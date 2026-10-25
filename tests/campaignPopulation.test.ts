import { describe, expect, it } from 'vitest';
import { populationGrowth, quoteFounding, advancePopulation } from '../src/domain/campaignPopulation';
import { createDefaultRulesSnapshot, decodeRulesSnapshot, encodeRulesSnapshot } from '../src/domain/campaignRules';
import { createConquest, conquestSchema, executeConquestCommand, getConquestView, type Conquest } from '../src/domain/conquest';
import { createDesign, createComponentWithId } from '../src/domain/shipDesign';
import { createOperationalState } from '../src/domain/campaignOperations';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { type CampaignFactionId } from '../src/domain/campaign';
import { buildConquestDesigns, executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { getWorldDistance } from '../src/domain/campaignTravel';

const rules = createDefaultRulesSnapshot().population;
function placeColonizer(state: Conquest, systemId: 'eden' | 'nexus', armed = false): number {
  const colonizer = state.session.ships.find(item => item.factionId === 'blue' && item.design.hullId === 'colonizer')!;
  colonizer.systemId = systemId;
  state.surveys.blue[systemId] = state.environment[systemId];
  if (armed) colonizer.design.slots.find(slot => slot.id === 'beam_1')!.component = createComponentWithId('beam', 'colonizer-beam');
  state.operations[String(colonizer.id)] = createOperationalState(colonizer.design);
  return colonizer.id;
}
function ship(state: Conquest, systemId: 'eden' | 'nexus' | 'sol', factionId: CampaignFactionId = 'blue', armed = true) {
  const design = createDesign('fighter', true);
  if (!armed) design.slots.find(slot => slot.id === 'beam_1')!.component = null;
  const id = ++state.session.production.lastOrderId;
  state.session.ships.push({ id, factionId, systemId, fuel: 3000, design });
  state.operations[String(id)] = createOperationalState(design);
  state.surveys.blue.rift = 'barren';
}
function command(state: Conquest, payload: Record<string, unknown>): Conquest {
  const before = structuredClone(state);
  const result = executeConquestCommand(state, { factionId: state.session.turn % 2 ? 'blue' : 'red',
    expectedTurn: state.session.turn, ...payload });
  expect(state).toEqual(before);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

describe('population rules and integer growth', () => {
  it.each([
    [0, 0, 0, 0, 'empty'], [1, 98, 1, 0, 'growing'], [5000, 0, 100, 0, 'growing'],
    [9999, 99, 1, 0, 'growing'], [10000, 23, 0, 23, 'at-capacity'],
    [10001, 43, 0, 43, 'over-capacity'], [20001, 12, 0, 12, 'over-capacity'],
    [1_000_000_000, 99, 0, 99, 'over-capacity']
  ])('calculates P=%i remainder=%i independently', (population, remainder, delta, nextRemainder, reason) => {
    expect(populationGrowth({ population, remainder }, rules)).toEqual({
      capacity: 10000, delta, reason, next: { population: population + delta, remainder: nextRemainder }
    });
  });

  it('accumulates sub-unit growth rather than inventing a minimum or losing it each turn', () => {
    let record = { population: 1, remainder: 0 };
    for (let step = 0; step < 49; step++) record = populationGrowth(record, rules).next;
    expect(record).toEqual({ population: 1, remainder: 98 });
    expect(populationGrowth(record, rules).next).toEqual({ population: 2, remainder: 0 });
  });

  it('uses the snapshot capacity without exceeding the absolute limit', () => {
    const modified = structuredClone(rules);
    modified.capacities.habitable = { base: 100, absolute: 150 };
    expect(populationGrowth({ population: 99, remainder: 0 }, modified).next).toEqual({ population: 100, remainder: 0 });
    expect(populationGrowth({ population: 1, remainder: 0 }, rules, false).reason).toBe('over-capacity');
  });

  it('requires the complete current rules snapshot with bounded capacities and no migration', () => {
    const snapshot = createDefaultRulesSnapshot();
    expect(decodeRulesSnapshot(encodeRulesSnapshot(snapshot))).toEqual(snapshot);
    for (const invalid of [
      { ...snapshot, schemaVersion: 1 }, { ...snapshot, population: undefined },
      { ...snapshot, population: { ...rules, growthPercent: NaN } },
      { ...snapshot, population: { ...rules, capacities: { ...rules.capacities, habitable: { base: 30, absolute: 20 } } } }
    ]) expect(() => encodeRulesSnapshot(invalid)).toThrow();
  });
});

describe('campaign demographic boundary', () => {
  it('initializes homes and empty neutral worlds, advances only ending ownership and detaches views', () => {
    const initial = freeze(createConquest());
    expect(initial.population.sol).toEqual({ population: 5000, remainder: 0 });
    expect(initial.population.eden).toEqual({ population: 0, remainder: 0 });
    expect(initial.population).not.toHaveProperty('rift');
    const blue = command(initial, { kind: 'endTurn' });
    expect(blue.population.sol.population).toBe(5100);
    expect(blue.population.vega.population).toBe(5000);
    const red = command(blue, { kind: 'endTurn' });
    expect(red.population.sol).toEqual(blue.population.sol);
    expect(red.population.vega.population).toBe(5100);
    expect(executeConquestCommand(red, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
    const view = getConquestView(red, 'blue');
    expect(view.population.map(item => item.systemId)).toEqual(['sol']);
    expect(view).not.toHaveProperty('rules');
    expect(view).not.toHaveProperty('treasuries');
    view.population[0].next.population = 0;
    expect(getConquestView(red, 'blue').population[0].next.population).toBe(5202);
  });

  it.each(['population', 'rules'])('rejects missing %s rather than supplying legacy defaults', field => {
    const state: Record<string, unknown> = createConquest();
    delete state[field];
    expect(conquestSchema.safeParse(state).success).toBe(false);
    expect(executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
  });

  it.each([
    { population: -1, remainder: 0 }, { population: 1.5, remainder: 0 },
    { population: Infinity, remainder: 0 }, { population: 1, remainder: 100 },
    { population: 1, remainder: -1 }, { population: 1, remainder: 0, extra: true }
  ])('rejects malformed population records %j', record => {
    const state = createConquest();
    expect(conquestSchema.safeParse({ ...state, population: { ...state.population, sol: record } }).success).toBe(false);
  });

  it('requires exactly habitable-world records and forbids unimplemented active effects', () => {
    const state = createConquest();
    expect(conquestSchema.safeParse({ ...state, population: { ...state.population, rift: { population: 0, remainder: 0 } } }).success).toBe(false);
    delete state.population.eden;
    expect(conquestSchema.safeParse(state).success).toBe(false);
    const effects = createConquest();
    effects.rules.effects = createDefaultRulesSnapshot().effects;
    expect(conquestSchema.safeParse(effects).success).toBe(false);
  });

  it('selects the nearest eligible source by public lanes then ASCII ID, independently of array order', () => {
    const state = createConquest();
    state.session.galaxy.systems.find(system => system.id === 'nexus')!.ownerId = 'blue';
    state.session.galaxy.systems.find(system => system.id === 'nexus')!.exploredBy.push('blue');
    state.population.nexus.population = 2000;
    const galaxy = state.session.galaxy;
    const quote = () => quoteFounding(galaxy, state.population, 'blue', 'eden', state.session.treasuries.blue, rules);
    expect(quote()).toEqual({ ok: true, sourceId: 'nexus', cost: { credits: 20, minerals: 10 } });
    galaxy.systems.reverse();
    expect(quote()).toEqual({ ok: true, sourceId: 'nexus', cost: { credits: 20, minerals: 10 } });
    state.population.nexus.population = 1999;
    expect(quote()).toMatchObject({ ok: true, sourceId: 'sol' });
  });

  it.each([true, false])('manual founding transfers real population and pays once (armed=%s)', armed => {
    const state = createConquest(), shipId = placeColonizer(state, 'eden', armed);
    state.population.sol.remainder = 17;
    state.session.treasuries.blue = { credits: 20, minerals: 10 };
    const next = command(freeze(state), { kind: 'colonize', systemId: 'eden', shipId });
    expect(next.population.sol).toEqual({ population: 4000, remainder: 17 });
    expect(next.population.eden).toEqual({ population: 1000, remainder: 0 });
    expect(next.session.treasuries.blue).toEqual({ credits: 0, minerals: 0 });
    expect(next.session.turn).toBe(1);
    expect(executeConquestCommand(next, { kind: 'colonize', systemId: 'eden', factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
    const grown = command(next, { kind: 'endTurn' });
    expect(grown.population.eden.population).toBe(1020);
    expect(grown.population.sol).toEqual({ population: 4080, remainder: 17 });
  });

  it.each(['source', 'credits', 'minerals'] as const)('manual refusal is atomic when %s is missing', missing => {
    const state = createConquest(), shipId = placeColonizer(state, 'eden');
    if (missing === 'source') {
      state.population.sol.population = 1999;
      state.colonyOutput.assignments.sol.industry = 1999;
    }
    else state.session.treasuries.blue[missing] = missing === 'credits' ? 19 : 9;
    const before = structuredClone(state);
    const result = executeConquestCommand(freeze(state), { kind: 'colonize', systemId: 'eden', shipId, factionId: 'blue', expectedTurn: 1 });
    expect(result).toMatchObject({ ok: false, code: missing === 'source' ? 'NO_SETTLERS' : 'INSUFFICIENT_RESOURCES' });
    expect(state).toEqual(before);
  });

  it('armed presence no longer auto-founds, spends settlers or charges a founding payment', () => {
    const state = createConquest(); ship(state, 'eden');
    const budget = getConquestView(state, 'blue').economyForecast;
    if (!budget.ok) throw new Error(budget.code);
    const next = command(state, { kind: 'endTurn' });
    expect(next.population.sol.population).toBe(5100);
    expect(next.population.eden).toEqual({ population: 0, remainder: 0 });
    expect(next.session.treasuries.blue).toEqual(budget.treasuryAfter);
    expect(command(next, { kind: 'endTurn' }).population.eden).toEqual(next.population.eden);
  });

  it.each(['source', 'credits'] as const)('endTurn does not attempt implicit founding when %s is missing', missing => {
    const state = createConquest(); ship(state, 'eden');
    if (missing === 'source') {
      state.population.sol.population = 1000;
      state.colonyOutput.assignments.sol.industry = 1000;
    } else {
      state.session.treasuries.blue.credits = 0;
      state.rules.population.foundingCost.credits = 10000;
    }
    const result = executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('notices');
    if (!result.ok) throw new Error(result.message);
    expect(result.state.session.turn).toBe(2);
    expect(result.state.session.galaxy.systems.find(system => system.id === 'eden')!.ownerId).toBeNull();
    expect(result.state.population.eden.population).toBe(0);
    expect(result.turnReceipt?.populationIncome).toEqual({
      credits: missing === 'source' ? 3000 : 15000,
      minerals: missing === 'source' ? 1000 : 5000
    });
  });

  it('multiple armed presences cannot implicitly spend any settlers', () => {
    const state = createConquest(); ship(state, 'eden'); ship(state, 'nexus');
    state.population.sol.population = 2000;
    state.colonyOutput.assignments.sol.industry = 2000;
    const next = command(state, { kind: 'endTurn' });
    expect(next.population.eden.population).toBe(0);
    expect(next.population.nexus.population).toBe(0);
    expect(next.population.sol.population).toBe(2040);
  });

  it('capture retains residents and remainder without charging or granting attacker growth until next own end', () => {
    let state = createConquest(); ship(state, 'sol', 'red');
    state.population.sol = { population: 4000, remainder: 53 };
    state.colonyOutput.assignments.sol.industry = 4000;
    state = command(state, { kind: 'endTurn' });
    expect(state.session.galaxy.systems.find(system => system.id === 'sol')!.ownerId).toBe('red');
    expect(state.population.sol).toEqual({ population: 4080, remainder: 53 });
    expect(state.session.treasuries.red).toEqual({ credits: 100, minerals: 50 });
    expect(getConquestView(state, 'blue').population).toEqual([]);
    expect(getConquestView(state, 'red').population.map(item => item.systemId)).toContain('sol');
    state = command(state, { kind: 'endTurn' });
    expect(state.population.sol).toEqual({ population: 4162, remainder: 13 });
  });

  it('a late mining overflow rejects the complete turn including demographic changes', () => {
    const state = createConquest(); ship(state, 'eden');
    state.research.blue.completed = ['support', 'applied'];
    state.researchJournal.blue = { support: 1, applied: 1 };
    const design = buildConquestDesigns(state.research.blue, state.researchTree).find(item => item.hullId === 'corvette')!;
    design.slots.find(slot => slot.id === 'service_1')!.component = createComponentWithId('mining', 'miner');
    const id = ++state.session.production.lastOrderId;
    state.session.ships.push({ id, factionId: 'blue', systemId: 'rift', fuel: 3000, design });
    state.operations[String(id)] = createOperationalState(design);
    state.session.treasuries.blue.minerals = 1_000_000_000 - 5000;
    const before = structuredClone(state);
    expect(executeConquestCommand(freeze(state), { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
    expect(state).toEqual(before);
  });

  it('save retains demographic arithmetic and rule snapshot; load does not grow and next command matches', () => {
    let state = createConquest(); const shipId = placeColonizer(state, 'eden');
    state = command(state, { kind: 'colonize', systemId: 'eden', shipId });
    state.population.sol = { population: 4081, remainder: 53 };
    const loaded = decodeConquestSave(encodeConquestSave(state));
    expect(loaded).toEqual(state);
    expect(command(loaded, { kind: 'endTurn' })).toEqual(command(state, { kind: 'endTurn' }));
    loaded.rules.population.capacities.habitable.base = 9000;
    expect(state.rules.population.capacities.habitable.base).toBe(10000);
    const envelope = JSON.parse(encodeConquestSave(state));
    expect(() => decodeConquestSave(JSON.stringify({ ...envelope, schemaVersion: 6 }))).toThrow();
    delete envelope.conquest.population;
    expect(() => decodeConquestSave(JSON.stringify(envelope))).toThrow();
  });

  it('preserves founded and grown population through a real battle capture, save and next own growth', () => {
    let state = createConquest(); const shipId = placeColonizer(state, 'eden');
    state = command(state, { kind: 'colonize', systemId: 'eden', shipId });
    ship(state, 'eden', 'blue', false);
    state = command(state, { kind: 'endTurn' });
    expect(state.population.eden).toEqual({ population: 1020, remainder: 0 });
    ship(state, 'eden', 'red');
    state = command(state, { kind: 'endTurn' });
    expect(state.battles.at(-1)).toMatchObject({ systemId: 'eden', winner: 'red' });
    expect(state.session.galaxy.systems.find(system => system.id === 'eden')!.ownerId).toBe('red');
    expect(state.population.eden).toEqual({ population: 1020, remainder: 0 });
    const loaded = decodeConquestSave(encodeConquestSave(freeze(state)));
    expect(loaded).toEqual(state);
    expect(command(loaded, { kind: 'endTurn' })).toEqual(command(state, { kind: 'endTurn' }));
    state = command(command(loaded, { kind: 'endTurn' }), { kind: 'endTurn' });
    expect(state.population.eden).toEqual({ population: 1040, remainder: 40 });
  });

  it('AI uses own demographic eligibility for legal founding and avoids retrying impossible colonization', () => {
    let state = createConquest(); state.research.blue.completed = state.researchTree.nodes.map(node => node.id);
    state.researchJournal.blue = Object.fromEntries(state.research.blue.completed.map(id => [id, 1]));
    placeColonizer(state, 'eden');
    state = command(state, { kind: 'explore', systemId: 'eden' });
    expect(planConquestAction(getConquestView(state, 'blue'))).toMatchObject({ kind: 'colonize', systemId: 'eden' });
    const result = executeConquestAiTurn(state, 'blue', 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.population.eden.population).toBe(1024);
    expect(result.workforceAdjustments).toContainEqual({
      systemId: 'sol', populationBefore: 5000, populationAfter: 4000,
      before: { industry: 5000, research: 0, culture: 0 }, after: { industry: 4000, research: 0, culture: 0 }
    });
    state.population.sol.population = 1000;
    state.colonyOutput.assignments.sol.industry = 1000;
    expect(planConquestAction(getConquestView(state, 'blue')).kind).not.toBe('colonize');
  });

  it('splits equally distant AI targets by ship ID without needing hidden knowledge', () => {
    const state = createConquest();
    state.research.blue.completed = state.researchTree.nodes.map(node => node.id);
    state.researchJournal.blue = Object.fromEntries(state.research.blue.completed.map(id => [id, 1]));
    ship(state, 'sol'); ship(state, 'sol');
    const view = getConquestView(state, 'blue');
    const nexus = view.galaxy.systems.find(system => system.id === 'nexus')!;
    nexus.x = -1; nexus.y = 1;
    expect(getWorldDistance(view.galaxy.systems, 'sol', 'eden')).toBe(getWorldDistance(view.galaxy.systems, 'sol', 'nexus'));
    view.production.orders = [];
    const first = planConquestAction(view);
    expect(first).toMatchObject({ kind: 'sendShip', shipId: 1 });
    view.ships[0].transit = { destinationId: 'eden', remainingTurns: 1 };
    const second = planConquestAction(view);
    expect(second).toMatchObject({ kind: 'sendShip', shipId: 3 });
    if (first.kind !== 'sendShip' || second.kind !== 'sendShip') throw new Error('Expected movement');
    expect(second.destinationId).not.toBe(first.destinationId);
  });

  it('standalone demographic advance does not mutate the initial map or population', () => {
    const state = freeze(createConquest());
    const next = advancePopulation(state.session.galaxy, state.population, 'blue', rules);
    expect(next.sol.population).toBe(5100);
    expect(state.population.sol.population).toBe(5000);
    expect(next.vega).not.toBe(state.population.vega);
  });
});
