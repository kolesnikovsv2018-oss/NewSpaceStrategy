import { describe, expect, it } from 'vitest';
import { createCombatDesign } from '../src/domain/combatPresets';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { campaignFleetsSchema, createCampaignFleets, isShipInFleet, MAX_CAMPAIGN_FLEETS,
  MAX_FLEET_ID, MAX_FLEET_SHIPS } from '../src/domain/campaignFleets';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, sessionCommandSchema, type CampaignSession, type SessionCommand, type SessionErrorCode } from '../src/domain/campaignSession';
import { MAX_ORDER_ID } from '../src/domain/production';

const create = { kind: 'createFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipIds: [2, 1] } as const;
// Mutable array type accepted by the public command API; frozen inputs are tested at runtime.
function createCommand(): SessionCommand { return { ...create, shipIds: [...create.shipIds] }; }
const disband = { kind: 'disbandFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1 } as const;
const send = { kind: 'sendShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1, destinationId: 'eden' } as const;
const refuel = { kind: 'refuelShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1 } as const;
function fixture(): CampaignSession {
  const state = createCampaignSession();
  for (const [id, faction] of [['eden', 'blue'], ['nexus', 'red']] as const) {
    const system = state.galaxy.systems.find(s => s.id === id)!;
    system.ownerId = faction; system.exploredBy = [faction];
  }
  state.production.lastOrderId = 6;
  state.ships = Array.from({ length: 6 }, (_, i) => ({ id: i + 1,
    factionId: i < 4 ? 'blue' : 'red', systemId: i < 4 ? 'sol' : 'vega', fuel: i % 4,
    design: i % 2 ? createCivilianDesign('freighter') : createCombatDesign('fighter') }));
  return state;
}
function freeze(value: object) {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); }); Object.freeze(value);
}
function apply(state: CampaignSession, command: SessionCommand): CampaignSession {
  const before = structuredClone(state), payload = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(state).toEqual(before); expect(command).toEqual(payload);
  if (!result.ok) throw Error(result.code);
  expect(campaignSessionSchema.safeParse(result.state).success).toBe(true);
  return result.state;
}
function reject(state: unknown, command: unknown, code: SessionErrorCode) {
  const before = structuredClone(state), payload = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(result).toMatchObject({ ok: false, code }); expect(result).not.toHaveProperty('state');
  expect(state).toEqual(before); expect(command).toEqual(payload);
}
function end(state: CampaignSession): CampaignSession {
  return apply(state, { kind: 'endTurn', factionId: state.turn % 2 ? 'blue' : 'red', expectedTurn: state.turn });
}
function grouped(): CampaignSession { return apply(fixture(), createCommand()); }

describe('stationary strategic fleet membership', () => {
  it('starts with independent explicit empty membership and a separate counter', () => {
    const a = createCampaignSession(), b = createCampaignSession();
    expect(a.fleets).toEqual({ lastFleetId: 0, items: [] });
    expect(createCampaignFleets()).toEqual(a.fleets);
    a.fleets.items.push({ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] });
    expect(b.fleets.items).toEqual([]); expect(createCampaignFleets().items).toEqual([]);
    expect(MAX_FLEET_SHIPS).toBe(10); expect(MAX_CAMPAIGN_FLEETS).toBe(20);
  });
  it('creates only membership, preserving input order, ships, snapshots, fuel, economy and turn', () => {
    const state = fixture(), command = createCommand(); freeze(state); freeze(command);
    const next = apply(state, command);
    expect(next).toEqual({ ...state, fleets: { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [2, 1] }] } });
    expect(isShipInFleet(next.fleets.items, 1)).toBe(true); expect(isShipInFleet(next.fleets.items, 3)).toBe(false);
    expect(next.ships[0]).not.toHaveProperty('fleetId');
    next.fleets.items[0].shipIds.reverse(); next.ships[0].design.name = 'Changed';
    expect(state.ships[0].design.name).not.toBe('Changed'); expect(command).toEqual(create);
  });
  it('disbands membership only, retains the ID counter and never reuses IDs', () => {
    const state = grouped(); freeze(state);
    const next = apply(state, disband);
    expect(next).toEqual({ ...state, fleets: { lastFleetId: 1, items: [] } });
    reject(next, disband, 'FLEET_NOT_FOUND');
    const recreated = apply(next, createCommand()); expect(recreated.fleets.items[0].id).toBe(2);
    expect(recreated.production.lastOrderId).toBe(6);
  });
  it('rejects an overlapping/repeated create atomically, without assigning free members or IDs', () => {
    const state = grouped(); freeze(state);
    reject(state, create, 'SHIP_IN_FLEET'); reject(state, { ...create, shipIds: [3, 4, 1] }, 'SHIP_IN_FLEET');
    const next = apply(state, { ...create, shipIds: [3, 4] });
    expect(next.fleets.items.map(f => f.id)).toEqual([1, 2]);
  });
  it('allows individual refuel but blocks individual send until explicit disband', () => {
    const state = grouped(); reject(state, send, 'SHIP_IN_FLEET');
    const full = apply(state, refuel); expect(full.fleets).toEqual(state.fleets);
    expect(full.ships[0].fuel).toBe(3); expect(full.ships[1]).toEqual(state.ships[1]);
    expect(full.treasuries.blue).toEqual({ credits: 85, minerals: 44 });
    reject(full, send, 'SHIP_IN_FLEET');
    const free = apply(full, disband), travelling = apply(free, send);
    expect(travelling.ships[0].fuel).toBe(2); expect(travelling.ships[0].transit).toBeDefined();
    expect(travelling.fleets).toEqual({ lastFleetId: 1, items: [] });
    expect(end(travelling).ships[0].systemId).toBe('eden');
  });
  it('permits unrelated ships to depart and leaves groups unchanged over both sides turns', () => {
    const state = grouped(); const next = apply(state, { ...send, shipId: 3 });
    expect(next.ships[2].fuel).toBe(1); expect(end(end(next)).fleets).toEqual(state.fleets);
    expect(end(next).ships.slice(0, 2)).toEqual(state.ships.slice(0, 2));
  });
  it('does not bypass refuel affordability or full-tank checks for members', () => {
    const state = grouped(); state.treasuries.blue.credits = 0;
    reject(state, refuel, 'INSUFFICIENT_RESOURCES'); state.ships[0].fuel = 3;
    reject(state, refuel, 'FUEL_FULL');
  });
  it('supports both sides, reverse member order and independent own views', () => {
    const state = end(grouped());
    const next = apply(state, { ...create, factionId: 'red', expectedTurn: 2, systemId: 'vega', shipIds: [6, 5] });
    expect(next.fleets.items[1]).toEqual({ id: 2, factionId: 'red', systemId: 'vega', shipIds: [6, 5] });
    expect(getCampaignSessionView(next, 'blue').fleets.map(f => f.id)).toEqual([1]);
    expect(getCampaignSessionView(next, 'red').fleets.map(f => f.id)).toEqual([2]);
    const redFree = apply(next, { ...disband, factionId: 'red', expectedTurn: 2, systemId: 'vega', fleetId: 2 });
    expect(redFree.fleets.items).toEqual([next.fleets.items[0]]);
    expect(redFree.ships).toEqual(next.ships);
  });
  it('requires exact own colony for every member and disband target', () => {
    const state = fixture(); state.ships[1].systemId = 'eden';
    reject(state, create, 'SHIP_NOT_FOUND');
    state.ships[0].systemId = 'eden';
    const next = apply(state, { ...create, systemId: 'eden', shipIds: [1, 2] });
    reject(next, disband, 'FLEET_NOT_FOUND');
    expect(apply(next, { ...disband, systemId: 'eden' }).fleets.items).toEqual([]);
  });
  it.each(['rift', 'nexus', 'dust'] as const)('checks own colony %s before member/group lookup', systemId => {
    reject(fixture(), { ...create, systemId }, 'NOT_OWN_COLONY');
    reject(grouped(), { ...disband, systemId, fleetId: 999 }, 'NOT_OWN_COLONY');
  });
  it.each([5, 7, 999])('refuses enemy/completed/missing member %s with no partial membership', shipId => {
    const state = fixture(); state.production.lastOrderId = 7;
    state.production.completed.push({ id: 7, factionId: 'blue', systemId: 'sol', design: state.ships[0].design });
    reject(state, { ...create, shipIds: [1, shipId] }, 'SHIP_NOT_FOUND');
    expect(state.fleets.lastFleetId).toBe(0);
  });
  it('refuses travelling members even though their origin matches the colony', () => {
    const state = fixture(); state.ships[1].transit = { destinationId: 'eden', remainingTurns: 1 };
    reject(state, create, 'SHIP_IN_TRANSIT');
  });
  it.each(['createFleet', 'disbandFleet'] as const)('guards stale before inactive for %s', kind => {
    const state = grouped(); state.turn = 2;
    const command = kind === 'createFleet' ? create : disband;
    reject(state, command, 'STALE_TURN'); reject(state, { ...command, expectedTurn: 2 }, 'NOT_ACTIVE_FACTION');
  });
  it('refuses foreign groups without exposing membership', () => {
    const state = end(grouped());
    reject(state, { ...disband, factionId: 'red', expectedTurn: 2, systemId: 'vega' }, 'FLEET_NOT_FOUND');
    reject(state, { ...disband, factionId: 'red', expectedTurn: 2, systemId: 'vega', fleetId: 999 }, 'FLEET_NOT_FOUND');
  });
  it('does not expose enemy grouping, counters or mutable member arrays after discovery', () => {
    const state = end(grouped()); state.galaxy.systems.find(s => s.id === 'vega')!.exploredBy.push('blue');
    const before = getCampaignSessionView(state, 'blue'); freeze(state);
    const next = apply(state, { ...create, factionId: 'red', expectedTurn: 2, systemId: 'vega', shipIds: [5, 6] });
    expect(getCampaignSessionView(next, 'blue')).toEqual(before);
    const view = getCampaignSessionView(next, 'blue');
    expect(view).not.toHaveProperty('lastFleetId'); expect(view.fleets).toHaveLength(1);
    view.fleets[0].shipIds.pop(); view.fleets[0].systemId = 'eden'; view.fleets.pop();
    expect(getCampaignSessionView(next, 'blue')).toEqual(before);
  });
  it('replays create/refuel/disband/send identically on frozen state and commands', () => {
    const initial = fixture(); freeze(initial);
    const commands: SessionCommand[] = [createCommand(), refuel, disband, send]; freeze(commands);
    const run = () => commands.reduce(apply, initial); expect(run()).toEqual(run());
    const next = run(); reject(next, disband, 'FLEET_NOT_FOUND');
    reject(end(next), create, 'STALE_TURN');
  });
  it('accepts exactly ten members without requiring resources or changing the ship cap', () => {
    const state = fixture(); state.production.lastOrderId = 100;
    state.ships = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(state.ships[0]), id: i + 1 }));
    state.treasuries.blue = { credits: 0, minerals: 0 };
    const next = apply(state, { ...create, shipIds: state.ships.slice(0, 10).map(s => s.id) });
    expect(next.fleets.items[0].shipIds).toHaveLength(10); expect(next.ships).toEqual(state.ships);
  });
  it('limits each side to twenty groups, releases the slot on disband, retains other-side capacity', () => {
    let state = fixture(); state.production.lastOrderId = 86;
    state.ships = Array.from({ length: 86 }, (_, i) => ({ ...structuredClone(state.ships[i < 44 ? 0 : 4]), id: i + 1 }));
    for (let i = 0; i < 20; i++) state = apply(state, { ...create, shipIds: [i * 2 + 1, i * 2 + 2] });
    reject(state, { ...create, shipIds: [41, 42] }, 'FLEET_LIMIT');
    state = end(state);
    for (let i = 0; i < 20; i++) state = apply(state, { ...create, factionId: 'red', expectedTurn: 2, systemId: 'vega', shipIds: [45 + i * 2, 46 + i * 2] });
    expect(state.fleets.items).toHaveLength(40);
    reject(state, { ...create, factionId: 'red', expectedTurn: 2, systemId: 'vega', shipIds: [85, 86] }, 'FLEET_LIMIT');
    state = end(state); state = apply(state, { ...disband, expectedTurn: 3 });
    state = apply(state, { ...create, expectedTurn: 3, shipIds: [41, 42] });
    expect(state.fleets.lastFleetId).toBe(41); expect(state.fleets.items).toHaveLength(40);
  });
  it('separates fleet IDs from production IDs and permits disband on final counters/turn', () => {
    const state = fixture(); state.turn = MAX_TURN; state.production.lastOrderId = MAX_ORDER_ID;
    state.fleets.lastFleetId = MAX_FLEET_ID - 1;
    const next = apply(state, { ...create, factionId: 'red', systemId: 'vega', expectedTurn: MAX_TURN, shipIds: [5, 6] });
    expect(next.fleets.items[0].id).toBe(MAX_FLEET_ID); expect(next.production).toEqual(state.production);
    const free = apply(next, { ...disband, factionId: 'red', systemId: 'vega', expectedTurn: MAX_TURN, fleetId: MAX_FLEET_ID });
    reject(free, { ...create, factionId: 'red', systemId: 'vega', expectedTurn: MAX_TURN, shipIds: [5, 6] }, 'FLEET_ID_LIMIT');
    reject(free, { kind: 'endTurn', factionId: 'red', expectedTurn: MAX_TURN }, 'TURN_LIMIT');
  });
  it('allows free group commands when income is capped and does not advance pending production', () => {
    const state = fixture(); state.treasuries.blue = { credits: MAX_RESOURCE, minerals: MAX_RESOURCE };
    state.production.lastOrderId = 7;
    state.production.orders.push({ id: 7, factionId: 'blue', systemId: 'sol', design: state.ships[0].design, remainingTurns: 1 });
    const next = apply(state, createCommand()); expect(next.production).toEqual(state.production);
    reject(next, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }, 'RESOURCE_LIMIT');
    expect(apply(next, disband).ships).toEqual(state.ships);
  });
  it('supports paid production, deployment, grouping, refill and disband without altering paid designs', () => {
    let state = createCampaignSession(); state.treasuries.blue = { credits: 1000, minerals: 1000 };
    const design = createCombatDesign('fighter');
    for (let i = 0; i < 2; i++) state = apply(state, { kind: 'enqueueProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', design });
    // FIFO: two four-own-turn fighters, eight rounds, no preloaded ships/completed.
    for (let i = 0; i < 16; i++) state = end(state);
    for (const orderId of [1, 2]) state = apply(state, { kind: 'deployProduction', factionId: 'blue', expectedTurn: 17, systemId: 'sol', orderId });
    const before = structuredClone(state);
    state = apply(state, { ...create, expectedTurn: 17, shipIds: [1, 2] });
    reject(state, { ...refuel, expectedTurn: 17 }, 'FUEL_FULL');
    state = apply(state, { ...disband, expectedTurn: 17 });
    expect(state.ships).toEqual(before.ships); expect(state.production).toEqual(before.production);
    expect(state.ships.every(ship => JSON.stringify(ship.design) === JSON.stringify(design))).toBe(true);
    expect(state.treasuries).toEqual(before.treasuries);
  });
});

describe('strict fleet state and commands', () => {
  it.each([undefined, null, {}, [], { lastFleetId: 0 }, { items: [] }, { lastFleetId: 0, items: [], cost: 0 }])('rejects missing/malformed fleet state %# without repair', fleets => {
    const state = { ...fixture(), fleets };
    reject(state, create, 'INVALID_STATE'); expect(campaignFleetsSchema.safeParse(fleets).success).toBe(false);
    expect(() => getCampaignSessionView(state as CampaignSession, 'blue')).toThrow();
  });
  it('explicitly rejects previous sessions without fleets instead of silently resetting membership', () => {
    const { fleets: _fleets, ...old } = fixture(); reject(old, create, 'INVALID_STATE');
    expect(old).not.toHaveProperty('fleets');
  });
  it.each([[], [1], [1, 1], [1, 2, 1], Array.from({ length: 11 }, (_, i) => i + 1), null, '1,2',
    [0, 1], [-1, 2], [1.5, 2], ['1', 2], [NaN, 2], [Infinity, 2], [MAX_ORDER_ID + 1, 2]])('rejects malformed membership %# in commands and state', shipIds => {
    reject(fixture(), { ...create, shipIds }, 'INVALID_COMMAND');
    const state = grouped(); Object.assign(state.fleets.items[0], { shipIds });
    reject(state, disband, 'INVALID_STATE');
  });
  it.each([0, -1, 0.5, '1', null, undefined, NaN, Infinity, MAX_FLEET_ID + 1])('rejects invalid fleet ID %s', fleetId => {
    reject(grouped(), { ...disband, fleetId }, 'INVALID_COMMAND');
    const state = grouped(); Object.assign(state.fleets.items[0], { id: fleetId });
    reject(state, disband, 'INVALID_STATE');
  });
  it.each([-1, 0.5, '1', null, undefined, NaN, Infinity, MAX_FLEET_ID + 1])('rejects invalid fleet counter %s', lastFleetId => {
    const state = fixture(); Object.assign(state.fleets, { lastFleetId }); reject(state, create, 'INVALID_STATE');
  });
  it.each([{ fleetId: 1 }, { cost: 0 }, { fuel: 3 }, { destinationId: 'eden' }, { name: 'Fleet' }, { ships: [] },
    { expectedTurn: undefined }, { systemId: undefined }, { factionId: 'neutral' }])('rejects forged create payload %#', extra => {
    const command = { ...create, ...extra }; expect(sessionCommandSchema.safeParse(command).success).toBe(false);
    reject(fixture(), command, 'INVALID_COMMAND');
  });
  it.each([{ shipIds: [1, 2] }, { refund: 5 }, { expectedTurn: undefined }, { systemId: undefined }, { factionId: 'neutral' }])('rejects forged disband payload %#', extra => {
    reject(grouped(), { ...disband, ...extra }, 'INVALID_COMMAND');
  });
  it.each([
    (s: CampaignSession) => { s.fleets.lastFleetId = 0; },
    (s: CampaignSession) => { s.fleets.items.push(structuredClone(s.fleets.items[0])); },
    (s: CampaignSession) => { s.fleets.lastFleetId = 2; s.fleets.items.push({ ...s.fleets.items[0], id: 2, shipIds: [2, 3] }); },
    (s: CampaignSession) => { s.fleets.items[0].shipIds = [1, 99]; },
    (s: CampaignSession) => { s.fleets.items[0].shipIds = [1, 5]; },
    (s: CampaignSession) => { s.ships[0].systemId = 'eden'; },
    (s: CampaignSession) => { s.ships[0].transit = { destinationId: 'eden', remainingTurns: 1 }; },
    (s: CampaignSession) => { s.fleets.items[0].systemId = 'eden'; },
    (s: CampaignSession) => { s.fleets.items[0].systemId = 'vega'; },
    (s: CampaignSession) => { s.fleets.items[0].factionId = 'red'; },
    (s: CampaignSession) => { Object.assign(s.fleets.items[0], { fuel: 3 }); },
    (s: CampaignSession) => { Object.assign(s.ships[0], { fleetId: 1 }); },
    (s: CampaignSession) => { s.production.completed.push({ id: 7, factionId: 'blue', systemId: 'sol', design: s.ships[0].design }); s.production.lastOrderId = 7; s.fleets.items[0].shipIds = [1, 7]; },
    (s: CampaignSession) => { s.fleets.lastFleetId = 2; s.fleets.items.unshift({ ...s.fleets.items[0], id: 2, shipIds: [3, 4] }); }
  ])('rejects inconsistent membership %# before executing any command', mutate => {
    const state = grouped(); mutate(state); reject(state, disband, 'INVALID_STATE');
    expect(() => getCampaignSessionView(state, 'blue')).toThrow();
  });
  it('rejects twenty-one groups of one side even with unique valid members', () => {
    const state = fixture(); state.production.lastOrderId = 42;
    state.ships = Array.from({ length: 42 }, (_, i) => ({ ...structuredClone(state.ships[0]), id: i + 1 }));
    state.fleets = { lastFleetId: 21, items: Array.from({ length: 21 }, (_, i) => ({ id: i + 1,
      factionId: 'blue', systemId: 'sol', shipIds: [i * 2 + 1, i * 2 + 2] })) };
    expect(campaignFleetsSchema.safeParse(state.fleets).success).toBe(false); reject(state, disband, 'INVALID_STATE');
  });
});
