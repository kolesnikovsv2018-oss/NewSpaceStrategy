import { expect, it } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand, getConquestOutcome, getConquestView, type Conquest } from '../src/domain/conquest';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';
import { getPopulationTechnologyForecast } from '../src/domain/campaignPopulation';
import { getColonyWorldType } from '../src/domain/campaignColonyEffects';
import { getDefaultResearchTree, researchTreeSchema } from '../src/domain/campaignResearch';
import { planConquestAction, executeConquestAiTurn } from '../src/domain/conquestAi';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { validateGalaxyMap } from '../src/domain/galaxyMap';
import { createOperationalState } from '../src/domain/campaignOperations';
import { createDesign, createComponentWithId, installComponent } from '../src/domain/shipDesign';
import { finishWorkTravel } from './fixtures/colonyWork';
import { activeOf } from './fixtures/conquestSides';

function apply(state: Conquest, command: Record<string, unknown>): Conquest {
  const before = structuredClone(state);
  const result = executeConquestCommand(state, { factionId: activeOf(state),
    expectedTurn: state.session.schedule.turn, ...command });
  expect(state).toEqual(before);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
function round(state: Conquest) { return apply(apply(state, { kind: 'endTurn' }), { kind: 'endTurn' }); }
function earn(state: Conquest, technologyId: string): Conquest {
  state = apply(state, { kind: 'research', technologyId });
  for (let index = 0; index < 12 && !state.research['player-01'].completed.includes(technologyId); index++) state = round(state);
  expect(state.research['player-01'].completed).toContain(technologyId);
  return state;
}
function start() {
  const generated = generateBrowserGalaxy(8, 41);
  if (!generated.ok) throw new Error(generated.message);
  let state = createConquest(undefined, undefined, 41, generated.map);
  const home = state.session.ships[0].systemId;
  state = apply(state, { kind: 'assignWorkers', systemId: home,
    workers: { industry: 1000, research: 4000, culture: 0 } });
  return { state, home, target: generated.map.worlds.find(world => world.type === 'toxic')!.id,
    barren: generated.map.worlds.find(world => world.type === 'barren')!.id };
}
function arrive() {
  const setup = start();
  let state = setup.state;
  for (const technologyId of ['engineering', 'support', 'ordnance', 'capital']) state = earn(state, technologyId);
  state = apply(state, { kind: 'sendShip', systemId: setup.home, shipId: 1, destinationId: setup.target });
  return { ...setup, state: finishWorkTravel(state, 1) };
}

it('keeps detection, paid survey, earned adaptation and paid founding as four distinct gates', () => {
  const setup = start(), initial = getConquestView(setup.state, 'player-01');
  expect(initial.environmentKnowledge).not.toHaveProperty(setup.target);
  expect(initial.galaxy.systems.find(world => world.id === setup.target)).not.toHaveProperty('habitable');
  expect(executeConquestCommand(setup.state, { kind: 'survey', systemId: setup.target,
    factionId: 'player-01', expectedTurn: 1 })).toMatchObject({ ok: false, code: 'OUT_OF_REACH' });
  let { state, target, home } = arrive();
  const detected = getConquestView(state, 'player-01');
  expect(detected.galaxy.systems.find(world => world.id === target)).toMatchObject({ visibility: 'explored', habitable: false });
  expect(detected.environmentKnowledge).not.toHaveProperty(target);
  expect(executeConquestCommand(state, { kind: 'colonize', systemId: target, shipId: 1,
    factionId: 'player-01', expectedTurn: state.session.schedule.turn })).toMatchObject({ ok: false, code: 'NOT_SURVEYED' });
  const treasury = { ...state.session.treasuries['player-01'] }, turn = state.session.schedule.turn;
  state = apply(state, { kind: 'survey', systemId: target });
  expect(state.session.treasuries['player-01']).toEqual({ credits: treasury.credits - 10, minerals: treasury.minerals - 5 });
  expect(state.session.schedule.turn).toBe(turn);
  expect(getConquestView(state, 'player-02').environmentKnowledge).not.toHaveProperty(target);
  expect(getConquestView(state, 'player-01').colonization.find(world => world.systemId === target)?.quote)
    .toMatchObject({ ok: false, code: 'ADAPTATION_REQUIRED' });
  expect(executeConquestCommand(state, { kind: 'colonize', systemId: target, shipId: 1,
    factionId: 'player-01', expectedTurn: turn })).toMatchObject({ ok: false, code: 'ADAPTATION_REQUIRED' });
  expect(executeConquestCommand(state, { kind: 'survey', systemId: target,
    factionId: 'player-01', expectedTurn: turn })).toMatchObject({ ok: false, code: 'ALREADY_SURVEYED' });
  const map = structuredClone(state.session.galaxy.map), environment = structuredClone(state.environment);
  state = earn(state, 'toxic-adaptation');
  expect(state.environment).toEqual(environment);
  expect(state.session.galaxy.map).toEqual(map);
  expect(state.population[target].population).toBe(0);
  expect(getPopulationTechnologyForecast(state.rules.population, 'toxic', []).capacity.total).toBe(6000);
  const saved = decodeConquestSave(encodeConquestSave(state));
  expect(apply(saved, { kind: 'colonize', systemId: target, shipId: 1 }))
    .toEqual(apply(state, { kind: 'colonize', systemId: target, shipId: 1 }));
  const before = state.population[home].population;
  state = apply(saved, { kind: 'colonize', systemId: target, shipId: 1 });
  expect(state.population[target]).toEqual({ population: 1000, remainder: 0 });
  expect(state.population[home].population).toBe(before - 1000);
  expect(state.session.ships.some(ship => ship.id === 1)).toBe(false);
  expect(getConquestView(state, 'player-01').population.find(world => world.systemId === target)?.capacity).toBe(6000);
});

it('retains surveyed type after departure without revealing current hidden ownership', () => {
  let { state, target, home } = arrive();
  state = apply(state, { kind: 'survey', systemId: target });
  state = apply(state, { kind: 'sendShip', systemId: target, shipId: 1, destinationId: home });
  state = round(state);
  const view = getConquestView(state, 'player-01');
  expect(view.environmentKnowledge[target]).toBe('toxic');
  expect(view.galaxy.systems.find(world => world.id === target)).not.toHaveProperty('ownerId');
  expect(decodeConquestSave(encodeConquestSave(state))).toEqual(state);
  const hiddenChange = structuredClone(state);
  hiddenChange.environment[target] = 'habitable';
  expect(getConquestView(hiddenChange, 'player-01')).toEqual(view);
  expect(planConquestAction(getConquestView(hiddenChange, 'player-01'))).toEqual(planConquestAction(view));
});

it.each(['credits', 'minerals'] as const)('rejects insufficient survey %s without consuming the other resource', resource => {
  const { state, target } = arrive();
  state.session.treasuries['player-01'][resource] = resource === 'credits' ? 9 : 4;
  const before = structuredClone(state);
  expect(executeConquestCommand(state, { kind: 'survey', systemId: target, factionId: 'player-01',
    expectedTurn: state.session.schedule.turn })).toMatchObject({ ok: false, code: 'INSUFFICIENT_RESOURCES' });
  expect(state).toEqual(before);
});

it('blocks survey with enemies, and occupation preserves toxic residents without giving adaptation', () => {
  const { state, target } = arrive();
  const defender = createDesign('fighter', true);
  state.session.ships.push({ id: 3, factionId: 'player-02', systemId: target, design: defender, fuel: 3000 });
  state.session.production.lastOrderId = 3;
  state.operations['3'] = createOperationalState(defender);
  expect(executeConquestCommand(state, { kind: 'survey', systemId: target, factionId: 'player-01',
    expectedTurn: state.session.schedule.turn }).ok).toBe(false);
  state.session.ships = state.session.ships.filter(ship => ship.id !== 3);
  delete state.operations['3'];
  const attacker = installComponent(createDesign('fighter', true), 'beam_1', createComponentWithId('beam', 'attacker'));
  state.session.ships.push({ id: 4, factionId: 'player-01', systemId: target, design: attacker, fuel: 3000 });
  state.session.production.lastOrderId = 4;
  state.operations['4'] = createOperationalState(attacker);
  const neutralArrival = apply(conquestSchema.parse(state), { kind: 'endTurn' });
  expect(neutralArrival.session.galaxy.systems.find(world => world.id === target)?.ownerId).toBeNull();
  expect(neutralArrival.population[target].population).toBe(0);
  expect(neutralArrival.surveys['player-01']).not.toHaveProperty(target);
  const world = state.session.galaxy.systems.find(world => world.id === target)!;
  world.ownerId = 'player-02'; world.exploredBy.push('player-02');
  state.surveys['player-02'][target] = 'toxic';
  state.population[target] = { population: 2500, remainder: 17 };
  const next = apply(conquestSchema.parse(state), { kind: 'endTurn' });
  expect(next.session.galaxy.systems.find(world => world.id === target)?.ownerId).toBe('player-01');
  expect(next.population[target]).toEqual({ population: 2500, remainder: 17 });
  expect(next.surveys['player-01'][target]).toBe('toxic');
  expect(next.research['player-01'].completed).not.toContain('toxic-adaptation');
  expect(decodeConquestSave(encodeConquestSave(next))).toEqual(next);
});

it('does not reveal hidden runtime types through observation, legal errors or the AI plan', () => {
  const setup = arrive(), first = setup.state, second = structuredClone(first);
  second.environment[setup.target] = 'habitable';
  expect(getConquestView(first, 'player-01')).toEqual(getConquestView(second, 'player-01'));
  expect(planConquestAction(getConquestView(first, 'player-01'))).toEqual(planConquestAction(getConquestView(second, 'player-01')));
  const command = { kind: 'colonize', systemId: setup.target, shipId: 1, factionId: 'player-01', expectedTurn: first.session.schedule.turn };
  expect(executeConquestCommand(first, command)).toEqual(executeConquestCommand(second, command));
});

it('uses runtime types for capacity and output without changing the initial victory targets or validating a new generator profile', () => {
  const setup = start(), state = setup.state, originalMap = structuredClone(state.session.galaxy.map);
  const total = getConquestView(state, 'player-01').totalHabitableWorlds;
  const outcome = getConquestOutcome(state);
  state.environment[setup.home] = 'toxic'; state.surveys['player-01'][setup.home] = 'toxic';
  const changed = conquestSchema.parse(state), view = getConquestView(changed, 'player-01');
  expect(getColonyWorldType(changed.session.galaxy, setup.home, changed.environment)).toBe('toxic');
  expect(view.population.find(world => world.systemId === setup.home)?.capacity).toBe(6000);
  expect(view.totalHabitableWorlds).toBe(total);
  expect(changed.session.galaxy.map).toEqual(originalMap);
  expect(validateGalaxyMap(changed.session.galaxy.map).ok).toBe(true);
  expect(getConquestOutcome(changed)).toEqual(outcome);
  const missing = structuredClone(changed);
  delete missing.environment[setup.target];
  expect(conquestSchema.safeParse(missing).success).toBe(false);
});

it('allows a diagnostic runtime improvement of initial barren without changing the canonical checker or military denominator', () => {
  const { state, barren } = start(), before = getConquestView(state, 'player-01').totalHabitableWorlds;
  const map = structuredClone(state.session.galaxy.map);
  state.environment[barren] = 'habitable';
  state.population[barren] = { population: 0, remainder: 0 };
  state.colonyOutput.assignments[barren] = { industry: 0, research: 0, culture: 0 };
  const changed = state.session.galaxy.systems.find(world => world.id === barren)!;
  changed.ownerId = 'player-01'; changed.exploredBy.push('player-01'); state.surveys['player-01'][barren] = 'habitable';
  const checked = conquestSchema.parse(state);
  expect(getConquestView(checked, 'player-01').population.find(world => world.systemId === barren)?.capacity).toBe(10000);
  expect(getConquestView(checked, 'player-01').totalHabitableWorlds).toBe(before);
  expect(checked.session.galaxy.map).toEqual(map);
  expect(validateGalaxyMap(checked.session.galaxy.map).ok).toBe(true);
  for (const world of checked.session.galaxy.systems) {
    if (world.id === barren) { world.ownerId = null; continue; }
    world.ownerId = 'player-01';
    if (!world.exploredBy.includes('player-01')) world.exploredBy.push('player-01');
    checked.surveys['player-01'][world.id] = checked.environment[world.id];
  }
  expect(getConquestOutcome(conquestSchema.parse(checked))).toEqual({ status: 'completed', winner: 'player-01', reason: 'all-planets' });
  const restored = decodeConquestSave(encodeConquestSave(checked));
  expect(restored.environment[barren]).toBe('habitable');
  expect(restored.session.galaxy.map!.worlds.find(world => world.id === barren)?.type).toBe('barren');
});

it('applies all five earned N09 selectors to toxic with unchanged caps and completed-S0 growth', () => {
  const setup = start();
  let state = setup.state;
  state.environment[setup.home] = 'toxic'; state.surveys['player-01'][setup.home] = 'toxic';
  state = conquestSchema.parse(state);
  for (const id of ['engineering', 'biology', 'biosphere', 'automation', 'applied', 'scientific-method', 'cultural-practices']) {
    state = earn(state, id);
  }
  state = apply(state, { kind: 'assignWorkers', systemId: setup.home,
    workers: { industry: 400, research: 300, culture: 300 } });
  const view = getConquestView(state, 'player-01'), colony = view.population.find(world => world.systemId === setup.home)!;
  expect(colony.capacity).toBe(8000);
  expect(colony.technology.growthRate.total).toBe(240);
  expect(view.colonyOutput.forecast.production.find(world => world.systemId === setup.home))
    .toMatchObject({ productionPoints: 480, sciencePoints: 360, culturePoints: 360 });
  expect(view.colonyOutput.reserveCaps.research).toBe(colony.population * 10);
  expect(view.colonyOutput.reserveCaps.culture).toBe(colony.population * 10);
  state.research['player-01'].completed = state.research['player-01'].completed.filter(id => id !== 'biosphere');
  delete state.researchJournal['player-01'].biosphere;
  state.research['player-01'].activeId = 'biosphere'; state.research['player-01'].progress.biosphere = 3999;
  state.colonyOutput.reserves['player-01'].research = 1;
  state.population[setup.home] = { population: 5999, remainder: 0 };
  const next = apply(conquestSchema.parse(state), { kind: 'endTurn' });
  expect(next.research['player-01'].completed).toContain('biosphere');
  expect(next.population[setup.home].population).toBe(6000);
  expect(getConquestView(next, 'player-01').population.find(world => world.systemId === setup.home)?.capacity).toBe(8000);
});

it('does not leak an unstudied barren type through mining income or allow colonization after its survey', () => {
  const state = createConquest();
  state.research['player-01'].completed = ['applied']; state.researchJournal['player-01'] = { applied: 1 };
  const design = installComponent(createDesign('corvette', true), 'service_1', createComponentWithId('mining', 'miner'));
  state.session.production.lastOrderId = 3;
  state.session.ships.push({ id: 3, factionId: 'player-01', systemId: 'rift', fuel: 3000, design });
  state.operations['3'] = createOperationalState(design);
  expect(getConquestView(state, 'player-01').income.minerals).toBe(5000);
  const studied = apply(conquestSchema.parse(state), { kind: 'survey', systemId: 'rift' });
  expect(getConquestView(studied, 'player-01').income.minerals).toBe(5008);
  expect(getConquestView(studied, 'player-01').colonization.find(world => world.systemId === 'rift')?.quote)
    .toMatchObject({ ok: false, code: 'UNINHABITABLE' });
});

it('rejects a tree missing its only reachable adaptation and rejects previous military versions', () => {
  const tree = getDefaultResearchTree();
  tree.nodes = tree.nodes.filter(node => node.id !== 'toxic-adaptation');
  expect(researchTreeSchema.safeParse(tree).success).toBe(false);
  const envelope = JSON.parse(encodeConquestSave(start().state));
  for (const schemaVersion of [10, 11]) expect(() => decodeConquestSave(JSON.stringify({ ...envelope, schemaVersion }))).toThrow();
  delete envelope.conquest.surveys;
  expect(() => decodeConquestSave(JSON.stringify(envelope))).toThrow();
});

it('the bounded own-view AI legally surveys and earns adaptation on a real eight-world map', () => {
  const setup = start();
  let state = setup.state, surveyed = false;
  for (let turn = 0; turn < 100 && getConquestOutcome(state).status === 'ongoing'; turn++) {
    if (state.session.schedule.turn % 2) {
      const result = executeConquestAiTurn(state, 'player-01', state.session.schedule.turn);
      if (!result.ok) throw new Error(result.message);
      state = result.state;
    } else state = apply(state, { kind: 'endTurn' });
    surveyed ||= state.surveys['player-01'][setup.target] === 'toxic';
  }
  expect(surveyed).toBe(true);
  expect(state.research['player-01'].completed).toContain('toxic-adaptation');
  expect(state.session.galaxy.systems.find(world => world.id === setup.target)?.ownerId).toBe('player-01');
  expect(getConquestOutcome(state)).toMatchObject({ status: 'completed', winner: 'player-01' });
}, 60000);
