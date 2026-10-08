import { z } from 'zod';
import { BattleManager } from '../entities/BattleManager';
import { CombatShipFactory, fleetCompositionSchema } from '../entities/CombatShipFactory';
import { COMBAT_SIMULATION_MAX_STEPS, COMBAT_SIMULATION_STEP } from './combatSimulation';
import { createSeededRandomStream } from './seededRandom';

const nonEmptyCompositionSchema = fleetCompositionSchema.refine(
  composition => Object.values(composition).some(count => (count ?? 0) > 0), 'Флот не может быть пустым');

export const combatSeriesRequestSchema = z.object({
  blue: nonEmptyCompositionSchema,
  red: nonEmptyCompositionSchema,
  seeds: z.array(z.number().int().min(1).max(0xffffffff)).min(1).max(100)
}).strict();

export type CombatSeriesRequest = z.input<typeof combatSeriesRequestSchema>;
export interface CombatSeriesBattle {
  seed: number;
  firstFactionId: 'blue' | 'red';
  winner: 'blue' | 'red' | null;
  timedOut: boolean;
  steps: number;
  durationMs: number;
  shipsDestroyed: number;
  totalDamage: number;
  survivors: { blue: number; red: number };
}

export interface CombatSeriesResult {
  battles: CombatSeriesBattle[];
  summary: {
    blueWins: number;
    redWins: number;
    draws: number;
    timeouts: number;
    meanDurationMs: number;
    meanShipsDestroyed: number;
  };
}

export interface CombatSeriesOptions {
  randomStreamLabels?: { blue: string; red: string };
}

export interface PairedCombatSeedResult {
  seed: number;
  firstWhenBlue: CombatSeriesBattle;
  firstWhenRed: CombatSeriesBattle;
  firstScoreWhenBlue: number;
  firstScoreWhenRed: number;
  pairedScore: number;
  sideBias: number;
}

export interface PairedCombatSeriesResult {
  pairs: PairedCombatSeedResult[];
  summary: {
    seeds: number;
    battles: number;
    firstWins: number;
    secondWins: number;
    draws: number;
    timeouts: number;
    meanFirstScore: number;
    firstScore95CI: { lower: number; upper: number };
    meanSideBias: number;
    sideBias95CI: { lower: number; upper: number };
    confidenceMethod: 'paired-normal-approximation';
  };
}

const pairedCombatSeriesRequestSchema = z.object({
  first: nonEmptyCompositionSchema,
  second: nonEmptyCompositionSchema,
  seeds: z.array(z.number().int().min(1).max(0xffffffff)).min(30).max(100)
    .refine(seeds => new Set(seeds).size === seeds.length, 'Seed в paired series должны быть уникальными')
}).strict();

export function runCombatSeries(input: unknown, options: CombatSeriesOptions = {}): CombatSeriesResult {
  const request = combatSeriesRequestSchema.parse(input);
  const battles = request.seeds.map(seed => {
    const randomForShip = (factionId: string, index: number) => createSeededRandomStream(seed,
      `${options.randomStreamLabels?.[factionId as 'blue' | 'red'] ?? factionId}:${index}`);
    const firstFactionId = createSeededRandomStream(seed, 'initiative')() < 0.5 ? 'blue' : 'red';
    const blue = CombatShipFactory.createFleet('blue', request.blue, { randomForShip, idPrefix: `series-${seed}` });
    const red = CombatShipFactory.createFleet('red', request.red, { randomForShip, idPrefix: `series-${seed}` });
    const positionFleet = (ships: typeof blue, faction: 'blue' | 'red') => ships.forEach((ship, index) => {
      const column = index % 8;
      const row = Math.floor(index / 8);
      ship.position = { x: faction === 'blue' ? 140 + column * 45 : 860 - column * 45, y: 100 + row * 45 };
    });
    positionFleet(blue, 'blue');
    positionFleet(red, 'red');

    const manager = new BattleManager({
      factions: [
        { id: 'blue', name: 'Blue', color: 0x4488ff, ships: blue },
        { id: 'red', name: 'Red', color: 0xff6655, ships: red }
      ],
      battlefieldWidth: 1000,
      battlefieldHeight: 900,
      autoTarget: true,
      friendlyFire: false
    }, { now: () => 0, silent: true, alternateFactionOrder: true, firstFactionId });

    manager.start();
    let steps = 0;
    const bothSidesAlive = () => manager.getAliveShips().some(ship => ship.factionId === 'blue') &&
      manager.getAliveShips().some(ship => ship.factionId === 'red');
    while (steps < COMBAT_SIMULATION_MAX_STEPS && bothSidesAlive()) {
      manager.update(COMBAT_SIMULATION_STEP);
      steps++;
    }
    const winner = manager.getWinner()?.id;
    const alive = manager.getAliveShips();
    const result: CombatSeriesBattle = {
      seed,
      firstFactionId,
      winner: winner === 'blue' || winner === 'red' ? winner : null,
      timedOut: winner === undefined && alive.some(ship => ship.factionId === 'blue') &&
        alive.some(ship => ship.factionId === 'red') && steps === COMBAT_SIMULATION_MAX_STEPS,
      steps,
      durationMs: manager.getStats().duration,
      shipsDestroyed: manager.getStats().shipsDestroyed,
      totalDamage: manager.getStats().totalDamage,
      survivors: {
        blue: alive.filter(ship => ship.factionId === 'blue').length,
        red: alive.filter(ship => ship.factionId === 'red').length
      }
    };
    manager.stop();
    return result;
  });

  const total = battles.length;
  return {
    battles,
    summary: {
      blueWins: battles.filter(battle => battle.winner === 'blue').length,
      redWins: battles.filter(battle => battle.winner === 'red').length,
      draws: battles.filter(battle => battle.winner === null).length,
      timeouts: battles.filter(battle => battle.timedOut).length,
      meanDurationMs: battles.reduce((sum, battle) => sum + battle.durationMs, 0) / total,
      meanShipsDestroyed: battles.reduce((sum, battle) => sum + battle.shipsDestroyed, 0) / total
    }
  };
}

function scoreForFaction(battle: CombatSeriesBattle, factionId: 'blue' | 'red'): number {
  return battle.winner === null ? 0.5 : battle.winner === factionId ? 1 : 0;
}

function confidenceInterval95(samples: number[], minimum: number, maximum: number): { lower: number; upper: number } {
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const squaredDeviation = samples.reduce((sum, sample) => sum + (sample - mean) ** 2, 0);
  const standardError = Math.sqrt(squaredDeviation / (samples.length - 1) / samples.length);
  const margin = 1.96 * standardError;
  return { lower: Math.max(minimum, mean - margin), upper: Math.min(maximum, mean + margin) };
}

export function runPairedCombatSeries(input: unknown): PairedCombatSeriesResult {
  const request = pairedCombatSeriesRequestSchema.parse(input);
  const forward = runCombatSeries({ blue: request.first, red: request.second, seeds: request.seeds }, {
    randomStreamLabels: { blue: 'lineup:first', red: 'lineup:second' }
  });
  const mirrored = runCombatSeries({ blue: request.second, red: request.first, seeds: request.seeds }, {
    randomStreamLabels: { blue: 'lineup:second', red: 'lineup:first' }
  });
  const pairs = request.seeds.map((seed, index): PairedCombatSeedResult => {
    const firstWhenBlue = forward.battles[index];
    const firstWhenRed = mirrored.battles[index];
    const firstScoreWhenBlue = scoreForFaction(firstWhenBlue, 'blue');
    const firstScoreWhenRed = scoreForFaction(firstWhenRed, 'red');
    return {
      seed,
      firstWhenBlue,
      firstWhenRed,
      firstScoreWhenBlue,
      firstScoreWhenRed,
      pairedScore: (firstScoreWhenBlue + firstScoreWhenRed) / 2,
      sideBias: firstScoreWhenBlue - firstScoreWhenRed
    };
  });
  const pairedScores = pairs.map(pair => pair.pairedScore);
  const sideBiases = pairs.map(pair => pair.sideBias);
  const pairBattles = pairs.flatMap(pair => [
    { result: pair.firstWhenBlue, firstSide: 'blue' as const },
    { result: pair.firstWhenRed, firstSide: 'red' as const }
  ]);

  return {
    pairs,
    summary: {
      seeds: pairs.length,
      battles: pairBattles.length,
      firstWins: pairBattles.filter(({ result, firstSide }) => result.winner === firstSide).length,
      secondWins: pairBattles.filter(({ result, firstSide }) => result.winner !== null && result.winner !== firstSide).length,
      draws: pairBattles.filter(({ result }) => result.winner === null).length,
      timeouts: pairBattles.filter(({ result }) => result.timedOut).length,
      meanFirstScore: pairedScores.reduce((sum, score) => sum + score, 0) / pairedScores.length,
      firstScore95CI: confidenceInterval95(pairedScores, 0, 1),
      meanSideBias: sideBiases.reduce((sum, bias) => sum + bias, 0) / sideBiases.length,
      sideBias95CI: confidenceInterval95(sideBiases, -1, 1),
      confidenceMethod: 'paired-normal-approximation'
    }
  };
}