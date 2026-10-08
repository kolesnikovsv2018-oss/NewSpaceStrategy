import { describe, expect, it, vi } from 'vitest';
import { BattleManager } from '../src/entities/BattleManager';
import { LegacyCombatShipFactory as CombatShipFactory } from './fixtures/LegacyCombatShipFactory';

function createBattle(autoTarget = true, environment: {
  alternateFactionOrder?: boolean;
  firstFactionId?: string;
} = {}) {
  const blue = CombatShipFactory.createFighter('blue');
  const red = CombatShipFactory.createFighter('red');
  // Same position, guaranteed hit. Random criticals are disabled for repeatability.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  blue.weaponStats.accuracy = 1;
  red.combatStats.evasion = 0;
  const manager = new BattleManager({
    factions: [
      { id: 'blue', name: 'Blue', color: 0x0000ff, ships: [blue] },
      { id: 'red', name: 'Red', color: 0xff0000, ships: [red] }
    ],
    battlefieldWidth: 1280,
    battlefieldHeight: 720,
    autoTarget,
    friendlyFire: false
  }, environment);
  return { blue, red, manager };
}

describe('BattleManager', () => {
  it('records losses for the victim and kills for the attacker', () => {
    const { blue, red, manager } = createBattle();
    blue.weaponStats.damage = 10000;
    const availableHP = red.combatStats.currentHull + red.combatStats.currentShield;
    manager.start();
    manager.update(1 / 60);
    const stats = manager.getStats();
    expect(stats.factionStats.get('blue')).toMatchObject({ shipsAlive: 1, shipsDestroyed: 0, kills: 1 });
    expect(stats.factionStats.get('red')).toMatchObject({ shipsAlive: 0, shipsDestroyed: 1, kills: 0 });
    expect(stats.totalDamage).toBe(availableHP);
    expect(stats.shipsDestroyed).toBe(1);
    expect(manager.getWinner()?.id).toBe('blue');
    expect(manager.getBattleReport()).toContain('Потери: 1');
  });

  it('advances duration by simulation time, not wall time', () => {
    const { manager } = createBattle(false);
    manager.start();
    manager.update(0.25);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60000);
    manager.update(0.25);
    expect(manager.getStats().duration).toBe(500);
  });

  it('stops and notifies once, leaving the final events available to render', () => {
    const { blue, manager } = createBattle();
    blue.weaponStats.damage = 10000;
    const onEnd = vi.fn();
    manager.onBattleEnd(onEnd);
    manager.start();
    manager.update(0.1);
    manager.stop();
    manager.update(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(manager.getStats().duration).toBe(100);
    expect(manager.drainEvents().map(event => event.type)).toEqual(['WeaponFired', 'ShipDestroyed']);
    expect(manager.drainEvents()).toEqual([]);
  });

  it('emits shots on a miss, but not again while reloading', () => {
    const { blue, red, manager } = createBattle();
    blue.weaponStats.accuracy = 0;
    red.weaponStats.currentCooldown = 100;
    manager.start();
    manager.update(0.01);
    expect(manager.drainEvents()).toMatchObject([{ type: 'WeaponFired', attackerId: blue.id, hit: false }]);
    manager.update(0.01);
    expect(manager.drainEvents()).toEqual([]);
  });

  it('does not emit shots on insufficient energy or range', () => {
    const { blue, red, manager } = createBattle();
    blue.powerSource.currentEnergy = 0;
    blue.powerSource.energyOutput = 0;
    red.weaponStats.range = 0;
    red.position.x = 100;
    manager.start();
    manager.update(0.01);
    expect(manager.drainEvents()).toEqual([]);
  });

  it('captures event positions instead of retaining mutable model positions', () => {
    const { blue, red, manager } = createBattle();
    blue.weaponStats.accuracy = 0;
    red.weaponStats.currentCooldown = 100;
    manager.start();
    manager.update(0.01);
    blue.position.x = 999;
    expect(manager.drainEvents()).toMatchObject([{ type: 'WeaponFired', from: { x: 0, y: 0 } }]);
  });

  it('updates each living ship once per step', () => {
    const { blue, red, manager } = createBattle(false);
    const blueUpdate = vi.spyOn(blue, 'update');
    const redUpdate = vi.spyOn(red, 'update');
    manager.start();
    manager.update(0.1);
    expect(blueUpdate).toHaveBeenCalledExactlyOnceWith(0.1);
    expect(redUpdate).toHaveBeenCalledExactlyOnceWith(0.1);
  });

  it('starts with the seeded faction and alternates initiative on following steps', () => {
    const { blue, red, manager } = createBattle(false, { alternateFactionOrder: true, firstFactionId: 'red' });
    const order: string[] = [];
    vi.spyOn(blue, 'update').mockImplementation(() => { order.push('blue'); });
    vi.spyOn(red, 'update').mockImplementation(() => { order.push('red'); });
    manager.start();
    manager.update(0.05);
    manager.update(0.05);
    expect(order).toEqual(['red', 'blue', 'blue', 'red']);
  });

  it('preserves configured faction order when initiative alternation is disabled', () => {
    const { blue, red, manager } = createBattle(false);
    const order: string[] = [];
    vi.spyOn(blue, 'update').mockImplementation(() => { order.push('blue'); });
    vi.spyOn(red, 'update').mockImplementation(() => { order.push('red'); });
    manager.start();
    manager.update(0.05);
    manager.update(0.05);
    expect(order).toEqual(['blue', 'red', 'blue', 'red']);
  });

  it('assigns symmetric lateral approach slots only when line formation is enabled', () => {
    const blueFirst = CombatShipFactory.createFighter('blue', 0);
    const blueSecond = CombatShipFactory.createFighter('blue', 1);
    const blueThird = CombatShipFactory.createFighter('blue', 2);
    const red = CombatShipFactory.createFighter('red');
    blueFirst.position = { x: 0, y: 0 };
    blueSecond.position = { x: 0, y: 0 };
    blueThird.position = { x: 0, y: 0 };
    red.position = { x: 500, y: 0 };
    const firstMove = vi.spyOn(blueFirst, 'moveToTarget').mockImplementation(() => {});
    const secondMove = vi.spyOn(blueSecond, 'moveToTarget').mockImplementation(() => {});
    const thirdMove = vi.spyOn(blueThird, 'moveToTarget').mockImplementation(() => {});
    const manager = new BattleManager({ factions: [
      { id: 'blue', name: 'Blue', color: 0, ships: [blueFirst, blueSecond, blueThird] },
      { id: 'red', name: 'Red', color: 1, ships: [red] }
    ], battlefieldWidth: 800, battlefieldHeight: 500, autoTarget: true, friendlyFire: false,
    formation: 'line-abreast' });

    manager.start();
    manager.update(0.05);

    expect(firstMove).toHaveBeenCalledWith(red, undefined, { x: 0, y: -60 });
    expect(secondMove).toHaveBeenCalledWith(red, undefined, { x: 0, y: 0 });
    expect(thirdMove).toHaveBeenCalledWith(red, undefined, { x: 0, y: 60 });

    blueSecond.isDestroyed = true;
    manager.update(0.05);
    expect(firstMove).toHaveBeenLastCalledWith(red, undefined, { x: 0, y: -30 });
    expect(thirdMove).toHaveBeenLastCalledWith(red, undefined, { x: 0, y: 30 });
    expect(secondMove).toHaveBeenCalledTimes(1);
  });

  it('lets a living ally intercept a shot only when line-of-fire cover is enabled', () => {
    const resolveShot = (cover?: 'line-of-fire') => {
      const attacker = CombatShipFactory.createFighter('blue');
      const screen = CombatShipFactory.createFighter('red', 0);
      const target = CombatShipFactory.createFighter('red', 1);
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      attacker.weaponStats.accuracy = 1;
      screen.combatStats.evasion = 0;
      attacker.position = { x: 0, y: 0 };
      screen.position = { x: 150, y: 5 };
      target.position = { x: 300, y: 0 };
      target.combatStats.currentHull = target.combatStats.maxHull * 0.2;
      const manager = new BattleManager({ factions: [
        { id: 'blue', name: 'Blue', color: 0, ships: [attacker] },
        { id: 'red', name: 'Red', color: 1, ships: [screen, target] }
      ], battlefieldWidth: 600, battlefieldHeight: 300, autoTarget: true, friendlyFire: false,
      targetPriority: 'lowest-hull-ratio', cover });
      manager.start();
      manager.update(0.01);
      const event = manager.drainEvents().find(item => item.type === 'WeaponFired' && item.attackerId === attacker.id);
      return { attacker, screen, target, event };
    };

    const uncovered = resolveShot();
    expect(uncovered.attacker.target).toBe(uncovered.target);
    expect(uncovered.event).toMatchObject({ type: 'WeaponFired', targetId: uncovered.target.id });
    expect(uncovered.screen.combatStats.currentShield).toBe(uncovered.screen.combatStats.maxShield);

    const covered = resolveShot('line-of-fire');
    expect(covered.attacker.target).toBe(covered.target);
    expect(covered.event).toMatchObject({ type: 'WeaponFired', targetId: covered.screen.id, hit: true });
    expect(covered.screen.combatStats.currentShield).toBeLessThan(covered.screen.combatStats.maxShield);
    expect(covered.target.combatStats.currentHull).toBe(covered.target.combatStats.maxHull * 0.2);
  });

  it('retreats below the configured hull ratio while preserving the default approach', () => {
    const createRetreatBattle = (retreatHullRatio?: number, hullRatio = 0.25) => {
      const blue = CombatShipFactory.createFighter('blue');
      const red = CombatShipFactory.createFighter('red');
      blue.position = { x: 0, y: 0 };
      red.position = { x: 500, y: 0 };
      blue.combatStats.currentHull = blue.combatStats.maxHull * hullRatio;
      const move = vi.spyOn(blue, 'moveToTarget').mockImplementation(() => {});
      const manager = new BattleManager({ factions: [
        { id: 'blue', name: 'Blue', color: 0, ships: [blue] },
        { id: 'red', name: 'Red', color: 1, ships: [red] }
      ], battlefieldWidth: 800, battlefieldHeight: 500, autoTarget: true, friendlyFire: false, retreatHullRatio });
      manager.start();
      manager.update(0.01);
      return { blue, red, move };
    };

    const defaultBattle = createRetreatBattle();
    expect(defaultBattle.move.mock.calls[0]).toEqual([defaultBattle.red]);

    const aboveThreshold = createRetreatBattle(0.5, 0.75);
    expect(aboveThreshold.move.mock.calls[0]).toEqual([aboveThreshold.red]);

    const retreating = createRetreatBattle(0.5, 0.25);
    expect(retreating.move.mock.calls[0]).toEqual([retreating.red, undefined, undefined, true]);
  });

  it('keeps nearest targeting by default and can prioritize the lowest hull ratio', () => {
    const createPriorityBattle = (targetPriority?: 'nearest' | 'lowest-hull-ratio') => {
      const blue = CombatShipFactory.createFighter('blue');
      const near = CombatShipFactory.createFighter('red', 0);
      const weakNear = CombatShipFactory.createFighter('red', 1);
      const weakFar = CombatShipFactory.createFighter('red', 2);
      blue.position = { x: 0, y: 0 };
      near.position = { x: 40, y: 0 };
      weakNear.position = { x: 80, y: 0 };
      weakFar.position = { x: 120, y: 0 };
      weakNear.combatStats.currentHull = weakNear.combatStats.maxHull * 0.25;
      weakFar.combatStats.currentHull = weakFar.combatStats.maxHull * 0.25;
      const manager = new BattleManager({ factions: [
        { id: 'blue', name: 'Blue', color: 0, ships: [blue] },
        { id: 'red', name: 'Red', color: 1, ships: [near, weakNear, weakFar] }
      ], battlefieldWidth: 500, battlefieldHeight: 500, autoTarget: true, friendlyFire: false, targetPriority });
      return { blue, near, weakNear, manager };
    };

    const nearest = createPriorityBattle();
    nearest.manager.start();
    nearest.manager.update(0.01);
    expect(nearest.blue.target?.id).toBe(nearest.near.id);

    const weakest = createPriorityBattle('lowest-hull-ratio');
    weakest.manager.start();
    weakest.manager.update(0.01);
    expect(weakest.blue.target?.id).toBe(weakest.weakNear.id);
  });

  it.each([0, -1, NaN, Infinity])('ignores invalid delta %s', delta => {
    const { blue, manager } = createBattle(false);
    const update = vi.spyOn(blue, 'update');
    manager.start();
    manager.update(delta);
    expect(update).not.toHaveBeenCalled();
    expect(manager.getStats().duration).toBe(0);
  });
});