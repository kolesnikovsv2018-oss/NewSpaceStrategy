import { describe, expect, it, vi } from 'vitest';
import { createDesignState, createShipState, snapshotShipState } from '../src/domain/shipState';
import { calculateShipStats, createComponent, createDesign, installComponent } from '../src/domain/shipDesign';
import { DesignedShip } from '../src/entities/DesignedShip';
import { LegacyCombatShipFactory as CombatShipFactory } from './fixtures/LegacyCombatShipFactory';
import { ShipFactory } from '../src/entities/ShipFactory';
import { EquipmentType } from '../src/entities/interfaces/ShipComponents';

describe('ShipState boundary', () => {
  it('creates fresh nested state and keeps snapshots detached', () => {
    const first = createShipState(100);
    const second = createShipState(100);
    first.weapons.push({ slotId: 'a', cooldown: 1, ammo: 3 });
    const snapshot = snapshotShipState(first);
    snapshot.position.x = 500;
    snapshot.velocity.y = 20;
    snapshot.weapons[0].ammo = 0;
    expect(first.position.x).toBe(0);
    expect(first.velocity.y).toBe(0);
    expect(first.weapons[0].ammo).toBe(3);
    expect(second.weapons).toEqual([]);
  });

  it('creates full design state without retaining stats or component references', () => {
    const design = installComponent(createDesign('corvette', true), 'projectile_1', createComponent('projectile'));
    const stats = calculateShipStats(design);
    const first = createDesignState(stats);
    const second = createDesignState(stats);
    expect(first.energy).toBe(stats.energyCapacity);
    expect(first.hull).toBe(stats.hitPoints);
    expect(first.shield).toBe(stats.shield);
    expect(first.weapons).toEqual([
      { slotId: 'beam_1', cooldown: 0, ammo: null },
      { slotId: 'projectile_1', cooldown: 0, ammo: 20 }
    ]);
    first.weapons[1].ammo = 0;
    first.position.x = 10;
    expect(second.weapons[1].ammo).toBe(20);
    expect(second.position.x).toBe(0);
    expect(calculateShipStats(design)).toEqual(stats);
  });

  it.each([
    ['legacy demo', () => ShipFactory.createScout()],
    ['legacy combat', () => CombatShipFactory.createFighter('blue')],
    ['designed', () => new DesignedShip(createDesign('corvette', true), 'blue')]
  ] as const)('%s uses shared state for movement and energy', (_label, create) => {
    const ship = create();
    const externalPosition = { x: 20, y: 40 };
    ship.position = externalPosition;
    externalPosition.x = 999;
    ship.powerSource.currentEnergy = 100;
    expect(ship.consumeEnergy(25)).toBe(true);
    expect(ship.getState().energy).toBe(75);
    ship.startMoving(200, 40);
    const snapshot = ship.getState();
    expect(snapshot.position).toEqual({ x: 20, y: 40 });
    expect(snapshot.isMoving).toBe(true);
    ship.update(0.1);
    expect(ship.getState().position.x).toBeGreaterThan(snapshot.position.x);
    expect(snapshot.position.x).toBe(20);
    expect(ship.getState().energy).toBe(ship.powerSource.currentEnergy);
    ship.stopMoving();
    expect(ship.getState().velocity).toEqual({ x: 0, y: 0 });
    expect(ship.getState().isMoving).toBe(false);
  });

  it('copies replacement energy configuration and keeps energy a live compatibility view', () => {
    const ship = ShipFactory.createScout();
    const replacement = { ...ship.powerSource, currentEnergy: 50 };
    ship.powerSource = replacement;
    replacement.currentEnergy = 0;
    expect(ship.getState().energy).toBe(50);
    const view = ship.powerSource;
    ship.consumeEnergy(5);
    expect(view.currentEnergy).toBe(45);
    view.currentEnergy = 30;
    expect(ship.getState().energy).toBe(30);
  });

  it('keeps HP and cooldown in state through legacy stat replacement and refit', () => {
    const ship = CombatShipFactory.createFrigate('blue');
    const stats = { ...ship.combatStats, currentHull: 70, currentShield: 10 };
    ship.combatStats = stats;
    ship.weaponStats = { ...ship.weaponStats, currentCooldown: 0.75 };
    stats.currentHull = 999;
    expect(ship.getState()).toMatchObject({ hull: 70, shield: 10,
      weapons: [{ slotId: 'legacy-aggregate', cooldown: 0.75, ammo: null }] });
    const shield = ship.equipment.find(item => item.type === EquipmentType.SHIELD)!;
    expect(ship.uninstallEquipment(shield.id)).toBe(true);
    expect(ship.installEquipment(shield)).toBe(true);
    expect(ship.getState()).toMatchObject({ hull: 70, shield: 10, weapons: [{ cooldown: 0.75 }] });
    ship.update(0.25);
    expect(ship.getState().weapons[0].cooldown).toBe(0.5);
    expect(ship.weaponStats.currentCooldown).toBe(0.5);
  });

  it('records actual independent weapon cooldowns and ammo, not a second aggregate weapon', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const design = installComponent(createDesign('corvette', true), 'projectile_1', createComponent('projectile'));
    const ship = new DesignedShip(design, 'blue');
    const target = new DesignedShip(createDesign('corvette', true), 'red');
    expect(ship.attack(target)).not.toBeNull();
    expect(ship.attack(target)).not.toBeNull();
    const state = ship.getState();
    expect(state.weapons.map(item => item.slotId)).toEqual(['beam_1', 'projectile_1']);
    expect(state.weapons[0].cooldown).toBe(0.5);
    expect(state.weapons[1].cooldown).toBeCloseTo(2 / 3);
    expect(state.weapons[1].ammo).toBe(19);
    expect(ship.weaponStats.currentCooldown).toBeCloseTo(2 / 3);
    expect(ship.getWeaponState()).toEqual(state.weapons);
    ship.update(0.25);
    expect(ship.getState().weapons[0].cooldown).toBe(0.25);
    expect(state.weapons[0].cooldown).toBe(0.5);
    state.weapons[1].ammo = 0;
    ship.getWeaponState()[1].ammo = 0;
    expect(ship.getState().weapons[1].ammo).toBe(19);
  });

  it('tracks shield delay and destruction without changing the blueprint', () => {
    const design = installComponent(createDesign('corvette', true), 'shield_1', createComponent('shield'));
    const ship = new DesignedShip(design, 'blue');
    ship.startMoving(100, 100);
    ship.takeDamage(100);
    expect(ship.getState()).toMatchObject({ shield: 430, shieldDelayRemaining: 3 });
    ship.update(1);
    expect(ship.getState().shieldDelayRemaining).toBe(2);
    ship.takeDamage(100000);
    expect(ship.getState()).toMatchObject({ hull: 0, shield: 0, isDestroyed: true, isMoving: false });
    const dead = ship.getState();
    ship.update(10);
    expect(ship.getState()).toEqual(dead);
    expect(ship.getDesign()).toEqual(design);
    expect(new DesignedShip(design, 'blue').getState().isDestroyed).toBe(false);
  });

  it('has no phantom weapon for an unarmed flight and no runtime state in saved design', () => {
    const ship = new DesignedShip(installComponent(createDesign('corvette', true), 'beam_1', null), 'blue', 'flight');
    expect(ship.getState().weapons).toEqual([]);
    ship.weaponStats.currentCooldown = 10;
    expect(ship.getState().weapons).toEqual([]);
    const saved = JSON.parse(JSON.stringify(ship.getDesign()));
    expect(saved).not.toHaveProperty('state');
    expect(saved).not.toHaveProperty('energy');
    expect(JSON.parse(JSON.stringify(ship.getState()))).toEqual(ship.getState());
  });
});
