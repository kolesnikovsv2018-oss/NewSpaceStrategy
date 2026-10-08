import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { campaignMatchSchema, createCampaignMatch, getCampaignOutcome, executeMatchCommand, executeMatchAiTurn,
  type CampaignMatch, type CampaignScenario } from '../src/domain/campaignMatch';
import * as runCodec from '../src/domain/campaignRunSave';
import { encodeCampaignRunSave } from '../src/domain/campaignRunSave';
import { CAMPAIGN_MATCH_SAVE_SCHEMA_VERSION, decodeCampaignMatchSave, encodeCampaignMatchSave,
  type CampaignMatchSaveErrorCode, type DecodeCampaignMatchSaveResult } from '../src/domain/campaignMatchSave';
import { MAX_CAMPAIGN_SAVE_BYTES, encodeCampaignSave, decodeCampaignSave } from '../src/domain/campaignSave';
import * as sessions from '../src/domain/campaignSession';
import * as executor from '../src/domain/campaignAiExecutor';
import * as planner from '../src/domain/campaignAiPlanner';
import { MAX_ORDER_ID, productionStateSchema, flightDesignSchema } from '../src/domain/production';
import { MAX_FLEET_ID } from '../src/domain/campaignFleets';
import { createCombatDesign } from '../src/domain/combatPresets';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { CampaignRunSaveManager } from '../src/utils/CampaignRunSaveManager';
import { loadProductionCatalog } from '../src/utils/ProductionCatalog';
import { freeze, requestFor, rich, sides } from './fixtures/campaignAi';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const local = { mode: 'local' } as const;
const computer = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } as const;
const scenarios: CampaignScenario[] = ['sandbox', 'joint-survey-v1'];
const completed = { status: 'completed', reason: 'joint-survey-complete' };
function created(scenario: CampaignScenario = 'joint-survey-v1'): CampaignMatch {
  const result = createCampaignMatch(local, scenario); if (!result.ok) throw Error(result.message);
  return result.match;
}
function encoded(match: unknown): string {
  const result = encodeCampaignMatchSave(match); if (!result.ok) throw Error(result.message);
  expect(Object.keys(result).sort()).toEqual(['json', 'ok']); return result.json;
}
function decoded(json: string): CampaignMatch {
  const result = decodeCampaignMatchSave(json); if (!result.ok) throw Error(result.message);
  expect(Object.keys(result).sort()).toEqual(['match', 'ok']); return result.match;
}
function reject(result: { ok: boolean }, code: CampaignMatchSaveErrorCode): void {
  expect(result).toMatchObject({ ok: false, code }); expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  const message = (result as { ok: false; message: string }).message;
  expect(message).toMatch(/[А-Яа-яЁё]/); expect(message.length).toBeLessThan(200);
  expect(message).not.toMatch(/PRIVATE|Error:|issues|treasuries|exploredBy/);
}
function envelope(match: CampaignMatch = created(), version = 3): Record<string, unknown> {
  return { format: 'orion-campaign', schemaVersion: version, rulesVersion: 1, session: match.run.session,
    ...(version !== 1 ? { control: match.run.control } : {}), ...(version === 3 ? { scenario: match.scenario } : {}) };
}
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
function surveyed(match: CampaignMatch): void {
  match.run.session.galaxy.systems.forEach(system => { system.exploredBy = ['blue', 'red']; });
}
function legacyEncoded(match: CampaignMatch, version: number): string {
  const result = version === 1 ? encodeCampaignSave(match.run.session) : encodeCampaignRunSave(match.run);
  if (!result.ok) throw Error(result.message); return result.json;
}

describe('match save boundary', () => {
  it('writes strict3/1 and derives completed after decoding without persisting outcome', () => {
    const created = createCampaignMatch({ mode: 'local' }, 'joint-survey-v1');
    if (!created.ok) throw Error(created.message);
    created.match.run.session.galaxy.systems.forEach(system => { system.exploredBy = ['blue', 'red']; });
    const encoded = encodeCampaignMatchSave(created.match); if (!encoded.ok) throw Error(encoded.message);
    const document = JSON.parse(encoded.json);
    expect(Object.keys(document).sort()).toEqual(['control', 'format', 'rulesVersion', 'scenario', 'schemaVersion', 'session']);
    expect(document.schemaVersion).toBe(3); expect(document.rulesVersion).toBe(1);
    const decoded = decodeCampaignMatchSave(encoded.json); if (!decoded.ok) throw Error(decoded.message);
    expect(decoded.match).toEqual(created.match);
    expect(getCampaignOutcome(decoded.match)).toEqual({ ok: true, outcome: { status: 'completed', reason: 'joint-survey-complete' } });
  });
  it('migrates a fully surveyed strict2 run only to ongoing sandbox', () => {
    const created = createCampaignMatch({ mode: 'human-vs-ai', aiPolicy: 'expansion-v1' }, 'joint-survey-v1');
    if (!created.ok) throw Error(created.message);
    created.match.run.session.galaxy.systems.forEach(system => { system.exploredBy = ['blue', 'red']; });
    const encoded = encodeCampaignRunSave(created.match.run); if (!encoded.ok) throw Error(encoded.message);
    const decoded = decodeCampaignMatchSave(encoded.json); if (!decoded.ok) throw Error(decoded.message);
    expect(decoded.match).toEqual({ run: created.match.run, scenario: 'sandbox' });
    expect(getCampaignOutcome(decoded.match)).toEqual({ ok: true, outcome: { status: 'ongoing' } });
  });
});

describe('strict envelope and error priority', () => {
  it('exports a distinct version and typed detached result without outcome', () => {
    expect(CAMPAIGN_MATCH_SAVE_SCHEMA_VERSION).toBe(3);
    expectTypeOf<CampaignMatchSaveErrorCode>().toEqualTypeOf<runCodec.CampaignRunSaveErrorCode | 'UNSUPPORTED_SCENARIO'>();
    expectTypeOf<Extract<DecodeCampaignMatchSaveResult, { ok: true }>>().toEqualTypeOf<{ ok: true; match: CampaignMatch }>();
  });
  it.each([undefined, null, 1, true, [], {}, new String('{}'), new Uint8Array([123, 125])])('rejects non-string %j before parse/size', input => {
    const parse = vi.spyOn(JSON, 'parse'), measure = vi.spyOn(TextEncoder.prototype, 'encode');
    reject(decodeCampaignMatchSave(input), 'INVALID_SAVE'); expect(parse).not.toHaveBeenCalled(); expect(measure).not.toHaveBeenCalled();
  });
  it.each(['', ' ', '{', '{} trailing', 'null', '[]', '1', 'true', '"PRIVATE"', '\uFEFF{}', '{"x":NaN}'])
  ('rejects malformed JSON/root %j', text => reject(decodeCampaignMatchSave(text), 'INVALID_SAVE'));
  it.each(['format', 'schemaVersion', 'rulesVersion', 'session'])('missing %s precedes future version', key => {
    const input = { ...envelope(), schemaVersion: 99, rulesVersion: 99 }; Reflect.deleteProperty(input, key);
    reject(decodeCampaignMatchSave(JSON.stringify(input)), 'INVALID_SAVE');
  });
  it.each(['outcome', 'run', 'winner', 'completedTurn', 'savedAt', 'summary', 'ticket', 'phase', 'progress', 'library', '__proto__'])
  ('extra %s precedes future version', key => {
    reject(decodeCampaignMatchSave(JSON.stringify({ ...envelope(), schemaVersion: 99, [key]: true })), 'INVALID_SAVE');
    reject(encodeCampaignMatchSave({ ...created(), [key]: true }), 'INVALID_STATE');
  });
  it.each(['schemaVersion', 'rulesVersion'].flatMap(key => [null, '3', 0, -1, 0.5, [], {}].map(value => ({ key, value }))))
  ('$key=$value must be a positive integer', ({ key, value }) => {
    reject(decodeCampaignMatchSave(JSON.stringify({ ...envelope(), schemaVersion: 99, [key]: value })), 'INVALID_SAVE');
  });
  it.each([1, 2, 3, 99])('schema%s orders versions before version-specific control/scenario and state', version => {
    const input = { ...envelope(), schemaVersion: version, rulesVersion: 99, control: null, scenario: null, session: null };
    reject(decodeCampaignMatchSave(JSON.stringify(input)), version === 99 ? 'UNSUPPORTED_SAVE_VERSION' : 'UNSUPPORTED_RULES_VERSION');
  });
  it.each([1, 2])('schema%s forbids scenario even if policy and state are invalid', version => {
    const input = { ...envelope(created(), version), scenario: 'sandbox', session: null, control: { ...computer, aiPolicy: 'future' } };
    const reader = vi.spyOn(runCodec, 'decodeCampaignRunSave');
    reject(decodeCampaignMatchSave(JSON.stringify(input)), 'INVALID_SAVE'); expect(reader).not.toHaveBeenCalled();
  });
  it.each(['control', 'scenario'])('schema3 requires own %s before policy', key => {
    const input = { ...envelope(), control: { ...computer, aiPolicy: 'future' }, scenario: 'future', session: null };
    Reflect.deleteProperty(input, key); reject(decodeCampaignMatchSave(JSON.stringify(input)), 'INVALID_SAVE');
  });
  it.each([null, {}, [], 'local', { mode: 'local', aiPolicy: 'expansion-v1' }, { mode: 'human-vs-ai' },
    { ...computer, extra: true }, { ...computer, aiPolicy: 'future\n' }])('bad control %j precedes scenario/state', control => {
    reject(decodeCampaignMatchSave(JSON.stringify({ ...envelope(), control, scenario: 'future', session: null })), 'INVALID_SAVE');
  });
  it.each(['x', 'EXPANSION-v1', 'A0-Z9', 'a'.repeat(64)])('unknown policy %s precedes even malformed scenario', aiPolicy => {
    reject(decodeCampaignMatchSave(JSON.stringify({ ...envelope(), control: { ...computer, aiPolicy }, scenario: {}, session: null })), 'UNSUPPORTED_AI_POLICY');
  });
  it.each([null, [], {}, 1, true, '', ' ', ' sandbox', 'sandbox ', 'sandbox\n', 'sandbox\r', 'sandbox\t', 'sandbox\u0000',
    'joint_survey_v1', 'joint.survey', 'joint/survey', 'разведка', 'a'.repeat(65)])('bad scenario %j is INVALID_SAVE, not unsupported', scenario => {
    reject(decodeCampaignMatchSave(JSON.stringify({ ...envelope(), scenario, session: null })), 'INVALID_SAVE');
    reject(encodeCampaignMatchSave({ ...created(), scenario }), 'INVALID_STATE');
  });
  it.each(['x', '-', 'A0-Z9', 'SANDBOX', 'joint-survey-v2', 'a'.repeat(64)])('unknown scenario %s precedes session validation', scenario => {
    const json = JSON.stringify({ ...envelope(), scenario, session: null });
    const read = vi.spyOn(campaignMatchSchema, 'safeParse');
    reject(decodeCampaignMatchSave(json), 'UNSUPPORTED_SCENARIO');
    expect(read).not.toHaveBeenCalled(); reject(encodeCampaignMatchSave({ ...created(), scenario }), 'INVALID_STATE');
  });
  it.each([null, {}, [], 'PRIVATE'])('known scenario passes invalid session %j to full validation', session => {
    reject(decodeCampaignMatchSave(JSON.stringify({ ...envelope(), session })), 'INVALID_STATE');
  });
  it.each([undefined, null, {}, { scenario: 'sandbox' }, { run: created().run }, created().run, created().run.session])
  ('encode rejects non-match %j', input => reject(encodeCampaignMatchSave(input), 'INVALID_STATE'));
});

describe('migration, completed roundtrips and unchanged readers', () => {
  it.each([1, 2].flatMap(version => [local, computer].map(control => ({ version, control }))))
  ('strict$version/$control.mode migrates only to sandbox, without retaining prior call settings', ({ version, control }) => {
    const match = created(); match.run.control = control; surveyed(match); const text = legacyEncoded(match, version);
    const before = text, reader = vi.spyOn(runCodec, 'decodeCampaignRunSave');
    const loaded = decoded(text); expect(reader).toHaveBeenCalledTimes(1); expect(reader).toHaveBeenCalledWith(text);
    expect(loaded).toEqual({ run: { ...match.run, control: version === 1 ? local : control }, scenario: 'sandbox' });
    expect(getCampaignOutcome(loaded)).toEqual({ ok: true, outcome: { status: 'ongoing' } });
    const copy = structuredClone(loaded); loaded.run.session.treasuries.blue.credits = 0; loaded.scenario = 'joint-survey-v1';
    decoded(encoded(match)); expect(decoded(text)).toEqual(copy); expect(text).toBe(before);
    expect(JSON.parse(encoded(copy)).schemaVersion).toBe(3);
    expect(JSON.parse(text).schemaVersion).toBe(version);
  });
  it.each(scenarios.flatMap(scenario => [local, computer].flatMap(control => [false, true].map(done => ({ scenario, control, done })))))
  ('$scenario/$control.mode/surveyed=$done roundtrip has no execution or outcome serialization', ({ scenario, control, done }) => {
    const match: CampaignMatch = { run: { session: rich(2, 3), control }, scenario };
    if (done) surveyed(match); const before = structuredClone(match); freeze(match);
    const execute = vi.spyOn(sessions, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn'), policy = vi.spyOn(planner, 'planAiTurn');
    const text = encoded(match), restored = decoded(text);
    expect(JSON.parse(text)).toEqual(envelope(match)); expect(restored).toEqual(before); expect(match).toEqual(before);
    expect(getCampaignOutcome(restored)).toEqual({ ok: true, outcome: done && scenario === 'joint-survey-v1' ? completed : { status: 'ongoing' } });
    expect(restored.run.session).not.toBe(match.run.session); expect(restored.run.session.ships[0].design).not.toBe(match.run.session.ships[0].design);
    const independent = decoded(text); restored.run.session.ships[0].design.name = 'Changed';
    expect(independent).toEqual(before); expect(decoded(text)).toEqual(before);
    expect(execute).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled(); expect(policy).not.toHaveBeenCalled();
    reject(decodeCampaignSave(text), 'INVALID_SAVE'); reject(runCodec.decodeCampaignRunSave(text), 'INVALID_SAVE');
    const port = { getItem: vi.fn(() => text), setItem: vi.fn() };
    expect(new CampaignRunSaveManager(port).load().ok).toBe(false); expect(port.setItem).not.toHaveBeenCalled();
  });
  it('completed load keeps authorization and blocks commands without reopening the game', () => {
    const match = created(); match.run.control = computer; match.run.session.turn = 2; surveyed(match);
    const restored = decoded(encoded(match)), request = requestFor(restored.run.session);
    expect(executeMatchCommand(restored, { kind: 'endTurn', ...request })).toMatchObject({ ok: false, code: 'FACTION_CONTROLLED_BY_AI' });
    expect(executeMatchAiTurn(restored, request)).toMatchObject({ ok: false, code: 'CAMPAIGN_COMPLETED' });
  });
  it('preserves valid caps/terminal and array order without recomputing counters or defaults', () => {
    const match: CampaignMatch = { run: { session: rich(sessions.MAX_TURN), control: computer }, scenario: 'joint-survey-v1' };
    const state = match.run.session;
    for (const [index, factionId] of sides.entries()) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega';
      for (let offset = 0; offset < 95; offset++) state.production.completed.push({ id: 300 + index * 100 + offset,
        factionId, systemId, design: structuredClone(state.ships[0].design) });
      for (let offset = 0; offset < 19; offset++) state.fleets.items.push({ id: 3 + index * 19 + offset,
        factionId, systemId, shipIds: [4 + index * 100 + offset * 2, 5 + index * 100 + offset * 2] });
    }
    state.fleets.items.sort((first, second) => first.id - second.id);
    state.production.lastOrderId = MAX_ORDER_ID; state.fleets.lastFleetId = MAX_FLEET_ID;
    state.treasuries.blue = { credits: sessions.MAX_RESOURCE, minerals: sessions.MAX_RESOURCE };
    state.ships.reverse(); state.production.completed.reverse(); surveyed(match);
    const restored = decoded(encoded(match)); expect(restored).toEqual(match);
    expect(restored.run.session.ships).toHaveLength(200); expect(restored.run.session.fleets.items).toHaveLength(40);
    expect(restored.run.session.production.orders.length + restored.run.session.production.completed.length).toBe(200);
    expect(getCampaignOutcome(restored)).toEqual({ ok: true, outcome: completed });
  });
});

describe('full hidden state, no repair or library migration', () => {
  const corruptions: [string, (state: sessions.CampaignSession) => void][] = [
    ['missing fuel', state => { Reflect.deleteProperty(state.ships[3], 'fuel'); }],
    ['missing fleets', state => { Reflect.deleteProperty(state, 'fleets'); }],
    ['partial group route', state => { delete state.ships[3].transit; }],
    ['unknown member', state => { state.fleets.items[1].shipIds[0] = 999; }],
    ['counter behind IDs', state => { state.production.lastOrderId = 1; }],
    ['duplicate ID', state => { state.ships[4].id = state.ships[3].id; }],
    ['FIFO waiting progress', state => { state.production.orders[5].remainingTurns = 2; }],
    ['invalid flight snapshot', state => { state.ships[3].design.slots.forEach(slot => { slot.component = null; }); }],
    ['legacy design', state => { Object.assign(state.ships[3].design, { schemaVersion: 1 }); }],
    ['hidden treasury overflow', state => { state.treasuries.red.credits = sessions.MAX_RESOURCE + 1; }],
    ['duplicate exploration', state => { state.galaxy.systems[5].exploredBy.push('red'); }],
    ['unknown session field', state => { Object.assign(state, { outcome: completed }); }]
  ];
  it.each(corruptions.flatMap(([name, corrupt]) => [1, 2, 3].map(version => ({ name, corrupt, version }))))
  ('$name schema$version rejects instead of calculating completion', ({ corrupt, version }) => {
    const match: CampaignMatch = { run: { session: rich(2, 3), control: computer }, scenario: 'joint-survey-v1' };
    surveyed(match); corrupt(match.run.session); const before = structuredClone(match); freeze(match);
    reject(decodeCampaignMatchSave(JSON.stringify(envelope(match, version))), 'INVALID_STATE');
    reject(encodeCampaignMatchSave(match), 'INVALID_STATE'); expect(match).toEqual(before);
  });
  it.each([NaN, Infinity, -Infinity])('encode refuses nonfinite %s; literal JSON1e400 also fails', value => {
    const match = created(); match.run.session.treasuries.red.credits = value;
    reject(encodeCampaignMatchSave(match), 'INVALID_STATE');
    const json = JSON.stringify(envelope()).replace('"credits":100', '"credits":1e400');
    reject(decodeCampaignMatchSave(json), 'INVALID_STATE');
  });
  it('rejects bare match/run/session and library envelopes; keeps existing name normalization only', () => {
    const match: CampaignMatch = { run: { session: rich(1, 3), control: local }, scenario: 'sandbox' };
    for (const input of [match, match.run, match.run.session, { schemaVersion: 2, designs: [match.run.session.ships[0].design], components: [] }])
      reject(decodeCampaignMatchSave(JSON.stringify(input)), 'INVALID_SAVE');
    match.run.session.ships[0].design.name = '  Судно  ';
    const restored = decoded(encoded(match)); expect(restored.run.session.ships[0].design.name).toBe('Судно');
    expect(match.run.session.ships[0].design.name).toBe('  Судно  ');
  });
});

describe('real UTF-8 boundaries', () => {
  it.each([1, 2, 3])('schema%s exact5MB decodes, +1 rejects before parse', version => {
    const text = JSON.stringify(envelope(created(), version));
    const exact = text + ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES - bytes(text)); expect(bytes(exact)).toBe(MAX_CAMPAIGN_SAVE_BYTES);
    expect(decoded(exact).scenario).toBe(version === 3 ? 'joint-survey-v1' : 'sandbox');
    const parse = vi.spyOn(JSON, 'parse'); reject(decodeCampaignMatchSave(exact + ' '), 'SAVE_TOO_LARGE'); expect(parse).not.toHaveBeenCalled();
  });
  it('counts multi-byte characters before JSON parsing, not just code units', () => {
    const text = 'я'.repeat(Math.floor(MAX_CAMPAIGN_SAVE_BYTES / 2)) + ' ';
    expect(text.length).toBeLessThan(MAX_CAMPAIGN_SAVE_BYTES); expect(bytes(text)).toBe(MAX_CAMPAIGN_SAVE_BYTES + 1);
    const parse = vi.spyOn(JSON, 'parse'); reject(decodeCampaignMatchSave(text), 'SAVE_TOO_LARGE'); expect(parse).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])('real schema%s oversized upgrade/encode uses legal long datetime, not a mocked schema', version => {
    const match: CampaignMatch = { run: { session: rich(2, 3), control: computer }, scenario: 'sandbox' };
    const design = match.run.session.ships[0].design; design.createdAt = '2026-10-08T00:00:00.0Z';
    const serialize = () => version === 3 ? encoded(match) : legacyEncoded(match, version);
    const initial = bytes(serialize()); design.createdAt = '2026-10-08T00:00:00.' + '0'.repeat(MAX_CAMPAIGN_SAVE_BYTES - initial + 1) + 'Z';
    const text = serialize(); expect(bytes(text)).toBe(MAX_CAMPAIGN_SAVE_BYTES);
    const restored = decoded(text); expect(restored.run.session).toEqual(match.run.session);
    if (version === 3) { expect(encoded(restored)).toBe(text); design.createdAt = design.createdAt.replace('Z', '0Z'); }
    reject(encodeCampaignMatchSave(version === 3 ? match : restored), 'SAVE_TOO_LARGE');
    expect(text.length).toBeLessThan(MAX_CAMPAIGN_SAVE_BYTES);
  });
});

describe('fault-only exception containment and purity', () => {
  const privateError = (): never => { throw Error('PRIVATE'); };
  it.each(['encode', 'decode3', 'decode2', 'decode1'].flatMap(operation =>
    ['session', 'production', 'flight'].map(layer => ({ operation, layer }))))
  ('$operation contains nested $layer refinement exception', ({ operation, layer }) => {
    const match: CampaignMatch = { run: { session: rich(2, 3), control: computer }, scenario: 'sandbox' };
    const json = operation === 'decode1' ? legacyEncoded(match, 1) : operation === 'decode2' ? legacyEncoded(match, 2) : encoded(match);
    const effect = layer === 'session' ? sessions.campaignSessionSchema._def.effect : layer === 'production'
      ? productionStateSchema._def.effect : flightDesignSchema._def.effect;
    if (effect.type !== 'refinement') throw Error('Expected refinement');
    const refine = vi.spyOn(effect, 'refinement').mockImplementation(privateError);
    reject(operation === 'encode' ? encodeCampaignMatchSave(match) : decodeCampaignMatchSave(json), 'INVALID_STATE');
    expect(refine).toHaveBeenCalledTimes(1);
  });
  it.each(['encode', 'decode'] as const)('%s contains TextEncoder exception', operation => {
    const match = created(), json = encoded(match); vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(privateError);
    reject(operation === 'encode' ? encodeCampaignMatchSave(match) : decodeCampaignMatchSave(json), operation === 'encode' ? 'INVALID_STATE' : 'INVALID_SAVE');
  });
  it('contains parse, stringify and encode-getter exceptions without partial data', () => {
    const match = created(); const parse = vi.spyOn(JSON, 'parse').mockImplementation(privateError);
    reject(decodeCampaignMatchSave('{}'), 'INVALID_SAVE'); parse.mockRestore();
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(privateError);
    reject(encodeCampaignMatchSave(match), 'INVALID_STATE'); stringify.mockRestore();
    reject(encodeCampaignMatchSave({ get run(): never { return privateError(); }, scenario: 'sandbox' }), 'INVALID_STATE');
  });
  it.each([1, 2])('schema%s contains legacy dependency exceptions and invalid returned run', version => {
    const json = legacyEncoded(created(), version), read = vi.spyOn(runCodec, 'decodeCampaignRunSave').mockImplementation(privateError);
    reject(decodeCampaignMatchSave(json), 'INVALID_SAVE');
    const run = created().run; run.session.turn = NaN; read.mockReturnValue({ ok: true, run });
    reject(decodeCampaignMatchSave(json), 'INVALID_STATE');
  });
  it.each([1, 2, 3, 99])('schema%s own undefined scenario is not a missing/default field', schemaVersion => {
    vi.spyOn(JSON, 'parse').mockReturnValue({ ...envelope(), schemaVersion, scenario: undefined });
    reject(decodeCampaignMatchSave('{}'), schemaVersion === 99 ? 'UNSUPPORTED_SAVE_VERSION' : 'INVALID_SAVE');
  });
  it('has no storage, clock, RNG, catalog, scheduling or gameplay calls', () => {
    const match = created(), texts = [legacyEncoded(match, 1), legacyEncoded(match, 2), encoded(match)];
    const names = ['localStorage', 'fetch', 'setTimeout', 'setInterval', 'requestAnimationFrame'];
    const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const name of names)
      Object.defineProperty(globalThis, name, { configurable: true, get: privateError });
    const now = vi.spyOn(Date, 'now').mockImplementation(privateError), random = vi.spyOn(Math, 'random').mockImplementation(privateError);
    const execute = vi.spyOn(sessions, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn'), policy = vi.spyOn(planner, 'planAiTurn');
    const read = vi.spyOn(ShipDesignManager.prototype, 'load'), write = vi.spyOn(ShipDesignManager.prototype, 'saveDesign');
    try {
      expect(encodeCampaignMatchSave(match).ok).toBe(true);
      texts.forEach(text => expect(decodeCampaignMatchSave(text).ok).toBe(true));
      for (const spy of [now, random, execute, ai, policy, read, write]) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});

describe('paid preset/library checkpoints, not real storage/reload', () => {
  it.each(scenarios.flatMap(scenario => ['preset', 'library'].map(source => ({ scenario, source }))))
  ('$scenario/$source retains FIFO/transits/snapshots and whole results across restoration', ({ scenario, source }) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const data = new Map<string, string>();
    const port: StoragePort = { getItem: vi.fn(key => data.get(key) ?? null), setItem: vi.fn((key, value) => { data.set(key, value); }) };
    const library = new ShipDesignManager(port), design = createCombatDesign('fighter'); if (source === 'library') library.saveDesign(design);
    const choice = loadProductionCatalog(library).choices.find(item => source === 'library'
      ? item.source === 'Библиотека' && item.design.id === design.id : item.source === 'Пресет' && item.design.hullId === 'fighter')!;
    const snapshot = structuredClone(choice.design); let match = created(scenario), restored = decoded(encoded(match));
    function both(command: sessions.SessionCommand): void {
      const original = executeMatchCommand(match, command), loaded = executeMatchCommand(restored, command);
      if (!original.ok || !loaded.ok) throw Error('Expected successful paid command');
      expect(loaded).toEqual(original); match = original.match; restored = loaded.match;
    }
    function end(): void { both({ kind: 'endTurn', ...requestFor(match.run.session) }); }
    function checkpoint(): void {
      const before = structuredClone(restored), text = encoded(restored); restored = decoded(text);
      expect(restored).toEqual(before); expect(restored).toEqual(match);
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
    expect(match.run.session.production.orders.map(order => order.remainingTurns)).toEqual([3, 4, 3, 4]);
    checkpoint(); const saved31 = encoded(restored), original31 = structuredClone(match);
    vi.setSystemTime(new Date('2050-01-01T00:00:00.000Z'));
    if (source === 'library') {
      library.saveDesign({ ...snapshot, name: 'Changed after payment' }); data.delete(ShipDesignManager.STORAGE_KEY);
      expect(library.load().designs).toEqual([]);
    }
    vi.mocked(port.getItem).mockClear(); vi.mocked(port.setItem).mockClear();
    restored = decoded(saved31);
    while (match.run.session.turn < 45) end();
    expect(match.run.session.production.completed.map(order => order.id)).toEqual([1, 3, 2, 4]); checkpoint();
    for (const systemId of ['sol', 'vega'] as const) {
      const records = match.run.session.production.completed.filter(record => record.systemId === systemId);
      for (const record of records) both({ kind: 'deployProduction', ...requestFor(match.run.session), systemId, orderId: record.id });
      both({ kind: 'createFleet', ...requestFor(match.run.session), systemId, shipIds: records.map(record => record.id) });
      both({ kind: 'sendFleet', ...requestFor(match.run.session), systemId, fleetId: match.run.session.fleets.lastFleetId,
        destinationId: systemId === 'sol' ? 'eden' : 'nexus' }); checkpoint();
      if (systemId === 'sol') {
        for (const target of ['nexus', 'vega', 'dust', 'rift'] as const) both({ kind: 'explore', ...requestFor(match.run.session), systemId: target });
        end();
      }
    }
    for (const systemId of ['eden', 'sol', 'rift'] as const) both({ kind: 'explore', ...requestFor(match.run.session), systemId });
    checkpoint(); const almost = structuredClone(match), restoredAlmost = structuredClone(restored);
    both({ kind: 'explore', ...requestFor(match.run.session), systemId: 'dust' }); checkpoint();
    expect(match.run.session.turn).toBe(46); expect(match.run.session.ships.filter(ship => ship.transit)).toHaveLength(2);
    expect(getCampaignOutcome(restored)).toEqual({ ok: true, outcome: scenario === 'sandbox' ? { status: 'ongoing' } : completed });
    expect(restored.run.session.treasuries).toEqual(almost.run.session.treasuries);
    expect(restored.run.session.ships.map(ship => ship.design)).toEqual(Array(4).fill(snapshot));
    const configured = { ...almost, run: { ...almost.run, control: computer } };
    const configuredRestored = decoded(encoded({ ...restoredAlmost, run: { ...restoredAlmost.run, control: computer } }));
    const ai = executeMatchAiTurn(configured, requestFor(configured.run.session));
    const restoredAi = executeMatchAiTurn(configuredRestored, requestFor(configuredRestored.run.session));
    if (!ai.ok) throw Error(ai.message); expect(restoredAi).toEqual(ai);
    expect(ai.match.run.session.turn).toBe(47);
    expect(ai.match.run.session.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(ai.match.run.session.ships.map(ship => [ship.fuel, ship.transit])).toEqual(Array(4).fill([2, undefined]));
    expect(decoded(encoded(ai.match))).toEqual(ai.match); expect(decoded(saved31)).toEqual(original31);
    expect(port.getItem).not.toHaveBeenCalled(); expect(port.setItem).not.toHaveBeenCalled();
  });
});
