import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCampaignRun, executeRunAiTurn, executeRunCommand, type CampaignRun, type RunCommandResult } from '../src/domain/campaignRun';
import { encodeCampaignRunSave, decodeCampaignRunSave } from '../src/domain/campaignRunSave';
import { type SessionCommand } from '../src/domain/campaignSession';
import { createCombatDesign } from '../src/domain/combatPresets';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { loadProductionCatalog } from '../src/utils/ProductionCatalog';
import { freeze, requestFor, sides } from './fixtures/campaignAi';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const local = { mode: 'local' } as const;
const computer = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } as const;
function encoded(run: CampaignRun): string {
  const before = structuredClone(run); freeze(run);
  const result = encodeCampaignRunSave(run);
  if (!result.ok) throw new Error(result.code);
  expect(run).toEqual(before); return result.json;
}
function decoded(json: string): CampaignRun {
  const result = decodeCampaignRunSave(json);
  if (!result.ok) throw new Error(result.code);
  return result.run;
}
function manual(run: CampaignRun, command: SessionCommand): Extract<RunCommandResult, { ok: true }> {
  const before = structuredClone(run); freeze(run); freeze(command);
  const result = executeRunCommand(run, command);
  if (!result.ok) throw new Error(`${command.kind}: ${result.code}`);
  expect(run).toEqual(before); expect(result.run).not.toBe(run);
  return result;
}
function ai(run: CampaignRun) {
  const before = structuredClone(run); freeze(run);
  const result = executeRunAiTurn(run, requestFor(run.session));
  if (!result.ok) throw new Error(result.code);
  expect(run).toEqual(before); expect(result.run.session.turn).toBe(run.session.turn + 1);
  expect(result.summary.turn).toBe(run.session.turn);
  return result;
}

describe('real paid LOCAL preparation; codec checkpoints are not storage/reload or public mode conversion', () => {
  it.each(['preset', 'library'].flatMap(source => ['local', 'diagnostic-red-ai'].map(mode => ({ source, mode }))))
  ('$source / $mode: earned29→FIFO31→45→groups→47, independent restored and uninterrupted branches', ({ source, mode }) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T12:34:56.123Z'));
    const data = new Map<string, string>();
    const port: StoragePort = { getItem: vi.fn(key => data.get(key) ?? null), setItem: vi.fn((key, value) => { data.set(key, value); }) };
    const library = new ShipDesignManager(port), created = createCombatDesign('fighter');
    if (source === 'library') library.saveDesign(created);
    const choice = loadProductionCatalog(library).choices.find(item => source === 'library'
      ? item.source === 'Библиотека' && item.design.id === created.id : item.source === 'Пресет' && item.design.hullId === 'fighter')!;
    expect(choice.issue).toBe(''); expect(choice.quote).toEqual({ cost: { credits: 185, minerals: 11 }, turns: 4 });
    const design = choice.design, snapshot = structuredClone(design); freeze(design);
    const fresh = createCampaignRun(local); if (!fresh.ok) throw new Error(fresh.code);
    let run = fresh.run;
    for (const factionId of sides) {
      for (const kind of ['explore', 'colonize'] as const) run = manual(run, { kind, factionId,
        systemId: factionId === 'blue' ? 'eden' : 'nexus', expectedTurn: run.session.turn }).run;
      run = manual(run, { kind: 'endTurn', ...requestFor(run.session) }).run;
    }
    while (run.session.turn < 29) run = manual(run, { kind: 'endTurn', ...requestFor(run.session) }).run;
    expect(run.session.treasuries).toEqual({ blue: { credits: 380, minerals: 190 }, red: { credits: 380, minerals: 190 } });
    for (const factionId of sides) {
      for (let count = 0; count < 2; count++) run = manual(run, { kind: 'enqueueProduction', factionId,
        systemId: factionId === 'blue' ? 'sol' : 'vega', expectedTurn: run.session.turn, design }).run;
      expect(run.session.treasuries[factionId]).toEqual({ credits: 10, minerals: 168 });
      run = manual(run, { kind: 'endTurn', ...requestFor(run.session) }).run;
    }
    expect(run.session.turn).toBe(31); expect(run.control).toEqual(local);
    expect(run.session.production.orders.map(x => [x.id, x.remainingTurns])).toEqual([[1, 3], [2, 4], [3, 3], [4, 4]]);
    const checkpoint31 = encoded(run), checkpointRun31 = structuredClone(run);
    vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'));
    if (source === 'library') {
      const edited = library.saveDesign({ ...snapshot, name: 'Изменённый после оплаты проект' });
      expect(edited.name).not.toBe(snapshot.name); expect(edited.updatedAt).not.toBe(snapshot.updatedAt);
      expect(library.load().designs[0].name).toBe(edited.name);
    }
    vi.mocked(port.getItem).mockClear(); vi.mocked(port.setItem).mockClear();
    let restored = decoded(checkpoint31); expect(restored).toEqual(run); expect(restored).not.toBe(run);
    const checkpoints = [31];
    function unchangedSnapshots(): void {
      for (const branch of [run, restored]) {
        expect([...branch.session.ships, ...branch.session.production.orders, ...branch.session.production.completed].map(x => x.design))
          .toEqual(Array(4).fill(snapshot));
      }
      expect(design).toEqual(snapshot); expect(restored).toEqual(run);
      expect(port.getItem).not.toHaveBeenCalled(); expect(port.setItem).not.toHaveBeenCalled();
    }
    function bothManual(command: SessionCommand): void {
      vi.setSystemTime(new Date('2026-09-10T12:34:56.123Z')); const original = manual(run, command);
      vi.setSystemTime(new Date('2050-01-01T00:00:00.000Z')); const loaded = manual(restored, command);
      expect(loaded).toEqual(original); run = original.run; restored = loaded.run; unchangedSnapshots();
    }
    function bothAi() {
      const before = run;
      vi.setSystemTime(new Date('2026-09-10T12:34:56.123Z')); const original = ai(run);
      vi.setSystemTime(new Date('2050-01-01T00:00:00.000Z')); const loaded = ai(restored);
      expect(loaded).toEqual(original); // Full run/control AND exact commands/receipt, not just turn.
      const own = requestFor(before.session).factionId, seen = new Set<string>();
      for (const order of before.session.production.orders) {
        const progresses = order.factionId === own && !seen.has(order.systemId);
        if (order.factionId === own) seen.add(order.systemId);
        if (progresses && order.remainingTurns === 1) expect(loaded.run.session.production.completed.find(x => x.id === order.id)?.design).toEqual(snapshot);
        else expect(loaded.run.session.production.orders.find(x => x.id === order.id)?.remainingTurns).toBe(order.remainingTurns - Number(progresses));
      }
      run = original.run; restored = loaded.run; unchangedSnapshots();
      return loaded.summary;
    }
    unchangedSnapshots();
    while (run.session.turn < 45) bothAi(); // Explicit LOCAL helper calls, never automatic decode work.
    expect(run.session.production.completed.map(x => x.id)).toEqual([1, 3, 2, 4]);
    expect(run.session.treasuries).toEqual({ blue: { credits: 170, minerals: 248 }, red: { credits: 170, minerals: 248 } });
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega', destinationId = factionId === 'blue' ? 'eden' : 'nexus';
      const shipIds = factionId === 'blue' ? [2, 1] : [4, 3], fleetId = factionId === 'blue' ? 1 : 2;
      for (const orderId of shipIds) bothManual({ kind: 'deployProduction', factionId, systemId, orderId, expectedTurn: run.session.turn });
      bothManual({ kind: 'createFleet', factionId, systemId, shipIds, expectedTurn: run.session.turn });
      const send: SessionCommand = { kind: 'sendFleet', factionId, systemId, destinationId, fleetId, expectedTurn: run.session.turn };
      bothManual(send);
      expect(executeRunCommand(restored, send)).toEqual(executeRunCommand(run, send));
      expect(executeRunCommand(restored, send)).toMatchObject({ ok: false, code: 'FLEET_IN_TRANSIT' });
      if (factionId === 'red' && mode === 'diagnostic-red-ai') {
        // Explicit diagnostic configuration AFTER real LOCAL purchases/deploy/send in BOTH branches.
        // There is intentionally no public local→AI conversion API or AI production policy.
        run = { session: run.session, control: computer }; restored = { session: restored.session, control: computer };
      }
      const checkpoint = encoded(restored), before = structuredClone(restored);
      expect(JSON.parse(checkpoint).control).toEqual(restored.control);
      expect(JSON.parse(checkpoint)).not.toHaveProperty('summary');
      if (factionId === 'blue' && source === 'library') {
        expect(port.getItem).not.toHaveBeenCalled(); expect(port.setItem).not.toHaveBeenCalled();
        data.delete(ShipDesignManager.STORAGE_KEY); // Only temporary library, never actual storage.
        expect(library.load().designs).toEqual([]); vi.mocked(port.getItem).mockClear();
      }
      const libraryBefore = Array.from(data.entries());
      vi.setSystemTime(new Date('2040-06-01T00:00:00.000Z'));
      restored = decoded(checkpoint); checkpoints.push(restored.session.turn);
      expect(restored).toEqual(before); expect(restored).toEqual(run);
      expect(restored.session.ships.filter(x => x.factionId === factionId).map(x => [x.id, x.fuel, x.systemId, x.transit]))
        .toEqual(shipIds.map(id => [id, 2, systemId, { destinationId, remainingTurns: 1 }]));
      const endingTurn = restored.session.turn, summary = bothAi();
      expect(summary.endTurnEconomy).toMatchObject({ factionId, turn: endingTurn,
        upkeep: { shipCount: 2, dueCredits: 2, paidCredits: 2, shortfallCredits: 0 }, treasuryAfter: { credits: 188, minerals: 258 } });
      expect(executeRunAiTurn(restored, { factionId, expectedTurn: endingTurn })).toMatchObject({ ok: false, code: 'STALE_TURN' });
      expect(Array.from(data.entries())).toEqual(libraryBefore);
    }
    expect(checkpoints).toEqual([31, 45, 46]);
    expect(restored.session.turn).toBe(47); expect(restored.control).toEqual(mode === 'local' ? local : computer);
    expect(restored.session.production).toEqual({ lastOrderId: 4, orders: [], completed: [] });
    expect(restored.session.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(restored.session.ships.map(x => [x.id, x.systemId, x.fuel, x.transit])).toEqual([
      [2, 'eden', 2, undefined], [1, 'eden', 2, undefined], [4, 'nexus', 2, undefined], [3, 'nexus', 2, undefined]
    ]);
    expect(restored.session.fleets.items.map(x => [x.id, x.systemId, x.shipIds])).toEqual([[1, 'eden', [2, 1]], [2, 'nexus', [4, 3]]]);
    expect(restored.session.fleets.lastFleetId).toBe(2); unchangedSnapshots();
    expect(decoded(checkpoint31)).toEqual(checkpointRun31); // Earlier checkpoint remains independent after all later commands.
    expect(data.size).toBe(0);
  });
});

describe('ordinary new AI-mode run, not diagnostic red purchases', () => {
  it('save on red does not execute AI; explicit later AI matches uninterrupted and retains authorization', () => {
    const fresh = createCampaignRun(computer); if (!fresh.ok) throw new Error(fresh.code);
    const run = manual(fresh.run, { kind: 'endTurn', ...requestFor(fresh.run.session) }).run;
    const restored = decoded(encoded(run)); expect(restored).toEqual(run); expect(restored.session.turn).toBe(2);
    expect(restored.session.treasuries.red).toEqual({ credits: 100, minerals: 50 });
    expect(executeRunCommand(restored, { kind: 'endTurn', ...requestFor(restored.session) }))
      .toMatchObject({ ok: false, code: 'FACTION_CONTROLLED_BY_AI' });
    const result = ai(restored); expect(result).toEqual(ai(run)); expect(result.run.session.turn).toBe(3);
    expect(result.run.session.treasuries.red).toEqual({ credits: 110, minerals: 55 });
    const again = decoded(encoded(result.run)); expect(again).toEqual(result.run);
    expect(executeRunAiTurn(again, requestFor(again.session))).toMatchObject({ ok: false, code: 'AI_NOT_ASSIGNED' });
  });
});