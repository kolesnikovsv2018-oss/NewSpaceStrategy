import { describe, expect, it } from 'vitest';
import { createCombatDesign } from '../src/domain/combatPresets';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { getFleetTransit, isFleetAtColony, MAX_FLEET_ID } from '../src/domain/campaignFleets';
import { isShipAtColony } from '../src/domain/campaignShips';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, sessionCommandSchema, type CampaignSession, type SessionCommand, type SessionErrorCode } from '../src/domain/campaignSession';
import { MAX_ORDER_ID } from '../src/domain/production';

const send = { kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden' } as const;
const disband = { kind: 'disbandFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1 } as const;
function fixture(): CampaignSession {
  const state = createCampaignSession();
  for (const [id, side] of [['eden', 'blue'], ['nexus', 'red']] as const) {
    const system = state.galaxy.systems.find(s => s.id === id)!; system.ownerId = side; system.exploredBy = [side];
  }
  state.production.lastOrderId = 10;
  state.ships = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, factionId: i < 6 ? 'blue' : 'red',
    systemId: i < 4 ? 'sol' : i < 6 ? 'eden' : 'vega', fuel: i % 3 + 1,
    design: i % 2 ? createCivilianDesign('freighter') : createCombatDesign('fighter') }));
  state.fleets = { lastFleetId: 4, items: [
    { id: 1, factionId: 'blue', systemId: 'sol', shipIds: [2, 1] },
    { id: 2, factionId: 'blue', systemId: 'sol', shipIds: [3, 4] },
    { id: 3, factionId: 'blue', systemId: 'eden', shipIds: [5, 6] },
    { id: 4, factionId: 'red', systemId: 'vega', shipIds: [7, 8] }
  ] };
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
  expect(campaignSessionSchema.safeParse(result.state).success).toBe(true); return result.state;
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

describe('atomic one-own-turn group travel', () => {
  it('debits each member exactly once, retaining membership/order/IDs/designs/turn and treasuries', () => {
    const state = fixture(); freeze(state); freeze(send);
    const next = apply(state, send);
    expect(next).toEqual({ ...state, ships: state.ships.map(ship => ship.id <= 2
      ? { ...ship, fuel: ship.fuel - 1, transit: { destinationId: 'eden', remainingTurns: 1 } } : ship) });
    expect(next.ships[0].fuel).toBe(0);
    expect(next.fleets.items[0]).not.toHaveProperty('transit'); expect(next.fleets.items[0].shipIds).toEqual([2, 1]);
    expect(next.ships[0].transit).not.toBe(next.ships[1].transit);
    next.ships[0].transit!.destinationId = 'sol'; next.ships[1].design.name = 'Changed';
    expect(state.ships[0].transit).toBeUndefined(); expect(state.ships[1].design.name).not.toBe('Changed');
  });
  it('derives a detached route and excludes the group and its members from both endpoint colonies', () => {
    const stationary = fixture(), fleet = stationary.fleets.items[0];
    expect(getFleetTransit(fleet, stationary.ships)).toBeUndefined(); expect(isFleetAtColony(fleet, stationary.ships, 'sol')).toBe(true);
    const moving = apply(stationary, send), group = moving.fleets.items[0];
    const transit = getFleetTransit(group, moving.ships)!;
    expect(transit).toEqual({ destinationId: 'eden', remainingTurns: 1 }); transit.destinationId = 'vega';
    expect(getFleetTransit(group, moving.ships)!.destinationId).toBe('eden');
    for (const system of ['sol', 'eden'] as const) {
      expect(isFleetAtColony(group, moving.ships, system)).toBe(false);
      expect(moving.ships.slice(0, 2).some(ship => isShipAtColony(ship, system))).toBe(false);
    }
    const arrived = end(moving);
    expect(isFleetAtColony(arrived.fleets.items[0], arrived.ships, 'eden')).toBe(true);
    expect(isFleetAtColony(arrived.fleets.items[0], arrived.ships, 'sol')).toBe(false);
    expect(getFleetTransit(arrived.fleets.items[0], arrived.ships)).toBeUndefined();
  });
  it('arrives the whole group on the first own endTurn, without extra fuel or automatic refill', () => {
    const moving = apply(fixture(), send); freeze(moving);
    const next = end(moving);
    expect(next.fleets.items[0]).toEqual({ ...moving.fleets.items[0], systemId: 'eden' });
    expect(next.ships.slice(0, 2)).toEqual(moving.ships.slice(0, 2).map(({ transit: _transit, ...ship }) => ({ ...ship, systemId: 'eden' })));
    expect(next.ships.slice(2)).toEqual(moving.ships.slice(2)); expect(next.fleets.items.slice(1)).toEqual(moving.fleets.items.slice(1));
    expect(next.treasuries.blue).toEqual({ credits: 120, minerals: 60 }); expect(next.turn).toBe(2);
    expect(end(next).ships).toEqual(next.ships); expect(end(next).fleets).toEqual(next.fleets);
    reject(next, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }, 'STALE_TURN');
  });
  it('does not advance a group or its members on the other side endTurn', () => {
    const moving = apply(fixture(), send); moving.turn = 2;
    const next = end(moving); expect(next.ships).toEqual(moving.ships); expect(next.fleets).toEqual(moving.fleets);
    expect(end(next).fleets.items[0].systemId).toBe('eden');
  });
  it('handles multiple opposite own routes, stationary groups, enemy groups and a free ship atomically', () => {
    let state = fixture(); state.turn = 2;
    state = apply(state, { ...send, factionId: 'red', expectedTurn: 2, systemId: 'vega', fleetId: 4, destinationId: 'nexus' });
    state = apply(state, { kind: 'sendShip', factionId: 'red', expectedTurn: 2, systemId: 'vega', shipId: 9, destinationId: 'nexus' });
    state.turn = 3; // Valid pending opposing trips fixture; no claim about gameplay history.
    state = apply(state, { ...send, expectedTurn: 3 });
    state = apply(state, { ...send, expectedTurn: 3, systemId: 'eden', destinationId: 'sol', fleetId: 3 });
    const next = end(state);
    expect(next.fleets.items.map(f => f.systemId)).toEqual(['eden', 'sol', 'sol', 'vega']);
    expect(next.ships.slice(6)).toEqual(state.ships.slice(6));
    expect(next.ships.slice(2, 4)).toEqual(state.ships.slice(2, 4));
    const red = end(next);
    expect(red.fleets.items[3].systemId).toBe('nexus'); expect(red.ships.slice(6, 9).map(s => s.systemId)).toEqual(['nexus', 'nexus', 'nexus']);
    expect(red.ships[9].systemId).toBe('vega');
  });
  it.each([0, 1])('refuses the entire group when member index %i is empty, no partial debit/transit', index => {
    const state = fixture(); state.ships[index].fuel = 0; freeze(state); reject(state, send, 'INSUFFICIENT_FUEL');
  });
  it('allows stationary member refuel then send, but not single send, in-flight refuel or create', () => {
    let state = fixture(); state.ships[1].fuel = 0;
    reject(state, send, 'INSUFFICIENT_FUEL');
    state = apply(state, { kind: 'refuelShip', factionId: 'blue', systemId: 'sol', expectedTurn: 1, shipId: 2 });
    reject(state, { kind: 'sendShip', factionId: 'blue', systemId: 'sol', expectedTurn: 1, shipId: 2, destinationId: 'eden' }, 'SHIP_IN_FLEET');
    state = apply(state, send); expect(state.ships[1].fuel).toBe(2);
    for (const shipId of [1, 2]) {
      reject(state, { kind: 'refuelShip', factionId: 'blue', systemId: 'sol', expectedTurn: 1, shipId }, 'SHIP_IN_TRANSIT');
      reject(state, { kind: 'sendShip', factionId: 'blue', systemId: 'sol', expectedTurn: 1, shipId, destinationId: 'eden' }, 'SHIP_IN_TRANSIT');
    }
    reject(state, { kind: 'createFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipIds: [1, 2] }, 'SHIP_IN_TRANSIT');
  });
  it('blocks repeated send/reroute/disband in transit before destination checks', () => {
    const state = apply(fixture(), send);
    reject(state, send, 'FLEET_IN_TRANSIT'); reject(state, { ...send, destinationId: 'vega' }, 'FLEET_IN_TRANSIT');
    reject(state, disband, 'FLEET_IN_TRANSIT');
    reject(state, { ...send, systemId: 'eden', destinationId: 'sol' }, 'FLEET_NOT_FOUND');
    reject(state, { ...disband, systemId: 'eden' }, 'FLEET_NOT_FOUND');
  });
  it('supports a return from the new source after refuel and preserves membership until disband', () => {
    let state = end(end(apply(fixture(), send)));
    reject(state, { ...send, expectedTurn: 3 }, 'FLEET_NOT_FOUND');
    reject(state, { ...send, expectedTurn: 3, systemId: 'eden', destinationId: 'sol' }, 'INSUFFICIENT_FUEL');
    state = apply(state, { kind: 'refuelShip', factionId: 'blue', expectedTurn: 3, systemId: 'eden', shipId: 1 });
    state = apply(state, { ...send, expectedTurn: 3, systemId: 'eden', destinationId: 'sol' });
    state = end(end(state));
    const before = structuredClone(state); state = apply(state, { ...disband, expectedTurn: 5 });
    expect(state.fleets.lastFleetId).toBe(4); expect(state.ships).toEqual(before.ships);
    expect(state.fleets.items.map(f => f.id)).toEqual([2, 3, 4]);
  });
  it('checks stale before inactive and guards disband after arrival by the active side', () => {
    const state = end(apply(fixture(), send));
    reject(state, send, 'STALE_TURN'); reject(state, { ...send, expectedTurn: 2 }, 'NOT_ACTIVE_FACTION');
    reject(state, { ...disband, expectedTurn: 2, systemId: 'eden' }, 'NOT_ACTIVE_FACTION');
  });
  it.each(['rift', 'dust', 'vega'] as const)('refuses non-own source %s before lookup', systemId => {
    reject(fixture(), { ...send, systemId, fleetId: 999 }, 'NOT_OWN_COLONY');
  });
  it.each(['rift', 'dust', 'vega', 'nexus'] as const)('refuses non-own destination %s without fuel debit', destinationId => {
    reject(fixture(), { ...send, destinationId }, 'NOT_OWN_COLONY');
  });
  it('refuses a neutral destination, even when explored, before fuel checks', () => {
    const state = fixture(); state.galaxy.systems.find(s => s.id === 'eden')!.ownerId = null;
    state.ships = state.ships.filter(s => s.systemId !== 'eden'); state.fleets.items = state.fleets.items.filter(f => f.id !== 3);
    state.ships[0].fuel = 0; reject(state, send, 'NOT_OWN_COLONY');
  });
  it.each(['sol', 'nexus'] as const)('refuses same/nonadjacent own destination %s before fuel', destinationId => {
    const state = fixture(), nexus = state.galaxy.systems.find(s => s.id === 'nexus')!;
    nexus.ownerId = 'blue'; nexus.exploredBy = ['blue']; state.ships[0].fuel = 0;
    reject(state, { ...send, destinationId }, 'INVALID_ROUTE');
  });
  it.each([3, 4, 5, 999])('refuses group in another colony, foreign or missing ID %i identically', fleetId => {
    reject(fixture(), { ...send, fleetId }, 'FLEET_NOT_FOUND');
  });
  it.each(['credits', 'minerals'] as const)('keeps all arrivals, fuel and production pending on %s overflow', resource => {
    const state = apply(fixture(), send); state.treasuries.blue[resource] = MAX_RESOURCE;
    state.production.lastOrderId = 11;
    state.production.orders.push({ id: 11, factionId: 'blue', systemId: 'sol', design: state.ships[0].design, remainingTurns: 1 });
    reject(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }, 'RESOURCE_LIMIT');
    expect(state.ships[0].fuel).toBe(0); expect(getFleetTransit(state.fleets.items[0], state.ships)).toBeDefined();
  });
  it('allows exact income caps and completes production and grouped/free arrivals once', () => {
    const state = apply(fixture(), send); state.treasuries.blue = { credits: MAX_RESOURCE - 20, minerals: MAX_RESOURCE - 10 };
    state.production.lastOrderId = 12;
    state.production.orders.push({ id: 11, factionId: 'blue', systemId: 'sol', design: state.ships[0].design, remainingTurns: 1 });
    state.ships.push({ ...structuredClone(state.ships[0]), id: 12 });
    const next = end(state); expect(next.treasuries.blue).toEqual({ credits: MAX_RESOURCE, minerals: MAX_RESOURCE });
    expect(next.production.completed[0].id).toBe(11); expect(next.production.orders).toEqual([]);
    expect(next.fleets.items[0].systemId).toBe('eden'); expect(next.ships[next.ships.length - 1].systemId).toBe('eden');
    expect(end(next).ships).toEqual(next.ships);
  });
  it('permits departure at terminal turn and exhausted counters, but blocks arrival at MAX_TURN', () => {
    const state = fixture(); state.turn = MAX_TURN; state.fleets.lastFleetId = MAX_FLEET_ID; state.production.lastOrderId = MAX_ORDER_ID;
    const next = apply(state, { ...send, factionId: 'red', systemId: 'vega', fleetId: 4, destinationId: 'nexus', expectedTurn: MAX_TURN });
    reject(next, { kind: 'endTurn', factionId: 'red', expectedTurn: MAX_TURN }, 'TURN_LIMIT');
    expect(next.fleets.items[3].systemId).toBe('vega'); expect(next.ships[6].fuel).toBe(0);
  });
  it('supports ten-member travel at the ship and group limits without freeing capacity', () => {
    const state = fixture(), design = state.ships[0].design;
    state.production.lastOrderId = 101;
    state.ships = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, factionId: 'blue', systemId: 'sol', fuel: 1, design: structuredClone(design) }));
    state.fleets = { lastFleetId: 20, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: Array.from({ length: 10 }, (_, i) => i + 1) },
      ...Array.from({ length: 19 }, (_, i) => ({ id: i + 2, factionId: 'blue' as const, systemId: 'sol' as const, shipIds: [11 + i * 2, 12 + i * 2] }))] };
    state.production.completed.push({ id: 101, factionId: 'blue', systemId: 'sol', design });
    state.treasuries.blue = { credits: 0, minerals: 0 };
    const next = apply(state, send); expect(next.ships.filter(s => s.transit)).toHaveLength(10);
    expect(next.ships.slice(0, 10).every(s => s.fuel === 0)).toBe(true);
    reject(next, { kind: 'deployProduction', factionId: 'blue', systemId: 'sol', expectedTurn: 1, orderId: 101 }, 'SHIP_LIMIT');
    reject(next, { kind: 'createFleet', factionId: 'blue', systemId: 'sol', expectedTurn: 1, shipIds: [49, 50] }, 'FLEET_LIMIT');
    const arrived = end(next); expect(arrived.ships.filter(s => s.systemId === 'eden')).toHaveLength(10);
    expect(arrived.fleets.items).toHaveLength(20);
  });
  it('keeps enemy group routes and tanks out of detached faction projections', () => {
    const state = fixture(); state.turn = 2;
    for (const id of ['vega', 'nexus']) state.galaxy.systems.find(s => s.id === id)!.exploredBy.push('blue');
    const before = getCampaignSessionView(state, 'blue');
    const moving = apply(state, { ...send, factionId: 'red', expectedTurn: 2, fleetId: 4, systemId: 'vega', destinationId: 'nexus' });
    expect(getCampaignSessionView(moving, 'blue')).toEqual(before);
    const view = getCampaignSessionView(moving, 'red'); expect(view.fleets.map(f => f.id)).toEqual([4]);
    expect(getFleetTransit(view.fleets[0], view.ships)).toEqual({ destinationId: 'nexus', remainingTurns: 1 });
    view.fleets[0].shipIds.reverse(); view.ships[0].transit!.destinationId = 'sol'; view.ships[0].design.name = 'Changed';
    expect(getCampaignSessionView(moving, 'red').fleets[0].shipIds).toEqual([7, 8]);
    expect(moving.ships[6].transit!.destinationId).toBe('nexus'); expect(moving.ships[6].design.name).not.toBe('Changed');
  });
  it('replays immutable commands with identical results and no counter allocation', () => {
    const state = fixture(); freeze(state);
    const commands: SessionCommand[] = [send, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 },
      { kind: 'endTurn', factionId: 'red', expectedTurn: 2 }, { ...disband, expectedTurn: 3, systemId: 'eden' }];
    freeze(commands); const run = () => commands.reduce(apply, state);
    expect(run()).toEqual(run()); expect(run().production.lastOrderId).toBe(10); expect(run().fleets.lastFleetId).toBe(4);
  });
  it('runs an ordinary paid two-ship cycle through grouping and grouped arrival without injected money/ships', () => {
    let state = createCampaignSession(); const design = createCombatDesign('fighter');
    state = apply(state, { kind: 'explore', factionId: 'blue', expectedTurn: 1, systemId: 'eden' });
    state = apply(state, { kind: 'colonize', factionId: 'blue', expectedTurn: 1, systemId: 'eden' });
    for (let i = 0; i < 28; i++) state = end(state);
    for (let i = 0; i < 2; i++) state = apply(state, { kind: 'enqueueProduction', factionId: 'blue', expectedTurn: state.turn, systemId: 'sol', design });
    for (let i = 0; i < 16; i++) state = end(state);
    for (const orderId of [1, 2]) state = apply(state, { kind: 'deployProduction', factionId: 'blue', expectedTurn: state.turn, systemId: 'sol', orderId });
    state = apply(state, { kind: 'createFleet', factionId: 'blue', expectedTurn: state.turn, systemId: 'sol', shipIds: [2, 1] });
    const before = structuredClone(state); state = apply(state, { ...send, expectedTurn: state.turn });
    expect(state.treasuries).toEqual(before.treasuries); state = end(state);
    expect(state.ships.every(ship => ship.systemId === 'eden' && ship.fuel === 2 && !ship.transit)).toBe(true);
    expect(state.ships.map(s => s.design)).toEqual([design, design]); expect(state.fleets.items[0]).toMatchObject({ id: 1, systemId: 'eden', shipIds: [2, 1] });
  });
});

describe('group travel schema boundaries', () => {
  it('keeps S3.15 stationary sessions valid without new persisted fields or default migration', () => {
    const state = fixture(); expect(campaignSessionSchema.parse(state)).toEqual(state);
    expect(state.fleets.items.every(f => !('transit' in f))).toBe(true);
    const { fleets: _fleets, ...old } = state; reject(old, send, 'INVALID_STATE');
  });
  it.each([{ fleetId: undefined }, { fleetId: 0 }, { fleetId: '1' }, { fleetId: 1.5 }, { fleetId: Infinity }, { fleetId: MAX_FLEET_ID + 1 },
    { systemId: undefined }, { systemId: 'unknown' }, { destinationId: undefined }, { destinationId: 'unknown' },
    { expectedTurn: undefined }, { expectedTurn: '1' }, { factionId: 'neutral' }, { shipIds: [1, 2] }, { fuel: 3 }, { cost: 0 },
    { transit: { destinationId: 'eden', remainingTurns: 1 } }, { remainingTurns: 1 }, { design: createCombatDesign('fighter') }
  ])('rejects malformed/forged group send payload %#', extra => {
    const command = { ...send, ...extra }; expect(sessionCommandSchema.safeParse(command).success).toBe(false);
    reject(fixture(), command, 'INVALID_COMMAND');
  });
  it.each([
    (s: CampaignSession) => { delete s.ships[0].transit; },
    (s: CampaignSession) => { delete s.ships[1].transit; },
    (s: CampaignSession) => { s.ships[0].systemId = 'eden'; delete s.ships[0].transit; },
    (s: CampaignSession) => { s.fleets.items[0].systemId = 'eden'; },
    (s: CampaignSession) => { s.ships.shift(); },
    (s: CampaignSession) => { s.ships[0].factionId = 'red'; },
    (s: CampaignSession) => { s.fleets.items[0].shipIds = [1, 3]; },
    (s: CampaignSession) => { s.galaxy.systems.find(x => x.id === 'eden')!.ownerId = null; },
    (s: CampaignSession) => { s.galaxy.systems.find(x => x.id === 'sol')!.ownerId = null; },
    (s: CampaignSession) => { Object.assign(s.ships[0].transit!, { remainingTurns: 2 }); },
    (s: CampaignSession) => { Object.assign(s.fleets.items[0], { transit: { destinationId: 'eden', remainingTurns: 1 } }); },
    (s: CampaignSession) => { Object.assign(s.ships[0], { fleetId: 1 }); }
  ])('rejects partial/diverged or forged group travel state %# before any command', mutate => {
    const state = apply(fixture(), send); mutate(state); reject(state, disband, 'INVALID_STATE');
    expect(() => getCampaignSessionView(state, 'blue')).toThrow();
  });
  it('rejects different valid member routes, not just individually invalid adjacency', () => {
    const state = fixture(), nexus = state.galaxy.systems.find(s => s.id === 'nexus')!;
    nexus.ownerId = 'blue'; nexus.exploredBy = ['blue'];
    state.ships[4].transit = { destinationId: 'sol', remainingTurns: 1 };
    state.ships[5].transit = { destinationId: 'nexus', remainingTurns: 1 };
    reject(state, send, 'INVALID_STATE');
  });
});
