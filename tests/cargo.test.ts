import { describe, expect, it } from 'vitest';
import { cargoTotals, loadCargo, unloadCargo, type CargoItem } from '../src/domain/cargo';
import { calculateShipStats, createComponent, createDesign, designSchema, HULLS, installComponent, validateDesign } from '../src/domain/shipDesign';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { DesignedShip } from '../src/entities/DesignedShip';
import { ShipFactory } from '../src/entities/ShipFactory';
import { CargoType, EngineType, EquipmentType, PowerSourceType } from '../src/entities/interfaces/ShipComponents';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { createV1Design } from './fixtures/v1Design';

const ore: CargoItem = { resourceType: 'ore', amount: 10, mass: 20, volume: 10 };
const legacyOre = { resourceType: 'ore', amount: 10, weight: 20, volume: 10 };
const limits = { mass: 100, volume: 100 };

describe('atomic cargo operations', () => {
  it.each(['amount', 'mass', 'volume'] as const)('rejects malformed %s without mutating the manifest', field => {
    for (const value of [0, -1, NaN, Infinity, -Infinity, 1e10, '10', null]) {
      const cargo = [{ ...ore }];
      expect(loadCargo(cargo, { ...ore, [field]: value }, limits).ok).toBe(false);
      expect(cargo).toEqual([ore]);
    }
  });

  it.each([null, {}, { ...ore, resourceType: '' }, { ...ore, resourceType: ' ' }, { ...ore, extra: 1 }])('rejects invalid cargo %j', input => {
    expect(loadCargo([], input, limits).ok).toBe(false);
  });

  it('normalizes the resource and detaches both old and new lots', () => {
    const old = [{ ...ore }];
    const input = { ...ore, resourceType: ' ore ' };
    const result = loadCargo(old, input, limits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.cargo).toEqual([ore, ore]);
    result.cargo[0].mass = 99; result.cargo[1].amount = 99;
    expect(old).toEqual([ore]); expect(input.amount).toBe(10);
  });

  it('checks mass and volume independently, including exact fits and zero-sized holds', () => {
    expect(loadCargo([], ore, { mass: 20, volume: 10 }).ok).toBe(true);
    expect(loadCargo([], ore, { mass: 19, volume: 100 }).ok).toBe(false);
    expect(loadCargo([], ore, { mass: 100, volume: 9 }).ok).toBe(false);
    expect(loadCargo([], ore, { mass: 0, volume: 0 }).ok).toBe(false);
  });

  it('rejects invalid limits and excessive lot count', () => {
    for (const value of [-1, NaN, Infinity]) {
      expect(loadCargo([], ore, { ...limits, mass: value }).ok).toBe(false);
      expect(loadCargo([], ore, { ...limits, volume: value }).ok).toBe(false);
    }
    expect(loadCargo(Array.from({ length: 1000 }, () => ({ ...ore })), ore, { mass: 1e9, volume: 1e9 }).ok).toBe(false);
  });

  it.each([0, -1, NaN, Infinity, 21])('rejects invalid or unavailable unloading amount %s atomically', amount => {
    const cargo = [{ ...ore }, { ...ore }];
    expect(unloadCargo(cargo, 'ore', amount).ok).toBe(false);
    expect(cargo).toEqual([ore, ore]);
  });

  it('unloads FIFO across lots with different density while preserving unrelated resources', () => {
    const ice = { resourceType: 'ice', amount: 4, mass: 4, volume: 8 };
    const cargo = [{ ...ore }, ice, { ...ore, mass: 40, volume: 20 }];
    const result = unloadCargo(cargo, ' ore ', 15);
    expect(result).toEqual({ ok: true, cargo: [ice, { ...ore, amount: 5, mass: 20, volume: 10 }] });
    expect(cargoTotals(cargo)).toEqual({ mass: 64, volume: 38 });
    expect(unloadCargo(cargo, 'missing', 1).ok).toBe(false);
  });

  it('removes all lots at the exact fractional sum without floating-point dust', () => {
    const cargo = [{ ...ore, amount: 0.1 }, { ...ore, amount: 0.2 }];
    expect(unloadCargo(cargo, 'ore', 0.1 + 0.2)).toEqual({ ok: true, cargo: [] });
  });
});

describe('cargo in ship state', () => {
  it('copies load inputs, legacy views and state snapshots, with independent ships', () => {
    const ship = ShipFactory.createFreighter();
    const other = new DesignedShip(ship.getDesign(), 'other', 'flight');
    const input = { ...legacyOre };
    expect(ship.loadCargo(input)).toBe(true);
    input.weight = 900;
    ship.cargo[0].amount = 900;
    const snapshot = ship.getState();
    snapshot.cargo[0].mass = 900;
    snapshot.cargo.push({ ...ore });
    expect(ship.getState().cargo).toEqual([ore]);
    expect(ship.cargoHold.currentWeight).toBe(20);
    expect(ship.cargoHold.usedSpace).toBe(10);
    expect(other.getState().cargo).toEqual([]);
  });

  it('updates mass and current velocity immediately and reversibly without changing design stats or cost', () => {
    const ship = ShipFactory.createFreighter();
    const before = calculateShipStats(ship.getDesign());
    ship.startMoving(3, 4);
    expect(ship.loadCargo(legacyOre)).toBe(true);
    expect(ship.getTotalWeight()).toBe(before.mass + 20);
    const speed = 100 * before.thrust / (before.thrust + (before.mass + 20) * 0.1);
    expect(ship.getCurrentMaxSpeed()).toBeCloseTo(speed);
    expect(ship.velocity.x).toBeCloseTo(speed * 0.6);
    expect(ship.velocity.y).toBeCloseTo(speed * 0.8);
    ship.update(0.5);
    expect(ship.position.x).toBeCloseTo(speed * 0.6 * 0.5);
    expect(ship.getTotalCost()).toBe(before.cost);
    expect(calculateShipStats(ship.getDesign())).toEqual(before);
    expect(ship.unloadCargo('ore', 10)).toBe(true);
    expect(ship.getTotalWeight()).toBe(before.mass);
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeCloseTo(before.speed);
    expect(ship.cargoHold.currentWeight).toBe(0);
    expect(ship.cargoHold.usedSpace).toBe(0);
  });

  it('rejects overcapacity and malformed operations without changing ship state or movement', () => {
    const ship = ShipFactory.createScout();
    ship.startMoving(1, 1);
    expect(ship.loadCargo({ ...legacyOre, weight: 100 })).toBe(true);
    const before = ship.getState();
    expect(ship.loadCargo(legacyOre)).toBe(false);
    expect(ship.getCargoMessage()).toContain('грузоподъёмность');
    expect(ship.unloadCargo('ore', -5)).toBe(false);
    expect(ship.loadCargo({ ...legacyOre, amount: NaN })).toBe(false);
    expect(ship.getState()).toEqual(before);
  });

  it('caps payload by hull mass reserve rather than equipment slot count', () => {
    const engineOnly = installComponent(createDesign('corvette'), 'engine_1', createComponent('engine'));
    const design = installComponent(engineOnly, 'armor_1', { ...createComponent('armor'), kind: 'armor',
      armorPoints: 1100, beamResistance: 0, projectileResistance: 0 });
    const stats = calculateShipStats(design);
    expect(stats.mass).toBe(297);
    expect(stats.cargoMassLimit).toBe(53);
    const ship = new DesignedShip(design, 'blue', 'flight');
    expect(ship.getAvailableCargoSlots()).toBe(8);
    expect(ship.loadCargo({ ...legacyOre, weight: 53 })).toBe(true);
    expect(ship.getTotalWeight()).toBe(HULLS.corvette.maxMass);
    expect(ship.loadCargo({ ...legacyOre, weight: 0.1 })).toBe(false);
    expect(ship.getAvailableCargoSlots()).toBe(8);
  });

  it('keeps an empty fighter bay empty without changing its combat statistics', () => {
    const ship = new DesignedShip(createDesign('fighter', true), 'blue');
    const before = ship.getState();
    expect(ship.getCargoLimits()).toEqual({ mass: 0, volume: 0 });
    expect(ship.loadCargo(legacyOre)).toBe(false);
    expect(ship.getState()).toEqual(before);
    expect(ship.getInfo()).toContain('0.0/0.0 т');
  });

  it('reserves legacy equipment mass but not cargo volume, with no double-counting', () => {
    const ship = ShipFactory.createCustomShip('Legacy', PowerSourceType.NUCLEAR, EngineType.ION, CargoType.BASIC);
    const mass = ship.getTotalWeight();
    const module = { id: 'test', name: 'Test', type: EquipmentType.SCANNER, slotsRequired: 1, weight: 10, cost: 5 };
    expect(ship.installEquipment(module)).toBe(true);
    expect(ship.getCargoLimits()).toEqual({ mass: 40, volume: 100 });
    expect(ship.loadCargo({ ...legacyOre, weight: 40, volume: 100 })).toBe(true);
    expect(ship.getTotalWeight()).toBe(mass + 50);
    expect(ship.cargoHold.currentWeight).toBe(50);
    expect(ship.installEquipment({ ...module, id: 'extra' })).toBe(false);
    expect(ship.uninstallEquipment('test')).toBe(true);
    expect(ship.cargoHold.currentWeight).toBe(40);
    expect(ship.cargoHold.usedSpace).toBe(100);
    expect(ship.unloadCargo('ore', 10)).toBe(true);
    expect(ship.getTotalWeight()).toBe(mass);
  });

  it('loads the original six-slot v1 schema and persists blueprints without runtime cargo', () => {
    const data = new Map<string, string>();
    const store: StoragePort = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
    const oldV1 = createV1Design();
    store.setItem(ShipDesignManager.V1_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, designs: [oldV1], components: [] }));
    const repository = new ShipDesignManager(store);
    const loaded = repository.load().designs[0];
    expect(loaded.slots.slice(0, 6)).toEqual(oldV1.slots);
    expect(loaded.id).toBe(oldV1.id);
    const ship = new DesignedShip(loaded, 'blue');
    expect(ship.loadCargo(legacyOre)).toBe(true);
    repository.saveDesign(ship.getDesign());
    const reopened = new ShipDesignManager(store).load().designs[0];
    expect(reopened.slots).toHaveLength(8);
    expect(reopened.schemaVersion).toBe(2);
    expect(designSchema.safeParse({ ...reopened, cargo: [ore] }).success).toBe(false);
    expect(repository.exportJSON()).not.toContain('cargo');
    expect(new DesignedShip(reopened, 'blue').getState().cargo).toEqual([]);
  });
});

describe('civilian factory migration', () => {
  it.each(['scout', 'freighter'] as const)('creates editable independent %s blueprints valid for flight but not battle', id => {
    const design = createCivilianDesign(id);
    const other = createCivilianDesign(id);
    expect(validateDesign(design, 'flight')).toEqual([]);
    expect(validateDesign(design, 'battle').map(issue => issue.code)).toEqual(['weapon']);
    expect(other.id).not.toBe(design.id);
    design.slots[3].component!.name = 'Changed';
    expect(other.slots[3].component!.name).not.toBe('Changed');
    const ship = id === 'scout' ? ShipFactory.createScout() : ShipFactory.createFreighter();
    expect(ship).toBeInstanceOf(DesignedShip);
    expect(ship.getState().weapons).toEqual([]);
    expect(ship.getState().shield).toBe(0);
    expect(ship.getInstalledModuleNames()).toHaveLength(1);
    expect(ship.getTotalWeight()).toBe(calculateShipStats(ship.getDesign()).mass);
  });

  it('creates a fully equipped canonical demo cruiser without ignored legacy installs', () => {
    const ship = ShipFactory.createWarship();
    expect(validateDesign(ship.getDesign())).toEqual([]);
    expect(ship.getState().weapons).toHaveLength(2);
    expect(ship.getInstalledModuleNames()).toHaveLength(5);
  });

  it('retains the mining module in the canonical miner without claiming active extraction', () => {
    const ship = ShipFactory.createMiner();
    expect(validateDesign(ship.getDesign(), 'flight')).toEqual([]);
    expect(ship.getDesign().slots.find(slot => slot.id === 'service_1')?.component).toMatchObject({
      kind: 'mining', miningSpeed: 10, efficiency: 0.8, name: 'Добывающий модуль Mk1'
    });
    expect(ship.getInfo()).toContain('ещё не исполняются');
    ship.update(10);
    expect(ship.cargoHold.currentWeight).toBe(0);
    expect(ship.getState().cargo).toEqual([]);
  });
});