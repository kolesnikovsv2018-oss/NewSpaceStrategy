import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBaselineStart, baselineMatrix, runBaseline } from '../src/diagnostics/conquestBaseline';
import { conquestSchema, executeConquestCommand, getConquestView, getConquestOutcome, type Conquest } from '../src/domain/conquest';
import { executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { createDesign } from '../src/domain/shipDesign';
import { createColonizerDesign } from '../src/domain/civilianPresets';
import { createOperationalState } from '../src/domain/campaignOperations';
import { createStrategicEquipment, getTravelCapabilities, getTravelQuote, getWorldDistance } from '../src/domain/campaignTravel';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import type { CampaignFactionId } from '../src/domain/campaign';
import { diagnosticTransit, workCommand as apply } from './fixtures/colonyWork';

function diagnosticFrontier(side: CampaignFactionId, worldCount: 6 | 40 = 6) {
  const state = createBaselineStart({ ...baselineMatrix()[0], worldCount }).state;
  state.session.turn = side === 'blue' ? 1 : 2;
  state.research[side].completed = state.researchTree.nodes.map(node => node.id);
  state.researchJournal[side] = Object.fromEntries(state.research[side].completed.map(id => [id, 1]));
  state.session.treasuries[side] = { credits: 10000, minerals: 5000 };
  const map = state.session.galaxy.map!;
  const home = map.participants[side === 'blue' ? 0 : 1].homeWorldId;
  const target = map.participants[side === 'blue' ? 1 : 0].homeWorldId;
  for (const world of state.session.galaxy.systems) {
    if (state.environment[world.id] === 'barren') {
      state.surveys[side][world.id] = 'barren';
    } else if (world.id !== target) {
      world.ownerId = side;
      state.surveys[side][world.id] = state.environment[world.id];
      state.population[world.id] = { population: world.id === home ? 5000 : 1000, remainder: 0 };
      state.colonyOutput.assignments[world.id] = {
        industry: state.population[world.id].population, research: 0, culture: 0
      };
    }
    if (!world.exploredBy.includes(side)) world.exploredBy.push(side);
  }
  const removed = state.session.ships.filter(ship => ship.factionId === side);
  state.session.ships = state.session.ships.filter(ship => ship.factionId !== side);
  for (const ship of removed) delete state.operations[String(ship.id)];
  const design = createDesign('corvette', true);
  design.strategicEquipment = { policy: 'project-travel-v1', drive: 'fast', jump: 'galactic', tank: 'extended' };
  const id = ++state.session.production.lastOrderId;
  state.session.ships.push({ id, factionId: side, systemId: home, design, fuel: 9000 });
  state.operations[String(id)] = createOperationalState(design);
  conquestSchema.parse(state);
  return { state, side, home, target, id, map };
}

function checkedPlan(state: Conquest, side: CampaignFactionId) {
  const view = getConquestView(state, side), snapshot = structuredClone(view);
  const command = planConquestAction(view);
  expect(view).toEqual(snapshot);
  return command;
}

describe('AI reconnaissance distinguishes detection from environment survey', () => {
  it.each(['blue', 'red'] as const)('sends %s to a previously detected, unsurveyed world using real capabilities and fuel', side => {
    const { state, target, home, id } = diagnosticFrontier(side);
    const view = getConquestView(state, side), before = structuredClone(state);
    expect(view.knownSystems).toContain(target);
    expect(view.knownHabitableSystems).not.toContain(target);
    expect(view.environmentKnowledge[target]).toBeUndefined();
    expect(view.galaxy.systems.find(world => world.id === target)?.visibility).toBe('unknown');
    const ship = view.ships[0], caps = getTravelCapabilities(ship.design.strategicEquipment);
    const quote = getTravelQuote(getWorldDistance(view.galaxy.systems, home, target), caps, ship.fuel);
    if (!quote.ok) throw new Error(quote.message);
    const command = checkedPlan(state, side);
    expect(command).toMatchObject({ kind: 'sendShip', shipId: id, destinationId: target });
    const next = apply(state, command);
    expect(next.session.ships.find(ship => ship.id === id)).toMatchObject({
      fuel: 9000 - quote.fuelCost, transit: { destinationId: target, totalTurns: quote.totalTurns }
    });
    expect(state).toEqual(before);
  });

  it.each(['blue', 'red'] as const)('allows a %s military attack on a visible colony without a survey, not neutral founding', side => {
    const { state, target, id } = diagnosticFrontier(side);
    const observer = createColonizerDesign(), observerId = ++state.session.production.lastOrderId;
    state.session.ships.push({ id: observerId, factionId: side, systemId: target, design: observer, fuel: 3000 });
    state.operations[String(observerId)] = createOperationalState(observer);
    conquestSchema.parse(state);
    const world = getConquestView(state, side).galaxy.systems.find(world => world.id === target);
    expect(world).toMatchObject({ visibility: 'explored', habitable: false });
    expect(checkedPlan(state, side)).toMatchObject({ kind: 'sendShip', shipId: id, destinationId: target });
    const refused = executeConquestCommand(state, { kind: 'colonize', factionId: side, expectedTurn: state.session.turn,
      systemId: target, shipId: observerId });
    expect(refused.ok).toBe(false);
  });

  it('does not confuse a known barren world with an unsurveyed one', () => {
    const { state, home } = diagnosticFrontier('blue', 40);
    const ship = state.session.ships.find(ship => ship.factionId === 'blue')!;
    ship.design.strategicEquipment = createStrategicEquipment();
    ship.fuel = 3000;
    conquestSchema.parse(state);
    const view = getConquestView(state, 'blue');
    const barren = view.galaxy.systems.find(world => view.environmentKnowledge[world.id] === 'barren' &&
      getTravelQuote(getWorldDistance(view.galaxy.systems, home, world.id),
        getTravelCapabilities(ship.design.strategicEquipment), ship.fuel).ok);
    if (!barren) throw new Error('Нет достижимого barren в диагностической карте');
    expect(view.knownSystems).toContain(barren.id);
    expect(checkedPlan(state, 'blue').kind).not.toBe('sendShip');
  });

  it('keeps the complete plan identical for equal own observations with different hidden ownership', () => {
    const { state, target } = diagnosticFrontier('blue'), other = structuredClone(state);
    other.session.galaxy.systems.find(world => world.id === target)!.ownerId = null;
    other.population[target] = { population: 0, remainder: 0 };
    other.colonyOutput.assignments[target] = { industry: 0, research: 0, culture: 0 };
    conquestSchema.parse(other);
    expect(getConquestView(other, 'blue')).toEqual(getConquestView(state, 'blue'));
    expect(checkedPlan(other, 'blue')).toEqual(checkedPlan(state, 'blue'));
  });

  it('preserves the real return reserve for a detected unsurveyed target when departing from the field', () => {
    const { state, target, home, map } = diagnosticFrontier('blue', 40);
    const ship = state.session.ships.find(ship => ship.factionId === 'blue')!;
    const field = map.worlds.find(world => world.type === 'barren' &&
      getWorldDistance(map.worlds, home, world.id) <= 200);
    if (!field) throw new Error('Нет диагностической полевой позиции');
    ship.systemId = field.id;
    const caps = getTravelCapabilities(ship.design.strategicEquipment);
    const outgoing = getTravelQuote(getWorldDistance(map.worlds, field.id, target), caps, caps.fuelCapacity);
    if (!outgoing.ok) throw new Error(outgoing.message);
    const reserve = Math.min(...state.session.galaxy.systems.filter(world => world.ownerId === 'blue')
      .map(world => Math.ceil(getWorldDistance(map.worlds, target, world.id) * caps.fuelConsumptionPerDistance)));
    ship.fuel = outgoing.fuelCost;
    conquestSchema.parse(state);
    const withoutReserve = checkedPlan(state, 'blue');
    expect(withoutReserve.kind).toBe('sendShip');
    if (withoutReserve.kind !== 'sendShip') throw new Error('Нет возврата к своей колонии');
    expect(withoutReserve.destinationId).not.toBe(target);
    expect(state.session.galaxy.systems.find(world => world.id === withoutReserve.destinationId)?.ownerId).toBe('blue');
    ship.fuel += reserve;
    conquestSchema.parse(state);
    expect(checkedPlan(state, 'blue')).toMatchObject({ kind: 'sendShip', shipId: ship.id, destinationId: target });
  });

  it('returns a bounded endTurn for a valid ongoing no-colony, no-fuel, no-income position', () => {
    const state = createBaselineStart(baselineMatrix()[0]).state;
    const home = state.session.ships.find(ship => ship.factionId === 'blue')!.systemId;
    state.session.galaxy.systems.find(world => world.id === home)!.ownerId = null;
    state.population[home] = { population: 0, remainder: 0 };
    state.colonyOutput.assignments[home] = { industry: 0, research: 0, culture: 0 };
    state.session.treasuries.blue = { credits: 0, minerals: 0 };
    state.session.ships.find(ship => ship.factionId === 'blue')!.fuel = 0;
    conquestSchema.parse(state);
    expect(getConquestOutcome(state)).toEqual({ status: 'ongoing' });
    expect(checkedPlan(state, 'blue')).toMatchObject({ kind: 'endTurn' });
    const result = executeConquestAiTurn(state, 'blue', 1);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.session.turn).toBe(2);
    expect(result.state.session.treasuries.blue).toEqual({ credits: 0, minerals: 0 });
    expect(getConquestOutcome(result.state)).toEqual({ status: 'ongoing' });
  });

  it('bounds a loaded diagnostic dead end for both sides instead of confusing it with a computation hang', () => {
    const input = { ...baselineMatrix()[0], maxTurns: 6 }, state = createBaselineStart(input).state;
    for (const world of state.session.galaxy.systems) {
      world.ownerId = null;
      state.population[world.id] = { population: 0, remainder: 0 };
      state.colonyOutput.assignments[world.id] = { industry: 0, research: 0, culture: 0 };
    }
    state.session.treasuries = { blue: { credits: 0, minerals: 0 }, red: { credits: 0, minerals: 0 } };
    for (const ship of state.session.ships) ship.fuel = 0;
    conquestSchema.parse(state);
    const run = runBaseline(input, { state: decodeConquestSave(encodeConquestSave(state)), turnsExecuted: 0 });
    expect(run.status).toBe('timeout');
    expect(run.turnsExecuted).toBe(6);
    expect(run.commands).toHaveLength(6);
    expect(run.commands.every(record => record.command.kind === 'endTurn' && record.result === 'accepted')).toBe(true);
    expect(run.outcome).toEqual({ status: 'ongoing' });
  });

  it('still requires a real paid survey before founding a neutral colony', () => {
    const { state, target } = diagnosticFrontier('blue');
    state.session.galaxy.systems.find(world => world.id === target)!.ownerId = null;
    state.population[target] = { population: 0, remainder: 0 };
    state.colonyOutput.assignments[target] = { industry: 0, research: 0, culture: 0 };
    const removed = state.session.ships.filter(ship => ship.factionId === 'red');
    state.session.ships = state.session.ships.filter(ship => ship.factionId !== 'red');
    for (const ship of removed) delete state.operations[String(ship.id)];
    const id = ++state.session.production.lastOrderId, design = createColonizerDesign();
    state.session.ships.push({ id, factionId: 'blue', systemId: target, design, fuel: 3000 });
    state.operations[String(id)] = createOperationalState(design);
    conquestSchema.parse(state);
    expect(checkedPlan(state, 'blue')).toMatchObject({ kind: 'survey', systemId: target });
    const surveyed = apply(state, checkedPlan(state, 'blue'));
    expect(surveyed.session.treasuries.blue).toEqual({ credits: 9990, minerals: 4995 });
    expect(checkedPlan(surveyed, 'blue')).toMatchObject({ kind: 'colonize', systemId: target, shipId: id });
    const completed = executeConquestAiTurn(surveyed, 'blue', 1);
    if (!completed.ok) throw new Error(completed.message);
    expect(getConquestOutcome(completed.state)).toMatchObject({ status: 'completed', winner: 'blue' });
    expect(completed.state.session.turn).toBe(1);
    expect(completed.state.session.treasuries.blue).toEqual({ credits: 9970, minerals: 4985 });
    const traced = runBaseline(baselineMatrix()[0], { state: surveyed, turnsExecuted: 0 });
    expect(traced.status).toBe('completed');
    expect(traced.turnsExecuted).toBe(0);
    expect(traced.finalState).toEqual(completed.state);
  });

  it('counts a queued colonizer for a detected unsurveyed target rather than repeatedly ordering it', () => {
    const { state, home } = diagnosticFrontier('blue');
    const destination = state.session.galaxy.systems.find(world => world.ownerId === 'blue' &&
      getWorldDistance(state.session.galaxy.map!.worlds, home, world.id) > 200)!.id;
    const source = state.session.ships.find(ship => ship.factionId === 'blue')!;
    source.transit = diagnosticTransit(home, destination, source.design, state.session.galaxy);
    source.fuel -= source.transit.fuelCost;
    for (let index = 0; index < 3; index++) {
      const id = ++state.session.production.lastOrderId;
      const ship = { ...structuredClone(source), id };
      state.session.ships.push(ship);
      state.operations[String(id)] = createOperationalState(ship.design);
    }
    const design = createColonizerDesign();
    design.strategicEquipment = { ...source.design.strategicEquipment };
    const queued = apply(state, { kind: 'enqueueProduction', systemId: home, design });
    expect(checkedPlan(queued, 'blue')).toMatchObject({ kind: 'endTurn' });
  });

  it.each(baselineMatrix().filter(input => input.kind === 'paid' && input.worldCount === 6 &&
    input.schedule === 'research-first'))('finishes the genuine paid late checkpoint $id without grants', input => {
    let state = decodeConquestSave(readFileSync(new URL(
      `../reports/2026-10-25/d13-timeouts/${input.id}.save.json`, import.meta.url), 'utf8'));
    const side = input.mirrored ? 'blue' : 'red';
    if (!input.mirrored) state = apply(state, { kind: 'endTurn' });
    const before = structuredClone(state);
    const result = executeConquestAiTurn(state, side, state.session.turn);
    if (!result.ok) throw new Error(result.message);
    expect(getConquestOutcome(result.state)).toMatchObject({ status: 'completed', winner: side });
    expect(result.state.session.turn).toBe(state.session.turn + 1);
    expect(state).toEqual(before);
    expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), side, state.session.turn)).toEqual(result);
  });
});
