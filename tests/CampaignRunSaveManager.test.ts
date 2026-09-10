import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CampaignRunSaveManager, type CampaignStorageErrorCode, type CampaignStorageFailure,
  type LoadCampaignRunResult, type SaveCampaignRunResult } from '../src/utils/CampaignRunSaveManager';
import { CampaignSaveManager } from '../src/utils/CampaignSaveManager';
import { decodeCampaignRunSave, encodeCampaignRunSave, type CampaignRunSaveErrorCode,
  type CampaignRunSaveFailure, type DecodeCampaignRunSaveResult } from '../src/domain/campaignRunSave';
import * as codec from '../src/domain/campaignRunSave';
import { encodeCampaignSave, MAX_CAMPAIGN_SAVE_BYTES } from '../src/domain/campaignSave';
import { campaignRunSchema, type CampaignRun } from '../src/domain/campaignRun';
import * as runs from '../src/domain/campaignRun';
import { createCampaignSession, MAX_RESOURCE, MAX_TURN, type CampaignSession } from '../src/domain/campaignSession';
import * as sessions from '../src/domain/campaignSession';
import * as executor from '../src/domain/campaignAiExecutor';
import * as planner from '../src/domain/campaignAiPlanner';
import * as presets from '../src/domain/combatPresets';
import * as civilian from '../src/domain/civilianPresets';
import * as designs from '../src/domain/shipDesign';
import * as catalog from '../src/utils/ProductionCatalog';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { freeze, rich, requestFor } from './fixtures/campaignAi';

const KEY = 'orion_campaign_v1'; // Independent public contract assertion.
const local = { mode: 'local' } as const;
const computer = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } as const;
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const fresh = (): CampaignRun => ({ session: createCampaignSession(), control: local });
const diagnostic = (turn = 1, control: CampaignRun['control'] = local): CampaignRun => ({ session: rich(turn, 3), control });
const documentFor = (run: CampaignRun) => JSON.stringify({ format: 'orion-campaign', schemaVersion: 2,
  rulesVersion: 1, session: run.session, control: run.control });

// Never access the real host storage, even when testing the default adapter.
function globalStorage(get: () => unknown): void {
  vi.stubGlobal('localStorage', undefined);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });
}
beforeEach(() => globalStorage(() => { throw new Error('PRIVATE: unexpected host access'); }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Atomic set-or-throw is a PORT contract, not manager rollback or a browser quota test. */
class MemoryStorage implements StoragePort {
  readonly data = new Map<string, string>([
    ['orion_shipyard_v2', '{unrelated v2'], ['orion_shipyard_v1', '{unrelated v1'],
    ['orion_ship_configs', '[]'], ['orion_components', '[]'],
    ['orion_campaign_v0', 'not a fallback'], ['other-app', 'Сохранить 🚀']
  ]);
  readFailure?: { value: unknown };
  writeFailure?: { value: unknown };
  readonly getItem = vi.fn((key: string): string | null => {
    if (this.readFailure) throw this.readFailure.value;
    return this.data.get(key) ?? null;
  });
  readonly setItem = vi.fn((key: string, value: string): void => {
    if (this.writeFailure) throw this.writeFailure.value;
    this.data.set(key, value);
  });
  readonly removeItem = vi.fn(() => { throw new Error('Forbidden remove'); });
  readonly clear = vi.fn(() => { throw new Error('Forbidden clear'); });
}
function noCleanup(store: MemoryStorage): void {
  expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
}
function noWrites(store: MemoryStorage): void { expect(store.setItem).not.toHaveBeenCalled(); noCleanup(store); }
function encoded(run: unknown): string {
  const result = encodeCampaignRunSave(run); if (!result.ok) throw new Error(result.code); return result.json;
}
function legacy(run: CampaignRun): string {
  const result = encodeCampaignSave(run.session); if (!result.ok) throw new Error(result.code); return result.json;
}
function loaded(manager: CampaignRunSaveManager): CampaignRun {
  const result = manager.load(); if (!result.ok) throw new Error(result.code);
  expect(Object.keys(result).sort()).toEqual(['ok', 'run']); return result.run;
}
function failure(result: LoadCampaignRunResult | SaveCampaignRunResult, code: CampaignStorageErrorCode | CampaignRunSaveErrorCode): void {
  expect(result).toMatchObject({ ok: false, code }); if (result.ok) throw new Error('Expected failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/); expect(result.message.length).toBeLessThan(250);
  expect(result.message).not.toMatch(/PRIVATE|SecurityError|QuotaExceededError|Error:|issues|\.ts:/);
}
function sizedRun(size: number, control: CampaignRun['control'] = local, version = 2): CampaignRun {
  const run = fresh(), design = presets.createCombatDesign('fighter'); run.control = control;
  design.name = 'Юникод 🚀'; design.createdAt = '2026-09-10T00:00:00.0Z';
  run.session.production.lastOrderId = 1;
  run.session.ships.push({ id: 1, factionId: 'blue', systemId: 'sol', fuel: 3, design });
  const base = version === 1 ? legacy(run) : encoded(run);
  design.createdAt = `2026-09-10T00:00:00.${'0'.repeat(size - bytes(base) + 1)}Z`;
  expect(campaignRunSchema.safeParse(run).success).toBe(true);
  return run;
}

describe('public types, shared key and lazy adapter', () => {
  it('preserves the policy error union and returns full run, never legacy state/json on success', () => {
    expect(CampaignRunSaveManager.STORAGE_KEY).toBe(KEY);
    expect(CampaignRunSaveManager.STORAGE_KEY).toBe(CampaignSaveManager.STORAGE_KEY);
    expectTypeOf<LoadCampaignRunResult>().toEqualTypeOf<DecodeCampaignRunSaveResult | CampaignStorageFailure>();
    expectTypeOf<SaveCampaignRunResult>().toEqualTypeOf<{ ok: true } | CampaignRunSaveFailure | CampaignStorageFailure>();
    expectTypeOf<ReturnType<CampaignRunSaveManager['load']>>().toEqualTypeOf<LoadCampaignRunResult>();
    expectTypeOf<ReturnType<CampaignRunSaveManager['save']>>().toEqualTypeOf<SaveCampaignRunResult>();
    expectTypeOf<Parameters<CampaignRunSaveManager['save']>>().toEqualTypeOf<[unknown]>();
    expectTypeOf<Extract<LoadCampaignRunResult, { ok: true }>>().toEqualTypeOf<{ ok: true; run: CampaignRun }>();
    expectTypeOf<Extract<SaveCampaignRunResult, { ok: false }>['code']>().toEqualTypeOf<CampaignStorageErrorCode | CampaignRunSaveErrorCode>();
    expectTypeOf<CampaignStorageErrorCode>().toEqualTypeOf<'SAVE_NOT_FOUND' | 'STORAGE_READ_FAILED' | 'STORAGE_WRITE_FAILED'>();
  });

  it('imports and constructs without IO, codec work, clock or RNG, including the shared legacy class', async () => {
    const access = vi.fn(() => { throw new Error('PRIVATE'); }); globalStorage(access);
    const store = new MemoryStorage(), now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    const encode = vi.spyOn(codec, 'encodeCampaignRunSave'), decode = vi.spyOn(codec, 'decodeCampaignRunSave');
    vi.resetModules();
    const module = await import('../src/utils/CampaignRunSaveManager');
    new module.CampaignRunSaveManager(); new module.CampaignRunSaveManager(store);
    expect(access).not.toHaveBeenCalled(); expect(store.getItem).not.toHaveBeenCalled(); noWrites(store);
    expect(now).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
  });

  it('resolves the global anew once per operation, not on construction and not from a cached port', () => {
    const a = new MemoryStorage(), b = new MemoryStorage(), run = fresh(); let current = a;
    const access = vi.fn(() => current); globalStorage(access); const manager = new CampaignRunSaveManager();
    expect(access).not.toHaveBeenCalled(); expect(manager.save(run)).toEqual({ ok: true });
    expect(a.getItem).not.toHaveBeenCalled(); current = b; failure(manager.load(), 'SAVE_NOT_FOUND');
    current = a; expect(loaded(manager)).toEqual(run);
    expect(access).toHaveBeenCalledTimes(3); expect(a.setItem.mock.calls).toEqual([[KEY, encoded(run)]]);
    expect(a.getItem.mock.calls).toEqual([[KEY]]); expect(b.getItem.mock.calls).toEqual([[KEY]]); noWrites(b);
  });

  it('uses injected storage exclusively and calls encode/decode once with the actual input/bytes', () => {
    const access = vi.fn(() => { throw new Error('PRIVATE'); }); globalStorage(access);
    const store = new MemoryStorage(), manager = new CampaignRunSaveManager(store), run = diagnostic(2, computer);
    const json = encoded(run), encode = vi.spyOn(codec, 'encodeCampaignRunSave'), decode = vi.spyOn(codec, 'decodeCampaignRunSave');
    expect(manager.save(run)).toEqual({ ok: true }); expect(loaded(manager)).toEqual(run);
    expect(encode.mock.calls).toEqual([[run]]); expect(decode.mock.calls).toEqual([[json]]);
    expect(access).not.toHaveBeenCalled(); expect(store.getItem.mock.calls).toEqual([[KEY]]);
    expect(store.setItem.mock.calls).toEqual([[KEY, json]]); noCleanup(store);
  });
});

describe('real codec read failures and no repair', () => {
  const cases: [string, () => unknown, CampaignRunSaveErrorCode | 'SAVE_NOT_FOUND'][] = [
    ['null only is missing', () => null, 'SAVE_NOT_FOUND'],
    ...['', ' \n\t', '{PRIVATE', 'null', '[]'].map((text): [string, () => unknown, CampaignRunSaveErrorCode] => [JSON.stringify(text), () => text, 'INVALID_SAVE']),
    ['wrong port return undefined', () => undefined, 'INVALID_SAVE'],
    ['wrong port return object', () => ({}), 'INVALID_SAVE'],
    ['bare run', () => JSON.stringify(fresh()), 'INVALID_SAVE'],
    ['bare session', () => JSON.stringify(createCampaignSession()), 'INVALID_SAVE'],
    ['library', () => '{"schemaVersion":2,"designs":[],"components":[]}', 'INVALID_SAVE'],
    ['missing session before future schema', () => JSON.stringify({ format: 'orion-campaign', schemaVersion: 9, rulesVersion: 9 }), 'INVALID_SAVE'],
    ['future schema before control/rules', () => JSON.stringify({ ...JSON.parse(documentFor(fresh())), session: null, control: null, schemaVersion: 9, rulesVersion: 9 }), 'UNSUPPORTED_SAVE_VERSION'],
    ['future rules before control/session', () => JSON.stringify({ ...JSON.parse(documentFor(fresh())), session: null, control: null, rulesVersion: 9 }), 'UNSUPPORTED_RULES_VERSION'],
    ['new missing control', () => JSON.stringify({ format: 'orion-campaign', schemaVersion: 2, rulesVersion: 1, session: null }), 'INVALID_SAVE'],
    ['legacy with control', () => documentFor(fresh()).replace('"schemaVersion":2', '"schemaVersion":1'), 'INVALID_SAVE'],
    ['malformed policy', () => JSON.stringify({ ...JSON.parse(documentFor(fresh())), control: { mode: 'human-vs-ai', aiPolicy: 'future\n' } }), 'INVALID_SAVE'],
    ['unknown policy before invalid session', () => JSON.stringify({ ...JSON.parse(documentFor(fresh())), session: null, control: { mode: 'human-vs-ai', aiPolicy: 'future-v2' } }), 'UNSUPPORTED_AI_POLICY'],
    ['null session', () => JSON.stringify({ ...JSON.parse(documentFor(fresh())), session: null }), 'INVALID_STATE'],
    ['oversize ASCII', () => '{' + ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES), 'SAVE_TOO_LARGE'],
    ['oversize Unicode 5MB+1', () => 'Я'.repeat(2_500_000) + '!', 'SAVE_TOO_LARGE']
  ];
  it.each(cases)('%s: one get, unchanged codec error, no writes/fallback or partial result', (_name, makeRaw, code) => {
    const raw = makeRaw(), store = new MemoryStorage();
    if (typeof raw === 'string') store.data.set(KEY, raw);
    store.getItem.mockImplementation(() => raw as string | null); // Deliberately malformed external port values.
    const before = new Map(store.data), expected = raw === null ? undefined : decodeCampaignRunSave(raw);
    const parse = vi.spyOn(JSON, 'parse'), decode = vi.spyOn(codec, 'decodeCampaignRunSave');
    const result = new CampaignRunSaveManager(store).load(); failure(result, code);
    if (raw === null) expect(decode).not.toHaveBeenCalled(); else expect(result).toEqual(expected);
    if (code === 'SAVE_TOO_LARGE') expect(parse).not.toHaveBeenCalled();
    expect(store.getItem.mock.calls).toEqual([[KEY]]); noWrites(store); expect(store.data).toEqual(before);
  });

  const corruptions: [string, (s: CampaignSession) => void][] = [
    ['hidden fuel', s => { s.ships[3].fuel = -1; }],
    ['hidden ownership', s => { s.galaxy.systems.find(x => x.id === 'nexus')!.ownerId = 'blue'; }],
    ['partial group transit', s => { delete s.ships[0].transit; }],
    ['missing group member', s => { s.fleets.items[1].shipIds[0] = 199; }],
    ['waiting FIFO progress', s => { s.production.orders[5].remainingTurns = 3; }],
    ['ship-order collision', s => { s.production.orders[0].id = 3; }],
    ['ID beyond counter', s => { s.production.lastOrderId = 1; }],
    ['non-flight snapshot', s => { s.ships[3].design.slots.find(x => x.id === 'engine_1')!.component = null; }],
    ['hidden treasury', s => { s.treasuries.red.credits = -1; }]
  ];
  describe.each([local, computer])('whole-run cross-state %j', control => {
    it.each(corruptions)('%s fails on both save and load with real schema; source and every key unchanged', (_name, damage) => {
      const run = diagnostic(2, control); damage(run.session); const snapshot = structuredClone(run); freeze(run);
      const store = new MemoryStorage(); store.data.set(KEY, documentFor(run)); const before = new Map(store.data);
      const manager = new CampaignRunSaveManager(store);
      failure(manager.load(), 'INVALID_STATE'); failure(manager.save(run), 'INVALID_STATE');
      expect(store.getItem.mock.calls).toEqual([[KEY]]); noWrites(store);
      expect(store.data).toEqual(before); expect(run).toEqual(snapshot);
    });
  });
});

describe('legacy compatibility and explicit upgrade only', () => {
  it.each([1, 2])('load1 at turn%s restores local without inheriting prior AI or writing; only explicit save upgrades', turn => {
    const run = diagnostic(turn), old = legacy(run), store = new MemoryStorage(), manager = new CampaignRunSaveManager(store);
    store.data.set(KEY, encoded({ ...run, control: computer })); expect(loaded(manager).control).toEqual(computer);
    store.data.set(KEY, old); store.getItem.mockClear(); const before = new Map(store.data);
    const first = loaded(manager), second = loaded(new CampaignRunSaveManager(store));
    expect(first).toEqual(run); expect(second).toEqual(run); expect(first).not.toBe(second);
    expect(store.getItem.mock.calls).toEqual([[KEY], [KEY]]); noWrites(store); expect(store.data).toEqual(before);
    expect(new CampaignSaveManager(store).load()).toEqual({ ok: true, state: run.session });
    const reads = store.getItem.mock.calls.length;
    expect(manager.save(first)).toEqual({ ok: true }); expect(store.getItem).toHaveBeenCalledTimes(reads);
    expect(store.setItem.mock.calls).toEqual([[KEY, encoded(run)]]);
    expect(JSON.parse(store.data.get(KEY)!)).toMatchObject({ schemaVersion: 2, rulesVersion: 1, control: local });
    expect(new CampaignSaveManager(store).load().ok).toBe(false);
    expect(loaded(new CampaignRunSaveManager(store))).toEqual(run);
    expect(store.data).toEqual(new Map(before).set(KEY, encoded(run))); noCleanup(store);
  });

  it('a valid legacy document at exactly 5MB loads, but explicit upgraded save fails without losing old bytes', () => {
    const run = sizedRun(MAX_CAMPAIGN_SAVE_BYTES, local, 1), old = legacy(run);
    expect(bytes(old)).toBe(MAX_CAMPAIGN_SAVE_BYTES);
    const store = new MemoryStorage(); store.data.set(KEY, old); const before = new Map(store.data);
    const manager = new CampaignRunSaveManager(store), restored = loaded(manager); expect(restored).toEqual(run);
    failure(manager.save(restored), 'SAVE_TOO_LARGE'); expect(store.getItem.mock.calls).toEqual([[KEY]]);
    noWrites(store); expect(store.data).toEqual(before);
  });
});

const exceptions = [
  ['SecurityError', () => new DOMException('PRIVATE', 'SecurityError')],
  ['QuotaExceededError', () => new DOMException('PRIVATE', 'QuotaExceededError')],
  ['Error', () => new Error('PRIVATE')], ['string', () => 'PRIVATE'], ['undefined', () => undefined]
] as const;
describe.each(exceptions)('safe storage failures: %s', (_name, makeError) => {
  it.each(['load', 'save'] as const)('%s contains throwing global getter', operation => {
    const run = fresh(), access = vi.fn(() => { throw makeError(); }); globalStorage(access);
    const manager = new CampaignRunSaveManager(); expect(access).not.toHaveBeenCalled();
    const result = operation === 'load' ? manager.load() : manager.save(run);
    const code = operation === 'load' ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED'; failure(result, code);
    expect(result).toEqual({ ok: false, code, message: operation === 'load' ? 'Не удалось прочитать сохранение кампании'
      : 'Не удалось записать кампанию: хранилище недоступно или заполнено' });
    expect(access).toHaveBeenCalledTimes(1);
  });
  it('contains getItem failure without decoding, rereading or returning a previous cached candidate', () => {
    const store = new MemoryStorage(), manager = new CampaignRunSaveManager(store); store.data.set(KEY, encoded(fresh()));
    loaded(manager); store.getItem.mockClear(); store.readFailure = { value: makeError() };
    const before = new Map(store.data), decode = vi.spyOn(codec, 'decodeCampaignRunSave');
    failure(manager.load(), 'STORAGE_READ_FAILED'); expect(decode).not.toHaveBeenCalled();
    expect(store.getItem.mock.calls).toEqual([[KEY]]); noWrites(store); expect(store.data).toEqual(before);
  });
  it.each(['absent', 'legacy', 'new', 'corrupt'] as const)('failed set preserves %s bytes and every other key; never reads/repairs', old => {
    const store = new MemoryStorage(), run = diagnostic(2, computer), snapshot = structuredClone(run); freeze(run);
    if (old !== 'absent') store.data.set(KEY, old === 'legacy' ? legacy(fresh()) : old === 'new' ? encoded(fresh()) : '{corrupt');
    const before = new Map(store.data); store.writeFailure = { value: makeError() };
    failure(new CampaignRunSaveManager(store).save(run), 'STORAGE_WRITE_FAILED');
    expect(store.setItem.mock.calls).toEqual([[KEY, encoded(run)]]); expect(store.getItem).not.toHaveBeenCalled();
    expect(store.data).toEqual(before); expect(run).toEqual(snapshot); noCleanup(store);
  });
});

describe('malformed ports are contained, not used as fallback triggers', () => {
  it.each([undefined, null, {}, 42, { getItem: 42, setItem: null }])('wrong default port %j', port => {
    globalStorage(() => port); const manager = new CampaignRunSaveManager();
    failure(manager.load(), 'STORAGE_READ_FAILED'); failure(manager.save(fresh()), 'STORAGE_WRITE_FAILED');
  });
  it.each([{}, 42, { getItem: null, setItem: 'wrong' }])('wrong injected port %j never resolves global', port => {
    const access = vi.fn(() => { throw new Error('PRIVATE'); }); globalStorage(access);
    const manager = new CampaignRunSaveManager(port as unknown as StoragePort); // Deliberately violate the typed port boundary.
    failure(manager.load(), 'STORAGE_READ_FAILED'); failure(manager.save(fresh()), 'STORAGE_WRITE_FAILED');
    expect(access).not.toHaveBeenCalled();
  });
  it.each(['getItem', 'setItem'] as const)('contains a throwing injected method accessor %s', method => {
    const access = vi.fn(() => { throw new DOMException('PRIVATE', 'SecurityError'); });
    const port = { getItem: () => null, setItem: () => {} }; Object.defineProperty(port, method, { get: access });
    const manager = new CampaignRunSaveManager(port);
    failure(method === 'getItem' ? manager.load() : manager.save(fresh()), method === 'getItem' ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED');
    expect(access).toHaveBeenCalledTimes(1);
  });
});

describe('encode before getter or methods, then one complete atomic overwrite', () => {
  const invalid: [string, () => unknown, CampaignRunSaveErrorCode][] = [
    ['null', () => null, 'INVALID_STATE'], ['undefined', () => undefined, 'INVALID_STATE'],
    ['bare session', createCampaignSession, 'INVALID_STATE'], ['missing session', () => ({ control: local }), 'INVALID_STATE'],
    ['missing control', () => ({ session: createCampaignSession() }), 'INVALID_STATE'],
    ['unknown policy', () => ({ ...fresh(), control: { mode: 'human-vs-ai', aiPolicy: 'future' } }), 'INVALID_STATE'],
    ['nonfinite resource', () => { const run = fresh(); run.session.treasuries.red.credits = Infinity; return run; }, 'INVALID_STATE'],
    ['extra summary', () => ({ ...fresh(), summary: {} }), 'INVALID_STATE'],
    ['valid oversize', () => sizedRun(MAX_CAMPAIGN_SAVE_BYTES + 1), 'SAVE_TOO_LARGE']
  ];
  it.each(invalid)('%s never resolves global nor touches injected port; codec result forwarded', (_name, makeRun, code) => {
    const run = makeRun(), beforeRun = structuredClone(run), expected = encodeCampaignRunSave(run); freeze(run);
    const access = vi.fn(() => { throw new DOMException('PRIVATE', 'SecurityError'); }); globalStorage(access);
    const store = new MemoryStorage(); store.data.set(KEY, legacy(fresh())); const before = new Map(store.data);
    for (const manager of [new CampaignRunSaveManager(), new CampaignRunSaveManager(store)]) {
      const result = manager.save(run); failure(result, code); expect(result).toEqual(expected);
    }
    expect(access).not.toHaveBeenCalled(); expect(store.getItem).not.toHaveBeenCalled(); noWrites(store);
    expect(store.data).toEqual(before); expect(run).toEqual(beforeRun);
  });
  it('fully encodes before global getter and set, and reports success only after synchronous set returns', () => {
    const run = diagnostic(), snapshot = structuredClone(run), json = encoded(run), store = new MemoryStorage();
    const encode = vi.spyOn(codec, 'encodeCampaignRunSave'); const steps: string[] = [];
    globalStorage(() => {
      expect(encode).toHaveBeenCalledTimes(1); steps.push('getter');
      // A reentrant caller mutation cannot affect the already detached encoded snapshot.
      run.session.treasuries.red.credits = 0; return store;
    });
    store.setItem.mockImplementation((key, value) => { steps.push('set'); expect(value).toBe(json); store.data.set(key, value); steps.push('returned'); });
    expect(new CampaignRunSaveManager().save(run)).toEqual({ ok: true }); steps.push('success');
    expect(steps).toEqual(['getter', 'set', 'returned', 'success']);
    expect(loaded(new CampaignRunSaveManager(store))).toEqual(snapshot); expect(store.setItem.mock.calls).toEqual([[KEY, json]]);
  });
  it.each(['absent', 'legacy', 'new', 'corrupt'] as const)('explicit save replaces %s without reading or asking confirmation', old => {
    const run = diagnostic(2, computer), snapshot = structuredClone(run), store = new MemoryStorage(); freeze(run);
    if (old !== 'absent') store.data.set(KEY, old === 'legacy' ? legacy(fresh()) : old === 'new' ? encoded(fresh()) : '{corrupt');
    const before = new Map(store.data); store.readFailure = { value: new Error('Forbidden read') };
    expect(new CampaignRunSaveManager(store).save(run)).toEqual({ ok: true });
    expect(store.setItem.mock.calls).toEqual([[KEY, encoded(run)]]); expect(store.getItem).not.toHaveBeenCalled();
    expect(store.data).toEqual(new Map(before).set(KEY, encoded(run))); expect(run).toEqual(snapshot); noCleanup(store);
  });
  it.each([local, computer])('exact5MB / +1 UTF-8 for %j uses real snapshots, not a mocked encoder', control => {
    const exact = sizedRun(MAX_CAMPAIGN_SAVE_BYTES, control), json = encoded(exact), store = new MemoryStorage();
    expect(bytes(json)).toBe(MAX_CAMPAIGN_SAVE_BYTES); expect(json.length).toBeLessThan(MAX_CAMPAIGN_SAVE_BYTES);
    freeze(exact); expect(new CampaignRunSaveManager(store).save(exact)).toEqual({ ok: true });
    expect(loaded(new CampaignRunSaveManager(store))).toEqual(exact); const before = new Map(store.data);
    const oversized = sizedRun(MAX_CAMPAIGN_SAVE_BYTES + 1, control); expect(bytes(documentFor(oversized))).toBe(MAX_CAMPAIGN_SAVE_BYTES + 1);
    failure(new CampaignRunSaveManager(store).save(oversized), 'SAVE_TOO_LARGE');
    expect(store.setItem.mock.calls).toEqual([[KEY, json]]); expect(store.getItem.mock.calls).toEqual([[KEY]]);
    expect(store.data).toEqual(before); noCleanup(store);
  });
});

describe('detached full snapshots, no cache or game execution', () => {
  describe.each([local, computer])('%j', control => {
    it.each([1, 2])('new instances preserve both sides and all nested snapshots at turn%s', turn => {
      const run = diagnostic(turn, control), before = structuredClone(run), store = new MemoryStorage(); freeze(run);
      expect(new CampaignRunSaveManager(store).save(run)).toEqual({ ok: true }); const stored = new Map(store.data);
      const first = loaded(new CampaignRunSaveManager(store)), second = loaded(new CampaignRunSaveManager(store));
      expect(first).toEqual(before); expect(second).toEqual(before); expect(first).not.toBe(second);
      first.control.mode = 'human-vs-ai'; first.session.treasuries.red.credits = 0;
      first.session.ships[0].design.slots.find(x => x.component)!.component!.name = 'Изменение';
      first.session.ships[0].transit!.destinationId = 'sol'; first.session.ships[0].fuel = 3;
      first.session.production.orders[0].design.name = 'Изменён заказ'; first.session.production.completed[0].design.name = 'Изменён готовый';
      first.session.fleets.items[0].shipIds.reverse(); first.session.galaxy.systems[0].exploredBy.push('red');
      expect(first.session.ships[1]).toEqual(before.session.ships[1]);
      expect(first.session.production.orders[1]).toEqual(before.session.production.orders[1]);
      expect(second).toEqual(before); expect(run).toEqual(before); expect(loaded(new CampaignRunSaveManager(store))).toEqual(before);
      expect(store.getItem.mock.calls).toEqual([[KEY], [KEY], [KEY]]); expect(store.setItem).toHaveBeenCalledTimes(1);
      expect(store.data).toEqual(stored); noCleanup(store);
    });
  });
  it('never retains caller aliases or candidate mutations across later loads', () => {
    const run = diagnostic(), store = new MemoryStorage(), manager = new CampaignRunSaveManager(store);
    run.session.ships[1].design = run.session.ships[0].design; run.session.ships[1].transit = run.session.ships[0].transit;
    const before = structuredClone(run); expect(manager.save(run)).toEqual({ ok: true });
    run.session.ships[0].design.name = 'Caller mutation'; run.control = computer;
    const restored = loaded(manager); expect(restored).toEqual(before);
    expect(restored.session.ships[0].design).not.toBe(restored.session.ships[1].design);
    expect(restored.session.ships[0].transit).not.toBe(restored.session.ships[1].transit);
    expect(loaded(new CampaignRunSaveManager(store))).toEqual(before);
  });
  it('two instances are last-successful-writer-wins, not a concurrency/security protocol', () => {
    const store = new MemoryStorage(), a = new CampaignRunSaveManager(store), b = new CampaignRunSaveManager(store);
    const first = diagnostic(), second = diagnostic(2, computer);
    expect(a.save(first)).toEqual({ ok: true }); const candidate = loaded(b);
    expect(b.save(second)).toEqual({ ok: true }); expect(loaded(a)).toEqual(second); expect(candidate).toEqual(first);
    const before = new Map(store.data); store.writeFailure = { value: new DOMException('PRIVATE', 'QuotaExceededError') };
    failure(a.save(first), 'STORAGE_WRITE_FAILED'); expect(store.data).toEqual(before); expect(loaded(b)).toEqual(second);
    store.writeFailure = undefined; expect(a.save(first)).toEqual({ ok: true }); expect(loaded(b)).toEqual(first);
    store.data.set(KEY, '{external corruption'); failure(a.load(), 'INVALID_SAVE');
    store.data.delete(KEY); failure(b.load(), 'SAVE_NOT_FOUND');
    store.data.set(KEY, legacy(second)); expect(loaded(a)).toEqual({ session: second.session, control: local });
    expect(store.getItem).toHaveBeenCalledTimes(7); expect(store.setItem).toHaveBeenCalledTimes(4); noCleanup(store);
  });
  it.each(['terminal', 'credits-cap', 'minerals-cap', 'deficit'] as const)('preserves valid %s without advancing, paying or repairing', kind => {
    const run: CampaignRun = { session: rich(kind === 'terminal' ? MAX_TURN : 2), control: computer };
    if (kind === 'credits-cap') run.session.treasuries.red.credits = MAX_RESOURCE;
    if (kind === 'minerals-cap') run.session.treasuries.red.minerals = MAX_RESOURCE;
    if (kind === 'deficit') run.session.treasuries.red.credits = 5;
    const before = structuredClone(run); freeze(run); const store = new MemoryStorage();
    expect(new CampaignRunSaveManager(store).save(run)).toEqual({ ok: true }); const restored = loaded(new CampaignRunSaveManager(store));
    expect(restored).toEqual(before); expect(run).toEqual(before);
    expect(runs.executeRunAiTurn(restored, requestFor(restored.session))).toEqual(runs.executeRunAiTurn(run, requestFor(run.session)));
    expect(store.getItem.mock.calls).toEqual([[KEY]]); expect(store.setItem).toHaveBeenCalledTimes(1);
    expect(store.data.get(KEY)).not.toMatch(/summary|endTurnEconomy|economyForecast|ticket|paused/);
  });
  it('save/load never calls commands, AI, catalog, factories, clocks, RNG, scheduling or network', () => {
    const run = diagnostic(2, computer), store = new MemoryStorage(), before = structuredClone(run), json = encoded(run); freeze(run);
    const spies = [vi.spyOn(runs, 'createCampaignRun'), vi.spyOn(runs, 'executeRunCommand'), vi.spyOn(runs, 'executeRunAiTurn'),
      vi.spyOn(sessions, 'createCampaignSession'), vi.spyOn(sessions, 'executeSessionCommand'), vi.spyOn(executor, 'executeAiTurn'),
      vi.spyOn(planner, 'planAiTurn'), vi.spyOn(catalog, 'loadProductionCatalog'), vi.spyOn(presets, 'createCombatDesign'),
      vi.spyOn(civilian, 'createCivilianDesign'), vi.spyOn(designs, 'createDesign'), vi.spyOn(designs, 'installComponent'),
      vi.spyOn(ShipDesignManager.prototype, 'load'), vi.spyOn(ShipDesignManager.prototype, 'saveDesign'),
      vi.spyOn(ShipDesignManager.prototype, 'decode'), vi.spyOn(Date, 'now'), vi.spyOn(Math, 'random')];
    const forbidden = vi.fn(() => { throw new Error('PRIVATE: unexpected effect'); });
    for (const name of ['Date', 'fetch', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask']) vi.stubGlobal(name, forbidden);
    expect(new CampaignRunSaveManager(store).save(run)).toEqual({ ok: true });
    expect(loaded(new CampaignRunSaveManager(store))).toEqual(before);
    expect(forbidden).not.toHaveBeenCalled(); spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(store.getItem.mock.calls).toEqual([[KEY]]); expect(store.setItem.mock.calls).toEqual([[KEY, json]]);
  });
});