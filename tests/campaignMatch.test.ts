import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runApi from '../src/domain/campaignRun';
import { campaignMatchSchema, campaignScenarioSchema, convertMatchToLocal, createCampaignMatch,
  executeMatchAiTurn, executeMatchCommand, getCampaignOutcome, type CampaignMatch,
  type CampaignScenario, type MatchErrorCode } from '../src/domain/campaignMatch';
import { type CampaignControl } from '../src/domain/campaignControl';
import * as session from '../src/domain/campaignSession';
import * as executor from '../src/domain/campaignAiExecutor';
import * as planner from '../src/domain/campaignAiPlanner';
import { type SystemId } from '../src/domain/campaign';
import { createCombatDesign } from '../src/domain/combatPresets';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { loadProductionCatalog } from '../src/utils/ProductionCatalog';
import { freeze, requestFor, rich, sides } from './fixtures/campaignAi';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const local: CampaignControl = { mode: 'local' };
const computer: CampaignControl = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' };
const completed = { status: 'completed', reason: 'joint-survey-complete' };
const scenarios: CampaignScenario[] = ['sandbox', 'joint-survey-v1'];
function created(control: CampaignControl = local, scenario: CampaignScenario = 'joint-survey-v1'): CampaignMatch {
  const result = createCampaignMatch(control, scenario);
  if (!result.ok) throw Error(result.message);
  expect(result.outcome).toEqual({ status: 'ongoing' });
  return result.match;
}
function reject(result: { ok: boolean }, code: MatchErrorCode): void {
  expect(result).toMatchObject({ ok: false, code });
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|stack|treasuries|exploredBy/);
}
function manual(match: CampaignMatch, command: session.SessionCommand): CampaignMatch {
  const before = structuredClone(match); freeze(match); freeze(command);
  const expected = runApi.executeRunCommand(match.run, command);
  const result = executeMatchCommand(match, command);
  if (!expected.ok || !result.ok) throw Error('Expected successful command');
  expect(result.match.run).toEqual(expected.run);
  expect(result.match.scenario).toBe(match.scenario);
  expect(getCampaignOutcome(result.match)).toEqual({ ok: true, outcome: result.outcome });
  expect(result.endTurnEconomy).toEqual(expected.endTurnEconomy);
  expect(match).toEqual(before); expect(result.match.run).not.toBe(match.run);
  return result.match;
}
function end(match: CampaignMatch): CampaignMatch {
  return manual(match, { kind: 'endTurn', ...requestFor(match.run.session) });
}
function survey(match: CampaignMatch): CampaignMatch {
  const faction = requestFor(match.run.session).factionId;
  const targets: SystemId[] = faction === 'blue' ? ['eden', 'nexus', 'vega', 'dust', 'rift'] : ['nexus', 'eden', 'sol', 'rift', 'dust'];
  for (const systemId of targets) {
    if (match.run.session.galaxy.systems.find(system => system.id === systemId)!.exploredBy.includes(faction)) continue;
    match = manual(match, { kind: 'explore', ...requestFor(match.run.session), systemId });
  }
  return match;
}
function markSurveyed(match: CampaignMatch): void {
  for (const system of match.run.session.galaxy.systems) system.exploredBy = ['blue', 'red'];
}
function commands(state: session.CampaignSession): session.SessionCommand[] {
  const context = requestFor(state), red = context.factionId === 'red';
  const systemId = red ? 'vega' : 'sol', destinationId = red ? 'nexus' : 'eden';
  return [
    { kind: 'explore', ...context, systemId: 'rift' }, { kind: 'colonize', ...context, systemId: destinationId },
    { kind: 'endTurn', ...context }, { kind: 'enqueueProduction', ...context, systemId, design: state.ships[0].design },
    { kind: 'cancelProduction', ...context, systemId, orderId: red ? 211 : 201 },
    { kind: 'deployProduction', ...context, systemId, orderId: red ? 231 : 230 },
    { kind: 'sendShip', ...context, systemId, shipId: red ? 104 : 4, destinationId },
    { kind: 'refuelShip', ...context, systemId, shipId: red ? 104 : 4 },
    { kind: 'createFleet', ...context, systemId, shipIds: red ? [104, 105] : [4, 5] },
    { kind: 'disbandFleet', ...context, systemId, fleetId: red ? 2 : 1 },
    { kind: 'sendFleet', ...context, systemId, fleetId: red ? 2 : 1, destinationId }
  ];
}

describe('campaign match completion boundary', () => {
  it('rejects a completed survey before calling the run command', () => {
    const result = createCampaignMatch({ mode: 'local' }, 'joint-survey-v1');
    if (!result.ok) throw Error(result.message);
    for (const system of result.match.run.session.galaxy.systems) system.exploredBy = ['blue', 'red'];
    const execute = vi.spyOn(runApi, 'executeRunCommand');
    expect(getCampaignOutcome(result.match)).toEqual({ ok: true,
      outcome: { status: 'completed', reason: 'joint-survey-complete' } });
    expect(executeMatchCommand(result.match, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }))
      .toMatchObject({ ok: false, code: 'CAMPAIGN_COMPLETED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps a fully surveyed sandbox ongoing and delegates its command once', () => {
    const result = createCampaignMatch({ mode: 'local' }, 'sandbox');
    if (!result.ok) throw Error(result.message);
    for (const system of result.match.run.session.galaxy.systems) system.exploredBy = ['blue', 'red'];
    const execute = vi.spyOn(runApi, 'executeRunCommand');
    const next = executeMatchCommand(result.match, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    expect(next).toMatchObject({ ok: true, outcome: { status: 'ongoing' },
      match: { scenario: 'sandbox', run: { session: { turn: 2 } } } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('strict schemas and independent derived outcomes', () => {
  it.each([undefined, null, '', 'survey', 'SANDBOX', 'sandbox ', {}, [], 1, { scenario: 'sandbox' }])
  ('rejects scenario %j before creation', scenario => {
    const create = vi.spyOn(runApi, 'createCampaignRun');
    expect(campaignScenarioSchema.safeParse(scenario).success).toBe(false);
    reject(createCampaignMatch(local, scenario), 'INVALID_STATE'); expect(create).not.toHaveBeenCalled();
  });
  it.each([null, {}, { mode: 'human-vs-ai' }, { mode: 'local', aiPolicy: 'expansion-v1' }, { mode: 'human-vs-ai', aiPolicy: 'future' }])
  ('validates control %j before creator', control => {
    const create = vi.spyOn(runApi, 'createCampaignRun');
    reject(createCampaignMatch(control, 'sandbox'), 'INVALID_STATE'); expect(create).not.toHaveBeenCalled();
  });
  it.each(scenarios.flatMap(scenario => [local, computer].map(control => ({ scenario, control }))))
  ('creates independent $scenario/$control.mode with no persisted outcome', ({ scenario, control }) => {
    freeze(control);
    const match = created(control, scenario), other = created(control, scenario);
    expect(Object.keys(match).sort()).toEqual(['run', 'scenario']);
    expect(match).toEqual(other); expect(match.run.control).not.toBe(control);
    match.run.session.treasuries.blue.credits = 0;
    expect(other.run.session.treasuries.blue.credits).toBe(100);
  });
  it.each([null, [], {}, { run: null, scenario: 'sandbox' }, { ...created(), outcome: completed },
    { run: created().run }, created().run, { ...created(), scenario: 'future' }])('rejects malformed match %j', input => {
    const dispatch = vi.spyOn(runApi, 'executeRunCommand'), ai = vi.spyOn(runApi, 'executeRunAiTurn');
    expect(campaignMatchSchema.safeParse(input).success).toBe(false);
    reject(getCampaignOutcome(input), 'INVALID_STATE'); reject(executeMatchCommand(input, null), 'INVALID_STATE');
    reject(executeMatchAiTurn(input, null), 'INVALID_STATE'); reject(convertMatchToLocal(input), 'INVALID_STATE');
    expect(dispatch).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
  });
  it.each(sides.flatMap(side => ['sol', 'eden', 'rift', 'nexus', 'dust', 'vega'].map(id => ({ side, id }))))
  ('one missing $side/$id is ongoing, irrespective of ownership', ({ side, id }) => {
    const match = created(); markSurveyed(match);
    const system = match.run.session.galaxy.systems.find(item => item.id === id)!;
    system.ownerId = null; system.exploredBy = system.exploredBy.filter(item => item !== side);
    expect(getCampaignOutcome(match)).toEqual({ ok: true, outcome: { status: 'ongoing' } });
  });
  it('has no alias between query results and does not store outcome in input', () => {
    const match = created(); markSurveyed(match); const before = structuredClone(match); freeze(match);
    const first = getCampaignOutcome(match), second = getCampaignOutcome(match);
    expect(first).toEqual({ ok: true, outcome: completed }); expect(second).toEqual(first);
    if (!first.ok || !second.ok) throw Error('Expected outcome');
    expect(first.outcome).not.toBe(second.outcome); Object.assign(first.outcome, { status: 'ongoing' });
    expect(second.outcome).toEqual(completed); expect(match).toEqual(before);
  });
  const corruptions: [string, (state: session.CampaignSession) => void][] = [
    ['hidden fuel', state => { state.ships[3].fuel = -1; }],
    ['flight design', state => { state.ships[3].design.slots.forEach(slot => { slot.component = null; }); }],
    ['membership', state => { state.fleets.items[1].shipIds[0] = 999; }],
    ['transit', state => { delete state.ships[0].transit; }],
    ['FIFO', state => { state.production.orders[5].remainingTurns = 2; }],
    ['counter', state => { state.production.lastOrderId = 1; }],
    ['treasury', state => { state.treasuries.red.credits = Infinity; }],
    ['missing fleet state', state => { Reflect.deleteProperty(state, 'fleets'); }],
    ['duplicate exploration', state => { state.galaxy.systems[0].exploredBy.push('blue'); }]
  ];
  it.each(corruptions)('validates complete hidden %s even when all knowledge looks completed', (_name, corrupt) => {
    const match: CampaignMatch = { run: { session: rich(2, 5), control: computer }, scenario: 'joint-survey-v1' };
    markSurveyed(match); corrupt(match.run.session); const before = structuredClone(match); freeze(match);
    reject(getCampaignOutcome(match), 'INVALID_STATE'); reject(executeMatchCommand(match, null), 'INVALID_STATE');
    reject(executeMatchAiTurn(match, null), 'INVALID_STATE'); reject(convertMatchToLocal(match), 'INVALID_STATE');
    expect(match).toEqual(before);
  });
});

describe('all commands and authorization priority', () => {
  const kinds = session.sessionCommandSchema.options.map(option => option.shape.kind.value);
  it.each(kinds.flatMap(kind => sides.flatMap(side => [local, computer].flatMap(control =>
    scenarios.map(scenario => ({ kind, side, control, scenario }))))))
  ('$kind/$side/$control.mode/$scenario', ({ kind, side, control, scenario }) => {
    const match: CampaignMatch = { run: { session: rich(side === 'blue' ? 1 : 2, 5), control }, scenario };
    markSurveyed(match); const command = commands(match.run.session).find(item => item.kind === kind)!;
    const expected = runApi.executeRunCommand(match.run, command), before = structuredClone(match); freeze(match); freeze(command);
    const dispatch = vi.spyOn(runApi, 'executeRunCommand');
    reject(executeMatchCommand(match, { ...command, extra: true }), 'INVALID_COMMAND');
    reject(executeMatchCommand(match, { ...command, expectedTurn: 3 }), 'STALE_TURN');
    reject(executeMatchCommand(match, { ...command, factionId: side === 'blue' ? 'red' : 'blue' }), 'NOT_ACTIVE_FACTION');
    expect(dispatch).not.toHaveBeenCalled();
    const result = executeMatchCommand(match, command);
    if (control.mode === 'human-vs-ai' && side === 'red') reject(result, 'FACTION_CONTROLLED_BY_AI');
    else if (scenario === 'joint-survey-v1') reject(result, 'CAMPAIGN_COMPLETED');
    else {
      expect(dispatch).toHaveBeenCalledTimes(1);
      if (expected.ok) expect(result).toEqual({ ok: true, match: { run: expected.run, scenario }, outcome: { status: 'ongoing' },
        ...(expected.endTurnEconomy ? { endTurnEconomy: expected.endTurnEconomy } : {}) });
      else expect(result).toEqual(expected);
    }
    if (scenario === 'joint-survey-v1' || control.mode === 'human-vs-ai' && side === 'red') expect(dispatch).not.toHaveBeenCalled();
    expect(match).toEqual(before);
  });
  it.each(sides.flatMap(side => [local, computer].flatMap(control => scenarios.map(scenario => ({ side, control, scenario })))))
  ('AI $side/$control.mode/$scenario preserves priority', ({ side, control, scenario }) => {
    const match = created(control, scenario); match.run.session.turn = side === 'blue' ? 1 : 2; markSurveyed(match);
    const request = requestFor(match.run.session), execute = vi.spyOn(runApi, 'executeRunAiTurn');
    reject(executeMatchAiTurn(match, { ...request, extra: true }), 'INVALID_COMMAND');
    reject(executeMatchAiTurn(match, { ...request, expectedTurn: 3 }), 'STALE_TURN');
    reject(executeMatchAiTurn(match, { ...request, factionId: side === 'blue' ? 'red' : 'blue' }), 'NOT_ACTIVE_FACTION');
    expect(execute).not.toHaveBeenCalled();
    const result = executeMatchAiTurn(match, request);
    if (control.mode === 'human-vs-ai' && side === 'blue') reject(result, 'AI_NOT_ASSIGNED');
    else if (scenario === 'joint-survey-v1') reject(result, 'CAMPAIGN_COMPLETED');
    else { expect(result).toMatchObject({ ok: true, outcome: { status: 'ongoing' } }); expect(execute).toHaveBeenCalledTimes(1); }
    if (!result.ok) expect(execute).not.toHaveBeenCalled();
  });
});

describe('reachable completion and transactional limits', () => {
  it('local completes on turn2 by the last manual exploration with no extra endTurn', () => {
    let match = survey(created()); match = end(match);
    const before = structuredClone(match.run.session.treasuries);
    match = survey(match);
    expect(getCampaignOutcome(match)).toEqual({ ok: true, outcome: completed });
    expect(match.run.session.turn).toBe(2); expect(match.run.session.treasuries).toEqual(before);
    expect(before.red).toEqual({ credits: 100, minerals: 50 });
    reject(executeMatchCommand(match, { kind: 'endTurn', ...requestFor(match.run.session) }), 'CAMPAIGN_COMPLETED');
    reject(executeMatchAiTurn(match, requestFor(match.run.session)), 'CAMPAIGN_COMPLETED');
  });
  it('human blue / real AI red completes after five packages at11, not an intermediate exploration', () => {
    let match = survey(created(computer));
    const execute = vi.spyOn(runApi, 'executeRunAiTurn'), policy = vi.spyOn(planner, 'planAiTurn');
    for (let index = 0; index < 5; index++) {
      match = end(match); const before = structuredClone(match); freeze(match);
      const result = executeMatchAiTurn(match, requestFor(match.run.session));
      if (!result.ok) throw Error(result.message);
      expect(result.match.run.session.turn).toBe(match.run.session.turn + 1);
      expect(result.summary.commands[result.summary.commands.length - 1]?.kind).toBe('endTurn');
      expect(result.outcome).toEqual(index === 4 ? completed : { status: 'ongoing' });
      expect(match).toEqual(before); match = result.match;
    }
    expect(match.run.session.turn).toBe(11); expect(execute).toHaveBeenCalledTimes(5); expect(policy).toHaveBeenCalledTimes(5);
    reject(executeMatchCommand(match, { kind: 'endTurn', ...requestFor(match.run.session) }), 'CAMPAIGN_COMPLETED');
    reject(executeMatchAiTurn(match, requestFor(match.run.session)), 'AI_NOT_ASSIGNED');
    expect(execute).toHaveBeenCalledTimes(5);
  });
  it.each(['credits', 'minerals'] as const)('last AI exploration rolls back at late %s cap; accepted blue-end stays', resource => {
    let match = created(computer); markSurveyed(match);
    match.run.session.galaxy.systems.find(system => system.id === 'dust')!.exploredBy = ['blue'];
    match.run.session.treasuries.red[resource] = session.MAX_RESOURCE - (resource === 'credits' ? 10 : 5);
    match = end(match); const before = structuredClone(match); freeze(match);
    const execute = vi.spyOn(session, 'executeSessionCommand');
    reject(executeMatchAiTurn(match, requestFor(match.run.session)), 'RESOURCE_LIMIT');
    expect(execute).toHaveBeenCalledTimes(3); expect(execute.mock.calls.map(call => (call[1] as session.SessionCommand).kind))
      .toEqual(['colonize', 'explore', 'endTurn']);
    expect(match).toEqual(before); expect(match.run.session.treasuries.blue).toEqual({ credits: 110, minerals: 55 });
    expect(getCampaignOutcome(match)).toEqual({ ok: true, outcome: { status: 'ongoing' } });
    const takeover = convertMatchToLocal(match); if (!takeover.ok) throw Error(takeover.message);
    const done = manual(takeover.match, { kind: 'explore', ...requestFor(match.run.session), systemId: 'dust' });
    expect(getCampaignOutcome(done)).toEqual({ ok: true, outcome: completed });
    expect(done.run.session.treasuries).toEqual(before.run.session.treasuries);
  });
  it('MAX_TURN blocks AI, but valid final manual explore does not need a turn increment', () => {
    const match = created(); markSurveyed(match); match.run.session.turn = session.MAX_TURN;
    match.run.session.galaxy.systems.find(system => system.id === 'dust')!.exploredBy = ['blue'];
    reject(executeMatchAiTurn(match, requestFor(match.run.session)), 'TURN_LIMIT');
    const done = manual(match, { kind: 'explore', ...requestFor(match.run.session), systemId: 'dust' });
    expect(done.run.session.turn).toBe(session.MAX_TURN); expect(getCampaignOutcome(done)).toEqual({ ok: true, outcome: completed });
  });
  it.each(sides)('diagnostic %s deficit completes FIFO and arrivals only through the successful AI end', faction => {
    const match: CampaignMatch = { run: { session: rich(faction === 'blue' ? 1 : 2), control: local }, scenario: 'joint-survey-v1' };
    markSurveyed(match); match.run.session.galaxy.systems.find(system => system.id === 'dust')!.exploredBy = [faction === 'blue' ? 'red' : 'blue'];
    match.run.session.treasuries[faction] = { credits: 5, minerals: 5 };
    const expected = runApi.executeRunAiTurn(match.run, requestFor(match.run.session));
    const result = executeMatchAiTurn(match, requestFor(match.run.session));
    if (!expected.ok || !result.ok) throw Error('Expected successful deficit turn');
    expect(result.match.run).toEqual(expected.run); expect(result.outcome).toEqual(completed);
    expect(result.summary.endTurnEconomy.upkeep).toMatchObject({ paidCredits: 25, dueCredits: 100, shortfallCredits: 75 });
    expect(result.match.run.session.ships.filter(ship => ship.factionId === faction && ship.transit)).toEqual([]);
    expect(result.match.run.session.ships.filter(ship => ship.factionId === faction).slice(0, 3).map(ship => ship.fuel)).toEqual([0, 0, 0]);
  });
  it('manual completion preserves diagnostic queues and zero-fuel free/group transits exactly', () => {
    const match: CampaignMatch = { run: { session: rich(2), control: local }, scenario: 'joint-survey-v1' };
    markSurveyed(match); match.run.session.galaxy.systems.find(system => system.id === 'dust')!.exploredBy = ['blue'];
    const before = structuredClone(match); const done = manual(match, { kind: 'explore', factionId: 'red', expectedTurn: 2, systemId: 'dust' });
    expect(done.run.session.production).toEqual(before.run.session.production);
    expect(done.run.session.ships).toEqual(before.run.session.ships); expect(done.run.session.fleets).toEqual(before.run.session.fleets);
    expect(done.run.session.treasuries).toEqual(before.run.session.treasuries);
    expect(getCampaignOutcome(done)).toEqual({ ok: true, outcome: completed });
  });
  it.each(scenarios.flatMap(scenario => [false, true].map(done => ({ scenario, done }))))
  ('takeover is independent/idempotent and preserves $scenario, surveyed=$done', ({ scenario, done }) => {
    const match = created(computer, scenario); if (done) markSurveyed(match); freeze(match);
    const execute = vi.spyOn(session, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    const result = convertMatchToLocal(match); if (!result.ok) throw Error(result.message);
    expect(result.match).toEqual({ ...match, run: { ...match.run, control: local } });
    expect(result.match.run.session).not.toBe(match.run.session);
    expect(result.outcome).toEqual(scenario === 'joint-survey-v1' && done ? completed : { status: 'ongoing' });
    expect(convertMatchToLocal(result.match)).toEqual(result); expect(execute).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
  });
});

describe('paid preset/library cycle, with diagnostic AI assignment only in the comparison branch', () => {
  it.each(['preset', 'library'] as const)('%s paid ships retain snapshots and pending routes at completion', source => {
    const contents = new Map<string, string>();
    const port: StoragePort = { getItem: vi.fn(key => contents.get(key) ?? null), setItem: vi.fn((key, value) => { contents.set(key, value); }) };
    const library = new ShipDesignManager(port), design = createCombatDesign('fighter');
    if (source === 'library') library.saveDesign(design);
    const choice = loadProductionCatalog(library).choices.find(item => source === 'library' ? item.design.id === design.id : item.design.hullId === 'fighter')!;
    const snapshot = structuredClone(choice.design); let match = created();
    for (const systemId of ['eden', 'nexus'] as const) {
      match = manual(match, { kind: 'explore', ...requestFor(match.run.session), systemId });
      match = manual(match, { kind: 'colonize', ...requestFor(match.run.session), systemId }); match = end(match);
    }
    while (match.run.session.turn < 29) match = end(match);
    expect(match.run.session.treasuries).toEqual({ blue: { credits: 380, minerals: 190 }, red: { credits: 380, minerals: 190 } });
    for (const systemId of ['sol', 'vega'] as const) {
      for (let index = 0; index < 2; index++) match = manual(match,
        { kind: 'enqueueProduction', ...requestFor(match.run.session), systemId, design: snapshot });
      match = end(match);
    }
    expect(match.run.session.turn).toBe(31);
    expect(match.run.session.production.orders.map(order => order.remainingTurns)).toEqual([3, 4, 3, 4]);
    if (source === 'library') { library.saveDesign({ ...snapshot, name: 'Changed after payment' }); contents.delete(ShipDesignManager.STORAGE_KEY); }
    vi.mocked(port.getItem).mockClear(); vi.mocked(port.setItem).mockClear();
    while (match.run.session.turn < 45) match = end(match);
    for (const systemId of ['sol', 'vega'] as const) {
      const destinationId = systemId === 'sol' ? 'eden' : 'nexus';
      const records = match.run.session.production.completed.filter(record => record.systemId === systemId);
      for (const record of records) match = manual(match, { kind: 'deployProduction', ...requestFor(match.run.session), systemId, orderId: record.id });
      match = manual(match, { kind: 'createFleet', ...requestFor(match.run.session), systemId, shipIds: records.map(record => record.id) });
      const fleetId = match.run.session.fleets.lastFleetId;
      match = manual(match, { kind: 'sendFleet', ...requestFor(match.run.session), systemId, destinationId, fleetId });
      if (systemId === 'sol') match = end(survey(match));
    }
    for (const systemId of ['eden', 'sol', 'rift'] as const) match = manual(match, { kind: 'explore', ...requestFor(match.run.session), systemId });
    expect(match.run.session.turn).toBe(46);
    const before = structuredClone(match), finished = survey(match);
    expect(getCampaignOutcome(finished)).toEqual({ ok: true, outcome: completed });
    expect(finished.run.session.turn).toBe(46);
    expect(finished.run.session.treasuries).toEqual(before.run.session.treasuries);
    expect(finished.run.session.ships).toEqual(before.run.session.ships);
    expect(finished.run.session.ships.filter(ship => ship.transit)).toHaveLength(2);
    expect(finished.run.session.ships.map(ship => ship.design)).toEqual(Array(4).fill(snapshot));
    const diagnostic: CampaignMatch = { ...before, run: { ...before.run, control: computer } };
    const ai = executeMatchAiTurn(diagnostic, requestFor(diagnostic.run.session));
    if (!ai.ok) throw Error(ai.message);
    expect(ai.outcome).toEqual(completed); expect(ai.match.run.session.turn).toBe(47);
    expect(ai.match.run.session.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
    expect(ai.match.run.session.ships.map(ship => [ship.fuel, ship.transit])).toEqual(Array(4).fill([2, undefined]));
    expect(ai.match.run.session.ships.map(ship => ship.design)).toEqual(Array(4).fill(snapshot));
    expect(port.getItem).not.toHaveBeenCalled(); expect(port.setItem).not.toHaveBeenCalled();
  });
});

describe('fault boundaries without changing real gameplay rules', () => {
  it.each(['query', 'manual', 'ai', 'takeover'] as const)('%s contains input getter exceptions', operation => {
    const input = { get run(): never { throw Error('PRIVATE'); }, scenario: 'sandbox' };
    const result = operation === 'query' ? getCampaignOutcome(input) : operation === 'manual' ? executeMatchCommand(input, null)
      : operation === 'ai' ? executeMatchAiTurn(input, null) : convertMatchToLocal(input);
    reject(result, 'INVALID_STATE');
  });
  it.each(['create', 'query', 'manual', 'ai', 'takeover'] as const)('%s contains full nested refinement exceptions', operation => {
    const match = created(), effect = session.campaignSessionSchema._def.effect;
    if (effect.type !== 'refinement') throw Error('Expected refinement');
    vi.spyOn(effect, 'refinement').mockImplementation(() => { throw Error('PRIVATE'); });
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    const result = operation === 'create' ? createCampaignMatch(local, 'sandbox') : operation === 'query' ? getCampaignOutcome(match)
      : operation === 'manual' ? executeMatchCommand(match, null) : operation === 'ai' ? executeMatchAiTurn(match, null) : convertMatchToLocal(match);
    reject(result, 'INVALID_STATE'); expect(dispatch).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
  });
  it.each(['create', 'takeover'] as const)('%s revalidates returned run rather than accepting a corrupt success', operation => {
    const match = created(), run = structuredClone(match.run); run.session.turn = NaN;
    vi.spyOn(runApi, operation === 'create' ? 'createCampaignRun' : 'convertRunToLocal').mockReturnValue({ ok: true, run });
    reject(operation === 'create' ? createCampaignMatch(local, 'sandbox') : convertMatchToLocal(match), 'INVALID_STATE');
  });
  it.each(['manual', 'ai'] as const)('%s payload getter exception is INVALID_COMMAND', operation => {
    const input = { kind: 'endTurn', get factionId(): never { throw Error('PRIVATE'); }, expectedTurn: 1 };
    reject(operation === 'manual' ? executeMatchCommand(created(), input) : executeMatchAiTurn(created(), input), 'INVALID_COMMAND');
  });
  it.each(['create', 'manual', 'ai', 'takeover'] as const)('%s dependency throws without leaking partial result', operation => {
    const match = created(), before = structuredClone(match); freeze(match);
    const method = operation === 'create' ? 'createCampaignRun' : operation === 'manual' ? 'executeRunCommand'
      : operation === 'ai' ? 'executeRunAiTurn' : 'convertRunToLocal';
    const spy = vi.spyOn(runApi, method).mockImplementation(() => { throw Error('PRIVATE'); });
    const result = operation === 'create' ? createCampaignMatch(local, 'sandbox') : operation === 'manual'
      ? executeMatchCommand(match, { kind: 'endTurn', ...requestFor(match.run.session) }) : operation === 'ai'
        ? executeMatchAiTurn(match, requestFor(match.run.session)) : convertMatchToLocal(match);
    reject(result, operation === 'ai' ? 'AI_EXECUTION_FAILED' : 'INVALID_STATE');
    expect(spy).toHaveBeenCalledTimes(1); expect(match).toEqual(before);
  });
  it.each(['manual', 'ai'] as const)('%s rejects a malformed successful final run', operation => {
    const match = created(); const invalid = structuredClone(match.run); invalid.session.turn = NaN;
    if (operation === 'manual') vi.spyOn(runApi, 'executeRunCommand').mockReturnValue({ ok: true, run: invalid });
    else vi.spyOn(runApi, 'executeRunAiTurn').mockReturnValue({ ok: true, run: invalid, summary: {} as executor.AiTurnSummary });
    reject(operation === 'manual' ? executeMatchCommand(match, { kind: 'endTurn', ...requestFor(match.run.session) })
      : executeMatchAiTurn(match, requestFor(match.run.session)), operation === 'ai' ? 'AI_EXECUTION_FAILED' : 'INVALID_STATE');
  });
  it('final results, receipt and summary are detached from dependency output and input', () => {
    const match = created(), request = requestFor(match.run.session);
    const response = runApi.executeRunAiTurn(match.run, request); if (!response.ok) throw Error(response.message);
    vi.spyOn(runApi, 'executeRunAiTurn').mockReturnValue(response);
    const result = executeMatchAiTurn(match, request); if (!result.ok) throw Error(result.message);
    const before = structuredClone(result); response.run.session.treasuries.blue.credits = 0;
    response.summary.endTurnEconomy.treasuryAfter.credits = 0; response.summary.commands.length = 0;
    expect(result).toEqual(before);
    const command = { kind: 'endTurn', ...request } as const;
    const manualResponse = runApi.executeRunCommand(match.run, command); if (!manualResponse.ok) throw Error(manualResponse.message);
    vi.spyOn(runApi, 'executeRunCommand').mockReturnValue(manualResponse);
    const manualResult = executeMatchCommand(match, command); const copy = structuredClone(manualResult);
    manualResponse.endTurnEconomy!.treasuryAfter.credits = 0;
    expect(manualResult).toEqual(copy);
  });
  it('does not touch clock, RNG, storage, network or scheduler', () => {
    const forbidden = (): never => { throw Error('PRIVATE side effect'); };
    vi.spyOn(Date, 'now').mockImplementation(forbidden); vi.spyOn(Math, 'random').mockImplementation(forbidden);
    for (const name of ['localStorage', 'fetch', 'setTimeout', 'setInterval', 'requestAnimationFrame']) vi.stubGlobal(name, forbidden);
    const match = created(); expect(getCampaignOutcome(match).ok).toBe(true);
    expect(executeMatchCommand(match, { kind: 'endTurn', ...requestFor(match.run.session) }).ok).toBe(true);
    expect(executeMatchAiTurn(match, requestFor(match.run.session)).ok).toBe(true);
    expect(convertMatchToLocal(match).ok).toBe(true);
  });
});