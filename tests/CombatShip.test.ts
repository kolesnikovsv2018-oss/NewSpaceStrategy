import { describe, expect, it, vi } from 'vitest';
import { CombatShip } from '../src/entities/CombatShip';
import { LegacyCombatShipFactory as CombatShipFactory } from './fixtures/LegacyCombatShipFactory';
import { ShipComponentFactory } from '../src/entities/ShipComponentFactory';
import { EquipmentType } from '../src/entities/interfaces/ShipComponents';

describe('CombatShip equipment', () => {
  it.each([
    ['fighter', CombatShipFactory.createFighter, 1, 60],
    ['frigate', CombatShipFactory.createFrigate, 2, 110],
    ['cruiser', CombatShipFactory.createCruiser, 3, 210],
    ['dreadnought', CombatShipFactory.createDreadnought, 5, 410]
  ] as const)('%s installs its complete loadout and calculates damage', (_name, create, count, damage) => {
    const ship = create('blue');
    expect(ship.equipment).toHaveLength(count);
    expect(ship.weaponStats.damage).toBe(damage);
    expect(ship.cargoHold.currentWeight).toBeLessThanOrEqual(ship.cargoHold.maxWeight);
    expect(ship.combatStats.currentShield).toBe(ship.combatStats.maxShield);
  });

  it('removing a weapon recalculates stats without resetting cooldown or healing', () => {
    const ship = CombatShipFactory.createFrigate('blue');
    ship.weaponStats.currentCooldown = 0.5;
    ship.combatStats.currentHull = 80;
    ship.combatStats.currentShield = 20;
    const weapon = ship.equipment.find(eq => eq.type === EquipmentType.WEAPON)!;

    expect(ship.uninstallEquipment(weapon.id)).toBe(true);
    expect(ship.weaponStats.damage).toBe(10);
    expect(ship.weaponStats.range).toBe(200);
    expect(ship.weaponStats.currentCooldown).toBe(0.5);
    expect(ship.combatStats.currentHull).toBe(80);
    expect(ship.combatStats.currentShield).toBe(20);
  });

  it('shield equipment affects capacity and regeneration, removing it clamps current shield', () => {
    const ship = CombatShipFactory.createFrigate('blue');
    expect(ship.combatStats.maxShield).toBe(150);
    expect(ship.combatStats.shieldRegenRate).toBe(9);
    const shield = ship.equipment.find(eq => eq.type === EquipmentType.SHIELD)!;
    expect(ship.uninstallEquipment(shield.id)).toBe(true);
    expect(ship.combatStats.maxShield).toBe(50);
    expect(ship.combatStats.currentShield).toBe(50);
    expect(ship.combatStats.shieldRegenRate).toBe(4);
  });

  it('failed equipment installation does not change stats', () => {
    const ship = CombatShipFactory.createFighter('blue');
    const stats = { ...ship.weaponStats };
    expect(ship.installEquipment(ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 3))).toBe(false);
    expect(ship.weaponStats).toEqual(stats);
    expect(ship.equipment).toHaveLength(1);
  });

  it('installing equipment does not replenish an already damaged shield', () => {
    const ship = CombatShipFactory.createCruiser('blue');
    const shield = ship.equipment.find(eq => eq.type === EquipmentType.SHIELD)!;
    ship.uninstallEquipment(shield.id);
    ship.combatStats.currentShield = 10;
    expect(ship.installEquipment(shield)).toBe(true);
    expect(ship.combatStats.currentShield).toBe(10);
  });

  it('same-tier equipment receives distinct ids even within one millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const ship = CombatShipFactory.createCruiser('blue');
    expect(new Set(ship.equipment.map(eq => eq.id)).size).toBe(ship.equipment.length);
  });

  it('factory rejects an invalid loadout instead of returning a partial ship', () => {
    vi.spyOn(CombatShip.prototype, 'installEquipment').mockReturnValue(false);
    expect(() => CombatShipFactory.createFighter('blue')).toThrow('Недопустимая комплектация');
  });

  it('ships and component state are independent, including ids in the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = CombatShipFactory.createFighter('blue');
    const second = CombatShipFactory.createFighter('blue');
    expect(first.id).not.toBe(second.id);
    first.powerSource.currentEnergy = 0;
    first.weaponStats.damage = 1;
    expect(second.powerSource.currentEnergy).toBe(second.powerSource.energyCapacity);
    expect(second.weaponStats.damage).toBe(60);
  });

  it('caps reported hull damage at remaining HP and excludes armor reduction', () => {
    const ship = CombatShipFactory.createFighter('red');
    ship.combatStats.currentHull = 5;
    ship.combatStats.currentShield = 10;
    const result = ship.takeDamage(10000);
    expect(result.shieldDamage).toBe(10);
    expect(result.hullDamage).toBe(5);
    expect(result.damage).toBe(15);
    expect(ship.isDestroyed).toBe(true);
  });

  it('does not update destroyed ships', () => {
    const ship = CombatShipFactory.createFighter('red');
    ship.takeDamage(10000);
    ship.powerSource.currentEnergy = 0;
    ship.weaponStats.currentCooldown = 1;
    ship.update(1);
    expect(ship.powerSource.currentEnergy).toBe(0);
    expect(ship.weaponStats.currentCooldown).toBe(1);
  });
});