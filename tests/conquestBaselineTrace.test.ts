import { describe, expect, it, vi } from 'vitest';
import { baselineMatrix, runBaseline, BASELINE_TRACE_VERSION, type BaselineWindowTrace } from '../src/diagnostics/conquestBaseline';
import * as conquest from '../src/domain/conquest';
import { decodeConquestSave } from '../src/utils/ConquestSaveManager';
import { createLateBaselineCheckpoint, main } from '../src/cli/conquestTimeouts';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const input = { ...baselineMatrix()[0], maxTurns: 8 };

describe('Opt-in baseline trace', () => {
  it('exposes CLI help and rejects bad arguments and an existing output directory before simulation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = await mkdtemp(join(tmpdir(), 'orion-trace-test-'));
    try {
      expect(await main(['--help'])).toBe(0);
      expect(await main([])).toBe(1);
      expect(await main(['--output-dir', ''])).toBe(1);
      await expect(main(['--output-dir', directory])).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      log.mockRestore();
      error.mockRestore();
      await rmdir(directory);
    }
  });

  it('keeps complete commands, metrics, checkpoints and state identical without diagnostic aliases', () => {
    const plain = runBaseline(input), windows: BaselineWindowTrace[] = [];
    let checkpoint: string | undefined;
    const traced = runBaseline(input, undefined, { checkpointAt: 6, onWindow(window, json) {
      windows.push(structuredClone(window));
      if (json) checkpoint = json;
      window.position.worlds[0].ownerId = null;
      window.position.factions[0].treasury.credits = 0;
      window.position.factions[0].research.completed.push('trace-only');
      const ship = window.position.ships[0];
      if (ship) ship.operational.hull = 1;
      window.commands[0].command.factionId = 'red';
    } });
    expect(BASELINE_TRACE_VERSION).toBe(1);
    expect(traced).toEqual(plain);
    expect(windows).toHaveLength(8);
    expect(windows.some(window => window.position.ships.length > 0)).toBe(true);
    expect(windows.flatMap(window => window.commands)).toEqual(plain.commands);
    expect(windows.map(window => window.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(windows.every(window => window.commands.length <= 24)).toBe(true);
    if (!checkpoint) throw new Error('Отсутствует запрошенная контрольная точка');
    const continuation = runBaseline(input, { state: decodeConquestSave(checkpoint), turnsExecuted: 6 });
    expect(continuation.finalState).toEqual(plain.finalState);
    expect(continuation.commands).toEqual(plain.commands.filter(record => record.command.expectedTurn >= 7));
    expect(windows.at(-1)?.position.worlds.map(world => world.ownerId)).toEqual(
      plain.finalState.session.galaxy.systems.map(world => world.ownerId));
  });

  it.each([0, 9, 1.5, NaN])('rejects invalid checkpoint=%s explicitly', checkpointAt => {
    expect(() => runBaseline(input, undefined, { onWindow() {}, checkpointAt })).toThrow('параметры трассы');
  });

  it('marks an initially barren world without a population record explicitly rather than inventing population zero', () => {
    const options = { ...input, worldCount: 40 as const, maxTurns: 1 }, windows: BaselineWindowTrace[] = [];
    const traced = runBaseline(options, undefined, { onWindow: window => windows.push(window) });
    expect(traced).toEqual(runBaseline(options));
    const barren = windows[0].position.worlds.filter(world => world.environment === 'barren');
    expect(barren.length).toBeGreaterThan(0);
    expect(barren.every(world => world.population === null)).toBe(true);
    expect(windows[0].position.worlds.filter(world => world.environment !== 'barren')
      .every(world => world.population !== null)).toBe(true);
  });

  it('does not invoke trace for rolled-back executor packets', () => {
    const original = conquest.executeConquestAction;
    const spy = vi.spyOn(conquest, 'executeConquestAction').mockImplementation((state, command, automated) => {
      if (typeof command === 'object' && command && 'kind' in command && command.kind === 'endTurn') {
        return original(state, { ...command, expectedTurn: 999 }, automated);
      }
      return original(state, command, automated);
    });
    try {
      const onWindow = vi.fn();
      expect(runBaseline(input, undefined, { onWindow }).status).toBe('executor-error');
      expect(onWindow).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('fails explicitly if an allegedly accepted endTurn does not advance the ongoing state', () => {
    const original = conquest.executeConquestAction;
    let ends = 0;
    const spy = vi.spyOn(conquest, 'executeConquestAction').mockImplementation((state, command, automated) => {
      if (typeof command === 'object' && command && 'kind' in command && command.kind === 'endTurn') {
        if (++ends > 2) throw new Error('runaway-test-guard');
        return { ok: true, state: conquest.conquestSchema.parse(state) };
      }
      return original(state, command, automated);
    });
    try {
      const onWindow = vi.fn();
      expect(() => runBaseline(input, undefined, { onWindow })).toThrow('не продвинуло ход');
      expect(ends).toBe(1);
      expect(onWindow).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('replays a nonempty late suffix for a run shorter than sixty windows', () => {
    const run = runBaseline(input), before = structuredClone(run), checkpoint = createLateBaselineCheckpoint(run);
    expect(checkpoint.turnsExecuted).toBe(7);
    const continued = runBaseline(input, { state: decodeConquestSave(checkpoint.json),
      turnsExecuted: checkpoint.turnsExecuted });
    expect(continued.commands.length).toBeGreaterThan(0);
    expect(continued.commands).toEqual(run.commands.filter(record => record.command.expectedTurn > 7));
    expect(continued.finalState).toEqual(run.finalState);
    expect(run).toEqual(before);
    expect(() => createLateBaselineCheckpoint(runBaseline({ ...input, maxTurns: 1 })))
      .toThrow('Нет поздней контрольной точки до остановки');
  });

  it('surfaces observer errors instead of reporting a successful run', () => {
    expect(() => runBaseline(input, undefined, { onWindow() { throw new Error('trace-write-failed'); } }))
      .toThrow('trace-write-failed');
  });

  it('bounds snapshots by the input horizon and retains real tactical timeouts without frames', () => {
    const windows: BaselineWindowTrace[] = [];
    const run = runBaseline({ ...input, kind: 'supply-boundary', maxTurns: 2 }, undefined,
      { onWindow: window => windows.push(window) });
    expect(windows).toHaveLength(2);
    expect(windows.flatMap(window => window.battles)).toEqual(run.battles);
    expect(windows.every(window => window.battles.every(battle => battle.timedOut))).toBe(true);
    expect(windows[0].position.ships).toHaveLength(200);
    expect(windows[0].position.ships.every(ship => ship.operational.ammunition.every(weapon => weapon.amount === 0))).toBe(true);
    expect(JSON.stringify(windows)).not.toContain('"frames"');
    expect(windows.at(-1)?.position.factions.map(side => side.budget)).toEqual(
      (['blue', 'red'] as const).map(side => conquest.getConquestView(run.finalState, side).economyForecast));
  });
});
