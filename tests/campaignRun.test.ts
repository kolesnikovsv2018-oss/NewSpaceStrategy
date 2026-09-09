import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CampaignControl } from '../src/domain/campaignControl';
import { campaignRunSchema, convertRunToLocal, createCampaignRun, executeRunAiTurn, executeRunCommand,
  runAiTurnRequestSchema, type CampaignRun, type RunErrorCode, type RunResult } from '../src/domain/campaignRun';
import * as session from '../src/domain/campaignSession';
import { createCampaignSession, getCampaignSessionView, MAX_RESOURCE, MAX_TURN, sessionCommandSchema,
  type CampaignSession, type SessionCommand } from '../src/domain/campaignSession';
import * as executor from '../src/domain/campaignAiExecutor';
import * as planner from '../src/domain/campaignAiPlanner';
import * as presets from '../src/domain/combatPresets';
import * as designs from '../src/domain/shipDesign';
import * as catalog from '../src/utils/ProductionCatalog';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { MAX_ORDER_ID } from '../src/domain/production';
import { MAX_FLEET_ID } from '../src/domain/campaignFleets';
import { freeze, known, requestFor, rich, sides } from './fixtures/campaignAi';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const local: CampaignControl = { mode: 'local' };
const computer: CampaignControl = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' };
function reject(result: RunResult, code: RunErrorCode): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error('Expected failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/); expect(result.message.length).toBeLessThan(200);
  expect(result.message).not.toMatch(/PRIVATE|Error:|issues|exploredBy|treasuries/);
}
function manual(run: CampaignRun, command: SessionCommand): CampaignRun {
  const before = structuredClone(run), input = structuredClone(command); freeze(run); freeze(command);
  const expected = session.executeSessionCommand(run.session, command), result = executeRunCommand(run, command);
  if (!expected.ok || !result.ok) throw new Error('Expected successful manual command');
  expect(result).toEqual({ ok: true, run: { session: expected.state, control: run.control },
    ...(expected.endTurnEconomy ? { endTurnEconomy: expected.endTurnEconomy } : {}) });
  expect(run).toEqual(before); expect(command).toEqual(input); return result.run;
}
function ai(run: CampaignRun) {
  const before = structuredClone(run), request = requestFor(run.session); freeze(run); freeze(request);
  const expected = executor.executeAiTurn(run.session, request), result = executeRunAiTurn(run, request);
  if (!expected.ok || !result.ok) throw new Error('Expected successful AI turn');
  expect(result).toEqual({ ok: true, run: { session: expected.state, control: run.control }, summary: expected.summary });
  expect(run).toEqual(before); expect(result.run.session.turn).toBe(run.session.turn + 1); return result;
}

function commands(state: CampaignSession): SessionCommand[] {
  const context = requestFor(state), systemId = context.factionId === 'blue' ? 'sol' : 'vega';
  const destinationId = context.factionId === 'blue' ? 'eden' : 'nexus';
  const offset = context.factionId === 'blue' ? 0 : 100;
  return [
    { kind: 'explore', ...context, systemId: 'rift' }, { kind: 'colonize', ...context, systemId: destinationId },
    { kind: 'endTurn', ...context }, { kind: 'enqueueProduction', ...context, systemId, design: state.ships[0].design },
    { kind: 'cancelProduction', ...context, systemId, orderId: offset ? 211 : 201 },
    { kind: 'deployProduction', ...context, systemId, orderId: offset ? 231 : 230 },
    { kind: 'sendShip', ...context, systemId, shipId: offset + 4, destinationId },
    { kind: 'refuelShip', ...context, systemId, shipId: offset + 4 },
    { kind: 'createFleet', ...context, systemId, shipIds: [offset + 4, offset + 5] },
    { kind: 'disbandFleet', ...context, systemId, fleetId: offset ? 2 : 1 },
    { kind: 'sendFleet', ...context, systemId, fleetId: offset ? 2 : 1, destinationId }
  ];
}

describe('every command kind: authorization and exact priority before existing rules', () => {
  const kinds = sessionCommandSchema.options.map(option => option.shape.kind.value);
  it('request shape matches the existing AI context and endTurn bounds, without depending on union order', () => {
    for (const factionId of [...sides, 'neutral']) for (const expectedTurn of [1, 2, MAX_TURN, MAX_TURN + 1, 0, 1.5, NaN, Infinity, '1']) {
      const request = { factionId, expectedTurn };
      expect(runAiTurnRequestSchema.safeParse(request).success).toBe(
        sessionCommandSchema.safeParse({ kind: 'endTurn', ...request }).success);
    }
  });
  it.each([undefined, null, [], {}, true, 'endTurn', { kind: 'win', factionId: 'blue', expectedTurn: 1 },
    { kind: 'endTurn', factionId: 'blue', expectedTurn: '1' },
    { kind: 'endTurn', factionId: 'blue', expectedTurn: NaN },
    { kind: 'enqueueProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', design: {} },
    { kind: 'createFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipIds: [1, 1] }
  ])('rejects malformed manual command %j before dispatch', command => {
    const dispatch = vi.spyOn(session, 'executeSessionCommand');
    reject(executeRunCommand({ session: createCampaignSession(), control: local }, command), 'INVALID_COMMAND');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(kinds.flatMap(kind => sides.flatMap(faction => [local, computer].map(control => ({ kind, faction, control })))))
  ('$control.mode $faction $kind', ({ kind, faction, control }) => {
    const state = rich(faction === 'blue' ? 1 : 2, 5);
    const command = commands(state).find(item => item.kind === kind)!;
    expect(command).toBeDefined(); expect(sessionCommandSchema.safeParse(command).success).toBe(true);
    const expected = session.executeSessionCommand(state, command), run = { session: state, control };
    const before = structuredClone(run); freeze(run); freeze(command);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), executeAi = vi.spyOn(executor, 'executeAiTurn');
    reject(executeRunCommand(run, { ...command, expectedTurn: state.turn + 1, extra: true }), 'INVALID_COMMAND');
    reject(executeRunCommand(run, { ...command, expectedTurn: state.turn + 1, factionId: faction === 'blue' ? 'red' : 'blue' }), 'STALE_TURN');
    reject(executeRunCommand(run, { ...command, factionId: faction === 'blue' ? 'red' : 'blue' }), 'NOT_ACTIVE_FACTION');
    expect(dispatch).not.toHaveBeenCalled();
    const result = executeRunCommand(run, command);
    if (control.mode === 'human-vs-ai' && faction === 'red') {
      reject(result, 'FACTION_CONTROLLED_BY_AI'); expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(dispatch).toHaveBeenCalledTimes(1);
      if (expected.ok) {
        expect(result).toEqual({ ok: true, run: { session: expected.state, control },
          ...(expected.endTurnEconomy ? { endTurnEconomy: expected.endTurnEconomy } : {}) });
      } else reject(result, expected.code);
    }
    expect(run).toEqual(before); expect(executeAi).not.toHaveBeenCalled();
  });

  it.each(sides.flatMap(faction => [local, computer].map(control => ({ faction, control }))))
  ('$control.mode helper $faction: schema → stale → active → assignment → executor', ({ faction, control }) => {
    const state = createCampaignSession(); state.turn = faction === 'blue' ? 1 : 2;
    state.treasuries[faction].credits = MAX_RESOURCE;
    const run = { session: state, control }, request = requestFor(state), execute = vi.spyOn(executor, 'executeAiTurn');
    reject(executeRunAiTurn(run, { ...request, expectedTurn: 3, plan: {} }), 'INVALID_COMMAND');
    reject(executeRunAiTurn(run, { ...request, expectedTurn: 3 }), 'STALE_TURN');
    reject(executeRunAiTurn(run, { ...request, factionId: faction === 'blue' ? 'red' : 'blue' }), 'NOT_ACTIVE_FACTION');
    expect(execute).not.toHaveBeenCalled();
    reject(executeRunAiTurn(run, request), control.mode === 'human-vs-ai' && faction === 'blue' ? 'AI_NOT_ASSIGNED' : 'RESOURCE_LIMIT');
    expect(execute).toHaveBeenCalledTimes(control.mode === 'human-vs-ai' && faction === 'blue' ? 0 : 1);
  });

  it.each([undefined, null, [], true, 'request', {}, { factionId: 'blue' }, { expectedTurn: 1 },
    { factionId: 'neutral', expectedTurn: 1 }, { factionId: 'blue', expectedTurn: '1' },
    ...[NaN, Infinity, -Infinity, 0, -1, 1.5, MAX_TURN + 1].map(expectedTurn => ({ factionId: 'blue', expectedTurn })),
    ...['kind', 'mode', 'aiPolicy', 'policy', 'scheduler', 'planner', 'view', 'run', 'budget', 'automatic']
      .map(key => ({ factionId: 'blue', expectedTurn: 1, [key]: 'PRIVATE' }))
  ])('strict request rejects %j, never accepts scheduling/plugin parameters', request => {
    expect(runAiTurnRequestSchema.safeParse(request).success).toBe(false);
    reject(executeRunAiTurn({ session: createCampaignSession(), control: local }, request), 'INVALID_COMMAND');
  });
});

describe('whole session validation, including hidden enemy state', () => {
  const corruptions: [string, (state: CampaignSession) => void][] = [
    ['missing fleets', state => { Reflect.deleteProperty(state, 'fleets'); }],
    ['missing ships', state => { Reflect.deleteProperty(state, 'ships'); }],
    ['missing production', state => { Reflect.deleteProperty(state, 'production'); }],
    ['hidden fuel missing', state => { Reflect.deleteProperty(state.ships[3], 'fuel'); }],
    ['hidden invalid flight', state => { state.ships[3].design.slots.forEach(slot => { slot.component = null; }); }],
    ['hidden group divergent transit', state => { delete state.ships[3].transit; }],
    ['hidden duplicate ship ID', state => { state.ships[3].id = state.ships[0].id; }],
    ['hidden treasury NaN', state => { state.treasuries.red.credits = NaN; }],
    ['hidden treasury overflow', state => { state.treasuries.red.minerals = MAX_RESOURCE + 1; }],
    ['hidden FIFO progressed waiting', state => { state.production.orders[5].remainingTurns = 2; }],
    ['hidden queue lost ownership', state => { known(state, 'nexus', 'blue', 'blue'); }],
    ['hidden exploration duplicate', state => { state.galaxy.systems[5].exploredBy.push('red'); }],
    ['counter behind ships', state => { state.production.lastOrderId = 1; }],
    ['hidden group unknown member', state => { state.fleets.items[1].shipIds[0] = 999; }],
    ['extra session control', state => { Object.assign(state, { control: local }); }],
    ['turn nonfinite', state => { state.turn = Infinity; }]
  ];
  it.each(corruptions)('%s rejects before malformed request/authorization; takeover cannot repair', (_name, corrupt) => {
    const state = rich(1, 3); corrupt(state);
    const run = { session: state, control: computer }, before = structuredClone(run); freeze(run);
    expect(campaignRunSchema.safeParse(run).success).toBe(false);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    reject(executeRunCommand(run, { factionId: 'red', expectedTurn: 2 }), 'INVALID_STATE');
    reject(executeRunAiTurn(run, { factionId: 'red', expectedTurn: 2, extra: true }), 'INVALID_STATE');
    reject(convertRunToLocal(run), 'INVALID_STATE');
    expect(run).toEqual(before); expect(dispatch).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
  });
});

describe('real handover, no implicit autoplay and unchanged policy', () => {
  it('exact human-blue/AI-red opening: 1→2→3→4→5, both treasuries130/65', () => {
    const created = createCampaignRun(computer); if (!created.ok) throw new Error(created.code);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), policy = vi.spyOn(planner, 'planAiTurn');
    let run = created.run;
    const blue = executeRunCommand(run, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    if (!blue.ok) throw new Error(blue.code);
    run = blue.run;
    expect(run.session.turn).toBe(2); expect(run.session.treasuries.blue).toEqual({ credits: 110, minerals: 55 });
    expect(run.session.treasuries.red).toEqual({ credits: 100, minerals: 50 });
    expect(policy).not.toHaveBeenCalled(); expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockClear();
    const red = executeRunAiTurn(run, { factionId: 'red', expectedTurn: 2 });
    if (!red.ok) throw new Error(red.code);
    expect(red.summary.commands).toEqual([{ kind: 'explore', factionId: 'red', expectedTurn: 2, systemId: 'nexus' },
      { kind: 'endTurn', factionId: 'red', expectedTurn: 2 }]);
    expect(policy).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(2);
    expect(red.run.session.turn).toBe(3); expect(red.run.session.treasuries.red).toEqual({ credits: 110, minerals: 55 });
    reject(executeRunAiTurn(red.run, { factionId: 'red', expectedTurn: 2 }), 'STALE_TURN');
    reject(executeRunAiTurn(red.run, { factionId: 'blue', expectedTurn: 3 }), 'AI_NOT_ASSIGNED');
    run = red.run;
    for (const kind of ['explore', 'colonize'] as const) run = manual(run, { kind, factionId: 'blue', expectedTurn: 3, systemId: 'eden' });
    expect(run.session.treasuries.blue).toEqual({ credits: 110, minerals: 55 });
    run = manual(run, { kind: 'endTurn', factionId: 'blue', expectedTurn: 3 });
    dispatch.mockClear(); policy.mockClear();
    const second = executeRunAiTurn(run, { factionId: 'red', expectedTurn: 4 });
    if (!second.ok) throw new Error(second.code);
    expect(second.summary.commands).toEqual([
      { kind: 'colonize', factionId: 'red', expectedTurn: 4, systemId: 'nexus' },
      { kind: 'explore', factionId: 'red', expectedTurn: 4, systemId: 'dust' },
      { kind: 'endTurn', factionId: 'red', expectedTurn: 4 }
    ]);
    expect(second.run.session.turn).toBe(5); expect(policy).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(3);
    expect(second.run.session.treasuries).toEqual({ blue: { credits: 130, minerals: 65 }, red: { credits: 130, minerals: 65 } });
    expect(second.run.control).toEqual(computer); expect(second.run.session.ships).toEqual([]);
    expect(second.run.session.production).toEqual({ lastOrderId: 0, orders: [], completed: [] });
    expect(second.run.session.fleets).toEqual({ lastFleetId: 0, items: [] });
    expect(second.run.session.galaxy.systems.map(item => [item.id, item.ownerId, item.exploredBy])).toEqual([
      ['sol', 'blue', ['blue']], ['eden', 'blue', ['blue']], ['rift', null, []],
      ['nexus', 'red', ['red']], ['dust', null, ['red']], ['vega', 'red', ['red']]
    ]);
  });

  it('local helper works in both directions, with unchanged four-turn policy and deterministic replay', () => {
    let run: CampaignRun = { session: createCampaignSession(), control: local };
    for (let turn = 1; turn <= 4; turn++) {
      const request = requestFor(run.session), result = ai(run);
      expect(executeRunAiTurn(run, request)).toEqual(result);
      reject(executeRunAiTurn(result.run, request), 'STALE_TURN'); run = result.run;
    }
    expect(run.session.turn).toBe(5);
    expect(run.session.treasuries).toEqual({ blue: { credits: 130, minerals: 65 }, red: { credits: 130, minerals: 65 } });
  });
});

describe('real diagnostic limits, atomic failures and recovery', () => {
  it.each(sides.flatMap(faction => (['credits', 'minerals'] as const).map(resource => ({ faction, resource }))))
  ('$faction late $resource cap rolls back colonization with existing FIFO/free/group transits and snapshots', ({ faction, resource }) => {
    const state = rich(faction === 'blue' ? 1 : 2, 3), other = faction === 'blue' ? 'red' : 'blue';
    for (const system of state.galaxy.systems) if (system.ownerId === other) system.ownerId = null;
    known(state, faction === 'blue' ? 'nexus' : 'eden', faction);
    state.ships = state.ships.filter(item => item.factionId === faction);
    state.fleets.items = state.fleets.items.filter(item => item.factionId === faction);
    state.production.orders = state.production.orders.filter(item => item.factionId === faction);
    state.production.completed = state.production.completed.filter(item => item.factionId === faction);
    state.treasuries[faction][resource] = MAX_RESOURCE - (resource === 'credits' ? 20 : 10);
    const run = { session: state, control: faction === 'blue' ? local : computer }, before = structuredClone(run);
    expect(campaignRunSchema.safeParse(run).success).toBe(true);
    expect(getCampaignSessionView(state, faction).economyForecast.ok).toBe(true); freeze(run);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), policy = vi.spyOn(planner, 'planAiTurn');
    reject(executeRunAiTurn(run, requestFor(state)), 'RESOURCE_LIMIT');
    expect(dispatch.mock.calls.map(([, command]) => (command as SessionCommand).kind)).toEqual(['colonize', 'explore', 'endTurn']);
    expect(policy).toHaveBeenCalledTimes(1); expect(run).toEqual(before);
    expect(run.session.ships.map(item => item.fuel)).toEqual([0, 0, 0]);
  });

  it.each(['credits', 'minerals'] as const)('red gross $resource cap remains blocked despite upkeep, takeover/refuel legally restores own end', resource => {
    const state = rich(2, 100); state.ships[103].fuel = 0;
    state.treasuries.red[resource] = MAX_RESOURCE - (resource === 'credits' ? 20 : 10) + 1;
    const run = { session: state, control: computer }, before = structuredClone(run); freeze(run);
    const dispatch = vi.spyOn(session, 'executeSessionCommand');
    reject(executeRunAiTurn(run, requestFor(state)), 'RESOURCE_LIMIT'); expect(dispatch).not.toHaveBeenCalled();
    expect(run).toEqual(before);
    const converted = convertRunToLocal(run); if (!converted.ok) throw new Error(converted.code);
    const refueled = manual(converted.run, { kind: 'refuelShip', ...requestFor(state), systemId: 'vega', shipId: 104 });
    expect(refueled.session.turn).toBe(2); expect(refueled.session.ships[103].fuel).toBe(3);
    expect(refueled.session.treasuries.red).toEqual({ credits: state.treasuries.red.credits - 15, minerals: state.treasuries.red.minerals - 6 });
    const ended = manual(refueled, { kind: 'endTurn', ...requestFor(state) });
    expect(ended.session.turn).toBe(3); expect(ended.session.ships).toHaveLength(200);
    expect(ended.session.ships.filter(item => item.factionId === 'red' && item.transit)).toEqual([]);
    expect(ended.session.production.orders.filter(item => item.factionId === 'red').map(item => item.remainingTurns)).toEqual([4, 4]);
  });

  it.each(sides.flatMap(faction => (['credits', 'minerals'] as const).flatMap(resource =>
    [false, true].flatMap(colonize => [0, 1].map(excess => ({ faction, resource, colonize, excess }))))))
  ('$faction $resource colonize=$colonize exact/+ $excess cap', ({ faction, resource, colonize, excess }) => {
    const state = createCampaignSession(); state.turn = faction === 'blue' ? 1 : 2;
    if (colonize) known(state, faction === 'blue' ? 'eden' : 'nexus', faction);
    state.treasuries[faction][resource] = MAX_RESOURCE - (resource === 'credits' ? 10 : 5) * (colonize ? 2 : 1) + excess;
    const run = { session: state, control: faction === 'blue' ? local : computer }, before = structuredClone(state); freeze(run);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), policy = vi.spyOn(planner, 'planAiTurn');
    const result = executeRunAiTurn(run, requestFor(state));
    if (excess) reject(result, 'RESOURCE_LIMIT');
    else {
      if (!result.ok) throw new Error(result.code);
      expect(result.run.session.treasuries[faction][resource]).toBe(MAX_RESOURCE);
      expect(result.summary.endTurnEconomy.treasuryAfter[resource]).toBe(MAX_RESOURCE);
    }
    expect(dispatch).toHaveBeenCalledTimes(excess && !colonize ? 0 : colonize ? 3 : 2);
    expect(policy).toHaveBeenCalledTimes(1); expect(run.session).toEqual(before);
  });

  it.each(['credits', 'minerals'] as const)('red late %s cap: preserves accepted blue end, takeover recovers own end without colonizing', resource => {
    const state = createCampaignSession(); known(state, 'nexus', 'red');
    state.treasuries.red[resource] = MAX_RESOURCE - (resource === 'credits' ? 10 : 5);
    const run = manual({ session: state, control: computer }, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    const before = structuredClone(run); freeze(run);
    reject(executeRunAiTurn(run, requestFor(run.session)), 'RESOURCE_LIMIT');
    expect(run).toEqual(before); expect(run.session.treasuries.blue).toEqual({ credits: 110, minerals: 55 });
    reject(executeRunCommand(run, { kind: 'endTurn', ...requestFor(run.session) }), 'FACTION_CONTROLLED_BY_AI');
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), policy = vi.spyOn(planner, 'planAiTurn');
    const takeover = convertRunToLocal(run); if (!takeover.ok) throw new Error(takeover.code);
    expect(dispatch).not.toHaveBeenCalled(); expect(policy).not.toHaveBeenCalled();
    expect(takeover.run.session).toEqual(before.session);
    const resumed = manual(takeover.run, { kind: 'endTurn', ...requestFor(takeover.run.session) });
    expect(resumed.session.turn).toBe(3); expect(resumed.session.treasuries.red[resource]).toBe(MAX_RESOURCE);
    expect(resumed.session.galaxy.systems.find(item => item.id === 'nexus')?.ownerId).toBeNull();
    expect(resumed.session.treasuries.blue).toEqual(before.session.treasuries.blue);
    expect(policy).not.toHaveBeenCalled();
  });

  it.each(sides)('%s deficit: actual25/100/75, FIFO heads and free/group arrivals, no refuel', faction => {
    const state = rich(faction === 'blue' ? 1 : 2), other = faction === 'blue' ? 'red' : 'blue';
    state.treasuries[faction] = { credits: 5, minerals: 5 };
    const before = structuredClone(state), result = ai({ session: state, control: faction === 'blue' ? local : computer });
    expect(result.summary.endTurnEconomy).toEqual({ factionId: faction, turn: state.turn,
      income: { credits: 20, minerals: 10 }, upkeep: { shipCount: 100, dueCredits: 100, paidCredits: 25, shortfallCredits: 75 },
      treasuryAfter: { credits: 0, minerals: 15 } });
    expect(getCampaignSessionView(result.run.session, faction).economyForecast).toMatchObject({ ok: true,
      upkeep: { paidCredits: 20, shortfallCredits: 80 }, treasuryAfter: { credits: 0, minerals: 25 } });
    expect(result.run.session.ships).toHaveLength(200);
    expect(result.run.session.ships.filter(item => item.factionId === faction && item.transit)).toEqual([]);
    expect(result.run.session.ships.filter(item => item.factionId === faction).slice(0, 3).map(item => [item.systemId, item.fuel]))
      .toEqual(Array(3).fill([faction === 'blue' ? 'eden' : 'nexus', 0]));
    expect(result.run.session.production.orders.filter(item => item.factionId === faction).map(item => item.remainingTurns)).toEqual([4, 4]);
    expect(result.run.session.production.completed.filter(item => item.factionId === faction)).toHaveLength(3);
    expect(result.run.session.fleets.items.find(item => item.factionId === faction)?.systemId).toBe(faction === 'blue' ? 'eden' : 'nexus');
    expect(result.run.session.ships.map(item => item.design)).toEqual(before.ships.map(item => item.design));
    for (const field of ['orders', 'completed'] as const) expect(result.run.session.production[field].filter(item => item.factionId === other))
      .toEqual(before.production[field].filter(item => item.factionId === other));
    expect(result.run.session.ships.filter(item => item.factionId === other)).toEqual(before.ships.filter(item => item.factionId === other));
    expect(result.run.session.fleets.items.filter(item => item.factionId === other)).toEqual(before.fleets.items.filter(item => item.factionId === other));
    expect(result.run.session.treasuries[other]).toEqual(before.treasuries[other]);
  });

  it('last human turn succeeds, terminal red rejects after authorization and takeover does not bypass turn limit', () => {
    const state = createCampaignSession(); state.turn = MAX_TURN - 1;
    const run = manual({ session: state, control: computer }, { kind: 'endTurn', ...requestFor(state) });
    expect(run.session.turn).toBe(MAX_TURN);
    reject(executeRunAiTurn(run, requestFor(state)), 'STALE_TURN');
    reject(executeRunAiTurn(run, requestFor(run.session)), 'TURN_LIMIT');
    reject(executeRunCommand(run, { kind: 'endTurn', ...requestFor(run.session) }), 'FACTION_CONTROLLED_BY_AI');
    const takeover = convertRunToLocal(run); if (!takeover.ok) throw new Error(takeover.code);
    reject(executeRunCommand(takeover.run, { kind: 'endTurn', ...requestFor(run.session) }), 'TURN_LIMIT');
  });

  it.each(sides)('%s no colonies/frontier still ends once, no home grants', faction => {
    const state = createCampaignSession(); state.turn = faction === 'blue' ? 1 : 2;
    state.galaxy.systems.forEach(system => { system.ownerId = null; system.exploredBy = []; });
    const result = ai({ session: state, control: faction === 'blue' ? local : computer });
    expect(result.summary.commands).toEqual([{ kind: 'endTurn', ...requestFor(state) }]);
    expect(result.run.session.galaxy).toEqual(state.galaxy); expect(result.run.session.treasuries).toEqual(state.treasuries);
  });

  it.each(sides)('%s all explored/colonized: no frontier means one end, no policy loop', faction => {
    const state = rich(faction === 'blue' ? 1 : 2, 3);
    for (const system of state.galaxy.systems) known(state, system.id, faction);
    const result = ai({ session: state, control: faction === 'blue' ? local : computer });
    expect(result.summary.commands).toEqual([{ kind: 'endTurn', ...requestFor(state) }]);
  });

  it('full diagnostic 200ships/200production/40groups and maximum IDs permit red AI end', () => {
    const state = rich(2);
    for (const [index, factionId] of sides.entries()) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega';
      for (let offset = 0; offset < 95; offset++) state.production.completed.push({ id: 300 + index * 100 + offset,
        factionId, systemId, design: structuredClone(state.ships[0].design) });
      for (let offset = 0; offset < 19; offset++) state.fleets.items.push({ id: 3 + index * 19 + offset,
        factionId, systemId, shipIds: [4 + index * 100 + offset * 2, 5 + index * 100 + offset * 2] });
    }
    state.fleets.items.sort((a, b) => a.id - b.id);
    state.production.lastOrderId = MAX_ORDER_ID; state.fleets.lastFleetId = MAX_FLEET_ID;
    const result = ai({ session: state, control: computer });
    expect(result.run.session.ships).toHaveLength(200); expect(result.run.session.fleets.items).toHaveLength(40);
    expect(result.run.session.production.orders.length + result.run.session.production.completed.length).toBe(200);
    expect(result.run.session.production.lastOrderId).toBe(MAX_ORDER_ID); expect(result.run.session.fleets.lastFleetId).toBe(MAX_FLEET_ID);
  });
});

describe('paid local preparation, not an AI purchase policy or public mode conversion', () => {
  it.each(['preset', 'library'] as const)('%s: real earned FIFO31→45, group transits→47, diagnostic red AI assignment only after purchases', source => {
    const data = new Map<string, string>();
    const storage: StoragePort = { getItem: vi.fn(key => data.get(key) ?? null), setItem: vi.fn((key, value) => { data.set(key, value); }) };
    const library = new ShipDesignManager(storage), created = presets.createCombatDesign('fighter');
    if (source === 'library') library.saveDesign(created);
    const choice = catalog.loadProductionCatalog(library).choices.find(item => source === 'library'
      ? item.source === 'Библиотека' && item.design.id === created.id : item.source === 'Пресет' && item.design.hullId === 'fighter')!;
    expect(choice.quote).toEqual({ cost: { credits: 185, minerals: 11 }, turns: 4 });
    const design = choice.design, snapshot = structuredClone(design); freeze(design);
    const newRun = createCampaignRun(local); if (!newRun.ok) throw new Error(newRun.code);
    let run = newRun.run;
    for (const factionId of sides) {
      for (const kind of ['explore', 'colonize'] as const) run = manual(run, { kind, factionId,
        systemId: factionId === 'blue' ? 'eden' : 'nexus', expectedTurn: run.session.turn });
      run = manual(run, { kind: 'endTurn', ...requestFor(run.session) });
    }
    while (run.session.turn < 29) run = manual(run, { kind: 'endTurn', ...requestFor(run.session) });
    expect(run.session.treasuries).toEqual({ blue: { credits: 380, minerals: 190 }, red: { credits: 380, minerals: 190 } });
    for (const factionId of sides) {
      for (let n = 0; n < 2; n++) run = manual(run, { kind: 'enqueueProduction', factionId, expectedTurn: run.session.turn,
        systemId: factionId === 'blue' ? 'sol' : 'vega', design });
      expect(run.session.treasuries[factionId]).toEqual({ credits: 10, minerals: 168 });
      run = manual(run, { kind: 'endTurn', ...requestFor(run.session) });
    }
    expect(run.session.turn).toBe(31);
    expect(run.session.production.orders.map(item => [item.id, item.remainingTurns])).toEqual([[1, 3], [2, 4], [3, 3], [4, 4]]);
    if (source === 'library') {
      library.saveDesign({ ...snapshot, name: 'Changed after payment' });
      expect(library.load().designs[0].name).toBe('Changed after payment');
      data.delete(ShipDesignManager.STORAGE_KEY); expect(library.load().designs).toEqual([]);
    }
    vi.mocked(storage.getItem).mockClear(); vi.mocked(storage.setItem).mockClear();
    const checkpoint31 = structuredClone(run);
    let resumed = campaignRunSchema.parse(run); // Runtime snapshot validation, NOT a save codec or public conversion.
    while (run.session.turn < 45) {
      run = ai(run).run; resumed = ai(resumed).run; expect(resumed).toEqual(run);
    }
    expect(run.session.production.completed.map(item => item.id)).toEqual([1, 3, 2, 4]);
    expect(run.session.treasuries).toEqual({ blue: { credits: 170, minerals: 248 }, red: { credits: 170, minerals: 248 } });
    for (const factionId of sides) {
      const systemId = factionId === 'blue' ? 'sol' : 'vega', destinationId = factionId === 'blue' ? 'eden' : 'nexus';
      const shipIds = factionId === 'blue' ? [2, 1] : [4, 3], fleetId = factionId === 'blue' ? 1 : 2;
      for (const orderId of shipIds) run = manual(run, { kind: 'deployProduction', factionId, systemId, orderId, expectedTurn: run.session.turn });
      run = manual(run, { kind: 'createFleet', factionId, systemId, shipIds, expectedTurn: run.session.turn });
      run = manual(run, { kind: 'sendFleet', factionId, systemId, destinationId, fleetId, expectedTurn: run.session.turn });
      const checkpoint = campaignRunSchema.parse(run), baseline = ai(run);
      // Diagnostic assignment after legal LOCAL purchases/send: NOT an exposed local→AI API.
      const configured = factionId === 'red' ? { session: checkpoint.session, control: computer } : checkpoint;
      const result = ai(configured);
      expect(result.run.session).toEqual(baseline.run.session); expect(result.summary).toEqual(baseline.summary);
      expect(checkpoint.session.ships.filter(item => item.factionId === factionId).map(item => [item.fuel, item.transit]))
        .toEqual(Array(2).fill([2, { destinationId, remainingTurns: 1 }]));
      run = result.run;
    }
    expect(run.session.turn).toBe(47); expect(run.control).toEqual(computer);
    expect(run.session.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(run.session.production).toEqual({ lastOrderId: 4, orders: [], completed: [] });
    expect(run.session.ships.map(item => [item.id, item.systemId, item.fuel, item.transit])).toEqual([
      [2, 'eden', 2, undefined], [1, 'eden', 2, undefined], [4, 'nexus', 2, undefined], [3, 'nexus', 2, undefined]
    ]);
    expect(run.session.fleets.items.map(item => [item.id, item.systemId, item.shipIds])).toEqual([[1, 'eden', [2, 1]], [2, 'nexus', [4, 3]]]);
    expect(run.session.ships.map(item => item.design)).toEqual(Array(4).fill(snapshot));
    expect(checkpoint31.session.production.orders.map(item => item.design)).toEqual(Array(4).fill(snapshot));
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); expect(design).toEqual(snapshot);
  });
});

describe('detached output and pure runtime dependency boundary', () => {
  it.each(['manual', 'AI'] as const)('%s: captured results, receipt/summary and nested run records never alias', mode => {
    const state = rich(2, 3); state.ships[1].design = state.ships[0].design; state.ships[1].transit = state.ships[0].transit;
    const run: CampaignRun = { session: state, control: mode === 'AI' ? computer : local }, before = structuredClone(run); freeze(run);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), aiExecute = vi.spyOn(executor, 'executeAiTurn');
    const result = mode === 'AI' ? executeRunAiTurn(run, requestFor(state)) : executeRunCommand(run, { kind: 'endTurn', ...requestFor(state) });
    if (!result.ok) throw new Error(result.code);
    const original = structuredClone(result);
    const captured = mode === 'AI' ? aiExecute.mock.results[0].value as executor.AiTurnResult : dispatch.mock.results[0].value as session.SessionResult;
    if (!captured.ok) throw new Error('Expected captured success');
    captured.state.ships[0].design.name = 'Changed dependency result';
    const receipt = 'summary' in captured ? captured.summary.endTurnEconomy : captured.endTurnEconomy!;
    receipt.income.credits = 999; receipt.treasuryAfter.credits = 999; receipt.upkeep.paidCredits = 999;
    if ('summary' in captured) captured.summary.commands[0].factionId = 'blue';
    expect(result).toEqual(original);
    const returnedReceipt = 'summary' in result ? result.summary.endTurnEconomy : result.endTurnEconomy!;
    returnedReceipt.treasuryAfter.credits = 123; returnedReceipt.upkeep.shipCount = 42;
    expect(result.run).toEqual(original.run);
    result.run.session.ships[0].design.slots.find(slot => slot.component)!.component!.name = 'Changed returned module';
    result.run.session.ships[0].transit!.destinationId = 'sol'; result.run.session.fleets.items[0].shipIds.reverse();
    result.run.session.production.orders[0].design.name = 'Changed queued snapshot';
    result.run.session.production.completed[0].design.name = 'Changed completed snapshot';
    result.run.control.mode = 'local';
    expect(result.run.session.ships[1].design).toEqual(before.session.ships[1].design);
    expect(result.run.session.ships[1].transit).toEqual(before.session.ships[1].transit);
    expect(run).toEqual(before);
  });

  it('create/manual/AI/takeover make no clocks, RNG, storage, catalog, factory, network or scheduling calls', () => {
    const run = { session: rich(2, 3), control: computer }, request = requestFor(run.session);
    const action = () => [createCampaignRun(local), createCampaignRun(computer), executeRunAiTurn(run, request),
      executeRunCommand({ ...run, control: local }, { kind: 'endTurn', ...request }), convertRunToLocal(run)];
    const expected = action(), forbidden = (): never => { throw new Error('Forbidden external dependency'); };
    const spies = [vi.spyOn(Math, 'random').mockImplementation(forbidden), vi.spyOn(performance, 'now').mockImplementation(forbidden),
      vi.spyOn(catalog, 'loadProductionCatalog').mockImplementation(forbidden), vi.spyOn(presets, 'createCombatDesign').mockImplementation(forbidden),
      vi.spyOn(designs, 'createDesign').mockImplementation(forbidden), vi.spyOn(designs, 'installComponent').mockImplementation(forbidden),
      vi.spyOn(ShipDesignManager.prototype, 'load').mockImplementation(forbidden), vi.spyOn(ShipDesignManager.prototype, 'saveDesign').mockImplementation(forbidden)];
    const date = vi.fn(forbidden), io = vi.fn(forbidden), storage = vi.fn(forbidden), rng = vi.fn(forbidden);
    vi.stubGlobal('localStorage', undefined); vi.stubGlobal('sessionStorage', undefined);
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, get: storage });
    vi.stubGlobal('Date', Object.assign(date, { now: date })); vi.stubGlobal('crypto', { randomUUID: rng, getRandomValues: rng });
    for (const name of ['fetch', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask']) vi.stubGlobal(name, io);
    let actual: ReturnType<typeof action>;
    try { actual = action(); } finally { vi.unstubAllGlobals(); }
    spies.forEach(spy => { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); });
    for (const spy of [date, io, storage, rng]) expect(spy).not.toHaveBeenCalled();
    expect(actual).toEqual(expected);
  });

  it('follows the new modules runtime import graph, not game entry; no UI/save/Phaser/IO dependencies', () => {
    const root = resolve(import.meta.dirname, '..'), visited = new Set<string>(), packages = new Set<string>();
    function visit(path: string): void {
      if (visited.has(path)) return; visited.add(path);
      const emitted = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false
      } }).outputText;
      const syntax = ts.createSourceFile(path, emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      function walk(node: ts.Node): void {
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === 'require')) throw new Error('Unexpected dynamic runtime dependency');
        ts.forEachChild(node, walk);
      }
      walk(syntax);
      for (const statement of syntax.statements) {
        if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const name = statement.moduleSpecifier.text;
        if (name.startsWith('.')) visit(resolve(dirname(path), name + '.ts')); else packages.add(name);
      }
    }
    visit(resolve(root, 'src/domain/campaignRun.ts')); visit(resolve(root, 'src/domain/campaignControl.ts'));
    expect(packages).toEqual(new Set(['zod']));
    for (const file of visited) expect(file.startsWith(resolve(root, 'src/domain') + '/')).toBe(true);
    for (const name of ['campaignSave', 'combatPresets', 'civilianPresets'])
      expect(visited.has(resolve(root, `src/domain/${name}.ts`))).toBe(false);
    for (const name of ['campaignSession', 'campaignAiExecutor', 'campaignAiPlanner'])
      expect(visited.has(resolve(root, `src/domain/${name}.ts`))).toBe(true);
  });
});