import { afterEach, describe, expect, it, vi } from 'vitest';
import * as planner from '../src/domain/campaignAiPlanner';
import * as session from '../src/domain/campaignSession';
import { executeAiTurn } from '../src/domain/campaignAiExecutor';
import { failure, freeze, frozen, requestFor, threeCommands } from './fixtures/campaignAi';

afterEach(() => vi.restoreAllMocks());
const context = { factionId: 'blue', expectedTurn: 1 } as const;
const colony = { kind: 'colonize', ...context, systemId: 'eden' } as const;
const explore = { kind: 'explore', ...context, systemId: 'nexus' } as const;
const end = { kind: 'endTurn', ...context } as const;
const genuineDispatch = session.executeSessionCommand;

describe('FAULT ONLY: internal plan prevalidation (not domain legality evidence)', () => {
  const cases: [string, unknown][] = [
    ['missing plan', undefined], ['null', null], ['array instead of plan', [end]], ['missing commands', {}],
    ['extra plan property', { commands: [end], secret: 'PRIVATE' }], ['nonarray', { commands: end }],
    ['empty', { commands: [] }], ['too long', { commands: [colony, explore, end, end] }],
    ['oversized', { commands: Array(1000).fill(end) }], ['missing end', { commands: [colony, explore] }],
    ['null last command', { commands: [colony, explore, null] }],
    ['unknown last kind', { commands: [colony, explore, { ...end, kind: 'win' }] }],
    ['extra last payload', { commands: [colony, explore, { ...end, systemId: 'sol' }] }],
    ['duplicate end', { commands: [end, end] }], ['end not last', { commands: [end, explore] }],
    ['reversed geo order', { commands: [explore, colony, end] }],
    ['duplicate explore', { commands: [explore, explore, end] }],
    ['duplicate colony', { commands: [colony, colony, end] }],
    ['wrong side first', { commands: [{ ...colony, factionId: 'red' }, explore, end] }],
    ['wrong side second', { commands: [colony, { ...explore, factionId: 'red' }, end] }],
    ['wrong side last', { commands: [colony, explore, { ...end, factionId: 'red' }] }],
    ['wrong turn first', { commands: [{ ...colony, expectedTurn: 2 }, explore, end] }],
    ['wrong turn second', { commands: [colony, { ...explore, expectedTurn: 2 }, end] }],
    ['wrong turn last', { commands: [colony, explore, { ...end, expectedTurn: 2 }] }],
    ['NaN', { commands: [colony, explore, { ...end, expectedTurn: NaN }] }],
    ['fraction', { commands: [{ ...colony, expectedTurn: 1.5 }, end] }],
    ['coerced string', { commands: [colony, explore, { ...end, expectedTurn: '1' }] }],
    ['missing system', { commands: [{ kind: 'explore', ...context }, end] }],
    ['invalid system', { commands: [{ ...explore, systemId: 'PRIVATE' }, end] }],
    ['valid forbidden refuel', { commands: [{ kind: 'refuelShip', ...context, systemId: 'sol', shipId: 1 }, end] }],
    ['valid forbidden disband', { commands: [{ kind: 'disbandFleet', ...context, systemId: 'sol', fleetId: 1 }, end] }],
    ['valid forbidden cancel last', { commands: [colony, explore, { kind: 'cancelProduction', ...context, systemId: 'sol', orderId: 1 }] }]
  ];
  it.each(cases)('%s: rejects WHOLE plan before first dispatch', (_name, plan) => {
    const state = threeCommands(), before = structuredClone(state); freeze(state);
    const policy = vi.spyOn(planner, 'planAiTurn').mockReturnValue({ ok: true, plan } as planner.AiPlanResult);
    const dispatch = vi.spyOn(session, 'executeSessionCommand');
    failure(executeAiTurn(state, context), 'AI_PLAN_INVALID');
    expect(policy).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled(); expect(state).toEqual(before);
  });

  it('a structurally valid but illegal plan is rejected by real session rules, with no fallback', () => {
    const state = threeCommands(), before = structuredClone(state);
    vi.spyOn(planner, 'planAiTurn').mockReturnValue({ ok: true, plan: { commands: [{ ...colony, systemId: 'nexus' }, end] } });
    const dispatch = vi.spyOn(session, 'executeSessionCommand');
    failure(executeAiTurn(state, context), 'NOT_EXPLORED');
    expect(dispatch).toHaveBeenCalledTimes(1); expect(state).toEqual(before);
  });
});

describe('FAULT ONLY: abort exceptions and injected command failures, never partial output/log', () => {
  it.each([1, 2, 3].flatMap(step => ['failure', 'throw'].map(mode => ({ step, mode }))))
  ('$mode at dispatch $step rolls back even earlier successful commands', ({ step, mode }) => {
    const state = threeCommands(), before = structuredClone(state); freeze(state);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const policy = vi.spyOn(planner, 'planAiTurn');
    let calls = 0;
    const dispatch = vi.spyOn(session, 'executeSessionCommand').mockImplementation((candidate, cmd) => {
      if (++calls === step) {
        // Simulate even a misbehaving dependency mutating its PRIVATE candidate before failing.
        (candidate as session.CampaignSession).treasuries.red.credits = 123456;
        if (mode === 'throw') throw new Error('PRIVATE newly revealed ownership');
        return { ok: false, code: 'OUT_OF_REACH', message: 'PRIVATE newly revealed ownership' };
      }
      return genuineDispatch(candidate, cmd);
    });
    failure(executeAiTurn(state, context), mode === 'throw' ? 'AI_EXECUTION_FAILED' : 'OUT_OF_REACH');
    expect(dispatch).toHaveBeenCalledTimes(step); expect(policy).toHaveBeenCalledTimes(1);
    expect(state).toEqual(before); logs.forEach(log => expect(log).not.toHaveBeenCalled());
  });

  it.each(['planner', 'projection', 'initial-schema', 'final-projection'] as const)('%s exception is contained at its proper boundary', location => {
    const state = threeCommands(), before = structuredClone(state);
    const dispatch = vi.spyOn(session, 'executeSessionCommand');
    const throwPrivate = (): never => { throw new Error('PRIVATE refinement/projection/planner detail'); };
    if (location === 'initial-schema') vi.spyOn(session.campaignSessionSchema, 'safeParse').mockImplementationOnce(throwPrivate);
    if (location === 'planner') vi.spyOn(planner, 'planAiTurn').mockImplementationOnce(throwPrivate);
    if (location === 'projection') vi.spyOn(session, 'getCampaignSessionView').mockImplementationOnce(throwPrivate);
    if (location === 'final-projection') {
      const real = session.getCampaignSessionView;
      vi.spyOn(session, 'getCampaignSessionView').mockImplementationOnce(real).mockImplementationOnce(throwPrivate);
    }
    failure(executeAiTurn(state, context), location === 'initial-schema' ? 'INVALID_STATE' : 'AI_EXECUTION_FAILED');
    expect(dispatch).toHaveBeenCalledTimes(location === 'final-projection' ? 3 : 0); expect(state).toEqual(before);
  });

  it('planner mutation of the recursive frozen observation fails safely', () => {
    const state = threeCommands(), before = structuredClone(state);
    vi.spyOn(planner, 'planAiTurn').mockImplementation(view => {
      frozen(view);
      (view.galaxy.lanes as unknown as string[][])[0].push('PRIVATE');
      return { ok: true, plan: { commands: [end] } };
    });
    const dispatch = vi.spyOn(session, 'executeSessionCommand');
    failure(executeAiTurn(state, context), 'AI_EXECUTION_FAILED');
    expect(dispatch).not.toHaveBeenCalled(); expect(state).toEqual(before);
  });

  it('unknown injected dependency code/message cannot leak', () => {
    vi.spyOn(session, 'executeSessionCommand').mockReturnValue({ ok: false, code: 'PRIVATE', message: 'PRIVATE' } as unknown as session.SessionResult);
    failure(executeAiTurn(threeCommands(), context), 'AI_EXECUTION_FAILED');
  });

  it('explicit allowlist strips contaminated view fields at every level and detaches the original projection', () => {
    const state = threeCommands(), view = session.getCampaignSessionView(state, 'blue');
    Object.assign(view, { fullState: state }); Object.assign(view.galaxy, { exploredBy: ['red'] });
    Object.assign(view.galaxy.systems[2], { ownerId: 'red', habitable: true, exploredBy: ['red'] });
    if (!view.economyForecast.ok) throw new Error('Expected forecast');
    Object.assign(view.economyForecast, { receipt: 'PRIVATE' });
    Object.assign(view.economyForecast.income, { enemy: 123 });
    Object.assign(view.economyForecast.upkeep, { enemyShips: 123 });
    Object.assign(view.economyForecast.treasuryAfter, { enemy: 123 });
    const original = structuredClone(view);
    vi.spyOn(session, 'getCampaignSessionView').mockReturnValueOnce(view);
    const policy = vi.spyOn(planner, 'planAiTurn');
    const result = executeAiTurn(state, requestFor(state)); expect(result.ok).toBe(true);
    const [observation, captured] = policy.mock.calls[0]; frozen(observation); frozen(captured);
    expect(observation).toEqual({ galaxy: session.getCampaignSessionView(state, 'blue').galaxy,
      turn: 1, activeFactionId: 'blue', economyForecast: session.getCampaignSessionView(state, 'blue').economyForecast });
    expect(view).toEqual(original); expect(Object.isFrozen(view)).toBe(false);
    expect(observation.galaxy).not.toBe(view.galaxy);
    expect(observation.galaxy.lanes[0]).not.toBe(view.galaxy.lanes[0]);
    expect(observation.economyForecast).not.toBe(view.economyForecast);
    view.galaxy.lanes[0][0] = 'dust'; view.economyForecast.income.credits = 999;
    expect(observation.galaxy.lanes[0][0]).toBe('sol');
    expect(observation.economyForecast).not.toEqual(view.economyForecast);
  });
});

describe('FAULT ONLY: validate final receipt/state independently from plan and dispatch', () => {
  const cases: [string, (result: Extract<session.SessionResult, { ok: true }>) => void][] = [
    ['absent receipt', result => { delete result.endTurnEconomy; }],
    ['extra receipt field', result => { Object.assign(result.endTurnEconomy!, { ok: true }); }],
    ['wrong faction', result => { result.endTurnEconomy!.factionId = 'red'; }],
    ['wrong completed turn', result => { result.endTurnEconomy!.turn++; }],
    ['wrong income credits', result => { result.endTurnEconomy!.income.credits++; }],
    ['wrong income minerals', result => { result.endTurnEconomy!.income.minerals++; }],
    ['NaN income', result => { result.endTurnEconomy!.income.credits = NaN; }],
    ['negative treasury', result => { result.endTurnEconomy!.treasuryAfter.credits = -1; }],
    ['fraction count', result => { result.endTurnEconomy!.upkeep.shipCount = 0.5; }],
    ['wrong count', result => { result.endTurnEconomy!.upkeep.shipCount++; }],
    ['wrong due', result => { result.endTurnEconomy!.upkeep.dueCredits++; }],
    ['wrong paid', result => { result.endTurnEconomy!.upkeep.paidCredits++; }],
    ['wrong deficit', result => { result.endTurnEconomy!.upkeep.shortfallCredits++; }],
    ['wrong after credits', result => { result.endTurnEconomy!.treasuryAfter.credits++; }],
    ['wrong after minerals', result => { result.endTurnEconomy!.treasuryAfter.minerals++; }],
    ['extra upkeep field', result => { Object.assign(result.endTurnEconomy!.upkeep, { credits: 0 }); }],
    ['extra income field', result => { Object.assign(result.endTurnEconomy!.income, { enemy: 0 }); }],
    ['extra treasury field', result => { Object.assign(result.endTurnEconomy!.treasuryAfter, { enemy: 0 }); }],
    ['missing payment field', result => { Reflect.deleteProperty(result.endTurnEconomy!.upkeep, 'paidCredits'); }],
    ['unchanged turn', result => { result.state.turn--; }],
    ['two turns', result => { result.state.turn++; }],
    ['invalid final state', result => { result.state.treasuries.red.minerals = Infinity; }],
    ['mismatched final credits', result => { result.state.treasuries.blue.credits++; }],
    ['mismatched final minerals', result => { result.state.treasuries.blue.minerals++; }]
  ];
  it.each(cases)('%s: no success/summary despite successful dispatches', (_name, corrupt) => {
    const state = threeCommands(), before = structuredClone(state);
    const policy = vi.spyOn(planner, 'planAiTurn');
    const dispatch = vi.spyOn(session, 'executeSessionCommand').mockImplementation((input, cmd) => {
      const result = genuineDispatch(input, cmd);
      if (result.ok && (cmd as session.SessionCommand).kind === 'endTurn') corrupt(result);
      return result;
    });
    failure(executeAiTurn(state, requestFor(state)), 'AI_EXECUTION_FAILED');
    expect(dispatch).toHaveBeenCalledTimes(3); expect(policy).toHaveBeenCalledTimes(1); expect(state).toEqual(before);
  });
});