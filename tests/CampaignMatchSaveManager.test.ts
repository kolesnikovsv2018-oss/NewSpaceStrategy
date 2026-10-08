import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CampaignMatchSaveManager, type CampaignStorageErrorCode, type CampaignStorageFailure,
  type LoadCampaignMatchResult, type SaveCampaignMatchResult } from '../src/utils/CampaignMatchSaveManager';
import { CampaignRunSaveManager } from '../src/utils/CampaignRunSaveManager';
import { CampaignSaveManager } from '../src/utils/CampaignSaveManager';
import { campaignMatchSchema, createCampaignMatch, getCampaignOutcome, executeMatchAiTurn, executeMatchCommand,
  type CampaignMatch, type CampaignScenario } from '../src/domain/campaignMatch';
import * as codec from '../src/domain/campaignMatchSave';
import { encodeCampaignSave, MAX_CAMPAIGN_SAVE_BYTES } from '../src/domain/campaignSave';
import { encodeCampaignRunSave } from '../src/domain/campaignRunSave';
import * as sessions from '../src/domain/campaignSession';
import * as executor from '../src/domain/campaignAiExecutor';
import * as planner from '../src/domain/campaignAiPlanner';
import { createCombatDesign } from '../src/domain/combatPresets';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { loadProductionCatalog } from '../src/utils/ProductionCatalog';
import { freeze, requestFor, rich } from './fixtures/campaignAi';

beforeEach(() => globalStorage(() => { throw Error('PRIVATE unexpected host storage'); }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const KEY = 'orion_campaign_v1';
const local = { mode: 'local' } as const;
const computer = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } as const;
const scenarios: CampaignScenario[] = ['sandbox', 'joint-survey-v1'];
const completed = { status: 'completed', reason: 'joint-survey-complete' };
function globalStorage(get: () => unknown): void {
  vi.stubGlobal('localStorage', undefined);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });
}
class MemoryStorage implements StoragePort {
  readonly data = new Map<string, string>([
    ['orion_shipyard_v2', '{unrelated'], ['orion_shipyard_v1', '{legacy'], ['orion_ship_configs', '[]'],
    ['orion_components', '[]'], ['orion_campaign_v0', 'not a fallback'], ['another-app', 'Сохранить']
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
  readonly removeItem = vi.fn(() => { throw Error('Forbidden remove'); });
  readonly clear = vi.fn(() => { throw Error('Forbidden clear'); });
}
function created(scenario: CampaignScenario = 'sandbox'): CampaignMatch {
  const result = createCampaignMatch(local, scenario); if (!result.ok) throw Error(result.message);
  return result.match;
}
function encoded(match: unknown): string {
  const result = codec.encodeCampaignMatchSave(match); if (!result.ok) throw Error(result.message); return result.json;
}
function oldEncoded(match: CampaignMatch, version: number): string {
  const result = version === 1 ? encodeCampaignSave(match.run.session) : encodeCampaignRunSave(match.run);
  if (!result.ok) throw Error(result.message); return result.json;
}
function loaded(store: StoragePort): CampaignMatch {
  const result = new CampaignMatchSaveManager(store).load(); if (!result.ok) throw Error(result.message);
  expect(Object.keys(result).sort()).toEqual(['match', 'ok']); return result.match;
}
function reject(result: LoadCampaignMatchResult | SaveCampaignMatchResult, code: CampaignStorageErrorCode | codec.CampaignMatchSaveErrorCode): void {
  expect(result).toMatchObject({ ok: false, code }); if (result.ok) throw Error('Expected failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/); expect(result.message.length).toBeLessThan(250);
  expect(result.message).not.toMatch(/PRIVATE|Error:|SecurityError|QuotaExceededError|issues|treasuries|exploredBy/);
}
function noWrites(store: MemoryStorage): void {
  expect(store.setItem).not.toHaveBeenCalled(); expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
}
function surveyed(match: CampaignMatch): void {
  match.run.session.galaxy.systems.forEach(system => { system.exploredBy = ['blue', 'red']; });
}
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
function sizedMatch(size: number, version = 3): CampaignMatch {
  const match = created(), design = createCombatDesign('fighter'); design.createdAt = '2026-10-08T00:00:00.0Z';
  match.run.session.production.lastOrderId = 1;
  match.run.session.ships.push({ id: 1, factionId: 'blue', systemId: 'sol', fuel: 0, design });
  const initial = bytes(version === 3 ? encoded(match) : oldEncoded(match, version));
  design.createdAt = '2026-10-08T00:00:00.' + '0'.repeat(size - initial + 1) + 'Z';
  expect(campaignMatchSchema.safeParse(match).success).toBe(true); return match;
}

describe('match repository boundary', () => {
  it('validates before resolving global storage and performs no IO on construction', () => {
    vi.stubGlobal('localStorage', undefined);
    const access = vi.fn(() => { throw Error('PRIVATE'); });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: access });
    const manager = new CampaignMatchSaveManager(); expect(access).not.toHaveBeenCalled();
    expect(manager.save(null)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(access).not.toHaveBeenCalled();
  });
  it('writes completed3 once and restores through a new instance without advancing the match', () => {
    const result = createCampaignMatch({ mode: 'local' }, 'joint-survey-v1'); if (!result.ok) throw Error(result.message);
    result.match.run.session.galaxy.systems.forEach(system => { system.exploredBy = ['blue', 'red']; });
    const data = new Map<string, string>();
    const port = { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
    expect(new CampaignMatchSaveManager(port).save(result.match)).toEqual({ ok: true });
    expect(port.getItem).not.toHaveBeenCalled(); expect(port.setItem).toHaveBeenCalledTimes(1);
    const loaded = new CampaignMatchSaveManager(port).load(); if (!loaded.ok) throw Error(loaded.message);
    expect(port.getItem).toHaveBeenCalledTimes(1); expect(loaded.match).toEqual(result.match);
    expect(getCampaignOutcome(loaded.match)).toEqual({ ok: true, outcome: { status: 'completed', reason: 'joint-survey-complete' } });
    expect(JSON.parse(data.get(CampaignMatchSaveManager.STORAGE_KEY)!).schemaVersion).toBe(3);
    expect(port.setItem).toHaveBeenCalledTimes(1);
  });
});

describe('shared key, lazy port and operation order', () => {
  it('import and construction do not access storage, clock, RNG or schedule work', async () => {
    const access = vi.fn(() => { throw Error('PRIVATE'); }); globalStorage(access);
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    const timeout = vi.spyOn(globalThis, 'setTimeout'), interval = vi.spyOn(globalThis, 'setInterval');
    vi.resetModules(); const module = await import('../src/utils/CampaignMatchSaveManager');
    new module.CampaignMatchSaveManager();
    for (const spy of [access, now, random, timeout, interval]) expect(spy).not.toHaveBeenCalled();
  });
  it('exposes match results with scenario error and the same single slot', () => {
    expect(CampaignMatchSaveManager.STORAGE_KEY).toBe(KEY);
    expect(CampaignMatchSaveManager.STORAGE_KEY).toBe(CampaignSaveManager.STORAGE_KEY);
    expect(CampaignMatchSaveManager.STORAGE_KEY).toBe(CampaignRunSaveManager.STORAGE_KEY);
    expectTypeOf<LoadCampaignMatchResult>().toEqualTypeOf<codec.DecodeCampaignMatchSaveResult | CampaignStorageFailure>();
    expectTypeOf<SaveCampaignMatchResult>().toEqualTypeOf<{ ok: true } | codec.CampaignMatchSaveFailure | CampaignStorageFailure>();
    expectTypeOf<Parameters<CampaignMatchSaveManager['save']>>().toEqualTypeOf<[unknown]>();
    expectTypeOf<Extract<LoadCampaignMatchResult, { ok: true }>>().toEqualTypeOf<{ ok: true; match: CampaignMatch }>();
  });
  it('constructs without port/codec/clock/RNG calls and uses only an injected port', () => {
    const store = new MemoryStorage(), access = vi.fn(() => { throw Error('PRIVATE'); }); globalStorage(access);
    const encode = vi.spyOn(codec, 'encodeCampaignMatchSave'), decode = vi.spyOn(codec, 'decodeCampaignMatchSave');
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    new CampaignMatchSaveManager(); const manager = new CampaignMatchSaveManager(store);
    for (const spy of [encode, decode, now, random, access, store.getItem]) expect(spy).not.toHaveBeenCalled(); noWrites(store);
    const match = created(); expect(manager.save(match)).toEqual({ ok: true }); expect(manager.load()).toEqual({ ok: true, match });
    expect(encode.mock.calls).toEqual([[match]]); expect(decode.mock.calls).toEqual([[store.data.get(KEY)]]);
    expect(access).not.toHaveBeenCalled(); expect(store.getItem.mock.calls).toEqual([[KEY]]);
    expect(store.setItem.mock.calls).toEqual([[KEY, encoded(match)]]);
  });
  it('resolves default storage afresh on each operation and never caches prior values', () => {
    const first = new MemoryStorage(), second = new MemoryStorage(), match = created(); let current = first;
    const access = vi.fn(() => current); globalStorage(access); const manager = new CampaignMatchSaveManager();
    expect(access).not.toHaveBeenCalled(); expect(manager.save(match)).toEqual({ ok: true });
    current = second; reject(manager.load(), 'SAVE_NOT_FOUND'); current = first;
    expect(manager.load()).toEqual({ ok: true, match }); expect(access).toHaveBeenCalledTimes(3);
    expect(first.getItem).toHaveBeenCalledTimes(1); expect(first.setItem).toHaveBeenCalledTimes(1); noWrites(second);
  });
  it('encodes once before getter/set-method access and decodes once after a single read', () => {
    const match = created(), json = encoded(match), events: string[] = [];
    const encode = codec.encodeCampaignMatchSave, decode = codec.decodeCampaignMatchSave;
    vi.spyOn(codec, 'encodeCampaignMatchSave').mockImplementation(input => { events.push('encode'); return encode(input); });
    vi.spyOn(codec, 'decodeCampaignMatchSave').mockImplementation(input => { events.push('decode'); return decode(input); });
    const port: StoragePort = {
      get setItem() { events.push('set-method'); return (_key: string, value: string) => { events.push('set'); expect(value).toBe(json); }; },
      get getItem() { events.push('get-method'); return (_key: string) => { events.push('get'); return json; }; }
    };
    globalStorage(() => { events.push('storage'); return port; }); const manager = new CampaignMatchSaveManager();
    expect(manager.save(match)).toEqual({ ok: true }); expect(events).toEqual(['encode', 'storage', 'set-method', 'set']);
    events.length = 0; expect(manager.load()).toEqual({ ok: true, match });
    expect(events).toEqual(['storage', 'get-method', 'get', 'decode']);
  });
});

describe('codec failures stay read-only and are not storage failures', () => {
  const cases: [string, () => unknown, CampaignStorageErrorCode | codec.CampaignMatchSaveErrorCode][] = [
    ['only null is missing', () => null, 'SAVE_NOT_FOUND'],
    ['undefined port return', () => undefined, 'INVALID_SAVE'], ['object port return', () => ({}), 'INVALID_SAVE'],
    ['empty', () => '', 'INVALID_SAVE'], ['malformed', () => '{PRIVATE', 'INVALID_SAVE'],
    ['bare match', () => JSON.stringify(created()), 'INVALID_SAVE'],
    ['library', () => '{"schemaVersion":2,"designs":[],"components":[]}', 'INVALID_SAVE'],
    ['future format', () => JSON.stringify({ ...JSON.parse(encoded(created())), schemaVersion: 9, rulesVersion: 9, session: null }), 'UNSUPPORTED_SAVE_VERSION'],
    ['future rules', () => JSON.stringify({ ...JSON.parse(encoded(created())), rulesVersion: 9, scenario: 'future', session: null }), 'UNSUPPORTED_RULES_VERSION'],
    ['future policy first', () => JSON.stringify({ ...JSON.parse(encoded(created())), control: { ...computer, aiPolicy: 'future' }, scenario: 'future', session: null }), 'UNSUPPORTED_AI_POLICY'],
    ['future scenario', () => JSON.stringify({ ...JSON.parse(encoded(created())), scenario: 'future', session: null }), 'UNSUPPORTED_SCENARIO'],
    ['malformed scenario', () => JSON.stringify({ ...JSON.parse(encoded(created())), scenario: 'sandbox\n', session: null }), 'INVALID_SAVE'],
    ['missing scenario', () => { const value = JSON.parse(encoded(created())); delete value.scenario; return JSON.stringify(value); }, 'INVALID_SAVE'],
    ['outcome extra', () => JSON.stringify({ ...JSON.parse(encoded(created())), outcome: completed }), 'INVALID_SAVE'],
    ['bad session', () => JSON.stringify({ ...JSON.parse(encoded(created())), session: null }), 'INVALID_STATE'],
    ['oversized Unicode', () => 'я'.repeat(MAX_CAMPAIGN_SAVE_BYTES / 2) + ' ', 'SAVE_TOO_LARGE']
  ];
  it.each(cases)('%s produces safe code and exactly one read', (_name, make, code) => {
    const raw = make(), store = new MemoryStorage(), before = Array.from(store.data);
    store.getItem.mockImplementation(() => raw as string | null);
    const decode = vi.spyOn(codec, 'decodeCampaignMatchSave');
    reject(new CampaignMatchSaveManager(store).load(), code); expect(store.getItem.mock.calls).toEqual([[KEY]]);
    expect(decode.mock.calls).toEqual(raw === null ? [] : [[raw]]); noWrites(store); expect(Array.from(store.data)).toEqual(before);
  });
  const corruptions: [string, (match: CampaignMatch) => void][] = [
    ['missing scenario', match => { Reflect.deleteProperty(match, 'scenario'); }],
    ['hidden fuel', match => { Reflect.deleteProperty(match.run.session.ships[3], 'fuel'); }],
    ['hidden group route', match => { delete match.run.session.ships[3].transit; }],
    ['hidden FIFO', match => { match.run.session.production.orders[5].remainingTurns = 2; }],
    ['hidden membership', match => { match.run.session.fleets.items[1].shipIds[0] = 999; }],
    ['hidden design', match => { match.run.session.ships[3].design.slots.forEach(slot => { slot.component = null; }); }],
    ['hidden counter', match => { match.run.session.production.lastOrderId = 1; }]
  ];
  it.each(corruptions)('%s fails full validation before even the default getter', (_name, corrupt) => {
    const match: CampaignMatch = { run: { session: rich(2, 3), control: computer }, scenario: 'joint-survey-v1' };
    surveyed(match); corrupt(match); const before = structuredClone(match); freeze(match);
    const access = vi.fn(() => { throw Error('PRIVATE'); }); globalStorage(access);
    reject(new CampaignMatchSaveManager().save(match), 'INVALID_STATE'); expect(access).not.toHaveBeenCalled(); expect(match).toEqual(before);
  });
  it('contains real nested refinement failures before write and after a single read', () => {
    const match = created(), store = new MemoryStorage(); store.data.set(KEY, encoded(match));
    const effect = sessions.campaignSessionSchema._def.effect; if (effect.type !== 'refinement') throw Error('Expected refinement');
    vi.spyOn(effect, 'refinement').mockImplementation(() => { throw Error('PRIVATE'); });
    const access = vi.fn(() => store); globalStorage(access);
    reject(new CampaignMatchSaveManager().save(match), 'INVALID_STATE'); expect(access).not.toHaveBeenCalled();
    reject(new CampaignMatchSaveManager(store).load(), 'INVALID_STATE'); expect(store.getItem).toHaveBeenCalledTimes(1); noWrites(store);
  });
});

describe('storage errors and no rollback attempts', () => {
  const failures = [new DOMException('PRIVATE', 'SecurityError'), new DOMException('PRIVATE', 'QuotaExceededError'),
    new Error('PRIVATE'), 'PRIVATE', null, undefined];
  it.each(failures.flatMap(error => ['read', 'write', 'getter-read', 'getter-write'].map(operation => ({ error, operation }))))
  ('$operation catches $error safely and preserves all keys under the atomic port contract', ({ error, operation }) => {
    const store = new MemoryStorage(), match = created(); store.data.set(KEY, encoded(match)); const before = Array.from(store.data);
    let manager: CampaignMatchSaveManager;
    const access = vi.fn(() => { throw error; });
    if (operation.startsWith('getter')) { globalStorage(access); manager = new CampaignMatchSaveManager(); }
    else {
      if (operation === 'read') store.readFailure = { value: error }; else store.writeFailure = { value: error };
      manager = new CampaignMatchSaveManager(store);
    }
    const read = operation.endsWith('read');
    reject(read ? manager.load() : manager.save(match), read ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED');
    expect(store.getItem).toHaveBeenCalledTimes(operation === 'read' ? 1 : 0);
    expect(store.setItem).toHaveBeenCalledTimes(operation === 'write' ? 1 : 0);
    expect(access).toHaveBeenCalledTimes(operation.startsWith('getter') ? 1 : 0);
    expect(Array.from(store.data)).toEqual(before); expect(store.removeItem).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
  });
  it.each([{}, 3, 'invalid', { getItem: 1, setItem: 1 }])('malformed port %j produces read/write failure, not a throw', input => {
    const manager = new CampaignMatchSaveManager(input as unknown as StoragePort);
    reject(manager.load(), 'STORAGE_READ_FAILED'); reject(manager.save(created()), 'STORAGE_WRITE_FAILED');
  });
  it.each(['getItem', 'setItem'] as const)('throwing %s method getter is caught', method => {
    const store = new MemoryStorage(); Object.defineProperty(store, method, { get() { throw Error('PRIVATE'); } });
    const manager = new CampaignMatchSaveManager(store);
    reject(method === 'getItem' ? manager.load() : manager.save(created()), method === 'getItem' ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED');
  });
  it('write-only port does not need a read and read-only port can load without a write', () => {
    const match = created(), text = encoded(match), write = vi.fn(), read = vi.fn(() => text);
    expect(new CampaignMatchSaveManager({ setItem: write } as unknown as StoragePort).save(match)).toEqual({ ok: true });
    expect(write.mock.calls).toEqual([[KEY, text]]);
    expect(loaded({ getItem: read } as unknown as StoragePort)).toEqual(match); expect(read.mock.calls).toEqual([[KEY]]);
  });
});

describe('round-trip and explicit migration across new instances', () => {
  it.each(scenarios)('%s ordinary AI-red2 reload is inert; only explicit authorized AI reaches3', scenario => {
    const initial = createCampaignMatch(computer, scenario); if (!initial.ok) throw Error(initial.message);
    const ended = executeMatchCommand(initial.match, { kind: 'endTurn', ...requestFor(initial.match.run.session) });
    if (!ended.ok) throw Error(ended.message); const store = new MemoryStorage();
    expect(new CampaignMatchSaveManager(store).save(ended.match)).toEqual({ ok: true });
    const execute = vi.spyOn(sessions, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    const restored = loaded(store); expect(restored).toEqual(ended.match); expect(restored.run.session.turn).toBe(2);
    expect(execute).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
    expect(executeMatchCommand(restored, { kind: 'endTurn', ...requestFor(restored.run.session) })).toMatchObject({ ok: false, code: 'FACTION_CONTROLLED_BY_AI' });
    expect(execute).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
    const expected = executeMatchAiTurn(ended.match, requestFor(ended.match.run.session));
    const actual = executeMatchAiTurn(restored, requestFor(restored.run.session));
    expect(actual).toEqual(expected); if (!actual.ok) throw Error(actual.message); expect(actual.match.run.session.turn).toBe(3);
    expect(store.setItem).toHaveBeenCalledTimes(1); expect(loaded(store)).toEqual(ended.match);
  });
  it.each([1, 2])('completed AI mode preserves authority before completion errors on turn%s', turn => {
    const match = created('joint-survey-v1'); surveyed(match); match.run.control = computer; match.run.session.turn = turn;
    const store = new MemoryStorage(); expect(new CampaignMatchSaveManager(store).save(match)).toEqual({ ok: true });
    const execute = vi.spyOn(sessions, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    const restored = loaded(store), request = requestFor(restored.run.session);
    expect(executeMatchCommand(restored, { kind: 'endTurn', ...request })).toMatchObject({ ok: false,
      code: turn === 1 ? 'CAMPAIGN_COMPLETED' : 'FACTION_CONTROLLED_BY_AI' });
    expect(executeMatchAiTurn(restored, request)).toMatchObject({ ok: false,
      code: turn === 1 ? 'AI_NOT_ASSIGNED' : 'CAMPAIGN_COMPLETED' });
    expect(execute).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled(); expect(restored).toEqual(match);
    expect(store.getItem).toHaveBeenCalledTimes(1); expect(store.setItem).toHaveBeenCalledTimes(1);
  });
  it.each(scenarios.flatMap(scenario => [local, computer].flatMap(control => [false, true].flatMap(done =>
    [1, 2].map(turn => ({ scenario, control, done, turn }))))))
  ('$scenario/$control.mode/turn$turn/surveyed=$done full snapshots survive new manager', ({ scenario, control, done, turn }) => {
    const match: CampaignMatch = { run: { session: rich(turn, 3), control }, scenario };
    if (done) surveyed(match); const before = structuredClone(match); freeze(match);
    const store = new MemoryStorage(), otherKeys = Array.from(store.data), text = encoded(match);
    const execute = vi.spyOn(sessions, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn'), policy = vi.spyOn(planner, 'planAiTurn');
    expect(new CampaignMatchSaveManager(store).save(match)).toEqual({ ok: true });
    expect(store.getItem).not.toHaveBeenCalled(); expect(store.setItem.mock.calls).toEqual([[KEY, text]]);
    const first = loaded(store), second = loaded(store); expect(first).toEqual(before); expect(second).toEqual(first);
    expect(first.run.session.ships[0].design).not.toBe(second.run.session.ships[0].design);
    first.run.session.ships[0].design.name = 'Changed'; first.scenario = 'sandbox';
    expect(second).toEqual(before); expect(loaded(store)).toEqual(before); expect(match).toEqual(before);
    expect(getCampaignOutcome(second)).toEqual({ ok: true, outcome: done && scenario === 'joint-survey-v1' ? completed : { status: 'ongoing' } });
    expect(store.setItem).toHaveBeenCalledTimes(1); expect(store.getItem).toHaveBeenCalledTimes(3);
    expect(Array.from(store.data).filter(([key]) => key !== KEY)).toEqual(otherKeys);
    for (const spy of [execute, ai, policy, store.removeItem, store.clear]) expect(spy).not.toHaveBeenCalled();
  });
  it.each([1, 2].flatMap(version => [local, computer].map(control => ({ version, control }))))
  ('strict$version/$control.mode loads sandbox without rewriting, explicit save writes3', ({ version, control }) => {
    const match = created('joint-survey-v1'); match.run.control = control; surveyed(match);
    const text = oldEncoded(match, version), store = new MemoryStorage(); store.data.set(KEY, text);
    const first = loaded(store); expect(first.scenario).toBe('sandbox'); expect(first.run.control).toEqual(version === 1 ? local : control);
    expect(getCampaignOutcome(first)).toEqual({ ok: true, outcome: { status: 'ongoing' } });
    noWrites(store); expect(store.data.get(KEY)).toBe(text);
    expect(new CampaignMatchSaveManager(store).save(first)).toEqual({ ok: true }); expect(store.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.data.get(KEY)!).schemaVersion).toBe(3); expect(loaded(store)).toEqual(first);
    expect(new CampaignRunSaveManager(store).load().ok).toBe(false); expect(new CampaignSaveManager(store).load().ok).toBe(false);
    expect(store.setItem).toHaveBeenCalledTimes(1);
  });
  it('last successful writer wins; existing manager sees replacement and missing without caching', () => {
    const store = new MemoryStorage(), first = new CampaignMatchSaveManager(store), second = new CampaignMatchSaveManager(store);
    const sandbox = created(), survey = created('joint-survey-v1'); surveyed(survey);
    expect(first.save(sandbox)).toEqual({ ok: true }); expect(second.load()).toEqual({ ok: true, match: sandbox });
    expect(second.save(survey)).toEqual({ ok: true }); expect(first.load()).toEqual({ ok: true, match: survey });
    store.writeFailure = { value: 'PRIVATE' }; reject(first.save(sandbox), 'STORAGE_WRITE_FAILED');
    expect(second.load()).toEqual({ ok: true, match: survey });
    store.data.delete(KEY); reject(first.load(), 'SAVE_NOT_FOUND'); expect(store.removeItem).not.toHaveBeenCalled();
  });
  it('successful save retains independent bytes after source mutation, no cached live match', () => {
    const store = new MemoryStorage(), match = created(); expect(new CampaignMatchSaveManager(store).save(match)).toEqual({ ok: true });
    const before = structuredClone(match), text = store.data.get(KEY); match.run.session.treasuries.blue.credits = 0;
    match.scenario = 'joint-survey-v1'; expect(store.data.get(KEY)).toBe(text); expect(loaded(store)).toEqual(before);
  });
});

describe('real byte limits and immutable old bytes on failed upgrade', () => {
  it('writes and reads an exactly5MB valid match; +1 encode never accesses storage', () => {
    const match = sizedMatch(MAX_CAMPAIGN_SAVE_BYTES), store = new MemoryStorage();
    expect(new CampaignMatchSaveManager(store).save(match)).toEqual({ ok: true }); expect(bytes(store.data.get(KEY)!)).toBe(MAX_CAMPAIGN_SAVE_BYTES);
    expect(loaded(store)).toEqual(match); const before = Array.from(store.data);
    match.run.session.ships[0].design.createdAt = match.run.session.ships[0].design.createdAt.replace('Z', '0Z');
    const access = vi.fn(() => store); globalStorage(access);
    reject(new CampaignMatchSaveManager().save(match), 'SAVE_TOO_LARGE'); expect(access).not.toHaveBeenCalled();
    expect(Array.from(store.data)).toEqual(before); expect(store.setItem).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2])('legacy%s exactly5MB loads but upgrade3 refuses without changing any slot bytes', version => {
    const match = sizedMatch(MAX_CAMPAIGN_SAVE_BYTES, version), text = oldEncoded(match, version), store = new MemoryStorage();
    expect(bytes(text)).toBe(MAX_CAMPAIGN_SAVE_BYTES); store.data.set(KEY, text); const before = Array.from(store.data);
    const restored = loaded(store); expect(restored).toEqual(match); noWrites(store);
    const access = vi.fn(() => store); globalStorage(access);
    reject(new CampaignMatchSaveManager().save(restored), 'SAVE_TOO_LARGE'); expect(access).not.toHaveBeenCalled();
    expect(Array.from(store.data)).toEqual(before); noWrites(store); expect(store.getItem).toHaveBeenCalledTimes(1);
  });
  it('exact5MB JSON whitespace loads once, +1 refuses before parse without repair', () => {
    const match = created(), json = encoded(match), store = new MemoryStorage();
    const text = json + ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES - bytes(json)); store.data.set(KEY, text);
    expect(loaded(store)).toEqual(match); store.data.set(KEY, text + ' ');
    const parse = vi.spyOn(JSON, 'parse'); reject(new CampaignMatchSaveManager(store).load(), 'SAVE_TOO_LARGE');
    expect(parse).not.toHaveBeenCalled(); expect(store.getItem).toHaveBeenCalledTimes(2); noWrites(store);
  });
});

describe('paid preset/library save/new-instance/load, not browser persistence', () => {
  it.each(scenarios.flatMap(scenario => ['preset', 'library'].map(source => ({ scenario, source }))))
  ('$scenario/$source FIFO/routes and accepted AI survive restoration and a subsequent write failure', ({ scenario, source }) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const libraryData = new Map<string, string>();
    const libraryPort: StoragePort = { getItem: vi.fn(key => libraryData.get(key) ?? null), setItem: vi.fn((key, value) => { libraryData.set(key, value); }) };
    const library = new ShipDesignManager(libraryPort), design = createCombatDesign('fighter'); if (source === 'library') library.saveDesign(design);
    const choice = loadProductionCatalog(library).choices.find(item => source === 'library'
      ? item.source === 'Библиотека' && item.design.id === design.id : item.source === 'Пресет' && item.design.hullId === 'fighter')!;
    const snapshot = structuredClone(choice.design), store = new MemoryStorage(), unrelated = Array.from(store.data);
    let match = created(scenario), restored = structuredClone(match);
    function both(command: sessions.SessionCommand): void {
      const original = executeMatchCommand(match, command), loadedResult = executeMatchCommand(restored, command);
      if (!original.ok || !loadedResult.ok) throw Error('Expected successful paid command');
      expect(loadedResult).toEqual(original); match = original.match; restored = loadedResult.match;
    }
    function end(): void { both({ kind: 'endTurn', ...requestFor(match.run.session) }); }
    function checkpoint(): void {
      const reads = store.getItem.mock.calls.length, writes = store.setItem.mock.calls.length, before = structuredClone(restored);
      expect(new CampaignMatchSaveManager(store).save(restored)).toEqual({ ok: true });
      expect(store.getItem).toHaveBeenCalledTimes(reads); expect(store.setItem).toHaveBeenCalledTimes(writes + 1);
      restored = loaded(store); expect(store.getItem).toHaveBeenCalledTimes(reads + 1);
      expect(store.setItem).toHaveBeenCalledTimes(writes + 1); expect(restored).toEqual(before); expect(restored).toEqual(match);
    }
    for (const systemId of ['eden', 'nexus'] as const) {
      for (const kind of ['explore', 'colonize'] as const) both({ kind, ...requestFor(match.run.session), systemId }); end();
    }
    while (match.run.session.turn < 29) end();
    expect(match.run.session.treasuries).toEqual({ blue: { credits: 380, minerals: 190 }, red: { credits: 380, minerals: 190 } });
    for (const systemId of ['sol', 'vega'] as const) {
      for (let index = 0; index < 2; index++) both({ kind: 'enqueueProduction', ...requestFor(match.run.session), systemId, design: snapshot });
      end();
    }
    expect(match.run.session.production.orders.map(order => order.remainingTurns)).toEqual([3, 4, 3, 4]); checkpoint();
    vi.setSystemTime(new Date('2050-01-01T00:00:00.000Z'));
    if (source === 'library') { library.saveDesign({ ...snapshot, name: 'Changed after payment' }); libraryData.delete(ShipDesignManager.STORAGE_KEY); }
    vi.mocked(libraryPort.getItem).mockClear(); vi.mocked(libraryPort.setItem).mockClear(); restored = loaded(store);
    while (match.run.session.turn < 45) end();
    expect(match.run.session.production.completed.map(order => order.id)).toEqual([1, 3, 2, 4]); checkpoint();
    for (const systemId of ['sol', 'vega'] as const) {
      const records = match.run.session.production.completed.filter(record => record.systemId === systemId);
      for (const record of records) both({ kind: 'deployProduction', ...requestFor(match.run.session), systemId, orderId: record.id });
      both({ kind: 'createFleet', ...requestFor(match.run.session), systemId, shipIds: records.map(record => record.id) });
      both({ kind: 'sendFleet', ...requestFor(match.run.session), systemId, fleetId: match.run.session.fleets.lastFleetId,
        destinationId: systemId === 'sol' ? 'eden' : 'nexus' }); checkpoint();
      if (systemId === 'sol') {
        for (const systemId of ['nexus', 'vega', 'dust', 'rift'] as const) both({ kind: 'explore', ...requestFor(match.run.session), systemId }); end();
      }
    }
    for (const systemId of ['eden', 'sol', 'rift'] as const) both({ kind: 'explore', ...requestFor(match.run.session), systemId });
    checkpoint(); const almost = structuredClone(match), restoredAlmost = structuredClone(restored);
    both({ kind: 'explore', ...requestFor(match.run.session), systemId: 'dust' }); checkpoint();
    expect(getCampaignOutcome(restored)).toEqual({ ok: true, outcome: scenario === 'sandbox' ? { status: 'ongoing' } : completed });
    expect(restored.run.session.turn).toBe(46); expect(restored.run.session.ships.filter(ship => ship.transit)).toHaveLength(2);
    expect(restored.run.session.treasuries).toEqual(almost.run.session.treasuries);
    expect(restored.run.session.ships.map(ship => ship.design)).toEqual(Array(4).fill(snapshot));
    const configured = { ...almost, run: { ...almost.run, control: computer } };
    const configuredRestored = { ...restoredAlmost, run: { ...restoredAlmost.run, control: computer } };
    expect(new CampaignMatchSaveManager(store).save(configuredRestored)).toEqual({ ok: true });
    const beforeAi = loaded(store), previousBytes = store.data.get(KEY)!;
    const ai = executeMatchAiTurn(configured, requestFor(configured.run.session));
    const loadedAi = executeMatchAiTurn(beforeAi, requestFor(beforeAi.run.session));
    if (!ai.ok || !loadedAi.ok) throw Error('Expected successful AI'); expect(loadedAi).toEqual(ai);
    expect(ai.match.run.session.turn).toBe(47);
    expect(ai.match.run.session.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(ai.match.run.session.ships.map(ship => [ship.fuel, ship.transit])).toEqual(Array(4).fill([2, undefined]));
    const accepted = structuredClone(loadedAi); freeze(loadedAi); store.writeFailure = { value: new DOMException('PRIVATE', 'QuotaExceededError') };
    const reads = store.getItem.mock.calls.length, writes = store.setItem.mock.calls.length;
    reject(new CampaignMatchSaveManager(store).save(loadedAi.match), 'STORAGE_WRITE_FAILED');
    expect(store.getItem).toHaveBeenCalledTimes(reads); expect(store.setItem).toHaveBeenCalledTimes(writes + 1);
    expect(loadedAi).toEqual(accepted); expect(store.data.get(KEY)).toBe(previousBytes); expect(loaded(store)).toEqual(beforeAi);
    expect(getCampaignOutcome(loadedAi.match)).toEqual({ ok: true, outcome: loadedAi.outcome });
    store.writeFailure = undefined; expect(new CampaignMatchSaveManager(store).save(loadedAi.match)).toEqual({ ok: true });
    expect(loaded(store)).toEqual(ai.match); expect(store.data.get(KEY)).toBe(encoded(ai.match));
    expect(Array.from(store.data).filter(([key]) => key !== KEY)).toEqual(unrelated);
    for (const spy of [libraryPort.getItem, libraryPort.setItem, store.clear, store.removeItem]) expect(spy).not.toHaveBeenCalled();
  });
});
