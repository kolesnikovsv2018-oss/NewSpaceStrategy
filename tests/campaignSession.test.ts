import { describe, expect, it } from 'vitest';
import { createCampaignState, executeCampaignCommand, getCampaignView } from '../src/domain/campaign';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, sessionCommandSchema, type CampaignSession, type SessionCommand,
  type SessionErrorCode } from '../src/domain/campaignSession';

function endTurn(state: CampaignSession): SessionCommand {
  return { kind: 'endTurn', factionId: state.turn % 2 === 1 ? 'blue' : 'red', expectedTurn: state.turn };
}
const exploreEden: SessionCommand = { kind: 'explore', factionId: 'blue', systemId: 'eden', expectedTurn: 1 };
const colonizeEden: SessionCommand = { ...exploreEden, kind: 'colonize' };
function apply(state: CampaignSession, command: SessionCommand): CampaignSession {
  const before = structuredClone(state), input = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(state).toEqual(before); expect(command).toEqual(input);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(campaignSessionSchema.safeParse(result.state).success).toBe(true);
  return result.state;
}
function reject(state: unknown, command: unknown, code: SessionErrorCode): void {
  const before = structuredClone(state), input = structuredClone(command);
  expect(executeSessionCommand(state, command)).toMatchObject({ ok: false, code });
  expect(state).toEqual(before); expect(command).toEqual(input);
}

describe('campaign session economy and turn', () => {
  it('starts two independent treasuries and a blue turn without adding initial income', () => {
    const state = createCampaignSession();
    expect(state).toEqual({ galaxy: createCampaignState(), turn: 1,
      treasuries: { blue: { credits: 100, minerals: 50 }, red: { credits: 100, minerals: 50 } },
      production: { lastOrderId: 0, orders: [], completed: [] }, ships: [], fleets: { lastFleetId: 0, items: [] } });
    expect(state.treasuries.blue).not.toBe(state.treasuries.red);
    expect(getCampaignSessionView(state, 'blue')).toMatchObject({ turn: 1, activeFactionId: 'blue', income: { credits: 10, minerals: 5 } });
  });

  it('does not share nested state between parties or with the scenario', () => {
    const first = createCampaignSession(), second = createCampaignSession();
    first.galaxy.systems[0].exploredBy.push('red'); first.treasuries.blue.credits = 0;
    expect(second).toEqual(createCampaignSession());
    expect(second.galaxy).toEqual(createCampaignState());
  });

  it('pays only the ending side once per turn and alternates blue/red', () => {
    const first = createCampaignSession();
    const second = apply(first, endTurn(first));
    expect(second).toEqual({ ...first, turn: 2,
      treasuries: { blue: { credits: 110, minerals: 55 }, red: first.treasuries.red } });
    expect(getCampaignSessionView(second, 'blue').activeFactionId).toBe('red');
    const third = apply(second, endTurn(second));
    expect(third.turn).toBe(3);
    expect(third.treasuries).toEqual({ blue: { credits: 110, minerals: 55 }, red: { credits: 110, minerals: 55 } });
    expect(getCampaignSessionView(third, 'red').activeFactionId).toBe('blue');
  });

  it('does not pay or advance the turn for exploration, colonization or view queries', () => {
    const initial = createCampaignSession();
    const next = apply(apply(initial, exploreEden), colonizeEden);
    expect(next.turn).toBe(1); expect(next.treasuries).toEqual(initial.treasuries);
    expect(getCampaignSessionView(next, 'blue').income).toEqual({ credits: 20, minerals: 10 });
    expect(getCampaignSessionView(next, 'blue').treasury).toEqual(initial.treasuries.blue);
    const ended = apply(next, endTurn(next));
    expect(ended.treasuries.blue).toEqual({ credits: 120, minerals: 60 });
    expect(ended.treasuries.red).toEqual(initial.treasuries.red);
  });

  it('counts only owned colonies, not neutral explored or enemy systems', () => {
    let state = apply(createCampaignSession(), exploreEden);
    state = apply(state, { ...exploreEden, systemId: 'nexus' });
    state = apply(state, { ...exploreEden, systemId: 'vega' });
    expect(getCampaignSessionView(state, 'blue').income).toEqual({ credits: 10, minerals: 5 });
    expect(apply(state, endTurn(state)).treasuries.blue).toEqual({ credits: 110, minerals: 55 });
  });

  it('allows zero-colony sides to end a turn without income (no defeat rule yet)', () => {
    const state = createCampaignSession(); state.galaxy.systems[0].ownerId = null;
    expect(getCampaignSessionView(state, 'blue').income).toEqual({ credits: 0, minerals: 0 });
    const next = apply(state, endTurn(state));
    expect(next.treasuries).toEqual(state.treasuries); expect(next.turn).toBe(2);
  });

  it('enforces the active side for all commands before checking hidden map properties', () => {
    const state = createCampaignSession();
    reject(state, { kind: 'endTurn', factionId: 'red', expectedTurn: 1 }, 'NOT_ACTIVE_FACTION');
    reject(state, { kind: 'explore', factionId: 'red', expectedTurn: 1, systemId: 'nexus' }, 'NOT_ACTIVE_FACTION');
    reject(state, { kind: 'colonize', factionId: 'red', expectedTurn: 1, systemId: 'nexus' }, 'NOT_ACTIVE_FACTION');
  });

  it('rejects delayed commands even when the same side becomes active again', () => {
    const state = createCampaignSession(), command = endTurn(state);
    const second = apply(state, command);
    reject(second, command, 'STALE_TURN');
    const third = apply(second, endTurn(second));
    reject(third, command, 'STALE_TURN');
    reject(third, exploreEden, 'STALE_TURN'); reject(third, colonizeEden, 'STALE_TURN');
    reject(state, { ...command, expectedTurn: 2 }, 'STALE_TURN');
  });

  it('reuses map results/rules and leaves the sandbox API unchanged', () => {
    const state = createCampaignSession();
    const expected = executeCampaignCommand(state.galaxy, { kind: 'explore', factionId: 'blue', systemId: 'eden' });
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error(expected.message);
    expect(apply(state, exploreEden).galaxy).toEqual(expected.state);
    reject(state, colonizeEden, 'NOT_EXPLORED');
    reject(state, { ...exploreEden, systemId: 'sol' }, 'ALREADY_EXPLORED');
    reject(state, { ...exploreEden, systemId: 'nexus' }, 'OUT_OF_REACH');
    expect(executeCampaignCommand(state.galaxy, { kind: 'explore', factionId: 'red', systemId: 'nexus' }).ok).toBe(true);
  });

  it('permits red map actions during its turn without advancing or paying early', () => {
    let state = createCampaignSession(); state = apply(state, endTurn(state));
    state = apply(state, { kind: 'explore', factionId: 'red', systemId: 'nexus', expectedTurn: 2 });
    state = apply(state, { kind: 'colonize', factionId: 'red', systemId: 'nexus', expectedTurn: 2 });
    expect(state.turn).toBe(2); expect(state.treasuries.red).toEqual({ credits: 100, minerals: 50 });
    expect(apply(state, endTurn(state)).treasuries.red).toEqual({ credits: 120, minerals: 60 });
  });

  it.each(['credits', 'minerals'] as const)('rejects %s overflow without partial payment or turn advance', resource => {
    const state = createCampaignSession(); state.treasuries.blue[resource] = MAX_RESOURCE;
    reject(state, endTurn(state), 'RESOURCE_LIMIT');
  });

  it('accepts income that lands exactly on both limits', () => {
    const state = createCampaignSession();
    state.treasuries.blue = { credits: MAX_RESOURCE - 10, minerals: MAX_RESOURCE - 5 };
    expect(apply(state, endTurn(state)).treasuries.blue).toEqual({ credits: MAX_RESOURCE, minerals: MAX_RESOURCE });
  });

  it('does not overflow the turn counter or pay income at the terminal limit', () => {
    const state = createCampaignSession(); state.turn = MAX_TURN - 1;
    const last = apply(state, endTurn(state));
    expect(last.turn).toBe(MAX_TURN); reject(last, endTurn(last), 'TURN_LIMIT');
  });

  it('accepts deeply frozen inputs and detaches every output branch', () => {
    const state = createCampaignSession();
    for (const system of state.galaxy.systems) { Object.freeze(system.exploredBy); Object.freeze(system); }
    Object.freeze(state.galaxy.systems); Object.freeze(state.galaxy);
    Object.freeze(state.treasuries.blue); Object.freeze(state.treasuries.red); Object.freeze(state.treasuries); Object.freeze(state);
    for (const command of [endTurn(state), exploreEden]) {
      const next = apply(state, Object.freeze(command));
      next.treasuries.red.credits = 0; next.galaxy.systems[0].exploredBy.push('red');
      expect(state).toEqual(createCampaignSession());
    }
  });

  it('has deterministic replay without elapsed time and does not mutate commands', () => {
    const commands: SessionCommand[] = [exploreEden, colonizeEden,
      { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }, { kind: 'endTurn', factionId: 'red', expectedTurn: 2 }];
    const run = () => commands.reduce(apply, createCampaignSession());
    expect(run()).toEqual(run());
  });
});

describe('session input boundaries and view', () => {
  it.each([NaN, Infinity, -Infinity, -1, 0.5, MAX_RESOURCE + 1, Number.MAX_SAFE_INTEGER, '100', null, undefined])
    ('rejects invalid resource %j without coercion', amount => {
      const state = createCampaignSession();
      const malformed = { ...state, treasuries: { ...state.treasuries, blue: { ...state.treasuries.blue, credits: amount } } };
      reject(malformed, endTurn(state), 'INVALID_STATE');
    });

  it.each([0, -1, 1.5, NaN, Infinity, MAX_TURN + 1, '1', null, undefined])('rejects invalid turn %j in state and command', turn => {
    const state = createCampaignSession();
    reject({ ...state, turn }, endTurn(state), 'INVALID_STATE');
    reject(state, { ...endTurn(state), expectedTurn: turn }, 'INVALID_COMMAND');
  });

  it.each([null, undefined, {}, [],
    { ...createCampaignSession(), activeFactionId: 'red' },
    { ...createCampaignSession(), treasuries: { blue: { credits: 0, minerals: 0 } } },
    { ...createCampaignSession(), treasuries: { ...createCampaignSession().treasuries, green: { credits: 0, minerals: 0 } } },
    { ...createCampaignSession(), galaxy: { systems: [] } },
    { ...createCampaignSession(), treasuries: { blue: { credits: 0, minerals: 0, fuel: 1 }, red: { credits: 0, minerals: 0 } } }
  ])('rejects malformed session %j', state => {
    reject(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }, 'INVALID_STATE');
  });

  it.each([null, undefined, {}, [],
    { kind: 'endTurn', factionId: 'blue' },
    { kind: 'endTurn', factionId: 'green', expectedTurn: 1 },
    { kind: 'endTurn', factionId: 'blue', expectedTurn: 1, systemId: 'sol' },
    { ...exploreEden, free: true }, { ...colonizeEden, cost: 0 },
    { ...exploreEden, systemId: 'unknown' }, { kind: 'buy', factionId: 'blue', expectedTurn: 1 }
  ])('rejects malformed session command %j', command => {
    expect(sessionCommandSchema.safeParse(command).success).toBe(false);
    reject(createCampaignSession(), command, 'INVALID_COMMAND');
  });

  it('allows zero balances without inventing action costs', () => {
    const state = createCampaignSession(); state.treasuries.blue = { credits: 0, minerals: 0 };
    const next = apply(apply(state, exploreEden), colonizeEden);
    expect(next.treasuries.blue).toEqual({ credits: 0, minerals: 0 });
  });

  it.each(['blue', 'red'] as const)('exposes only %s treasury/income with the matching galaxy projection', faction => {
    const state = createCampaignSession(); state.treasuries.red = { credits: 9876, minerals: 5432 };
    const view = getCampaignSessionView(state, faction);
    expect(Object.keys(view).sort()).toEqual(['activeFactionId', 'economyForecast', 'fleets', 'galaxy', 'income', 'production', 'ships', 'treasury', 'turn']);
    expect(view.treasury).toEqual(state.treasuries[faction]);
    expect(view.galaxy).toEqual(getCampaignView(state.galaxy, faction));
    const before = getCampaignSessionView(state, faction);
    view.treasury.credits = 0; view.income.minerals = 0; view.galaxy.systems[0].name = 'changed'; view.galaxy.lanes.pop();
    expect(getCampaignSessionView(state, faction)).toEqual(before);
  });

  it('does not expose enemy resource changes through the other side’s view', () => {
    const state = createCampaignSession(), before = getCampaignSessionView(state, 'blue');
    state.treasuries.red.credits += 100;
    expect(getCampaignSessionView(state, 'blue')).toEqual(before);
  });

  it('rejects invalid query state/faction instead of returning partial private data', () => {
    const state = createCampaignSession();
    expect(() => getCampaignSessionView(state, 'green' as 'blue')).toThrow();
    state.treasuries.red.minerals = -1;
    expect(() => getCampaignSessionView(state, 'blue')).toThrow();
  });
});
