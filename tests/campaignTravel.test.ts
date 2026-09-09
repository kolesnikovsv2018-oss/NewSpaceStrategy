import { describe, expect, it } from 'vitest';
import { HULLS, type ShipDesign } from '../src/domain/shipDesign';
import { areSystemsAdjacent, getGalaxyDefinition, type CampaignFactionId, type SystemId } from '../src/domain/campaign';
import { advanceShipTravel, campaignShipsSchema, isShipAtColony } from '../src/domain/campaignShips';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, type CampaignSession, type SessionCommand, type SessionErrorCode } from '../src/domain/campaignSession';
import { MAX_ORDER_ID } from '../src/domain/production';

function design(): ShipDesign {
  return { schemaVersion: 2, id: 'transport', name: 'Транспорт', hullId: 'fighter',
    createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    slots: HULLS.fighter.slots.map(slot => ({ id: slot.id, component: slot.id === 'engine_1'
      ? { id: 'engine', name: 'Двигатель', kind: 'engine', thrust: 10, maxSpeed: 10, maneuverability: 0.7, powerGeneration: 1 } : null })) };
}
function own(state: CampaignSession, systemId: SystemId, factionId: CampaignFactionId) {
  const system = state.galaxy.systems.find(s => s.id === systemId)!;
  system.ownerId = factionId; system.exploredBy = [factionId];
}
function fixture() {
  const state = createCampaignSession(); own(state, 'eden', 'blue'); own(state, 'nexus', 'red');
  state.production.lastOrderId = 2;
  state.ships = [{ id: 1, factionId: 'blue', systemId: 'sol', fuel: 3, design: design() },
    { id: 2, factionId: 'red', systemId: 'vega', fuel: 3, design: design() }];
  return state;
}
const send = { kind: 'sendShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1, destinationId: 'eden' } as const;
function end(state: CampaignSession): SessionCommand {
  return { kind: 'endTurn', factionId: state.turn % 2 ? 'blue' : 'red', expectedTurn: state.turn };
}
function apply(state: CampaignSession, command: SessionCommand): CampaignSession {
  const before = structuredClone(state), input = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(state).toEqual(before); expect(command).toEqual(input);
  if (!result.ok) throw Error(result.code);
  expect(campaignSessionSchema.safeParse(result.state).success).toBe(true); return result.state;
}
function reject(state: unknown, command: unknown, code: SessionErrorCode) {
  const before = structuredClone(state), input = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(result).toMatchObject({ ok: false, code }); expect(result).not.toHaveProperty('state');
  expect(state).toEqual(before); expect(command).toEqual(input);
}
function freeze(value: object) {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); }); Object.freeze(value);
}

describe('one-own-turn strategic travel', () => {
  it('reuses undirected topology without exposing mutable lanes', () => {
    for (const [a, b] of getGalaxyDefinition().lanes) {
      expect(areSystemsAdjacent(a, b)).toBe(true); expect(areSystemsAdjacent(b, a)).toBe(true);
    }
    const map = getGalaxyDefinition(); map.lanes.length = 0;
    expect(areSystemsAdjacent('sol', 'eden')).toBe(true);
    expect(areSystemsAdjacent('sol', 'sol')).toBe(false); expect(areSystemsAdjacent('sol', 'nexus')).toBe(false);
  });
  it('adds a detached transit and spends one fuel, without treasury/turn/ID/design or production change', () => {
    const state = fixture(); freeze(state); freeze(send);
    const next = apply(state, send);
    expect(next).toEqual({ ...state, ships: [{ ...state.ships[0], fuel: 2, transit: { destinationId: 'eden', remainingTurns: 1 } }, state.ships[1]] });
    next.ships[0].design.name = 'Edited'; next.ships[0].transit!.destinationId = 'nexus';
    expect(state.ships[0].design).toEqual(design()); expect(state.ships[0]).not.toHaveProperty('transit');
  });
  it('arrives once on own endTurn and retains the original snapshot and ID', () => {
    const travelling = apply(fixture(), send); freeze(travelling);
    const arrived = apply(travelling, end(travelling));
    expect(arrived.ships[0]).toEqual({ ...fixture().ships[0], fuel: 2, systemId: 'eden' });
    expect(arrived.treasuries.blue).toEqual({ credits: 119, minerals: 60 }); expect(arrived.turn).toBe(2);
    reject(arrived, end(travelling), 'STALE_TURN');
    const next = apply(arrived, end(arrived)); expect(next.ships).toEqual(arrived.ships);
  });
  it('does not advance an opposing trip at another side endTurn', () => {
    const state = apply(fixture(), send); state.turn = 2;
    const next = apply(state, end(state)); expect(next.ships).toEqual(state.ships);
    expect(apply(next, end(next)).ships[0].systemId).toBe('eden');
  });
  it('sends red across the reverse declared edge and advances only red', () => {
    const state = fixture(); state.turn = 2;
    const command: SessionCommand = { ...send, factionId: 'red', expectedTurn: 2, systemId: 'vega', shipId: 2, destinationId: 'nexus' };
    const next = apply(state, command), arrived = apply(next, end(next));
    expect(arrived.ships[1].systemId).toBe('nexus'); expect(arrived.ships[0]).toEqual(state.ships[0]);
  });
  it('blocks repeats and rerouting while in transit without changing the destination', () => {
    const state = apply(fixture(), send);
    reject(state, send, 'SHIP_IN_TRANSIT'); reject(state, { ...send, destinationId: 'sol' }, 'SHIP_IN_TRANSIT');
    reject(state, { ...send, systemId: 'eden', destinationId: 'sol' }, 'SHIP_NOT_FOUND');
  });
  it('requires the current source after arrival, permits a return trip on the next own turn', () => {
    let state = apply(fixture(), send); state = apply(state, end(state)); state = apply(state, end(state));
    reject(state, send, 'STALE_TURN'); reject(state, { ...send, expectedTurn: 3 }, 'SHIP_NOT_FOUND');
    state = apply(state, { ...send, systemId: 'eden', destinationId: 'sol', expectedTurn: 3 });
    expect(apply(state, end(state)).ships[0].systemId).toBe('sol');
  });
  it('does not place a travelling ship at either endpoint in stationed selectors', () => {
    const ship = apply(fixture(), send).ships[0];
    expect(isShipAtColony(ship, 'sol')).toBe(false); expect(isShipAtColony(ship, 'eden')).toBe(false);
    const arrived = advanceShipTravel([ship], 'blue')[0]; expect(isShipAtColony(arrived, 'eden')).toBe(true);
    expect(isShipAtColony(arrived, 'sol')).toBe(false);
  });
  it('guards expectedTurn before active-side checks', () => {
    const state = fixture(); state.turn = 2;
    reject(state, send, 'STALE_TURN'); reject(state, { ...send, expectedTurn: 2 }, 'NOT_ACTIVE_FACTION');
  });
  it.each(['rift', 'dust', 'vega'] as const)('rejects non-owned source %s without leaking ships', systemId => {
    reject(fixture(), { ...send, systemId }, 'NOT_OWN_COLONY');
    reject(fixture(), { ...send, systemId, shipId: 99 }, 'NOT_OWN_COLONY');
  });
  it.each(['rift', 'dust', 'vega', 'nexus'] as const)('rejects non-owned target %s identically before route checks', destinationId => {
    const state = fixture(); reject(state, { ...send, destinationId }, 'NOT_OWN_COLONY');
    state.galaxy.systems.find(s => s.id === destinationId)!.exploredBy.push('blue');
    reject(state, { ...send, destinationId }, 'NOT_OWN_COLONY');
  });
  it('does not treat a discovered neutral colony candidate as an owned destination', () => {
    const state = fixture(); state.galaxy.systems.find(s => s.id === 'eden')!.ownerId = null;
    reject(state, send, 'NOT_OWN_COLONY');
  });
  it.each(['sol', 'nexus'] as const)('rejects same or non-adjacent own destination %s', destinationId => {
    const state = fixture(); own(state, 'nexus', 'blue');
    reject(state, { ...send, destinationId }, 'INVALID_ROUTE');
  });
  it.each([2, 3, 99])('does not send an enemy, undeployed or missing ship %i', shipId => {
    const state = fixture(); state.production.lastOrderId = 3;
    state.production.completed.push({ id: 3, factionId: 'blue', systemId: 'sol', design: design() });
    reject(state, { ...send, shipId }, 'SHIP_NOT_FOUND');
  });
  it('arrives all own trips simultaneously without moving stationed or enemy ships', () => {
    const state = fixture(); state.production.lastOrderId = 4;
    state.ships.push({ ...state.ships[0], id: 3, systemId: 'eden' }, { ...state.ships[0], id: 4 });
    state.ships[1].transit = { destinationId: 'nexus', remainingTurns: 1 };
    let next = apply(state, send); next = apply(next, { ...send, shipId: 3, systemId: 'eden', destinationId: 'sol' });
    const arrived = apply(next, end(next));
    expect(arrived.ships.map(s => s.systemId)).toEqual(['eden', 'vega', 'sol', 'sol']);
    expect(arrived.ships[1].transit).toEqual(state.ships[1].transit); expect(arrived.ships[3]).toEqual(state.ships[3]);
  });
  it.each(['credits', 'minerals'] as const)('rolls back income, production and arrival together on %s overflow', resource => {
    const state = apply(fixture(), send); state.treasuries.blue[resource] = MAX_RESOURCE;
    state.production.lastOrderId = 3;
    state.production.orders.push({ id: 3, factionId: 'blue', systemId: 'sol', design: design(), remainingTurns: 1 });
    reject(state, end(state), 'RESOURCE_LIMIT'); expect(state.ships[0].transit).toBeDefined();
  });
  it('allows exact resource caps and completes production and travel in one atomic endTurn', () => {
    const state = apply(fixture(), send); state.treasuries.blue = { credits: MAX_RESOURCE - 20, minerals: MAX_RESOURCE - 10 };
    state.production.lastOrderId = 3;
    state.production.orders.push({ id: 3, factionId: 'blue', systemId: 'sol', design: design(), remainingTurns: 1 });
    const next = apply(state, end(state)); expect(next.treasuries.blue).toEqual({ credits: MAX_RESOURCE - 1, minerals: MAX_RESOURCE });
    expect(next.production.completed[0].id).toBe(3); expect(next.ships[0].systemId).toBe('eden');
  });
  it('terminal turn blocks arrival, not a zero-time send command', () => {
    const state = fixture(); state.turn = MAX_TURN;
    const next = apply(state, { ...send, factionId: 'red', shipId: 2, systemId: 'vega', destinationId: 'nexus', expectedTurn: MAX_TURN });
    reject(next, end(next), 'TURN_LIMIT'); expect(next.ships[1].transit).toBeDefined();
  });
  it('travel requires neither resource balance nor a free ID or ship slot', () => {
    const state = fixture(); state.production.lastOrderId = MAX_ORDER_ID;
    state.ships = Array.from({ length: 100 }, (_, i) => ({ ...state.ships[0], id: i + 1 }));
    state.treasuries.blue = { credits: 0, minerals: 0 };
    const next = apply(state, send); expect(next.ships).toHaveLength(100);
    expect(next.treasuries).toEqual(state.treasuries); expect(next.production.lastOrderId).toBe(MAX_ORDER_ID);
  });
  it('supports paid deployment and immediate departure without waiting an extra turn', () => {
    let state = createCampaignSession(); own(state, 'eden', 'blue');
    state = apply(state, { kind: 'enqueueProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', design: design() });
    state = apply(state, end(state)); state = apply(state, end(state));
    state = apply(state, { kind: 'deployProduction', factionId: 'blue', expectedTurn: 3, systemId: 'sol', orderId: 1 });
    state = apply(state, { ...send, expectedTurn: 3 }); expect(apply(state, end(state)).ships[0].systemId).toBe('eden');
  });
  it('query hides enemy routes and returns independent nested transit snapshots', () => {
    const state = apply(fixture(), send);
    state.galaxy.systems.find(s => s.id === 'vega')!.exploredBy.push('blue');
    state.galaxy.systems.find(s => s.id === 'nexus')!.exploredBy.push('blue');
    const before = getCampaignSessionView(state, 'blue');
    state.ships[1].transit = { destinationId: 'nexus', remainingTurns: 1 };
    expect(getCampaignSessionView(state, 'blue')).toEqual(before);
    const view = getCampaignSessionView(state, 'blue'); view.ships[0].transit!.destinationId = 'sol';
    view.ships[0].design.name = 'Changed';
    expect(getCampaignSessionView(state, 'blue')).toEqual(before);
    expect(getCampaignSessionView(state, 'red').ships.map(s => s.id)).toEqual([2]);
  });
  it('replays identically on frozen input and helper never mutates caller ships', () => {
    const initial = fixture(); freeze(initial);
    const commands: SessionCommand[] = [send, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }]; freeze(commands);
    const run = () => commands.reduce(apply, initial); expect(run()).toEqual(run());
    const ships = apply(initial, send).ships; freeze(ships);
    const arrived = advanceShipTravel(ships, 'blue'); expect(ships[0].transit).toBeDefined();
    expect(arrived[0].transit).toBeUndefined(); expect(arrived[1]).not.toBe(ships[1]);
    expect(() => advanceShipTravel(ships, 'neutral' as CampaignFactionId)).toThrow();
  });
  it('counts 100 travelling ships against deployment capacity and rejects the 101st in state', () => {
    const state = apply(fixture(), send); state.production.lastOrderId = 101;
    state.ships = Array.from({ length: 100 }, (_, i) => ({ ...state.ships[0], id: i + 1 }));
    state.production.completed = [{ id: 101, factionId: 'blue', systemId: 'sol', design: design() }];
    expect(campaignSessionSchema.safeParse(state).success).toBe(true);
    reject(state, { kind: 'deployProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 101 }, 'SHIP_LIMIT');
    state.production.completed = []; state.ships.push({ ...state.ships[0], id: 101 });
    reject(state, end(state), 'INVALID_STATE');
  });
  it('can depart immediately after founding an adjacent own colony through session commands', () => {
    let state = fixture(); const eden = state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = null; eden.exploredBy = [];
    state = apply(state, { kind: 'explore', factionId: 'blue', expectedTurn: 1, systemId: 'eden' });
    reject(state, send, 'NOT_OWN_COLONY');
    state = apply(state, { kind: 'colonize', factionId: 'blue', expectedTurn: 1, systemId: 'eden' });
    expect(apply(apply(state, send), end(state)).ships[0].systemId).toBe('eden');
  });
  it('accepts the previous stationed record without filling a second status field', () => {
    const state = fixture(), parsed = campaignSessionSchema.parse(state);
    expect(parsed).toEqual(state); expect(parsed.ships[0]).not.toHaveProperty('transit');
    expect(parsed.ships[0]).not.toHaveProperty('status');
    const { ships: _ships, ...oldSession } = state;
    reject(oldSession, send, 'INVALID_STATE');
  });
  it.each([0, -1, 1.2, '1', null, NaN, Infinity, MAX_ORDER_ID + 1])('rejects invalid shipId %s', shipId => {
    reject(fixture(), { ...send, shipId }, 'INVALID_COMMAND');
  });
  it.each([{ destinationId: 'unknown' }, { destinationId: null }, { remainingTurns: 1 }, { cost: 0 }, { design: design() },
    { fuel: 0 }, { transit: {} }, { expectedTurn: undefined }, { systemId: undefined }])('rejects malformed/extra payload %#', fields => {
    reject(fixture(), { ...send, ...fields }, 'INVALID_COMMAND');
  });
  it.each([null, {}, { destinationId: 'eden' }, { destinationId: 'eden', remainingTurns: 0 },
    { destinationId: 'eden', remainingTurns: 2 }, { destinationId: 'eden', remainingTurns: '1' },
    { destinationId: 'eden', remainingTurns: 1, fuel: 0 }, { destinationId: 'sol', remainingTurns: 1 },
    { destinationId: 'nexus', remainingTurns: 1 }, { destinationId: 'invalid', remainingTurns: 1 }])('rejects malformed transit %#', transit => {
    const state = fixture(); Object.assign(state.ships[0], { transit });
    reject(state, send, 'INVALID_STATE'); expect(() => getCampaignSessionView(state, 'blue')).toThrow();
    expect(campaignShipsSchema.safeParse(state.ships).success).toBe(false);
  });
  it.each(['source', 'destination'] as const)('rejects a session whose travelling %s colony no longer belongs to the ship', endpoint => {
    const state = apply(fixture(), send); own(state, endpoint === 'source' ? 'sol' : 'eden', 'red');
    reject(state, end(state), 'INVALID_STATE'); expect(() => getCampaignSessionView(state, 'blue')).toThrow();
  });
});
