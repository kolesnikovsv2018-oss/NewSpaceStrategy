import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAiTurn } from '../src/domain/campaignAiExecutor';
import { planAiTurn } from '../src/domain/campaignAiPlanner';
import * as session from '../src/domain/campaignSession';
import { campaignSessionSchema, createCampaignSession, getCampaignSessionView, MAX_RESOURCE,
  type CampaignSession, type SessionCommand } from '../src/domain/campaignSession';
import * as presets from '../src/domain/combatPresets';
import * as designs from '../src/domain/shipDesign';
import * as catalog from '../src/utils/ProductionCatalog';
import { CampaignSaveManager } from '../src/utils/CampaignSaveManager';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { decodeCampaignSave, encodeCampaignSave } from '../src/domain/campaignSave';
import { ai, command, failure, freeze, known, observe, requestFor, rich, sides, threeCommands } from './fixtures/campaignAi';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

class MemoryStorage implements StoragePort {
  readonly data = new Map<string, string>();
  readonly getItem = vi.fn((key: string) => this.data.get(key) ?? null);
  readonly setItem = vi.fn((key: string, value: string) => { this.data.set(key, value); });
}

function hiddenPair(change: string): [CampaignSession, CampaignSession] {
  const first = threeCommands(), design = presets.createCombatDesign('fighter');
  first.production.lastOrderId = 20; first.fleets.lastFleetId = 1;
  first.ships = [1, 2, 3].map(id => ({ id, factionId: 'red', systemId: 'vega', fuel: 3, design: structuredClone(design) }));
  first.fleets.items = [{ id: 1, factionId: 'red', systemId: 'vega', shipIds: [2, 1] }];
  first.production.orders = [4, 5].map(id => ({ id, factionId: 'red', systemId: 'vega', remainingTurns: 4, design: structuredClone(design) }));
  const second = structuredClone(first);
  if (change === 'owner' || change === 'all') known(second, 'nexus', 'red', 'red');
  if (change === 'exploration' || change === 'all') for (const system of second.galaxy.systems) known(second, system.id, 'red');
  if (change === 'treasury' || change === 'all') second.treasuries.red = { credits: MAX_RESOURCE, minerals: 0 };
  if (change === 'FIFO' || change === 'all') second.production.orders[0].remainingTurns = 1;
  if (change === 'ships' || change === 'all') {
    second.ships[2].fuel = 0; second.ships[2].design.name = 'PRIVATE enemy design';
    second.ships.push({ ...structuredClone(second.ships[2]), id: 6 });
  }
  if (change === 'fleets' || change === 'all') second.fleets.items[0].shipIds = [3, 1, 2];
  if (change === 'counters' || change === 'all') {
    second.production.lastOrderId = 1_000_000_000; second.fleets.lastFleetId = 1_000_000_000;
  }
  for (const state of [first, second]) expect(campaignSessionSchema.safeParse(state).success).toBe(true);
  expect(getCampaignSessionView(first, 'blue')).toEqual(getCampaignSessionView(second, 'blue'));
  return [first, second];
}

describe('paired VALID states: privacy and complete-plan/outcome equivalence', () => {
  it.each(['owner', 'exploration', 'treasury', 'FIFO', 'ships', 'fleets', 'counters', 'all'].flatMap(change =>
    [false, true].map(cap => ({ change, cap }))))('$change hidden difference, late cap=$cap', ({ change, cap }) => {
    const [first, second] = hiddenPair(change);
    if (cap) for (const state of [first, second]) state.treasuries.blue.credits = MAX_RESOURCE - 10;
    expect(getCampaignSessionView(first, 'blue')).toEqual(getCampaignSessionView(second, 'blue'));
    const request = requestFor(first), aPlan = planAiTurn(observe(first), request), bPlan = planAiTurn(observe(second), request);
    expect(aPlan).toEqual(bPlan);
    expect(aPlan).toEqual({ ok: true, plan: { commands: [
      { kind: 'colonize', ...request, systemId: 'eden' }, { kind: 'explore', ...request, systemId: 'nexus' }, { kind: 'endTurn', ...request }
    ] } });
    const beforeA = structuredClone(first), beforeB = structuredClone(second); freeze(first); freeze(second);
    const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
    const a = executeAiTurn(first, request), b = executeAiTurn(second, request);
    expect(a.ok).toBe(b.ok);
    if (a.ok && b.ok) {
      expect(a.summary).toEqual(b.summary);
      expect(a.state.treasuries.blue).toEqual(b.state.treasuries.blue);
      expect(a.state.production).toEqual(first.production); expect(b.state.production).toEqual(second.production);
      expect(a.state.ships).toEqual(first.ships); expect(b.state.ships).toEqual(second.ships);
      expect(a.state.fleets).toEqual(first.fleets); expect(b.state.fleets).toEqual(second.fleets);
      expect(a.state.treasuries.red).toEqual(first.treasuries.red); expect(b.state.treasuries.red).toEqual(second.treasuries.red);
      if (change === 'owner' || change === 'all') {
        expect(getCampaignSessionView(a.state, 'blue').galaxy.systems.find(item => item.id === 'nexus')).toMatchObject({ ownerId: null });
        expect(getCampaignSessionView(b.state, 'blue').galaxy.systems.find(item => item.id === 'nexus')).toMatchObject({ ownerId: 'red' });
      }
      expect(JSON.stringify(a.summary)).not.toMatch(/PRIVATE|ownerId|habitable|exploredBy|lastOrderId|lastFleetId|design/);
    } else { expect(a).toEqual(b); failure(a, 'RESOURCE_LIMIT'); }
    expect(first).toEqual(beforeA); expect(second).toEqual(beforeB);
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it('equal MINIMAL observation permits different own FIFO/routes but still equal whole plan/status/summary', () => {
    const first = rich(1, 3), second = structuredClone(first);
    second.production.orders[0].remainingTurns = 2;
    second.ships.filter(item => item.factionId === 'blue').forEach(item => {
      delete item.transit; item.fuel = 3; item.design.name = 'Different own snapshot';
    });
    expect(campaignSessionSchema.safeParse(second).success).toBe(true);
    expect(getCampaignSessionView(first, 'blue')).not.toEqual(getCampaignSessionView(second, 'blue'));
    expect(observe(first)).toEqual(observe(second));
    expect(planAiTurn(observe(first), requestFor(first))).toEqual(planAiTurn(observe(second), requestFor(second)));
    const a = ai(first), b = ai(second);
    expect(a.summary).toEqual(b.summary); expect(a.state).not.toEqual(b.state);
  });
});

describe('real earned preset/library FIFO and group travel; manual purchases, explicit AI ends', () => {
  it.each(['preset', 'library'] as const)('%s: codec AND save/new-manager/load across clocks at31,45,46 →47/188/258/fuel2', source => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T10:00:00Z'));
    const store = new MemoryStorage(), library = new ShipDesignManager(store);
    const created = presets.createCombatDesign('fighter');
    if (source === 'library') library.saveDesign(created);
    const choice = catalog.loadProductionCatalog(library).choices.find(item => source === 'library'
      ? item.source === 'Библиотека' && item.design.id === created.id
      : item.source === 'Пресет' && item.design.hullId === 'fighter')!;
    expect(choice.quote).toEqual({ cost: { credits: 185, minerals: 11 }, turns: 4 });
    const design = choice.design, snapshot = structuredClone(design); freeze(design);
    const originalLibrary = new Map(store.data);
    let state = createCampaignSession();
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'eden' : 'nexus';
      for (const kind of ['explore', 'colonize'] as const) state = command(state, { kind, factionId, systemId, expectedTurn: state.turn });
      state = ai(state).state;
    }
    for (let turn = 3; turn < 29; turn++) state = ai(state).state;
    expect(state.turn).toBe(29);
    expect(state.treasuries).toEqual({ blue: { credits: 380, minerals: 190 }, red: { credits: 380, minerals: 190 } });
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega';
      for (let n = 0; n < 2; n++) state = command(state, { kind: 'enqueueProduction', factionId, systemId, design, expectedTurn: state.turn });
      expect(state.treasuries[factionId]).toEqual({ credits: 10, minerals: 168 });
      state = ai(state).state;
    }
    expect(state.turn).toBe(31);
    expect(state.production.orders.map(item => [item.id, item.remainingTurns])).toEqual([[1, 3], [2, 4], [3, 3], [4, 4]]);
    expect(store.data).toEqual(originalLibrary);
    // Only the TEMPORARY library changes/disappears after prepayment; never edit paid snapshots.
    if (source === 'library') {
      library.saveDesign({ ...snapshot, name: 'Changed library after payment' });
      expect(library.load().designs[0].name).toBe('Changed library after payment');
      store.data.delete(ShipDesignManager.STORAGE_KEY);
      expect(library.load().designs).toEqual([]);
    }
    store.getItem.mockClear(); store.setItem.mockClear();
    let restored = state, codecBranch = state;
    const checkpoints: number[] = [];
    function checkpoint(): void {
      const before = structuredClone(restored), request = requestFor(restored);
      const dispatch = vi.spyOn(session, 'executeSessionCommand');
      const encoded = encodeCampaignSave(codecBranch); if (!encoded.ok) throw new Error(encoded.code);
      const envelope = JSON.parse(encoded.json);
      expect(Object.keys(envelope).sort()).toEqual(['format', 'rulesVersion', 'schemaVersion', 'session']);
      expect(envelope).toMatchObject({ format: 'orion-campaign', schemaVersion: 1, rulesVersion: 1 });
      expect(encoded.json).not.toMatch(/controller|AI|commands|summary|economyForecast|endTurnEconomy|seed/);
      expect(new CampaignSaveManager(store).save(restored)).toEqual({ ok: true });
      vi.setSystemTime(new Date(`2040-01-${String(checkpoints.length + 1).padStart(2, '0')}T00:00:00Z`));
      const decoded = decodeCampaignSave(encoded.json), loaded = new CampaignSaveManager(store).load();
      if (!decoded.ok) throw new Error(decoded.code); if (!loaded.ok) throw new Error(loaded.code);
      codecBranch = decoded.state; restored = loaded.state;
      expect(restored).toEqual(before); expect(codecBranch).toEqual(before);
      expect(requestFor(restored)).toEqual(request); expect(restored).not.toBe(state);
      expect(dispatch).not.toHaveBeenCalled(); dispatch.mockRestore();
      checkpoints.push(state.turn);
    }
    function both(input?: SessionCommand): void {
      const stored = new Map(store.data), reads = store.getItem.mock.calls.length, writes = store.setItem.mock.calls.length;
      if (input) {
        state = command(state, input); restored = command(restored, input); codecBranch = command(codecBranch, input);
        expect(restored).toEqual(state); expect(codecBranch).toEqual(state);
      } else {
        const request = requestFor(state);
        vi.setSystemTime(new Date('2026-09-10T10:00:00Z')); const uninterrupted = ai(state);
        vi.setSystemTime(new Date('2050-12-31T23:59:59Z')); const resumed = ai(restored), decoded = ai(codecBranch);
        expect(resumed).toEqual(uninterrupted); expect(decoded).toEqual(uninterrupted);
        state = uninterrupted.state; restored = resumed.state; codecBranch = decoded.state;
        failure(executeAiTurn(restored, request), 'STALE_TURN');
      }
      expect([...state.production.orders, ...state.production.completed, ...state.ships].map(item => item.design)).toEqual(Array(4).fill(snapshot));
      expect(store.data).toEqual(stored); expect(store.getItem).toHaveBeenCalledTimes(reads); expect(store.setItem).toHaveBeenCalledTimes(writes);
    }
    checkpoint();
    for (let turn = 31; turn < 45; turn++) both();
    expect(state.production.completed.map(item => item.id)).toEqual([1, 3, 2, 4]);
    expect(state.treasuries).toEqual({ blue: { credits: 170, minerals: 248 }, red: { credits: 170, minerals: 248 } });
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega', destinationId = factionId === 'blue' ? 'eden' : 'nexus';
      const shipIds = factionId === 'blue' ? [2, 1] : [4, 3], fleetId = factionId === 'blue' ? 1 : 2;
      for (const orderId of shipIds) both({ kind: 'deployProduction', factionId, systemId, orderId, expectedTurn: state.turn });
      both({ kind: 'createFleet', factionId, systemId, shipIds, expectedTurn: state.turn });
      both({ kind: 'sendFleet', factionId, systemId, destinationId, fleetId, expectedTurn: state.turn });
      checkpoint();
      expect(restored.ships.filter(item => item.factionId === factionId).map(item => [item.fuel, item.transit]))
        .toEqual(Array(2).fill([2, { destinationId, remainingTurns: 1 }]));
      both();
    }
    expect(checkpoints).toEqual([31, 45, 46]);
    expect(state.turn).toBe(47); expect(restored).toEqual(state); expect(codecBranch).toEqual(state);
    expect(state.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(state.production).toEqual({ lastOrderId: 4, orders: [], completed: [] });
    expect(state.ships.map(item => [item.id, item.systemId, item.fuel, item.transit])).toEqual([
      [2, 'eden', 2, undefined], [1, 'eden', 2, undefined], [4, 'nexus', 2, undefined], [3, 'nexus', 2, undefined]
    ]);
    expect(state.fleets).toEqual({ lastFleetId: 2, items: [
      { id: 1, factionId: 'blue', systemId: 'eden', shipIds: [2, 1] },
      { id: 2, factionId: 'red', systemId: 'nexus', shipIds: [4, 3] }
    ] });
    expect(store.getItem.mock.calls).toEqual(Array(3).fill([CampaignSaveManager.STORAGE_KEY]));
    expect(store.setItem).toHaveBeenCalledTimes(3); expect(design).toEqual(snapshot);
  });
});

describe('purity and integration boundary', () => {
  it('makes no runtime clock/RNG/storage/catalog/factory/IO calls, including with existing snapshots', () => {
    const state = rich(1, 3), request = requestFor(state), expected = executeAiTurn(state, request);
    const forbidden = () => { throw new Error('Forbidden external dependency'); };
    const spies = [vi.spyOn(Date, 'now').mockImplementation(forbidden), vi.spyOn(Math, 'random').mockImplementation(forbidden),
      vi.spyOn(performance, 'now').mockImplementation(forbidden), vi.spyOn(catalog, 'loadProductionCatalog').mockImplementation(forbidden),
      vi.spyOn(presets, 'createCombatDesign').mockImplementation(forbidden), vi.spyOn(designs, 'createDesign').mockImplementation(forbidden),
      vi.spyOn(designs, 'installComponent').mockImplementation(forbidden), vi.spyOn(ShipDesignManager.prototype, 'load').mockImplementation(forbidden),
      vi.spyOn(CampaignSaveManager.prototype, 'load').mockImplementation(forbidden), vi.spyOn(CampaignSaveManager.prototype, 'save').mockImplementation(forbidden)];
    vi.stubGlobal('localStorage', undefined);
    const storage = vi.fn(forbidden); Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: storage });
    const date = vi.fn(forbidden), rng = vi.fn(forbidden), io = vi.fn(forbidden);
    vi.stubGlobal('Date', date); vi.stubGlobal('crypto', { randomUUID: rng, getRandomValues: rng });
    vi.stubGlobal('fetch', io); vi.stubGlobal('setTimeout', io); vi.stubGlobal('setInterval', io);
    const actual = executeAiTurn(state, request);
    vi.unstubAllGlobals(); // Restore timing before runner/assertion bookkeeping.
    spies.forEach(spy => { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); });
    expect(storage).not.toHaveBeenCalled(); expect(date).not.toHaveBeenCalled(); expect(rng).not.toHaveBeenCalled(); expect(io).not.toHaveBeenCalled();
    expect(actual).toEqual(expected);
  });

  it('planner has only erased type imports; the game reaches AI only through MainScene → run → executor → planner', () => {
    const root = resolve(import.meta.dirname, '..');
    const plannerPath = resolve(root, 'src/domain/campaignAiPlanner.ts');
    const syntax = ts.createSourceFile(plannerPath, readFileSync(plannerPath, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of syntax.statements) if (ts.isImportDeclaration(statement)) expect(statement.importClause?.isTypeOnly).toBe(true);
    const visited = new Set<string>();
    const imports = new Map<string, Set<string>>();
    function visit(path: string): void {
      if (visited.has(path)) return; visited.add(path);
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of file.statements) {
        if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith('.')) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
        const target = resolve(dirname(path), specifier + '.ts');
        const parents = imports.get(target) ?? new Set<string>(); parents.add(path); imports.set(target, parents);
        visit(target);
      }
    }
    visit(resolve(root, 'src/main.ts'));
    const executorPath = resolve(root, 'src/domain/campaignAiExecutor.ts');
    expect(visited.has(plannerPath)).toBe(true);
    expect(visited.has(executorPath)).toBe(true);
    expect(imports.get(plannerPath)).toEqual(new Set([executorPath]));
    const runPath = resolve(root, 'src/domain/campaignRun.ts');
    expect(imports.get(executorPath)).toEqual(new Set([runPath]));
    expect(imports.get(runPath)).toContain(resolve(root, 'src/scenes/MainScene.ts'));
  });
});