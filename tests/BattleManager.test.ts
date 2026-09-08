import { describe, expect, it, vi } from 'vitest';
import { BattleManager } from '../src/entities/BattleManager';
import { LegacyCombatShipFactory as CombatShipFactory } from './fixtures/LegacyCombatShipFactory';

function createBattle(autoTarget = true) {
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
  });
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

  it.each([0, -1, NaN, Infinity])('ignores invalid delta %s', delta => {
    const { blue, manager } = createBattle(false);
    const update = vi.spyOn(blue, 'update');
    manager.start();
    manager.update(delta);
    expect(update).not.toHaveBeenCalled();
    expect(manager.getStats().duration).toBe(0);
  });
});