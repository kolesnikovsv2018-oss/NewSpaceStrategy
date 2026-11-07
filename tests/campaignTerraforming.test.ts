import { describe, expect, it } from 'vitest';
import { conquestSchema, executeConquestCommand, getConquestOutcome, getConquestView } from '../src/domain/conquest';
import { createDesign } from '../src/domain/shipDesign';
import { getColonyProjectRefund } from '../src/domain/campaignOutput';
import { encodeConquestSave, decodeConquestSave } from '../src/utils/ConquestSaveManager';
import { createOperationalState } from '../src/domain/campaignOperations';
import { planConquestAction } from '../src/domain/conquestAi';
import { createColonizerDesign } from '../src/domain/civilianPresets';
import { paidToxicColony, diagnosticTransit, workCommand as apply, workRound as round } from './fixtures/colonyWork';

describe('paid terraforming on the shared industrial FIFO', () => {
  it.each([[10999, false], [11000, true], [11001, true]] as const)('handles progress boundary %i once', (progress, completed) => {
    const { state: source, target } = paidToxicColony();
    let state = apply(source, { kind: 'startTerraform', systemId: target });
    state.colonyOutput.projects[0].productionProgress = progress;
    const result = executeConquestCommand(state, { kind: 'endTurn', systemId: undefined,
      factionId: 'player-01', expectedTurn: state.session.schedule.turn });
    expect(result.ok).toBe(false);
    state = apply(state, { kind: 'endTurn' });
    expect(state.environment[target]).toBe(completed ? 'habitable' : 'toxic');
    expect(state.colonyOutput.projects).toHaveLength(completed ? 0 : 1);
    if (!completed) expect(state.colonyOutput.projects[0].productionProgress).toBe(11999);
  });

  it.each([0, 1000, 11999])('refunds progress %i without generating money or progress on restart', progress => {
    const { state: source, target } = paidToxicColony();
    let state = apply(source, { kind: 'startTerraform', systemId: target });
    state.colonyOutput.projects[0].productionProgress = progress;
    const before = { ...state.session.treasuries['player-01'] }, refund = getColonyProjectRefund(state.colonyOutput.projects[0]);
    state = apply(state, { kind: 'cancelColonyProject', systemId: target, projectId: state.colonyOutput.projects[0].id });
    expect(state.session.treasuries['player-01']).toEqual({ credits: before.credits + refund.credits, minerals: before.minerals + refund.minerals });
    state = apply(state, { kind: 'startTerraform', systemId: target });
    expect(state.colonyOutput.projects[0].productionProgress).toBe(0);
    expect(state.session.treasuries['player-01'].credits).toBeLessThanOrEqual(before.credits);
  });

  it('uses only own capacity pressure and considers fleet opportunity cost in the bounded AI', () => {
    const { state, target, home } = paidToxicColony();
    state.research['player-01'].completed = state.researchTree.nodes.map(node => node.id);
    state.researchJournal['player-01'] = Object.fromEntries(state.research['player-01'].completed.map(id => [id, 1]));
    for (const colony of state.session.galaxy.systems.filter(world => world.ownerId === 'player-01')) {
      const capacity = getConquestView(state, 'player-01').population.find(world => world.systemId === colony.id)!.capacity;
      state.population[colony.id].population = capacity;
      state.colonyOutput.assignments[colony.id] = { industry: capacity, research: 0, culture: 0 };
    }
    for (let i = 0; i < 5; i++) {
      const design = i === 4 ? createColonizerDesign() : createDesign('fighter', true);
      design.strategicEquipment = { policy: 'project-travel-v1', drive: 'standard', jump: 'galactic', tank: 'extended' };
      const ship = { id: ++state.session.production.lastOrderId, design, systemId: target, factionId: 'player-01' as const,
        fuel: 0, transit: diagnosticTransit(target, home, design, state.session.galaxy) };
      state.session.ships.push(ship); state.operations[String(ship.id)] = createOperationalState(design);
    }
    expect(planConquestAction(getConquestView(state, 'player-01'))).toMatchObject({ kind: 'startTerraform', systemId: target });
  });

  it.each(['credits', 'minerals'] as const)('rejects insufficient %s atomically', currency => {
    const { state, target } = paidToxicColony();
    state.session.treasuries['player-01'][currency] = state.rules.terraforming.cost[currency] - 1;
    const before = structuredClone(state);
    expect(executeConquestCommand(state, { kind: 'startTerraform', factionId: 'player-01',
      expectedTurn: state.session.schedule.turn, systemId: target })).toMatchObject({ ok: false, code: 'INSUFFICIENT_RESOURCES' });
    expect(state).toEqual(before);
  });

  it('pays once, shares FIFO with ships, roundtrips progress, and applies environment only after S0 growth', () => {
    const setup = paidToxicColony(), target = setup.target;
    let state = setup.state;
    const map = structuredClone(state.session.galaxy.map), treasury = { ...state.session.treasuries['player-01'] };
    state = apply(state, { kind: 'startTerraform', systemId: target });
    const id = state.colonyOutput.projects[0].id;
    expect(state.session.treasuries['player-01']).toEqual({ credits: treasury.credits - 300, minerals: treasury.minerals - 150 });
    state = apply(state, { kind: 'enqueueProduction', systemId: target, design: createDesign('fighter', true) });
    const before = structuredClone(state);
    state = round(state);
    expect(before.colonyOutput.projects[0].productionProgress).toBe(0);
    expect(state.colonyOutput.projects[0].productionProgress).toBe(1000);
    expect(state.colonyOutput.production.orders[0].productionProgress).toBe(0);
    const restored = decodeConquestSave(encodeConquestSave(state));
    expect(round(restored)).toEqual(round(state));
    state = restored;
    for (let turn = 0; turn < 20 && state.colonyOutput.projects.length; turn++) {
      const p = state.population[target], expected = getConquestView(state, 'player-01').population.find(world => world.systemId === target)!.next;
      state = round(state);
      expect(state.population[target].population).toBeGreaterThanOrEqual(p.population);
      expect(state.population[target]).toEqual(expected);
    }
    expect(state.colonyOutput.projects).toEqual([]);
    expect(state.environment[target]).toBe('habitable');
    expect(state.session.galaxy.map).toEqual(map);
    expect(getConquestView(state, 'player-01').population.find(world => world.systemId === target)?.capacity).toBe(12000);
    expect(state.colonyOutput.production.orders[0].productionProgress).toBe(0);
    expect(state.colonyOutput.production.orders[0].id).toBeGreaterThan(id);
    expect(decodeConquestSave(encodeConquestSave(state))).toEqual(state);
    expect(round(state).colonyOutput.production.completed).toHaveLength(1);
    expect(getConquestOutcome(state)).toEqual(getConquestOutcome(setup.state));
  });

  it('shows pause, waits behind a ship, and refunds only the unused exact fraction', () => {
    const setup = paidToxicColony(), target = setup.target;
    let state = apply(setup.state, { kind: 'enqueueProduction', systemId: target, design: createDesign('fighter', true) });
    state = apply(state, { kind: 'startTerraform', systemId: target });
    state = round(state);
    expect(state.colonyOutput.projects[0].productionProgress).toBe(0);
    state = round(state);
    const project = state.colonyOutput.projects[0];
    expect(project.productionProgress).toBe(1000);
    expect(getColonyProjectRefund(project)).toEqual({ credits: 275, minerals: 137 });
    state = apply(state, { kind: 'assignWorkers', systemId: target, workers: { industry: 0, research: 0, culture: 0 } });
    expect(getConquestView(state, 'player-01').colonyOutput.forecast.production.find(row => row.systemId === target)?.productionStatus).toBe('paused');
    expect(round(state).colonyOutput.projects[0].productionProgress).toBe(1000);
    const money = { ...state.session.treasuries['player-01'] };
    state = apply(state, { kind: 'cancelColonyProject', systemId: target, projectId: project.id });
    expect(state.session.treasuries['player-01']).toEqual({ credits: money.credits + 275, minerals: money.minerals + 137 });
    expect(state.environment[target]).toBe('toxic');
    expect(getConquestView(state, 'player-02').workProjects).toEqual([]);
  });

  it('rejects duplicate/source/stale/non-owner and rolls back an overflowing refund', () => {
    const { state: source, target, home } = paidToxicColony();
    let state = apply(source, { kind: 'startTerraform', systemId: target });
    for (const payload of [{ systemId: target }, { systemId: home }, { systemId: target, expectedTurn: 1 },
      { systemId: target, factionId: 'player-02' }]) {
      expect(executeConquestCommand(state, { kind: 'startTerraform', factionId: 'player-01',
        expectedTurn: state.session.schedule.turn, ...payload }).ok).toBe(false);
    }
    state.session.treasuries['player-01'].credits = 1_000_000_000;
    const before = structuredClone(state);
    expect(executeConquestCommand(state, { kind: 'cancelColonyProject', systemId: target,
      projectId: state.colonyOutput.projects[0].id, factionId: 'player-01', expectedTurn: state.session.schedule.turn }))
      .toMatchObject({ ok: false, code: 'RESOURCE_LIMIT' });
    expect(state).toEqual(before);
  });

  it('does not complete a project for the old owner when the colony is occupied on the completion end', () => {
    const setup = paidToxicColony(), target = setup.target;
    let state = apply(setup.state, { kind: 'startTerraform', systemId: target });
    state.colonyOutput.projects[0].productionProgress = 11000;
    const ship = { id: ++state.session.production.lastOrderId, factionId: 'player-02' as const, systemId: target,
      design: createDesign('fighter', true), fuel: 3000 };
    state.session.ships.push(ship);
    state.operations[String(ship.id)] = createOperationalState(ship.design);
    state = apply(conquestSchema.parse(state), { kind: 'endTurn' });
    expect(state.session.galaxy.systems.find(world => world.id === target)?.ownerId).toBe('player-02');
    expect(state.environment[target]).toBe('toxic');
    expect(state.colonyOutput.projects).toEqual([]);
  });
});
