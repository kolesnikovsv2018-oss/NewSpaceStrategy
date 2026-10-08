import { describe, expect, it, vi } from 'vitest';
import { DesignedShip } from '../src/entities/DesignedShip';
import { BattleManager } from '../src/entities/BattleManager';
import { calculateShipStats, componentSchema, createComponent, createDesign, installComponent } from '../src/domain/shipDesign';
import { calculateConquestDesignScore } from '../src/domain/conquestAi';

describe('design to runtime', () => {
  it('instantiates independent ships with exactly the calculated stats', () => {
    const design = createDesign('corvette', true);
    const stats = calculateShipStats(design);
    const first = new DesignedShip(design, 'blue');
    const second = new DesignedShip(design, 'blue');
    expect(first.id).not.toBe(second.id);
    expect(first.getTotalWeight()).toBe(stats.mass);
    expect(first.getTotalCost()).toBe(stats.cost);
    expect(first.getCurrentMaxSpeed()).toBe(stats.speed);
    expect(first.combatStats.maxHull).toBe(stats.hitPoints);
    first.takeDamage(10);
    first.powerSource.currentEnergy = 0;
    design.name = 'Changed source';
    first.getDesign().name = 'Changed snapshot';
    expect(second.combatStats.currentHull).toBe(stats.hitPoints);
    expect(second.powerSource.currentEnergy).toBe(stats.energyCapacity);
    expect(first.name).not.toBe(design.name);
    expect(second.getDesign().name).toBe(first.name);
  });

  it('rejects invalid projects at the runtime boundary', () => {
    expect(() => new DesignedShip(createDesign(), 'blue')).toThrow('Нужен двигатель');
  });

  it('reports zero shield without NaN for an unshielded design', () => {
    const ship = new DesignedShip(createDesign('corvette', true), 'blue');
    expect(ship.getShieldPercent()).toBe(0);
    expect(ship.getCombatInfo()).not.toContain('NaN');
  });

  it('labels runtime DPS as nominal until projectile ammunition is depleted', () => {
    const design = installComponent(createDesign('corvette', true), 'projectile_1', createComponent('projectile'));
    const ship = new DesignedShip(design, 'blue');

    expect(ship.getInfo()).toContain('DPS*:');
    expect(ship.getInfo()).toContain('DPS до исчерпания боезапаса; без критов/защиты цели');
  });

  it('does not regenerate a damaged shield before its delay expires', () => {
    const ship = new DesignedShip(installComponent(createDesign('corvette', true), 'shield_1', createComponent('shield')), 'blue');
    ship.takeDamage(100);
    const shield = ship.combatStats.currentShield;
    ship.update(2);
    expect(ship.combatStats.currentShield).toBe(shield);
    ship.update(2);
    expect(ship.combatStats.currentShield).toBe(shield + 20);
  });

  it('applies edited damage, energy cost and cooldown, not factory defaults', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const weapon = componentSchema.parse({ ...createComponent('beam'), damage: 45, accuracy: 1 });
    const design = installComponent(createDesign('corvette', true), 'beam_1', weapon);
    const attacker = new DesignedShip(design, 'blue');
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    target.combatStats.evasion = 0;
    const before = attacker.powerSource.currentEnergy;
    expect(attacker.attack(target)?.damage).toBe(45);
    expect(before - attacker.powerSource.currentEnergy).toBe(140);
    expect(attacker.attack(target)).toBeNull();
    attacker.update(0.5);
    expect(attacker.attack(target)?.damage).toBe(45);
  });

  it.each([
    [0.1, 12], [1, 120], [1.5, 172], [2, 240], [4, 480], [5, 600], [20, 2400]
  ])('fireRate %s produces exactly %s opportunities in 120s, matching AI', (fireRate, shots) => {
    const engine = componentSchema.parse({ ...createComponent('engine'), powerGeneration: 4000 });
    const beam = componentSchema.parse({ ...createComponent('beam'), range: 900, fireRate });
    let design = installComponent(createDesign('corvette'), 'engine_1', engine);
    design = installComponent(design, 'beam_1', beam);
    const attacker = new DesignedShip(design, 'blue', 'battle', { random: () => 0.99 });
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    target.position = { x: 100, y: 0 };
    let opportunities = 0;
    for (let step = 0; step < 2400; step++) {
      attacker.update(0.05);
      if (attacker.attack(target)) opportunities++;
    }
    expect(opportunities).toBe(shots);
    expect(calculateConquestDesignScore(design, { credits: 10000, minerals: 10000 }).expectedDamage)
      .toBe(shots * 25 * 0.8);
    expect(target.combatStats.currentHull).toBe(target.combatStats.maxHull);
  });

  it('keeps mixed cooldowns and ammo independent, including when energy prevents a shot', () => {
    const beam = componentSchema.parse({ ...createComponent('beam'), fireRate: 0.1, accuracy: 0 });
    const projectile = componentSchema.parse({ ...createComponent('projectile'), fireRate: 2, ammoCapacity: 3, accuracy: 0 });
    let design = installComponent(createDesign('corvette', true), 'beam_1', beam);
    design = installComponent(design, 'projectile_1', projectile);
    const attacker = new DesignedShip(design, 'blue');
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    vi.spyOn(attacker, 'getEnergyGeneration').mockReturnValue(0);
    attacker.setEnergy(0);
    attacker.update(0.05);
    expect(attacker.attack(target)).toBeNull();
    expect(attacker.getWeaponState()).toMatchObject([{ cooldown: 0, ammo: null }, { cooldown: 0, ammo: 3 }]);
    attacker.setEnergy(attacker.getEnergyCapacity());
    expect(attacker.attack(target)).not.toBeNull();
    expect(attacker.attack(target)).not.toBeNull();
    for (let shot = 0; shot < 2; shot++) {
      for (let step = 0; step < 9; step++) attacker.update(0.05);
      expect(attacker.attack(target)).toBeNull();
      attacker.update(0.05);
      expect(attacker.attack(target)).not.toBeNull();
    }
    expect(attacker.getWeaponState()).toMatchObject([{ ammo: null }, { cooldown: 0.5, ammo: 0 }]);
    expect(attacker.getWeaponState()[0].cooldown).toBeGreaterThan(8);
    for (let step = 0; step < 10; step++) attacker.update(0.05);
    expect(attacker.attack(target)).toBeNull();
  });

  it('consumes ammunition per shot including misses, never mutating the saved design', () => {
    const weapon = componentSchema.parse({ ...createComponent('projectile'), ammoCapacity: 1, accuracy: 0 });
    const design = installComponent(installComponent(createDesign('corvette', true), 'beam_1', null), 'projectile_1', weapon);
    const attacker = new DesignedShip(design, 'blue');
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    expect(attacker.getPreferredCombatRange()).toBe(300);
    expect(attacker.attack(target)?.hit).toBe(false);
    expect(attacker.getPreferredCombatRange()).toBeUndefined();
    attacker.update(2);
    expect(attacker.attack(target)).toBeNull();
    expect(attacker.getWeaponState()[0].ammo).toBe(0);
    expect(new DesignedShip(design, 'blue').getWeaponState()[0].ammo).toBe(1);
  });

  it('regenerates shields only after delay and pays energy', () => {
    const design = installComponent(createDesign('corvette', true), 'shield_1', createComponent('shield'));
    const ship = new DesignedShip(design, 'blue');
    ship.takeDamage(100);
    const shield = ship.combatStats.currentShield;
    ship.powerSource.currentEnergy = 0;
    // Disable generation explicitly for this energy-limited scenario; design projections are immutable.
    vi.spyOn(ship, 'getEnergyGeneration').mockReturnValue(0);
    ship.update(4);
    expect(ship.combatStats.currentShield).toBe(shield);
    ship.powerSource.currentEnergy = 60;
    ship.update(1);
    expect(ship.combatStats.currentShield).toBe(shield + 20);
    expect(ship.powerSource.currentEnergy).toBe(0);
  });

  it('projectiles bypass beam shields and armor resistance reduces actual damage', () => {
    let design = installComponent(createDesign('corvette', true), 'shield_1', createComponent('shield'));
    design = installComponent(design, 'armor_1', createComponent('armor'));
    const ship = new DesignedShip(design, 'blue');
    const result = ship.takeDamage(100, false, 'projectile');
    expect(result.shieldDamage).toBe(0);
    expect(result.hullDamage).toBeCloseTo(28);
  });

  it('fires independent weapons in the same tick without double counting a kill', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const design = installComponent(createDesign('corvette', true), 'beam_2', createComponent('beam'));
    const blue = new DesignedShip(design, 'blue');
    const red = new DesignedShip(createDesign('corvette', true), 'red');
    red.combatStats.evasion = 0;
    red.combatStats.currentHull = 40;
    const manager = new BattleManager({ factions: [
      { id: 'blue', name: 'Blue', color: 0, ships: [blue] }, { id: 'red', name: 'Red', color: 1, ships: [red] }
    ], battlefieldWidth: 1280, battlefieldHeight: 720, autoTarget: true, friendlyFire: false });
    manager.start(); manager.update(1 / 60);
    expect(manager.getStats().shipsDestroyed).toBe(1);
    expect(manager.getStats().totalDamage).toBe(40);
    expect(manager.drainEvents().map(event => event.type)).toEqual(['WeaponFired', 'WeaponFired', 'ShipDestroyed']);
  });

  it('moves mixed-range designs close enough for their shortest loaded weapon', () => {
    const beam = componentSchema.parse({ ...createComponent('beam'), range: 900, fireRate: 0.1 });
    const projectile = componentSchema.parse({ ...createComponent('projectile'), range: 300, fireRate: 0.1 });
    const design = installComponent(installComponent(createDesign('corvette', true), 'beam_1', beam), 'projectile_1', projectile);
    const blue = new DesignedShip(design, 'blue');
    const red = new DesignedShip(createDesign('corvette', true), 'red');
    blue.position = { x: 100, y: 100 };
    red.position = { x: 600, y: 100 };
    const manager = new BattleManager({ factions: [
      { id: 'blue', name: 'Blue', color: 0, ships: [blue] }, { id: 'red', name: 'Red', color: 1, ships: [red] }
    ], battlefieldWidth: 1000, battlefieldHeight: 500, autoTarget: true, friendlyFire: false });

    manager.start();
    manager.update(0.05);

    expect(blue.getPreferredCombatRange()).toBe(300);
    expect(blue.target).toBe(red);
    expect(blue.isMoving).toBe(true);
  });

  it('holds a requested close engagement range without retreating at the old half-range threshold', () => {
    const ship = new DesignedShip(createDesign('corvette', true), 'blue');
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    const range = ship.weaponStats.range;
    ship.position = { x: 0, y: 0 };
    target.position = { x: range * 0.2, y: 0 };

    ship.moveToTarget(target, 0.25);

    expect(ship.isMoving).toBe(false);
  });

  it('moves away from the target when retreat is requested', () => {
    const ship = new DesignedShip(createDesign('corvette', true), 'blue');
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    ship.position = { x: 0, y: 0 };
    target.position = { x: 100, y: 0 };

    ship.moveToTarget(target, undefined, undefined, true);

    expect(ship.isMoving).toBe(true);
    expect(ship.velocity.x).toBeLessThan(0);
    expect(ship.velocity.y).toBeCloseTo(0);
  });
});