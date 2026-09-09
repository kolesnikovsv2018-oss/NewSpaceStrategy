import { describe, expect, it } from 'vitest';
import { createCombatDesign } from '../src/domain/combatPresets';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { campaignShipSchema, CAMPAIGN_FUEL_CAPACITY, getRefuelQuote, TRAVEL_FUEL_COST } from '../src/domain/campaignShips';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, sessionCommandSchema, type CampaignSession, type SessionCommand, type SessionErrorCode } from '../src/domain/campaignSession';
import { MAX_ORDER_ID } from '../src/domain/production';

const send = { kind: 'sendShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1, destinationId: 'eden' } as const;
const refuel = { kind: 'refuelShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1 } as const;
function fixture(fuel = 0): CampaignSession {
  const state = createCampaignSession();
  for (const [id, faction] of [['eden', 'blue'], ['nexus', 'red']] as const) {
    const system = state.galaxy.systems.find(s => s.id === id)!;
    system.ownerId = faction; system.exploredBy = [faction];
  }
  state.production.lastOrderId = 2;
  state.ships = [{ id: 1, factionId: 'blue', systemId: 'sol', fuel, design: createCombatDesign('fighter') },
    { id: 2, factionId: 'red', systemId: 'vega', fuel: 1, design: createCombatDesign('cruiser') }];
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
  expect(executeSessionCommand(state, command)).toMatchObject({ ok: false, code });
  expect(executeSessionCommand(state, command)).not.toHaveProperty('state');
  expect(state).toEqual(before); expect(command).toEqual(payload);
}
function end(state: CampaignSession): CampaignSession {
  return apply(state, { kind: 'endTurn', factionId: state.turn % 2 ? 'blue' : 'red', expectedTurn: state.turn });
}

describe('strategic fuel, independent of tactical design and energy', () => {
  it('defines fixed strategic capacity, trip cost and detached full-tank quotes', () => {
    expect(CAMPAIGN_FUEL_CAPACITY).toBe(3); expect(TRAVEL_FUEL_COST).toBe(1);
    expect(getRefuelQuote(0)).toEqual({ amount: 3, cost: { credits: 15, minerals: 6 } });
    expect(getRefuelQuote(1)).toEqual({ amount: 2, cost: { credits: 10, minerals: 4 } });
    expect(getRefuelQuote(2)).toEqual({ amount: 1, cost: { credits: 5, minerals: 2 } });
    expect(getRefuelQuote(3)).toEqual({ amount: 0, cost: { credits: 0, minerals: 0 } });
    getRefuelQuote(0).cost.credits = 999; expect(getRefuelQuote(0).cost.credits).toBe(15);
  });
  it.each([undefined, null, '1', -1, 0.5, 4, NaN, Infinity, -Infinity, {}, true])('rejects invalid/missing fuel %s without defaults or coercion', fuel => {
    const state = fixture(); Object.assign(state.ships[0], { fuel });
    expect(campaignShipSchema.safeParse(state.ships[0]).success).toBe(false);
    reject(state, refuel, 'INVALID_STATE');
    expect(() => getCampaignSessionView(state, 'blue')).toThrow();
    expect(() => getRefuelQuote(fuel as number)).toThrow();
  });
  it.each([false, true])('rejects pre-fuel runtime records, transit=%s, without mutating them', transit => {
    const state = fixture();
    if (transit) state.ships[0].transit = { destinationId: 'eden', remainingTurns: 1 };
    delete (state.ships[0] as Partial<typeof state.ships[0]>).fuel;
    reject(state, refuel, 'INVALID_STATE');
    expect(state.ships[0]).not.toHaveProperty('fuel');
    expect(campaignSessionSchema.safeParse(createCampaignSession()).success).toBe(true);
  });
  it.each([0, 1, 2, 3])('accepts integer fuel %i in detached own views', fuel => {
    const state = fixture(fuel), view = getCampaignSessionView(state, 'blue');
    expect(view.ships[0].fuel).toBe(fuel); expect(view.ships.map(s => s.id)).toEqual([1]);
    view.ships[0].fuel = fuel === 0 ? 3 : 0; view.ships[0].design.name = 'Changed';
    expect(state.ships[0].fuel).toBe(fuel); expect(state.ships[0].design.name).not.toBe('Changed');
    state.ships[1].fuel = 0;
    expect(getCampaignSessionView(state, 'blue').ships[0].fuel).toBe(fuel);
  });
  it.each(['fighter', 'dreadnought', 'freighter'] as const)('deploys %s with full fuel and no new payment or design field', kind => {
    const state = createCampaignSession();
    const design = kind === 'freighter' ? createCivilianDesign(kind) : createCombatDesign(kind);
    state.production = { lastOrderId: 1, orders: [], completed: [{ id: 1, factionId: 'blue', systemId: 'sol', design }] };
    state.treasuries.blue = { credits: 0, minerals: 0 };
    freeze(state);
    const next = apply(state, { kind: 'deployProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 1 });
    expect(next.ships[0]).toEqual({ ...state.production.completed[0], fuel: 3 });
    expect(next.treasuries).toEqual(state.treasuries); expect(next.ships[0].design).not.toHaveProperty('fuel');
    reject(next, { kind: 'deployProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 1 }, 'COMPLETED_NOT_FOUND');
  });
  it('rejects an empty tank even with abundant resources, without starting travel', () => {
    const state = fixture(); state.treasuries.blue = { credits: MAX_RESOURCE, minerals: MAX_RESOURCE };
    reject(state, send, 'INSUFFICIENT_FUEL'); expect(state.ships[0]).not.toHaveProperty('transit');
  });
  it('spends the last unit at send, never again at arrival, and does not auto-refuel', () => {
    const state = fixture(1); state.treasuries.blue = { credits: 0, minerals: 0 }; freeze(state);
    const next = apply(state, send);
    expect(next).toEqual({ ...state, ships: [{ ...state.ships[0], fuel: 0, transit: { destinationId: 'eden', remainingTurns: 1 } }, state.ships[1]] });
    reject(next, send, 'SHIP_IN_TRANSIT'); reject(next, refuel, 'SHIP_IN_TRANSIT');
    const arrived = end(next); expect(arrived.ships[0]).toEqual({ ...state.ships[0], systemId: 'eden', fuel: 0 });
    const again = end(arrived);
    reject(again, { ...send, expectedTurn: 3, systemId: 'eden', destinationId: 'sol' }, 'INSUFFICIENT_FUEL');
    expect(end(end(again)).ships).toEqual(again.ships);
  });
  it.each(['credits', 'minerals'] as const)('failed endTurn on %s does not refund or charge already spent fuel', resource => {
    const state = apply(fixture(1), send); state.treasuries.blue[resource] = MAX_RESOURCE;
    reject(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }, 'RESOURCE_LIMIT');
    expect(state.ships[0].fuel).toBe(0); expect(state.ships[0].transit).toBeDefined();
  });
  it.each([0, 1, 2])('fills fuel %i atomically at the exact price, changes nothing else', fuel => {
    const state = fixture(fuel), quote = getRefuelQuote(fuel); state.treasuries.blue = { ...quote.cost }; freeze(state); freeze(refuel);
    const next = apply(state, refuel);
    expect(next).toEqual({ ...state, ships: [{ ...state.ships[0], fuel: 3 }, state.ships[1]],
      treasuries: { ...state.treasuries, blue: { credits: 0, minerals: 0 } } });
    expect(next.ships[0].design).not.toBe(state.ships[0].design);
    reject(next, refuel, 'FUEL_FULL');
    const departed = apply(next, send); expect(departed.ships[0].fuel).toBe(2);
  });
  it.each(['credits', 'minerals'] as const)('rejects partial fill when one %s short, without charging either resource', resource => {
    const state = fixture(); state.treasuries.blue = { ...getRefuelQuote(0).cost }; state.treasuries.blue[resource]--;
    freeze(state); reject(state, refuel, 'INSUFFICIENT_RESOURCES');
  });
  it('full tank refuses before affordability and does not debit or advance the turn', () => {
    const state = fixture(3); state.treasuries.blue = { credits: 0, minerals: 0 }; reject(state, refuel, 'FUEL_FULL');
  });
  it('checks stale then inactive, with no ship information leak', () => {
    const state = fixture(); state.turn = 2;
    reject(state, refuel, 'STALE_TURN'); reject(state, { ...refuel, expectedTurn: 2 }, 'NOT_ACTIVE_FACTION');
    reject(state, { ...refuel, expectedTurn: 2, shipId: 999 }, 'NOT_ACTIVE_FACTION');
  });
  it.each(['rift', 'vega', 'dust'] as const)('refuses non-owned colony %s before ID lookup', systemId => {
    reject(fixture(), { ...refuel, systemId }, 'NOT_OWN_COLONY');
    reject(fixture(), { ...refuel, systemId, shipId: 999 }, 'NOT_OWN_COLONY');
  });
  it('refuses wrong own location, enemy, missing and completed IDs', () => {
    const state = fixture(); state.production.lastOrderId = 3;
    state.production.completed.push({ id: 3, factionId: 'blue', systemId: 'sol', design: state.ships[0].design });
    reject(state, { ...refuel, systemId: 'eden' }, 'SHIP_NOT_FOUND');
    for (const shipId of [2, 3, 99]) reject(state, { ...refuel, shipId }, 'SHIP_NOT_FOUND');
  });
  it('preserves destination/route validation priority over fuel for send', () => {
    const state = fixture(); reject(state, { ...send, destinationId: 'vega' }, 'NOT_OWN_COLONY');
    reject(state, { ...send, destinationId: 'sol' }, 'INVALID_ROUTE');
  });
  it('supports red refuel and reverse travel on terminal turn, without new IDs or ship slots', () => {
    const state = fixture(); state.turn = MAX_TURN; state.production.lastOrderId = MAX_ORDER_ID;
    state.ships = Array.from({ length: 100 }, (_, i) => ({ ...state.ships[1], id: i + 1, fuel: 0 }));
    const full = apply(state, { ...refuel, factionId: 'red', expectedTurn: MAX_TURN, systemId: 'vega' });
    expect(full.treasuries.red).toEqual({ credits: 85, minerals: 44 });
    expect(full.treasuries.blue).toEqual(state.treasuries.blue);
    expect(full.ships.slice(1)).toEqual(state.ships.slice(1));
    const next = apply(full, { ...send, factionId: 'red', expectedTurn: MAX_TURN, systemId: 'vega', destinationId: 'nexus' });
    expect(next.ships[0].fuel).toBe(2); expect(next.production.lastOrderId).toBe(MAX_ORDER_ID);
    reject(next, { kind: 'endTurn', factionId: 'red', expectedTurn: MAX_TURN }, 'TURN_LIMIT');
  });
  it('refuels after arrival at the destination on the next own turn and replays deterministically', () => {
    const initial = fixture(1); freeze(initial);
    const commands: SessionCommand[] = [send, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 },
      { kind: 'endTurn', factionId: 'red', expectedTurn: 2 }, { ...refuel, expectedTurn: 3, systemId: 'eden' },
      { ...send, expectedTurn: 3, systemId: 'eden', destinationId: 'sol' }];
    freeze(commands);
    const run = () => commands.reduce(apply, initial), next = run(); expect(run()).toEqual(next);
    expect(next.ships[0].fuel).toBe(2); expect(next.treasuries.blue).toEqual({ credits: 104, minerals: 54 }); // One own endTurn upkeep.
    reject(next, refuel, 'STALE_TURN');
    const view = getCampaignSessionView(next, 'blue'); view.ships[0].fuel = 0;
    expect(next.ships[0].fuel).toBe(2);
  });
  it.each([{ amount: 1 }, { cost: 0 }, { fuel: 3 }, { capacity: 9 }, { destinationId: 'eden' }, { design: {} },
    { expectedTurn: undefined }, { systemId: undefined }, { factionId: 'neutral' }, { shipId: undefined },
    { shipId: 0 }, { shipId: 1.5 }, { shipId: '1' }, { shipId: Infinity }, { shipId: MAX_ORDER_ID + 1 }])('rejects malformed or forged refuel payload %#', fields => {
    const command = { ...refuel, ...fields };
    expect(sessionCommandSchema.safeParse(command).success).toBe(false);
    reject(fixture(), command, 'INVALID_COMMAND');
  });
  it('cannot inject tank contents into deployment or the paid design', () => {
    const state = createCampaignSession();
    reject(state, { kind: 'deployProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 1, fuel: 3 }, 'INVALID_COMMAND');
    reject(state, { kind: 'enqueueProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', design: { ...createCombatDesign('fighter'), fuel: 3 } }, 'INVALID_COMMAND');
  });
});
