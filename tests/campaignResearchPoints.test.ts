import { expect, it } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand, getConquestView, type Conquest } from '../src/domain/conquest';
import { getDefaultResearchTree, isCampaignDesignAvailable } from '../src/domain/campaignResearch';
import { createDesign, createComponentWithId, installComponent } from '../src/domain/shipDesign';
import { createOperationalState } from '../src/domain/campaignOperations';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { MAX_TURN } from '../src/domain/campaignSession';
import { baselineMatrix, runBaseline, verifyBaseline } from '../src/diagnostics/conquestBaseline';
import { activeOf } from './fixtures/conquestSides';

function apply(state: Conquest, payload: Record<string, unknown>): Conquest {
  const before = structuredClone(state);
  const result = executeConquestCommand(state, { ...payload, factionId: activeOf(state),
    expectedTurn: state.session.schedule.turn });
  if (!result.ok) throw new Error(result.message);
  expect(state).toEqual(before);
  return result.state;
}
function round(state: Conquest): Conquest { return apply(apply(state, { kind: 'endTurn' }), { kind: 'endTurn' }); }

it('preserves invested science across A→B→pause→A→B without double spending', () => {
  let state = apply(createConquest(), { kind: 'assignWorkers', systemId: 'sol',
    workers: { industry: 4000, research: 1000, culture: 0 } });
  state = apply(state, { kind: 'research', technologyId: 'engineering' });
  expect(state.session.treasuries['player-01']).toEqual({ credits: 100, minerals: 50 });
  expect(apply(state, { kind: 'research', technologyId: 'engineering' })).toEqual(state);
  state = round(state);
  expect(state.research['player-01'].progress).toEqual({ engineering: 1000 });
  state = apply(state, { kind: 'research', technologyId: 'applied' });
  state = round(state);
  expect(state.research['player-01'].progress).toEqual({ engineering: 1000, applied: 1000 });
  state = apply(state, { kind: 'pauseResearch' });
  expect(apply(state, { kind: 'pauseResearch' })).toEqual(state);
  state = round(state);
  expect(state.colonyOutput.reserves['player-01'].research).toBe(1000);
  state = apply(state, { kind: 'research', technologyId: 'engineering' });
  const source = structuredClone(state), restored = decodeConquestSave(encodeConquestSave(state));
  expect(round(restored)).toEqual(round(source));
  state = round(restored);
  expect(state.research['player-01']).toEqual({ activeId: null, completed: ['engineering'], progress: { applied: 1000 } });
  expect(state.colonyOutput.reserves['player-01'].research).toBe(1000);
  state = apply(state, { kind: 'research', technologyId: 'applied' });
  state = round(state);
  expect(state.research['player-01'].completed).toEqual(['engineering', 'applied']);
  expect(state.colonyOutput.reserves['player-01'].research).toBe(1000);
  expect(executeConquestCommand(state, { kind: 'research', technologyId: 'engineering', factionId: 'player-01',
    expectedTurn: state.session.schedule.turn })).toMatchObject({ ok: false, code: 'RULE_REJECTED' });
});

it.each(['engineering', 'applied', 'support'])('earns a working root effect: %s', id => {
  let state = createConquest();
  const base = createDesign('corvette', true);
  const beam = base.slots.find(slot => slot.id === 'beam_1')!.component;
  if (beam?.kind !== 'beam') throw new Error('Invalid beam');
  const design = id === 'engineering' ? installComponent(base, 'beam_1', { ...beam, damage: 30 })
    : id === 'applied' ? installComponent(base, 'service_1', createComponentWithId('scanner', 'opened-scanner'))
      : installComponent(createDesign('frigate', true), 'armor_1', createComponentWithId('armor', 'opened-armor'));
  expect(isCampaignDesignAvailable(design, state.research['player-01'], state.researchTree)).toBe(false);
  state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 0, research: 5000, culture: 0 } });
  state = apply(state, { kind: 'research', technologyId: id });
  const forecast = getConquestView(state, 'player-01').researchForecast;
  expect(forecast.timing).toEqual({ status: 'completes', remainingOwnTurns: 1 });
  const result = executeConquestCommand(state, { kind: 'endTurn', factionId: 'player-01', expectedTurn: 1 });
  if (!result.ok) throw new Error(result.message);
  expect(result.turnReceipt?.research).toEqual(forecast.receipt);
  state = result.state;
  expect(state.research['player-01'].completed).toEqual([id]);
  expect(isCampaignDesignAvailable(design, state.research['player-01'], state.researchTree)).toBe(true);
  expect(state.population.sol.population).toBe(5100);
  expect(result.turnReceipt?.research.produced).toBe(5000);
  expect(getConquestView(state, 'player-01').colonyOutput.forecast.reserves.research.after)
    .toBe(state.colonyOutput.reserves['player-01'].research + 5000);
});

it('pauses without colonies and preserves progress and reserve across own and enemy ends', () => {
  const state = createConquest();
  state.session.galaxy.systems.find(system => system.id === 'sol')!.ownerId = null;
  state.colonyOutput.assignments.sol = { industry: 0, research: 0, culture: 0 };
  state.research['player-01'].activeId = 'engineering'; state.research['player-01'].progress.engineering = 100;
  state.colonyOutput.reserves['player-01'].research = 5000;
  const checked = conquestSchema.parse(state);
  expect(getConquestView(checked, 'player-01').researchForecast.timing).toEqual({ status: 'paused', reason: 'no-colonies' });
  const next = round(checked);
  expect(next.research['player-01']).toEqual(state.research['player-01']);
  expect(next.colonyOutput.reserves['player-01'].research).toBe(5000);
  next.session.galaxy.systems.find(system => system.id === 'sol')!.ownerId = 'player-01';
  const recovered = apply(conquestSchema.parse(next), { kind: 'endTurn' });
  expect(recovered.research['player-01'].completed).toEqual(['engineering']);
  expect(recovered.colonyOutput.reserves['player-01'].research).toBe(3100);
});

it.each(['mining', 'battle'])('rolls back scientific completion and all payments on a late %s failure', failure => {
  const state = createConquest();
  state.research['player-01'].completed = ['applied'];
  state.researchJournal['player-01'] = { applied: 1 };
  state.research['player-01'].activeId = 'engineering'; state.research['player-01'].progress.engineering = 1999;
  state.colonyOutput.reserves['player-01'].research = 1;
  state.population.sol = { population: 0, remainder: 0 };
  state.colonyOutput.assignments.sol = { industry: 0, research: 0, culture: 0 };
  const design = failure === 'mining' ? installComponent(createDesign('corvette', true), 'service_1',
    createComponentWithId('mining', 'late-miner')) : createDesign('fighter', true);
  state.session.production.lastOrderId = 2;
  state.session.ships = [{ id: 1, factionId: 'player-01', systemId: 'rift', design, fuel: 3 }];
  state.operations = { '1': createOperationalState(design) };
  state.surveys['player-01'].rift = 'barren';
  if (failure === 'mining') state.session.treasuries['player-01'].minerals = 999999995;
  else {
    state.lastBattleId = MAX_TURN;
    state.session.ships.push({ id: 2, factionId: 'player-02', systemId: 'rift', design, fuel: 3 });
    state.operations['2'] = createOperationalState(design);
  }
  const checked = conquestSchema.parse(state), before = structuredClone(checked);
  expect(getConquestView(checked, 'player-01').researchForecast.receipt.completedId).toBe('engineering');
  const result = executeConquestCommand(checked, { kind: 'endTurn', factionId: 'player-01', expectedTurn: 1 });
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('state');
  expect(result).not.toHaveProperty('turnReceipt');
  expect(checked).toEqual(before);
});

it('keeps own science observation independent of hidden enemy research and reserves', () => {
  const first = createConquest(), second = structuredClone(first);
  second.research['player-02'] = { completed: ['support'], activeId: 'engineering', progress: { engineering: 1999 } };
  second.researchJournal['player-02'] = { support: 1 };
  second.colonyOutput.reserves['player-02'].research = 12345;
  const left = getConquestView(first, 'player-01'), right = getConquestView(second, 'player-01');
  expect(left).toEqual(right);
  expect(planConquestAction(left)).toEqual(planConquestAction(right));
  right.research.progress.engineering = 10;
  expect(first.research['player-01'].progress).toEqual({});
});

it('keeps a saved research snapshot independent of the external tree and repeats the next full command', () => {
  const external = getDefaultResearchTree();
  let state = createConquest({ mode: 'local' }, external);
  state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 4999, research: 1, culture: 0 } });
  state = round(apply(state, { kind: 'research', technologyId: 'engineering' }));
  const json = encodeConquestSave(state);
  external.nodes[0].researchCost = 1;
  external.nodes[0].effects = [{ kind: 'component-unlock', component: 'armor' }];
  const loaded = decodeConquestSave(json);
  expect(loaded.researchTree.nodes[0].researchCost).toBe(2000);
  const command = { kind: 'endTurn', factionId: 'player-01', expectedTurn: state.session.schedule.turn };
  expect(executeConquestCommand(loaded, command)).toEqual(executeConquestCommand(state, command));
});

it('does not promise a research deadline at the turn limit or after campaign completion', () => {
  const state = createConquest();
  state.session.schedule = { order: state.session.schedule.order, activeIndex: 0, turn: MAX_TURN, revision: MAX_TURN - 1, round: MAX_TURN };
  expect(getConquestView(state, 'player-01').researchForecast.timing).toEqual({ status: 'unavailable', reason: 'turn-limit' });
  state.session.schedule = { order: state.session.schedule.order, activeIndex: 0, turn: 1, revision: 0, round: 1 };
  for (const system of state.session.galaxy.systems.filter(system => ['sol', 'eden', 'nexus', 'vega'].includes(system.id))) {
    system.ownerId = 'player-01';
    state.surveys['player-01'][system.id] = state.environment[system.id];
    if (!system.exploredBy.includes('player-01')) system.exploredBy.push('player-01');
  }
  expect(getConquestView(state, 'player-01').researchForecast.timing).toEqual({ status: 'unavailable', reason: 'campaign-completed' });
});

it('the actual bounded AI earns science, completes an opening and retains industrial output', () => {
  let state = createConquest();
  let produced = 0, spent = 0, industrial = 0, completed = false;
  for (let window = 0; window < 12 && !completed; window++) {
    const faction = activeOf(state);
    const result = faction === 'player-01' ? executeConquestAiTurn(state, 'player-01', state.session.schedule.turn)
      : executeConquestCommand(state, { kind: 'endTurn', factionId: faction, expectedTurn: state.session.schedule.turn });
    if (!result.ok) throw new Error(result.message);
    if (faction === 'player-01') {
      const receipt = result.turnReceipt!;
      produced += receipt.research.produced; spent += receipt.research.spent; industrial += receipt.productionPoints;
      expect(receipt.research.produced).toBeGreaterThan(0);
      completed = result.state.research['player-01'].completed.length > 0;
      expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), 'player-01', state.session.schedule.turn)).toEqual(result);
    }
    state = result.state;
  }
  expect(completed).toBe(true);
  expect(spent).toBeGreaterThanOrEqual(2000);
  expect(produced).toBeGreaterThanOrEqual(spent);
  expect(industrial).toBeGreaterThan(0);
});

it('checkpoints a real partially funded research before short games finish and accounts for all science', () => {
  const input = baselineMatrix().find(input => input.kind === 'paid' && input.worldCount === 6 && input.schedule === 'current-ai')!;
  const run = runBaseline({ ...input, maxTurns: 16 });
  expect(run.checkpoint?.turnsExecuted).toBe(4);
  const restored = decodeConquestSave(run.checkpoint!.json);
  expect(Object.values(restored.research['player-01'].progress).some(value => value > 0)).toBe(true);
  expect(verifyBaseline(run)).toEqual({ repeat: 'passed', roundTrip: 'passed' });
  for (const metric of Object.values(run.metrics)) {
    expect(metric.researchPoints).toBe(metric.researchSpent + metric.researchReserve + metric.researchOverflow);
  }
}, 60000);
