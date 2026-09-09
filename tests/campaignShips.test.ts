import { describe, expect, it } from 'vitest';
import { HULLS, validateDesign, type ShipDesign } from '../src/domain/shipDesign';
import { campaignShipsSchema, MAX_CAMPAIGN_SHIPS } from '../src/domain/campaignShips';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, type CampaignSession, type SessionCommand, type SessionErrorCode } from '../src/domain/campaignSession';
import { MAX_ORDER_ID } from '../src/domain/production';

function design(): ShipDesign {
  return { schemaVersion: 2, id: 'civilian', name: 'Корабль', hullId: 'fighter',
    createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    slots: HULLS.fighter.slots.map(slot => ({ id: slot.id, component: slot.id === 'engine_1'
      ? { id: 'engine', name: 'Двигатель', kind: 'engine', thrust: 10, maxSpeed: 10, maneuverability: 0.7, powerGeneration: 1 } : null })) };
}
function ready(): CampaignSession {
  const state = createCampaignSession();
  state.production = { lastOrderId: 2, orders: [], completed: [
    { id: 1, factionId: 'blue', systemId: 'sol', design: design() },
    { id: 2, factionId: 'red', systemId: 'vega', design: design() }
  ] };
  return state;
}
const deploy = { kind: 'deployProduction', factionId: 'blue', systemId: 'sol', expectedTurn: 1, orderId: 1 } as const;
function apply(state: CampaignSession, command: SessionCommand): CampaignSession {
  const before = structuredClone(state), input = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(state).toEqual(before); expect(command).toEqual(input);
  if (!result.ok) throw Error(result.code);
  expect(campaignSessionSchema.safeParse(result.state).success).toBe(true);
  return result.state;
}
function reject(state: unknown, command: unknown, code: SessionErrorCode) {
  const before = structuredClone(state), input = structuredClone(command);
  expect(executeSessionCommand(state, command)).toMatchObject({ ok: false, code });
  expect(executeSessionCommand(state, command)).not.toHaveProperty('state');
  expect(state).toEqual(before); expect(command).toEqual(input);
}
function freeze(value: object) {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); }); Object.freeze(value);
}

describe('strategic deployment', () => {
  it('starts with independent empty ship lists', () => {
    const a = createCampaignSession(), b = createCampaignSession();
    a.ships.push(ready().production.completed[0]); expect(b.ships).toEqual([]);
    expect(campaignShipsSchema.parse([])).toEqual([]);
  });
  it('moves exactly the completed record, retaining ID/project/colony without cost or turn change', () => {
    const state = ready(); freeze(state); freeze(deploy);
    const next = apply(state, deploy);
    expect(next).toEqual({ ...state, ships: [state.production.completed[0]],
      production: { ...state.production, completed: [state.production.completed[1]] } });
    expect(Object.keys(next.ships[0]).sort()).toEqual(['design', 'factionId', 'id', 'systemId']);
    expect(validateDesign(next.ships[0].design, 'battle').length).toBeGreaterThan(0);
  });
  it('uses an independent nested snapshot rather than a reference to completed or another ship', () => {
    const state = ready(); state.production.completed.push({ ...state.production.completed[0], id: 3 }); state.production.lastOrderId = 3;
    const next = apply(apply(state, deploy), { ...deploy, orderId: 3 });
    next.ships[0].design.name = 'Edited'; next.ships[0].design.slots[0].component = null;
    expect(next.ships[1].design).toEqual(design()); expect(state.production.completed[0].design).toEqual(design());
  });
  it('rejects repeats in the same turn and after a full round without adding another ship', () => {
    let state = apply(ready(), deploy); reject(state, deploy, 'COMPLETED_NOT_FOUND');
    state = apply(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    state = apply(state, { kind: 'endTurn', factionId: 'red', expectedTurn: 2 });
    reject(state, deploy, 'STALE_TURN'); reject(state, { ...deploy, expectedTurn: 3 }, 'COMPLETED_NOT_FOUND');
    expect(state.ships).toHaveLength(1);
  });
  it('deploys red independently when active', () => {
    const state = ready(); state.turn = 2;
    const next = apply(state, { ...deploy, factionId: 'red', systemId: 'vega', expectedTurn: 2, orderId: 2 });
    expect(next.ships[0].factionId).toBe('red'); expect(next.production.completed.map(r => r.id)).toEqual([1]);
  });
  it('rejects an inactive side and checks stale turn first', () => {
    const state = ready(); state.turn = 2;
    reject(state, deploy, 'STALE_TURN'); reject(state, { ...deploy, expectedTurn: 2 }, 'NOT_ACTIVE_FACTION');
  });
  it.each(['eden', 'rift', 'vega'] as const)('refuses non-owned %s before looking up a record', systemId => {
    reject(ready(), { ...deploy, systemId }, 'NOT_OWN_COLONY');
    reject(ready(), { ...deploy, systemId, orderId: 99 }, 'NOT_OWN_COLONY');
  });
  it('cannot transfer a record to another own colony or deploy an enemy record', () => {
    const state = ready(), eden = state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = 'blue'; eden.exploredBy = ['blue'];
    reject(state, { ...deploy, systemId: 'eden' }, 'COMPLETED_NOT_FOUND');
    reject(state, { ...deploy, orderId: 2 }, 'COMPLETED_NOT_FOUND');
  });
  it('does not deploy pending/missing/cancelled orders', () => {
    let state = createCampaignSession();
    state = apply(state, { kind: 'enqueueProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', design: design() });
    reject(state, deploy, 'COMPLETED_NOT_FOUND'); reject(state, { ...deploy, orderId: 99 }, 'COMPLETED_NOT_FOUND');
    state = apply(state, { ...deploy, kind: 'cancelProduction' }); reject(state, deploy, 'COMPLETED_NOT_FOUND');
  });
  it('completes the paid lifecycle deterministically with frozen inputs and preserves ships on endTurn', () => {
    const initial = createCampaignSession(), ship = design(); freeze(initial); freeze(ship);
    const commands: SessionCommand[] = [
      { kind: 'enqueueProduction', factionId: 'blue', systemId: 'sol', expectedTurn: 1, design: ship },
      { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 },
      { kind: 'endTurn', factionId: 'red', expectedTurn: 2 }, { ...deploy, expectedTurn: 3 }
    ];
    freeze(commands);
    const run = () => commands.reduce(apply, initial);
    const result = run(); expect(run()).toEqual(result); expect(result.production.completed).toEqual([]);
    freeze(result); const ended = apply(result, { kind: 'endTurn', factionId: 'blue', expectedTurn: 3 });
    expect(ended.ships).toEqual(result.ships); expect(ended.ships).not.toBe(result.ships);
    reject(result, { ...deploy, kind: 'cancelProduction', expectedTurn: 3 }, 'ORDER_NOT_FOUND');
  });
  it('can deploy at the final turn and exhausted production ID counter without minting another ID', () => {
    const state = ready(); state.turn = MAX_TURN;
    // MAX_TURN is even, so deploy red.
    state.production.lastOrderId = MAX_ORDER_ID; state.production.completed[1].id = MAX_ORDER_ID;
    state.treasuries.red = { credits: MAX_RESOURCE, minerals: MAX_RESOURCE };
    const next = apply(state, { ...deploy, factionId: 'red', systemId: 'vega', orderId: MAX_ORDER_ID, expectedTurn: MAX_TURN });
    expect(next.ships[0].id).toBe(MAX_ORDER_ID); expect(next.turn).toBe(MAX_TURN);
    expect(next.production.lastOrderId).toBe(MAX_ORDER_ID); expect(next.treasuries).toEqual(state.treasuries);
  });
  it('accepts exactly 100 own ships and rejects overflow without consuming completed', () => {
    const state = ready(); state.production.lastOrderId = 102;
    state.ships = Array.from({ length: MAX_CAMPAIGN_SHIPS - 1 }, (_, i) => ({ ...state.production.completed[0], id: i + 3 }));
    const next = apply(state, deploy); expect(next.ships).toHaveLength(MAX_CAMPAIGN_SHIPS);
    next.production.completed.push({ ...state.production.completed[0], id: 102 });
    reject(next, { ...deploy, orderId: 102 }, 'SHIP_LIMIT');
  });
  it('does not count enemy ships toward own capacity', () => {
    const state = ready(); state.production.lastOrderId = 102;
    state.ships = Array.from({ length: MAX_CAMPAIGN_SHIPS }, (_, i) => ({ ...state.production.completed[1], id: i + 3 }));
    expect(apply(state, deploy).ships).toHaveLength(101);
  });
  it('accepts 100 ships of each side but rejects a ship ID also present in the pending queue', () => {
    const state = ready(); state.production.lastOrderId = 202;
    state.ships = [0, 1].flatMap(side => Array.from({ length: 100 }, (_, i) => ({
      ...state.production.completed[side], id: 3 + side * 100 + i
    })));
    expect(campaignSessionSchema.safeParse(state).success).toBe(true);
    state.production.orders.push({ ...state.ships[0], remainingTurns: 1 });
    reject(state, deploy, 'INVALID_STATE');
  });
  it('deploys at another own colony and can deploy completed records out of issuance order', () => {
    const state = ready(), eden = state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = 'blue'; eden.exploredBy = ['blue'];
    state.production.completed.push({ ...state.production.completed[0], id: 3, systemId: 'eden' });
    state.production.lastOrderId = 3;
    const next = apply(apply(state, { ...deploy, orderId: 3, systemId: 'eden' }), deploy);
    expect(next.ships.map(ship => [ship.id, ship.systemId])).toEqual([[3, 'eden'], [1, 'sol']]);
  });
  it('frees a production slot while retaining the ID counter for subsequent enqueue', () => {
    const state = ready(); state.production.lastOrderId = 101;
    state.production.completed.push(...Array.from({ length: 99 }, (_, i) => ({ ...state.production.completed[0], id: i + 3 })));
    const command: SessionCommand = { kind: 'enqueueProduction', factionId: 'blue', systemId: 'sol', expectedTurn: 1, design: design() };
    reject(state, command, 'PRODUCTION_LIMIT');
    const next = apply(apply(state, deploy), command);
    expect(next.production.orders[0].id).toBe(102); expect(next.ships[0].id).toBe(1);
  });
  it('projects only own detached ships even after discovering the enemy colony', () => {
    let state = apply(ready(), deploy); state.turn = 2;
    state = apply(state, { ...deploy, factionId: 'red', systemId: 'vega', expectedTurn: 2, orderId: 2 });
    state.galaxy.systems.find(s => s.id === 'vega')!.exploredBy.push('blue');
    const view = getCampaignSessionView(state, 'blue'); expect(view.ships.map(s => s.id)).toEqual([1]);
    expect(view).not.toHaveProperty('lastOrderId');
    view.ships[0].design.name = 'Changed'; view.ships.length = 0;
    expect(getCampaignSessionView(state, 'blue').ships[0].design).toEqual(design());
    expect(getCampaignSessionView(state, 'red').ships.map(s => s.id)).toEqual([2]);
  });
  it.each([0, -1, 1.5, '1', NaN, Infinity, MAX_ORDER_ID + 1, null])('rejects invalid deployment ID %s', orderId => {
    reject(ready(), { ...deploy, orderId }, 'INVALID_COMMAND');
  });
  it.each([{ design: design() }, { cost: 0 }, { shipId: 3 }, { destination: 'eden' }, { remainingTurns: 0 }])('rejects injected payload %j', fields => {
    reject(ready(), { ...deploy, ...fields }, 'INVALID_COMMAND');
  });
  it.each([
    (s: CampaignSession) => { delete (s as Partial<CampaignSession>).ships; },
    (s: CampaignSession) => { s.ships.push({ ...s.production.completed[0] }); },
    (s: CampaignSession) => { s.ships.push({ ...s.production.completed[0], id: 3 }); },
    (s: CampaignSession) => { s.ships = [{ ...s.production.completed[0], systemId: 'vega' }]; s.production.completed.shift(); },
    (s: CampaignSession) => { const ship = s.production.completed.shift()!; s.ships = [ship, structuredClone(ship)]; },
    (s: CampaignSession) => { const ship = s.production.completed.shift()!; s.ships = [ship]; ship.design.slots.forEach(slot => { slot.component = null; }); },
    (s: CampaignSession) => { const ship = s.production.completed.shift()!; s.ships = [ship]; Object.assign(ship, { hp: 100 }); },
    (s: CampaignSession) => { const ship = s.production.completed.shift()!; s.ships = [ship]; ship.id = 0; },
    (s: CampaignSession) => { s.production.lastOrderId = 104; s.ships = Array.from({ length: 101 }, (_, i) => ({ ...s.production.completed[0], id: i + 3 })); }
  ])('rejects malformed ship state %# atomically and query throws', mutate => {
    const state = ready(); mutate(state); reject(state, deploy, 'INVALID_STATE');
    expect(() => getCampaignSessionView(state, 'blue')).toThrow();
  });
});
