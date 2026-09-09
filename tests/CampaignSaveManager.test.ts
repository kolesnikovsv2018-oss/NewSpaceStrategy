import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CampaignSaveManager, type CampaignStorageErrorCode, type CampaignStorageFailure,
  type LoadCampaignResult, type SaveCampaignResult } from '../src/utils/CampaignSaveManager';
import { decodeCampaignSave, encodeCampaignSave, MAX_CAMPAIGN_SAVE_BYTES,
  type CampaignSaveErrorCode, type CampaignSaveFailure, type DecodeCampaignSaveResult } from '../src/domain/campaignSave';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, type CampaignSession, type SessionCommand } from '../src/domain/campaignSession';
import { MAX_ORDER_ID } from '../src/domain/production';
import { MAX_FLEET_ID } from '../src/domain/campaignFleets';
import { createCombatDesign } from '../src/domain/combatPresets';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';

const KEY = 'orion_campaign_v1'; // Independent assertion of the public slot, not the implementation constant.
const sides = ['blue', 'red'] as const;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const documentFor = (session: unknown, schemaVersion = 1, rulesVersion = 1) =>
  JSON.stringify({ format: 'orion-campaign', schemaVersion, rulesVersion, session });

// Never resolve the host's real localStorage, including in tests of the default adapter.
function browserStorage(get: () => StoragePort): void {
  vi.stubGlobal('localStorage', undefined);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });
}
beforeEach(() => browserStorage(() => { throw new Error('Unexpected host storage access'); }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Synchronous port contract: throw BEFORE changing data, or replace one value atomically.
 * It deliberately exposes forbidden cleanup methods to detect remove/rollback strategies.
 */
class MemoryStorage implements StoragePort {
  readonly data = new Map<string, string>([
    ['orion_shipyard_v2', '{"schemaVersion":2,"designs":[],"components":[]}'],
    ['orion_shipyard_v1', '{"schemaVersion":1,"designs":[],"components":[]}'],
    ['orion_ship_configs', '[]'], ['orion_components', '[]'],
    ['orion_campaign_v0', 'old unrelated campaign'], ['other-app', 'untouched 🚀']
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
  readonly removeItem = vi.fn(() => { throw new Error('Forbidden deletion'); });
  readonly clear = vi.fn(() => { throw new Error('Forbidden cleanup'); });
}

function noWrites(store: MemoryStorage): void {
  expect(store.setItem).not.toHaveBeenCalled();
  expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
}
function encoded(state: unknown): string {
  const result = encodeCampaignSave(state);
  if (!result.ok) throw new Error(result.code);
  return result.json;
}
function loaded(manager: CampaignSaveManager): CampaignSession {
  const result = manager.load();
  if (!result.ok) throw new Error(result.code);
  expect(Object.keys(result).sort()).toEqual(['ok', 'state']);
  return result.state;
}
function failure(result: LoadCampaignResult | SaveCampaignResult,
  code: CampaignStorageErrorCode | CampaignSaveErrorCode): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error('Expected failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/);
  expect(result.message.length).toBeLessThan(250);
  expect(result.message).not.toMatch(/PRIVATE_STORAGE_DETAIL|SecurityError|QuotaExceededError|Error:|\bat .*\.ts:/);
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
const endCommand = (state: CampaignSession): SessionCommand => ({
  kind: 'endTurn', factionId: state.turn % 2 ? 'blue' : 'red', expectedTurn: state.turn
});
function advance(state: CampaignSession, command: SessionCommand = endCommand(state)) {
  const before = structuredClone(state), payload = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(state).toEqual(before); expect(command).toEqual(payload);
  if (!result.ok) throw new Error(`${command.kind}: ${result.code}`);
  return result;
}

// Small, explicitly diagnostic fixture; the paid-command cycle below is separate.
function diagnostic(turn = 1): CampaignSession {
  const state = createCampaignSession(), design = createCombatDesign('fighter');
  state.turn = turn;
  state.production.lastOrderId = 20; state.fleets.lastFleetId = 9;
  design.createdAt = '2024-02-29T12:34:56.123456Z';
  for (const [index, factionId] of sides.entries()) {
    const systemId = factionId === 'blue' ? 'sol' : 'vega';
    const destinationId = factionId === 'blue' ? 'eden' : 'nexus';
    const destination = state.galaxy.systems.find(system => system.id === destinationId)!;
    destination.ownerId = factionId; destination.exploredBy = [factionId];
    const shipIds = [2 + index * 2, 1 + index * 2];
    for (const id of shipIds) state.ships.push({ id, factionId, systemId, fuel: 0,
      design: structuredClone(design), transit: { destinationId, remainingTurns: 1 } });
    state.fleets.items.push({ id: index + 1, factionId, systemId, shipIds });
    for (let offset = 0; offset < 2; offset++) state.production.orders.push({
      id: 5 + index * 2 + offset, factionId, systemId, design: structuredClone(design), remainingTurns: offset ? 4 : 1
    });
    state.production.completed.unshift({ id: 9 + index, factionId, systemId, design: structuredClone(design) });
  }
  expect(campaignSessionSchema.safeParse(state).success).toBe(true);
  return state;
}

function sizedState(size: number): CampaignSession {
  const state = createCampaignSession(), design = createCombatDesign('fighter');
  design.createdAt = '2026-09-09T00:00:00.0Z';
  state.production.lastOrderId = 1;
  state.ships.push({ id: 1, factionId: 'blue', systemId: 'sol', fuel: 3, design });
  const extra = size - bytes(encoded(state));
  design.createdAt = `2026-09-09T00:00:00.${'0'.repeat(extra + 1)}Z`;
  expect(campaignSessionSchema.safeParse(state).success).toBe(true);
  expect(bytes(documentFor(state))).toBe(size);
  return state;
}

describe('CampaignSaveManager public contract and lazy storage', () => {
  it('exports precise synchronous result shapes and a separate exact slot key', () => {
    expect(CampaignSaveManager.STORAGE_KEY).toBe(KEY);
    expectTypeOf<CampaignStorageErrorCode>()
      .toEqualTypeOf<'SAVE_NOT_FOUND' | 'STORAGE_READ_FAILED' | 'STORAGE_WRITE_FAILED'>();
    expectTypeOf<CampaignStorageFailure>()
      .toEqualTypeOf<{ ok: false; code: CampaignStorageErrorCode; message: string }>();
    expectTypeOf<LoadCampaignResult>().toEqualTypeOf<DecodeCampaignSaveResult | CampaignStorageFailure>();
    expectTypeOf<SaveCampaignResult>().toEqualTypeOf<{ ok: true } | CampaignSaveFailure | CampaignStorageFailure>();
    expectTypeOf<ReturnType<CampaignSaveManager['load']>>().toEqualTypeOf<LoadCampaignResult>();
    expectTypeOf<ReturnType<CampaignSaveManager['save']>>().toEqualTypeOf<SaveCampaignResult>();
    expectTypeOf<Parameters<CampaignSaveManager['save']>>().toEqualTypeOf<[unknown]>();
    expectTypeOf<Extract<LoadCampaignResult, { ok: true }>>()
      .toEqualTypeOf<{ ok: true; state: CampaignSession }>();
    expectTypeOf<Extract<SaveCampaignResult, { ok: true }>>().toEqualTypeOf<{ ok: true }>();
  });

  it('constructs without resolving a throwing browser getter or touching an injected port', () => {
    const access = vi.fn((): StoragePort => { throw new Error('PRIVATE_STORAGE_DETAIL'); });
    browserStorage(access);
    const store = new MemoryStorage(), before = new Map(store.data);
    expect(() => new CampaignSaveManager()).not.toThrow();
    expect(() => new CampaignSaveManager(store)).not.toThrow();
    expect(access).not.toHaveBeenCalled(); expect(store.getItem).not.toHaveBeenCalled();
    noWrites(store); expect(store.data).toEqual(before);
  });

  it('resolves the default port afresh per explicit operation, never caches or auto-reads', () => {
    const first = new MemoryStorage(), second = new MemoryStorage();
    let current: StoragePort = first;
    const access = vi.fn(() => current); browserStorage(access);
    const manager = new CampaignSaveManager(), state = createCampaignSession();
    expect(access).not.toHaveBeenCalled();
    expect(manager.save(state)).toEqual({ ok: true });
    expect(access).toHaveBeenCalledTimes(1); expect(first.getItem).not.toHaveBeenCalled();
    expect(first.setItem.mock.calls).toEqual([[KEY, encoded(state)]]);
    current = second;
    failure(manager.load(), 'SAVE_NOT_FOUND');
    expect(access).toHaveBeenCalledTimes(2); expect(second.getItem.mock.calls).toEqual([[KEY]]);
    noWrites(second);
    current = first;
    expect(loaded(manager)).toEqual(state); expect(access).toHaveBeenCalledTimes(3);
    expect(first.getItem.mock.calls).toEqual([[KEY]]); expect(first.setItem).toHaveBeenCalledTimes(1);
  });

  it('uses the injected port exclusively even when the global getter throws', () => {
    const access = vi.fn((): StoragePort => { throw new Error('PRIVATE_STORAGE_DETAIL'); }); browserStorage(access);
    const store = new MemoryStorage(), manager = new CampaignSaveManager(store), state = createCampaignSession();
    expect(manager.save(state)).toEqual({ ok: true }); expect(loaded(manager)).toEqual(state);
    expect(access).not.toHaveBeenCalled();
    expect(store.getItem.mock.calls).toEqual([[KEY]]); expect(store.setItem.mock.calls).toEqual([[KEY, encoded(state)]]);
  });
});

describe('one read, real codec failures, no repair or fallback', () => {
  it.each([null, '', ' \n\t'])('distinguishes absent null from corrupt text %j', raw => {
    const store = new MemoryStorage(); if (raw !== null) store.data.set(KEY, raw);
    const before = new Map(store.data), manager = new CampaignSaveManager(store);
    const result = manager.load();
    failure(result, raw === null ? 'SAVE_NOT_FOUND' : 'INVALID_SAVE');
    if (raw === null) expect(result).toEqual({ ok: false, code: 'SAVE_NOT_FOUND', message: 'Сохранение кампании не найдено' });
    else expect(result).toEqual(decodeCampaignSave(raw));
    expect(store.getItem.mock.calls).toEqual([[KEY]]); noWrites(store); expect(store.data).toEqual(before);
  });

  const cases: [string, () => string, CampaignSaveErrorCode][] = [
    ['broken JSON', () => '{PRIVATE_STORAGE_DETAIL', 'INVALID_SAVE'],
    ['raw session', () => JSON.stringify(createCampaignSession()), 'INVALID_SAVE'],
    ['library document', () => '{"schemaVersion":2,"designs":[],"components":[]}', 'INVALID_SAVE'],
    ['missing session before future version', () => '{"format":"orion-campaign","schemaVersion":9,"rulesVersion":1}', 'INVALID_SAVE'],
    ['future schema before rules/state', () => documentFor(null, 2, 3), 'UNSUPPORTED_SAVE_VERSION'],
    ['future rules before state', () => documentFor(null, 1, 2), 'UNSUPPORTED_RULES_VERSION'],
    ['null state', () => documentFor(null), 'INVALID_STATE'],
    ['incomplete session', () => documentFor({ turn: 1 }), 'INVALID_STATE'],
    ['partial group transit', () => { const state = diagnostic(); delete state.ships[0].transit; return documentFor(state); }, 'INVALID_STATE'],
    ['oversized malformed ASCII', () => '{' + ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES), 'SAVE_TOO_LARGE'],
    ['oversized multibyte text', () => 'Я'.repeat(2_500_000) + '!', 'SAVE_TOO_LARGE'],
    ['oversized future version', () => {
      const text = documentFor(null, 9); return text + ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES + 1 - bytes(text));
    }, 'SAVE_TOO_LARGE']
  ];
  it.each(cases)('forwards %s unchanged and preserves every stored byte', (_name, makeRaw, code) => {
    const raw = makeRaw(), expected = decodeCampaignSave(raw), store = new MemoryStorage();
    store.data.set(KEY, raw); const before = new Map(store.data);
    const parse = vi.spyOn(JSON, 'parse');
    const result = new CampaignSaveManager(store).load();
    if (code === 'SAVE_TOO_LARGE') expect(parse).not.toHaveBeenCalled();
    else expect(parse).toHaveBeenCalledTimes(1);
    failure(result, code); expect(result).toEqual(expected);
    expect(store.getItem.mock.calls).toEqual([[KEY]]); noWrites(store); expect(store.data).toEqual(before);
  });

  it('loads an exact UTF-8 cap document once without compacting or rewriting the slot', () => {
    const state = diagnostic(), text = documentFor(state);
    const raw = text + ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES - bytes(text));
    expect(raw.length).toBeLessThan(MAX_CAMPAIGN_SAVE_BYTES); expect(bytes(raw)).toBe(MAX_CAMPAIGN_SAVE_BYTES);
    const store = new MemoryStorage(); store.data.set(KEY, raw); const before = new Map(store.data);
    const parse = vi.spyOn(JSON, 'parse');
    expect(loaded(new CampaignSaveManager(store))).toEqual(state);
    expect(parse).toHaveBeenCalledTimes(1); expect(parse).toHaveBeenCalledWith(raw);
    expect(store.getItem.mock.calls).toEqual([[KEY]]); noWrites(store); expect(store.data).toEqual(before);
  });
});

const exceptions = [
  ['SecurityError', () => new DOMException('PRIVATE_STORAGE_DETAIL', 'SecurityError')],
  ['QuotaExceededError', () => new DOMException('PRIVATE_STORAGE_DETAIL', 'QuotaExceededError')],
  ['generic error', () => new Error('PRIVATE_STORAGE_DETAIL')],
  ['thrown string', () => 'PRIVATE_STORAGE_DETAIL']
] as const;
describe.each(exceptions)('storage exceptions: %s', (_name, makeError) => {
  it.each(['load', 'save'] as const)('%s contains a throwing localStorage getter with fixed text', operation => {
    const state = diagnostic(), before = structuredClone(state);
    const access = vi.fn((): StoragePort => { throw makeError(); }); browserStorage(access);
    const manager = new CampaignSaveManager(); expect(access).not.toHaveBeenCalled();
    const result = operation === 'load' ? manager.load() : manager.save(state);
    const code = operation === 'load' ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED';
    failure(result, code);
    expect(result).toEqual({ ok: false, code, message: operation === 'load'
      ? 'Не удалось прочитать сохранение кампании'
      : 'Не удалось записать кампанию: хранилище недоступно или заполнено' });
    expect(access).toHaveBeenCalledTimes(1); expect(state).toEqual(before);
  });

  it.each(['valid', 'corrupt'] as const)('read failure preserves a %s slot and never falls back', old => {
    const store = new MemoryStorage(); store.data.set(KEY, old === 'valid' ? encoded(diagnostic()) : '{corrupt');
    store.readFailure = { value: makeError() }; const before = new Map(store.data);
    const result = new CampaignSaveManager(store).load();
    failure(result, 'STORAGE_READ_FAILED');
    expect(result).toEqual({ ok: false, code: 'STORAGE_READ_FAILED', message: 'Не удалось прочитать сохранение кампании' });
    expect(store.getItem.mock.calls).toEqual([[KEY]]); noWrites(store); expect(store.data).toEqual(before);
  });

  it.each(['absent', 'valid', 'corrupt'] as const)('one failed set preserves a %s slot without reads, rollback or deletion', old => {
    const store = new MemoryStorage(), state = diagnostic(2), beforeState = structuredClone(state);
    if (old !== 'absent') store.data.set(KEY, old === 'valid' ? encoded(createCampaignSession()) : '{corrupt');
    const before = new Map(store.data), json = encoded(state); freeze(state);
    store.writeFailure = { value: makeError() };
    const result = new CampaignSaveManager(store).save(state);
    failure(result, 'STORAGE_WRITE_FAILED');
    expect(result).toEqual({ ok: false, code: 'STORAGE_WRITE_FAILED',
      message: 'Не удалось записать кампанию: хранилище недоступно или заполнено' });
    expect(store.getItem).not.toHaveBeenCalled(); expect(store.setItem.mock.calls).toEqual([[KEY, json]]);
    expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
    expect(store.data).toEqual(before); expect(state).toEqual(beforeState);
  });
});

describe('encode before any storage access; explicit single atomic overwrite', () => {
  const invalidInputs: [string, () => unknown, CampaignSaveErrorCode][] = [
    ['undefined', () => undefined, 'INVALID_STATE'], ['null', () => null, 'INVALID_STATE'],
    ['empty object', () => ({}), 'INVALID_STATE'],
    ['nonfinite treasury', () => { const state = createCampaignSession(); state.treasuries.blue.credits = Infinity; return state; }, 'INVALID_STATE'],
    ['cross-state corruption', () => { const state = diagnostic(); state.fleets.items[0].shipIds[0] = 19; return state; }, 'INVALID_STATE'],
    ['runtime-valid oversized snapshot', () => sizedState(MAX_CAMPAIGN_SAVE_BYTES + 1), 'SAVE_TOO_LARGE']
  ];
  it.each(invalidInputs)('%s forwards encode failure before even the browser getter', (_name, makeState, code) => {
    const state = makeState(), before = structuredClone(state), expected = encodeCampaignSave(state); freeze(state);
    const access = vi.fn((): StoragePort => { throw new DOMException('PRIVATE_STORAGE_DETAIL', 'SecurityError'); });
    browserStorage(access);
    const result = new CampaignSaveManager().save(state);
    failure(result, code); expect(result).toEqual(expected);
    expect(access).not.toHaveBeenCalled(); expect(state).toEqual(before);
  });

  it.each(['valid', 'corrupt'] as const)('invalid and oversized input preserve a %s slot and all library keys', old => {
    const store = new MemoryStorage(); store.data.set(KEY, old === 'valid' ? encoded(diagnostic()) : '{corrupt');
    const before = new Map(store.data), manager = new CampaignSaveManager(store);
    // The port also rejects access: encode errors must win over both storage error kinds.
    store.readFailure = { value: new Error('PRIVATE_STORAGE_DETAIL') };
    store.writeFailure = { value: new DOMException('PRIVATE_STORAGE_DETAIL', 'QuotaExceededError') };
    for (const input of [null, sizedState(MAX_CAMPAIGN_SAVE_BYTES + 1)]) {
      const snapshot = structuredClone(input), expected = encodeCampaignSave(input); freeze(input);
      const result = manager.save(input);
      failure(result, input === null ? 'INVALID_STATE' : 'SAVE_TOO_LARGE'); expect(result).toEqual(expected);
      expect(input).toEqual(snapshot);
    }
    expect(store.getItem).not.toHaveBeenCalled(); noWrites(store); expect(store.data).toEqual(before);
  });

  it.each(['absent', 'valid', 'corrupt'] as const)('explicit caller save replaces a %s slot with exactly one complete document', old => {
    const store = new MemoryStorage(), state = diagnostic(), beforeState = structuredClone(state);
    if (old !== 'absent') store.data.set(KEY, old === 'valid' ? encoded(createCampaignSession()) : '{corrupt');
    const before = new Map(store.data), json = encoded(state), manager = new CampaignSaveManager(store); freeze(state);
    // Reading for overwrite confirmation belongs to the future caller/UI, not save().
    store.readFailure = { value: new Error('Unexpected read') };
    expect(store.data).toEqual(before); expect(store.getItem).not.toHaveBeenCalled(); noWrites(store);
    expect(manager.save(state)).toEqual({ ok: true });
    expect(store.setItem.mock.calls).toEqual([[KEY, json]]); expect(store.getItem).not.toHaveBeenCalled();
    expect(decodeCampaignSave(store.data.get(KEY))).toEqual({ ok: true, state: beforeState });
    expect(store.data).toEqual(new Map(before).set(KEY, json)); expect(state).toEqual(beforeState);
    expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
  });

  it('accepts exactly 5MB as one complete write, without promising browser quota', () => {
    const state = sizedState(MAX_CAMPAIGN_SAVE_BYTES), before = structuredClone(state), store = new MemoryStorage();
    freeze(state); expect(new CampaignSaveManager(store).save(state)).toEqual({ ok: true });
    expect(store.setItem).toHaveBeenCalledTimes(1); expect(store.setItem.mock.calls[0][0]).toBe(KEY);
    expect(bytes(store.setItem.mock.calls[0][1])).toBe(MAX_CAMPAIGN_SAVE_BYTES);
    expect(store.getItem).not.toHaveBeenCalled();
    expect(loaded(new CampaignSaveManager(store))).toEqual(before); expect(state).toEqual(before);
    expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
  });
});

describe('fresh, deeply detached loads without implicit game commands or cached state', () => {
  it.each([1, 2])('preserves both sides, counters, ordered snapshots and zero-fuel transit at parity %s', turn => {
    const state = diagnostic(turn), before = structuredClone(state), store = new MemoryStorage(); freeze(state);
    const writer = new CampaignSaveManager(store);
    expect(writer.save(state)).toEqual({ ok: true }); const stored = new Map(store.data);
    const first = loaded(writer), second = loaded(new CampaignSaveManager(store));
    expect(first).toEqual(before); expect(second).toEqual(before); expect(state).toEqual(before);
    expect(first).not.toBe(state); expect(second).not.toBe(first);
    first.ships[0].design.slots.find(slot => slot.component)!.component!.name = 'Changed component';
    first.ships[0].transit!.destinationId = 'vega'; first.ships[0].fuel = 3;
    first.production.orders[0].design.slots[0].component = null;
    first.production.completed[0].design.name = 'Changed completed';
    first.fleets.items[0].shipIds.reverse(); first.galaxy.systems[0].exploredBy.push('red');
    first.treasuries.red.credits = 0;
    expect(first.ships[1]).toEqual(before.ships[1]);
    expect(first.production.orders[1]).toEqual(before.production.orders[1]);
    expect(second).toEqual(before); expect(state).toEqual(before);
    expect(loaded(new CampaignSaveManager(store))).toEqual(before);
    expect(store.getItem.mock.calls).toEqual([[KEY], [KEY], [KEY]]);
    expect(store.setItem).toHaveBeenCalledTimes(1); expect(store.data).toEqual(stored);
  });

  it('does not retain the caller state after saving, including aliased designs and routes', () => {
    const state = diagnostic(), store = new MemoryStorage();
    state.ships[1].design = state.ships[0].design; state.ships[1].transit = state.ships[0].transit;
    const before = structuredClone(state), manager = new CampaignSaveManager(store);
    expect(manager.save(state)).toEqual({ ok: true }); const json = store.data.get(KEY);
    state.ships[0].design.name = 'Changed caller'; state.fleets.items[0].shipIds.pop();
    const candidate = loaded(new CampaignSaveManager(store));
    expect(candidate).toEqual(before); expect(candidate.ships[0].design).not.toBe(candidate.ships[1].design);
    expect(candidate.ships[0].transit).not.toBe(candidate.ships[1].transit);
    expect(loaded(manager)).toEqual(before); expect(store.data.get(KEY)).toBe(json);
    expect(store.setItem).toHaveBeenCalledTimes(1);
  });

  it('two managers obey last-successful-write-wins, reread errors and recover without caching', () => {
    const store = new MemoryStorage(), first = new CampaignSaveManager(store), second = new CampaignSaveManager(store);
    const a = diagnostic(1), b = diagnostic(2), c = createCampaignSession();
    expect(first.save(a)).toEqual({ ok: true }); const oldCandidate = loaded(second);
    expect(second.save(b)).toEqual({ ok: true }); expect(loaded(first)).toEqual(b); expect(oldCandidate).toEqual(a);
    const beforeFailure = new Map(store.data);
    store.writeFailure = { value: new DOMException('PRIVATE_STORAGE_DETAIL', 'QuotaExceededError') };
    failure(first.save(c), 'STORAGE_WRITE_FAILED'); expect(store.data).toEqual(beforeFailure);
    expect(loaded(first)).toEqual(b); expect(loaded(second)).toEqual(b);
    store.writeFailure = undefined;
    expect(first.save(c)).toEqual({ ok: true }); expect(loaded(second)).toEqual(c);
    store.data.set(KEY, '{external corruption'); failure(first.load(), 'INVALID_SAVE');
    store.data.delete(KEY); failure(second.load(), 'SAVE_NOT_FOUND');
    store.readFailure = { value: 'PRIVATE_STORAGE_DETAIL' }; failure(first.load(), 'STORAGE_READ_FAILED');
    store.readFailure = undefined; store.data.set(KEY, encoded(a)); expect(loaded(first)).toEqual(a);
    expect(store.getItem.mock.calls).toEqual(Array.from({ length: 9 }, () => [KEY]));
    expect(store.setItem.mock.calls).toEqual([[KEY, encoded(a)], [KEY, encoded(b)], [KEY, encoded(c)], [KEY, encoded(c)]]);
    expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
  });

  it.each(['terminal', 'credits-cap', 'minerals-cap', 'deficit'] as const)('restores valid %s without curing or advancing it', kind => {
    const state = diagnostic(kind === 'terminal' ? MAX_TURN : 1), store = new MemoryStorage();
    state.production.lastOrderId = MAX_ORDER_ID; state.fleets.lastFleetId = MAX_FLEET_ID;
    if (kind === 'credits-cap') state.treasuries.blue.credits = MAX_RESOURCE;
    if (kind === 'minerals-cap') state.treasuries.blue.minerals = MAX_RESOURCE;
    if (kind === 'deficit') {
      state.treasuries.blue.credits = 0;
      for (let id = 30; id < 51; id++) state.ships.push({ id, factionId: 'blue', systemId: 'sol', fuel: 0,
        design: structuredClone(state.ships[0].design) });
    }
    const before = structuredClone(state); freeze(state);
    expect(new CampaignSaveManager(store).save(state)).toEqual({ ok: true }); const stored = new Map(store.data);
    const restored = loaded(new CampaignSaveManager(store)); expect(restored).toEqual(before);
    const side = state.turn % 2 ? 'blue' : 'red';
    const forecast = getCampaignSessionView(restored, side).economyForecast;
    expect(forecast).toEqual(getCampaignSessionView(state, side).economyForecast);
    const result = executeSessionCommand(restored, endCommand(restored));
    expect(result).toEqual(executeSessionCommand(state, endCommand(state)));
    if (kind !== 'deficit') {
      const code = kind === 'terminal' ? 'TURN_LIMIT' : 'RESOURCE_LIMIT';
      expect(forecast).toEqual({ ok: false, code }); expect(result).toMatchObject({ ok: false, code });
    } else {
      expect(result).toMatchObject({ ok: true, endTurnEconomy: {
        upkeep: { shipCount: 23, dueCredits: 23, paidCredits: 20, shortfallCredits: 3 }
      } });
      if (!result.ok) throw new Error(result.code);
      expect(result.state.production.orders.map(order => [order.id, order.remainingTurns])).toEqual([[6, 4], [7, 1], [8, 4]]);
      expect(result.state.ships.filter(ship => ship.factionId === 'blue' && ship.transit)).toEqual([]);
      expect(result.state.ships.filter(ship => ship.factionId === 'red' && ship.transit)).toHaveLength(2);
      expect(result.state.fleets.items[0].systemId).toBe('eden');
      expect(result.state.ships).toHaveLength(25);
    }
    expect(restored).toEqual(before); expect(state).toEqual(before); expect(store.data).toEqual(stored);
    expect(store.getItem.mock.calls).toEqual([[KEY]]); expect(store.setItem).toHaveBeenCalledTimes(1);
    expect(store.data.get(KEY)).not.toMatch(/economyForecast|endTurnEconomy|paidCredits|shortfallCredits/);
  });
});

describe('real paid production and group travel through the slot (not diagnostic state)', () => {
  it.each(['preset', 'library'] as const)('%s: resumes FIFO and both own group arrivals identically to uninterrupted play', source => {
    const store = new MemoryStorage(), library = new ShipDesignManager(store);
    const design = source === 'library' ? library.saveDesign(createCombatDesign('fighter')) : createCombatDesign('fighter');
    const snapshot = structuredClone(design); freeze(design);
    const initialStorage = new Map(store.data);
    store.getItem.mockClear(); store.setItem.mockClear();
    let state = createCampaignSession();
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'eden' : 'nexus';
      for (const kind of ['explore', 'colonize'] as const) state = advance(state, { kind, factionId, systemId, expectedTurn: state.turn }).state;
      state = advance(state).state;
    }
    while (state.turn < 29) state = advance(state).state;
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega';
      for (let index = 0; index < 2; index++) state = advance(state, {
        kind: 'enqueueProduction', factionId, systemId, design, expectedTurn: state.turn
      }).state;
      expect(state.treasuries[factionId]).toEqual({ credits: 10, minerals: 168 });
      state = advance(state).state;
    }
    expect(state.turn).toBe(31);
    expect(state.production.orders.map(order => [order.id, order.remainingTurns])).toEqual([[1, 3], [2, 4], [3, 3], [4, 4]]);
    expect(store.data).toEqual(initialStorage); expect(store.getItem).not.toHaveBeenCalled(); noWrites(store);

    let restored = state;
    let checkpoints = 0;
    function checkpoint(): void {
      const input = restored, before = structuredClone(input);
      const reads = store.getItem.mock.calls.length, writes = store.setItem.mock.calls.length;
      expect(new CampaignSaveManager(store).save(restored)).toEqual({ ok: true });
      expect(store.getItem).toHaveBeenCalledTimes(reads); expect(store.setItem).toHaveBeenCalledTimes(writes + 1);
      restored = loaded(new CampaignSaveManager(store)); checkpoints++;
      expect(store.getItem).toHaveBeenCalledTimes(reads + 1);
      expect(input).toEqual(before); expect(restored).toEqual(before); expect(restored).not.toBe(input);
    }
    function both(command: SessionCommand = endCommand(state)): void {
      const stored = new Map(store.data), uninterrupted = advance(state, command), resumed = advance(restored, command);
      expect(resumed).toEqual(uninterrupted); // Full state and actual payment receipt, not just turn.
      state = uninterrupted.state; restored = resumed.state;
      expect([...restored.production.orders, ...restored.production.completed, ...restored.ships].map(record => record.design))
        .toEqual(Array(4).fill(snapshot));
      expect(store.data).toEqual(stored); expect(design).toEqual(snapshot);
    }
    checkpoint(); // A partially paid/progressed FIFO is preserved, not restarted.
    while (state.turn < 45) both();
    expect(restored.production.completed.map(order => order.id)).toEqual([1, 3, 2, 4]);
    expect(restored.treasuries).toEqual({ blue: { credits: 170, minerals: 248 }, red: { credits: 170, minerals: 248 } });
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega', destinationId = factionId === 'blue' ? 'eden' : 'nexus';
      const shipIds = factionId === 'blue' ? [2, 1] : [4, 3], fleetId = factionId === 'blue' ? 1 : 2;
      for (const orderId of shipIds) both({ kind: 'deployProduction', factionId, systemId, orderId, expectedTurn: state.turn });
      both({ kind: 'createFleet', factionId, systemId, shipIds, expectedTurn: state.turn });
      const send: SessionCommand = { kind: 'sendFleet', factionId, systemId, destinationId, fleetId, expectedTurn: state.turn };
      both(send); checkpoint();
      expect(restored.ships.filter(ship => ship.factionId === factionId).map(ship => [ship.fuel, ship.systemId, ship.transit]))
        .toEqual(shipIds.map(() => [2, systemId, { destinationId, remainingTurns: 1 }]));
      expect(executeSessionCommand(restored, send)).toEqual(executeSessionCommand(state, send));
      expect(executeSessionCommand(restored, send)).toMatchObject({ ok: false, code: 'FLEET_IN_TRANSIT' });
      const ending = endCommand(state), result = advance(restored, ending);
      expect(result.endTurnEconomy?.upkeep).toEqual({ shipCount: 2, dueCredits: 2, paidCredits: 2, shortfallCredits: 0 });
      both(ending);
      expect(executeSessionCommand(restored, ending)).toMatchObject({ ok: false, code: 'STALE_TURN' });
    }
    expect(restored).toEqual(state); expect(restored.turn).toBe(47);
    expect(restored.production).toEqual({ lastOrderId: 4, orders: [], completed: [] });
    expect(restored.ships.map(ship => [ship.id, ship.systemId, ship.fuel, ship.transit]))
      .toEqual([[2, 'eden', 2, undefined], [1, 'eden', 2, undefined], [4, 'nexus', 2, undefined], [3, 'nexus', 2, undefined]]);
    expect(restored.fleets).toEqual({ lastFleetId: 2, items: [
      { id: 1, factionId: 'blue', systemId: 'eden', shipIds: [2, 1] },
      { id: 2, factionId: 'red', systemId: 'nexus', shipIds: [4, 3] }
    ] });
    expect(restored.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(store.getItem.mock.calls).toEqual(Array.from({ length: checkpoints }, () => [KEY]));
    expect(store.setItem).toHaveBeenCalledTimes(checkpoints); expect(checkpoints).toBe(3);
    expect(new Map([...store.data].filter(([key]) => key !== KEY))).toEqual(initialStorage);
    expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
  });
});