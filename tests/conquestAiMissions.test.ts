import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { baselineMatrix, createBaselineStart, runBaseline } from '../src/diagnostics/conquestBaseline';
import { conquestSchema, getConquestView, type Conquest, type ConquestCommand } from '../src/domain/conquest';
import * as conquest from '../src/domain/conquest';
import { executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { createComponent, createDesign, installComponent } from '../src/domain/shipDesign';
import { createOperationalState } from '../src/domain/campaignOperations';
import { getFleetTravelQuotes, getTravelCapabilities, getTravelQuote, getWorldDistance } from '../src/domain/campaignTravel';
import { MAX_FLEET_ID } from '../src/domain/campaignFleets';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { diagnosticTransit, workCommand as apply } from './fixtures/colonyWork';
import type { CampaignFactionId } from '../src/domain/campaign';

function cycleCheckpoint(): Conquest {
  return decodeConquestSave(readFileSync(
    'reports/2026-10-25/d14-ai-recon/baseline/6-41-current-ai-direct.save.json', 'utf8'));
}

function diagnosticMission(side: CampaignFactionId = 'blue', oneObjective = false) {
  const state = createBaselineStart(baselineMatrix()[0]).state;
  state.session.turn = side === 'blue' ? 1 : 2;
  state.session.ships = [];
  state.operations = {};
  const worlds = state.session.galaxy.systems;
  const home = worlds[side === 'blue' ? 0 : 3].id;
  const rear = worlds[side === 'blue' ? 1 : 4].id;
  const target = worlds[side === 'blue' ? 3 : 0].id;
  for (const faction of ['blue', 'red'] as const) {
    state.research[faction] = { completed: state.researchTree.nodes.map(node => node.id), activeId: null, progress: {} };
    state.researchJournal[faction] = Object.fromEntries(state.research[faction].completed.map(id => [id, 1]));
    state.session.treasuries[faction] = { credits: 10000, minerals: 10000 };
  }
  for (const [index, world] of worlds.entries()) {
    world.ownerId = oneObjective ? world.id === target ? side === 'blue' ? 'red' : 'blue' : side
      : index < 3 ? 'blue' : 'red';
    world.exploredBy = ['blue', 'red'];
    state.population[world.id] = { population: 5000, remainder: 0 };
    state.colonyOutput.assignments[world.id] = { industry: 5000, research: 0, culture: 0 };
    state.surveys.blue[world.id] = state.environment[world.id];
    state.surveys.red[world.id] = state.environment[world.id];
  }
  for (let index = 0; index < 4; index++) {
    const design = createDesign('corvette', true);
    design.strategicEquipment = { policy: 'project-travel-v1', drive: 'fast', jump: 'galactic', tank: 'extended' };
    const id = ++state.session.production.lastOrderId;
    state.session.ships.push({ id, factionId: side, systemId: home, design, fuel: 9000 });
    state.operations[String(id)] = createOperationalState(design);
  }
  return { state: conquestSchema.parse(state), side, home, rear, target };
}

function packet(state: Conquest) {
  const commands: ConquestCommand[] = [];
  const side: CampaignFactionId = state.session.turn % 2 ? 'blue' : 'red';
  const expectedTurn = state.session.turn;
  for (let index = 0; index < 24; index++) {
    const command: ConquestCommand = index === 23 ? { kind: 'endTurn', factionId: side, expectedTurn }
      : planConquestAction(getConquestView(state, side));
    commands.push(command);
    state = apply(state, command);
    if (command.kind === 'endTurn') return { state, commands };
  }
  throw new Error('Packet did not end');
}

describe('AI offensive missions', () => {
  it.each(baselineMatrix().filter(input => input.kind === 'paid' && input.worldCount === 6 &&
    (input.schedule === 'current-ai' || input.id === '6-12345-production-first-mirror')))(
    'breaks the paid frontier cycle after loading the unchanged D14 checkpoint $id', input => {
    const state = decodeConquestSave(readFileSync(
      `reports/2026-10-25/d14-ai-recon/baseline/${input.id}.save.json`, 'utf8'));
    const before = structuredClone(state);
    const run = runBaseline(input, { state, turnsExecuted: 60 });
    expect(state).toEqual(before);
    expect(run.status).toBe('completed');
    expect(run.turnsExecuted).toBeLessThanOrEqual(200);
    expect(run.battles.some(battle => battle.turn > state.session.turn)).toBe(true);
    expect(run.commands.every(record => record.result === 'accepted')).toBe(true);
  }, 60000);

  it('makes identical immutable decisions from an identical own observation', () => {
    const state = conquestSchema.parse(cycleCheckpoint());
    const view = getConquestView(state, 'blue'), snapshot = structuredClone(view);
    expect(planConquestAction(view)).toEqual(planConquestAction(structuredClone(view)));
    expect(view).toEqual(snapshot);
  });

  it.each(['blue', 'red'] as const)('covers alternative known objectives instead of sending every %s ship after the nearest one', side => {
    const { state } = diagnosticMission(side);
    const next = packet(state);
    const destinations = next.commands.flatMap(command =>
      command.kind === 'sendShip' || command.kind === 'sendFleet' ? [command.destinationId] : []);
    expect(new Set(destinations).size).toBe(3);
    expect(next.commands.filter(command => command.kind === 'endTurn')).toHaveLength(1);
    expect(next.commands.length).toBeLessThanOrEqual(24);
  });

  it.each(['blue', 'red'] as const)('rallies %s support before departure and releases the force after the real arrival', side => {
    const { state, home, rear } = diagnosticMission(side);
    const support = state.session.ships.at(-1)!;
    support.systemId = rear;
    const command = planConquestAction(getConquestView(state, side));
    expect(command).toMatchObject({ kind: 'sendShip', shipId: support.id, destinationId: home });
    const sent = apply(state, command), waiting = packet(sent);
    expect(waiting.commands.some(command => command.kind === 'sendShip' || command.kind === 'sendFleet')).toBe(false);
    expect(waiting.commands.some(command => command.kind === 'enqueueProduction')).toBe(true);
    const quote = getTravelQuote(getWorldDistance(state.session.galaxy.map!.worlds, rear, home),
      getTravelCapabilities(support.design.strategicEquipment), support.fuel);
    if (!quote.ok) throw new Error(quote.message);
    expect(sent.session.ships.at(-1)?.transit?.remainingTurns).toBe(quote.totalTurns);
    const arrived = waiting.state;
    expect(arrived.session.ships.at(-1)?.transit).toBeUndefined();
    const nextOwn = apply(arrived, { kind: 'endTurn' });
    expect(packet(nextOwn).commands.some(command => command.kind === 'sendShip' || command.kind === 'sendFleet')).toBe(true);
  });

  it('does not wait for merely queued ships or delay the last objective to rally', () => {
    const { state, rear, target } = diagnosticMission('blue', true);
    state.session.ships.at(-1)!.systemId = rear;
    const next = packet(state);
    const departures = next.commands.filter(command => command.kind === 'sendShip' || command.kind === 'sendFleet');
    expect(departures.length).toBeGreaterThan(0);
    expect(departures.every(command => command.destinationId === target)).toBe(true);
  });

  it.each(['blue', 'red'] as const)('defends an observed %s colony without inventing enemy equipment or departures', side => {
    const { state, home, rear } = diagnosticMission(side);
    state.session.ships.at(-1)!.systemId = rear;
    const enemy = structuredClone(state.session.ships[0]);
    enemy.id = ++state.session.production.lastOrderId;
    enemy.factionId = side === 'blue' ? 'red' : 'blue';
    state.session.ships.push(enemy);
    state.operations[String(enemy.id)] = createOperationalState(enemy.design);
    const next = packet(conquestSchema.parse(state));
    expect(next.commands.some(command => (command.kind === 'sendShip' || command.kind === 'sendFleet') &&
      command.destinationId === home)).toBe(true);
    expect(next.commands.some(command => (command.kind === 'sendShip' || command.kind === 'sendFleet') &&
      command.systemId === home)).toBe(false);
    expect(next.state.lastBattleId).toBeGreaterThan(state.lastBattleId);
  });

  it('keeps a useful existing fleet and uses its slowest drive and each real fuel tank', () => {
    const { state: source, home, target } = diagnosticMission('blue', true);
    source.session.ships[0].design.strategicEquipment.drive = 'standard';
    source.session.ships[0].design.strategicEquipment.jump = 'deep';
    const state = apply(source, { kind: 'createFleet', systemId: home, shipIds: source.session.ships.map(ship => ship.id) });
    const before = structuredClone(state);
    const command = planConquestAction(getConquestView(state, 'blue'));
    expect(command).toMatchObject({ kind: 'sendFleet', destinationId: target });
    const quotes = getFleetTravelQuotes(getWorldDistance(state.session.galaxy.map!.worlds, home, target),
      state.session.ships.map(ship => ({ capabilities: getTravelCapabilities(ship.design.strategicEquipment), fuel: ship.fuel })));
    const sent = apply(state, command);
    for (const [index, ship] of sent.session.ships.entries()) {
      const quote = quotes[index].quote;
      if (!quote.ok) throw new Error(quote.message);
      expect(ship.transit).toMatchObject({ remainingTurns: quote.totalTurns, capabilities: { strategicSpeed: 100 } });
      expect(ship.fuel).toBe(state.session.ships[index].fuel - quote.fuelCost);
    }
    expect(state).toEqual(before);
    expect(sent.session.fleets.items).toEqual(state.session.fleets.items);
    const restored = decodeConquestSave(encodeConquestSave(sent));
    expect(executeConquestAiTurn(restored, 'blue', restored.session.turn)).toEqual(
      executeConquestAiTurn(sent, 'blue', sent.session.turn));
  });

  it('does not create a group when its global ID budget is exhausted', () => {
    const { state } = diagnosticMission('blue', true);
    state.session.fleets.lastFleetId = MAX_FLEET_ID;
    const view = getConquestView(state, 'blue');
    expect(view.canCreateFleet).toBe(false);
    expect(planConquestAction(view).kind).toBe('sendShip');
    expect(executeConquestAiTurn(state, 'blue', state.session.turn).ok).toBe(true);
  });

  it('does not create a twenty-first group or hide the exhausted fleet capability', () => {
    const { state } = diagnosticMission('blue', true);
    while (state.session.ships.length < 42) {
      const ship = structuredClone(state.session.ships[0]);
      ship.id = ++state.session.production.lastOrderId;
      state.session.ships.push(ship);
      state.operations[String(ship.id)] = createOperationalState(ship.design);
    }
    for (let index = 0; index < 20; index++) state.session.fleets.items.push({
      id: ++state.session.fleets.lastFleetId, factionId: 'blue', systemId: state.session.ships[0].systemId,
      shipIds: state.session.ships.slice(index * 2, index * 2 + 2).map(ship => ship.id)
    });
    const view = getConquestView(state, 'blue');
    expect(view.canCreateFleet).toBe(false);
    const next = packet(state);
    expect(next.commands.some(command => command.kind === 'createFleet')).toBe(false);
    expect(next.commands.some(command => command.kind === 'sendFleet')).toBe(true);
  });

  it('refuels a low member rather than sending a partially capable group', () => {
    const { state: source, home } = diagnosticMission('blue', true);
    source.session.ships.at(-1)!.fuel = 0;
    const state = apply(source, { kind: 'createFleet', systemId: home, shipIds: source.session.ships.map(ship => ship.id) });
    expect(planConquestAction(getConquestView(state, 'blue'))).toMatchObject({
      kind: 'refuelShip', shipId: source.session.ships.at(-1)!.id
    });
    const result = executeConquestAiTurn(state, 'blue', state.session.turn);
    expect(result.ok).toBe(true);
  });

  it('excludes a refit-locked ship from movement and group membership', () => {
    const { state: source, home } = diagnosticMission('blue', true);
    const locked = source.session.ships[0];
    const state = apply(source, { kind: 'startRefit', systemId: home, shipId: locked.id, design: locked.design });
    const next = packet(state);
    expect(next.commands.some(command => command.kind === 'sendShip' && command.shipId === locked.id)).toBe(false);
    expect(next.commands.some(command => command.kind === 'createFleet' && command.shipIds.includes(locked.id))).toBe(false);
  });

  it('releases a usable member when a stranded leader prevents every common return route', () => {
    const { state: source, home, target } = diagnosticMission('blue', true);
    const state = apply(source, { kind: 'createFleet', systemId: home, shipIds: source.session.ships.map(ship => ship.id) });
    state.session.fleets.items[0].systemId = target;
    for (const ship of state.session.ships) ship.systemId = target;
    state.session.ships[0].fuel = 0;
    const command = planConquestAction(getConquestView(state, 'blue'));
    expect(command.kind).toBe('disbandFleet');
    const separated = apply(state, command);
    const next = planConquestAction(getConquestView(separated, 'blue'));
    expect(next.kind).toBe('sendShip');
    if (next.kind !== 'sendShip') throw new Error('Expected usable return');
    expect(next.shipId).not.toBe(state.session.ships[0].id);
    expect(separated.session.ships[0].fuel).toBe(0);
  });

  it.each([0, -1])('uses the exact return-fuel boundary (%i) without a free refuel', offset => {
    const { state, target } = diagnosticMission('blue', true);
    const ship = state.session.ships[0];
    state.session.ships = [ship];
    state.operations = { [String(ship.id)]: state.operations[String(ship.id)] };
    ship.systemId = target;
    const colonies = getConquestView(state, 'blue').galaxy.systems.filter(world =>
      world.visibility === 'explored' && world.ownerId === 'blue');
    const minimum = Math.min(...colonies.map(world => getWorldDistance(state.session.galaxy.map!.worlds, target, world.id)));
    ship.fuel = Math.ceil(minimum * 5) + offset;
    state.session.treasuries.blue = { credits: 0, minerals: 0 };
    const command = planConquestAction(getConquestView(state, 'blue'));
    expect(command.kind).toBe(offset === 0 ? 'sendShip' : 'endTurn');
    if (command.kind === 'sendShip') {
      const sent = apply(state, command);
      expect(sent.session.ships[0].fuel).toBe(0);
      expect(state.session.ships[0].fuel).toBe(Math.ceil(minimum * 5));
    }
  });

  it('does not attack with a projectile-only ship with no rounds and no affordable supply', () => {
    const { state } = diagnosticMission('blue', true);
    const ship = state.session.ships[0];
    let design = installComponent(ship.design, 'beam_1', null);
    design = installComponent(design, 'projectile_1', createComponent('projectile'));
    ship.design = design;
    state.operations[String(ship.id)] = createOperationalState(design);
    state.operations[String(ship.id)].ammunition.forEach(weapon => { weapon.amount = 0; });
    state.session.treasuries.blue = { credits: 0, minerals: 0 };
    const next = packet(conquestSchema.parse(state));
    expect(next.commands.some(command => command.kind === 'sendShip' && command.shipId === ship.id)).toBe(false);
    expect(next.commands.some(command => command.kind === 'createFleet' && command.shipIds.includes(ship.id))).toBe(false);
  });

  it('enforces the exact 24-command bound while a hundred ships need fuel and movement', () => {
    const { state } = diagnosticMission('blue', true);
    while (state.session.ships.length < 100) {
      const ship = structuredClone(state.session.ships[0]);
      ship.id = ++state.session.production.lastOrderId;
      state.session.ships.push(ship);
      state.operations[String(ship.id)] = createOperationalState(ship.design);
    }
    for (const ship of state.session.ships) ship.fuel = 0;
    const before = structuredClone(state);
    const dispatch = vi.spyOn(conquest, 'executeConquestAction');
    try {
      const result = executeConquestAiTurn(state, 'blue', state.session.turn);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.state.session.turn).toBe(state.session.turn + 1);
      expect(dispatch.mock.calls).toHaveLength(24);
      expect(dispatch.mock.calls.filter(([, command]) =>
        typeof command === 'object' && command && 'kind' in command && command.kind === 'endTurn')).toHaveLength(1);
      expect(state).toEqual(before);
    } finally { dispatch.mockRestore(); }
  });

  it('keeps decisions equal for different hidden enemy resources, operations and travel', () => {
    const { state, target } = diagnosticMission();
    const other = structuredClone(state);
    other.session.treasuries.red = { credits: 1, minerals: 2 };
    const enemy = structuredClone(other.session.ships[0]);
    enemy.id = ++other.session.production.lastOrderId;
    enemy.factionId = 'red';
    enemy.systemId = target;
    enemy.transit = diagnosticTransit(target, other.session.galaxy.systems.at(-1)!.id, enemy.design, other.session.galaxy);
    enemy.fuel -= enemy.transit.fuelCost;
    other.session.ships.push(enemy);
    other.operations[String(enemy.id)] = createOperationalState(enemy.design);
    other.operations[String(enemy.id)].hull = 1;
    const first = getConquestView(state, 'blue'), second = getConquestView(other, 'blue');
    expect(first).toEqual(second);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
    try { expect(planConquestAction(first)).toEqual(planConquestAction(second)); }
    finally { now.mockRestore(); random.mockRestore(); }
  });
});
