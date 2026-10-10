import { describe, expect, it, vi } from 'vitest';
import { baselineMatrix, createBaselineStart, runBaseline, summarizeBaseline, verifyBaseline,
  type BaselineInput } from '../src/diagnostics/conquestBaseline';
import { executeConquestAiTurn } from '../src/domain/conquestAi';
import * as conquest from '../src/domain/conquest';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { validateGalaxyMap } from '../src/domain/galaxyMap';
import { main } from '../src/cli/conquestBaseline';

const input = (overrides: Partial<BaselineInput> = {}): BaselineInput => ({
  ...baselineMatrix()[0], maxTurns: 16, ...overrides
});

describe('Conquest baseline', () => {
  it('fixes the approved 54 paid + 4 boundary matrix before measuring', () => {
    const matrix = baselineMatrix();
    expect(matrix).toHaveLength(58);
    expect(new Set(matrix.map(item => item.id)).size).toBe(58);
    expect(matrix.filter(item => item.kind === 'paid')).toHaveLength(54);
    expect(matrix.filter(item => item.kind === 'paid').every(item => item.maxTurns === 200)).toBe(true);
    expect(matrix.filter(item => item.kind !== 'paid').every(item => item.maxTurns === 8)).toBe(true);
    for (const count of [6, 40, 256]) expect(matrix.filter(item => item.worldCount === count &&
      item.kind === 'paid')).toHaveLength(18);
  });

  it.each([6, 40, 256] as const)('repeats full state/commands/metrics and round-trips %i worlds', worldCount => {
    const options = input({ worldCount });
    const run = runBaseline(options);
    expect(verifyBaseline(run)).toEqual({ repeat: 'passed', roundTrip: 'passed' });
    expect(run.versions).toEqual({ baseline: 1, save: 5, rules: 3, tree: 2, battlePolicy: 'campaign-v2' });
    expect(run.map.seed).toBe(options.mapSeed);
    expect(run.finalState.seed).toBe(options.campaignSeed);
    expect(run.status).toBe('timeout');
    expect(run.outcome).toEqual({ status: 'ongoing' });
    expect(run.turnsExecuted).toBe(16);
    expect(run.finalState.session.turn).toBe(17);
    expect(run.unavailable.population).toBe('mechanic-not-implemented');
  });

  it.each([false, true])('keeps canonical maps and lineup attribution on mirrored=%s', mirrored => {
    const normal = createBaselineStart(input());
    const start = createBaselineStart(input({ mirrored }));
    expect(validateGalaxyMap(start.map)).toEqual({ ok: true, map: start.map });
    expect(start.map.lanes).toEqual(normal.map.lanes);
    expect(start.map.participants[0].homeWorldId).toBe(normal.map.participants[mirrored ? 1 : 0].homeWorldId);
    expect(start.state.session.ships).toEqual([]);
    expect(start.state.session.production.lastOrderId).toBe(0);
    expect(start.state.session.treasuries.blue).toEqual({ credits: 100, minerals: 50 });
    const run = runBaseline(input({ mirrored }));
    expect(run.lineups.first).toBe(mirrored ? 'red' : 'blue');
    expect(run.metrics[run.lineups.first].firstResearch.status).toBe('measured');
    expect(run.commands.every(record => record.result === 'accepted')).toBe(true);
  });

  it.each([false, true])('matches the real existing AI executor packet for each starting side (%s)', redStart => {
    const options = input({ maxTurns: redStart ? 2 : 1 });
    let state = createBaselineStart(options).state;
    const blue = executeConquestAiTurn(state, 'blue', 1);
    if (!blue.ok) throw new Error(blue.message);
    state = blue.state;
    if (redStart) {
      const red = executeConquestAiTurn(state, 'red', 2);
      if (!red.ok) throw new Error(red.message);
      state = red.state;
    }
    expect(runBaseline(options).finalState).toEqual(state);
  });

  it.each([false, true])('uses legal paid opening schedules, including red lineup (%s)', mirrored => {
    const builder = runBaseline(input({ schedule: 'production-first', mirrored, maxTurns: 60 }));
    const researcher = runBaseline(input({ schedule: 'research-first', mirrored, maxTurns: 60 }));
    const first = builder.lineups.first;
    const builderCommands = builder.commands.filter(record => record.command.factionId === first);
    expect(builderCommands.find(record => record.command.kind !== 'endTurn')?.command.kind).toBe('enqueueProduction');
    const researchOrder = researcher.commands.find(record => record.command.factionId === first &&
      record.command.kind === 'enqueueProduction')!;
    expect(researchOrder.command.expectedTurn).toBeGreaterThanOrEqual(17);
    expect(researcher.finalState.research[first].completed).toHaveLength(3);
    expect(verifyBaseline(builder).roundTrip).toBe('passed');
    expect(builder.commands.every(record => record.result === 'accepted')).toBe(true);
    expect(builder.metrics[first].released).toBeGreaterThan(0);
    expect(builder.metrics[first].spent.enqueueProduction.credits).toBeGreaterThan(0);
  });

  it('accounts for actual gross releases and spending with an independent paid resource oracle', () => {
    const run = runBaseline(input({ schedule: 'production-first', maxTurns: 8 }));
    for (const side of ['blue', 'red'] as const) {
      const metric = run.metrics[side];
      expect(metric.ownEnds).toBe(4);
      expect(metric.gross).toEqual({ credits: 40, minerals: 20 });
      const spent = Object.values(metric.spent).reduce((sum, cost) =>
        ({ credits: sum.credits + cost.credits, minerals: sum.minerals + cost.minerals }), { credits: 0, minerals: 0 });
      expect(run.finalState.session.treasuries[side]).toEqual({
        credits: 100 + metric.gross.credits - spent.credits,
        minerals: 50 + metric.gross.minerals - spent.minerals
      });
      expect(metric.spent.research).toEqual(side === 'red' ? { credits: 30, minerals: 0 } : undefined);
    }
    expect(run.metrics.blue.firstOrder).toEqual({ status: 'timeout', throughTurn: 8 });
    expect(run.metrics.blue.firstRelease).toEqual({ status: 'timeout', throughTurn: 8 });
  });

  it('records real executor rejection separately, rolls back the packet and does not invent a code', () => {
    const original = conquest.executeConquestAction;
    const spy = vi.spyOn(conquest, 'executeConquestAction').mockImplementation((state, command, automated) => {
      if (typeof command === 'object' && command && 'kind' in command && command.kind === 'endTurn') {
        return original(state, { ...command, expectedTurn: 999 }, automated);
      }
      return original(state, command, automated);
    });
    try {
      const options = input({ maxTurns: 1 }), start = createBaselineStart(options);
      const run = runBaseline(options);
      expect(run.status).toBe('executor-error');
      expect(run.turnsExecuted).toBe(0);
      expect(run.finalState).toEqual(start.state);
      expect(run.commands[0].result).toBe('rolled-back');
      expect(run.commands.at(-1)).toMatchObject({ result: 'rejected', message: 'Номер хода изменился',
        executorCode: { status: 'unavailable', reason: 'executor-returns-message-only' } });
      expect(run.metrics.blue.gross.credits).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('runs symmetric real battles and attributes losses to participants, not ending side', () => {
    const run = runBaseline(input({ kind: 'symmetric-boundary', maxTurns: 2 }));
    expect(run.battles.length).toBeGreaterThan(0);
    expect(run.metrics.blue.firstEncounter).toEqual({ status: 'measured', turn: 1 });
    expect(run.metrics.red.firstEncounter).toEqual({ status: 'measured', turn: 1 });
    expect(run.metrics.blue.losses + run.metrics.red.losses).toBe(
      run.battles.reduce((total, battle) => total + battle.destroyed.length, 0));
    expect(verifyBaseline(run).roundTrip).toBe('passed');
  });

  it('distinguishes supply/economy shortage and tactical timeouts from strategic victory', () => {
    const run = runBaseline(input({ kind: 'supply-boundary', maxTurns: 2 }));
    expect(run.status).toBe('timeout');
    expect(run.battleTimeouts).toBe(2);
    expect(run.finalState.session.ships).toHaveLength(200);
    expect(run.metrics.blue.losses + run.metrics.red.losses).toBe(0);
    expect(run.commands[0].endTurnObservations).toEqual(expect.arrayContaining([
      'ships-with-empty-fuel', 'empty-ammunition', 'upkeep-shortfall', 'boundary-end-only'
    ]));
    expect(run.metrics.blue.spent.upkeep.credits).toBe(10);
    expect(run.metrics.blue.firstShip).toEqual({ status: 'timeout', throughTurn: 2 });
  }, 20000);

  it.each(['symmetric-boundary', 'supply-boundary'] as const)(
    'preserves the next real boundary battle after an intermediate save (%s)', kind => {
      const first = runBaseline(input({ kind, maxTurns: 1 }));
      const resumed = runBaseline(input({ kind, maxTurns: 2 }), {
        state: decodeConquestSave(encodeConquestSave(first.finalState)), turnsExecuted: 1
      });
      const uninterrupted = runBaseline(input({ kind, maxTurns: 2 }));
      expect(resumed.finalState).toEqual(uninterrupted.finalState);
      expect(resumed.commands).toEqual(uninterrupted.commands.filter(record => record.command.expectedTurn === 2));
      expect(resumed.battles).toEqual(uninterrupted.battles.filter(battle => battle.turn === 2));
    }, 20000
  );

  it('uses no clocks/global random and rejects invalid or foreign current checkpoints', () => {
    const options = input(), start = createBaselineStart(options);
    const snapshot = structuredClone(start.state);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
    try {
      const first = runBaseline(options);
      expect(runBaseline(options)).toEqual(first);
      expect(start.state).toEqual(snapshot);
      expect(() => runBaseline({ ...options, maxTurns: 201 })).toThrow();
      expect(() => runBaseline(options, { state: start.state, turnsExecuted: 1 })).toThrow();
      expect(() => runBaseline(options, { state: createBaselineStart(input({ mapSeed: 42 })).state,
        turnsExecuted: 0 })).toThrow();
      expect(() => decodeConquestSave(encodeConquestSave({ ...start.state, researchTree:
        { ...start.state.researchTree, version: 1 } }))).toThrow();
    } finally { clock.mockRestore(); random.mockRestore(); }
  });

  it('reports distributions, censored milestones, both lineups and CLI argument errors', async () => {
    const summaries = summarizeBaseline([runBaseline(input({ maxTurns: 1 })), runBaseline(input({ maxTurns: 1, mirrored: true }))]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ n: 2, timeout: 2, completed: 0,
      first: { firstResearch: { distribution: { status: 'measured', n: 1, min: 1, median: 1, max: 1 }, censored: 1 } } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--help'])).toBe(0);
      expect(await main([])).toBe(1);
      expect(await main(['--output', 'wrong.txt'])).toBe(1);
      expect(error).toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  it('preserves accepted measured tempo across all six-world seed pairs and starts', () => {
    for (const options of baselineMatrix().filter(item => item.kind === 'paid' && item.worldCount === 6)) {
      const run = runBaseline(options), metrics = run.metrics[run.lineups.first];
      const production = options.schedule === 'production-first';
      expect(run.status).toBe('completed');
      expect(run.turnsExecuted).toBeGreaterThanOrEqual(production ? 45 : 59);
      expect(run.turnsExecuted).toBeLessThanOrEqual(production ? 48 : 61);
      for (const [key, minimum, maximum] of [
        ['firstOrder', production ? 27 : 41, production ? 28 : 42],
        ['firstRelease', production ? 35 : 49, production ? 36 : 50],
        ['firstShip', production ? 37 : 51, production ? 38 : 52]
      ] as const) {
        const metric = metrics[key];
        expect(metric.status).toBe('measured');
        if (metric.status !== 'measured') throw new Error('Не наблюдался обязательный milestone');
        expect(metric.turn).toBeGreaterThanOrEqual(minimum);
        expect(metric.turn).toBeLessThanOrEqual(maximum);
      }
    }
  }, 30000);
});
