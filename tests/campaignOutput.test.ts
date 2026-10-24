import { expect, it } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand, getConquestView } from '../src/domain/conquest';
import { createDesign } from '../src/domain/shipDesign';
import { advanceColonyOutput, getColonyOutputForecast, getColonyProductionQuote, getColonyProductionRefund,
  reduceWorkforce } from '../src/domain/campaignOutput';
import { createDefaultRulesSnapshot } from '../src/domain/campaignRules';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { executeConquestAiTurn } from '../src/domain/conquestAi';
import { createOperationalState } from '../src/domain/campaignOperations';

const outputRules = createDefaultRulesSnapshot().colonyOutput;

function end(state: ReturnType<typeof createConquest>, factionId: 'blue' | 'red' = 'blue') {
  const result = executeConquestCommand(state, { kind: 'endTurn', factionId, expectedTurn: state.session.turn });
  if (!result.ok) throw new Error(result.message);
  return result;
}

it('rejects an assignment above population atomically and accepts exactly the available workforce', () => {
  const state = createConquest();
  state.population.sol.population = 9;
  state.colonyOutput.assignments.sol = { industry: 9, research: 0, culture: 0 };
  const before = structuredClone(state);
  const tooMany = executeConquestCommand(state, { kind: 'assignWorkers', factionId: 'blue', expectedTurn: 1,
    systemId: 'sol', workers: { industry: 10, research: 0, culture: 0 } });
  expect(tooMany.ok).toBe(false);
  expect(state).toEqual(before);
  const exact = executeConquestCommand(state, { kind: 'assignWorkers', factionId: 'blue', expectedTurn: 1,
    systemId: 'sol', workers: { industry: 9, research: 0, culture: 0 } });
  expect(exact.ok).toBe(true);
  expect(exact.ok && getConquestView(exact.state, 'blue').colonyOutput.assignments.sol).toMatchObject({
    population: 9, industry: 9, research: 0, culture: 0, unassigned: 0
  });
});

it('reduces assignments proportionally with deterministic industry/research/culture remainder priority', () => {
  expect(reduceWorkforce({ industry: 5, research: 3, culture: 2 }, 6))
    .toEqual({ industry: 4, research: 1, culture: 1 });
  expect(reduceWorkforce({ industry: 5, research: 3, culture: 2 }, 0))
    .toEqual({ industry: 0, research: 0, culture: 0 });
  expect(reduceWorkforce({ industry: 5, research: 3, culture: 2 }, 10))
    .toEqual({ industry: 5, research: 3, culture: 2 });
});

it('quotes point costs and computes exact proportional refunds including large integer products', () => {
  const design = createDesign('fighter', true), quote = getColonyProductionQuote(design, outputRules);
  expect(quote.productionCost).toBe(Math.ceil(quote.cost.credits / 10));
  const order = { id: 1, factionId: 'blue' as const, systemId: 'sol' as const, design,
    cost: { credits: 100, minerals: 11 }, productionCost: 10, productionProgress: 0 };
  expect(getColonyProductionRefund(order)).toEqual(order.cost);
  expect(getColonyProductionRefund({ ...order, productionProgress: 5 }))
    .toEqual({ credits: 50, minerals: 5 });
  expect(getColonyProductionRefund({ ...order, productionProgress: 9 }))
    .toEqual({ credits: 10, minerals: 1 });
  expect(getColonyProductionRefund({ ...order, cost: { credits: 1_000_000_000, minerals: 999_999_999 },
    productionCost: 1_000_000_000, productionProgress: 1 }))
    .toEqual({ credits: 999_999_999, minerals: 999_999_998 });
});

it('cancels by the unused point share and rolls back a refund that exceeds the resource cap', () => {
  const design = createDesign('fighter', true), quote = getColonyProductionQuote(design, outputRules);
  const state = createConquest();
  state.session.production.lastOrderId = 1;
  const order = { id: 1, factionId: 'blue' as const, systemId: 'sol' as const, design,
    cost: quote.cost, productionCost: quote.productionCost, productionProgress: Math.floor(quote.productionCost / 2) };
  state.colonyOutput.production.orders = [order];
  const refund = getColonyProductionRefund(order);
  const cancelled = executeConquestCommand(conquestSchema.parse(state), { kind: 'cancelProduction',
    factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 1 });
  expect(cancelled.ok).toBe(true);
  expect(cancelled.ok && cancelled.state.session.treasuries.blue).toEqual({
    credits: 100 + refund.credits, minerals: 50 + refund.minerals
  });
  expect(cancelled.ok && cancelled.state.colonyOutput.production.orders).toEqual([]);

  const overflow = structuredClone(state);
  overflow.session.treasuries.blue.credits = 1_000_000_000 - refund.credits + 1;
  const before = structuredClone(overflow);
  const refused = executeConquestCommand(conquestSchema.parse(overflow), { kind: 'cancelProduction',
    factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 1 });
  expect(refused).toMatchObject({ ok: false, code: 'RESOURCE_LIMIT' });
  expect(overflow).toEqual(before);
});

it('uses pre-growth workforce, completes only one FIFO head without spillover, and never repeats completion', () => {
  const state = createConquest(), design = createDesign('fighter', true), quote = getColonyProductionQuote(design, outputRules);
  state.session.production.lastOrderId = 2;
  state.colonyOutput.assignments.sol = { industry: quote.productionCost, research: 0, culture: 0 };
  state.colonyOutput.production.orders = [1, 2].map(id => ({ id, factionId: 'blue' as const, systemId: 'sol' as const,
    design, cost: quote.cost, productionCost: quote.productionCost, productionProgress: 0 }));
  const advanced = conquestSchema.parse(state);
  const result = end(advanced);
  expect(result.turnReceipt?.population).toBe(5000);
  expect(result.turnReceipt?.populationIncome).toEqual({ credits: 15000, minerals: 5000 });
  expect(result.turnReceipt?.productionPoints).toBe(quote.productionCost);
  expect(result.state.population.sol.population).toBe(5100);
  expect(result.state.colonyOutput.production.completed.map(order => order.id)).toEqual([1]);
  expect(result.state.colonyOutput.production.orders).toMatchObject([{ id: 2, productionProgress: 0 }]);
  expect(result.turnReceipt?.completedProductionIds).toEqual([1]);
  const redTurn = end(result.state, 'red');
  const deploy = executeConquestCommand(redTurn.state, { kind: 'deployProduction', factionId: 'blue',
    expectedTurn: 3, systemId: 'sol', orderId: 1 });
  expect(deploy.ok).toBe(true);
  if (!deploy.ok) return;
  const blueTurn = end(deploy.state);
  expect(blueTurn.turnReceipt?.completedProductionIds).toEqual([2]);
  expect(blueTurn.state.colonyOutput.production.completed.map(order => order.id)).toEqual([2]);
  expect(blueTurn.state.session.ships.map(ship => ship.id)).toEqual([1]);
});

it('keeps zero-industry orders paused and preserves over-cap reserves without growing them', () => {
  const state = createConquest(), design = createDesign('fighter', true), quote = getColonyProductionQuote(design, outputRules);
  state.session.production.lastOrderId = 1;
  state.colonyOutput.assignments.sol = { industry: 0, research: 1, culture: 0 };
  state.colonyOutput.production.orders = [{ id: 1, factionId: 'blue', systemId: 'sol', design,
    cost: quote.cost, productionCost: quote.productionCost, productionProgress: 0 }];
  state.colonyOutput.reserves.blue.research = 50_001;
  const checked = conquestSchema.parse(state);
  const view = getConquestView(checked, 'blue');
  expect(view.colonyOutput.forecast.production.find(row => row.systemId === 'sol')?.productionStatus).toBe('paused');
  expect(view.colonyOutput.forecast.production.find(row => row.systemId === 'sol')?.remainingOwnTurns).toBeNull();
  expect(view.colonyOutput.forecast.reserves.research).toMatchObject({
    current: 50_001, cap: 50_000, accepted: 0, after: 50_001
  });
  const output = advanceColonyOutput(checked.colonyOutput, checked.session.galaxy, checked.population, 'blue',
    checked.rules.colonyOutput, 0);
  expect(output.state.production.orders[0].productionProgress).toBe(0);
});

it('does not progress a blue queue or reserves on the enemy end turn', () => {
  const state = createConquest(), design = createDesign('fighter', true), quote = getColonyProductionQuote(design, outputRules);
  state.session.turn = 2;
  state.session.production.lastOrderId = 1;
  state.colonyOutput.assignments.sol = { industry: 1, research: 0, culture: 0 };
  state.colonyOutput.reserves.blue.research = 25;
  state.colonyOutput.production.orders = [{ id: 1, factionId: 'blue', systemId: 'sol', design,
    cost: quote.cost, productionCost: quote.productionCost, productionProgress: 3 }];
  const result = end(conquestSchema.parse(state), 'red');
  expect(result.state.colonyOutput.production.orders[0].productionProgress).toBe(3);
  expect(result.state.colonyOutput.reserves.blue.research).toBe(25);
});

it('caps science and culture at the population-based limit', () => {
  const state = createConquest(), rules = createDefaultRulesSnapshot();
  state.colonyOutput.assignments.sol = { industry: 0, research: 2500, culture: 2500 };
  state.colonyOutput.reserves.blue = { research: 49_999, culture: 49_999 };
  conquestSchema.parse(state);
  const output = getColonyOutputForecast(state.session.galaxy, state.population, state.colonyOutput,
    'blue', rules.colonyOutput, 0);
  for (const kind of ['research', 'culture'] as const) {
    expect(output.reserves[kind]).toMatchObject({ cap: 50_000, produced: 2500, accepted: 1, overflow: 2499, after: 50_000 });
  }
});

it('matches pre-growth science spending to the forecast and actual receipt', () => {
  const state = createConquest();
  state.population.sol = { population: 9, remainder: 99 };
  state.colonyOutput.assignments.sol = { industry: 3, research: 4, culture: 2 };
  state.research.blue.activeId = 'support';
  state.research.blue.progress.support = 0;
  const view = getConquestView(state, 'blue'), result = end(state);
  expect(view.colonyOutput.forecast.income).toEqual({ credits: 27, minerals: 9 });
  expect(result.turnReceipt).toMatchObject({
    population: 9, populationIncome: view.colonyOutput.forecast.income,
    populationUpkeepCredits: 9, shipUpkeepCredits: 0, creditsPaid: 9,
    productionPoints: 3, reserves: view.colonyOutput.forecast.reserves,
    treasuryAfter: { credits: 118, minerals: 59 }
  });
  expect(result.state.population.sol).toEqual({ population: 10, remainder: 17 });
  expect(result.state.colonyOutput.reserves.blue).toEqual({ research: 0, culture: 2 });
  expect(result.state.research.blue).toEqual({ completed: [], activeId: 'support', progress: { support: 4 } });
  expect(result.state.session.treasuries.blue).toEqual(view.economyForecast.ok && view.economyForecast.treasuryAfter);
});

it('uses the saved output rates in quotes, validation, forecast and production progress', () => {
  const state = createConquest(), design = createDesign('fighter', true);
  state.rules.colonyOutput.productionCreditsPerPoint = 5;
  state.rules.colonyOutput.pointsPerWorker = 2;
  const quote = getColonyProductionQuote(design, state.rules.colonyOutput);
  expect(quote.productionCost).toBe(Math.ceil(quote.cost.credits / 5));
  const funded = end(end(state).state, 'red').state;
  const ordered = executeConquestCommand(funded, { kind: 'enqueueProduction', factionId: 'blue',
    expectedTurn: 3, systemId: 'sol', design });
  if (!ordered.ok) throw new Error(ordered.message);
  const assigned = executeConquestCommand(ordered.state, { kind: 'assignWorkers', factionId: 'blue',
    expectedTurn: 3, systemId: 'sol', workers: { industry: 1, research: 1, culture: 1 } });
  if (!assigned.ok) throw new Error(assigned.message);
  const loaded = decodeConquestSave(encodeConquestSave(assigned.state));
  const result = end(loaded);
  expect(result.state.colonyOutput.production.orders[0]).toMatchObject({
    productionCost: quote.productionCost, productionProgress: 2
  });
  expect(result.turnReceipt?.reserves.research.produced).toBe(2);
  expect(result.turnReceipt?.reserves.culture.produced).toBe(2);
});

it('rejects saved waiting-order progress and forged costs instead of repairing them', () => {
  const state = createConquest(), design = createDesign('fighter', true);
  const quote = getColonyProductionQuote(design, outputRules);
  state.session.production.lastOrderId = 2;
  state.colonyOutput.production.orders = [1, 2].map(id => ({
    id, factionId: 'blue', systemId: 'sol', design, ...quote, productionProgress: id === 2 ? 1 : 0
  }));
  expect(conquestSchema.safeParse(state).success).toBe(false);
  state.colonyOutput.production.orders[1].productionProgress = 0;
  expect(conquestSchema.safeParse(state).success).toBe(true);
  state.colonyOutput.production.orders[0].cost.credits++;
  expect(() => encodeConquestSave(state)).toThrow();
});

it('round-trips a paid partial order and produces the identical completion, reserves and deployment', () => {
  let state = end(end(createConquest()).state, 'red').state;
  const design = createDesign('fighter', true);
  const ordered = executeConquestCommand(state, { kind: 'enqueueProduction', factionId: 'blue',
    expectedTurn: 3, systemId: 'sol', design });
  if (!ordered.ok) throw new Error(ordered.message);
  const assigned = executeConquestCommand(ordered.state, { kind: 'assignWorkers', factionId: 'blue',
    expectedTurn: 3, systemId: 'sol', workers: { industry: 3, research: 2, culture: 1 } });
  if (!assigned.ok) throw new Error(assigned.message);
  expect(getConquestView(assigned.state, 'blue').colonyOutput.forecast.production[0].remainingOwnTurns)
    .toBe(Math.ceil(assigned.state.colonyOutput.production.orders[0].productionCost / 3));
  state = end(assigned.state).state;
  expect(state.colonyOutput.production.orders[0].productionProgress).toBe(3);
  let restored = decodeConquestSave(encodeConquestSave(state));
  for (let turn = 0; turn < 20 && state.colonyOutput.production.orders.length; turn++) {
    const faction = state.session.turn % 2 ? 'blue' : 'red';
    const uninterrupted = end(state, faction), resumed = end(restored, faction);
    expect(resumed).toEqual(uninterrupted);
    state = uninterrupted.state; restored = resumed.state;
  }
  expect(state.colonyOutput.production.orders).toEqual([]);
  expect(state.colonyOutput.production.completed.map(record => record.id)).toEqual([1]);
  state = end(state, 'red').state;
  restored = end(restored, 'red').state;
  const payload = { kind: 'deployProduction', factionId: 'blue', expectedTurn: state.session.turn,
    systemId: 'sol', orderId: 1 };
  const deployed = executeConquestCommand(state, payload);
  expect(executeConquestCommand(restored, payload)).toEqual(deployed);
  expect(deployed.ok && deployed.state.session.ships.map(ship => ship.id)).toEqual([1]);
});

it('preserves the output receipt when an AI packet ends its turn', () => {
  const state = createConquest();
  const result = executeConquestAiTurn(state, 'blue', 1);
  if (!result.ok) throw new Error(result.message);
  expect(result.turnReceipt).toMatchObject({
    factionId: 'blue', turn: 1, population: 5000, populationIncome: { credits: 15000, minerals: 5000 }
  });
  expect(result.turnReceipt?.treasuryAfter).toEqual(result.state.session.treasuries.blue);
});

it('keeps a diagnostic upkeep deficit soft while progressing the queue, growth and reserves', () => {
  const state = createConquest(), design = createDesign('fighter', true);
  state.rules.colonyOutput.creditsPerPopulation = 0;
  state.session.treasuries.blue.credits = 1;
  state.session.production.lastOrderId = 1;
  state.colonyOutput.assignments.sol = { industry: 1, research: 1, culture: 1 };
  state.colonyOutput.production.orders = [{ id: 1, factionId: 'blue', systemId: 'sol', design,
    ...getColonyProductionQuote(design, state.rules.colonyOutput), productionProgress: 0 }];
  const result = end(state);
  expect(result.turnReceipt).toMatchObject({ populationUpkeepCredits: 5000, creditsPaid: 1,
    creditsShortfall: 4999, treasuryAfter: { credits: 0, minerals: 5050 } });
  expect(result.state.colonyOutput.production.orders[0].productionProgress).toBe(1);
  expect(result.state.colonyOutput.reserves.blue).toEqual({ research: 1, culture: 1 });
  expect(result.state.population.sol.population).toBe(5100);
});

it('captures without refund or transferring the old reserve and resets the captured workforce', () => {
  const state = createConquest(), design = createDesign('fighter', true);
  state.session.production.lastOrderId = 2;
  state.session.ships.push({ id: 2, factionId: 'red', systemId: 'sol', design, fuel: 3 });
  state.operations['2'] = createOperationalState(design);
  state.colonyOutput.production.orders = [{ id: 1, factionId: 'blue', systemId: 'sol', design,
    ...getColonyProductionQuote(design, state.rules.colonyOutput), productionProgress: 0 }];
  state.colonyOutput.reserves.blue = { research: 50, culture: 25 };
  const result = end(state);
  expect(result.state.session.galaxy.systems.find(system => system.id === 'sol')?.ownerId).toBe('red');
  expect(result.state.colonyOutput.assignments.sol).toEqual({ industry: 0, research: 0, culture: 0 });
  expect(result.state.colonyOutput.production).toEqual({ orders: [], completed: [] });
  expect(result.state.colonyOutput.reserves).toEqual({ blue: { research: 50, culture: 25 },
    red: { research: 0, culture: 0 } });
  expect(result.state.population.sol.population).toBe(5100);
  expect(result.state.session.treasuries.blue).toEqual({ credits: 10100, minerals: 5050 });
  expect(result.state.session.treasuries.red).toEqual({ credits: 100, minerals: 50 });
});

it('keeps production and science reserves restricted to the observed side', () => {
  const state = createConquest(), design = createDesign('fighter', true);
  state.session.production.lastOrderId = 1;
  state.colonyOutput.production.completed.push({ id: 1, factionId: 'red', systemId: 'vega', design });
  state.colonyOutput.reserves.red.research = 123;
  const checked = conquestSchema.parse(state);
  const blue = getConquestView(checked, 'blue');
  const red = getConquestView(checked, 'red');
  expect(blue.production.completed).toEqual([]);
  expect(blue.colonyOutput.reserves).not.toHaveProperty('red');
  expect(red.production.completed).toHaveLength(1);
  expect(red.colonyOutput.reserves.research).toBe(123);
  expect(red.colonyOutput.reserves).not.toHaveProperty('blue');
});
