import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ShipRuntime } from '../src/entities/ShipRuntime';
import { Ship } from '../src/entities/Ship';
import { ShipFactory } from '../src/entities/ShipFactory';
import { CombatShipFactory } from '../src/entities/CombatShipFactory';
import { LegacyShipFactory } from '../src/legacy/LegacyShipFactory';
import { PowerSourceType, EngineType, CargoType } from '../src/entities/interfaces/ShipComponents';
import { createShipState } from '../src/domain/shipState';
import { cargoTotals } from '../src/domain/cargo';
import type { FlightShip } from '../src/entities/interfaces/FlightShip';
import { DesignedShip } from '../src/entities/DesignedShip';

/** Operations must work without ever reading component-shaped projections. */
class ProbeRuntime extends ShipRuntime {
  get powerSource(): never { throw new Error('power projection read'); }
  get engine(): never { throw new Error('engine projection read'); }
  get cargoHold(): never { throw new Error('cargo projection read'); }
  getEnergyCapacity() { return 100; }
  getEnergyGeneration() { return 5; }
  getMovementPower() { return 10; }
  getCargoLimits() { return { mass: 50, volume: 100 }; }
  getCurrentMaxSpeed() { return 100 - cargoTotals(this.getCargo()).mass; }
  getDesign() { return undefined; }
  getInstalledModuleNames() { return []; }
  getTotalCost() { return 0; }
  getTotalWeight() { return cargoTotals(this.getCargo()).mass; }
  getMaxRange() { return 0; }
  getInfo() { return ''; }
  update(delta: number) { this.rechargeEnergy(delta); this.advanceMovement(delta, true); }
  legacyStep(delta: number) { this.rechargeEnergy(delta); this.advanceMovement(delta, false); }
}

const lot = { resourceType: 'ore', amount: 10, mass: 20, volume: 10 };
const legacy = () => LegacyShipFactory.createCustomShip('Legacy', PowerSourceType.SOLAR, EngineType.ION, CargoType.BASIC);

describe('neutral ShipRuntime', () => {
  it('owns an independent state and does not read projections for energy or movement', () => {
    const input = createShipState(50);
    input.weapons = [{ slotId: 'a', cooldown: 1, ammo: 3 }];
    const ship = new ProbeRuntime('probe', 'Probe', input);
    input.position.x = 900;
    input.weapons[0].ammo = 0;
    expect(ship.getState().weapons[0].ammo).toBe(3);
    expect(ship.getEnergy()).toBe(50);
    expect(ship.consumeEnergy(10)).toBe(true);
    expect(ship.consumeEnergy(41)).toBe(false);
    expect(ship.getEnergy()).toBe(40);
    expect(ship.startMoving(300, 400)).toBe(true);
    expect(ship.velocity).toEqual({ x: 60, y: 80 });
    ship.update(1);
    expect(ship.position).toEqual({ x: 60, y: 80 });
    expect(ship.getEnergy()).toBe(35);
    ship.stopMoving();
    ship.rechargeEnergy(100);
    expect(ship.getEnergy()).toBe(100);
    expect(ship.getState()).toMatchObject({ isMoving: false, velocity: { x: 0, y: 0 } });
  });

  it('copies position, velocity, cargo and snapshots, keeping one authoritative manifest', () => {
    const ship = new ProbeRuntime('probe', 'Probe');
    const position = { x: 10, y: 20 }, velocity = { x: 1, y: 2 };
    ship.position = position; ship.velocity = velocity;
    position.x = 900; velocity.x = 900;
    const input = { ...lot };
    expect(ship.loadCargoLot(input)).toBe(true);
    input.mass = 999;
    ship.getCargo()[0].amount = 999;
    const snapshot = ship.getState();
    snapshot.cargo[0].mass = 999;
    snapshot.position.x = 999;
    expect(ship.getState()).toMatchObject({ position: { x: 10, y: 20 }, velocity: { x: 1, y: 2 }, cargo: [lot] });
    expect(new ProbeRuntime('other', 'Other').getCargo()).toEqual([]);
  });

  it('resizes velocity immediately on load and FIFO unload without component access', () => {
    const ship = new ProbeRuntime('probe', 'Probe');
    ship.startMoving(300, 400);
    expect(ship.loadCargoLot(lot)).toBe(true);
    expect(ship.velocity).toEqual({ x: 48, y: 64 });
    expect(ship.loadCargoLot({ ...lot, amount: 5, mass: 10, volume: 40 })).toBe(true);
    expect(ship.unloadCargo('ore', 12)).toBe(true);
    expect(ship.getCargo()).toEqual([{ resourceType: 'ore', amount: 3, mass: 6, volume: 24 }]);
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeCloseTo(94);
    expect(ship.unloadCargo('ore', 3)).toBe(true);
    expect(ship.getCargo()).toEqual([]);
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeCloseTo(100);
  });

  it.each([
    null, { ...lot, mass: -1 }, { ...lot, mass: Infinity }, { ...lot, amount: 0 },
    { ...lot, mass: 51 }, { ...lot, volume: 101 }, { resourceType: 'ore', amount: 10, weight: 20, volume: 10 }
  ])('rejects invalid/overflow/noncanonical cargo atomically: %j', input => {
    const ship = new ProbeRuntime('probe', 'Probe');
    ship.startMoving(100, 0);
    const before = ship.getState();
    expect(ship.loadCargoLot(input)).toBe(false);
    expect(ship.getState()).toEqual(before);
    expect(ship.getCargoMessage()).not.toBe('');
  });

  it('keeps insufficient FIFO unload atomic, including movement', () => {
    const ship = new ProbeRuntime('probe', 'Probe');
    ship.loadCargoLot(lot);
    ship.startMoving(100, 0);
    const before = ship.getState();
    expect(ship.unloadCargo('ore', 11)).toBe(false);
    expect(ship.getState()).toEqual(before);
  });

  it('preserves distinct payment ordering for canonical and legacy movement', () => {
    const canonical = new ProbeRuntime('a', 'A');
    const old = new ProbeRuntime('b', 'B');
    for (const ship of [canonical, old]) ship.startMoving(100, 0);
    canonical.update(1); old.legacyStep(1); // Only 5 energy generated, 10 required.
    expect(canonical.position.x).toBe(0);
    expect(old.position.x).toBe(100);
    for (const ship of [canonical, old]) {
      expect(ship.getEnergy()).toBe(5);
      expect(ship.isMoving).toBe(false);
    }
  });
});

describe('canonical runtime and outbound compatibility', () => {
  it.each(['createScout', 'createFreighter', 'createMiner', 'createWarship'] as const)('%s needs no legacy Ship methods', preset => {
    for (const method of ['getTotalWeight', 'getCurrentMaxSpeed', 'getCargoLimits', 'getEnergyCapacity',
      'getEnergyGeneration', 'getMovementPower', 'update'] as const) {
      vi.spyOn(Ship.prototype, method).mockImplementation(() => { throw new Error('Legacy runtime called'); });
    }
    const ship = ShipFactory[preset]();
    expect(ship).not.toBeInstanceOf(Ship);
    expect(ship).toBeInstanceOf(ShipRuntime);
    expect(ship.startMoving(100, 0)).toBe(true);
    const energy = ship.getEnergy();
    ship.update(0.1);
    expect(ship.position.x).toBeGreaterThan(0);
    expect(ship.getEnergy()).toBeLessThan(energy);
    expect(ship.loadCargoLot(lot)).toBe(true);
    expect(ship.unloadCargo('ore', 10)).toBe(true);
    expect(ship.getInfo()).toContain(ship.name);
  });

  it('exposes stable frozen configuration views and live writable currentEnergy only', () => {
    const ship = ShipFactory.createMiner();
    const power = ship.powerSource, engine = ship.engine, hold = ship.cargoHold;
    expect(ship.powerSource).toBe(power);
    expect(ship.engine).toBe(engine);
    expect(ship.cargoHold).toBe(hold);
    for (const view of [power, engine, hold]) expect(Object.isFrozen(view)).toBe(true);
    power.currentEnergy = 50;
    expect(ship.getEnergy()).toBe(50);
    expect(ship.consumeEnergy(5)).toBe(true);
    expect(power.currentEnergy).toBe(45);
    const replacement = { ...power, currentEnergy: 30 };
    ship.powerSource = replacement;
    replacement.currentEnergy = 999;
    expect(power.currentEnergy).toBe(30);
    expect(ship.powerSource).toBe(power);
    expect(() => { ship.powerSource = { ...power, energyOutput: 0 }; }).toThrow('ShipDesign');
    expect(ship.getEnergy()).toBe(30);
    expect(Reflect.set(power, 'energyOutput', 0)).toBe(false);
    expect(Reflect.set(engine, 'energyConsumption', 0)).toBe(false);
    expect(Reflect.set(hold, 'capacity', 999999)).toBe(false);
    ship.loadCargoLot(lot);
    expect(hold.currentWeight).toBe(20);
    expect(hold.usedSpace).toBe(10);
    ship.unloadCargo('ore', 10);
    expect(hold.currentWeight).toBe(0);
  });

  it.each([legacy, () => ShipFactory.createMiner()])('keeps old weight input explicit alongside canonical mass input', create => {
    const ship = create();
    expect(ship.loadCargo({ resourceType: 'ore', amount: 10, weight: 20, volume: 10 })).toBe(true);
    expect(ship.loadCargoLot({ ...lot, resourceType: 'ice' })).toBe(true);
    expect(ship.getCargo().map(item => item.mass)).toEqual([20, 20]);
    expect(ship.cargo.map(item => item.weight)).toEqual([20, 20]);
    ship.cargo[0].weight = 999;
    expect(ship.getCargo()[0].mass).toBe(20);
    expect(ship.cargoHold.currentWeight).toBe(40);
  });

  it('retains mutable legacy configuration and original component numbers', () => {
    const ship = legacy();
    expect(ship).toBeInstanceOf(Ship);
    expect(ship.getTotalWeight()).toBe(280);
    expect(ship.getTotalCost()).toBe(4500);
    expect(ship.getCurrentMaxSpeed()).toBe(156.25);
    ship.powerSource = { ...ship.powerSource, energyOutput: 0, currentEnergy: 0 };
    ship.startMoving(100, 0);
    ship.update(1);
    expect(ship.position.x).toBe(156.25); // Historical pay-after-move behavior is deliberately retained.
    expect(ship.isMoving).toBe(false);
    ship.engine.energyConsumption = 0;
    expect(ship.getMovementPower()).toBe(0);
  });

  it('keeps canonical payment-before-movement and neutral energy-limited shield regeneration', () => {
    const ship = CombatShipFactory.createFrigate('blue');
    vi.spyOn(ship, 'getEnergyGeneration').mockReturnValue(0);
    ship.powerSource.currentEnergy = 0;
    ship.startMoving(100, 0);
    ship.update(1);
    expect(ship.position.x).toBe(0);
    expect(ship.isMoving).toBe(false);
    ship.takeDamage(20);
    const shield = ship.getState().shield;
    ship.update(5);
    expect(ship.getState().shield).toBe(shield);
    ship.powerSource.currentEnergy = 3;
    ship.update(1);
    expect(ship.getState().shield).toBeCloseTo(shield + 1);
    expect(ship.getEnergy()).toBe(0);
  });

  it('keeps rejected refits and immutable blueprint despite outbound view operations', () => {
    const ship = ShipFactory.createMiner();
    const original = ship.getDesign();
    expect(ship.installEquipment({})).toBe(false);
    expect(ship.uninstallEquipment('anything')).toBe(false);
    expect(ship.equipment).toEqual([]);
    expect(ship.equipment).not.toBe(ship.equipment);
    ship.loadCargoLot(lot);
    ship.powerSource.currentEnergy = 10;
    expect(ship.getDesign()).toEqual(original);
    expect(ShipFactory.createFromDesign(original).getCargo()).toEqual([]);
    expectTypeOf<DesignedShip>().toMatchTypeOf<FlightShip>();
    expectTypeOf<Ship>().toMatchTypeOf<FlightShip>();
    expectTypeOf<FlightShip>().not.toHaveProperty('loadCargo');
  });
});