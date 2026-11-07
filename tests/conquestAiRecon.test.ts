import { describe, expect, it } from 'vitest';
import { createBaselineStart, baselineMatrix, runBaseline } from '../src/diagnostics/conquestBaseline';
import { conquestSchema, executeConquestCommand, getConquestView, getConquestOutcome, type Conquest } from '../src/domain/conquest';
import { executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { createDesign } from '../src/domain/shipDesign';
import { createColonizerDesign } from '../src/domain/civilianPresets';
import { createOperationalState } from '../src/domain/campaignOperations';
import { createStrategicEquipment, getTravelCapabilities, getTravelQuote, getWorldDistance } from '../src/domain/campaignTravel';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import type { ParticipantId } from '../src/domain/campaign';
import { diagnosticTransit, workCommand as apply } from './fixtures/colonyWork';

function diagnosticFrontier(side: ParticipantId, worldCount: 6 | 40 = 6) {
  const state = createBaselineStart({ ...baselineMatrix()[0], worldCount }).state;
  state.session.schedule = side === 'player-01'
    ? { order: state.session.schedule.order, activeIndex: 0, turn: 1, revision: 0, round: 1 }
    : { order: state.session.schedule.order, activeIndex: 1, turn: 2, revision: 1, round: 1 };
  state.research[side].completed = state.researchTree.nodes.map(node => node.id);
  state.researchJournal[side] = Object.fromEntries(state.research[side].completed.map(id => [id, 1]));
  state.session.treasuries[side] = { credits: 10000, minerals: 5000 };
  const map = state.session.galaxy.map!;
  const home = map.participants[side === 'player-01' ? 0 : 1].homeWorldId;
  const target = map.participants[side === 'player-01' ? 1 : 0].homeWorldId;
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

function checkedPlan(state: Conquest, side: ParticipantId) {
  const view = getConquestView(state, side), snapshot = structuredClone(view);
  const command = planConquestAction(view);
  expect(view).toEqual(snapshot);
  return command;
}

describe('AI reconnaissance distinguishes detection from environment survey', () => {
  it.each(['player-01', 'player-02'] as const)('sends %s to a previously detected, unsurveyed world using real capabilities and fuel', side => {
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

  it.each(['player-01', 'player-02'] as const)('allows a %s military attack on a visible colony without a survey, not neutral founding', side => {
    const { state, target, id } = diagnosticFrontier(side);
    const observer = createColonizerDesign(), observerId = ++state.session.production.lastOrderId;
    state.session.ships.push({ id: observerId, factionId: side, systemId: target, design: observer, fuel: 3000 });
    state.operations[String(observerId)] = createOperationalState(observer);
    conquestSchema.parse(state);
    const world = getConquestView(state, side).galaxy.systems.find(world => world.id === target);
    expect(world).toMatchObject({ visibility: 'explored', habitable: false });
    expect(checkedPlan(state, side)).toMatchObject({ kind: 'sendShip', shipId: id, destinationId: target });
    const refused = executeConquestCommand(state, { kind: 'colonize', factionId: side, expectedTurn: state.session.schedule.turn,
      systemId: target, shipId: observerId });
    expect(refused.ok).toBe(false);
  });

  it('does not confuse a known barren world with an unsurveyed one', () => {
    const { state, home } = diagnosticFrontier('player-01', 40);
    const ship = state.session.ships.find(ship => ship.factionId === 'player-01')!;
    ship.design.strategicEquipment = createStrategicEquipment();
    ship.fuel = 3000;
    conquestSchema.parse(state);
    const view = getConquestView(state, 'player-01');
    const barren = view.galaxy.systems.find(world => view.environmentKnowledge[world.id] === 'barren' &&
      getTravelQuote(getWorldDistance(view.galaxy.systems, home, world.id),
        getTravelCapabilities(ship.design.strategicEquipment), ship.fuel).ok);
    if (!barren) throw new Error('Нет достижимого barren в диагностической карте');
    expect(view.knownSystems).toContain(barren.id);
    expect(checkedPlan(state, 'player-01').kind).not.toBe('sendShip');
  });

  it('keeps the complete plan identical for equal own observations with different hidden ownership', () => {
    const { state, target } = diagnosticFrontier('player-01'), other = structuredClone(state);
    other.session.galaxy.systems.find(world => world.id === target)!.ownerId = null;
    other.population[target] = { population: 0, remainder: 0 };
    other.colonyOutput.assignments[target] = { industry: 0, research: 0, culture: 0 };
    conquestSchema.parse(other);
    expect(getConquestView(other, 'player-01')).toEqual(getConquestView(state, 'player-01'));
    expect(checkedPlan(other, 'player-01')).toEqual(checkedPlan(state, 'player-01'));
  });

  it('preserves the real return reserve for a detected unsurveyed target when departing from the field', () => {
    const { state, target, home, map } = diagnosticFrontier('player-01', 40);
    const ship = state.session.ships.find(ship => ship.factionId === 'player-01')!;
    const field = map.worlds.find(world => world.type === 'barren' &&
      getWorldDistance(map.worlds, home, world.id) <= 200);
    if (!field) throw new Error('Нет диагностической полевой позиции');
    ship.systemId = field.id;
    const caps = getTravelCapabilities(ship.design.strategicEquipment);
    const outgoing = getTravelQuote(getWorldDistance(map.worlds, field.id, target), caps, caps.fuelCapacity);
    if (!outgoing.ok) throw new Error(outgoing.message);
    const reserve = Math.min(...state.session.galaxy.systems.filter(world => world.ownerId === 'player-01')
      .map(world => Math.ceil(getWorldDistance(map.worlds, target, world.id) * caps.fuelConsumptionPerDistance)));
    ship.fuel = outgoing.fuelCost;
    conquestSchema.parse(state);
    const withoutReserve = checkedPlan(state, 'player-01');
    expect(withoutReserve.kind).toBe('sendShip');
    if (withoutReserve.kind !== 'sendShip') throw new Error('Нет возврата к своей колонии');
    expect(withoutReserve.destinationId).not.toBe(target);
    expect(state.session.galaxy.systems.find(world => world.id === withoutReserve.destinationId)?.ownerId).toBe('player-01');
    ship.fuel += reserve;
    conquestSchema.parse(state);
    expect(checkedPlan(state, 'player-01')).toMatchObject({ kind: 'sendShip', shipId: ship.id, destinationId: target });
  });

  it('returns a bounded endTurn for a valid ongoing no-colony, no-fuel, no-income position', () => {
    const state = createBaselineStart(baselineMatrix()[0]).state;
    const home = state.session.ships.find(ship => ship.factionId === 'player-01')!.systemId;
    state.session.galaxy.systems.find(world => world.id === home)!.ownerId = null;
    state.population[home] = { population: 0, remainder: 0 };
    state.colonyOutput.assignments[home] = { industry: 0, research: 0, culture: 0 };
    state.session.treasuries['player-01'] = { credits: 0, minerals: 0 };
    state.session.ships.find(ship => ship.factionId === 'player-01')!.fuel = 0;
    conquestSchema.parse(state);
    expect(getConquestOutcome(state)).toEqual({ status: 'ongoing' });
    expect(checkedPlan(state, 'player-01')).toMatchObject({ kind: 'endTurn' });
    const result = executeConquestAiTurn(state, 'player-01', 1);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.session.schedule.turn).toBe(2);
    expect(result.state.session.treasuries['player-01']).toEqual({ credits: 0, minerals: 0 });
    expect(getConquestOutcome(result.state)).toEqual({ status: 'ongoing' });
  });

  it('bounds a loaded diagnostic dead end for both sides instead of confusing it with a computation hang', () => {
    const input = { ...baselineMatrix()[0], maxTurns: 6 }, state = createBaselineStart(input).state;
    for (const world of state.session.galaxy.systems) {
      world.ownerId = null;
      state.population[world.id] = { population: 0, remainder: 0 };
      state.colonyOutput.assignments[world.id] = { industry: 0, research: 0, culture: 0 };
    }
    state.session.treasuries = { 'player-01': { credits: 0, minerals: 0 }, 'player-02': { credits: 0, minerals: 0 } };
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
    const { state, target } = diagnosticFrontier('player-01');
    state.session.galaxy.systems.find(world => world.id === target)!.ownerId = null;
    state.population[target] = { population: 0, remainder: 0 };
    state.colonyOutput.assignments[target] = { industry: 0, research: 0, culture: 0 };
    const removed = state.session.ships.filter(ship => ship.factionId === 'player-02');
    state.session.ships = state.session.ships.filter(ship => ship.factionId !== 'player-02');
    for (const ship of removed) delete state.operations[String(ship.id)];
    const id = ++state.session.production.lastOrderId, design = createColonizerDesign();
    state.session.ships.push({ id, factionId: 'player-01', systemId: target, design, fuel: 3000 });
    state.operations[String(id)] = createOperationalState(design);
    conquestSchema.parse(state);
    expect(checkedPlan(state, 'player-01')).toMatchObject({ kind: 'survey', systemId: target });
    const surveyed = apply(state, checkedPlan(state, 'player-01'));
    expect(surveyed.session.treasuries['player-01']).toEqual({ credits: 9990, minerals: 4995 });
    expect(checkedPlan(surveyed, 'player-01')).toMatchObject({ kind: 'colonize', systemId: target, shipId: id });
    const completed = executeConquestAiTurn(surveyed, 'player-01', 1);
    if (!completed.ok) throw new Error(completed.message);
    expect(getConquestOutcome(completed.state)).toMatchObject({ status: 'completed', winner: 'player-01' });
    expect(completed.state.session.schedule.turn).toBe(1);
    expect(completed.state.session.treasuries['player-01']).toEqual({ credits: 9970, minerals: 4985 });
    const traced = runBaseline(baselineMatrix()[0], { state: surveyed, turnsExecuted: 0 });
    expect(traced.status).toBe('completed');
    expect(traced.turnsExecuted).toBe(0);
    expect(traced.finalState).toEqual(completed.state);
  });

  it('counts a queued colonizer for a detected unsurveyed target rather than repeatedly ordering it', () => {
    const { state, home } = diagnosticFrontier('player-01');
    const destination = state.session.galaxy.systems.find(world => world.ownerId === 'player-01' &&
      getWorldDistance(state.session.galaxy.map!.worlds, home, world.id) > 200)!.id;
    const source = state.session.ships.find(ship => ship.factionId === 'player-01')!;
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
    const command = checkedPlan(queued, 'player-01');
    // Н15: законный startBuilding заменяет прежний бездействующий endTurn; повторный заказ колонизатора по-прежнему запрещён.
    expect(command.kind !== 'enqueueProduction' || command.design.hullId !== 'colonizer').toBe(true);
  });

  it.each(baselineMatrix().filter(input => input.kind === 'paid' && input.worldCount === 6 &&
    input.schedule === 'research-first'))('finishes the paid research-first horizon with one own turn $id', input => {
    // Н15: чекпоинты Д13 (save16/tree10) нечитаемы актуальным форматом 17/14 без миграций;
    // эквивалент — свежий прогон той же paid-матрицы: полный прогон даёт финиш T и победителя,
    // прогон до T-1 и один собственный AI-ход завершают партию без грантов.
    const full = runBaseline(input);
    expect(full.status).toBe('completed');
    if (full.status !== 'completed') throw new Error('Expected completed horizon');
    if (full.outcome.status !== 'completed') throw new Error('Expected completed outcome');
    const side = full.outcome.winner;
    const horizon = full.turnsExecuted;
    const pre = runBaseline({ ...input, maxTurns: horizon - 1 });
    expect(pre.status).toBe('timeout');
    if (!pre.finalState) throw new Error('Expected pre-completion state');
    const state = pre.finalState;
    const before = structuredClone(state);
    const result = executeConquestAiTurn(state, side, state.session.schedule.turn);
    if (!result.ok) throw new Error(result.message);
    expect(getConquestOutcome(result.state)).toMatchObject({ status: 'completed', winner: side });
    expect(result.state.session.schedule.turn).toBe(state.session.schedule.turn + 1);
    expect(state).toEqual(before);
    expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), side, state.session.schedule.turn)).toEqual(result);
  }, 120000);
});
