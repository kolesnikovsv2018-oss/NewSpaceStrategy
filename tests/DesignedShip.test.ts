import { describe, expect, it, vi } from 'vitest';
import { DesignedShip } from '../src/entities/DesignedShip';
import { BattleManager } from '../src/entities/BattleManager';
import { calculateShipStats, componentSchema, createComponent, createDesign, installComponent } from '../src/domain/shipDesign';

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

  it('consumes ammunition per shot including misses, never mutating the saved design', () => {
    const weapon = componentSchema.parse({ ...createComponent('projectile'), ammoCapacity: 1, accuracy: 0 });
    const design = installComponent(installComponent(createDesign('corvette', true), 'beam_1', null), 'projectile_1', weapon);
    const attacker = new DesignedShip(design, 'blue');
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    expect(attacker.attack(target)?.hit).toBe(false);
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
    ship.powerSource.energyOutput = 0;
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
});