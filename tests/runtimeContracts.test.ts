import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { BattleManager } from '../src/entities/BattleManager';
import { CombatShip } from '../src/entities/CombatShip';
import { DesignedShip } from '../src/entities/DesignedShip';
import { TacticalShip } from '../src/entities/TacticalShip';
import { Ship } from '../src/entities/Ship';
import { ShipRuntime } from '../src/entities/ShipRuntime';
import { ShipFactory } from '../src/entities/ShipFactory';
import { CombatShipFactory } from '../src/entities/CombatShipFactory';
import type { ICombatant } from '../src/entities/interfaces/CombatSystem';
import type { ShipView } from '../src/entities/interfaces/ShipView';
import { LegacyCombatShipFactory } from './fixtures/LegacyCombatShipFactory';

const constructors = [
  ['legacy', (faction = 'blue') => LegacyCombatShipFactory.createFrigate(faction)],
  ['designed', (faction = 'blue') => CombatShipFactory.createFrigate(faction)]
] as const;

function battle(blue: ICombatant, red: ICombatant): BattleManager {
  return new BattleManager({
    factions: [
      { id: 'blue', name: 'Blue', color: 0x0000ff, ships: [blue] },
      { id: 'red', name: 'Red', color: 0xff0000, ships: [red] }
    ],
    battlefieldWidth: 1280, battlefieldHeight: 720, autoTarget: true, friendlyFire: false
  });
}

/** Deliberately unrelated to any production class: tests the declared contract, not inheritance. */
function contractCombatant(factionId: string): ICombatant {
  const ship: ICombatant = {
    id: factionId, name: factionId, factionId, isDestroyed: false,
    position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, isMoving: false,
    powerSource: { name: 'battery', currentEnergy: 100, energyCapacity: 100, energyOutput: 0 },
    engine: { name: 'engine', thrust: 1, energyConsumption: 0 },
    cargoHold: { name: 'hold', capacity: 1, usedSpace: 0, currentWeight: 0, maxWeight: 1 },
    combatStats: { maxHull: 5, currentHull: 5, maxShield: 0, currentShield: 0, shieldRegenRate: 0, armor: 0, evasion: 0 },
    weaponStats: { damage: 10, range: 100, fireRate: 1, accuracy: 1, energyCost: 0, cooldown: 1, currentCooldown: 0 },
    getDesign: () => undefined, getInfo: () => factionId, getCombatInfo: () => factionId,
    getTotalCost: () => 1, getTotalWeight: () => 1, getCurrentMaxSpeed: () => 1,
    getMaxRange: () => 100, getFlightEstimate: () => ({ kind: 'sustained' }), getInstalledModuleNames: () => [],
    update: vi.fn(), getAttackAttemptsPerStep: () => 2,
    moveToTarget: vi.fn(),
    findNearestEnemy: enemies => enemies.find(enemy => !enemy.isDestroyed && enemy.factionId !== factionId),
    attack: target => target.isDestroyed ? null : target.takeDamage(10),
    takeDamage: damage => {
      const hullDamage = Math.min(damage, ship.combatStats.currentHull);
      ship.combatStats.currentHull -= hullDamage;
      ship.isDestroyed = ship.combatStats.currentHull === 0;
      return { hit: true, damage: hullDamage, shieldDamage: 0, hullDamage, critical: false, evaded: false };
    }
  };
  return ship;
}

describe('runtime contracts and sibling combat models', () => {
  it('separates canonical runtime from CombatShip while keeping the shared compatibility base explicit', () => {
    const canonical = CombatShipFactory.createFighter('blue');
    const legacy = LegacyCombatShipFactory.createFighter('red');
    expect(canonical).toBeInstanceOf(DesignedShip);
    expect(canonical).not.toBeInstanceOf(CombatShip);
    expect(legacy).toBeInstanceOf(CombatShip);
    expect(legacy).not.toBeInstanceOf(DesignedShip);
    expect(canonical).toBeInstanceOf(TacticalShip);
    expect(canonical).not.toBeInstanceOf(Ship);
    expect(legacy).toBeInstanceOf(Ship);
    for (const ship of [canonical, legacy]) expect(ship).toBeInstanceOf(ShipRuntime);
    expectTypeOf<DesignedShip>().toMatchTypeOf<ICombatant>();
    expectTypeOf<CombatShip>().toMatchTypeOf<ICombatant>();
    expectTypeOf<Ship>().toMatchTypeOf<ShipView>();
    expectTypeOf<ShipView>().not.toHaveProperty('update');
    expectTypeOf<ShipView>().not.toHaveProperty('installEquipment');
    expectTypeOf<ShipView>().not.toHaveProperty('equipment');
  });

  it('does not execute legacy attack, damage or update implementations for a design', () => {
    for (const method of ['attack', 'takeDamage', 'update'] as const) {
      vi.spyOn(CombatShip.prototype, method).mockImplementation(() => { throw new Error('Legacy combat called'); });
    }
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const blue = CombatShipFactory.createFighter('blue');
    const red = CombatShipFactory.createFighter('red');
    blue.update(0.1);
    expect(blue.attack(red)?.hit).toBe(true);
    expect(blue.takeDamage(1).hullDamage).toBeGreaterThan(0);
  });

  it.each(['createScout', 'createFreighter', 'createMiner'] as const)('%s initializes no aggregate weapon or phantom shield', preset => {
    const ship = ShipFactory[preset]();
    expect(ship).not.toBeInstanceOf(CombatShip);
    expect(ship.getState()).toMatchObject({ shield: 0, weapons: [] });
    expect(ship.getAttackAttemptsPerStep()).toBe(0);
    expect(ship.weaponStats.damage).toBe(0);
    ship.weaponStats.currentCooldown = 2;
    expect(ship.weaponStats.currentCooldown).toBe(0);
    ship.update(1);
    expect(ship.getState()).toMatchObject({ shield: 0, weapons: [] });
  });

  describe.each(constructors)('%s shared tactical behavior', (_label, create) => {
    it('keeps replaced combat views live but input objects and state snapshots independent', () => {
      const ship = create();
      const originalView = ship.combatStats;
      const replacement = { ...ship.combatStats, currentHull: 70, currentShield: 20 };
      ship.combatStats = replacement;
      replacement.currentHull = 999;
      expect(originalView.currentHull).toBe(70);
      ship.combatStats.currentShield = 10;
      const weaponView = ship.weaponStats;
      ship.weaponStats = { ...ship.weaponStats, currentCooldown: 0.75 };
      expect(weaponView.currentCooldown).toBe(0.75);
      const snapshot = ship.getState();
      snapshot.hull = 0;
      snapshot.weapons[0].cooldown = 0;
      expect(ship.getState()).toMatchObject({ hull: 70, shield: 10, weapons: [{ cooldown: 0.75 }] });
      expect(ship.getHullPercent()).toBeCloseTo(70 / ship.combatStats.maxHull * 100);
      expect(ship.getShieldPercent()).toBeCloseTo(10 / ship.combatStats.maxShield * 100);
      expect(ship.getCombatInfo()).toContain(ship.factionId);
    });

    it('finds the nearest live enemy across model types, keeping first candidate on ties', () => {
      const ship = create();
      const friend = contractCombatant('blue');
      const dead = contractCombatant('red');
      dead.isDestroyed = true;
      const first = CombatShipFactory.createFighter('red');
      const second = LegacyCombatShipFactory.createFighter('red');
      first.position.x = 30;
      second.position.x = -30;
      const enemies = [friend, dead, first, second];
      expect(ship.findNearestEnemy(enemies)).toBe(first);
      expect(ship.getDistanceTo(first)).toBe(30);
      expect(ship.findNearestEnemy([friend, dead])).toBeUndefined();
      expect(enemies).toEqual([friend, dead, first, second]);
    });

    it.each([
      ['approach', 1.1, 1], ['retreat', 0.25, -1], ['stop', 0.7, 0]
    ] as const)('preserves %s navigation independently of combat formulas', (_mode, ratio, direction) => {
      const ship = create();
      const target = contractCombatant('red');
      const x = ship.weaponStats.range * ratio;
      const positioned = { ...target, position: { x, y: 0 } };
      ship.startMoving(0, 100);
      ship.moveToTarget(positioned);
      expect(Math.sign(ship.velocity.x)).toBe(direction);
      expect(ship.isMoving).toBe(direction !== 0);
      expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeCloseTo(direction === 0 ? 0 : ship.getCurrentMaxSpeed());
    });
  });

  it.each(['legacy', 'designed'] as const)('resolves mixed-model damage and final events with %s attacker', kind => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const blue = kind === 'legacy' ? LegacyCombatShipFactory.createFighter('blue') : CombatShipFactory.createFighter('blue');
    const red = kind === 'legacy' ? CombatShipFactory.createFighter('red') : LegacyCombatShipFactory.createFighter('red');
    red.combatStats.currentHull = 1;
    red.combatStats.currentShield = 0;
    red.combatStats.evasion = 0;
    const redUpdate = vi.spyOn(red, 'update');
    const blueUpdate = vi.spyOn(blue, 'update');
    const manager = battle(blue, red);
    const ended = vi.fn();
    manager.onBattleEnd(ended);
    manager.start();
    manager.update(0.01);
    expect(manager.getStats()).toMatchObject({ totalDamage: 1, shipsDestroyed: 1, duration: 10 });
    expect(manager.getWinner()?.id).toBe('blue');
    expect(manager.getStats().factionStats.get('red')?.shipsDestroyed).toBe(1);
    expect(manager.getStats().factionStats.get('blue')?.kills).toBe(1);
    expect(blueUpdate).toHaveBeenCalledExactlyOnceWith(0.01);
    expect(redUpdate).not.toHaveBeenCalled();
    expect(red.getState()).toMatchObject({ hull: 0, isDestroyed: true, isMoving: false });
    expect(manager.drainEvents().map(event => event.type)).toEqual(['WeaponFired', 'ShipDestroyed']);
    expect(manager.drainEvents()).toEqual([]);
    manager.stop();
    manager.update(1);
    expect(ended).toHaveBeenCalledOnce();
  });

  it('runs BattleManager with structural combatants having no Ship prototype', () => {
    const blue = contractCombatant('blue');
    const red = contractCombatant('red');
    expect(blue).not.toBeInstanceOf(Ship);
    const manager = battle(blue, red);
    manager.start();
    manager.update(0.1);
    expect(blue.target).toBe(red);
    expect(blue.moveToTarget).toHaveBeenCalledWith(red);
    expect(manager.getStats()).toMatchObject({ totalDamage: 5, shipsDestroyed: 1 });
    expect(manager.getAllShips()).toEqual([blue, red]);
    expect(manager.getAliveShips()).toEqual([blue]);
    expect(manager.getDestroyedShips()).toEqual([red]);
    expect(manager.drainEvents().map(event => event.type)).toEqual(['WeaponFired', 'ShipDestroyed']);
    expect(blue.update).toHaveBeenCalledOnce();
    expect(red.update).not.toHaveBeenCalled();
  });
});