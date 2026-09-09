import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { executeAiTurn, type AiTurnErrorCode, type AiTurnResult, type AiTurnSummary } from '../src/domain/campaignAiExecutor';
import * as planner from '../src/domain/campaignAiPlanner';
import * as session from '../src/domain/campaignSession';
import { campaignSessionSchema, createCampaignSession, getCampaignSessionView, MAX_RESOURCE, MAX_TURN,
  type CampaignSession, type EndTurnEconomy, type SessionErrorCode } from '../src/domain/campaignSession';
import { MAX_ORDER_ID } from '../src/domain/production';
import { MAX_FLEET_ID } from '../src/domain/campaignFleets';
import { ai, failure, freeze, frozen, known, observe, requestFor, rich, sides, threeCommands } from './fixtures/campaignAi';

afterEach(() => vi.restoreAllMocks());

describe('AI strict runtime boundary and access priority (real schemas)', () => {
  it('exports only synchronous unknown state/request entry and safe result types', () => {
    expectTypeOf<Parameters<typeof executeAiTurn>>().toEqualTypeOf<[unknown, unknown]>();
    expectTypeOf<ReturnType<typeof executeAiTurn>>().toEqualTypeOf<AiTurnResult>();
    expectTypeOf<AiTurnErrorCode>().toEqualTypeOf<SessionErrorCode | 'AI_PLAN_INVALID' | 'AI_EXECUTION_FAILED'>();
    expectTypeOf<AiTurnSummary>().toEqualTypeOf<{ factionId: 'blue' | 'red'; turn: number;
      commands: planner.AiCommand[]; endTurnEconomy: EndTurnEconomy }>();
    expectTypeOf<Extract<AiTurnResult, { ok: true }>>().toEqualTypeOf<{ ok: true; state: CampaignSession; summary: AiTurnSummary }>();
  });
  it.each([undefined, null, {}, [], true, 'state', 42])('rejects malformed state %j before request', input => {
    failure(executeAiTurn(input, null), 'INVALID_STATE');
  });
  it.each([undefined, null, {}, [], true, 'request', 42,
    { factionId: 'blue' }, { expectedTurn: 1 }, { factionId: 'neutral', expectedTurn: 1 },
    { factionId: 'blue', expectedTurn: 1, policy: 'v1' }, { factionId: 'blue', expectedTurn: 1, view: {} },
    { factionId: 'blue', expectedTurn: 1, plan: {} }, { factionId: 'blue', expectedTurn: 1, budget: 3 },
    { factionId: 'red', expectedTurn: 2, systemId: 'eden' }, { factionId: 'blue', expectedTurn: 1, design: {} }
  ])('rejects strict malformed request %j', input => failure(executeAiTurn(createCampaignSession(), input), 'INVALID_COMMAND'));

  it.each([NaN, Infinity, -Infinity, 0, -1, 1.5, MAX_TURN + 1, '1', null])('rejects noncanonical turn %j in state AND request', value => {
    const state = { ...createCampaignSession(), turn: value };
    failure(executeAiTurn(state, { factionId: 'red', expectedTurn: 2 }), 'INVALID_STATE');
    failure(executeAiTurn(createCampaignSession(), { factionId: 'red', expectedTurn: value }), 'INVALID_COMMAND');
  });

  const corruptions: [string, (state: CampaignSession) => unknown][] = [
    ['extra state field', state => ({ ...state, controller: 'AI' })],
    ['missing fleets', ({ fleets: _fleets, ...state }) => state],
    ['missing ships', ({ ships: _ships, ...state }) => state],
    ['missing production', ({ production: _production, ...state }) => state],
    ['missing enemy fuel', state => { Reflect.deleteProperty(state.ships[100], 'fuel'); return state; }],
    ['enemy flight invalid', state => { state.ships[100].design.slots.forEach(slot => { slot.component = null; }); return state; }],
    ['enemy group divergence', state => { delete state.ships[100].transit; return state; }],
    ['enemy duplicate ID', state => { state.ships[100].id = state.ships[0].id; return state; }],
    ['enemy invalid credits', state => { state.treasuries.red.credits = NaN; return state; }],
    ['enemy queue lost colony', state => { known(state, 'nexus', 'blue', 'blue'); return state; }],
    ['hidden duplicate explored', state => { state.galaxy.systems[5].exploredBy.push('red'); return state; }],
    ['counter behind IDs', state => { state.production.lastOrderId = 1; return state; }],
    ['extra receipt in state', state => ({ ...state, endTurnEconomy: {} })]
  ];
  it.each(corruptions)('full cross-state validation: %s', (_name, corrupt) => {
    const input = corrupt(rich()), before = structuredClone(input); freeze(input);
    failure(executeAiTurn(input, { factionId: 'red', expectedTurn: 2, extra: true }), 'INVALID_STATE');
    expect(input).toEqual(before);
  });

  it.each(sides)('%s: stale before inactive, active before terminal/gross cap', factionId => {
    const state = createCampaignSession(); state.turn = factionId === 'blue' ? MAX_TURN - 1 : MAX_TURN;
    state.treasuries[factionId] = { credits: MAX_RESOURCE, minerals: MAX_RESOURCE };
    const other = factionId === 'blue' ? 'red' : 'blue';
    failure(executeAiTurn(state, { factionId: other, expectedTurn: state.turn - 1 }), 'STALE_TURN');
    failure(executeAiTurn(state, { factionId: other, expectedTurn: state.turn }), 'NOT_ACTIVE_FACTION');
    failure(executeAiTurn(state, { factionId, expectedTurn: state.turn }), factionId === 'red' ? 'TURN_LIMIT' : 'RESOURCE_LIMIT');
  });
});

describe('real AI economics, limits and whole-batch atomicity', () => {
  it('runs the exact earned initial blue1/red2/blue3/red4 cycle to 130/65 each at turn5', () => {
    let state = createCampaignSession();
    const expected = [
      [['explore', 'eden'], ['endTurn']], [['explore', 'nexus'], ['endTurn']],
      [['colonize', 'eden'], ['explore', 'nexus'], ['endTurn']],
      [['colonize', 'nexus'], ['explore', 'dust'], ['endTurn']]
    ];
    for (let index = 0; index < 4; index++) {
      const result = ai(state), faction = index % 2 ? 'red' : 'blue';
      expect(result.summary.commands.map(item => item.kind === 'endTurn' ? [item.kind] : [item.kind, item.systemId])).toEqual(expected[index]);
      expect(result.state.treasuries[faction]).toEqual(index < 2 ? { credits: 110, minerals: 55 } : { credits: 130, minerals: 65 });
      expect(result.summary.endTurnEconomy.income).toEqual(index < 2 ? { credits: 10, minerals: 5 } : { credits: 20, minerals: 10 });
      expect(result.summary.endTurnEconomy.upkeep).toEqual({ shipCount: 0, dueCredits: 0, paidCredits: 0, shortfallCredits: 0 });
      state = result.state;
    }
    expect(state.turn).toBe(5);
    expect(state.treasuries).toEqual({ blue: { credits: 130, minerals: 65 }, red: { credits: 130, minerals: 65 } });
    expect(state.galaxy.systems.map(item => [item.id, item.ownerId, item.exploredBy])).toEqual([
      ['sol', 'blue', ['blue']], ['eden', 'blue', ['blue']], ['rift', null, []],
      ['nexus', 'red', ['red', 'blue']], ['dust', null, ['red']], ['vega', 'red', ['red']]
    ]);
    expect(state.ships).toEqual([]); expect(state.production).toEqual({ lastOrderId: 0, orders: [], completed: [] });
    expect(state.fleets).toEqual({ lastFleetId: 0, items: [] });
  });

  it.each(sides)('%s: zero money is not a purchase failure', faction => {
    const state = createCampaignSession(); state.turn = faction === 'blue' ? 1 : 2;
    state.treasuries[faction] = { credits: 0, minerals: 0 };
    known(state, faction === 'blue' ? 'eden' : 'nexus', faction);
    const result = ai(state);
    expect(result.summary.commands.map(item => item.kind)).toEqual(['colonize', 'explore', 'endTurn']);
    expect(result.state.treasuries[faction]).toEqual({ credits: 20, minerals: 10 });
  });

  it.each(sides)('%s: no colonies/no exploration ends once without granting a home', faction => {
    const state = createCampaignSession(); state.turn = faction === 'blue' ? 1 : 2;
    for (const system of state.galaxy.systems) { system.ownerId = null; system.exploredBy = []; }
    const result = ai(state);
    expect(result.summary.commands).toEqual([{ kind: 'endTurn', ...requestFor(state) }]);
    expect(result.state.galaxy).toEqual(state.galaxy); expect(result.state.treasuries).toEqual(state.treasuries);
  });

  it.each(sides.flatMap(faction => (['credits', 'minerals'] as const).flatMap(resource =>
    [false, true].flatMap(colonize => [0, 1].map(excess => ({ faction, resource, colonize, excess }))))))
  ('$faction $resource: final exact cap/+ $excess with colonize=$colonize', ({ faction, resource, colonize, excess }) => {
    const state = createCampaignSession(); state.turn = faction === 'blue' ? 1 : 2;
    if (colonize) known(state, faction === 'blue' ? 'eden' : 'nexus', faction);
    const income = (resource === 'credits' ? 10 : 5) * (colonize ? 2 : 1);
    state.treasuries[faction][resource] = MAX_RESOURCE - income + excess;
    const before = structuredClone(state), dispatch = vi.spyOn(session, 'executeSessionCommand'); freeze(state);
    const result = executeAiTurn(state, requestFor(state));
    if (excess) {
      failure(result, 'RESOURCE_LIMIT');
      expect(dispatch).toHaveBeenCalledTimes(colonize ? 3 : 0);
    } else {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(result.state.treasuries[faction][resource]).toBe(MAX_RESOURCE);
      expect(dispatch).toHaveBeenCalledTimes(colonize ? 3 : 2);
    }
    expect(state).toEqual(before);
  });

  it.each(['credits', 'minerals'] as const)('%s gross overflow cannot be rescued by upkeep100', resource => {
    const state = rich(); state.treasuries.blue[resource] = MAX_RESOURCE - (resource === 'credits' ? 20 : 10) + 1;
    const dispatch = vi.spyOn(session, 'executeSessionCommand');
    failure(executeAiTurn(state, requestFor(state)), 'RESOURCE_LIMIT');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['credits', 'minerals'] as const)('%s exact gross cap still pays own upkeep100 without clamping', resource => {
    const state = rich(); state.treasuries.blue[resource] = MAX_RESOURCE - (resource === 'credits' ? 20 : 10);
    const result = ai(state);
    expect(result.summary.endTurnEconomy.upkeep).toEqual({ shipCount: 100, dueCredits: 100, paidCredits: 100, shortfallCredits: 0 });
    expect(result.state.treasuries.blue[resource]).toBe(MAX_RESOURCE - (resource === 'credits' ? 100 : 0));
  });

  it.each(['credits', 'minerals'] as const)('%s late colonization overflow preserves rich FIFO/routes and already-spent fuel', resource => {
    const state = rich(1, 3);
    // An additional known free colony next to blue Eden, no red record uses it here.
    state.galaxy.systems.find(system => system.id === 'vega')!.ownerId = null;
    state.galaxy.systems.find(system => system.id === 'nexus')!.ownerId = null;
    known(state, 'nexus', 'blue');
    state.production.orders = state.production.orders.filter(item => item.factionId === 'blue');
    state.production.completed = state.production.completed.filter(item => item.factionId === 'blue');
    state.ships = state.ships.filter(item => item.factionId === 'blue');
    state.fleets.items = state.fleets.items.filter(item => item.factionId === 'blue');
    state.treasuries.blue[resource] = MAX_RESOURCE - (resource === 'credits' ? 20 : 10);
    expect(campaignSessionSchema.safeParse(state).success).toBe(true);
    expect(observe(state).economyForecast.ok).toBe(true);
    const before = structuredClone(state); freeze(state);
    const dispatch = vi.spyOn(session, 'executeSessionCommand');
    failure(executeAiTurn(state, requestFor(state)), 'RESOURCE_LIMIT');
    expect(dispatch.mock.calls.map(([, cmd]) => (cmd as planner.AiCommand).kind)).toEqual(['colonize', 'explore', 'endTurn']);
    expect(state).toEqual(before); expect(state.ships.map(item => item.fuel)).toEqual([0, 0, 0]);
  });

  it('MAX_TURN-1 completes once; terminal refuses, stale replay never pays again', () => {
    const state = createCampaignSession(); state.turn = MAX_TURN - 1;
    const result = ai(state);
    expect(result.state.turn).toBe(MAX_TURN);
    failure(executeAiTurn(result.state, requestFor(state)), 'STALE_TURN');
    failure(executeAiTurn(result.state, requestFor(result.state)), 'TURN_LIMIT');
    expect(executeAiTurn(state, requestFor(state))).toEqual(result);
  });

  it.each(sides)('%s deficit pays25/100, continues both colony FIFO heads and free/group arrivals only for self', faction => {
    const state = rich(faction === 'blue' ? 1 : 2), other = faction === 'blue' ? 'red' : 'blue';
    state.treasuries[faction] = { credits: 5, minerals: 5 };
    const before = structuredClone(state), result = ai(state);
    expect(result.summary.endTurnEconomy).toEqual({ factionId: faction, turn: state.turn,
      income: { credits: 20, minerals: 10 }, upkeep: { shipCount: 100, dueCredits: 100, paidCredits: 25, shortfallCredits: 75 },
      treasuryAfter: { credits: 0, minerals: 15 } });
    expect(getCampaignSessionView(result.state, faction).economyForecast).toEqual({ ok: true,
      income: { credits: 20, minerals: 10 }, upkeep: { shipCount: 100, dueCredits: 100, paidCredits: 20, shortfallCredits: 80 },
      treasuryAfter: { credits: 0, minerals: 25 } });
    expect(result.summary.commands.some(item => item.kind === 'colonize')).toBe(false);
    expect(result.state.ships).toHaveLength(200);
    expect(result.state.ships.filter(item => item.factionId === faction && item.transit)).toEqual([]);
    expect(result.state.ships.filter(item => item.factionId === faction).slice(0, 3).map(item => [item.systemId, item.fuel]))
      .toEqual(Array(3).fill([faction === 'blue' ? 'eden' : 'nexus', 0]));
    expect(result.state.production.orders.filter(item => item.factionId === faction).map(item => item.remainingTurns)).toEqual([4, 4]);
    expect(result.state.production.completed.filter(item => item.factionId === faction)).toHaveLength(3);
    expect(result.state.fleets.items.find(item => item.factionId === faction)?.systemId).toBe(faction === 'blue' ? 'eden' : 'nexus');
    expect(result.state.treasuries[other]).toEqual(before.treasuries[other]);
    for (const field of ['orders', 'completed'] as const) expect(result.state.production[field].filter(item => item.factionId === other))
      .toEqual(before.production[field].filter(item => item.factionId === other));
    expect(result.state.ships.filter(item => item.factionId === other)).toEqual(before.ships.filter(item => item.factionId === other));
    expect(result.state.fleets.items.filter(item => item.factionId === other)).toEqual(before.fleets.items.filter(item => item.factionId === other));
  });

  it.each(sides)('%s full200ships/200production/40groups and both maxIDs permit endTurn', faction => {
    const state = rich(faction === 'blue' ? 1 : 2);
    for (const [index, side] of sides.entries()) {
      const systemId = side === 'blue' ? 'sol' : 'vega';
      for (let offset = 0; offset < 95; offset++) state.production.completed.push({ id: 300 + index * 100 + offset,
        factionId: side, systemId, design: structuredClone(state.ships[0].design) });
      for (let offset = 0; offset < 19; offset++) state.fleets.items.push({ id: 3 + index * 19 + offset,
        factionId: side, systemId, shipIds: [4 + index * 100 + offset * 2, 5 + index * 100 + offset * 2] });
    }
    state.fleets.items.sort((a, b) => a.id - b.id);
    state.production.lastOrderId = MAX_ORDER_ID; state.fleets.lastFleetId = MAX_FLEET_ID;
    state.ships[state.ships.length - 1].id = MAX_ORDER_ID;
    state.production.completed[state.production.completed.length - 1].id = MAX_ORDER_ID - 1;
    state.fleets.items[state.fleets.items.length - 1].id = MAX_FLEET_ID;
    expect(campaignSessionSchema.safeParse(state).success).toBe(true);
    const result = ai(state);
    expect(result.state.production.lastOrderId).toBe(MAX_ORDER_ID); expect(result.state.fleets.lastFleetId).toBe(MAX_FLEET_ID);
    expect(result.state.ships).toHaveLength(200); expect(result.state.fleets.items).toHaveLength(40);
    expect(result.state.production.orders.length + result.state.production.completed.length).toBe(200);
    expect(result.summary.commands.map(item => item.kind)).toEqual(['explore', 'endTurn']);
  });
});

describe('runtime isolation and bounded execution with real dependencies', () => {
  it.each(['one', 'two', 'three'] as const)('%s-command batch: one planner, original observation only, <=3 dispatch', length => {
    const state = length === 'three' ? threeCommands() : createCampaignSession();
    if (length === 'one') for (const system of state.galaxy.systems) { known(state, system.id, 'blue'); }
    // Remove the newly available known colony to leave just endTurn.
    if (length === 'one') { known(state, 'eden', 'blue', 'blue'); known(state, 'nexus', 'red', 'red'); }
    const sourceView = getCampaignSessionView(state, 'blue'), beforeView = structuredClone(sourceView);
    const projection = vi.spyOn(session, 'getCampaignSessionView');
    const policy = vi.spyOn(planner, 'planAiTurn'), dispatch = vi.spyOn(session, 'executeSessionCommand');
    const result = ai(state), [observation, context] = policy.mock.calls[0];
    expect(policy).toHaveBeenCalledTimes(1); frozen(observation); frozen(context);
    expect(Object.keys(observation).sort()).toEqual(['activeFactionId', 'economyForecast', 'galaxy', 'turn']);
    expect(Object.keys(context).sort()).toEqual(['expectedTurn', 'factionId']);
    expect(observation).toEqual(observe(state));
    expect(observation.galaxy.systems).not.toBe(sourceView.galaxy.systems);
    expect(sourceView).toEqual(beforeView);
    expect(observation.galaxy.systems.filter(item => item.visibility === 'unknown').every(item =>
      !('ownerId' in item) && !('habitable' in item) && !('exploredBy' in item))).toBe(true);
    const count = { one: 1, two: 2, three: 3 }[length];
    expect(dispatch).toHaveBeenCalledTimes(count);
    expect(dispatch.mock.calls.map(([, cmd]) => cmd)).toEqual(result.summary.commands);
    expect(dispatch.mock.calls.filter(([, cmd]) => (cmd as planner.AiCommand).kind === 'endTurn')).toHaveLength(1);
    expect(policy.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
    expect(projection.mock.calls[0][0].turn).toBe(state.turn);
  });

  it('deeply detaches nested state/summary/commands from each other, input and captured planner output', () => {
    const state = threeCommands(), before = structuredClone(state), policy = vi.spyOn(planner, 'planAiTurn');
    const result = ai(state), original = structuredClone(result), planned = policy.mock.results[0].value as planner.AiPlanResult;
    if (!planned.ok) throw new Error('Expected plan');
    planned.plan.commands[0].factionId = 'red';
    expect(result).toEqual(original);
    result.summary.endTurnEconomy.income.credits = 999;
    result.summary.endTurnEconomy.treasuryAfter.credits = 999;
    result.summary.endTurnEconomy.upkeep.paidCredits = 999;
    result.summary.commands[0].factionId = 'red';
    expect(result.state).toEqual(original.state);
    result.state.galaxy.systems[0].exploredBy.push('red'); result.state.treasuries.blue.credits = 0;
    expect(state).toEqual(before);
    expect(ai(state)).toEqual(original);
  });

  it('detaches rich nested snapshots, routes, fleet arrays and even captured dispatch state/receipt', () => {
    const state = rich(1, 3);
    // Input aliases are legal; none may propagate to independently owned output records.
    state.ships[1].design = state.ships[0].design;
    state.ships[1].transit = state.ships[0].transit;
    const before = structuredClone(state), dispatch = vi.spyOn(session, 'executeSessionCommand');
    const result = ai(state), original = structuredClone(result);
    const last = dispatch.mock.results[dispatch.mock.results.length - 1].value as session.SessionResult;
    if (!last.ok || !last.endTurnEconomy) throw new Error('Expected endTurn receipt');
    last.endTurnEconomy.income.credits = 999;
    last.endTurnEconomy.treasuryAfter.credits = 999;
    last.state.ships[0].design.name = 'Changed private dispatch state';
    expect(result).toEqual(original);
    result.state.ships[0].design.slots.find(slot => slot.component)!.component!.name = 'Changed returned module';
    result.state.ships[3].transit!.destinationId = 'sol';
    result.state.fleets.items[0].shipIds.reverse();
    result.state.production.orders[0].design.name = 'Changed queued design';
    result.state.production.completed[0].design.name = 'Changed completed design';
    expect(result.state.ships[1].design).toEqual(before.ships[1].design);
    expect(result.state.ships[4].transit).toEqual(before.ships[4].transit);
    expect(result.summary).toEqual(original.summary); expect(state).toEqual(before);
    expect(ai(state)).toEqual(original);
  });
});