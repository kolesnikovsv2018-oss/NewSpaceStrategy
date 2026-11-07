import { describe, expect, it } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand, getConquestView, type Conquest } from '../src/domain/conquest';
import { executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { createDesign } from '../src/domain/shipDesign';
import { createColonizerDesign } from '../src/domain/civilianPresets';
import { createOperationalState } from '../src/domain/campaignOperations';
import { getTravelCapabilities, getTravelQuote, getWorldDistance } from '../src/domain/campaignTravel';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';
import { validateGalaxyMap } from '../src/domain/galaxyMap';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import type { ParticipantId } from '../src/domain/campaign';
import { diagnosticTransit, finishWorkTravel, workCommand as apply, workRound as round } from './fixtures/colonyWork';

function setup(faction: ParticipantId, count = 40, seed = 41) {
  const generated = generateBrowserGalaxy(count, seed);
  if (!generated.ok) throw new Error(generated.message);
  const state = createConquest(undefined, undefined, 101, generated.map);
  state.session.schedule = faction === 'player-01'
    ? { order: state.session.schedule.order, activeIndex: 0, turn: 1, revision: 0, round: 1 }
    : { order: state.session.schedule.order, activeIndex: 1, turn: 2, revision: 1, round: 1 };
  state.research[faction].completed = state.researchTree.nodes.map(node => node.id);
  state.researchJournal[faction] = Object.fromEntries(state.research[faction].completed.map(id => [id, 1]));
  const map = state.session.galaxy.map!;
  const home = map.participants[faction === 'player-01' ? 0 : 1].homeWorldId;
  state.colonyOutput.assignments[home] = { industry: 5000, research: 0, culture: 0 };
  state.session.treasuries[faction] = { credits: 10000, minerals: 5000 };
  return { state, map, home };
}

function busyCombat(state: Conquest, faction: ParticipantId, home: string, target: string) {
  for (let index = 0; index < 4; index++) {
    const design = createDesign('corvette', true);
    design.strategicEquipment = { policy: 'project-travel-v1', drive: 'fast', jump: 'galactic', tank: 'extended' };
    const transit = diagnosticTransit(home, target, design, state.session.galaxy);
    const id = ++state.session.production.lastOrderId;
    state.session.ships.push({ id, factionId: faction, systemId: home, design, transit, fuel: 9000 - transit.fuelCost });
    state.operations[String(id)] = createOperationalState(design);
  }
}

function stranded(faction: ParticipantId, fuel: number) {
  const prepared = setup(faction);
  const { state, map, home } = prepared;
  const barren = map.worlds.find(world => world.type === 'barren' &&
    getWorldDistance(map.worlds, home, world.id) <= 200 &&
    map.worlds.some(target => target.type === 'habitable' && target.ownerId === null &&
      getWorldDistance(map.worlds, world.id, target.id) <= 200));
  if (!barren) throw new Error('Нет диагностического barren у своей колонии');
  const colonizer = state.session.ships.find(ship => ship.factionId === faction)!;
  colonizer.systemId = barren.id;
  colonizer.fuel = fuel;
  state.surveys[faction][barren.id] = 'barren';
  state.session.galaxy.systems.find(world => world.id === barren.id)!.exploredBy = [faction];
  busyCombat(state, faction, home, barren.id);
  expect(conquestSchema.safeParse(state).success).toBe(true);
  return { ...prepared, barren, colonizer };
}

function plan(state: Conquest, faction: ParticipantId) {
  expect(conquestSchema.safeParse(state).success).toBe(true);
  const view = getConquestView(state, faction), before = structuredClone(view);
  const command = planConquestAction(view);
  expect(view).toEqual(before);
  return command;
}

function returnScenario(fuel: number) {
  const prepared = setup('player-01', 8, 8);
  const { state, map } = prepared, from = map.worlds[1], colony = map.worlds[2], target = map.worlds[7];
  const own = state.session.galaxy.systems.find(world => world.id === colony.id)!;
  own.ownerId = 'player-01'; own.exploredBy = ['player-01'];
  state.surveys['player-01'][colony.id] = 'habitable';
  state.population[colony.id] = { population: 1000, remainder: 0 };
  state.colonyOutput.assignments[colony.id] = { industry: 1000, research: 0, culture: 0 };
  state.session.ships = state.session.ships.filter(ship => ship.factionId !== 'player-01');
  delete state.operations['1'];
  const design = createDesign('corvette', true), id = ++state.session.production.lastOrderId;
  state.session.ships.push({ id, factionId: 'player-01', systemId: from.id, design, fuel });
  state.operations[String(id)] = createOperationalState(design);
  state.surveys['player-01'][from.id] = 'habitable';
  state.session.galaxy.systems.find(world => world.id === from.id)!.exploredBy = ['player-01'];
  return { ...prepared, from, colony, target, id, caps: getTravelCapabilities(design.strategicEquipment) };
}

describe('AI fuel planning without imaginary refuelling', () => {
  it.each([
    ['player-01', 0], ['player-01', 1], ['player-02', 0], ['player-02', 1]
  ] as const)('orders one replacement for an immobile %s colonizer with fuel%i', (faction, fuel) => {
    const { state, colonizer, home } = stranded(faction, fuel);
    const view = getConquestView(state, faction), before = structuredClone(state);
    const caps = getTravelCapabilities(colonizer.design.strategicEquipment);
    expect(view.galaxy.systems.some(world =>
      getTravelQuote(getWorldDistance(view.galaxy.systems, colonizer.systemId, world.id), caps, fuel).ok)).toBe(false);
    expect(plan(state, faction)).toMatchObject({ kind: 'enqueueProduction', systemId: home,
      design: { hullId: 'colonizer' } });
    const result = executeConquestAiTurn(state, faction, state.session.schedule.turn);
    if (!result.ok) throw new Error(result.message);
    expect(state).toEqual(before);
    expect(result.state.session.schedule.turn).toBe(state.session.schedule.turn + 1);
    expect(result.state.session.production.lastOrderId).toBeGreaterThan(state.session.production.lastOrderId);
    const records = [...result.state.colonyOutput.production.orders, ...result.state.colonyOutput.production.completed];
    expect(records.filter(record => record.factionId === faction && record.design.hullId === 'colonizer')).toHaveLength(1);
    expect(result.state.session.ships.find(ship => ship.id === colonizer.id)!.fuel).toBe(fuel);
    expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), faction, state.session.schedule.turn)).toEqual(result);
  });

  it.each(['player-01', 'player-02'] as const)('returns a recoverable %s colonizer for real paid refuelling', faction => {
    const { state, colonizer, home, map } = stranded(faction, 0);
    const caps = getTravelCapabilities(colonizer.design.strategicEquipment);
    const quote = getTravelQuote(getWorldDistance(map.worlds, colonizer.systemId, home), caps, caps.fuelCapacity);
    if (!quote.ok) throw new Error(quote.message);
    colonizer.fuel = quote.fuelCost;
    const command = plan(state, faction);
    expect(command).toMatchObject({ kind: 'sendShip', shipId: colonizer.id, destinationId: home });
    let next = apply(state, command);
    expect(next.session.ships.find(ship => ship.id === colonizer.id)!.fuel).toBe(0);
    expect(plan(next, faction).kind).not.toBe('enqueueProduction');
    next = finishWorkTravel(next, colonizer.id);
    const workers = { ...next.colonyOutput.assignments[home] };
    expect(plan(next, faction)).toMatchObject({ kind: 'refuelShip', shipId: colonizer.id, systemId: home });
    const before = { ...next.session.treasuries[faction] };
    next = apply(next, plan(next, faction));
    expect(next.session.ships.find(ship => ship.id === colonizer.id)!.fuel).toBe(3000);
    expect(next.colonyOutput.assignments[home]).toEqual(workers);
    expect(next.session.treasuries[faction]).toEqual({ credits: before.credits - 15, minerals: before.minerals - 6 });
  });

  it('does not count an outbound-only colonizer whose unknown targets all fail the real return reserve', () => {
    const { state, map, home, barren, colonizer } = stranded('player-01', 0);
    const distance = Math.min(...map.worlds.filter(world => world.id !== home && world.id !== barren.id)
      .map(world => getWorldDistance(map.worlds, barren.id, world.id)));
    colonizer.fuel = Math.ceil(distance * 5);
    expect(colonizer.fuel).toBeLessThan(Math.ceil(getWorldDistance(map.worlds, barren.id, home) * 5));
    expect(plan(state, 'player-01')).toMatchObject({ kind: 'enqueueProduction', design: { hullId: 'colonizer' } });
  });

  it.each([
    ['player-01', false], ['player-02', false], ['player-01', true], ['player-02', true]
  ] as const)('keeps an incoming %s colonizer with fuel0, previously detected target=%s', (faction, detected) => {
    const { state, colonizer, home, map } = stranded(faction, 0);
    const destination = map.worlds.find(world => world.ownerId === null && world.type === 'habitable' &&
      getTravelQuote(getWorldDistance(map.worlds, home, world.id),
        getTravelCapabilities(colonizer.design.strategicEquipment), 3000).ok)!;
    colonizer.systemId = home;
    const quote = getTravelQuote(getWorldDistance(map.worlds, home, destination.id),
      getTravelCapabilities(colonizer.design.strategicEquipment), 3000);
    if (!quote.ok) throw new Error(quote.message);
    if (detected) state.session.galaxy.systems.find(world => world.id === destination.id)!.exploredBy = [faction];
    expect(state.surveys[faction]).not.toHaveProperty(destination.id);
    colonizer.fuel = quote.fuelCost;
    const next = apply(state, { kind: 'sendShip', systemId: home, shipId: colonizer.id, destinationId: destination.id });
    expect(next.session.ships.find(ship => ship.id === colonizer.id)!.fuel).toBe(0);
    expect(plan(next, faction).kind).not.toBe('enqueueProduction');
  });

  it.each(['player-01', 'player-02'] as const)('counts a fully fuelled future %s colonizer in queued and completed production', faction => {
    let { state, colonizer, home } = stranded(faction, 0);
    state.session.ships = state.session.ships.filter(ship => ship.id !== colonizer.id);
    delete state.operations[String(colonizer.id)];
    state = apply(state, { kind: 'enqueueProduction', systemId: home, design: createColonizerDesign() });
    expect(plan(state, faction).kind).not.toBe('enqueueProduction');
    state = round(state);
    expect(plan(state, faction)).toMatchObject({ kind: 'deployProduction',
      orderId: state.colonyOutput.production.completed[0].id });
  });

  it.each([
    [1126, false], [1130, false], [1131, true]
  ] as const)('uses the actual return price for fuel%i, allowing the exact boundary=%s', (fuel, safe) => {
    const { state, home, from, target, map, id, caps } = returnScenario(fuel);
    const outgoing = getTravelQuote(getWorldDistance(map.worlds, from.id, target.id), caps, fuel);
    expect(outgoing).toMatchObject({ ok: true, fuelCost: 563 });
    if (!outgoing.ok) throw new Error(outgoing.message);
    expect(Math.ceil(getWorldDistance(map.worlds, target.id, home) * 5)).toBe(568);
    const action = plan(state, 'player-01');
    expect(action).toMatchObject({ kind: 'sendShip', shipId: id, destinationId: safe ? target.id : home });
    const sent = executeConquestCommand(state, action);
    if (!sent.ok) throw new Error(sent.message);
    if (safe) {
      let next = finishWorkTravel(sent.state, id);
      expect(next.session.ships.find(ship => ship.id === id)!.fuel).toBe(568);
      next = apply(next, { kind: 'sendShip', systemId: target.id, shipId: id, destinationId: home });
      expect(next.session.ships.find(ship => ship.id === id)!.fuel).toBe(0);
    }
  });

  it('accepts a real return to another own colony instead of requiring the departure home', () => {
    const fixture = returnScenario(3000);
    const { state, map, home, from, colony, target, id, caps } = fixture;
    const origin = map.worlds.find(world => world.id === home)!;
    const length = getWorldDistance(map.worlds, home, target.id);
    colony.x = origin.x + (target.x - origin.x) * 25 / length;
    colony.y = origin.y + (target.y - origin.y) * 25 / length;
    expect(validateGalaxyMap(map).ok).toBe(true);
    const outward = Math.ceil(getWorldDistance(map.worlds, from.id, target.id) * 5);
    const back = Math.ceil(getWorldDistance(map.worlds, target.id, colony.id) * 5);
    expect(back).toBeLessThan(outward);
    state.session.ships.find(ship => ship.id === id)!.fuel = outward + back;
    expect(getTravelQuote(getWorldDistance(map.worlds, target.id, home), caps, back).ok).toBe(false);
    const action = plan(state, 'player-01');
    expect(action).toMatchObject({ kind: 'sendShip', shipId: id, destinationId: target.id });
    let next = apply(state, action);
    next = finishWorkTravel(next, id);
    next = apply(next, { kind: 'sendShip', systemId: target.id, shipId: id, destinationId: colony.id });
    expect(next.session.ships.find(ship => ship.id === id)!.fuel).toBe(0);
  });

  it('rejects a fuel-affordable exploration when every own return exceeds the jump limit', () => {
    const { state, map, home, from, colony, target, id } = returnScenario(3000);
    const origin = map.worlds.find(world => world.id === home)!;
    const position = Array.from({ length: 360 }, (_, index) => ({
      x: origin.x + 201 * Math.cos(index * Math.PI / 180),
      y: origin.y + 201 * Math.sin(index * Math.PI / 180)
    })).find(candidate => candidate.x >= 0 && candidate.x <= 1000 && candidate.y >= 0 && candidate.y <= 1000 &&
      Math.hypot(candidate.x - from.x, candidate.y - from.y) <= 200 &&
      Math.hypot(candidate.x - colony.x, candidate.y - colony.y) > 200 &&
      map.worlds.every(world => world.id === target.id || Math.hypot(candidate.x - world.x, candidate.y - world.y) >= 10));
    if (!position) throw new Error('Нет диагностической границы перехода');
    Object.assign(target, position);
    expect(validateGalaxyMap(map).ok).toBe(true);
    expect(getWorldDistance(map.worlds, target.id, home)).toBeCloseTo(201);
    expect(plan(state, 'player-01')).toMatchObject({ kind: 'sendShip', shipId: id, destinationId: home });
  });
});
