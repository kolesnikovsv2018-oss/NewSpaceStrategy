import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { baselineMatrix, createBaselineStart, runBaseline } from '../src/diagnostics/conquestBaseline';
import { replayDevelopmentCommands, summarizeDevelopmentWindow } from '../src/diagnostics/conquestDevelopment';
import { createConquest, getConquestView, conquestSchema, type ConquestCommand } from '../src/domain/conquest';
import * as conquest from '../src/domain/conquest';
import { buildConquestDesigns } from '../src/domain/conquestAi';
import { main } from '../src/cli/conquestDevelopment';
import { workCommand as apply, workRound } from './fixtures/colonyWork';

describe('Development diagnostics, not a second simulation', () => {
  it('replays real paid commands with an independent checkpoint and unchanged input', () => {
    const input = { ...baselineMatrix()[0], maxTurns: 4 };
    const start = createBaselineStart(input).state, before = structuredClone(start);
    const run = runBaseline(input), commands = run.commands.map(record => record.command);
    const snapshot = structuredClone(commands);
    const replay = replayDevelopmentCommands(start, commands, 3);
    expect(replay.finalState).toEqual(run.finalState);
    expect(replay.windows.map(window => window.turn)).toEqual([1, 2, 3, 4]);
    expect(replay.windows.every(window => window.advanced === 1 && window.commandCount <= 24)).toBe(true);
    expect(replay.checkpoint?.session.turn).toBe(3);
    replay.checkpoint!.session.treasuries.blue.credits = 0;
    expect(start).toEqual(before);
    expect(commands).toEqual(snapshot);
    expect(replay.finalState).toEqual(run.finalState);
  });

  it.each([false, true])('distinguishes idle growth from a head that completes during the window (queued=%s)', queued => {
    let state = workRound(createConquest());
    const design = buildConquestDesigns(state.research.blue, state.researchTree)[0];
    if (queued) state = apply(state, { kind: 'enqueueProduction', systemId: 'sol', design });
    const before = structuredClone(state);
    const population = getConquestView(state, 'blue').colonyOutput.assignments.sol.population;
    const assign: ConquestCommand = { kind: 'assignWorkers', factionId: 'blue', expectedTurn: state.session.turn,
      systemId: 'sol', workers: { industry: population, research: 0, culture: 0 } };
    const assigned = apply(state, assign);
    const end: ConquestCommand = { kind: 'endTurn', factionId: 'blue', expectedTurn: state.session.turn };
    const after = apply(assigned, end);
    const result = summarizeDevelopmentWindow(state, after, [{ before: state, command: assign }, { before: assigned, command: end }]);
    expect(result.idleIndustryAssignments).toBe(queued ? 0 : 1);
    expect(result.commandKinds).toEqual({ assignWorkers: 1, endTurn: 1 });
    expect(result.before.population).toBeLessThan(result.after.population);
    if (queued) {
      expect(result.before.orders).toBe(1);
      expect(result.after.orders).toBe(0);
      expect(result.after.completed).toBe(1);
    }
    expect(state).toEqual(before);
  });

  it('rejects an unfinished packet rather than reporting partial development as a complete window', () => {
    const state = workRound(createConquest());
    const command: ConquestCommand = { kind: 'assignWorkers', factionId: 'blue', expectedTurn: state.session.turn,
      systemId: 'sol', workers: { industry: 5100, research: 0, culture: 0 } };
    expect(() => replayDevelopmentCommands(state, [command], 4)).toThrow('Незавершённое окно');
    expect(() => summarizeDevelopmentWindow(state, state, [])).toThrow('число команд');
  });

  it('propagates a real rejected stale command without a successful fallback', () => {
    const state = createConquest();
    expect(() => replayDevelopmentCommands(state, [{ kind: 'endTurn', factionId: 'blue', expectedTurn: 2 }], 3))
      .toThrow('STALE_TURN');
  });

  it('fault-only: shares the baseline no-progress guard before recording a false successful window', () => {
    const state = createConquest();
    const dispatch = vi.spyOn(conquest, 'executeConquestAction').mockImplementation(input => ({
      ok: true, state: conquestSchema.parse(input)
    }));
    try {
      expect(() => replayDevelopmentCommands(state, [{ kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }], 2))
        .toThrow('не продвинуло ход');
      expect(dispatch).toHaveBeenCalledOnce();
    } finally { dispatch.mockRestore(); }
  });
});

describe('Development CLI boundary', () => {
  it('documents the real entry and rejects invalid horizons before reading an archive', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--help'])).toBe(0);
      expect(log.mock.calls[0][0]).toContain('--development --archive');
      expect(await main([])).toBe(1);
      for (const horizon of ['0', '200', '201', 'NaN', '1.5']) {
        expect(await main(['--archive', 'missing.run.json.gz', '--output-dir', 'not-created',
          '--from-window', horizon])).toBe(1);
      }
      expect(error.mock.calls.length).toBeGreaterThan(0);
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  it('rejects a changed archive hash before decompression or simulation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orion-development-'));
    const archive = join(directory, 'case.run.json.gz'), metadata = join(directory, 'case.result.json');
    const output = join(directory, 'output');
    await writeFile(archive, 'not-gzip');
    await writeFile(metadata, JSON.stringify({
      input: baselineMatrix().find(input => input.worldCount === 40)!, sha256: '0'.repeat(64)
    }));
    try {
      await expect(main(['--archive', archive, '--output-dir', output])).rejects.toThrow('SHA256');
      expect(existsSync(output)).toBe(false);
    } finally { await unlink(archive); await unlink(metadata); await rmdir(directory); }
  });
});
