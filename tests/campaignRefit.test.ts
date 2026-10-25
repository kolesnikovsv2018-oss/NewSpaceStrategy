import { describe, expect, it } from 'vitest';
import { createConquest, executeConquestCommand, getConquestView, conquestSchema, type Conquest } from '../src/domain/conquest';
import { createDesign, createComponentWithId, installComponent, calculateShipStats, calculateComponent, validateDesign, type ShipDesign } from '../src/domain/shipDesign';
import { getRefitQuote, getRefitOperationalState, createOperationalState } from '../src/domain/campaignOperations';
import { getColonyProjectRefund } from '../src/domain/campaignOutput';
import { hasCompactEquipment, isCampaignDesignAvailable } from '../src/domain/campaignResearch';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { buildConquestDesigns } from '../src/domain/conquestAi';
import { workCommand as apply, workRound as round, earnWorkTechnology as earn } from './fixtures/colonyWork';

function compact(design: ShipDesign): ShipDesign {
  return { ...structuredClone(design), id: `${design.id}-compact`, name: 'Компактный проект',
    slots: design.slots.map(slot => ({ ...slot, component: slot.component ? { ...slot.component, technologyVariant: 'compact' } : null })) };
}
function paidShip() {
  let state = createConquest();
  state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 1000, research: 4000, culture: 0 } });
  for (const id of ['engineering', 'support', 'ordnance']) state = earn(state, id);
  const design = installComponent(createDesign('corvette', true), 'projectile_1', createComponentWithId('projectile', 'projectile'));
  state = apply(state, { kind: 'enqueueProduction', systemId: 'sol', design });
  const id = state.session.production.lastOrderId;
  state = round(state);
  state = apply(state, { kind: 'deployProduction', systemId: 'sol', orderId: id });
  return { state, id, design };
}
function reject(state: Conquest, payload: Record<string, unknown>, code?: string) {
  const before = structuredClone(state);
  const result = executeConquestCommand(state, { factionId: 'blue', expectedTurn: state.session.turn, ...payload });
  expect(result).toMatchObject({ ok: false, ...(code ? { code } : {}) });
  expect(state).toEqual(before);
}

describe('effective equipment and paid refit', () => {
  it('uses the old equipment in a real battle and cancels a destroyed ship even at the completion boundary', () => {
    const setup = paidShip();
    let state = earn(setup.state, 'miniaturization');
    state.operations[String(setup.id)].hull = 1;
    state = apply(state, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: compact(setup.design) });
    const project = state.colonyOutput.projects[0];
    project.productionProgress = project.productionCost - 1;
    state.session.ships = state.session.ships.filter(ship => ship.id !== 1);
    delete state.operations['1'];
    const attacker = { id: ++state.session.production.lastOrderId, factionId: 'red' as const, systemId: 'sol' as const,
      design: createDesign('fighter', true), fuel: 3000 };
    state.session.ships.push(attacker); state.operations[String(attacker.id)] = createOperationalState(attacker.design);
    const result = executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: state.session.turn });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.battles.at(-1)?.destroyed).toContain(setup.id);
    expect(result.state.session.ships.some(ship => ship.id === setup.id)).toBe(false);
    expect(result.state.colonyOutput.projects).toEqual([]);
    expect(result.turnReceipt?.cancelledWorldProjectIds).toContain(project.id);
    expect(result.turnReceipt?.completedWorldProjectIds).not.toContain(project.id);
  });

  it.each(['zero', 'partial', 'last'] as const)('cancels %s refit with the exact unused refund and no operations reset', phase => {
    const setup = paidShip();
    let state = earn(setup.state, 'miniaturization');
    state = apply(state, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: compact(setup.design) });
    const project = state.colonyOutput.projects[0];
    project.productionProgress = phase === 'zero' ? 0 : phase === 'partial' ? 1 : project.productionCost - 1;
    const refund = getColonyProjectRefund(project), operations = structuredClone(state.operations);
    const treasury = { ...state.session.treasuries.blue };
    state = apply(state, { kind: 'cancelColonyProject', systemId: 'sol', projectId: project.id });
    expect(state.session.treasuries.blue).toEqual({ credits: treasury.credits + refund.credits, minerals: treasury.minerals + refund.minerals });
    expect(state.operations).toEqual(operations);
    expect(state.session.ships.find(ship => ship.id === setup.id)!.design).toEqual(setup.design);
  });
  it('enforces exact and +1 equipment budgets separately from mass, power, slots and cargo', () => {
    const fighter = compact(createDesign('fighter', true));
    const twin = installComponent(fighter, 'beam_2', { ...createComponentWithId('beam', 'second'), technologyVariant: 'compact' });
    expect(calculateShipStats(twin).equipmentVolume).toBe(60);
    expect(validateDesign(twin, 'flight')).toEqual([]);
    const base = createDesign('fighter');
    base.slots.find(slot => slot.id === 'beam_1')!.component = createComponentWithId('beam', 'beam');
    base.slots.find(slot => slot.id === 'shield_1')!.component = createComponentWithId('shield', 'shield');
    base.slots.find(slot => slot.id === 'armor_1')!.component = { ...createComponentWithId('armor', 'armor'), technologyVariant: 'compact' };
    expect(calculateShipStats(base).equipmentVolume).toBe(61);
    expect(validateDesign(base, 'draft')).toMatchObject([{ code: 'equipment-volume' }]);
    const standard = createDesign('fighter', true), small = compact(standard);
    expect(calculateShipStats(small).mass).toBe(calculateShipStats(standard).mass);
    expect(calculateShipStats(small).cargoVolume).toBe(calculateShipStats(standard).cargoVolume);
    const beam = createComponentWithId('beam', 'price'), mini = { ...beam, technologyVariant: 'compact' as const };
    expect(calculateComponent(mini).cost).toBe(Math.ceil(calculateComponent(beam).cost * 5 / 4));
    const massive = structuredClone(small), engine = massive.slots.find(slot => slot.component?.kind === 'engine')!.component!;
    if (engine.kind !== 'engine') throw new Error('Missing engine');
    engine.thrust = 100000;
    expect(validateDesign(massive, 'flight').some(issue => issue.code === 'mass')).toBe(true);
    engine.thrust = 1000; engine.powerGeneration = 0;
    expect(validateDesign(massive, 'flight').some(issue => issue.code === 'power')).toBe(true);
    expect(validateDesign({ ...small, schemaVersion: 2 }, 'draft').some(issue => issue.code === 'schema')).toBe(true);
    expect(validateDesign({ ...small, slots: small.slots.map(slot => ({ ...slot,
      component: slot.component ? { ...slot.component, equipmentVolume: 0 } : null })) }, 'draft').length).toBeGreaterThan(0);
  });

  it('earns compact access without rewriting paid orders, completed, ships or transit snapshots', () => {
    const setup = paidShip();
    let state = setup.state;
    const next = compact(setup.design);
    expect(isCampaignDesignAvailable(next, state.research.blue, state.researchTree)).toBe(false);
    reject(state, { kind: 'enqueueProduction', systemId: 'sol', design: next }, 'INVALID_DESIGN');
    state = apply(state, { kind: 'enqueueProduction', systemId: 'sol', design: setup.design });
    state = round(state);
    state = apply(state, { kind: 'enqueueProduction', systemId: 'sol', design: setup.design });
    state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 0, research: 4000, culture: 0 } });
    state = apply(state, { kind: 'sendShip', systemId: 'sol', shipId: setup.id, destinationId: 'eden' });
    const bytes = JSON.stringify(state.session.ships.find(ship => ship.id === setup.id)!.design);
    state = earn(state, 'miniaturization');
    expect(hasCompactEquipment(state.research.blue, state.researchTree)).toBe(true);
    expect(JSON.stringify(state.session.ships.find(ship => ship.id === setup.id)!.design)).toBe(bytes);
    expect(JSON.stringify(state.colonyOutput.production.orders[0].design)).toBe(bytes);
    expect(JSON.stringify(state.colonyOutput.production.completed[0].design)).toBe(bytes);
    expect(isCampaignDesignAvailable(next, state.research.blue, state.researchTree)).toBe(true);
    const candidates = buildConquestDesigns(state.research.blue, state.researchTree);
    expect(candidates.length).toBeLessThanOrEqual(48);
    expect(candidates.some(design => design.slots.some(slot => slot.component?.technologyVariant === 'compact'))).toBe(true);
    expect(candidates.every(design => isCampaignDesignAvailable(design, state.research.blue, state.researchTree))).toBe(true);
  });

  it('pays/refits through the shared FIFO and restores progress without free HP, ammo or fuel', () => {
    const setup = paidShip();
    let state = earn(setup.state, 'miniaturization');
    state.operations[String(setup.id)].hull = 123;
    state.operations[String(setup.id)].ammunition[0].amount = 7;
    state.session.ships.find(ship => ship.id === setup.id)!.fuel = 1;
    state = conquestSchema.parse(state);
    const target = compact(setup.design), quote = getRefitQuote(setup.design, target, state.rules.colonyOutput.productionCreditsPerPoint);
    const treasury = { ...state.session.treasuries.blue };
    state = apply(state, { kind: 'createProject', name: target.name, design: target });
    state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 1, research: 4000, culture: 0 } });
    state = apply(state, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: state.projects.blue.items[0].design });
    expect(state.session.treasuries.blue).toEqual({ credits: treasury.credits - quote.cost.credits, minerals: treasury.minerals - quote.cost.minerals });
    reject(state, { kind: 'sendShip', systemId: 'sol', shipId: setup.id, destinationId: 'eden' });
    reject(state, { kind: 'createFleet', systemId: 'sol', shipIds: [1, setup.id] });
    reject(state, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: target });
    state = round(state);
    expect(state.colonyOutput.projects[0].productionProgress).toBe(1);
    expect(state.session.ships.find(ship => ship.id === setup.id)!.design).toEqual(setup.design);
    const restored = decodeConquestSave(encodeConquestSave(state));
    expect(round(restored)).toEqual(round(state));
    state = apply(restored, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 1000, research: 4000, culture: 0 } });
    state = round(state);
    expect(state.session.ships.find(ship => ship.id === setup.id)!).toMatchObject({ design: target, fuel: 1 });
    expect(state.operations[String(setup.id)]).toEqual({ hull: 123, ammunition: [{ slotId: 'projectile_1', amount: 7 }] });
    expect(state.colonyOutput.projects).toEqual([]);
    expect(getConquestView(state, 'red').workProjects).toEqual([]);
  });

  it('leaves new or changed projectile slots empty and rejects reducing max HP', () => {
    const { design } = paidShip(), target = compact(design);
    const operation = { hull: 100, ammunition: [{ slotId: 'projectile_1', amount: 7 }] };
    expect(getRefitOperationalState(design, target, operation).ammunition[0].amount).toBe(7);
    const weapon = target.slots.find(slot => slot.id === 'projectile_1')!.component!;
    if (weapon.kind !== 'projectile') throw new Error('Missing projectile');
    weapon.damage += 1;
    expect(getRefitOperationalState(design, target, operation).ammunition[0].amount).toBe(0);
    expect(() => getRefitOperationalState(design, createDesign('fighter', true), { ...operation, hull: 400 })).toThrow();
  });

  it.each(['credits', 'minerals'] as const)('rejects unpaid %s refit without changing operations', currency => {
    const setup = paidShip();
    const state = earn(setup.state, 'miniaturization'), target = compact(setup.design);
    const quote = getRefitQuote(setup.design, target, state.rules.colonyOutput.productionCreditsPerPoint);
    state.session.treasuries.blue[currency] = quote.cost[currency] - 1;
    reject(state, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: target }, 'INSUFFICIENT_RESOURCES');
  });

  it('rejects invalid/foreign/transit/grouped targets and cancels a reservation atomically', () => {
    const setup = paidShip();
    let state = earn(setup.state, 'miniaturization');
    reject(state, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: createDesign('corvette') }, 'INVALID_DESIGN');
    reject(state, { kind: 'startRefit', systemId: 'vega', shipId: 2, design: createDesign('colonizer', true) }, 'NOT_OWN_COLONY');
    const grouped = apply(state, { kind: 'createFleet', systemId: 'sol', shipIds: [1, setup.id] });
    reject(grouped, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: compact(setup.design) }, 'SHIP_IN_FLEET');
    const moving = apply(state, { kind: 'sendShip', systemId: 'sol', shipId: setup.id, destinationId: 'eden' });
    reject(moving, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: compact(setup.design) }, 'SHIP_IN_TRANSIT');
    state = apply(state, { kind: 'startRefit', systemId: 'sol', shipId: setup.id, design: compact(setup.design) });
    const project = state.colonyOutput.projects[0];
    const before = structuredClone(state.operations);
    state = apply(state, { kind: 'cancelColonyProject', systemId: 'sol', projectId: project.id });
    expect(state.operations).toEqual(before);
    expect(state.session.ships.find(ship => ship.id === setup.id)!.design).toEqual(setup.design);
    expect(apply(state, { kind: 'sendShip', systemId: 'sol', shipId: setup.id, destinationId: 'eden' }).session.ships
      .find(ship => ship.id === setup.id)?.transit).toBeDefined();
  });
});
