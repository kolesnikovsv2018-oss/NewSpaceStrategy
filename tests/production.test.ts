import { describe, expect, it } from 'vitest';
import { HULLS, validateDesign, type ShipDesign } from '../src/domain/shipDesign';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, type CampaignSession, type SessionCommand, type SessionErrorCode } from '../src/domain/campaignSession';
import { advanceProduction, createProductionState, getProductionQuote, getProductionRefund,
  MAX_ORDER_ID, MAX_PRODUCTION_RECORDS, productionStateSchema } from '../src/domain/production';

function design(short = false): ShipDesign {
  return { schemaVersion: 2, id: 'test-design', name: 'Заказ', hullId: 'fighter',
    createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    slots: HULLS.fighter.slots.map(slot => ({ id: slot.id, component: slot.id === 'engine_1'
      ? { id: 'engine', name: 'Двигатель', kind: 'engine', thrust: short ? 10 : 1000,
        maxSpeed: short ? 10 : 200, maneuverability: 0.7, powerGeneration: short ? 1 : 600 } : null })) };
}
function funded(): CampaignSession {
  const state = createCampaignSession();
  state.treasuries = { blue: { credits: 10000, minerals: 10000 }, red: { credits: 10000, minerals: 10000 } };
  return state;
}
function enqueue(state: CampaignSession, ship = design(), systemId: 'sol' | 'eden' | 'vega' = 'sol'): SessionCommand {
  return { kind: 'enqueueProduction', factionId: state.turn % 2 ? 'blue' : 'red', expectedTurn: state.turn, systemId, design: ship };
}
function cancel(state: CampaignSession, orderId = 1): SessionCommand {
  return { kind: 'cancelProduction', factionId: 'blue', systemId: 'sol', expectedTurn: state.turn, orderId };
}
function end(state: CampaignSession): SessionCommand {
  return { kind: 'endTurn', factionId: state.turn % 2 ? 'blue' : 'red', expectedTurn: state.turn };
}
function apply(state: CampaignSession, command: SessionCommand): CampaignSession {
  const before = structuredClone(state), input = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(state).toEqual(before); expect(command).toEqual(input);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(campaignSessionSchema.safeParse(result.state).success).toBe(true);
  return result.state;
}
function reject(state: unknown, command: unknown, code: SessionErrorCode) {
  const before = structuredClone(state), input = structuredClone(command);
  expect(executeSessionCommand(state, command)).toMatchObject({ ok: false, code });
  expect(state).toEqual(before); expect(command).toEqual(input);
}
function freeze(value: object) {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); });
  Object.freeze(value);
}

describe('colony production domain', () => {
  it('starts independent empty production without changing starting resources', () => {
    const first = createCampaignSession(), second = createCampaignSession();
    expect(first.production).toEqual(createProductionState());
    first.production.lastOrderId = 5;
    expect(second.production.lastOrderId).toBe(0);
    expect(second.treasuries.blue).toEqual({ credits: 100, minerals: 50 });
  });

  it('quotes canonical cost/mass with upward rounding and a minimum of one turn', () => {
    expect(getProductionQuote(design())).toEqual({ cost: { credits: 159, minerals: 9 }, turns: 4 });
    expect(getProductionQuote(design(true))).toEqual({ cost: { credits: 12, minerals: 4 }, turns: 1 });
    const quote = getProductionQuote(design()); quote.cost.credits = 0;
    expect(getProductionQuote(design()).cost.credits).toBe(159);
  });

  it('accepts civilian flight designs, without weakening battle validation', () => {
    const ship = design(); expect(validateDesign(ship, 'flight')).toEqual([]);
    expect(validateDesign(ship, 'battle').some(issue => issue.code === 'weapon')).toBe(true);
    const state = apply(funded(), enqueue(funded(), ship));
    expect(state.production.orders[0].design).toEqual(ship);
  });

  it('charges both resources up front, stores only the independent project and does not progress on enqueue', () => {
    const state = funded(), command = enqueue(state), next = apply(state, command);
    expect(next.treasuries.blue).toEqual({ credits: 9841, minerals: 9991 });
    expect(next.treasuries.red).toEqual(state.treasuries.red); expect(next.turn).toBe(1);
    expect(next.production.orders[0]).toEqual({ id: 1, systemId: 'sol', factionId: 'blue', design: design(), remainingTurns: 4 });
    if (command.kind !== 'enqueueProduction') throw Error('fixture');
    command.design.name = 'Поздняя правка'; command.design.slots[3].component = null;
    expect(next.production.orders[0].design).toEqual(design());
  });

  it('accepts exact balances and leaves zero without borrowing future income', () => {
    const state = funded(); state.treasuries.blue = getProductionQuote(design()).cost;
    const next = apply(state, enqueue(state)); expect(next.treasuries.blue).toEqual({ credits: 0, minerals: 0 });
  });

  it.each(['credits', 'minerals'] as const)('rejects insufficient %s without spending the other resource', resource => {
    const state = funded(); state.treasuries.blue[resource] = getProductionQuote(design()).cost[resource] - 1;
    reject(state, enqueue(state), 'INSUFFICIENT_RESOURCES');
  });

  it.each(['eden', 'rift', 'vega'] as const)('rejects production in non-owned %s with the same error', systemId => {
    const state = funded(); reject(state, { ...enqueue(state), systemId }, 'NOT_OWN_COLONY');
    reject(state, { ...cancel(state), systemId }, 'NOT_OWN_COLONY');
  });

  it.each(['enqueueProduction', 'cancelProduction'] as const)('guards active faction and expected turn for %s', kind => {
    const state = funded(), command = kind === 'enqueueProduction' ? enqueue(state) : cancel(state);
    reject(state, { ...command, factionId: 'red', systemId: 'vega' }, 'NOT_ACTIVE_FACTION');
    reject(state, { ...command, expectedTurn: 3 }, 'STALE_TURN');
  });

  it('allows three FIFO orders per colony and rejects a fourth before charging or allocating an ID', () => {
    let state = funded();
    for (let i = 0; i < 3; i++) state = apply(state, enqueue(state));
    expect(state.production.orders.map(order => order.id)).toEqual([1, 2, 3]);
    reject(state, enqueue(state), 'QUEUE_FULL');
  });

  it('advances only the first order of each own colony, not the other side or waiting orders', () => {
    let state = funded();
    state.galaxy.systems.find(system => system.id === 'eden')!.ownerId = 'blue';
    state.galaxy.systems.find(system => system.id === 'eden')!.exploredBy = ['blue'];
    state = apply(state, enqueue(state)); state = apply(state, enqueue(state));
    state = apply(state, enqueue(state, design(), 'eden'));
    state = apply(state, end(state));
    expect(state.production.orders.map(order => order.remainingTurns)).toEqual([3, 4, 3]);
    state = apply(state, enqueue(state, design(), 'vega'));
    state = apply(state, end(state));
    expect(state.production.orders.map(order => order.remainingTurns)).toEqual([3, 4, 3, 3]);
  });

  it('completes exactly once with no spillover to the next order and no runtime ship', () => {
    let state = funded(); state = apply(state, enqueue(state, design(true))); state = apply(state, enqueue(state));
    const command = end(state); state = apply(state, command);
    expect(state.production.orders).toHaveLength(1); expect(state.production.orders[0].remainingTurns).toBe(4);
    expect(state.production.completed).toEqual([{ id: 1, factionId: 'blue', systemId: 'sol', design: design(true) }]);
    reject(state, command, 'STALE_TURN');
    reject(state, { ...cancel(state), factionId: 'red', systemId: 'vega' }, 'ORDER_NOT_FOUND');
    state = apply(state, end(state)); reject(state, cancel(state), 'ORDER_NOT_FOUND');
    state = apply(state, end(state));
    expect(state.production.completed).toHaveLength(1); expect(state.production.orders[0].remainingTurns).toBe(3);
  });

  it('completes a four-turn order only after four own end turns', () => {
    let state = funded(); state = apply(state, enqueue(state));
    for (let i = 0; i < 6; i++) state = apply(state, end(state));
    expect(state.production.orders[0].remainingTurns).toBe(1); expect(state.production.completed).toEqual([]);
    state = apply(state, end(state)); expect(state.production.orders).toEqual([]);
    expect(state.production.completed[0].design).toEqual(design());
  });

  it('can produce in a newly founded colony during its first own turn', () => {
    let state = funded();
    state = apply(state, { kind: 'explore', factionId: 'blue', expectedTurn: 1, systemId: 'eden' });
    state = apply(state, { kind: 'colonize', factionId: 'blue', expectedTurn: 1, systemId: 'eden' });
    state = apply(state, enqueue(state, design(true), 'eden')); state = apply(state, end(state));
    expect(state.production.completed[0].systemId).toBe('eden');
    expect(state.treasuries.blue).toEqual({ credits: 10008, minerals: 10006 });
  });

  it('refunds an unstarted order fully, never reuses IDs and rejects a repeated cancellation', () => {
    let state = funded(); state = apply(state, enqueue(state)); state = apply(state, cancel(state));
    expect(state.treasuries.blue).toEqual(funded().treasuries.blue); expect(state.production.lastOrderId).toBe(1);
    reject(state, cancel(state), 'ORDER_NOT_FOUND');
    state = apply(state, enqueue(state)); expect(state.production.orders[0].id).toBe(2);
  });

  it('refunds only remaining work after progress, rounded down for each resource', () => {
    let state = funded(); state = apply(state, enqueue(state)); state = apply(state, end(state)); state = apply(state, end(state));
    expect(getProductionRefund(state.production.orders[0])).toEqual({ credits: 119, minerals: 6 });
    state = apply(state, cancel(state)); expect(state.treasuries.blue).toEqual({ credits: 9970, minerals: 10002 });
  });

  it('cancels a waiting order for full cost without disturbing the head progress', () => {
    let state = funded(); state = apply(state, enqueue(state)); state = apply(state, enqueue(state));
    state = apply(state, end(state)); state = apply(state, end(state));
    const before = state.treasuries.blue.credits; state = apply(state, cancel(state, 2));
    expect(state.treasuries.blue.credits).toBe(before + 159); expect(state.production.orders[0].remainingTurns).toBe(3);
  });

  it('promotes the next order after cancelling the head but does not advance it until end turn', () => {
    let state = funded(); state = apply(state, enqueue(state)); state = apply(state, enqueue(state));
    state = apply(state, cancel(state)); expect(state.production.orders[0].remainingTurns).toBe(4);
    state = apply(state, end(state)); expect(state.production.orders[0].remainingTurns).toBe(3);
  });

  it.each(['credits', 'minerals'] as const)('refund overflow of %s keeps the order and both balances', resource => {
    let state = funded(); state = apply(state, enqueue(state)); state.treasuries.blue[resource] = MAX_RESOURCE;
    reject(state, cancel(state), 'RESOURCE_LIMIT');
  });

  it.each(['credits', 'minerals'] as const)('income overflow of %s prevents completion and progression atomically', resource => {
    let state = funded(); state = apply(state, enqueue(state, design(true))); state.treasuries.blue[resource] = MAX_RESOURCE;
    reject(state, end(state), 'RESOURCE_LIMIT');
  });

  it('terminal turn prevents production, income and turn changes', () => {
    let state = funded(); state.turn = MAX_TURN; state = apply(state, enqueue(state, design(true), 'vega'));
    reject(state, end(state), 'TURN_LIMIT');
  });

  it('caps IDs without charging, but still allows cancellation at the cap', () => {
    let state = funded(); state.production.lastOrderId = MAX_ORDER_ID - 1;
    state = apply(state, enqueue(state)); expect(state.production.orders[0].id).toBe(MAX_ORDER_ID);
    reject(state, enqueue(state), 'ORDER_ID_LIMIT'); state = apply(state, cancel(state, MAX_ORDER_ID));
    reject(state, enqueue(state), 'ORDER_ID_LIMIT');
  });

  it('reserves completed capacity on enqueue and allows the last reserved order to finish', () => {
    let state = funded();
    state.production.completed = Array.from({ length: MAX_PRODUCTION_RECORDS - 1 }, (_, i) => ({ id: i + 1,
      factionId: 'blue', systemId: 'sol', design: design(true) }));
    state.production.lastOrderId = MAX_PRODUCTION_RECORDS - 1;
    state = apply(state, enqueue(state, design(true))); reject(state, enqueue(state), 'PRODUCTION_LIMIT');
    state = apply(state, end(state)); expect(state.production.completed).toHaveLength(MAX_PRODUCTION_RECORDS);
    // The other faction has an independent capacity reservation.
    state = apply(state, enqueue(state, design(true), 'vega'));
    expect(state.production.orders[0].factionId).toBe('red');
  });

  it('queries neither progress nor reveal opponent orders, completed projects or the global ID counter', () => {
    let state = funded(); const redBefore = getCampaignSessionView(state, 'red');
    state = apply(state, enqueue(state, design(true))); expect(getCampaignSessionView(state, 'red')).toEqual(redBefore);
    const view = getCampaignSessionView(state, 'blue'); expect(Object.keys(view.production).sort()).toEqual(['completed', 'orders']);
    view.production.orders[0].design.slots[3].component = null;
    expect(state.production.orders[0].design).toEqual(design(true));
    state = apply(state, end(state));
    expect(getCampaignSessionView(state, 'red').production).toEqual({ orders: [], completed: [] });
    const completedView = getCampaignSessionView(state, 'blue'); completedView.production.completed[0].design.name = 'Modified';
    expect(state.production.completed[0].design.name).toBe('Заказ');
  });

  it('operates on deeply frozen inputs with detached outputs and deterministic replay', () => {
    const start = funded(), command = enqueue(start); freeze(start); freeze(command);
    const first = apply(start, command), second = apply(start, command); expect(first).toEqual(second);
    freeze(first); const next = apply(first, end(first));
    next.production.orders[0].design.name = 'Only output'; expect(first.production.orders[0].design.name).toBe('Заказ');
    expect(advanceProduction(first.production, 'blue').orders[0].remainingTurns).toBe(3);
  });

  it.each(['engine', 'power', 'kind', 'mass'] as const)('rejects a structurally valid but flight-invalid %s project', defect => {
    const ship = design();
    if (defect === 'engine') ship.slots[3].component = null;
    const engine = ship.slots[3].component;
    if (engine?.kind === 'engine') {
      if (defect === 'power') engine.powerGeneration = 0;
      if (defect === 'mass') engine.thrust = 100000;
      if (defect === 'kind') { ship.slots[0].component = engine; ship.slots[3].component = null; }
    }
    expect(() => getProductionQuote(ship)).toThrow(); reject(funded(), enqueue(funded(), ship), 'INVALID_DESIGN');
  });

  it.each([0, -1, 1.5, NaN, Infinity, '1', null, undefined])('rejects invalid cancellation ID %s', orderId => {
    const state = funded(); reject(state, { ...cancel(state), orderId }, 'INVALID_COMMAND');
  });

  it('rejects untrusted extra command fields and malformed project structure', () => {
    const state = funded();
    reject(state, { ...enqueue(state), cost: { credits: 0, minerals: 0 } }, 'INVALID_COMMAND');
    reject(state, { ...enqueue(state), design: { ...design(), schemaVersion: 1 } }, 'INVALID_COMMAND');
    reject(state, { ...cancel(state), refund: 100 }, 'INVALID_COMMAND');
    reject(state, { ...enqueue(state), remainingTurns: 1 }, 'INVALID_COMMAND');
  });

  const corruptions: [string, (state: CampaignSession) => void][] = [
    ['duplicate ID', s => { s.production.orders.push(structuredClone(s.production.orders[0])); }],
    ['counter below issued ID', s => { s.production.lastOrderId = 0; }],
    ['counter overflow', s => { s.production.lastOrderId = MAX_ORDER_ID + 1; }],
    ['zero remaining turns', s => { s.production.orders[0].remainingTurns = 0; }],
    ['fractional progress', s => { s.production.orders[0].remainingTurns = 1.5; }],
    ['NaN progress', s => { s.production.orders[0].remainingTurns = NaN; }],
    ['progress over quote', s => { s.production.orders[0].remainingTurns = 5; }],
    ['wrong owner', s => { s.production.orders[0].factionId = 'red'; }],
    ['neutral colony', s => { s.production.orders[0].systemId = 'eden'; }],
    ['invalid stored design', s => { s.production.orders[0].design.slots[3].component = null; }],
    ['progressed waiting order', s => { s.production.lastOrderId = 2; s.production.orders.push({ ...structuredClone(s.production.orders[0]), id: 2, remainingTurns: 3 }); }],
    ['reordered FIFO', s => { s.production.lastOrderId = 2; s.production.orders.unshift({ ...structuredClone(s.production.orders[0]), id: 2 }); }],
    ['duplicate completed ID', s => { const { remainingTurns: _r, ...record } = s.production.orders[0]; s.production.completed.push(record); }],
    ['queue too long', s => { const order = s.production.orders[0]; s.production.lastOrderId = 4; s.production.orders = [1, 2, 3, 4].map(id => ({ ...structuredClone(order), id })); }]
  ];
  it.each(corruptions)('rejects malformed stored state: %s', (_name, corrupt) => {
    const state = apply(funded(), enqueue(funded())); corrupt(state);
    reject(state, end(state), 'INVALID_STATE');
    expect(() => getCampaignSessionView(state, 'blue')).toThrow();
  });

  it('requires explicit production state, rejects forged fields and excess completed capacity', () => {
    const state = funded(); const { production: _production, ...oldSession } = state;
    reject(oldSession, end(state), 'INVALID_STATE');
    reject({ ...state, production: { ...state.production, hidden: true } }, end(state), 'INVALID_STATE');
    const completed = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, factionId: 'blue', systemId: 'sol', design: design(true) }));
    expect(productionStateSchema.safeParse({ lastOrderId: 101, orders: [], completed }).success).toBe(false);
  });
});
