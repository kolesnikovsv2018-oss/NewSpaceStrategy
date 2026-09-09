import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CAMPAIGN_RULES_VERSION, CAMPAIGN_SAVE_FORMAT, CAMPAIGN_SAVE_SCHEMA_VERSION,
  MAX_CAMPAIGN_SAVE_BYTES, decodeCampaignSave, encodeCampaignSave,
  type CampaignSaveErrorCode, type CampaignSaveFailure, type DecodeCampaignSaveResult,
  type EncodeCampaignSaveResult } from '../src/domain/campaignSave';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, type CampaignSession, type SessionCommand, type SessionResult } from '../src/domain/campaignSession';
import * as sessionDomain from '../src/domain/campaignSession';
import { type SystemId } from '../src/domain/campaign';
import { MAX_FLEET_ID } from '../src/domain/campaignFleets';
import { MAX_ORDER_ID } from '../src/domain/production';
import { createCombatDesign } from '../src/domain/combatPresets';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { designSchema, validateDesign, v1DesignSchema, type ShipDesign } from '../src/domain/shipDesign';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { loadProductionCatalog } from '../src/utils/ProductionCatalog';
import * as productionCatalog from '../src/utils/ProductionCatalog';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const sides = ['blue', 'red'] as const;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const envelope = (session: unknown = createCampaignSession()) => ({
  format: 'orion-campaign', schemaVersion: 1, rulesVersion: 1, session
});
const documentFor = (session: unknown) => JSON.stringify(envelope(session));
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function encoded(state: unknown): string {
  const result = encodeCampaignSave(state);
  if (!result.ok) throw new Error(result.code);
  expect(Object.keys(result).sort()).toEqual(['json', 'ok']);
  return result.json;
}
function decoded(json: string): CampaignSession {
  const result = decodeCampaignSave(json);
  if (!result.ok) throw new Error(result.code);
  expect(Object.keys(result).sort()).toEqual(['ok', 'state']);
  return result.state;
}
function rejected(result: EncodeCampaignSaveResult | DecodeCampaignSaveResult, code: CampaignSaveErrorCode): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error('Expected codec failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/);
  expect(result.message.length).toBeLessThan(250);
  expect(result.message).not.toMatch(/SECRET_PAYLOAD|\bat .*\.ts:|SyntaxError|ZodError/);
}
function roundtrip(state: CampaignSession): CampaignSession {
  const before = structuredClone(state);
  expect(campaignSessionSchema.safeParse(state).success).toBe(true);
  const next = decoded(encoded(state));
  expect(next).toEqual(before);
  expect(state).toEqual(before);
  expect(next).not.toBe(state);
  return next;
}
function success(state: CampaignSession, command: SessionCommand): Extract<SessionResult, { ok: true }> {
  const before = structuredClone(state), payload = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(state).toEqual(before); expect(command).toEqual(payload);
  if (!result.ok) throw new Error(`${command.kind}: ${result.code}`);
  expect(result.state).not.toBe(state);
  expect(campaignSessionSchema.safeParse(result.state).success).toBe(true);
  return result;
}
const endCommand = (state: CampaignSession): SessionCommand => ({
  kind: 'endTurn', factionId: state.turn % 2 ? 'blue' : 'red', expectedTurn: state.turn
});
const end = (state: CampaignSession) => success(state, endCommand(state)).state;

// Deliberately injected diagnostic state, NOT evidence of an earned gameplay history.
function diagnostic(): CampaignSession {
  const state = createCampaignSession(), design = createCombatDesign('fighter');
  for (const [id, side] of [['eden', 'blue'], ['nexus', 'red']] as const) {
    const system = state.galaxy.systems.find(item => item.id === id)!;
    system.ownerId = side; system.exploredBy = [side];
  }
  design.createdAt = '2024-02-29T12:34:56.123456Z';
  design.updatedAt = '2026-09-09T00:00:00.000001Z';
  state.production = { lastOrderId: 20, orders: [
    { id: 11, factionId: 'blue', systemId: 'sol', design: structuredClone(design), remainingTurns: 1 },
    { id: 12, factionId: 'blue', systemId: 'sol', design: structuredClone(design), remainingTurns: 4 },
    { id: 13, factionId: 'red', systemId: 'vega', design: structuredClone(design), remainingTurns: 2 }
  ], completed: [
    { id: 18, factionId: 'red', systemId: 'vega', design: structuredClone(design) },
    { id: 15, factionId: 'blue', systemId: 'sol', design: structuredClone(design) }
  ] };
  state.ships = [2, 1, 4, 3, 6, 5].map(id => {
    const factionId = id === 1 || id === 2 || id === 5 ? 'blue' : 'red';
    return { id, factionId, systemId: factionId === 'blue' ? 'sol' : 'vega',
      design: structuredClone(design), fuel: id % 4,
      ...(id <= 4 ? { transit: { destinationId: factionId === 'blue' ? 'eden' as const : 'nexus' as const,
        remainingTurns: 1 as const } } : {}) };
  });
  state.fleets = { lastFleetId: 9, items: [
    { id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] },
    { id: 3, factionId: 'red', systemId: 'vega', shipIds: [4, 3] }
  ] };
  return state;
}

// Only corruption tests use dynamic paths: no weakening/casting of the production schemas.
function put(target: unknown, path: readonly (string | number)[], value: unknown): void {
  let node = target as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]] = value;
}
function omit(target: unknown, key: string): void { delete (target as Record<string, unknown>)[key]; }

describe('campaign save public contract and envelope priority', () => {
  it('exports the exact v1/rules1/UTF-8 limit and discriminated result/error unions', () => {
    expect([CAMPAIGN_SAVE_FORMAT, CAMPAIGN_SAVE_SCHEMA_VERSION, CAMPAIGN_RULES_VERSION, MAX_CAMPAIGN_SAVE_BYTES])
      .toEqual(['orion-campaign', 1, 1, 5_000_000]);
    expectTypeOf<CampaignSaveErrorCode>().toEqualTypeOf<'INVALID_SAVE' | 'SAVE_TOO_LARGE' |
      'UNSUPPORTED_SAVE_VERSION' | 'UNSUPPORTED_RULES_VERSION' | 'INVALID_STATE'>();
    expectTypeOf<CampaignSaveFailure>().toEqualTypeOf<{ ok: false; code: CampaignSaveErrorCode; message: string }>();
    expectTypeOf<ReturnType<typeof encodeCampaignSave>>().toEqualTypeOf<EncodeCampaignSaveResult>();
    expectTypeOf<ReturnType<typeof decodeCampaignSave>>().toEqualTypeOf<DecodeCampaignSaveResult>();
    expectTypeOf<Extract<EncodeCampaignSaveResult, { ok: true }>>().toEqualTypeOf<{ ok: true; json: string }>();
    expectTypeOf<Extract<DecodeCampaignSaveResult, { ok: true }>>()
      .toEqualTypeOf<{ ok: true; state: CampaignSession }>();
    expect(JSON.parse(encoded(createCampaignSession()))).toEqual(envelope());
  });

  it.each([undefined, null, 0, true, [], {}, new String('{}'), new Uint8Array([123, 125])])
    ('rejects non-string input %j without parsing', input => {
      const parse = vi.spyOn(JSON, 'parse');
      rejected(decodeCampaignSave(input), 'INVALID_SAVE'); expect(parse).not.toHaveBeenCalled();
    });
  it.each(['', ' \n\t', '{', '{"format":', '{"x":NaN}', '{"x":Infinity}', '{} trailing', '\uFEFF{}',
    'null', '[]', 'true', '1', '"SECRET_PAYLOAD"'])('rejects malformed JSON/root %j', input => {
    rejected(decodeCampaignSave(input), 'INVALID_SAVE');
  });
  it.each(['format', 'schemaVersion', 'rulesVersion', 'session'])('requires envelope key %s even with future versions', key => {
    const input = { ...envelope(null), schemaVersion: 2, rulesVersion: 2 }; omit(input, key);
    rejected(decodeCampaignSave(JSON.stringify(input)), 'INVALID_SAVE');
  });
  it.each([null, 1, '', 'orion-shipyard', 'ORION-CAMPAIGN'])('rejects format %j before versions', format => {
    rejected(decodeCampaignSave(JSON.stringify({ ...envelope(null), format, schemaVersion: 2 })), 'INVALID_SAVE');
  });
  it.each(['savedAt', 'expectedTurn', 'activeFactionId', 'receipt', 'SECRET_PAYLOAD'])('rejects extra envelope key %s first', key => {
    rejected(decodeCampaignSave(JSON.stringify({ ...envelope(null), schemaVersion: 2, [key]: 'SECRET_PAYLOAD' })), 'INVALID_SAVE');
  });
  describe.each(['schemaVersion', 'rulesVersion'] as const)('%s', key => {
    it.each([undefined, null, '1', true, 0, -1, 0.5, 1.5, [], {}])('rejects non-positive-integer version %j as shape', version => {
      const input = { ...envelope(null), schemaVersion: 2, rulesVersion: 2, [key]: version };
      rejected(decodeCampaignSave(JSON.stringify(input)), 'INVALID_SAVE');
    });
    it.each([2, 999, Number.MAX_SAFE_INTEGER])('rejects unsupported positive version %s before null session', version => {
      rejected(decodeCampaignSave(JSON.stringify({ ...envelope(null), [key]: version })),
        key === 'schemaVersion' ? 'UNSUPPORTED_SAVE_VERSION' : 'UNSUPPORTED_RULES_VERSION');
    });
    it('rejects an overflowing JSON number as malformed shape, not an unsupported version', () => {
      const text = JSON.stringify(envelope()).replace(`"${key}":1`, `"${key}":1e400`);
      rejected(decodeCampaignSave(text), 'INVALID_SAVE');
    });
  });
  it('checks schema before rules before the contents of a present session', () => {
    rejected(decodeCampaignSave(JSON.stringify({ ...envelope(null), schemaVersion: 2, rulesVersion: 3 })), 'UNSUPPORTED_SAVE_VERSION');
    rejected(decodeCampaignSave(JSON.stringify({ ...envelope(null), rulesVersion: 3 })), 'UNSUPPORTED_RULES_VERSION');
    rejected(decodeCampaignSave(documentFor(null)), 'INVALID_STATE');
    rejected(decodeCampaignSave(documentFor({})), 'INVALID_STATE');
    rejected(decodeCampaignSave(JSON.stringify({ ...envelope(null), schemaVersion: 2, rulesVersion: '3' })), 'INVALID_SAVE');
  });
  it('rejects actual library v1/v2, standalone designs and raw session/view without migration', () => {
    const design = createCombatDesign('fighter');
    const old = v1DesignSchema.parse({ ...design, schemaVersion: 1,
      slots: design.slots.filter(slot => !slot.id.startsWith('service_')) });
    const repository = new ShipDesignManager({ getItem: () => null, setItem: () => { throw new Error('Unexpected write'); } });
    const legacyLibrary = JSON.stringify({ schemaVersion: 1, designs: [old], components: [] });
    expect(repository.decode(legacyLibrary).designs[0].schemaVersion).toBe(2); // Valid library, not junk JSON.
    const migrate = vi.spyOn(repository, 'decode');
    const load = vi.spyOn(ShipDesignManager.prototype, 'load');
    for (const input of [legacyLibrary, JSON.stringify({ schemaVersion: 2, designs: [design], components: [] }),
      JSON.stringify(design), JSON.stringify(old), JSON.stringify(createCampaignSession()),
      JSON.stringify(getCampaignSessionView(createCampaignSession(), 'blue'))]) {
      rejected(decodeCampaignSave(input), 'INVALID_SAVE');
    }
    const state = diagnostic(); put(state.ships[0], ['design'], old);
    rejected(encodeCampaignSave(state), 'INVALID_STATE');
    rejected(decodeCampaignSave(documentFor(state)), 'INVALID_STATE');
    expect(migrate).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  });
});

type Corruption = [string, (state: CampaignSession) => void];
const corruptions: Corruption[] = [
  ...(['galaxy', 'turn', 'treasuries', 'production', 'ships', 'fleets'] as const)
    .map((key): Corruption => [`missing mandatory ${key}`, state => omit(state, key)]),
  ['missing system', s => { s.galaxy.systems.pop(); }],
  ['duplicate system ID', s => { s.galaxy.systems[1].id = 'sol'; }],
  ['unknown system ID', s => put(s, ['galaxy', 'systems', 1, 'id'], 'foreign')],
  ['duplicate exploration', s => { s.galaxy.systems[0].exploredBy = ['blue', 'blue']; }],
  ['owner not explored', s => { s.galaxy.systems[0].exploredBy = []; }],
  ['uninhabitable owned system', s => { const r = s.galaxy.systems.find(x => x.id === 'rift')!; r.ownerId = 'blue'; r.exploredBy = ['blue']; }],
  ['foreign faction ID', s => put(s.ships[0], ['factionId'], 'neutral')],
  ['missing fuel', s => omit(s.ships[0], 'fuel')],
  ['missing fleet items', s => omit(s.fleets, 'items')],
  ['missing fleet counter', s => omit(s.fleets, 'lastFleetId')],
  ['duplicate ship ID', s => { s.ships[1].id = s.ships[0].id; }],
  ['ship ID above lastOrderId', s => { s.ships[4].id = 21; }],
  ['ship overlaps pending order', s => { s.ships[4].id = 11; }],
  ['ship overlaps completed record', s => { s.ships[4].id = 18; }],
  ['duplicate production ID across arrays', s => { s.production.completed[0].id = 11; }],
  ['duplicate pending ID', s => { s.production.orders[1].id = 11; }],
  ['duplicate completed ID', s => { s.production.completed[1].id = 18; }],
  ['production ID above counter', s => { s.production.lastOrderId = 17; }],
  ['unsorted FIFO', s => { s.production.orders.reverse(); }],
  ['progress in waiting FIFO order', s => { s.production.orders[1].remainingTurns = 3; }],
  ['head beyond quoted duration', s => { s.production.orders[0].remainingTurns = 5; }],
  ['head already completed', s => { s.production.orders[0].remainingTurns = 0; }],
  ['colony queue above three', s => {
    s.production.orders = [11, 12, 13, 14].map(id => ({ ...structuredClone(s.production.orders[1]), id }));
  }],
  ['production in foreign colony', s => { s.production.orders[0].systemId = 'vega'; }],
  ['completed in foreign colony', s => { s.production.completed[0].systemId = 'sol'; }],
  ['ship in foreign colony', s => { s.ships[4].systemId = 'sol'; }],
  ['group in foreign colony', s => { s.fleets.items[0].systemId = 'vega'; }],
  ['lost source ownership', s => { s.galaxy.systems[0].ownerId = null; }],
  ['lost target ownership', s => { s.galaxy.systems.find(x => x.id === 'eden')!.ownerId = null; }],
  ['foreign target ownership', s => { const e = s.galaxy.systems.find(x => x.id === 'eden')!; e.ownerId = 'red'; e.exploredBy = ['red']; }],
  ['same-source transit', s => { s.ships[0].transit!.destinationId = 'sol'; }],
  ['nonadjacent transit', s => { s.ships[0].transit!.destinationId = 'nexus'; }],
  ['partial group transit', s => { delete s.ships[0].transit; }],
  ['partial group arrival', s => { delete s.ships[0].transit; s.ships[0].systemId = 'eden'; }],
  ['divergent individually valid group routes', s => {
    const n = s.galaxy.systems.find(x => x.id === 'nexus')!; n.ownerId = 'blue'; n.exploredBy = ['blue'];
    s.ships = s.ships.filter(x => x.factionId === 'blue'); s.fleets.items = s.fleets.items.slice(0, 1);
    s.production.orders = s.production.orders.filter(x => x.factionId === 'blue');
    s.production.completed = s.production.completed.filter(x => x.factionId === 'blue');
    s.fleets.items[0].systemId = 'eden';
    s.ships[0].systemId = 'eden'; s.ships[1].systemId = 'eden';
    s.ships[0].transit!.destinationId = 'sol'; s.ships[1].transit!.destinationId = 'nexus';
  }],
  ['missing fleet member', s => { s.fleets.items[0].shipIds[0] = 19; }],
  ['pending order as fleet member', s => { s.fleets.items[0].shipIds[0] = 11; }],
  ['completed record as fleet member', s => { s.fleets.items[0].shipIds[0] = 15; }],
  ['foreign fleet member', s => { s.fleets.items[0].shipIds[0] = 3; }],
  ['member from other own colony', s => { delete s.ships[0].transit; s.ships[0].systemId = 'eden'; delete s.ships[1].transit; }],
  ['duplicate member within fleet', s => { s.fleets.items[0].shipIds = [1, 1]; }],
  ['member in two fleets', s => { s.fleets.items.push({ ...structuredClone(s.fleets.items[0]), id: 4 }); }],
  ['one-member fleet', s => { s.fleets.items[0].shipIds = [1]; }],
  ['duplicate fleet ID', s => { s.fleets.items[1].id = 1; }],
  ['fleet ID above counter', s => { s.fleets.lastFleetId = 2; }],
  ['unsorted fleet IDs', s => { s.fleets.items.reverse(); }],
  ['invalid flight in ship', s => { s.ships[0].design.slots.find(x => x.id === 'engine_1')!.component = null; }],
  ['invalid flight in order', s => { s.production.orders[0].design.slots.find(x => x.id === 'engine_1')!.component = null; }],
  ['invalid flight in completed', s => { s.production.completed[0].design.slots.find(x => x.id === 'engine_1')!.component = null; }],
  ['flight energy deficit', s => { const c = s.ships[0].design.slots.find(x => x.id === 'engine_1')!.component!; if (c.kind === 'engine') c.powerGeneration = 0; }],
  ['malformed date', s => { s.ships[0].design.createdAt = 'not-a-date'; }],
  ['wrong slot layout', s => { s.ships[0].design.slots.pop(); }],
  ['extra receipt', s => put(s, ['endTurnEconomy'], { paidCredits: 999 })],
  ['extra forecast', s => put(s, ['economyForecast'], { ok: true })],
  ['extra active side', s => put(s, ['activeFactionId'], 'blue')],
  ['extra galaxy definition', s => put(s.galaxy, ['lanes'], [])],
  ['extra system coordinate', s => put(s.galaxy.systems[0], ['x'], 0)],
  ['extra treasury debt', s => put(s.treasuries.blue, ['debt'], 0)],
  ['extra production quote', s => put(s.production.orders[0], ['quote'], { turns: 4 })],
  ['extra completed progress', s => put(s.production.completed[0], ['remainingTurns'], 0)],
  ['extra production fuel', s => put(s.production.orders[0], ['fuel'], 3)],
  ['extra ship fleetId', s => put(s.ships[0], ['fleetId'], 1)],
  ['extra ship runtime', s => put(s.ships[0], ['hitPoints'], 200)],
  ['extra fleet route', s => put(s.fleets.items[0], ['transit'], { destinationId: 'eden', remainingTurns: 1 })],
  ['extra fleet design', s => put(s.fleets.items[0], ['design'], s.ships[0].design)],
  ['extra transit source', s => put(s.ships[0].transit, ['sourceId'], 'sol')],
  ['extra design stats', s => put(s.ships[0].design, ['stats'], {})],
  ['extra slot field', s => put(s.ships[0].design.slots[0], ['enabled'], true)],
  ['extra component field', s => put(s.ships[0].design.slots.find(x => x.component)!.component, ['mass'], 1)]
];

describe.each(['encode', 'decode'] as const)('%s full runtime validation (diagnostic corruptions)', api => {
  function check(state: unknown): void {
    const before = structuredClone(state); freeze(state);
    rejected(api === 'encode' ? encodeCampaignSave(state) : decodeCampaignSave(documentFor(state)), 'INVALID_STATE');
    expect(state).toEqual(before);
  }
  it.each(corruptions)('%s', (_label, corrupt) => {
    const state = diagnostic(); expect(campaignSessionSchema.safeParse(state).success).toBe(true);
    corrupt(state); check(state);
  });
  it.each([null, {}, [], 1, 'SECRET_PAYLOAD', true])('rejects incomplete/wrong session %j', check);
  it.each([
    ['turn zero', ['turn'], 0], ['turn fraction', ['turn'], 1.5], ['turn string', ['turn'], '1'],
    ['turn above cap', ['turn'], MAX_TURN + 1], ['negative credits', ['treasuries', 'blue', 'credits'], -1],
    ['fractional minerals', ['treasuries', 'red', 'minerals'], 0.5], ['treasury above cap', ['treasuries', 'blue', 'credits'], MAX_RESOURCE + 1],
    ['ship ID zero', ['ships', 0, 'id'], 0], ['fuel negative', ['ships', 0, 'fuel'], -1],
    ['fuel over capacity', ['ships', 0, 'fuel'], 4], ['fuel fractional', ['ships', 0, 'fuel'], 0.5],
    ['fuel string', ['ships', 0, 'fuel'], '2'], ['transit null', ['ships', 0, 'transit'], null],
    ['route duration two', ['ships', 0, 'transit', 'remainingTurns'], 2],
    ['route duration zero', ['ships', 0, 'transit', 'remainingTurns'], 0],
    ['negative order counter', ['production', 'lastOrderId'], -1], ['order counter overflow', ['production', 'lastOrderId'], MAX_ORDER_ID + 1],
    ['fractional fleet counter', ['fleets', 'lastFleetId'], 1.5], ['fleet counter overflow', ['fleets', 'lastFleetId'], MAX_FLEET_ID + 1]
  ] satisfies [string, (string | number)[], unknown][])('%s', (_label, path, value) => {
    const state = diagnostic(); put(state, path, value); check(state);
  });
});

describe('lossless, detached snapshots', () => {
  it.each([1, 2])('roundtrips a frozen initial session at parity %i, keeping both private sides', turn => {
    let state = createCampaignSession(); if (turn === 2) state = end(state);
    freeze(state); const restored = roundtrip(state);
    for (const side of sides) expect(getCampaignSessionView(restored, side)).toEqual(getCampaignSessionView(state, side));
    expect(getCampaignSessionView(restored, 'blue').activeFactionId).toBe(turn === 1 ? 'blue' : 'red');
    expect(restored.galaxy.systems).toHaveLength(6); expect(Object.keys(restored.treasuries)).toEqual(['blue', 'red']);
  });
  it('preserves counter holes, unsorted ships/completed, FIFO head/waiter and ordered membership', () => {
    const state = diagnostic(); state.ships.find(x => x.id === 5)!.id = state.production.lastOrderId;
    freeze(state); const restored = roundtrip(state);
    expect(restored.ships.map(x => x.id)).toEqual([2, 1, 4, 3, 6, 20]);
    expect(restored.production.completed.map(x => x.id)).toEqual([18, 15]);
    expect(restored.production.orders.map(x => x.remainingTurns)).toEqual([1, 4, 2]);
    expect(restored.fleets).toEqual(state.fleets); expect(restored.production.lastOrderId).toBe(20);
    expect(roundtrip({ ...createCampaignSession(), production: { lastOrderId: MAX_ORDER_ID, orders: [], completed: [] },
      fleets: { lastFleetId: MAX_FLEET_ID, items: [] } }).production.lastOrderId).toBe(MAX_ORDER_ID);
  });
  it('does not add a home-ownership/history rule absent from the runtime schema', () => {
    const state = createCampaignSession();
    for (const system of state.galaxy.systems) { system.ownerId = null; system.exploredBy = []; }
    const sol = state.galaxy.systems.find(x => x.id === 'sol')!; sol.ownerId = 'red'; sol.exploredBy = ['red'];
    roundtrip(state); expect(getCampaignSessionView(state, 'blue').income).toEqual({ credits: 0, minerals: 0 });
  });
  it('accepts civilian flight rather than requiring a battle design', () => {
    const state = diagnostic(), civilian = createCivilianDesign('scout');
    expect(validateDesign(civilian, 'flight')).toEqual([]); expect(validateDesign(civilian, 'battle').length).toBeGreaterThan(0);
    state.ships[0].design = civilian; state.production.completed[0].design = structuredClone(civilian);
    roundtrip(state);
  });
  it('preserves different snapshots with the same design/component IDs and their exact dates', () => {
    const state = diagnostic(), original = structuredClone(state);
    const designs = [state.production.orders[0].design, state.production.completed[0].design, state.ships[0].design];
    designs.forEach((design, index) => {
      design.name = `Снимок ${index}`;
      const component = design.slots.find(x => x.component?.kind === 'beam')!.component!;
      if (component.kind === 'beam') component.damage = 20 + index;
    });
    expect(new Set(designs.map(x => x.id)).size).toBe(1);
    const restored = roundtrip(state);
    expect(restored.ships[0].design.createdAt).toBe(original.ships[0].design.createdAt);
    expect(restored.ships[0].design.updatedAt).toBe(original.ships[0].design.updatedAt);
    expect(restored.ships[0].design).not.toEqual(restored.production.orders[0].design);
    expect(restored.production.completed[0].design).not.toEqual(restored.production.orders[0].design);
  });
  it('uses only existing name.trim, preserving IDs, dates, Unicode, control characters and JSON escaping', () => {
    const state = diagnostic(), design = state.ships[0].design;
    design.name = '  Корабль 🚀 "А"\\Б\nстрока\t\u0000  ';
    design.id = '  проект-🚀  ';
    const component = design.slots.find(x => x.component)!.component!;
    component.name = ' \tЛазер "Я" 🚀\\\nвнутри  '; component.id = '  модуль  ';
    const before = structuredClone(state); freeze(state);
    for (const restored of [decoded(encoded(state)), decoded(documentFor(state))]) {
      expect(restored).toEqual(campaignSessionSchema.parse(before));
      expect(restored.ships[0].design.name).toBe(design.name.trim());
      expect(restored.ships[0].design.id).toBe(design.id);
      expect(restored.ships[0].design.slots.find(x => x.component)!.component!.name).toBe(component.name.trim());
      expect(restored.ships[0].design.createdAt).toBe(design.createdAt);
      expect(restored.ships[0].design.updatedAt).toBe(design.updatedAt);
    }
    const json = encoded(state); expect(json).toContain('\\u0000'); expect(json).toContain('\\"А\\"');
    expect(state).toEqual(before);
  });
  it('deeply separates input, successive decodes and repeated snapshots/components/membership/routes', () => {
    const state = diagnostic();
    // Even aliases in an otherwise valid caller-owned state must become distinct snapshots.
    state.ships[1].design = state.ships[0].design;
    state.ships[1].transit = state.ships[0].transit;
    state.production.completed[1].design = state.ships[0].design;
    const before = structuredClone(state), json = encoded(state), first = decoded(json), second = decoded(json);
    expect(first.ships[0].design).not.toBe(first.ships[1].design);
    expect(first.ships[0].transit).not.toBe(first.ships[1].transit);
    first.ships[0].design.slots.find(x => x.component)!.component!.name = 'Changed';
    first.ships[0].transit!.destinationId = 'vega';
    first.fleets.items[0].shipIds.reverse(); first.galaxy.systems[0].exploredBy.push('red');
    first.production.orders[0].design.name = 'Changed order'; first.treasuries.red.credits = 0;
    expect(first.ships[1].design).toEqual(before.ships[1].design);
    expect(first.ships[1].transit).toEqual(before.ships[1].transit);
    expect(first.production.completed[1].design).toEqual(before.production.completed[1].design);
    expect(second).toEqual(before); expect(state).toEqual(before); expect(decoded(json)).toEqual(before);
    state.ships[0].design.name = 'Changed caller'; state.fleets.items[0].shipIds.pop();
    expect(second).toEqual(before); expect(decoded(json)).toEqual(before);
  });
});

describe('exact UTF-8 resource boundary, not a mocked schema/limit', () => {
  it.each(['ASCII', 'Кириллица', '🚀🛰️'])('counts whitespace and %s bytes: exact cap succeeds, +1 never parses', name => {
    const state = diagnostic(); state.ships[0].design.name = name;
    const base = documentFor(state), padding = MAX_CAMPAIGN_SAVE_BYTES - bytes(base);
    const exact = base + '\n\t '.repeat(Math.floor(padding / 3)) + ' '.repeat(padding % 3);
    expect(bytes(exact)).toBe(5_000_000);
    // Other Russian design/component names also make the ASCII-labelled document multibyte.
    expect(exact.length).toBeLessThan(MAX_CAMPAIGN_SAVE_BYTES);
    const parse = vi.spyOn(JSON, 'parse');
    const restored = decodeCampaignSave(exact);
    expect(restored).toEqual({ ok: true, state }); expect(parse).toHaveBeenCalledTimes(1);
    parse.mockClear();
    expect((exact + ' ').length).toBeLessThan(MAX_CAMPAIGN_SAVE_BYTES);
    expect(bytes(exact + ' ')).toBe(5_000_001);
    rejected(decodeCampaignSave(exact + ' '), 'SAVE_TOO_LARGE'); expect(parse).not.toHaveBeenCalled();
  });
  it('checks the ASCII fast length limit and byte limit before JSON syntax/envelope/versions', () => {
    const ascii = '{' + ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES);
    const multibyte = 'Я'.repeat(2_500_000) + '!';
    const future = JSON.stringify({ ...envelope(null), schemaVersion: 9 });
    const oversizedFuture = future + ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES + 1 - bytes(future));
    expect(multibyte.length).toBeLessThan(MAX_CAMPAIGN_SAVE_BYTES);
    const parse = vi.spyOn(JSON, 'parse');
    for (const input of [ascii, multibyte, oversizedFuture]) rejected(decodeCampaignSave(input), 'SAVE_TOO_LARGE');
    expect(parse).not.toHaveBeenCalled();
    rejected(decodeCampaignSave(' '.repeat(MAX_CAMPAIGN_SAVE_BYTES)), 'INVALID_SAVE');
    expect(parse).toHaveBeenCalledTimes(1);
  });
  it('encodes exactly 5MB, but rejects a runtime-valid 5MB+1 snapshot without truncation', () => {
    const state = createCampaignSession(), design = createCombatDesign('fighter');
    design.createdAt = '2026-09-09T00:00:00.0Z';
    state.production.lastOrderId = 1;
    state.ships = [{ id: 1, factionId: 'blue', systemId: 'sol', fuel: 3, design }];
    const extraDigits = MAX_CAMPAIGN_SAVE_BYTES - bytes(encoded(state));
    design.createdAt = `2026-09-09T00:00:00.${'0'.repeat(extraDigits + 1)}Z`;
    expect(designSchema.safeParse(design).success).toBe(true);
    expect(campaignSessionSchema.safeParse(state).success).toBe(true);
    const exact = encoded(state); expect(bytes(exact)).toBe(5_000_000);
    expect(decoded(exact)).toEqual(state);
    design.createdAt = design.createdAt.replace(/Z$/, '0Z');
    expect(campaignSessionSchema.safeParse(state).success).toBe(true);
    expect(bytes(documentFor(state))).toBe(5_000_001);
    freeze(state); rejected(encodeCampaignSave(state), 'SAVE_TOO_LARGE');
    expect(design.createdAt.endsWith('00Z')).toBe(true);
  });
});

// Max-capacity diagnostics remain explicitly separate from the command-earned cycles below.
function maximumDiagnostic(): CampaignSession {
  const state = diagnostic(), design = state.ships[0].design;
  state.ships = []; state.production = { lastOrderId: MAX_ORDER_ID, orders: [], completed: [] };
  state.fleets = { lastFleetId: MAX_FLEET_ID, items: [] };
  for (const [sideIndex, factionId] of sides.entries()) {
    const systemId: SystemId = factionId === 'blue' ? 'sol' : 'vega';
    for (let index = 0; index < 100; index++) {
      state.ships.push({ id: 1 + sideIndex * 100 + index, factionId, systemId, fuel: index % 4, design: structuredClone(design) });
      const record = { id: 201 + sideIndex * 100 + index, factionId, systemId, design: structuredClone(design) };
      if (index < 3) state.production.orders.push({ ...record, remainingTurns: index === 0 ? 1 : 4 });
      else state.production.completed.push(record);
    }
    for (let index = 0; index < 20; index++) {
      state.fleets.items.push({ id: 1 + sideIndex * 20 + index, factionId, systemId,
        shipIds: [2, 1, 5, 3, 4].map(offset => sideIndex * 100 + index * 5 + offset) });
    }
  }
  state.ships.reverse(); state.production.completed.reverse();
  return state;
}

describe('capacity and stalled-economy diagnostics (not earned fixtures)', () => {
  it('roundtrips all 200 ships + 200 production snapshots + 40 fleets at once', () => {
    const state = maximumDiagnostic(); freeze(state);
    const restored = roundtrip(state);
    expect(restored.ships).toHaveLength(200);
    expect(restored.production.orders.length + restored.production.completed.length).toBe(200);
    expect(restored.fleets.items).toHaveLength(40);
    for (const side of sides) {
      expect(restored.ships.filter(x => x.factionId === side)).toHaveLength(100);
      expect([...restored.production.orders, ...restored.production.completed].filter(x => x.factionId === side)).toHaveLength(100);
      expect(restored.fleets.items.filter(x => x.factionId === side)).toHaveLength(20);
    }
    expect(bytes(encoded(state))).toBeLessThan(MAX_CAMPAIGN_SAVE_BYTES);
  });
  it.each(['ships', 'production', 'fleets', 'members'] as const)('does not weaken %s limits for saving', area => {
    const state = maximumDiagnostic();
    if (area === 'ships') state.ships.push({ ...structuredClone(state.ships[0]), id: 500 });
    if (area === 'production') state.production.completed.push({ ...structuredClone(state.production.completed[0]), id: 500 });
    if (area === 'fleets') state.fleets.items.push({ ...structuredClone(state.fleets.items[0]), id: 41 });
    if (area === 'members') state.fleets.items[0].shipIds = Array.from({ length: 11 }, (_, i) => i + 1);
    rejected(encodeCampaignSave(state), 'INVALID_STATE'); rejected(decodeCampaignSave(documentFor(state)), 'INVALID_STATE');
  });
  it.each(['terminal', 'credits-cap', 'minerals-cap', 'deficit'] as const)('loads %s without moving, paying, curing or persisting a forecast', kind => {
    const state = diagnostic(); state.production.lastOrderId = MAX_ORDER_ID; state.fleets.lastFleetId = MAX_FLEET_ID;
    if (kind === 'terminal') state.turn = MAX_TURN;
    if (kind === 'credits-cap') state.treasuries.blue.credits = MAX_RESOURCE;
    if (kind === 'minerals-cap') state.treasuries.blue.minerals = MAX_RESOURCE;
    if (kind === 'deficit') {
      state.treasuries.blue.credits = 0;
      const design = state.ships[0].design;
      for (let id = 30; id < 57; id++) state.ships.push({ id, factionId: 'blue', systemId: 'sol', fuel: 0, design: structuredClone(design) });
    }
    freeze(state); const restored = roundtrip(state), side = state.turn % 2 ? 'blue' : 'red';
    const forecast = getCampaignSessionView(restored, side).economyForecast;
    expect(forecast).toEqual(getCampaignSessionView(state, side).economyForecast);
    const json = encoded(restored); expect(json).not.toMatch(/economyForecast|endTurnEconomy|paidCredits|shortfallCredits/);
    expect(executeSessionCommand(restored, endCommand(restored))).toEqual(executeSessionCommand(state, endCommand(state)));
    if (kind !== 'deficit') {
      const code = kind === 'terminal' ? 'TURN_LIMIT' : 'RESOURCE_LIMIT';
      expect(forecast).toEqual({ ok: false, code });
      expect(executeSessionCommand(restored, endCommand(restored))).toMatchObject({ ok: false, code });
      expect(restored.ships[0].transit).toBeDefined();
    } else {
      expect(forecast).toMatchObject({ ok: true, upkeep: { shipCount: 30, dueCredits: 30, paidCredits: 20, shortfallCredits: 10 } });
      const next = success(restored, endCommand(restored));
      expect(next.endTurnEconomy?.upkeep).toEqual({ shipCount: 30, dueCredits: 30, paidCredits: 20, shortfallCredits: 10 });
      expect(next.state.ships[0].transit).toBeUndefined();
      expect(next.state.production.completed.map(x => x.id)).toEqual([18, 15, 11]);
      expect(next.state.production.orders.map(x => [x.id, x.remainingTurns])).toEqual([[12, 4], [13, 2]]);
      expect(next.state.ships.find(x => x.id === 3)!.transit).toBeDefined();
    }
    expect(restored).toEqual(state);
  });
  it('recalculates the new forecast after one own arrival/FIFO completion rather than restoring the old receipt', () => {
    const state = diagnostic(), result = success(state, endCommand(state));
    const restored = roundtrip(result.state);
    expect(result.endTurnEconomy).toMatchObject({ turn: 1, treasuryAfter: { credits: 117, minerals: 60 } });
    expect(getCampaignSessionView(restored, 'blue').economyForecast).toMatchObject({ ok: true, treasuryAfter: { credits: 134, minerals: 70 } });
    expect(restored).not.toHaveProperty('endTurnEconomy'); expect(restored).not.toHaveProperty('economyForecast');
    expect(restored.production.orders.map(x => [x.id, x.remainingTurns])).toEqual([[12, 4], [13, 2]]);
    const next = success(restored, endCommand(restored));
    expect(next.state.production.orders.map(x => [x.id, x.remainingTurns])).toEqual([[12, 4], [13, 1]]);
    expect(next.state.ships.filter(x => x.transit)).toEqual([]);
  });
});

describe('command-earned preset/library continuation, both factions (no injected game state)', () => {
  it.each(['preset', 'library'] as const)('%s: pay two each, FIFO, deploy/group/send, restore before each own endTurn', source => {
    const entries = new Map<string, string>();
    const storage: StoragePort = {
      getItem: vi.fn((key: string) => entries.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { entries.set(key, value); })
    };
    const repository = new ShipDesignManager(storage);
    let saved: ShipDesign | undefined;
    if (source === 'library') saved = repository.saveDesign(createCombatDesign('fighter'));
    const choice = loadProductionCatalog(repository).choices.find(x =>
      source === 'library' ? x.source === 'Библиотека' && x.design.id === saved!.id : x.source === 'Пресет' && x.design.hullId === 'fighter')!;
    expect(choice.issue).toBe(''); expect(choice.quote).toEqual({ cost: { credits: 185, minerals: 11 }, turns: 4 });
    const design = choice.design, snapshot = structuredClone(design); freeze(design);
    let state = createCampaignSession();
    for (const side of sides) {
      const systemId = side === 'blue' ? 'eden' : 'nexus';
      for (const kind of ['explore', 'colonize'] as const) state = success(state, { kind, factionId: side, systemId, expectedTurn: state.turn }).state;
      state = end(state);
    }
    while (state.turn < 29) state = end(state);
    expect(state.treasuries).toEqual({ blue: { credits: 380, minerals: 190 }, red: { credits: 380, minerals: 190 } });
    for (const side of sides) {
      const systemId = side === 'blue' ? 'sol' : 'vega';
      for (let count = 0; count < 2; count++) state = success(state, {
        kind: 'enqueueProduction', factionId: side, systemId, expectedTurn: state.turn, design
      }).state;
      expect(state.treasuries[side]).toEqual({ credits: 10, minerals: 168 });
      state = end(state);
    }
    expect(state.production.orders.map(x => [x.id, x.remainingTurns])).toEqual([[1, 3], [2, 4], [3, 3], [4, 4]]);
    while (state.turn < 45) {
      const before = state, headIds = new Set<SystemId>();
      const side = state.turn % 2 ? 'blue' : 'red';
      state = end(state);
      for (const order of before.production.orders) {
        const progresses = order.factionId === side && !headIds.has(order.systemId);
        if (order.factionId === side) headIds.add(order.systemId);
        if (progresses && order.remainingTurns === 1) expect(state.production.completed.find(x => x.id === order.id)?.design).toEqual(snapshot);
        else expect(state.production.orders.find(x => x.id === order.id)?.remainingTurns).toBe(order.remainingTurns - Number(progresses));
      }
    }
    expect(state.production.completed.map(x => x.id)).toEqual([1, 3, 2, 4]);
    expect(state.treasuries).toEqual({ blue: { credits: 170, minerals: 248 }, red: { credits: 170, minerals: 248 } });

    // Change and then remove the real library after payment; paid snapshots must be autonomous.
    if (saved) {
      repository.saveDesign({ ...saved, name: 'Изменённый библиотечный проект' });
      expect(repository.load().designs[0].name).not.toBe(snapshot.name);
      expect(roundtrip(state)).toEqual(state);
      entries.clear(); expect(new ShipDesignManager(storage).load().designs).toEqual([]);
    }
    const storedBefore = Array.from(entries.entries());
    const reads = vi.mocked(storage.getItem).mock.calls.length, writes = vi.mocked(storage.setItem).mock.calls.length;
    let restored = roundtrip(state);
    function both(command: SessionCommand): void {
      const uninterrupted = success(state, command), resumed = success(restored, command);
      expect(resumed).toEqual(uninterrupted); // Includes complete state AND the actual endTurn receipt.
      state = uninterrupted.state; restored = resumed.state;
      expect([...restored.ships, ...restored.production.orders, ...restored.production.completed].map(x => x.design))
        .toEqual(Array(4).fill(snapshot));
      expect(design).toEqual(snapshot);
    }
    for (const side of sides) {
      const systemId = side === 'blue' ? 'sol' : 'vega', destinationId = side === 'blue' ? 'eden' : 'nexus';
      const ids = side === 'blue' ? [2, 1] : [4, 3], fleetId = side === 'blue' ? 1 : 2;
      for (const orderId of ids) both({ kind: 'deployProduction', factionId: side, systemId, orderId, expectedTurn: state.turn });
      both({ kind: 'createFleet', factionId: side, systemId, shipIds: ids, expectedTurn: state.turn });
      both({ kind: 'sendFleet', factionId: side, systemId, fleetId, destinationId, expectedTurn: state.turn });
      const before = structuredClone(restored); restored = roundtrip(restored);
      expect(restored).toEqual(before);
      expect(restored.ships.filter(x => x.factionId === side).map(x => [x.fuel, x.systemId, x.transit]))
        .toEqual(ids.map(() => [2, systemId, { destinationId, remainingTurns: 1 }]));
      const refusal = { kind: 'sendFleet', factionId: side, systemId, fleetId, destinationId, expectedTurn: state.turn };
      expect(executeSessionCommand(restored, refusal)).toEqual(executeSessionCommand(state, refusal));
      expect(executeSessionCommand(restored, refusal)).toMatchObject({ ok: false, code: 'FLEET_IN_TRANSIT' });
      const endingTurn = state.turn;
      const receipt = success(restored, endCommand(restored)).endTurnEconomy;
      expect(receipt).toMatchObject({ factionId: side, turn: endingTurn,
        upkeep: { shipCount: 2, dueCredits: 2, paidCredits: 2, shortfallCredits: 0 } });
      both(endCommand(state));
      expect(restored.ships.filter(x => x.factionId === side).every(x => x.systemId === destinationId && x.fuel === 2 && !x.transit)).toBe(true);
      const stale: SessionCommand = { kind: 'endTurn', factionId: side, expectedTurn: endingTurn };
      expect(executeSessionCommand(restored, stale)).toMatchObject({ ok: false, code: 'STALE_TURN' });
    }
    expect(restored.turn).toBe(47);
    expect(restored.ships.map(x => x.id)).toEqual([2, 1, 4, 3]);
    expect(restored.production).toEqual({ lastOrderId: 4, orders: [], completed: [] });
    expect(restored.fleets.items.map(x => [x.id, x.systemId, x.shipIds])).toEqual([[1, 'eden', [2, 1]], [2, 'nexus', [4, 3]]]);
    expect(restored.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(Array.from(entries.entries())).toEqual(storedBefore);
    expect(storage.getItem).toHaveBeenCalledTimes(reads); expect(storage.setItem).toHaveBeenCalledTimes(writes);
    expect(design).toEqual(snapshot);
  });
});

describe('pure codec environment boundary', () => {
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite runtime numbers %s without serialization', value => {
    const state = createCampaignSession(); state.treasuries.blue.credits = value;
    const stringify = vi.spyOn(JSON, 'stringify');
    rejected(encodeCampaignSave(state), 'INVALID_STATE'); expect(stringify).not.toHaveBeenCalled();
    expect(state.treasuries.blue.credits).toBe(value);
  });
  it.each(['1e400', '-1e400'])('rejects overflowing session JSON number %s', value => {
    const text = documentFor(createCampaignSession()).replace('"credits":100', `"credits":${value}`);
    rejected(decodeCampaignSave(text), 'INVALID_STATE');
  });
  it('contains unexpected refinement exceptions without exposing a partial state or raw error', () => {
    const state = createCampaignSession(), text = documentFor(state), before = structuredClone(state);
    // Fault injection covers the exception boundary only; real validation is exercised above.
    vi.spyOn(campaignSessionSchema, 'safeParse').mockImplementation(() => { throw new Error('SECRET_PAYLOAD'); });
    rejected(encodeCampaignSave(state), 'INVALID_STATE'); rejected(decodeCampaignSave(text), 'INVALID_STATE');
    expect(state).toEqual(before);
  });
  it('contains serializer exceptions without exposing the input or claiming success', () => {
    const state = createCampaignSession(), before = structuredClone(state);
    vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('SECRET_PAYLOAD'); });
    rejected(encodeCampaignSave(state), 'INVALID_STATE'); expect(state).toEqual(before);
  });
  it('never reads clocks/storage/catalog/Phaser or invokes commands, even for full moving snapshots', () => {
    const state = diagnostic(), text = documentFor(state), before = structuredClone(state);
    // Prepare all factories and snapshots BEFORE observing/blocking environment dependencies.
    const clock = vi.spyOn(Date, 'now');
    const iso = vi.spyOn(Date.prototype, 'toISOString');
    const date = vi.spyOn(globalThis, 'Date');
    const random = vi.spyOn(Math, 'random');
    const load = vi.spyOn(ShipDesignManager.prototype, 'load');
    const save = vi.spyOn(ShipDesignManager.prototype, 'saveDesign');
    const libraryDecode = vi.spyOn(ShipDesignManager.prototype, 'decode');
    const command = vi.spyOn(sessionDomain, 'executeSessionCommand');
    const catalog = vi.spyOn(productionCatalog, 'loadProductionCatalog');
    const access = vi.fn(() => { throw new Error('Codec accessed an environment dependency'); });
    const forbidden = new Proxy({}, { get: access });
    vi.stubGlobal('localStorage', forbidden); vi.stubGlobal('sessionStorage', forbidden);
    vi.stubGlobal('Phaser', forbidden); vi.stubGlobal('window', forbidden); vi.stubGlobal('document', forbidden);
    const json = encoded(state); expect(decoded(text)).toEqual(before); expect(decoded(json)).toEqual(before);
    expect(state).toEqual(before);
    for (const spy of [clock, iso, date, random, load, save, libraryDecode, command, catalog, access]) expect(spy).not.toHaveBeenCalled();
  });
});