import { ShipRuntime } from './ShipRuntime';
import type { ICombatant, ICombatStats, IWeaponStats, IAttackResult } from './interfaces/CombatSystem';
import { assertNonNegative, finitePosition, nonNegativeFinite } from '../domain/runtimeNumbers';

// TypeScript's mixin constructor signature preserves each base's own constructor arguments.
// The only erased type is the constructor tuple, never component data or runtime operations.
type RuntimeConstructor = abstract new (...args: any[]) => ShipRuntime;

/** Add tactics to either the neutral runtime or the legacy adapter without inheriting legacy equipment. */
export function withTactics<TBase extends RuntimeConstructor>(Base: TBase) {
abstract class Tactical extends Base implements ICombatant {
  private combatStatsView!: ICombatStats;
  private weaponStatsView!: IWeaponStats;

  get combatStats(): ICombatStats { return this.combatStatsView; }
  set combatStats(stats: ICombatStats) {
    assertNonNegative(stats.currentHull, 'Корпус');
    assertNonNegative(stats.currentShield, 'Щит');
    const ship = this;
    const { currentHull, currentShield, ...configuration } = stats;
    this.state.hull = currentHull;
    this.state.shield = currentShield;
    this.combatStatsView = { ...configuration,
      get currentHull() { return ship.state.hull; },
      set currentHull(value: number) { assertNonNegative(value, 'Корпус'); ship.state.hull = value; },
      get currentShield() { return ship.state.shield; },
      set currentShield(value: number) { assertNonNegative(value, 'Щит'); ship.state.shield = value; }
    };
  }

  get weaponStats(): IWeaponStats { return this.weaponStatsView; }
  set weaponStats(stats: IWeaponStats) {
    assertNonNegative(stats.currentCooldown, 'Перезарядка');
    const ship = this;
    const { currentCooldown, ...configuration } = stats;
    this.state.weapons.forEach(weapon => { weapon.cooldown = currentCooldown; });
    this.weaponStatsView = { ...configuration,
      get currentCooldown() { return Math.max(0, ...ship.state.weapons.map(weapon => weapon.cooldown)); },
      set currentCooldown(value: number) {
        assertNonNegative(value, 'Перезарядка');
        ship.state.weapons.forEach(weapon => { weapon.cooldown = value; });
      }
    };
  }

  target?: ICombatant;
  get isDestroyed(): boolean { return this.state.isDestroyed; }
  set isDestroyed(value: boolean) { this.state.isDestroyed = value; }

  factionId = 'neutral';

  abstract getAttackAttemptsPerStep(): number;
  abstract attack(target: ICombatant): IAttackResult | null;
  abstract takeDamage(damage: number, critical?: boolean, damageType?: 'beam' | 'projectile'): IAttackResult;

  getDistanceTo(target: Pick<ICombatant, 'position'>): number {
    if (!finitePosition(target.position) || !finitePosition(this.position)) return Infinity;
    const dx = target.position.x - this.position.x;
    const dy = target.position.y - this.position.y;
    return Math.hypot(dx, dy);
  }

  findNearestEnemy(enemies: readonly ICombatant[]): ICombatant | undefined {
    let nearest: ICombatant | undefined;
    let minDistance = Infinity;
    enemies.forEach(enemy => {
      if (!enemy.isDestroyed && enemy.factionId !== this.factionId) {
        const distance = this.getDistanceTo(enemy);
        if (distance < minDistance) {
          minDistance = distance;
          nearest = enemy;
        }
      }
    });
    return nearest;
  }

  moveToTarget(target: ICombatant, optimalRange = 0.8): void {
    if (!nonNegativeFinite(optimalRange) || !finitePosition(target.position) || !finitePosition(this.position)) return;
    const distance = this.getDistanceTo(target);
    const targetDistance = this.weaponStats.range * optimalRange;
    if (!Number.isFinite(distance) || !nonNegativeFinite(targetDistance)) return;
    if (distance > targetDistance) {
      this.startMoving(target.position.x, target.position.y);
    } else if (distance < this.weaponStats.range * 0.5) {
      const dx = this.position.x - target.position.x;
      const dy = this.position.y - target.position.y;
      const angle = Math.atan2(dy, dx);
      this.startMoving(this.position.x + Math.cos(angle) * 50, this.position.y + Math.sin(angle) * 50);
    } else {
      this.stopMoving();
    }
  }

  getHullPercent(): number {
    return (this.combatStats.currentHull / this.combatStats.maxHull) * 100;
  }

  getShieldPercent(): number {
    return this.combatStats.maxShield > 0 ? (this.combatStats.currentShield / this.combatStats.maxShield) * 100 : 0;
  }

  getCombatInfo(): string {
    return `
${this.name} [${this.factionId}]
Корпус: ${this.combatStats.currentHull.toFixed(0)}/${this.combatStats.maxHull} (${this.getHullPercent().toFixed(0)}%)
Щит: ${this.combatStats.currentShield.toFixed(0)}/${this.combatStats.maxShield} (${this.getShieldPercent().toFixed(0)}%)
Броня: ${this.combatStats.armor.toFixed(1)}
Урон: ${this.weaponStats.damage}
Дальность оружия: ${this.weaponStats.range} такт. ед.
Статус: ${this.isDestroyed ? '💀 Уничтожен' : '✓ Активен'}
    `.trim();
  }
}
return Tactical;
}

export abstract class TacticalShip extends withTactics(ShipRuntime) {}