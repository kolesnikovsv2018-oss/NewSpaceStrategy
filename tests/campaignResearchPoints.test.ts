import { expect, it } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand, getConquestView, type Conquest } from '../src/domain/conquest';
import { getDefaultResearchTree, isCampaignDesignAvailable } from '../src/domain/campaignResearch';
import { createDesign, createComponentWithId, installComponent } from '../src/domain/shipDesign';
import { createOperationalState } from '../src/domain/campaignOperations';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { MAX_TURN } from '../src/domain/campaignSession';
import { baselineMatrix, runBaseline, verifyBaseline } from '../src/diagnostics/conquestBaseline';

function apply(state: Conquest, payload: Record<string, unknown>): Conquest {
  const before = structuredClone(state);
  const result = executeConquestCommand(state, { ...payload, factionId: state.session.turn % 2 ? 'blue' : 'red',
    expectedTurn: state.session.turn });
  if (!result.ok) throw new Error(result.message);
  expect(state).toEqual(before);
  return result.state;
}
function round(state: Conquest): Conquest { return apply(apply(state, { kind: 'endTurn' }), { kind: 'endTurn' }); }

it('preserves invested science across A→B→pause→A→B without double spending', () => {
  let state = apply(createConquest(), { kind: 'assignWorkers', systemId: 'sol',
    workers: { industry: 4000, research: 1000, culture: 0 } });
  state = apply(state, { kind: 'research', technologyId: 'engineering' });
  expect(state.session.treasuries.blue).toEqual({ credits: 100, minerals: 50 });
  expect(apply(state, { kind: 'research', technologyId: 'engineering' })).toEqual(state);
  state = round(state);
  expect(state.research.blue.progress).toEqual({ engineering: 1000 });
  state = apply(state, { kind: 'research', technologyId: 'applied' });
  state = round(state);
  expect(state.research.blue.progress).toEqual({ engineering: 1000, applied: 1000 });
  state = apply(state, { kind: 'pauseResearch' });
  expect(apply(state, { kind: 'pauseResearch' })).toEqual(state);
  state = round(state);
  expect(state.colonyOutput.reserves.blue.research).toBe(1000);
  state = apply(state, { kind: 'research', technologyId: 'engineering' });
  const source = structuredClone(state), restored = decodeConquestSave(encodeConquestSave(state));
  expect(round(restored)).toEqual(round(source));
  state = round(restored);
  expect(state.research.blue).toEqual({ activeId: null, completed: ['engineering'], progress: { applied: 1000 } });
  expect(state.colonyOutput.reserves.blue.research).toBe(1000);
  state = apply(state, { kind: 'research', technologyId: 'applied' });
  state = round(state);
  expect(state.research.blue.completed).toEqual(['engineering', 'applied']);
  expect(state.colonyOutput.reserves.blue.research).toBe(1000);
  expect(executeConquestCommand(state, { kind: 'research', technologyId: 'engineering', factionId: 'blue',
    expectedTurn: state.session.turn })).toMatchObject({ ok: false, code: 'RULE_REJECTED' });
});

it.each(['engineering', 'applied', 'support'])('earns a working root effect: %s', id => {
  let state = createConquest();
  const base = createDesign('corvette', true);
  const beam = base.slots.find(slot => slot.id === 'beam_1')!.component;
  if (beam?.kind !== 'beam') throw new Error('Invalid beam');
  const design = id === 'engineering' ? installComponent(base, 'beam_1', { ...beam, damage: 30 })
    : id === 'applied' ? installComponent(base, 'service_1', createComponentWithId('scanner', 'opened-scanner'))
      : installComponent(createDesign('frigate', true), 'armor_1', createComponentWithId('armor', 'opened-armor'));
  expect(isCampaignDesignAvailable(design, state.research.blue, state.researchTree)).toBe(false);
  state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 0, research: 5000, culture: 0 } });
  state = apply(state, { kind: 'research', technologyId: id });
  const forecast = getConquestView(state, 'blue').researchForecast;
  expect(forecast.timing).toEqual({ status: 'completes', remainingOwnTurns: 1 });
  const result = executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
  if (!result.ok) throw new Error(result.message);
  expect(result.turnReceipt?.research).toEqual(forecast.receipt);
  state = result.state;
  expect(state.research.blue.completed).toEqual([id]);
  expect(isCampaignDesignAvailable(design, state.research.blue, state.researchTree)).toBe(true);
  expect(state.population.sol.population).toBe(5100);
  expect(result.turnReceipt?.research.produced).toBe(5000);
  expect(getConquestView(state, 'blue').colonyOutput.forecast.reserves.research.after)
    .toBe(state.colonyOutput.reserves.blue.research + 5000);
});

it('pauses without colonies and preserves progress and reserve across own and enemy ends', () => {
  const state = createConquest();
  state.session.galaxy.systems.find(system => system.id === 'sol')!.ownerId = null;
  state.colonyOutput.assignments.sol = { industry: 0, research: 0, culture: 0 };
  state.research.blue.activeId = 'engineering'; state.research.blue.progress.engineering = 100;
  state.colonyOutput.reserves.blue.research = 5000;
  const checked = conquestSchema.parse(state);
  expect(getConquestView(checked, 'blue').researchForecast.timing).toEqual({ status: 'paused', reason: 'no-colonies' });
  const next = round(checked);
  expect(next.research.blue).toEqual(state.research.blue);
  expect(next.colonyOutput.reserves.blue.research).toBe(5000);
  next.session.galaxy.systems.find(system => system.id === 'sol')!.ownerId = 'blue';
  const recovered = apply(conquestSchema.parse(next), { kind: 'endTurn' });
  expect(recovered.research.blue.completed).toEqual(['engineering']);
  expect(recovered.colonyOutput.reserves.blue.research).toBe(3100);
});

it.each(['mining', 'battle'])('rolls back scientific completion and all payments on a late %s failure', failure => {
  const state = createConquest();
  state.research.blue.completed = ['applied'];
  state.researchJournal.blue = { applied: 1 };
  state.research.blue.activeId = 'engineering'; state.research.blue.progress.engineering = 1999;
  state.colonyOutput.reserves.blue.research = 1;
  state.population.sol = { population: 0, remainder: 0 };
  state.colonyOutput.assignments.sol = { industry: 0, research: 0, culture: 0 };
  const design = failure === 'mining' ? installComponent(createDesign('corvette', true), 'service_1',
    createComponentWithId('mining', 'late-miner')) : createDesign('fighter', true);
  state.session.production.lastOrderId = 2;
  state.session.ships = [{ id: 1, factionId: 'blue', systemId: 'rift', design, fuel: 3 }];
  state.operations = { '1': createOperationalState(design) };
  state.surveys.blue.rift = 'barren';
  if (failure === 'mining') state.session.treasuries.blue.minerals = 999999995;
  else {
    state.lastBattleId = MAX_TURN;
    state.session.ships.push({ id: 2, factionId: 'red', systemId: 'rift', design, fuel: 3 });
    state.operations['2'] = createOperationalState(design);
  }
  const checked = conquestSchema.parse(state), before = structuredClone(checked);
  expect(getConquestView(checked, 'blue').researchForecast.receipt.completedId).toBe('engineering');
  const result = executeConquestCommand(checked, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('state');
  expect(result).not.toHaveProperty('turnReceipt');
  expect(checked).toEqual(before);
});

it('keeps own science observation independent of hidden enemy research and reserves', () => {
  const first = createConquest(), second = structuredClone(first);
  second.research.red = { completed: ['support'], activeId: 'engineering', progress: { engineering: 1999 } };
  second.researchJournal.red = { support: 1 };
  second.colonyOutput.reserves.red.research = 12345;
  const left = getConquestView(first, 'blue'), right = getConquestView(second, 'blue');
  expect(left).toEqual(right);
  expect(planConquestAction(left)).toEqual(planConquestAction(right));
  right.research.progress.engineering = 10;
  expect(first.research.blue.progress).toEqual({});
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
  const command = { kind: 'endTurn', factionId: 'blue', expectedTurn: state.session.turn };
  expect(executeConquestCommand(loaded, command)).toEqual(executeConquestCommand(state, command));
});

it('does not promise a research deadline at the turn limit or after campaign completion', () => {
  const state = createConquest();
  state.session.turn = MAX_TURN;
  expect(getConquestView(state, 'blue').researchForecast.timing).toEqual({ status: 'unavailable', reason: 'turn-limit' });
  state.session.turn = 1;
  for (const system of state.session.galaxy.systems.filter(system => ['sol', 'eden', 'nexus', 'vega'].includes(system.id))) {
    system.ownerId = 'blue';
    state.surveys.blue[system.id] = state.environment[system.id];
    if (!system.exploredBy.includes('blue')) system.exploredBy.push('blue');
  }
  expect(getConquestView(state, 'blue').researchForecast.timing).toEqual({ status: 'unavailable', reason: 'campaign-completed' });
});

it('the actual bounded AI earns science, completes an opening and retains industrial output', () => {
  let state = createConquest();
  let produced = 0, spent = 0, industrial = 0, completed = false;
  for (let window = 0; window < 12 && !completed; window++) {
    const faction = state.session.turn % 2 ? 'blue' : 'red';
    const result = faction === 'blue' ? executeConquestAiTurn(state, 'blue', state.session.turn)
      : executeConquestCommand(state, { kind: 'endTurn', factionId: faction, expectedTurn: state.session.turn });
    if (!result.ok) throw new Error(result.message);
    if (faction === 'blue') {
      const receipt = result.turnReceipt!;
      produced += receipt.research.produced; spent += receipt.research.spent; industrial += receipt.productionPoints;
      expect(receipt.research.produced).toBeGreaterThan(0);
      completed = result.state.research.blue.completed.length > 0;
      expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), 'blue', state.session.turn)).toEqual(result);
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
  expect(Object.values(restored.research.blue.progress).some(value => value > 0)).toBe(true);
  expect(verifyBaseline(run)).toEqual({ repeat: 'passed', roundTrip: 'passed' });
  for (const metric of Object.values(run.metrics)) {
    expect(metric.researchPoints).toBe(metric.researchSpent + metric.researchReserve + metric.researchOverflow);
  }
}, 60000);
