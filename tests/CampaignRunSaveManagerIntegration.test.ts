import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CampaignRunSaveManager } from '../src/utils/CampaignRunSaveManager';
import { createCampaignRun, executeRunAiTurn, executeRunCommand, type CampaignRun } from '../src/domain/campaignRun';
import { type SessionCommand } from '../src/domain/campaignSession';
import { createCombatDesign } from '../src/domain/combatPresets';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { loadProductionCatalog } from '../src/utils/ProductionCatalog';
import { freeze, requestFor, sides } from './fixtures/campaignAi';

const KEY = 'orion_campaign_v1';
const local = { mode: 'local' } as const;
const computer = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } as const;
beforeEach(() => {
  vi.stubGlobal('localStorage', undefined);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Unexpected host storage'); } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

class MemoryStorage implements StoragePort {
  readonly data = new Map<string, string>([
    ['orion_shipyard_v2', '{"schemaVersion":2,"designs":[],"components":[]}'],
    ['orion_shipyard_v1', '{unrelated legacy library'], ['orion_ship_configs', '[]'],
    ['orion_components', '[]'], ['other-app', 'Сохранить 🚀']
  ]);
  failWrite = false;
  readonly getItem = vi.fn((key: string) => this.data.get(key) ?? null);
  readonly setItem = vi.fn((key: string, value: string): void => {
    if (this.failWrite) throw new DOMException('PRIVATE quota details', 'QuotaExceededError');
    this.data.set(key, value);
  });
  readonly removeItem = vi.fn(() => { throw new Error('Forbidden cleanup'); });
  readonly clear = vi.fn(() => { throw new Error('Forbidden cleanup'); });
}
function loaded(store: StoragePort): CampaignRun {
  const result = new CampaignRunSaveManager(store).load(); if (!result.ok) throw new Error(result.code); return result.run;
}
function manual(run: CampaignRun, command: SessionCommand) {
  const before = structuredClone(run), payload = structuredClone(command); freeze(run); freeze(command);
  const result = executeRunCommand(run, command); if (!result.ok) throw new Error(`${command.kind}: ${result.code}`);
  expect(run).toEqual(before); expect(command).toEqual(payload); expect(result.run).not.toBe(run); return result;
}
function ai(run: CampaignRun) {
  const before = structuredClone(run); freeze(run);
  const result = executeRunAiTurn(run, requestFor(run.session)); if (!result.ok) throw new Error(result.code);
  expect(run).toEqual(before); expect(result.run.session.turn).toBe(run.session.turn + 1);
  expect(result.summary.turn).toBe(run.session.turn); return result;
}

describe('paid LOCAL gameplay through the real run repository (temporary port, not browser persistence)', () => {
  it.each(['preset', 'library'].flatMap(source => ['local', 'diagnostic-red-ai'].map(mode => ({ source, mode }))))
  ('$source / $mode: earned29→FIFO31→45→groups→47 equals uninterrupted full run and every summary', ({ source, mode }) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T12:34:56.123Z'));
    const store = new MemoryStorage(), library = new ShipDesignManager(store), created = createCombatDesign('fighter');
    if (source === 'library') library.saveDesign(created);
    const choice = loadProductionCatalog(library).choices.find(item => source === 'library'
      ? item.source === 'Библиотека' && item.design.id === created.id : item.source === 'Пресет' && item.design.hullId === 'fighter')!;
    expect(choice.issue).toBe(''); expect(choice.quote).toEqual({ cost: { credits: 185, minerals: 11 }, turns: 4 });
    const design = choice.design, snapshot = structuredClone(design); freeze(design);
    const initialStorage = new Map(store.data); store.getItem.mockClear(); store.setItem.mockClear();
    const fresh = createCampaignRun(local); if (!fresh.ok) throw new Error(fresh.code); let run = fresh.run;
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
    expect(store.data).toEqual(initialStorage); expect(store.getItem).not.toHaveBeenCalled(); expect(store.setItem).not.toHaveBeenCalled();

    let restored = run; const checkpoints: number[] = [];
    const otherKeys = () => new Map([...store.data].filter(([key]) => key !== KEY));
    function checkpoint(afterSave?: () => void): void {
      const input = restored, before = structuredClone(restored); freeze(restored);
      const reads = store.getItem.mock.calls.length, writes = store.setItem.mock.calls.length, others = otherKeys();
      expect(new CampaignRunSaveManager(store).save(restored)).toEqual({ ok: true });
      expect(store.getItem).toHaveBeenCalledTimes(reads); expect(store.setItem).toHaveBeenCalledTimes(writes + 1);
      expect(store.setItem.mock.calls[writes][0]).toBe(KEY); expect(otherKeys()).toEqual(others);
      const raw = store.data.get(KEY)!;
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['control', 'format', 'rulesVersion', 'schemaVersion', 'session']);
      expect(JSON.parse(raw).control).toEqual(restored.control);
      afterSave?.(); // Only explicit changes to the temporary library, never gameplay injections.
      const bytesBeforeLoad = new Map(store.data), readsBeforeLoad = store.getItem.mock.calls.length;
      vi.setSystemTime(new Date('2040-06-01T00:00:00.000Z'));
      restored = loaded(store); checkpoints.push(restored.session.turn);
      expect(store.getItem).toHaveBeenCalledTimes(readsBeforeLoad + 1);
      expect(store.getItem.mock.calls[readsBeforeLoad]).toEqual([KEY]);
      expect(store.setItem).toHaveBeenCalledTimes(writes + 1);
      expect(restored).toEqual(before); expect(restored).toEqual(run); expect(restored).not.toBe(input);
      expect(input).toEqual(before); expect(store.data).toEqual(bytesBeforeLoad);
    }
    function snapshots(): void {
      for (const branch of [run, restored]) expect([...branch.session.production.orders,
        ...branch.session.production.completed, ...branch.session.ships].map(x => x.design)).toEqual(Array(4).fill(snapshot));
      expect(design).toEqual(snapshot); expect(restored).toEqual(run);
    }
    function both(command?: SessionCommand) {
      const stored = new Map(store.data), reads = store.getItem.mock.calls.length, writes = store.setItem.mock.calls.length;
      vi.setSystemTime(new Date('2026-09-10T12:34:56.123Z')); const original = command ? manual(run, command) : ai(run);
      vi.setSystemTime(new Date('2050-01-01T00:00:00.000Z')); const resumed = command ? manual(restored, command) : ai(restored);
      expect(resumed).toEqual(original); // Includes full run/control and actual summary/receipt, not only turn.
      run = original.run; restored = resumed.run; snapshots();
      expect(store.getItem).toHaveBeenCalledTimes(reads); expect(store.setItem).toHaveBeenCalledTimes(writes);
      expect(store.data).toEqual(stored); return resumed;
    }
    checkpoint(); const checkpoint31 = store.data.get(KEY)!, run31 = structuredClone(restored);
    vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'));
    if (source === 'library') {
      const edited = library.saveDesign({ ...snapshot, name: 'Изменённый после оплаты проект' });
      expect(edited.name).not.toBe(snapshot.name); expect(edited.updatedAt).not.toBe(snapshot.updatedAt);
      expect(library.load().designs[0].name).toBe(edited.name);
      // Load the unchanged campaign again after editing its now-unrelated library snapshot.
      const before = new Map(store.data), writes = store.setItem.mock.calls.length;
      restored = loaded(store); expect(restored).toEqual(run31); expect(store.data).toEqual(before);
      expect(store.setItem).toHaveBeenCalledTimes(writes);
    }
    snapshots();
    while (run.session.turn < 45) both(); // Explicit LOCAL helper, never load-triggered AI.
    expect(run.session.production.completed.map(x => x.id)).toEqual([1, 3, 2, 4]);
    expect(run.session.treasuries).toEqual({ blue: { credits: 170, minerals: 248 }, red: { credits: 170, minerals: 248 } });
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega', destinationId = factionId === 'blue' ? 'eden' : 'nexus';
      const shipIds = factionId === 'blue' ? [2, 1] : [4, 3], fleetId = factionId === 'blue' ? 1 : 2;
      for (const orderId of shipIds) both({ kind: 'deployProduction', factionId, systemId, orderId, expectedTurn: run.session.turn });
      both({ kind: 'createFleet', factionId, systemId, shipIds, expectedTurn: run.session.turn });
      const send: SessionCommand = { kind: 'sendFleet', factionId, systemId, destinationId, fleetId, expectedTurn: run.session.turn };
      both(send);
      expect(executeRunCommand(restored, send)).toEqual(executeRunCommand(run, send));
      expect(executeRunCommand(restored, send)).toMatchObject({ ok: false, code: 'FLEET_IN_TRANSIT' });
      if (factionId === 'red' && mode === 'diagnostic-red-ai') {
        // Diagnostic assignment AFTER real LOCAL purchases/deploy/send. Not an AI-production
        // policy or a public local→AI switch; the ordinary new-AI run is tested separately.
        run = { session: run.session, control: computer }; restored = { session: restored.session, control: computer };
      }
      checkpoint(() => {
        if (factionId === 'blue' && source === 'library') store.data.delete(ShipDesignManager.STORAGE_KEY);
      });
      expect(restored.session.ships.filter(x => x.factionId === factionId).map(x => [x.id, x.systemId, x.fuel, x.transit]))
        .toEqual(shipIds.map(id => [id, systemId, 2, { destinationId, remainingTurns: 1 }]));
      const ending = requestFor(restored.session), result = both();
      if (!('summary' in result)) throw new Error('Expected explicit AI summary');
      expect(result.summary.endTurnEconomy).toMatchObject({ factionId, turn: ending.expectedTurn,
        upkeep: { shipCount: 2, dueCredits: 2, paidCredits: 2, shortfallCredits: 0 }, treasuryAfter: { credits: 188, minerals: 258 } });
      expect(executeRunAiTurn(restored, ending)).toMatchObject({ ok: false, code: 'STALE_TURN' });
      // A failed save after an already accepted AI does NOT undo gameplay or the earlier slot.
      const accepted = restored, acceptedBefore = structuredClone(restored), stored = new Map(store.data);
      const reads = store.getItem.mock.calls.length, writes = store.setItem.mock.calls.length; store.failWrite = true;
      expect(new CampaignRunSaveManager(store).save(restored)).toEqual({ ok: false, code: 'STORAGE_WRITE_FAILED',
        message: 'Не удалось записать кампанию: хранилище недоступно или заполнено' });
      expect(restored).toBe(accepted); expect(restored).toEqual(acceptedBefore); expect(restored).toEqual(run);
      expect(store.data).toEqual(stored); expect(store.getItem).toHaveBeenCalledTimes(reads);
      expect(store.setItem).toHaveBeenCalledTimes(writes + 1); store.failWrite = false;
      expect(loaded(store).session.turn).toBe(ending.expectedTurn); // Prior checkpoint still available, not replayed.
    }
    expect(checkpoints).toEqual([31, 45, 46]); expect(restored.session.turn).toBe(47);
    expect(restored.control).toEqual(mode === 'local' ? local : computer);
    expect(restored.session.production).toEqual({ lastOrderId: 4, orders: [], completed: [] });
    expect(restored.session.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(restored.session.ships.map(x => [x.id, x.systemId, x.fuel, x.transit])).toEqual([
      [2, 'eden', 2, undefined], [1, 'eden', 2, undefined], [4, 'nexus', 2, undefined], [3, 'nexus', 2, undefined]
    ]);
    expect(restored.session.fleets).toEqual({ lastFleetId: 2, items: [
      { id: 1, factionId: 'blue', systemId: 'eden', shipIds: [2, 1] }, { id: 2, factionId: 'red', systemId: 'nexus', shipIds: [4, 3] }
    ] });
    snapshots();
    const historicalPort: StoragePort = { getItem: vi.fn(() => checkpoint31), setItem: vi.fn(() => { throw new Error('Unexpected upgrade'); }) };
    expect(loaded(historicalPort)).toEqual(run31); expect(historicalPort.getItem).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(historicalPort.setItem).not.toHaveBeenCalled();
    const expectedOthers = new Map(initialStorage); if (source === 'library') expectedOthers.delete(ShipDesignManager.STORAGE_KEY);
    expect(otherKeys()).toEqual(expectedOthers); expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
  });
});

describe('ordinary new AI-mode run (no diagnostic red purchases or auto-resume)', () => {
  it('saves on red, new-manager load does nothing, later explicit AI matches uninterrupted and keeps authorization', () => {
    const fresh = createCampaignRun(computer); if (!fresh.ok) throw new Error(fresh.code);
    const run = manual(fresh.run, { kind: 'endTurn', ...requestFor(fresh.run.session) }).run, store = new MemoryStorage();
    expect(new CampaignRunSaveManager(store).save(run)).toEqual({ ok: true }); const before = new Map(store.data);
    const restored = loaded(store); expect(restored).toEqual(run); expect(restored.session.turn).toBe(2);
    expect(restored.session.treasuries.red).toEqual({ credits: 100, minerals: 50 }); expect(store.data).toEqual(before);
    expect(executeRunCommand(restored, { kind: 'endTurn', ...requestFor(restored.session) }))
      .toMatchObject({ ok: false, code: 'FACTION_CONTROLLED_BY_AI' });
    const result = ai(restored); expect(result).toEqual(ai(run)); expect(result.run.session.turn).toBe(3);
    expect(result.run.session.treasuries.red).toEqual({ credits: 110, minerals: 55 });
    expect(store.data).toEqual(before); expect(store.getItem.mock.calls).toEqual([[KEY]]); expect(store.setItem).toHaveBeenCalledTimes(1);
    expect(new CampaignRunSaveManager(store).save(result.run)).toEqual({ ok: true }); const again = loaded(store);
    expect(again).toEqual(result.run);
    expect(executeRunAiTurn(again, requestFor(again.session))).toMatchObject({ ok: false, code: 'AI_NOT_ASSIGNED' });
  });
});