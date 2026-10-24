import { expect, it } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand, getConquestView, type Conquest } from '../src/domain/conquest';
import { calculateColonyValue, getCompletedColonyEffects } from '../src/domain/campaignColonyEffects';
import { populationGrowth, getPopulationTechnologyForecast } from '../src/domain/campaignPopulation';
import { createDefaultRulesSnapshot, rulesEffectSchema, type NumericModifierEffect } from '../src/domain/campaignRules';
import { researchTreeSchema } from '../src/domain/campaignResearch';
import { getConquestResearchUtility, planConquestAction } from '../src/domain/conquestAi';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { createCombatDesign } from '../src/domain/combatPresets';
import { createOperationalState } from '../src/domain/campaignOperations';
import { MAX_TURN } from '../src/domain/campaignSession';

function apply(state: Conquest, payload: Record<string, unknown>): Conquest {
  const result = executeConquestCommand(state, { factionId: state.session.turn % 2 ? 'blue' : 'red',
    expectedTurn: state.session.turn, ...payload });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
function complete(state: Conquest, ids: string[]): void {
  state.research.blue.completed = ids;
  state.researchJournal.blue = Object.fromEntries(ids.map(id => [id, 1]));
}
function effect(overrides: Partial<NumericModifierEffect> = {}): NumericModifierEffect {
  return { kind: 'modifier', id: 'test-output', target: 'science-output', scope: 'own-colonies',
    worldType: 'habitable', unit: 'percent', operation: 'add', value: 0.1, cap: null,
    stackingGroup: 'science', activationPhase: 'on-turn-start', handler: 'colony-output', ...overrides };
}

it('uses canonical groups with independent 130/132 oracles, one rounding and bounded output', () => {
  const a = effect(), b = effect({ id: 'second', value: 0.2 });
  const value = (effects: NumericModifierEffect[]) => calculateColonyValue(1, 100, 'science-output', 'habitable', effects).total;
  expect(value([a, b])).toBe(130);
  expect(value([b, a])).toBe(130);
  expect(value([{ ...a, operation: 'multiply' }, { ...b, operation: 'multiply' }])).toBe(132);
  expect(value([effect({ value: 10 })])).toBe(200);
  expect(value([effect({ value: 0.004 }), effect({ id: 'second', value: 0.004 })])).toBe(101);
  expect(value([effect({ value: 1, cap: 0.25 })])).toBe(125);
  expect(() => value([a, a])).toThrow();
  expect(calculateColonyValue(1, 0, 'science-output', 'habitable', [effect({ unit: 'flat', value: 100 })]).total).toBe(0);
});

it('requires an explicit own/type/phase/handler and never enables barren colonization', () => {
  for (const invalid of [{ ...effect(), worldType: undefined }, { ...effect(), scope: 'global' },
    { ...effect(), worldType: 'ocean' }, { ...effect(), activationPhase: 'on-research' },
    { ...effect(), handler: 'ship-stats' }]) expect(rulesEffectSchema.safeParse(invalid).success).toBe(false);
  expect(calculateColonyValue(1, 100, 'science-output', 'barren', [effect()]).total).toBe(100);
  const rules = createDefaultRulesSnapshot();
  expect(getPopulationTechnologyForecast(rules.population, 'barren', rules.effects).capacity.total).toBe(0);
});

it('separates growth and capacity, respects absoluteMax and never clips over-cap residents', () => {
  const state = createConquest();
  expect(conquestSchema.safeParse({ ...state, population: { ...state.population,
    sol: { population: 1, remainder: 99.99999999999 } } }).success).toBe(false);
  const growth = state.rules.effects.filter(item => item.id === 'biology-growth');
  const capacity = state.rules.effects.filter(item => item.id === 'biosphere-capacity');
  const record = { population: 5000, remainder: 0 };
  expect(populationGrowth(record, state.rules.population, true, growth)).toMatchObject({ capacity: 10000, delta: 120 });
  expect(populationGrowth(record, state.rules.population, true, capacity)).toMatchObject({ capacity: 12000, delta: 100 });
  const huge = capacity.map(item => ({ ...item, value: 1_000_000 }));
  expect(populationGrowth(record, state.rules.population, true, huge).capacity).toBe(20000);
  const over = { population: 20001, remainder: 12.34 };
  expect(populationGrowth(over, state.rules.population, true, huge).next).toEqual(over);
  expect(populationGrowth({ population: 9999, remainder: 99.99 }, state.rules.population, true, growth).next)
    .toEqual({ population: 10000, remainder: 0 });
});

it('retains fractional growth exactly across long runs and save/reload', () => {
  const state = createConquest();
  const effects = state.rules.effects.filter(item => item.id === 'biology-growth');
  let record = { population: 1, remainder: 0 };
  for (let index = 0; index < 41; index++) record = populationGrowth(record, state.rules.population, true, effects).next;
  expect(record).toEqual({ population: 1, remainder: 98.4 });
  expect(populationGrowth(record, state.rules.population, true, effects).next).toEqual({ population: 2, remainder: 0.8 });
  complete(state, ['biology']); state.population.sol = record;
  state.colonyOutput.assignments.sol = { industry: 1, research: 0, culture: 0 };
  const saved = decodeConquestSave(encodeConquestSave(state));
  expect(apply(saved, { kind: 'endTurn' })).toEqual(apply(state, { kind: 'endTurn' }));
});

it.each(['biology', 'biosphere', 'automation', 'scientific-method', 'cultural-practices'])(
  'earns the actual effect of reachable node %s without free science or state injection', id => {
    let state = createConquest();
    state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 0, research: 5000, culture: 0 } });
    const target = state.researchTree.nodes.find(node => node.id === id)!;
    for (const technologyId of [...target.prerequisites, id]) {
      state = apply(state, { kind: 'research', technologyId });
      for (let ends = 0; !state.research.blue.completed.includes(technologyId); ends++) {
        if (ends > 8) throw new Error('Research did not finish within the bound');
        state = apply(apply(state, { kind: 'endTurn' }), { kind: 'endTurn' });
      }
    }
    expect(state.researchJournal.blue[id]).toBeGreaterThan(0);
    const effects = getCompletedColonyEffects(state.researchTree, state.research.blue, state.rules);
    expect(effects.some(item => item.id === target.effects.find(item => item.kind === 'colony-effect')?.effectId)).toBe(true);
    const restored = decodeConquestSave(encodeConquestSave(state));
    expect(apply(restored, { kind: 'endTurn' })).toEqual(apply(state, { kind: 'endTurn' }));
  });

it('uses S0 for growth: a biology completion changes neither current delta nor P immediately', () => {
  let state = createConquest();
  state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 4000, research: 1000, culture: 0 } });
  state = apply(state, { kind: 'research', technologyId: 'biology' });
  state.research.blue.progress.biology = 1000;
  const before = structuredClone(state);
  const first = apply(state, { kind: 'endTurn' });
  expect(first.population.sol.population).toBe(5100);
  expect(first.researchJournal.blue).toEqual({ biology: 1 });
  expect(getConquestView(first, 'blue').researchJournal).toEqual([{ technologyId: 'biology', turn: 1, activationTurn: 3 }]);
  const enemy = apply(first, { kind: 'endTurn' });
  expect(enemy.population.sol).toEqual(first.population.sol);
  const next = apply(enemy, { kind: 'endTurn' });
  expect(next.population.sol).toEqual({ population: 5222, remainder: 40 });
  expect(state).toEqual(before);
});

it('uses old science to finish science-output, no cascade, and new output only at next own end', () => {
  let state = createConquest(); complete(state, ['applied']);
  state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 3000, research: 1000, culture: 1000 } });
  state = apply(state, { kind: 'research', technologyId: 'scientific-method' });
  state.research.blue.progress['scientific-method'] = 2000;
  const result = executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
  if (!result.ok) throw new Error(result.message);
  expect(result.turnReceipt?.research).toMatchObject({ produced: 1000, spent: 1000, reserveAfter: 0 });
  expect(result.state.research.blue.completed).toEqual(['applied', 'scientific-method']);
  expect(result.state.research.blue.activeId).toBeNull();
  const own = getConquestView(result.state, 'blue');
  expect(own.colonyOutput.forecast.reserves.research.produced).toBe(1200);
  expect(own.colonyOutput.forecast.production[0].breakdown.science).toMatchObject({
    base: 1, workers: 1000, labor: 1000, technology: 200, limit: 2000, total: 1200
  });
  const next = executeConquestCommand(apply(result.state, { kind: 'endTurn' }),
    { kind: 'endTurn', factionId: 'blue', expectedTurn: 3 });
  expect(next.ok && next.turnReceipt?.research.produced).toBe(1200);
});

it('does not transfer enemy technology or journal and keeps equal own observations and plans', () => {
  const first = createConquest(), second = createConquest();
  second.research.red.completed = ['biology']; second.researchJournal.red = { biology: 1 };
  expect(getConquestView(first, 'blue')).toEqual(getConquestView(second, 'blue'));
  expect(planConquestAction(getConquestView(first, 'blue'))).toEqual(planConquestAction(getConquestView(second, 'blue')));
});

it('applies industry/culture once to the real FIFO and reserve, not to a waiting head or enemy end', () => {
  let state = apply(apply(createConquest(), { kind: 'endTurn' }), { kind: 'endTurn' });
  complete(state, ['engineering', 'automation', 'cultural-practices']);
  state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 5, research: 0, culture: 5 } });
  for (let index = 0; index < 2; index++) state = apply(state, {
    kind: 'enqueueProduction', systemId: 'sol', design: createCombatDesign('fighter')
  });
  const forecast = getConquestView(state, 'blue').colonyOutput.forecast;
  const next = apply(state, { kind: 'endTurn' });
  expect(forecast.production[0]).toMatchObject({ productionPoints: 6, culturePoints: 6 });
  expect(next.colonyOutput.production.orders.map(order => order.productionProgress)).toEqual([6, 0]);
  expect(next.colonyOutput.reserves.blue.culture).toBe(6);
  expect(apply(next, { kind: 'endTurn' }).colonyOutput).toEqual(next.colonyOutput);
});

it('defers a newly unlocked capacity until next own end and never grants free residents', () => {
  let state = createConquest(); complete(state, ['biology']);
  state.population.sol = { population: 10000, remainder: 0 };
  state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 9000, research: 1000, culture: 0 } });
  state = apply(state, { kind: 'research', technologyId: 'biosphere' });
  state.research.blue.progress.biosphere = 3000;
  const first = apply(state, { kind: 'endTurn' });
  expect(first.population.sol.population).toBe(10000);
  expect(getConquestView(first, 'blue').population[0].capacity).toBe(12000);
  expect(apply(apply(first, { kind: 'endTurn' }), { kind: 'endTurn' }).population.sol.population).toBe(10240);
});

it('rejects missing/mismatched journals, dangling references, old versions and unsupported library effects', () => {
  const state = createConquest();
  expect(conquestSchema.safeParse({ ...state, researchJournal: undefined }).success).toBe(false);
  expect(conquestSchema.safeParse({ ...state, researchJournal: { blue: { biology: 1 }, red: {} } }).success).toBe(false);
  const tree = structuredClone(state.researchTree);
  tree.nodes[0].effects = [{ kind: 'colony-effect', effectId: 'unknown' }];
  expect(researchTreeSchema.safeParse(tree).success).toBe(false);
  state.rules.effects.pop();
  expect(conquestSchema.safeParse(state).success).toBe(false);
  const encoded = JSON.parse(encodeConquestSave(createConquest()));
  encoded.schemaVersion = 9; encoded.rulesVersion = 6;
  expect(() => decodeConquestSave(JSON.stringify(encoded))).toThrow();
});

it('keeps saved coefficients independent of external defaults and repeats the entire next command', () => {
  const state = createConquest(); complete(state, ['biology']);
  const growth = state.rules.effects.find(item => item.id === 'biology-growth')!;
  growth.value = 0.5;
  const saved = decodeConquestSave(encodeConquestSave(state));
  growth.value = 0;
  expect(getConquestView(saved, 'blue').population[0].delta).toBe(150);
  expect(getConquestView(createConquest(), 'blue').population[0].delta).toBe(100);
  const oracle = structuredClone(saved);
  expect(apply(saved, { kind: 'endTurn' })).toEqual(apply(oracle, { kind: 'endTurn' }));
});

it('rolls back completed technology, journal, growth and output on a late real encounter failure', () => {
  const state = createConquest();
  state.research.blue.activeId = 'biology'; state.research.blue.progress.biology = 1999;
  state.colonyOutput.reserves.blue.research = 1;
  state.lastBattleId = MAX_TURN;
  const design = createCombatDesign('fighter');
  state.session.production.lastOrderId = 2;
  state.session.ships = ['blue', 'red'].map((side, index) => ({
    id: index + 1, factionId: side === 'blue' ? 'blue' : 'red', systemId: 'rift', fuel: 3, design
  }));
  state.operations = { '1': createOperationalState(design), '2': createOperationalState(design) };
  const before = structuredClone(state);
  const failed = executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
  expect(failed.ok).toBe(false);
  expect(failed).not.toHaveProperty('state'); expect(failed).not.toHaveProperty('turnReceipt');
  expect(state).toEqual(before);
});

it('AI measures own marginal utility and gives no invented gain at capacity or reserve caps', () => {
  const state = createConquest();
  state.population.sol.population = 10000;
  state.colonyOutput.assignments.sol = { industry: 0, research: 5000, culture: 5000 };
  state.colonyOutput.reserves.blue = { research: 100000, culture: 100000 };
  let view = getConquestView(state, 'blue');
  const find = (id: string) => state.researchTree.nodes.find(node => node.id === id)!;
  expect(getConquestResearchUtility(view, find('biology'))).toBe(0);
  expect(getConquestResearchUtility(view, find('scientific-method'))).toBe(0);
  expect(getConquestResearchUtility(view, find('cultural-practices'))).toBe(0);
  state.colonyOutput.reserves.blue.research = 0;
  view = getConquestView(state, 'blue');
  expect(getConquestResearchUtility(view, find('scientific-method'))).toBeGreaterThan(0);
  expect(getConquestResearchUtility(view, find('biosphere'))).toBeGreaterThan(0);
  state.population.sol.population = 5000;
  state.colonyOutput.assignments.sol = { industry: 4000, research: 1000, culture: 0 };
  complete(state, ['engineering', 'applied', 'support', 'ordnance', 'capital']);
  expect(planConquestAction(getConquestView(state, 'blue'))).toMatchObject({
    kind: 'research', technologyId: 'scientific-method'
  });
});
