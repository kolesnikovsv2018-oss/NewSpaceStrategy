import { describe, expect, it, vi } from 'vitest';
import { estimateFlight, formatFlightEstimate } from '../src/domain/flightEstimate';
import { createShipState } from '../src/domain/shipState';
import { ShipFactory } from '../src/entities/ShipFactory';
import { CombatShipFactory } from '../src/entities/CombatShipFactory';
import { LegacyShipFactory } from '../src/legacy/LegacyShipFactory';
import { LegacyCombatShipFactory } from './fixtures/LegacyCombatShipFactory';
import { PowerSourceType, EngineType, CargoType } from '../src/entities/interfaces/ShipComponents';
import { ShipRuntime } from '../src/entities/ShipRuntime';

const invalid = [-1, NaN, Infinity, -Infinity, '1', null, undefined] as number[];
const invalidCoordinates = invalid.filter(value => !Number.isFinite(value));
const legacy = () => LegacyShipFactory.createCustomShip('Legacy', PowerSourceType.SOLAR, EngineType.ION, CargoType.BASIC);
const factories = [
  { name: 'legacy flight', create: legacy },
  { name: 'canonical', create: () => CombatShipFactory.createFrigate('blue') },
  { name: 'legacy combat', create: () => LegacyCombatShipFactory.createFrigate('blue') }
];
const combatFactories = factories.slice(1) as { name: string; create: () => ReturnType<typeof CombatShipFactory.createFrigate> | ReturnType<typeof LegacyCombatShipFactory.createFrigate> }[];

describe.each(factories)('$name numeric runtime boundaries', ({ create }) => {
  it.each(invalid)('rejects invalid scalar %s without state mutation', value => {
    const ship = create();
    ship.setEnergy(50);
    ship.startMoving(100, 100);
    const before = ship.getState();
    expect(ship.consumeEnergy(value)).toBe(false);
    ship.rechargeEnergy(value);
    ship.update(value);
    if (!Number.isFinite(value)) {
      expect(ship.startMoving(value, 1)).toBe(false);
      expect(ship.startMoving(1, value)).toBe(false);
    }
    expect(() => ship.setEnergy(value)).toThrow(RangeError);
    expect(() => { ship.powerSource.currentEnergy = value; }).toThrow(RangeError);
    expect(() => { ship.powerSource = { ...ship.powerSource, currentEnergy: value }; }).toThrow(RangeError);
    expect(ship.getState()).toEqual(before);
  });

  it('accepts zero expenditure, rejects over-capacity writes, and ignores zero time', () => {
    const ship = create();
    ship.startMoving(100, 0);
    const before = ship.getState();
    expect(ship.consumeEnergy(0)).toBe(true);
    ship.update(0); ship.rechargeEnergy(0);
    expect(ship.consumeEnergy(ship.getEnergyCapacity() + 1)).toBe(false);
    expect(() => ship.setEnergy(ship.getEnergyCapacity() + 1)).toThrow(RangeError);
    expect(() => { ship.powerSource.currentEnergy = ship.getEnergyCapacity() + 1; }).toThrow(RangeError);
    expect(ship.getState()).toEqual(before);
    expect(ship.consumeEnergy(ship.getEnergy())).toBe(true);
    expect(ship.getEnergy()).toBe(0);
    ship.setEnergy(ship.getEnergyCapacity());
    ship.rechargeEnergy(Number.MAX_VALUE);
    expect(ship.getEnergy()).toBe(ship.getEnergyCapacity());
  });

  it('rejects invalid vectors and overflow targets before replacing movement', () => {
    const ship = create();
    ship.position = { x: -Number.MAX_VALUE, y: 0 };
    ship.velocity = { x: 2, y: 3 };
    const before = ship.getState();
    for (const value of invalidCoordinates) {
      expect(() => { ship.position = { x: value, y: 0 }; }).toThrow(RangeError);
      expect(() => { ship.velocity = { x: 0, y: value }; }).toThrow(RangeError);
    }
    expect(ship.startMoving(Number.MAX_VALUE, 0)).toBe(false);
    expect(ship.getState()).toEqual(before);
    ship.position = { x: 0, y: 0 };
    expect(ship.startMoving(-100, -100)).toBe(true); // Coordinates are signed, unlike energy and time.
    expect(ship.velocity.x).toBeLessThan(0);
    expect(ship.startMoving(1e200, 1e200)).toBe(true); // Math.hypot avoids squared-distance overflow.
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeCloseTo(ship.getCurrentMaxSpeed());
  });
});

describe.each(combatFactories)('$name combat input guards', ({ create }) => {
  it.each([0, ...invalid])('ignores damage/time %s without healing or resetting timers', value => {
    const ship = create();
    ship.takeDamage(20);
    ship.weaponStats.currentCooldown = 2;
    ship.startMoving(100, 100);
    const before = ship.getState();
    expect(ship.takeDamage(value, true)).toEqual({ hit: false, damage: 0, shieldDamage: 0, hullDamage: 0, critical: false, evaded: false });
    ship.update(value);
    expect(ship.getState()).toEqual(before);
  });

  it('validates live state setters and whole-view replacements atomically', () => {
    const ship = create();
    const before = ship.getState(), combat = ship.combatStats, weapon = ship.weaponStats;
    for (const value of invalid) {
      expect(() => { ship.combatStats.currentHull = value; }).toThrow(RangeError);
      expect(() => { ship.combatStats.currentShield = value; }).toThrow(RangeError);
      expect(() => { ship.weaponStats.currentCooldown = value; }).toThrow(RangeError);
      expect(() => { ship.combatStats = { ...combat, currentHull: 1, currentShield: value }; }).toThrow(RangeError);
      expect(() => { ship.weaponStats = { ...weapon, currentCooldown: value }; }).toThrow(RangeError);
    }
    expect(ship.getState()).toEqual(before);
    expect(ship.combatStats).toBe(combat);
    expect(ship.weaponStats).toBe(weapon);
  });

  it('ignores invalid target coordinates/ratios without spending energy or cooldown', () => {
    const ship = create(), target = create();
    ship.startMoving(100, 100);
    const before = ship.getState();
    for (const value of invalid.filter(item => item !== undefined)) ship.moveToTarget(target, value);
    // The legacy live coordinate objects still allow direct mutation; consumers reject bad vectors.
    target.position.x = NaN;
    ship.moveToTarget(target);
    expect(ship.attack(target)).toBeNull();
    expect(ship.getState()).toEqual(before);
  });

  it('preserves the default optimalRange for omitted or undefined arguments', () => {
    const ship = create(), explicit = create(), target = create();
    target.position = { x: 1000, y: 500 };
    ship.moveToTarget(target, undefined);
    explicit.moveToTarget(target, 0.8);
    expect(ship.velocity).toEqual(explicit.velocity);
  });

  it('caps a huge finite hit and makes repeated damage on destroyed ships inert', () => {
    const ship = create();
    const available = ship.getState().hull + ship.getState().shield;
    const result = ship.takeDamage(Number.MAX_VALUE);
    expect(result.damage).toBe(available);
    expect(ship.isDestroyed).toBe(true);
    const before = ship.getState();
    expect(ship.takeDamage(10).damage).toBe(0);
    ship.update(10);
    expect(ship.getState()).toEqual(before);
  });
});

describe('flight estimate units and compatibility', () => {
  it('uses net power, seconds and tactical distance without touching state', () => {
    const ship = legacy();
    ship.powerSource.energyOutput = 2;
    ship.setEnergy(60); // Movement 5 EU/s, net draw 3 EU/s => 20s.
    const before = ship.getState();
    expect(ship.getFlightEstimate()).toEqual({ kind: 'limited', seconds: 20, distance: 3125 });
    expect(ship.getState()).toEqual(before);
    expect(ship.getMaxRange()).toBe(2400); // Old API is intentionally left battery-only/unloaded.
    ship.loadCargoLot({ resourceType: 'ore', amount: 10, mass: 20, volume: 10 });
    expect(ship.getFlightEstimate()).toEqual({ kind: 'limited', seconds: 20, distance: 20 * ship.getCurrentMaxSpeed() });
    expect(ship.getMaxRange()).toBe(2400);
  });

  it('uses canonical loaded speed and exposes sustained generation without numeric Infinity', () => {
    const ship = ShipFactory.createMiner();
    expect(ship.getFlightEstimate()).toEqual({ kind: 'sustained' });
    vi.spyOn(ship, 'getEnergyGeneration').mockReturnValue(0);
    ship.setEnergy(60);
    ship.loadCargoLot({ resourceType: 'ore', amount: 10, mass: 20, volume: 10 });
    const before = ship.getState();
    expect(ship.getFlightEstimate()).toEqual({ kind: 'limited', seconds: 60 / ship.getMovementPower(),
      distance: 60 / ship.getMovementPower() * ship.getCurrentMaxSpeed() });
    expect(ship.getState()).toEqual(before);
    expect(ship.getInfo()).toContain('ЭЕ/с');
    expect(ship.getInfo()).not.toContain('св.');
  });

  it('distinguishes zero battery, zero speed, free movement and balanced generation', () => {
    expect(estimateFlight(0, 0, 10, 100)).toEqual({ kind: 'limited', seconds: 0, distance: 0 });
    expect(estimateFlight(0, 10, 10, 100)).toEqual({ kind: 'sustained' });
    expect(estimateFlight(0, 0, 0, 100)).toEqual({ kind: 'sustained' });
    expect(estimateFlight(50, 20, 10, 0)).toEqual({ kind: 'stationary' });
    expect(estimateFlight(60, 2, 5, 100)).toEqual({ kind: 'limited', seconds: 20, distance: 2000 });
  });

  it.each(invalid)('returns unavailable rather than NaN/Infinity for invalid input %s', value => {
    for (let index = 0; index < 4; index++) {
      const args: [number, number, number, number] = [10, 2, 5, 100];
      args[index] = value;
      expect(estimateFlight(...args)).toEqual({ kind: 'unavailable' });
    }
  });

  it('handles arithmetic overflow explicitly and formats every variant', () => {
    expect(estimateFlight(Number.MAX_VALUE, 0, Number.MIN_VALUE, 1)).toEqual({ kind: 'unavailable' });
    expect(estimateFlight(Number.MAX_VALUE, 0, 1, Number.MAX_VALUE)).toEqual({ kind: 'unavailable' });
    expect(formatFlightEstimate({ kind: 'unavailable' })).toContain('недоступна');
    expect(formatFlightEstimate({ kind: 'stationary' })).toContain('Нет скорости');
    expect(formatFlightEstimate({ kind: 'sustained' })).toBe('Генерация покрывает движение');
    expect(formatFlightEstimate({ kind: 'limited', seconds: 5, distance: 100 })).toBe('5.0 с / 100.0 такт. ед.');
  });
});

/** Exposes exactly one neutral movement operation, independent of regeneration/tactics. */
class MovementProbe extends ShipRuntime {
  get powerSource(): never { throw new Error('unused'); }
  get engine(): never { throw new Error('unused'); }
  get cargoHold(): never { throw new Error('unused'); }
  getEnergyCapacity() { return 100; }
  getEnergyGeneration() { return 10; }
  getMovementPower() { return 10; }
  getCargoLimits() { return { mass: 0, volume: 0 }; }
  getCurrentMaxSpeed() { return 100; }
  getDesign() { return undefined; }
  getInstalledModuleNames() { return []; }
  getTotalCost() { return 0; }
  getTotalWeight() { return 0; }
  getMaxRange() { return 0; }
  getInfo() { return ''; }
  update(delta: number) { this.advanceMovement(delta, true); }
  legacyStep(delta: number) { this.advanceMovement(delta, false); }
}

describe('neutral numerical guards', () => {
  it('ignores overflow of movement coordinates or power before consuming energy in either ordering', () => {
    const ship = new MovementProbe('a', 'A', createShipState(50));
    ship.isMoving = true;
    ship.position = { x: Number.MAX_VALUE, y: 0 };
    ship.velocity = { x: Number.MAX_VALUE, y: 0 };
    const before = ship.getState();
    ship.update(1); ship.legacyStep(1);
    ship.update(Number.MAX_VALUE); ship.legacyStep(Number.MAX_VALUE);
    expect(ship.getState()).toEqual(before);
  });

  it('ignores invalid characteristic queries and rejects invalid initial energy/coordinates', () => {
    const ship = new MovementProbe('a', 'A', createShipState(50));
    const before = ship.getState();
    vi.spyOn(ship, 'getEnergyGeneration').mockReturnValue(-1);
    ship.rechargeEnergy(1);
    vi.spyOn(ship, 'getCurrentMaxSpeed').mockReturnValue(NaN);
    expect(ship.startMoving(100, 100)).toBe(false);
    expect(ship.getState()).toEqual(before);
    expect(() => new MovementProbe('b', 'B', createShipState(-1))).toThrow(RangeError);
    expect(() => new MovementProbe('b', 'B', { ...createShipState(), position: { x: NaN, y: 0 } })).toThrow(RangeError);
  });
});