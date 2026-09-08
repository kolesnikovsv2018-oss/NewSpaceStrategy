import { describe, expect, it, vi } from 'vitest';
import { CombatShipFactory } from '../src/entities/CombatShipFactory';
import { DesignedShip } from '../src/entities/DesignedShip';
import { BattleManager } from '../src/entities/BattleManager';
import { COMBAT_PRESET_NAMES, createCombatDesign, type CombatPresetId } from '../src/domain/combatPresets';
import { calculateShipStats, installComponent, validateDesign } from '../src/domain/shipDesign';
import { ShipDesignManager } from '../src/utils/ShipDesignManager';

describe('canonical combat factory', () => {
  it.each([
    ['fighter', CombatShipFactory.createFighter, 'fighter', 2, 1],
    ['frigate', CombatShipFactory.createFrigate, 'frigate', 4, 1],
    ['cruiser', CombatShipFactory.createCruiser, 'cruiser', 5, 2],
    ['dreadnought', CombatShipFactory.createDreadnought, 'battleship', 6, 3]
  ] as const)('%s uses a complete validated blueprint and calculated stats', (preset, create, hull, modules, weapons) => {
    const ship = create('blue', 2);
    const design = ship.getDesign();
    const stats = calculateShipStats(design);
    expect(ship).toBeInstanceOf(DesignedShip);
    expect(ship.name).toBe(`${COMBAT_PRESET_NAMES[preset]}-3`);
    expect(design.hullId).toBe(hull);
    expect(validateDesign(design)).toEqual([]);
    expect(design.slots.filter(slot => slot.component)).toHaveLength(modules);
    expect(ship.getWeaponState()).toHaveLength(weapons);
    expect(ship.getState().weapons.some(weapon => weapon.slotId === 'legacy-aggregate')).toBe(false);
    expect(ship.getTotalWeight()).toBe(stats.mass);
    expect(ship.getTotalCost()).toBe(stats.cost);
    expect(ship.getCurrentMaxSpeed()).toBe(stats.speed);
    expect(ship.getState()).toMatchObject({ energy: stats.energyCapacity, hull: stats.hitPoints, shield: stats.shield });
    expect(ship.weaponStats.damage).toBe(stats.weapons.reduce((sum, weapon) => sum + weapon.definition.damage, 0));
  });

  it.each(Object.keys(COMBAT_PRESET_NAMES) as CombatPresetId[])('%s can be saved, imported, edited and instantiated without conversion', preset => {
    const storage = new Map<string, string>();
    const repository = new ShipDesignManager({ getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); } });
    const saved = repository.saveDesign(createCombatDesign(preset));
    repository.importJSON(repository.exportJSON());
    const loaded = repository.load().designs[0];
    expect(loaded).toEqual(saved);
    const gun = loaded.slots.find(slot => slot.id === 'beam_1')!.component!;
    if (gun.kind !== 'beam') throw new Error('Invalid fixture');
    const edited = installComponent(loaded, 'beam_1', { ...gun, damage: gun.damage + 5 });
    const ship = CombatShipFactory.createFromDesign(edited, 'red');
    expect(ship.getDesign()).toEqual(edited);
    expect(ship.factionId).toBe('red');
    expect(calculateShipStats(ship.getDesign()).dps).toBeGreaterThan(calculateShipStats(saved).dps);
    expect(repository.load().designs[0]).toEqual(saved);
  });

  it('copies template modules and runtime state for every instance', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = CombatShipFactory.createCruiser('blue');
    const second = CombatShipFactory.createCruiser('blue');
    expect(first.id).not.toBe(second.id);
    expect(first.getDesign().id).not.toBe(second.getDesign().id);
    const slots = first.getDesign().slots.flatMap(slot => slot.component ? [slot.component.id] : []);
    expect(new Set(slots).size).toBe(slots.length);
    first.takeDamage(100);
    first.powerSource.currentEnergy = 0;
    first.getDesign().slots[0].component!.name = 'Changed copy';
    expect(second.getState().shield).toBe(second.combatStats.maxShield);
    expect(second.getState().energy).toBe(second.powerSource.energyCapacity);
    expect(second.getDesign()).toEqual(CombatShipFactory.createFromDesign(second.getDesign(), 'blue').getDesign());
  });

  it('rejects invalid edited designs at the runtime boundary instead of returning a partial loadout', () => {
    const design = installComponent(createCombatDesign('fighter'), 'beam_1', null);
    expect(() => CombatShipFactory.createFromDesign(design, 'blue')).toThrow('Для боя установите оружие');
    expect(() => CombatShipFactory.createFromDesign({ ...design, hullId: 'unknown' } as never, 'blue')).toThrow();
  });

  it('uses edited gun damage and energy rather than mutable legacy weapon summaries', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const design = createCombatDesign('fighter');
    const gun = design.slots.find(slot => slot.id === 'beam_1')!.component!;
    if (gun.kind !== 'beam') throw new Error('Invalid fixture');
    const ship = CombatShipFactory.createFromDesign(installComponent(design, 'beam_1', { ...gun, damage: 42, accuracy: 1 }), 'blue');
    const target = CombatShipFactory.createFighter('red');
    target.combatStats.evasion = 0;
    ship.weaponStats.damage = 9999; // Compatibility summary must not introduce invisible firepower.
    const energy = ship.getState().energy;
    expect(ship.attack(target)?.damage).toBe(42);
    expect(energy - ship.getState().energy).toBe(124);
    expect(ship.attack(target)).toBeNull();
  });

  it('accounts for actual losses/damage and final events using production presets', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const blue = CombatShipFactory.createFighter('blue');
    const red = CombatShipFactory.createFighter('red');
    red.combatStats.evasion = 0;
    red.combatStats.currentHull = 10;
    const manager = new BattleManager({ factions: [
      { id: 'blue', name: 'Blue', color: 0, ships: [blue] }, { id: 'red', name: 'Red', color: 1, ships: [red] }
    ], battlefieldWidth: 1280, battlefieldHeight: 720, autoTarget: true, friendlyFire: false });
    manager.start(); manager.update(1 / 60);
    expect(manager.getStats().totalDamage).toBe(10);
    expect(manager.getStats().shipsDestroyed).toBe(1);
    expect(manager.getStats().factionStats.get('blue')).toMatchObject({ kills: 1, shipsDestroyed: 0 });
    expect(manager.getStats().factionStats.get('red')).toMatchObject({ kills: 0, shipsDestroyed: 1 });
    expect(manager.drainEvents().map(event => event.type)).toEqual(['WeaponFired', 'ShipDestroyed']);
    expect(manager.drainEvents()).toEqual([]);
  });

  it('builds the same fleet composition API with fresh validated project instances', () => {
    const fleet = CombatShipFactory.createFleet('blue', { fighters: 5, frigates: 2, cruisers: 1 });
    expect(fleet).toHaveLength(8);
    expect(fleet.map(ship => ship.getDesign().hullId)).toEqual(['fighter', 'fighter', 'fighter', 'fighter', 'fighter', 'frigate', 'frigate', 'cruiser']);
    expect(new Set(fleet.map(ship => ship.id)).size).toBe(8);
    expect(fleet.every(ship => validateDesign(ship.getDesign()).length === 0)).toBe(true);
    expect(CombatShipFactory.createFleet('red', {})).toEqual([]);
    expect(CombatShipFactory.createFighterSquadron('blue', 0)).toEqual([]);
  });

  it.each([-1, 0.5, NaN, Infinity, 129])('rejects invalid count %s before creating ships', count => {
    const create = vi.spyOn(CombatShipFactory, 'createFighter');
    expect(() => CombatShipFactory.createFleet('blue', { fighters: 1, frigates: count })).toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(() => CombatShipFactory.createRandomFleet('blue', count)).toThrow();
  });

  it('rejects excessive total size and unknown composition keys', () => {
    expect(() => CombatShipFactory.createFleet('blue', { fighters: 100, cruisers: 100 })).toThrow();
    expect(() => CombatShipFactory.createFleet('blue', { fighter: 1 } as never)).toThrow();
    expect(() => createCombatDesign('fighter', -1)).toThrow();
  });

  it.each([[0, 'fighter'], [0.4, 'frigate'], [0.7, 'cruiser'], [0.95, 'battleship']] as const)('random branch %s creates hull %s', (random, hull) => {
    vi.spyOn(Math, 'random').mockReturnValue(random);
    expect(CombatShipFactory.createRandomShip('red').getDesign().hullId).toBe(hull);
    expect(CombatShipFactory.createRandomFleet('red', 2)).toHaveLength(2);
  });
});
