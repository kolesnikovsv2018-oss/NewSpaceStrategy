import { DesignedShip } from '../entities/DesignedShip';
import { BattleManager } from '../entities/BattleManager';
import { campaignShipsSchema, type CampaignShip } from './campaignShips';
import { readOperationalState, type OperationalState } from './campaignOperations';
import { createSeededRandom, createSeededRandomStream } from './seededRandom';
import { COMBAT_SIMULATION_MAX_STEPS, COMBAT_SIMULATION_STEP } from './combatSimulation';
import type { CampaignFactionId } from './campaign';
import type { BattleEvent } from '../entities/interfaces/CombatSystem';

export const CONQUEST_BATTLE_STEP = COMBAT_SIMULATION_STEP;
export const CONQUEST_BATTLE_STEPS = COMBAT_SIMULATION_MAX_STEPS;
export interface BattleFrame {
  seconds: number;
  ships: { id: number; factionId: CampaignFactionId; x: number; y: number; hull: number }[];
  events: BattleEvent[];
}
export interface ConquestBattleResult {
  winner: CampaignFactionId | null;
  timedOut: boolean;
  destroyed: number[];
  survivors: { id: number; operational: OperationalState }[];
  frames: BattleFrame[];
}

export function resolveConquestBattle(input: CampaignShip[], operations: Record<string, OperationalState>, seed: number,
  policy: 'campaign-v1' | 'campaign-v2' = 'campaign-v1'): ConquestBattleResult {
  const ships = campaignShipsSchema.parse(input).sort((left, right) => left.id - right.id);
  const legacyRandom = createSeededRandom(seed);
  if (!ships.length || ships.some(ship => ship.transit || ship.systemId !== ships[0].systemId)) throw new Error('Недопустимые участники боя');
  const factionRanks = new Map<CampaignFactionId, number>();
  const sideRank = new Map<number, number>();
  for (const ship of ships) {
    sideRank.set(ship.id, factionRanks.get(ship.factionId) ?? 0);
    factionRanks.set(ship.factionId, (factionRanks.get(ship.factionId) ?? 0) + 1);
  }
  const models = ships.map((ship, index) => {
    const operational = readOperationalState(operations[String(ship.id)], ship.design);
    const armed = ship.design.slots.some(slot => slot.component?.kind === 'beam' || slot.component?.kind === 'projectile');
    const random = policy === 'campaign-v2'
      ? createSeededRandomStream(seed, `campaign-ship:${ship.factionId}:${ship.id}`)
      : legacyRandom;
    const model = new DesignedShip(ship.design, ship.factionId, armed ? 'battle' : 'flight',
      { id: `campaign-${ship.id}`, random, operational });
    const row = policy === 'campaign-v2' ? sideRank.get(ship.id)! : index;
    model.position = { x: ship.factionId === 'blue' ? 200 : 800, y: 100 + row * 5 };
    return model;
  });
  const firstFactionId = policy === 'campaign-v2'
    ? createSeededRandomStream(seed, 'initiative')() < 0.5 ? 'blue' : 'red'
    : undefined;
  const manager = new BattleManager({
    factions: (['blue', 'red'] as const).map(id => ({ id, name: id, color: id === 'blue' ? 0x44bbff : 0xff6655,
      ships: models.filter(model => model.factionId === id) })),
    battlefieldWidth: 1000, battlefieldHeight: 1200, autoTarget: true, friendlyFire: false
  }, { now: () => 0, silent: true, ...(firstFactionId ? { alternateFactionOrder: true, firstFactionId } : {}) });
  const frames: BattleFrame[] = [];
  let events: BattleEvent[] = [];
  const frame = (step: number) => {
    frames.push({ seconds: step * CONQUEST_BATTLE_STEP, ships: models.map((model, index) => ({
      id: ships[index].id, factionId: ships[index].factionId, x: model.position.x, y: model.position.y,
      hull: model.combatStats.currentHull
    })), events });
    events = [];
  };
  const aliveSides = () => new Set(models.filter(model => !model.isDestroyed).map(model => model.factionId));
  let step = 0;
  frame(step);
  manager.start();
  while (step < CONQUEST_BATTLE_STEPS && aliveSides().size > 1) {
    manager.update(CONQUEST_BATTLE_STEP);
    events.push(...manager.drainEvents().slice(0, Math.max(0, 256 - events.length)));
    step++;
    if (step % 20 === 0) frame(step);
  }
  if (step % 20 !== 0) frame(step);
  manager.stop();
  const remaining = aliveSides();
  return {
    winner: remaining.size === 1 ? [...remaining][0] as CampaignFactionId : null,
    timedOut: remaining.size > 1,
    destroyed: ships.filter((_ship, index) => models[index].isDestroyed).map(ship => ship.id),
    survivors: models.flatMap((model, index) => model.isDestroyed ? [] : [{ id: ships[index].id,
      operational: { hull: model.combatStats.currentHull, ammunition: model.getWeaponState().flatMap(weapon =>
        weapon.ammo === null ? [] : [{ slotId: weapon.slotId, amount: weapon.ammo }]) } }]),
    frames
  };
}