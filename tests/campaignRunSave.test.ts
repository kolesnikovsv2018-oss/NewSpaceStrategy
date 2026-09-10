import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CAMPAIGN_RUN_SAVE_SCHEMA_VERSION, decodeCampaignRunSave, encodeCampaignRunSave,
  type CampaignRunSaveErrorCode, type CampaignRunSaveFailure, type DecodeCampaignRunSaveResult,
  type EncodeCampaignRunSaveResult } from '../src/domain/campaignRunSave';
import { CAMPAIGN_RULES_VERSION, CAMPAIGN_SAVE_FORMAT, CAMPAIGN_SAVE_SCHEMA_VERSION,
  MAX_CAMPAIGN_SAVE_BYTES, decodeCampaignSave, encodeCampaignSave } from '../src/domain/campaignSave';
import * as legacy from '../src/domain/campaignSave';
import { campaignRunSchema, type CampaignRun } from '../src/domain/campaignRun';
import * as runs from '../src/domain/campaignRun';
import { campaignSessionSchema, createCampaignSession, getCampaignSessionView, MAX_RESOURCE, MAX_TURN,
  type CampaignSession } from '../src/domain/campaignSession';
import * as sessions from '../src/domain/campaignSession';
import * as executor from '../src/domain/campaignAiExecutor';
import * as planner from '../src/domain/campaignAiPlanner';
import { MAX_CAMPAIGN_FLEETS, MAX_FLEET_ID, MAX_FLEET_SHIPS, campaignFleetsSchema } from '../src/domain/campaignFleets';
import { MAX_CAMPAIGN_SHIPS, campaignShipsSchema } from '../src/domain/campaignShips';
import { MAX_COLONY_QUEUE, MAX_ORDER_ID, MAX_PRODUCTION_RECORDS, productionStateSchema } from '../src/domain/production';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { createCombatDesign } from '../src/domain/combatPresets';
import { designSchema, validateDesign, v1DesignSchema } from '../src/domain/shipDesign';
import { CampaignSaveManager } from '../src/utils/CampaignSaveManager';
import { ShipDesignManager } from '../src/utils/ShipDesignManager';
import * as catalog from '../src/utils/ProductionCatalog';
import { freeze, known, requestFor, rich, sides } from './fixtures/campaignAi';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const local = { mode: 'local' } as const;
const computer = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } as const;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const envelope = (session: unknown = createCampaignSession(), control: unknown = local) => ({
  format: CAMPAIGN_SAVE_FORMAT, schemaVersion: 2, rulesVersion: 1, session, control
});
const documentFor = (run: CampaignRun) => JSON.stringify(envelope(run.session, run.control));
function encoded(run: unknown): string {
  const result = encodeCampaignRunSave(run);
  if (!result.ok) throw new Error(result.code);
  expect(Object.keys(result).sort()).toEqual(['json', 'ok']);
  return result.json;
}
function decoded(json: string): CampaignRun {
  const result = decodeCampaignRunSave(json);
  if (!result.ok) throw new Error(result.code);
  expect(Object.keys(result).sort()).toEqual(['ok', 'run']);
  return result.run;
}
function reject(result: EncodeCampaignRunSaveResult | DecodeCampaignRunSaveResult, code: CampaignRunSaveErrorCode): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error('Expected codec failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/); expect(result.message.length).toBeLessThan(200);
  expect(result.message).not.toMatch(/PRIVATE|Error:|issues|treasuries|exploredBy|\.ts:/);
}
function roundtrip(run: CampaignRun): CampaignRun {
  const before = structuredClone(run); freeze(run);
  expect(campaignRunSchema.safeParse(run).success).toBe(true);
  const restored = decoded(encoded(run));
  expect(restored).toEqual(before); expect(restored).not.toBe(run); expect(run).toEqual(before);
  return restored;
}
function omit(value: unknown, key: string): void { delete (value as Record<string, unknown>)[key]; }
function put(value: unknown, path: readonly (string | number)[], replacement: unknown): void {
  let node = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]] = replacement;
}

describe('run codec exports, exact envelope and ordered refusals', () => {
  it('exports distinct schema2, unchanged legacy1/rules1/budget and typed result unions', () => {
    expect([CAMPAIGN_RUN_SAVE_SCHEMA_VERSION, CAMPAIGN_SAVE_SCHEMA_VERSION, CAMPAIGN_RULES_VERSION,
      CAMPAIGN_SAVE_FORMAT, MAX_CAMPAIGN_SAVE_BYTES]).toEqual([2, 1, 1, 'orion-campaign', 5_000_000]);
    expectTypeOf<CampaignRunSaveErrorCode>().toEqualTypeOf<'INVALID_SAVE' | 'SAVE_TOO_LARGE' | 'INVALID_STATE' |
      'UNSUPPORTED_SAVE_VERSION' | 'UNSUPPORTED_RULES_VERSION' | 'UNSUPPORTED_AI_POLICY'>();
    expectTypeOf<CampaignRunSaveFailure>().toEqualTypeOf<{ ok: false; code: CampaignRunSaveErrorCode; message: string }>();
    expectTypeOf<ReturnType<typeof encodeCampaignRunSave>>().toEqualTypeOf<EncodeCampaignRunSaveResult>();
    expectTypeOf<ReturnType<typeof decodeCampaignRunSave>>().toEqualTypeOf<DecodeCampaignRunSaveResult>();
    expectTypeOf<Extract<DecodeCampaignRunSaveResult, { ok: true }>>().toEqualTypeOf<{ ok: true; run: CampaignRun }>();
    expectTypeOf<Extract<EncodeCampaignRunSaveResult, { ok: true }>>().toEqualTypeOf<{ ok: true; json: string }>();
  });
  it.each([local, computer])('writes exactly the canonical five fields for %j', control => {
    const run = { session: createCampaignSession(), control };
    expect(encoded(run)).toBe(JSON.stringify(envelope(run.session, control)));
    expect(JSON.parse(encoded(run))).toEqual(envelope(run.session, control));
    expect(roundtrip(run).control).toEqual(control);
  });
  it.each([undefined, null, 0, true, [], {}, new String('{}'), new Uint8Array([123, 125])])
  ('type precedes parser/size for %j', value => {
    const parse = vi.spyOn(JSON, 'parse'), size = vi.spyOn(TextEncoder.prototype, 'encode');
    reject(decodeCampaignRunSave(value), 'INVALID_SAVE');
    expect(parse).not.toHaveBeenCalled(); expect(size).not.toHaveBeenCalled();
  });
  it.each(['', ' \n\t', '{', '{} trailing', '{"x":NaN}', '{"x":Infinity}', '\uFEFF{}', 'null', '[]', 'true', '1', '"PRIVATE"'])
  ('rejects malformed JSON or root %j', json => reject(decodeCampaignRunSave(json), 'INVALID_SAVE'));
  it.each(['format', 'schemaVersion', 'rulesVersion', 'session'])('requires own base field %s before future versions', key => {
    const input = { ...envelope(null, null), schemaVersion: 99, rulesVersion: 99 }; omit(input, key);
    reject(decodeCampaignRunSave(JSON.stringify(input)), 'INVALID_SAVE');
  });
  it.each([null, 1, '', 'orion-shipyard', 'ORION-CAMPAIGN'])('rejects wrong format %j first', format => {
    reject(decodeCampaignRunSave(JSON.stringify({ ...envelope(null, null), schemaVersion: 99, format })), 'INVALID_SAVE');
  });
  it.each(['savedAt', 'expectedTurn', 'activeFactionId', 'summary', 'ticket', 'generation', 'request', 'paused',
    'pending', 'seed', 'cursor', 'observedFactionId', 'library', '__proto__'])('rejects root extra %s before all versions', key => {
    reject(decodeCampaignRunSave(JSON.stringify({ ...envelope(null, null), schemaVersion: 99, rulesVersion: 99, [key]: 'PRIVATE' })), 'INVALID_SAVE');
  });
  describe.each(['schemaVersion', 'rulesVersion'] as const)('%s shape', key => {
    it.each([undefined, null, '1', true, false, 0, -1, 0.5, 1.5, [], {}])('rejects %j before schema dispatch', version => {
      reject(decodeCampaignRunSave(JSON.stringify({ ...envelope(null, null), schemaVersion: 99, rulesVersion: 99, [key]: version })), 'INVALID_SAVE');
    });
    it.each(['1e400', '-1e400'])('rejects JSON overflow %s as malformed shape', value => {
      const json = JSON.stringify(envelope()).replace(`"${key}":${key === 'schemaVersion' ? 2 : 1}`, `"${key}":${value}`);
      reject(decodeCampaignRunSave(json), 'INVALID_SAVE');
    });
  });
  it.each([3, 99, Number.MAX_SAFE_INTEGER])('unknown schema %s precedes missing/invalid/unknown control and session', schemaVersion => {
    for (const control of [undefined, null, {}, { mode: 'human-vs-ai', aiPolicy: 'future' }]) {
      reject(decodeCampaignRunSave(JSON.stringify({ ...envelope(null, control), control, schemaVersion, rulesVersion: 99 })), 'UNSUPPORTED_SAVE_VERSION');
    }
  });
  it.each([1, 2])('schema%s unsupported rules precedes version-specific control and null session', schemaVersion => {
    for (const rulesVersion of [2, 99, Number.MAX_SAFE_INTEGER]) for (const control of [undefined, null, { mode: 'human-vs-ai', aiPolicy: 'future' }]) {
      reject(decodeCampaignRunSave(JSON.stringify({ ...envelope(null), control, schemaVersion, rulesVersion })), 'UNSUPPORTED_RULES_VERSION');
    }
  });
  it.each([1, 2])('strict version-specific presence for schema%s, no control default', schemaVersion => {
    const input = { ...envelope(null), schemaVersion };
    if (schemaVersion === 2) omit(input, 'control');
    reject(decodeCampaignRunSave(JSON.stringify(input)), 'INVALID_SAVE');
  });
  const invalidControls: unknown[] = [null, 1, 'local', [], {}, { mode: 'LOCAL' }, { mode: 'ai' }, { mode: 'local', aiPolicy: 'expansion-v1' },
    { mode: 'local', extra: true }, { mode: 'human-vs-ai' }, { mode: 'human-vs-ai', aiPolicy: null },
    { mode: 'human-vs-ai', aiPolicy: 1 }, { mode: 'human-vs-ai', aiPolicy: ['expansion-v1'] },
    { ...computer, extra: true }, { mode: 'human-vs-ai', aiPolicy: 'future', extra: true },
    ...['', ' ', ' expansion-v1', 'expansion-v1 ', 'expansion_v1', 'экспансия', '🚀', 'future\n', 'future\r',
      'future\t', 'a.b', 'a/b', 'a\u0000', 'a'.repeat(65)].map(aiPolicy => ({ mode: 'human-vs-ai', aiPolicy }))];
  it.each(invalidControls)('invalid control %j wins over null session; encode is INVALID_STATE', control => {
    reject(decodeCampaignRunSave(JSON.stringify(envelope(null, control))), 'INVALID_SAVE');
    reject(encodeCampaignRunSave({ session: createCampaignSession(), control }), 'INVALID_STATE');
  });
  it.each(['x', '-', 'A0-Z9', 'EXPANSION-v1', 'expansion-v2', 'a'.repeat(64)])('well-shaped unknown policy %s wins over invalid session', aiPolicy => {
    const parse = vi.spyOn(campaignRunSchema, 'safeParse');
    reject(decodeCampaignRunSave(JSON.stringify(envelope(null, { mode: 'human-vs-ai', aiPolicy }))), 'UNSUPPORTED_AI_POLICY');
    expect(parse).not.toHaveBeenCalled();
    reject(encodeCampaignRunSave({ session: createCampaignSession(), control: { mode: 'human-vs-ai', aiPolicy } }), 'INVALID_STATE');
  });
  it.each([undefined, null, [], {}, 1, true, 'PRIVATE'])('supported envelope with present session %j reaches full validation', session => {
    const input = envelope(session); input.session = session;
    reject(decodeCampaignRunSave(JSON.stringify(input)), session === undefined ? 'INVALID_SAVE' : 'INVALID_STATE');
    reject(encodeCampaignRunSave({ session, control: local }), 'INVALID_STATE');
  });
  it.each(['session', 'control'])('encode requires %s without implicit default', key => {
    const run = { session: createCampaignSession(), control: local }; omit(run, key);
    reject(encodeCampaignRunSave(run), 'INVALID_STATE');
  });
  it.each(['schemaVersion', 'rulesVersion', 'format', 'summary', 'ticket', 'savedAt'])('encode rejects caller metadata %s rather than dropping it', key => {
    reject(encodeCampaignRunSave({ session: createCampaignSession(), control: local, [key]: 2 }), 'INVALID_STATE');
  });
});

describe('explicit strict 1/1 migration only; legacy APIs remain state-only', () => {
  it.each([1, 2])('legacy parity %s restores LOCAL, never inherits a prior AI configuration', turn => {
    const session = rich(turn, 3), old = encodeCampaignSave(session);
    if (!old.ok) throw new Error(old.code);
    const oldBytes = old.json, read = vi.spyOn(legacy, 'decodeCampaignSave');
    const first = decoded(oldBytes); expect(read).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledWith(oldBytes);
    expect(first).toEqual({ session, control: local });
    const ai = decoded(encoded({ session, control: computer }));
    expect(ai.control).toEqual(computer);
    first.control.mode = 'human-vs-ai'; first.session.treasuries.red.credits = 0;
    const second = decoded(oldBytes); expect(second).toEqual({ session, control: local });
    expect(old.json).toBe(oldBytes); expect(JSON.parse(oldBytes)).not.toHaveProperty('control');
    const upgraded = encoded(second); // Only this explicit encode produces schema2, with no storage operation.
    expect(JSON.parse(upgraded)).toEqual(envelope(session, local));
    expect(decoded(upgraded)).toEqual(second); expect(decodeCampaignSave(upgraded).ok).toBe(false);
    expect(decodeCampaignSave(oldBytes)).toEqual({ ok: true, state: session });
    expect(encodeCampaignSave(session)).toEqual(old);
  });
  it.each([local, computer, null, {}, { mode: 'human-vs-ai', aiPolicy: 'future' }])('legacy1 with control %j is not a migration', control => {
    reject(decodeCampaignRunSave(JSON.stringify({ ...envelope(null, control), schemaVersion: 1 })), 'INVALID_SAVE');
  });
  it.each([local, computer])('old reader and unchanged manager reject new %j without discarding control', control => {
    const json = encoded({ session: rich(2, 3), control }), data = new Map([[CampaignSaveManager.STORAGE_KEY, json]]);
    const port = { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn() };
    expect(decodeCampaignSave(json).ok).toBe(false);
    expect(new CampaignSaveManager(port).load().ok).toBe(false);
    expect(port.getItem).toHaveBeenCalledTimes(1); expect(port.setItem).not.toHaveBeenCalled();
    expect(data.get(CampaignSaveManager.STORAGE_KEY)).toBe(json);
    expect(decoded(json).control).toEqual(control);
    expect(encodeCampaignSave({ session: createCampaignSession(), control }).ok).toBe(false);
  });
  it('rejects real library v1/v2, standalone designs, bare run/session/view and missing fuel/fleets, no library migration', () => {
    const design = createCombatDesign('fighter'), oldDesign = v1DesignSchema.parse({ ...design, schemaVersion: 1,
      slots: design.slots.filter(slot => !slot.id.startsWith('service_')) });
    const repository = new ShipDesignManager({ getItem: () => null, setItem: () => { throw new Error('Unexpected write'); } });
    const library = JSON.stringify({ schemaVersion: 1, designs: [oldDesign], components: [] });
    expect(repository.decode(library).designs[0].schemaVersion).toBe(2);
    const migrate = vi.spyOn(ShipDesignManager.prototype, 'decode');
    for (const input of [library, JSON.stringify({ schemaVersion: 2, designs: [design], components: [] }), JSON.stringify(design),
      JSON.stringify(oldDesign), JSON.stringify(createCampaignSession()), JSON.stringify(getCampaignSessionView(createCampaignSession(), 'blue')),
      JSON.stringify({ session: createCampaignSession(), control: local })]) reject(decodeCampaignRunSave(input), 'INVALID_SAVE');
    for (const damage of ['fuel', 'fleets', 'design']) {
      const state = rich(1, 3);
      if (damage === 'fuel') omit(state.ships[0], 'fuel');
      if (damage === 'fleets') omit(state, 'fleets');
      if (damage === 'design') put(state.ships[0], ['design'], oldDesign);
      const { control: _control, ...old } = { ...envelope(state), schemaVersion: 1 };
      reject(decodeCampaignRunSave(JSON.stringify(old)), 'INVALID_STATE');
    }
    expect(migrate).not.toHaveBeenCalled();
  });
});

type Corruption = [string, (session: CampaignSession) => void];
const corruptions: Corruption[] = [
  ...['galaxy', 'turn', 'treasuries', 'production', 'ships', 'fleets'].map((key): Corruption => [`missing ${key}`, s => omit(s, key)]),
  ['missing system', s => { s.galaxy.systems.pop(); }],
  ['duplicate system', s => { s.galaxy.systems[1].id = 'sol'; }],
  ['unknown system', s => put(s.galaxy.systems[0], ['id'], 'PRIVATE')],
  ['hidden duplicate exploration', s => { s.galaxy.systems.find(x => x.id === 'vega')!.exploredBy = ['red', 'red']; }],
  ['hidden owner unobserved', s => { s.galaxy.systems.find(x => x.id === 'vega')!.exploredBy = []; }],
  ['uninhabitable ownership', s => { known(s, 'rift', 'red', 'red'); }],
  ['hidden missing fuel', s => omit(s.ships[3], 'fuel')],
  ['hidden duplicate ship', s => { s.ships[4].id = 101; }],
  ['hidden ship above counter', s => { s.ships[5].id = 241; }],
  ['hidden ship overlaps order', s => { s.ships[5].id = 211; }],
  ['hidden ship overlaps completed', s => { s.ships[5].id = 231; }],
  ['hidden production duplicate', s => { s.production.completed[0].id = 211; }],
  ['production ID beyond counter', s => { s.production.lastOrderId = 220; }],
  ['unsorted FIFO', s => { s.production.orders.reverse(); }],
  ['hidden waiting progress', s => { s.production.orders[5].remainingTurns = 3; }],
  ['hidden head beyond quote', s => { s.production.orders[4].remainingTurns = 5; }],
  ['hidden completed wrong colony', s => { s.production.completed[0].systemId = 'sol'; }],
  ['hidden order wrong colony', s => { s.production.orders[4].systemId = 'sol'; }],
  ['hidden ship wrong colony', s => { s.ships[5].systemId = 'sol'; }],
  ['hidden fleet wrong colony', s => { s.fleets.items[1].systemId = 'sol'; }],
  ['hidden lost source', s => { s.galaxy.systems.find(x => x.id === 'vega')!.ownerId = null; }],
  ['hidden lost target', s => { s.galaxy.systems.find(x => x.id === 'nexus')!.ownerId = null; }],
  ['hidden same-source route', s => { s.ships[3].transit!.destinationId = 'vega'; }],
  ['hidden nonadjacent route', s => { s.ships[3].transit!.destinationId = 'sol'; }],
  ['hidden partial group transit', s => { delete s.ships[3].transit; }],
  ['hidden partial arrival', s => { delete s.ships[3].transit; s.ships[3].systemId = 'nexus'; }],
  ['divergent individually valid routes', s => {
    // Both members are locally valid; only the full session can reject their disagreement.
    known(s, 'eden', 'red', 'red'); s.ships = s.ships.filter(x => x.factionId === 'red');
    s.production.orders = []; s.production.completed = []; s.fleets.items = s.fleets.items.slice(1);
    s.fleets.items[0].systemId = 'nexus';
    s.ships[0].systemId = 'nexus'; s.ships[1].systemId = 'nexus';
    s.ships[0].transit!.destinationId = 'vega'; s.ships[1].transit!.destinationId = 'eden';
    expect(campaignShipsSchema.safeParse(s.ships).success).toBe(true);
    expect(campaignFleetsSchema.safeParse(s.fleets).success).toBe(true);
  }],
  ['hidden missing member', s => { s.fleets.items[1].shipIds[0] = 239; }],
  ['hidden pending member', s => { s.fleets.items[1].shipIds[0] = 211; }],
  ['hidden completed member', s => { s.fleets.items[1].shipIds[0] = 231; }],
  ['hidden foreign member', s => { s.fleets.items[1].shipIds[0] = 1; }],
  ['hidden duplicate member', s => { s.fleets.items[1].shipIds = [101, 101]; }],
  ['hidden single member', s => { s.fleets.items[1].shipIds = [101]; }],
  ['hidden member in two groups', s => { s.fleets.lastFleetId = 3; s.fleets.items.push({ ...s.fleets.items[1], id: 3 }); }],
  ['fleet above counter', s => { s.fleets.lastFleetId = 1; }],
  ['fleet duplicate ID', s => { s.fleets.items[1].id = 1; }],
  ['fleet unsorted', s => { s.fleets.items.reverse(); }],
  ...(['ship', 'order', 'completed'] as const).map((kind): Corruption => [`hidden invalid flight ${kind}`, s => {
    const design = kind === 'ship' ? s.ships[3].design : kind === 'order' ? s.production.orders[4].design : s.production.completed[0].design;
    design.slots.find(x => x.id === 'engine_1')!.component = null;
  }]),
  ['hidden energy deficit', s => { const c = s.ships[3].design.slots.find(x => x.component?.kind === 'engine')!.component!;
    if (c.kind === 'engine') c.powerGeneration = 0; }],
  ['hidden slot layout', s => { s.ships[3].design.slots.pop(); }],
  ['hidden invalid date', s => { s.ships[3].design.createdAt = 'PRIVATE'; }],
  ...([
    [['endTurnEconomy'], {}], [['economyForecast'], {}], [['activeFactionId'], 'red'], [['control'], local],
    [['galaxy', 'lanes'], []], [['galaxy', 'systems', 0, 'x'], 0], [['treasuries', 'red', 'debt'], 0],
    [['production', 'orders', 4, 'quote'], {}], [['production', 'orders', 4, 'fuel'], 3],
    [['production', 'completed', 0, 'remainingTurns'], 0], [['ships', 3, 'fleetId'], 2], [['ships', 3, 'hitPoints'], 1],
    [['ships', 3, 'transit', 'sourceId'], 'vega'], [['fleets', 'items', 1, 'transit'], {}],
    [['ships', 3, 'design', 'stats'], {}], [['ships', 3, 'design', 'slots', 0, 'enabled'], true]
  ] satisfies [(string | number)[], unknown][]).map(([path, value]): Corruption => [`strict extra ${path.join('.')}`, s => put(s, path, value)]),
  ...([
    [['turn'], 0], [['turn'], 1.5], [['turn'], '1'], [['turn'], MAX_TURN + 1],
    [['treasuries', 'red', 'credits'], -1], [['treasuries', 'red', 'minerals'], 0.5],
    [['treasuries', 'red', 'credits'], MAX_RESOURCE + 1], [['ships', 3, 'id'], 0],
    [['ships', 3, 'fuel'], -1], [['ships', 3, 'fuel'], 4], [['ships', 3, 'fuel'], 0.5], [['ships', 3, 'fuel'], '2'],
    [['ships', 3, 'transit'], null], [['ships', 3, 'transit', 'remainingTurns'], 2],
    [['production', 'lastOrderId'], -1], [['production', 'lastOrderId'], MAX_ORDER_ID + 1],
    [['fleets', 'lastFleetId'], 0.5], [['fleets', 'lastFleetId'], MAX_FLEET_ID + 1]
  ] satisfies [(string | number)[], unknown][]).map(([path, value]): Corruption => [`numeric ${path.join('.')}=${value}`, s => put(s, path, value)])
];

describe.each(['encode', 'decode2', 'migrate1'] as const)('%s full-session regressions (real schemas; diagnostic, not paid)', operation => {
  it.each(corruptions)('%s', (_label, corrupt) => {
    const session = rich(1, 3); corrupt(session);
    const run = { session, control: computer }, before = structuredClone(run); freeze(run);
    const { control: _control, ...old } = { ...envelope(session), schemaVersion: 1 };
    reject(operation === 'encode' ? encodeCampaignRunSave(run) : decodeCampaignRunSave(operation === 'decode2'
      ? documentFor(run) : JSON.stringify(old)), 'INVALID_STATE');
    expect(run).toEqual(before);
  });
});

describe('full detached snapshots and existing canonicalization only', () => {
  it.each([local, computer])('both parities, private sides and complete moving run %j', control => {
    for (const turn of [1, 2]) {
      const run = { session: rich(turn, 3), control }, restored = roundtrip(run);
      for (const side of sides) expect(getCampaignSessionView(restored.session, side)).toEqual(getCampaignSessionView(run.session, side));
      expect(restored.session.galaxy.systems).toHaveLength(6);
      expect(restored.session.ships.map(x => x.fuel)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(restored.session.ships.every(x => !!x.transit)).toBe(true);
    }
  });
  it('retains counter holes, ship ID equal to counter, unsorted completed/ships, FIFO and membership order', () => {
    const session = rich(1, 3); session.ships[2].id = session.production.lastOrderId; session.ships.reverse();
    session.fleets.lastFleetId = MAX_FLEET_ID;
    const result = roundtrip({ session, control: computer }).session;
    expect(result.ships.map(x => x.id)).toEqual([103, 102, 101, 240, 2, 1]);
    expect(result.production.completed.map(x => x.id)).toEqual([231, 230]);
    expect(result.production.orders.map(x => x.remainingTurns)).toEqual([1, 4, 1, 4, 1, 4, 1, 4]);
    expect(result.fleets.items.map(x => x.shipIds)).toEqual([[2, 1], [102, 101]]);
    expect(result.fleets.lastFleetId).toBe(MAX_FLEET_ID); expect(result.production.lastOrderId).toBe(240);
    const empty = createCampaignSession(); empty.production.lastOrderId = MAX_ORDER_ID; empty.fleets.lastFleetId = MAX_FLEET_ID;
    roundtrip({ session: empty, control: local });
  });
  it('accepts civilian flight, not battle; does not add historical home grants', () => {
    const session = rich(1, 3), design = createCivilianDesign('scout');
    expect(validateDesign(design, 'flight')).toEqual([]); expect(validateDesign(design, 'battle').length).toBeGreaterThan(0);
    session.ships[3].design = design; session.production.completed[0].design = structuredClone(design);
    roundtrip({ session, control: computer });
    const empty = createCampaignSession(); empty.galaxy.systems.forEach(x => { x.ownerId = null; x.exploredBy = []; });
    known(empty, 'sol', 'red', 'red'); roundtrip({ session: empty, control: computer });
  });
  it('preserves distinct same-ID snapshots, exact dates, Unicode/escaping and trims only existing names', () => {
    const session = rich(1, 3), designs = [session.ships[0].design, session.production.orders[0].design, session.production.completed[0].design];
    for (const [i, design] of designs.entries()) {
      design.id = '  проект-🚀  '; design.name = `  Корабль ${i} 🚀 "А"\\Б\nстрока\t\u0000  `;
      design.createdAt = '2024-02-29T12:34:56.123456Z'; design.updatedAt = '2026-09-10T00:00:00.000001Z';
      const beam = design.slots.find(x => x.component?.kind === 'beam')!.component!;
      beam.name = `  Лазер ${i}  `; beam.id = '  модуль  '; if (beam.kind === 'beam') beam.damage = 20 + i;
    }
    const run = { session, control: computer }, before = structuredClone(run); freeze(run);
    for (const restored of [decoded(encoded(run)), decoded(documentFor(run))]) {
      expect(restored).toEqual(campaignRunSchema.parse(before));
      expect(restored.session.ships[0].design.name).toBe(designs[0].name.trim());
      expect(restored.session.ships[0].design.id).toBe(designs[0].id);
      expect(restored.session.ships[0].design.createdAt).toBe(designs[0].createdAt);
      expect(restored.session.ships[0].design.updatedAt).toBe(designs[0].updatedAt);
      expect(restored.session.ships[0].design).not.toEqual(restored.session.production.orders[0].design);
    }
    expect(encoded(run)).toContain('\\u0000'); expect(encoded(run)).toContain('\\"А\\"'); expect(run).toEqual(before);
  });
  it('deeply detaches input, successive results, aliased designs/components/routes and all arrays', () => {
    const session = rich(1, 3); session.ships[1].design = session.ships[0].design; session.ships[1].transit = session.ships[0].transit;
    session.production.completed[0].design = session.ships[0].design;
    const run = { session, control: { ...computer } }, before = structuredClone(run), json = encoded(run);
    const first = decoded(json), second = decoded(json);
    expect(first.session.ships[0].design).not.toBe(first.session.ships[1].design);
    expect(first.session.ships[0].transit).not.toBe(first.session.ships[1].transit);
    first.session.ships[0].design.slots.find(x => x.component)!.component!.name = 'Changed';
    first.session.ships[0].transit!.destinationId = 'vega'; first.session.fleets.items[0].shipIds.reverse();
    first.session.galaxy.systems[0].exploredBy.push('red'); first.session.production.orders[0].design.name = 'Changed order';
    first.session.treasuries.red.credits = 0; first.control.mode = 'local';
    expect(first.session.ships[1].design).toEqual(before.session.ships[1].design);
    expect(first.session.ships[1].transit).toEqual(before.session.ships[1].transit);
    expect(first.session.production.completed[0].design).toEqual(before.session.production.completed[0].design);
    expect(second).toEqual(before); expect(run).toEqual(before);
    run.session.ships[0].design.name = 'Caller changed'; run.control.aiPolicy = 'expansion-v1'; run.session.fleets.items[0].shipIds.pop();
    expect(second).toEqual(before); expect(decoded(json)).toEqual(before);
  });
});

describe('real UTF-8 5MB limit before parse / after compact stringify', () => {
  it.each(['ASCII', 'Кириллица', '🚀🛰️'])('%s exact bytes accepted; +1 refuses before parse even below UTF-16 limit', name => {
    const run = { session: rich(1, 3), control: computer }; run.session.ships[0].design.name = name;
    const base = documentFor(run), count = MAX_CAMPAIGN_SAVE_BYTES - bytes(base);
    const exact = base + '\n\t '.repeat(Math.floor(count / 3)) + ' '.repeat(count % 3);
    expect(bytes(exact)).toBe(5_000_000); expect((exact + ' ').length).toBeLessThan(5_000_000);
    const parse = vi.spyOn(JSON, 'parse'); expect(decoded(exact)).toEqual(run); expect(parse).toHaveBeenCalledTimes(1);
    parse.mockClear(); expect(bytes(exact + ' ')).toBe(5_000_001);
    reject(decodeCampaignRunSave(exact + ' '), 'SAVE_TOO_LARGE'); expect(parse).not.toHaveBeenCalled();
  });
  it('ASCII fast path, Unicode and future/malformed oversized text all precede syntax/versions/policy', () => {
    const base = JSON.stringify({ ...envelope(null, { mode: 'human-vs-ai', aiPolicy: 'future' }), schemaVersion: 99 });
    const texts = ['{'.padEnd(5_000_001), 'Я'.repeat(2_500_000) + '!', base + ' '.repeat(5_000_001 - bytes(base))];
    const parse = vi.spyOn(JSON, 'parse'), measure = vi.spyOn(TextEncoder.prototype, 'encode');
    reject(decodeCampaignRunSave(texts[0]), 'SAVE_TOO_LARGE'); expect(measure).not.toHaveBeenCalled();
    for (const text of texts.slice(1)) reject(decodeCampaignRunSave(text), 'SAVE_TOO_LARGE');
    expect(parse).not.toHaveBeenCalled();
    reject(decodeCampaignRunSave(' '.repeat(5_000_000)), 'INVALID_SAVE'); expect(parse).toHaveBeenCalledTimes(1);
  });
  it.each([local, computer])('canonical encode %j uses real valid fractional datetime to hit exact/+1 bytes', control => {
    const session = createCampaignSession(), design = createCombatDesign('fighter'); design.createdAt = '2026-09-10T00:00:00.0Z';
    session.production.lastOrderId = 1; session.ships = [{ id: 1, factionId: 'blue', systemId: 'sol', fuel: 3, design }];
    const run = { session, control }, extra = MAX_CAMPAIGN_SAVE_BYTES - bytes(encoded(run));
    design.createdAt = `2026-09-10T00:00:00.${'0'.repeat(extra + 1)}Z`;
    expect(designSchema.safeParse(design).success).toBe(true); expect(campaignRunSchema.safeParse(run).success).toBe(true);
    const json = encoded(run); expect(bytes(json)).toBe(5_000_000); expect(decoded(json)).toEqual(run);
    design.createdAt = design.createdAt.replace(/Z$/, '0Z');
    expect(campaignRunSchema.safeParse(run).success).toBe(true); expect(bytes(documentFor(run))).toBe(5_000_001);
    freeze(run); reject(encodeCampaignRunSave(run), 'SAVE_TOO_LARGE'); expect(design.createdAt.endsWith('00Z')).toBe(true);
  });
  it('legacy has the same preparse cap; adding mandatory control may make explicit encode2 exceed it', () => {
    const session = createCampaignSession(), design = createCombatDesign('fighter'); design.createdAt = '2026-09-10T00:00:00.0Z';
    session.production.lastOrderId = 1; session.ships = [{ id: 1, factionId: 'blue', systemId: 'sol', fuel: 3, design }];
    const old = encodeCampaignSave(session); if (!old.ok) throw new Error(old.code);
    design.createdAt = `2026-09-10T00:00:00.${'0'.repeat(5_000_000 - bytes(old.json) + 1)}Z`;
    const exact = encodeCampaignSave(session); if (!exact.ok) throw new Error(exact.code);
    expect(bytes(exact.json)).toBe(5_000_000);
    const migrated = decoded(exact.json); expect(migrated).toEqual({ session, control: local });
    reject(encodeCampaignRunSave(migrated), 'SAVE_TOO_LARGE');
    const parse = vi.spyOn(JSON, 'parse'); reject(decodeCampaignRunSave(exact.json + ' '), 'SAVE_TOO_LARGE');
    expect(parse).not.toHaveBeenCalled(); expect(bytes(exact.json)).toBe(5_000_000);
  });
});

// Reuse the real rich fixture; increase only the distinct limits under test, never mock schemas.
function maximum(): CampaignSession {
  const state = rich(2);
  for (const [index, factionId] of sides.entries()) {
    const systemId = factionId === 'blue' ? 'sol' : 'vega';
    for (let offset = 0; offset < 95; offset++) state.production.completed.push({ id: 300 + index * 100 + offset,
      factionId, systemId, design: structuredClone(state.ships[0].design) });
    for (let offset = 0; offset < 19; offset++) state.fleets.items.push({ id: 3 + index * 19 + offset, factionId, systemId,
      shipIds: [4 + index * 100 + offset * 2, 5 + index * 100 + offset * 2] });
  }
  state.fleets.items.sort((a, b) => a.id - b.id); state.production.completed.reverse(); state.ships.reverse();
  state.production.lastOrderId = MAX_ORDER_ID; state.fleets.lastFleetId = MAX_FLEET_ID;
  return state;
}
describe('capacity/stalled states, no repair or resource advancement during codec operations', () => {
  it('roundtrips all 400 independent snapshots and 40 groups together at maximum counters', () => {
    expect([MAX_CAMPAIGN_SHIPS, MAX_PRODUCTION_RECORDS, MAX_CAMPAIGN_FLEETS, MAX_FLEET_SHIPS, MAX_COLONY_QUEUE])
      .toEqual([100, 100, 20, 10, 3]);
    const run = { session: maximum(), control: computer }, restored = roundtrip(run);
    expect(restored.session.ships).toHaveLength(200); expect(restored.session.fleets.items).toHaveLength(40);
    expect(restored.session.production.orders.length + restored.session.production.completed.length).toBe(200);
    const designs = [...restored.session.ships, ...restored.session.production.orders, ...restored.session.production.completed].map(x => x.design);
    expect(new Set(designs).size).toBe(400); expect(bytes(encoded(run))).toBeLessThan(5_000_000);
    for (const side of sides) {
      expect(restored.session.ships.filter(x => x.factionId === side)).toHaveLength(100);
      expect([...restored.session.production.orders, ...restored.session.production.completed].filter(x => x.factionId === side)).toHaveLength(100);
      expect(restored.session.fleets.items.filter(x => x.factionId === side)).toHaveLength(20);
    }
  });
  it.each(['ships', 'production', 'fleets', 'members', 'queue'] as const)('%s exact and +1 have independently valid IDs/ownership/membership', area => {
    const session = rich(1), design = session.ships[0].design;
    session.production.lastOrderId = MAX_ORDER_ID; session.fleets.lastFleetId = MAX_FLEET_ID;
    if (area === 'ships') session.ships = session.ships.filter(x => x.factionId === 'blue' || x.id <= 103);
    if (area === 'production') {
      for (let i = 0; i < 95; i++) session.production.completed.push({ id: 300 + i, factionId: 'blue', systemId: 'sol', design: structuredClone(design) });
    }
    if (area === 'fleets') for (let i = 0; i < 19; i++) session.fleets.items.push({ id: 3 + i, factionId: 'blue', systemId: 'sol', shipIds: [4 + 2 * i, 5 + 2 * i] });
    if (area === 'members') session.fleets.items[0].shipIds = Array.from({ length: 10 }, (_, i) => i + 4);
    if (area === 'queue') session.production.orders.push({ id: 300, factionId: 'blue', systemId: 'sol', design: structuredClone(design), remainingTurns: 4 });
    expect(campaignSessionSchema.safeParse(session).success).toBe(true);
    roundtrip({ session: structuredClone(session), control: local });
    if (area === 'ships') session.ships.push({ id: 500, factionId: 'blue', systemId: 'sol', fuel: 3, design: structuredClone(design) });
    if (area === 'production') session.production.completed.push({ id: 500, factionId: 'blue', systemId: 'sol', design: structuredClone(design) });
    if (area === 'fleets') session.fleets.items.push({ id: 22, factionId: 'blue', systemId: 'sol', shipIds: [42, 43] });
    if (area === 'members') session.fleets.items[0].shipIds.push(14);
    if (area === 'queue') session.production.orders.push({ id: 301, factionId: 'blue', systemId: 'sol', design: structuredClone(design), remainingTurns: 4 });
    expect(campaignShipsSchema.safeParse(session.ships).success).toBe(area !== 'ships');
    expect(productionStateSchema.safeParse(session.production).success).toBe(area !== 'production' && area !== 'queue');
    expect(campaignFleetsSchema.safeParse(session.fleets).success).toBe(area !== 'fleets' && area !== 'members');
    const run = { session, control: computer }; reject(encodeCampaignRunSave(run), 'INVALID_STATE');
    reject(decodeCampaignRunSave(documentFor(run)), 'INVALID_STATE');
  });
  it.each(sides)('%s terminal, gross cap of either resource and deficit retain full state and next result', side => {
    for (const kind of ['terminal', 'credits', 'minerals', 'deficit'] as const) {
      const session = rich(side === 'blue' ? 1 : 2); session.production.lastOrderId = MAX_ORDER_ID; session.fleets.lastFleetId = MAX_FLEET_ID;
      if (kind === 'terminal') session.turn = MAX_TURN;
      else if (kind === 'deficit') session.treasuries[side] = { credits: 5, minerals: 5 };
      else session.treasuries[side][kind] = MAX_RESOURCE;
      const run = { session, control: local }, restored = roundtrip(run), request = { kind: 'endTurn', ...requestFor(session) };
      expect(getCampaignSessionView(restored.session, side)).toEqual(getCampaignSessionView(session, side));
      const result = runs.executeRunCommand(restored, request); expect(result).toEqual(runs.executeRunCommand(run, request));
      expect(encoded(restored)).not.toMatch(/economyForecast|endTurnEconomy|summary|paidCredits|shortfallCredits/);
      if (kind !== 'deficit') expect(result).toMatchObject({ ok: false, code: kind === 'terminal' ? 'TURN_LIMIT' : 'RESOURCE_LIMIT' });
      else {
        if (!result.ok) throw new Error(result.code);
        expect(result.endTurnEconomy?.upkeep).toEqual({ shipCount: 100, dueCredits: 100, paidCredits: 25, shortfallCredits: 75 });
        expect(result.run.session.ships.filter(x => x.factionId === side && x.transit)).toEqual([]);
        expect(result.run.session.ships.filter(x => x.factionId === side).slice(0, 3).map(x => x.fuel)).toEqual([0, 0, 0]);
        expect(result.run.session.production.orders.filter(x => x.factionId === side).map(x => x.remainingTurns)).toEqual([4, 4]);
        expect(result.run.session.fleets.items.find(x => x.factionId === side)?.systemId).toBe(side === 'blue' ? 'eden' : 'nexus');
        expect(getCampaignSessionView(result.run.session, side).economyForecast).toMatchObject({ ok: true, upkeep: { paidCredits: 20, shortfallCredits: 80 } });
      }
      expect(restored).toEqual(run);
    }
  });
});

describe('pure boundary, real validation rather than exception injection', () => {
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite %s before stringify', value => {
    const run = { session: createCampaignSession(), control: computer }; run.session.treasuries.red.credits = value;
    const stringify = vi.spyOn(JSON, 'stringify'); reject(encodeCampaignRunSave(run), 'INVALID_STATE'); expect(stringify).not.toHaveBeenCalled();
  });
  it.each(['1e400', '-1e400'])('rejects real JSON session overflow %s', value => {
    reject(decodeCampaignRunSave(JSON.stringify(envelope()).replace('"credits":100', `"credits":${value}`)), 'INVALID_STATE');
  });
  it('encode/decode/migrate do not call AI, commands, clocks, IO, catalog or scheduling', () => {
    const run = { session: rich(2, 3), control: computer }, json = encoded(run), old = encodeCampaignSave(run.session);
    if (!old.ok) throw new Error(old.code);
    const before = structuredClone(run); freeze(run);
    const spies = [vi.spyOn(sessions, 'executeSessionCommand'), vi.spyOn(sessions, 'createCampaignSession'),
      vi.spyOn(runs, 'executeRunCommand'), vi.spyOn(runs, 'executeRunAiTurn'), vi.spyOn(executor, 'executeAiTurn'),
      vi.spyOn(planner, 'planAiTurn'), vi.spyOn(catalog, 'loadProductionCatalog'),
      vi.spyOn(ShipDesignManager.prototype, 'load'), vi.spyOn(ShipDesignManager.prototype, 'saveDesign'),
      vi.spyOn(ShipDesignManager.prototype, 'decode'), vi.spyOn(Math, 'random'), vi.spyOn(performance, 'now')];
    const forbidden = vi.fn((): never => { throw new Error('PRIVATE forbidden external dependency'); });
    vi.stubGlobal('Date', Object.assign(forbidden, { now: forbidden }));
    vi.stubGlobal('crypto', { randomUUID: forbidden, getRandomValues: forbidden });
    for (const name of ['localStorage', 'sessionStorage']) {
      vi.stubGlobal(name, undefined); Object.defineProperty(globalThis, name, { configurable: true, get: forbidden });
    }
    for (const name of ['fetch', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask']) vi.stubGlobal(name, forbidden);
    let results: unknown;
    try { results = [encoded(run), decoded(json), decoded(old.json)]; } finally { vi.unstubAllGlobals(); }
    expect(results).toEqual([json, before, { session: before.session, control: local }]);
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled()); expect(forbidden).not.toHaveBeenCalled(); expect(run).toEqual(before);
  });
});