import { describe, expect, it } from 'vitest';
import { calculateComponent, calculateShipStats, createComponentWithId, createDesign, designSchema,
  componentSchema, installComponent, validateDesign, withTacticalVariant, type ShipDesign } from '../src/domain/shipDesign';
import { DesignedShip } from '../src/entities/DesignedShip';
import { createOperationalState, getRefitOperationalState } from '../src/domain/campaignOperations';
import { createConquest, executeConquestCommand, type Conquest } from '../src/domain/conquest';
import { hasTacticalVariant, isCampaignDesignAvailable } from '../src/domain/campaignResearch';
import { buildConquestDesigns, calculateConquestDesignScore } from '../src/domain/conquestAi';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { getProductionQuote } from '../src/domain/production';
import { runPairedCombatSeries } from '../src/domain/combatSeries';
import { workCommand as apply, workRound as round, earnWorkTechnology as earn } from './fixtures/colonyWork';

function upgraded(design: ShipDesign): ShipDesign {
  return { ...structuredClone(design), slots: design.slots.map(slot => ({ ...slot,
    component: slot.component ? withTacticalVariant(slot.component) : null })) };
}
function exact(design: ShipDesign): ShipDesign {
  expect(validateDesign(design, 'battle')).toEqual([]);
  return design;
}
function restored(state: Conquest): Conquest {
  const next = decodeConquestSave(encodeConquestSave(state));
  expect(next).toEqual(state);
  expect(executeConquestCommand(next, { kind: 'endTurn', factionId: 'blue', expectedTurn: next.session.turn }))
    .toEqual(executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: state.session.turn }));
  return next;
}

describe('N13: independent effective arithmetic', () => {
  it('applies propulsion exactly once, never supplying extra generation', () => {
    const base = createComponentWithId('engine', 'drive'), next = calculateComponent(withTacticalVariant(base));
    expect(next.effective).toMatchObject({ thrust: 1250, maxSpeed: 220.00000000000003, powerGeneration: 600 });
    expect(next.mass).toBeCloseTo(62.4);
    expect(next.power).toBeCloseTo(40.5);
    expect(next.cost).toBe(19370);
    expect(next.equipmentVolume).toBe(42);
    const compact = calculateComponent({ ...withTacticalVariant(base), technologyVariant: 'compact' });
    expect(compact.mass).toBe(next.mass); expect(compact.power).toBe(next.power);
    expect(compact.equipmentVolume).toBe(33.6); expect(compact.cost).toBe(Math.ceil(19370 * 5 / 4));
  });

  it('derives focused and rapid weapons from effective ratings and charges their real energy', () => {
    const focused = calculateComponent(withTacticalVariant(createComponentWithId('beam', 'beam')));
    expect(focused.effective).toMatchObject({ damage: 30, range: 625, fireRate: 1.6 });
    expect(focused.energyPerShot).toBe(122.5); expect(focused.power).toBe(196);
    expect(focused.mass).toBe(18.25); expect(focused.cost).toBe(6113); expect(focused.equipmentVolume).toBe(24);
    const rapid = calculateComponent(withTacticalVariant(createComponentWithId('projectile', 'gun')));
    expect(rapid.effective).toMatchObject({ damage: 27, range: 270, fireRate: 1.875, ammoCapacity: 20 });
    expect(rapid.energyPerShot).toBe(216); expect(rapid.power).toBe(405);
    expect(rapid.mass).toBeCloseTo(83.925); expect(rapid.cost).toBe(3317);
    const design = upgraded(createDesign('corvette', true));
    expect(calculateShipStats(design).weapons[0].definition.damage).toBe(30);
    expect(calculateShipStats(design).dps).toBeCloseTo(30 * 1.6 * 0.85);
  });

  it('keeps armor, shield and reinforced HP distinct and applies their tradeoffs', () => {
    const armor = calculateComponent(withTacticalVariant(createComponentWithId('armor', 'armor')));
    expect(armor.effective).toMatchObject({ armorPoints: 187.5, projectileResistance: 0.4 });
    expect(armor.mass).toBeCloseTo(25.875); expect(armor.cost).toBe(1300); expect(armor.equipmentVolume).toBe(22);
    const shield = calculateComponent(withTacticalVariant(createComponentWithId('shield', 'shield')));
    expect(shield.effective).toMatchObject({ capacity: 650, rechargeRate: 16, rechargeDelay: 3.5 });
    expect(shield.mass).toBeCloseTo(28.75); expect(shield.cost).toBe(5590); expect(shield.power).toBe(48);
    const base = createDesign('corvette', true), reinforced = { ...base, hullVariant: 'reinforced' as const };
    const stats = calculateShipStats(reinforced);
    expect(stats.hitPoints).toBe(600); expect(stats.mass - calculateShipStats(base).mass).toBeCloseTo(12);
    expect(stats.cost - calculateShipStats(base).cost).toBe(900);
    expect(stats.energyCapacity).toBe(2000);
    expect(stats.equipmentVolume).toBe(calculateShipStats(base).equipmentVolume);
  });

  it('rejects crossed kind variants, missing/other tactical versions and effective absolute overflow', () => {
    const base = createDesign('corvette', true);
    expect(componentSchema.safeParse({ ...createComponentWithId('armor', 'a'), tacticalVariant: 'focused' }).success).toBe(false);
    expect(designSchema.safeParse({ ...base, tacticalRules: undefined }).success).toBe(false);
    expect(designSchema.safeParse({ ...base, tacticalRules: 'design-combat-v0' }).success).toBe(false);
    const beam = base.slots.find(slot => slot.id === 'beam_1')!;
    beam.component = componentSchema.parse({ ...createComponentWithId('beam', 'b'), tacticalVariant: 'focused', range: 10000 });
    expect(validateDesign(base, 'draft').some(issue => issue.code === 'effective-cap')).toBe(true);
    const capped = calculateComponent(componentSchema.parse({ ...createComponentWithId('beam', 'cap'), accuracy: 1, tacticalVariant: 'focused' }));
    expect(capped.effective).toMatchObject({ accuracy: 1 });
  });
});

describe('N13: actual runtime boundaries', () => {
  it('accelerates by thrust/total mass, preserves speed on re-targeting and stops without inertia', () => {
    const design = upgraded(createDesign('corvette', true)), stats = calculateShipStats(design);
    const ship = new DesignedShip(design, 'blue');
    ship.startMoving(1000, 0);
    expect(ship.velocity.x).toBe(0);
    const a = 1250 / stats.mass;
    ship.update(0.05);
    expect(ship.velocity.x).toBeCloseTo(a * 0.05);
    expect(ship.position.x).toBeCloseTo(a * 0.0025);
    ship.startMoving(1000, 0); ship.update(0.05);
    expect(ship.velocity.x).toBeCloseTo(a * 0.1);
    expect(ship.loadCargoLot({ resourceType: 'ore', amount: 1, mass: 10, volume: 1 })).toBe(true);
    const speed = ship.velocity.x;
    ship.update(0.05);
    expect(ship.velocity.x).toBeCloseTo(speed + 1250 / (stats.mass + 10) * 0.05);
    for (let index = 0; index < 1000; index++) ship.update(0.05);
    expect(ship.velocity.x).toBeCloseTo(ship.getCurrentMaxSpeed());
    ship.stopMoving(); expect(ship.velocity).toEqual({ x: 0, y: 0 });
  });

  it('cannot advance or shoot without energy and does not spend cooldown/ammo on refusal', () => {
    const design = upgraded(createDesign('corvette', true)), ship = new DesignedShip(design, 'blue');
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    ship.setEnergy(0); expect(ship.attack(target)).toBeNull();
    expect(ship.getWeaponState()[0].cooldown).toBe(0);
    // A direct powered movement step remains payable; generation is a separate update stage.
    ship.startMoving(1000, 0);
    ship.update(0.05);
    expect(ship.getEnergy()).toBeCloseTo(600 * 0.05 - 40.5 * 0.05);
  });

  it.each([-0.000001, 0, 0.000001])('checks exact effective range plus %s without replacing damage resolution', delta => {
    const ship = new DesignedShip(upgraded(createDesign('corvette', true)), 'blue', 'battle', { random: () => 0.5 });
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    target.combatStats.evasion = 0;
    target.position = { x: 625 + delta, y: 0 };
    const result = ship.attack(target);
    if (delta > 0) expect(result).toBeNull();
    else expect(result?.hullDamage).toBe(30);
  });

  it('uses real composite resistance and energy-paid capacitor recovery after its new delay', () => {
    let design = installComponent(createDesign('frigate', true), 'shield_1', withTacticalVariant(createComponentWithId('shield', 's')));
    design = installComponent(design, 'armor_1', withTacticalVariant(createComponentWithId('armor', 'a')));
    const ship = new DesignedShip(exact(design), 'blue');
    const hit = ship.takeDamage(100, false, 'projectile');
    expect(hit.shieldDamage).toBe(0); expect(hit.hullDamage).toBeCloseTo(100 * 0.6 * 100 / 287.5);
    ship.takeDamage(100, false, 'beam');
    const before = ship.combatStats.currentShield;
    ship.update(3.5); expect(ship.combatStats.currentShield).toBe(before);
    ship.setEnergy(0); ship.update(1);
    expect(ship.combatStats.currentShield).toBe(before + 16);
    expect(ship.getEnergy()).toBe(552);
  });

  it('preserves absolute damaged HP/fuel and resets changed effective projectile ammo only', () => {
    const base = installComponent(createDesign('corvette', true), 'projectile_1', createComponentWithId('projectile', 'p'));
    const operation = createOperationalState(base); operation.hull = 123; operation.ammunition[0].amount = 7;
    const compact = { ...base, slots: base.slots.map(slot => ({ ...slot, component: slot.component ?
      { ...slot.component, technologyVariant: 'compact' as const } : null })) };
    expect(getRefitOperationalState(base, compact, operation)).toEqual(operation);
    const next = { ...upgraded(base), hullVariant: 'reinforced' as const };
    expect(getRefitOperationalState(base, next, operation)).toEqual({ hull: 123, ammunition: [{ slotId: 'projectile_1', amount: 0 }] });
    expect(() => getRefitOperationalState(next, base, { ...operation, hull: 550 })).toThrow('предел HP');
  });
});

describe('N13: earned integration and bounded observations', () => {
  it('earns branches, builds and refits a paid snapshot, reloads, fights and retains the next oracle', () => {
    let state = createConquest();
    const base = createDesign('corvette', true), next = { ...upgraded(base), hullVariant: 'reinforced' as const };
    expect(isCampaignDesignAvailable(next, state.research.blue, state.researchTree)).toBe(false);
    state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 1000, research: 4000, culture: 0 } });
    for (const id of ['engineering', 'support', 'ordnance', 'capital', 'tactical-propulsion', 'focused-beams', 'reinforced-hulls']) state = earn(state, id);
    expect(hasTacticalVariant('focused', state.research.blue, state.researchTree)).toBe(true);
    state = apply(state, { kind: 'createProject', name: 'Target', design: next });
    state = apply(state, { kind: 'enqueueProduction', systemId: 'sol', design: base });
    const shipId = state.session.production.lastOrderId;
    state = round(state);
    state = apply(state, { kind: 'deployProduction', systemId: 'sol', orderId: shipId });
    const before = structuredClone(state.operations[String(shipId)]), fuel = state.session.ships.find(ship => ship.id === shipId)!.fuel;
    state = apply(state, { kind: 'startRefit', systemId: 'sol', shipId, design: next });
    state = apply(state, { kind: 'deleteProject', projectId: state.projects.blue.items[0].id });
    state = restored(state);
    for (let step = 0; state.colonyOutput.projects.length && step < 20; step++) state = round(state);
    expect(state.colonyOutput.projects).toEqual([]);
    expect(state.operations[String(shipId)]).toEqual(before);
    expect(state.session.ships.find(ship => ship.id === shipId)!.fuel).toBe(fuel);
    expect(state.session.ships.find(ship => ship.id === shipId)!.design).toEqual(next);
    state = apply(state, { kind: 'sendShip', systemId: 'sol', shipId, destinationId: 'vega' });
    state = restored(state);
    state = round(state);
    expect(state.battles.length).toBeGreaterThan(0);
    expect(state.battles.at(-1)?.tacticalRules).toBe('design-combat-v1');
    restored(state);
    for (const value of [undefined, 'design-combat-v0']) expect(() => encodeConquestSave({ ...state, tacticalRules: value })).toThrow();
  });

  it('enumerates defense/engine/weapon/hull candidates within the same hard bound', () => {
    const state = createConquest(), tree = state.researchTree;
    const research = { completed: tree.nodes.map(node => node.id), activeId: null, progress: {} };
    const candidates = buildConquestDesigns(research, tree);
    expect(candidates.length).toBeLessThanOrEqual(47);
    expect(candidates.every(design => isCampaignDesignAvailable(design, research, tree))).toBe(true);
    for (const variant of ['high-thrust', 'focused', 'rapid', 'composite', 'capacitor']) {
      expect(candidates.some(design => design.slots.some(slot => slot.component?.tacticalVariant === variant)), variant).toBe(true);
    }
    expect(candidates.some(design => design.hullVariant === 'reinforced')).toBe(true);
    const full = createDesign('corvette', true), empty = structuredClone(full);
    const engine = empty.slots.find(slot => slot.component?.kind === 'engine')!.component!;
    if (engine.kind !== 'engine') throw Error('engine');
    engine.powerGeneration = 0;
    const price = { credits: 10000, minerals: 10000 };
    expect(() => calculateConquestDesignScore(empty, price)).toThrow();
    expect(calculateConquestDesignScore(full, price).expectedDamage).toBeGreaterThan(0);
  });
});

// Equalize real quoted resources with paid engine mass/generation/thrust, not forged costs.
function equalCost(first: ShipDesign, second: ShipDesign): [ShipDesign, ShipDesign] {
  const stats = [first, second].map(calculateShipStats);
  const targetMass = Math.max(...stats.map(s => s.mass)) + 50.3;
  const targetCost = Math.max(...stats.map(s => s.cost)) + 10000;
  return [first, second].map((input, index) => {
    const design = structuredClone(input), slot = design.slots.find(slot => slot.id === 'engine_1')!;
    if (slot.component?.kind !== 'engine') throw Error('engine');
    const advanced = slot.component.tacticalVariant === 'high-thrust';
    const massCoefficient = advanced ? 0.024 : 0.02, costCoefficient = advanced ? 1.3 : 1;
    const sum = (targetMass - stats[index].mass) / massCoefficient;
    const generation = ((targetCost - stats[index].cost) / costCoefficient - 1.5 * sum) / 18.5;
    slot.component.powerGeneration += generation;
    slot.component.thrust += sum - generation;
    return exact(design);
  }) as [ShipDesign, ShipDesign];
}

it('measures three actual equal-cost technology role pairs with common-seed mirrors and explicit timeouts', () => {
  const base = createDesign('corvette', true);
  const armor = installComponent(base, 'armor_1', withTacticalVariant(createComponentWithId('armor', 'a')));
  const shield = installComponent(base, 'shield_1', withTacticalVariant(createComponentWithId('shield', 's')));
  const gun = installComponent(base, 'projectile_1', withTacticalVariant(createComponentWithId('projectile', 'p')));
  const seeds = Array.from({ length: 30 }, (_, i) => i + 101);
  for (const [index, [left, right]] of [[base, upgraded(base)], [armor, shield], [upgraded(base), gun]].entries()) {
    const [first, second] = equalCost(left, right), a = getProductionQuote(first).cost, b = getProductionQuote(second).cost;
    for (const key of ['credits', 'minerals'] as const) expect(Math.abs(a[key] - b[key]) / Math.max(a[key], b[key])).toBeLessThanOrEqual(0.01);
    const request = { first: [first], second: [second], seeds };
    const result = runPairedCombatSeries(request);
    expect(runPairedCombatSeries(request)).toEqual(result);
    expect(result.tacticalRules).toBe('design-combat-v1');
    expect(result.summary.battles).toBe(60);
    expect(result.summary.timeouts).toBe(0);
    expect(result.summary.firstScore95CI.lower).toBeLessThanOrEqual(result.summary.meanFirstScore);
    expect(result.summary.firstScore95CI.upper).toBeGreaterThanOrEqual(result.summary.meanFirstScore);
    expect(result.summary.sideBias95CI.lower).toBeLessThanOrEqual(0);
    expect(result.summary.sideBias95CI.upper).toBeGreaterThanOrEqual(0);
    if (index === 1) expect(result.summary.meanFirstScore).toBeGreaterThanOrEqual(0.9);
    else {
      expect(result.summary.firstScore95CI.lower).toBeLessThan(0.5);
      expect(result.summary.firstScore95CI.upper).toBeGreaterThan(0.5);
    }
  }
});
