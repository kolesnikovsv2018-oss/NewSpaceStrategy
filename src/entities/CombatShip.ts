import { withTactics } from './TacticalShip';
import { Ship } from './Ship';
import { noDamageResult } from './interfaces/CombatSystem';
import { positiveFinite } from '../domain/runtimeNumbers';
import type { ICombatStats, IWeaponStats, IAttackResult, ICombatant } from './interfaces/CombatSystem';
import { IPowerSource, IEngine, ICargo, IEquipment, EquipmentType } from './interfaces/ShipComponents';

/**
 * Боевой корабль с возможностью сражаться
 */
export class CombatShip extends withTactics(Ship) {
  constructor(
    id: string,
    name: string,
    powerSource: IPowerSource,
    engine: IEngine,
    cargoHold: ICargo,
    factionId: string
  ) {
    super(id, name, powerSource, engine, cargoHold);
    this.factionId = factionId;
    this.state.weapons = [{ slotId: 'legacy-aggregate', cooldown: 0, ammo: null }];

    // Инициализация боевых характеристик на основе компонентов
    this.combatStats = this.initCombatStats();
    this.weaponStats = this.initWeaponStats();
  }

  override installEquipment(equipment: IEquipment): boolean {
    if (!super.installEquipment(equipment)) return false;
    this.recalculateEquipmentStats();
    return true;
  }

  override uninstallEquipment(equipmentId: string): boolean {
    if (!super.uninstallEquipment(equipmentId)) return false;
    this.recalculateEquipmentStats();
    return true;
  }

  /** Пересчёт не лечит корабль и не позволяет обойти перезарядку переустановкой. */
  private recalculateEquipmentStats(): void {
    const { currentHull, currentShield } = this.combatStats;
    const cooldown = this.weaponStats.currentCooldown;
    this.combatStats = this.initCombatStats();
    this.combatStats.currentHull = Math.min(currentHull, this.combatStats.maxHull);
    this.combatStats.currentShield = Math.min(currentShield, this.combatStats.maxShield);
    this.weaponStats = this.initWeaponStats();
    this.weaponStats.currentCooldown = cooldown;
  }

  /**
   * Инициализация боевых характеристик
   */
  private initCombatStats(): ICombatStats {
    // Базовые характеристики зависят от компонентов корабля
    const baseHull = 100 + this.cargoHold.capacity;
    const shields = this.equipment.filter(eq => eq.type === EquipmentType.SHIELD);
    const baseShield = this.powerSource.energyCapacity / 10
      + shields.reduce((total, eq) => total + (eq.effect?.protection ?? 0), 0);
    const shieldRegenRate = this.powerSource.energyOutput / 5
      + shields.reduce((total, eq) => total + (eq.effect?.regenRate ?? 0), 0);
    const baseArmor = this.cargoHold.weight / 10;
    const baseEvasion = Math.min(this.engine.maxSpeed / 1000, 0.3);

    return {
      maxHull: baseHull,
      currentHull: baseHull,
      maxShield: baseShield,
      currentShield: baseShield,
      shieldRegenRate,
      armor: baseArmor,
      evasion: baseEvasion
    };
  }

  /**
   * Инициализация характеристик оружия
   */
  private initWeaponStats(): IWeaponStats {
    // Базовое оружие зависит от источника энергии и установленного оборудования
    let baseDamage = 10;
    let baseRange = 200;
    let baseAccuracy = 0.7;
    let baseFireRate = 1;

    // Улучшаем характеристики если установлено оружие
    this.equipment.forEach(eq => {
      if (eq.type === EquipmentType.WEAPON && eq.effect) {
        baseDamage += eq.effect.damage || 0;
        baseRange += eq.effect.range || 0;
        baseAccuracy = Math.min(baseAccuracy + 0.1, 0.95);
        baseFireRate += 0.2;
      }
    });

    return {
      damage: baseDamage,
      range: baseRange,
      fireRate: baseFireRate,
      accuracy: baseAccuracy,
      energyCost: 5,
      cooldown: 1 / baseFireRate,
      currentCooldown: 0
    };
  }

  /**
   * Атаковать цель
   */
  getAttackAttemptsPerStep(): number { return 1; }

  attack(target: ICombatant): IAttackResult | null {
    // Проверяем, можем ли атаковать
    if (this.isDestroyed || target.isDestroyed) {
      return null;
    }

    // Проверяем перезарядку
    if (this.weaponStats.currentCooldown > 0) {
      return null;
    }

    // Проверяем дальность
    const distance = this.getDistanceTo(target);
    if (distance > this.weaponStats.range) {
      return null;
    }

    // Проверяем энергию
    if (!this.consumeEnergy(this.weaponStats.energyCost)) {
      return null;
    }

    // Запускаем перезарядку
    this.weaponStats.currentCooldown = this.weaponStats.cooldown;

    // Проверяем попадание
    const hitChance = this.weaponStats.accuracy * (1 - target.combatStats.evasion);
    const hit = Math.random() < hitChance;

    if (!hit) {
      return {
        hit: false,
        damage: 0,
        shieldDamage: 0,
        hullDamage: 0,
        critical: false,
        evaded: true
      };
    }

    // Вычисляем урон
    let damage = this.weaponStats.damage;

    // Шанс критического удара 10%
    const critical = Math.random() < 0.1;
    if (critical) {
      damage *= 2;
    }

    // Применяем урон к цели
    return target.takeDamage(damage, critical);
  }

  /**
   * Получить урон
   */
  takeDamage(damage: number, critical: boolean = false, _damageType?: 'beam' | 'projectile'): IAttackResult {
    if (!positiveFinite(damage) || this.isDestroyed) return noDamageResult();
    let remainingDamage = damage;
    let shieldDamage = 0;
    let hullDamage = 0;

    // Сначала урон по щиту
    if (this.combatStats.currentShield > 0) {
      shieldDamage = Math.min(remainingDamage, this.combatStats.currentShield);
      this.combatStats.currentShield -= shieldDamage;
      remainingDamage -= shieldDamage;
    }

    // Оставшийся урон по корпусу с учетом брони
    if (remainingDamage > 0) {
      const armorReduction = this.combatStats.armor / (this.combatStats.armor + 100);
      hullDamage = Math.min(remainingDamage * (1 - armorReduction), this.combatStats.currentHull);
      this.combatStats.currentHull -= hullDamage;

      // Проверяем уничтожение
      if (this.combatStats.currentHull <= 0) {
        this.combatStats.currentHull = 0;
        this.isDestroyed = true;
        this.stopMoving();
      }
    }

    return {
      hit: true,
      damage: shieldDamage + hullDamage,
      shieldDamage: shieldDamage,
      hullDamage: hullDamage,
      critical: critical,
      evaded: false
    };
  }

  /**
   * Обновление боевого корабля
   */
  update(deltaTime: number): void {
    if (this.isDestroyed || !positiveFinite(deltaTime)) return;
    super.update(deltaTime);

    // Восстанавливаем щит
    if (this.combatStats.currentShield < this.combatStats.maxShield) {
      this.combatStats.currentShield = Math.min(
        this.combatStats.currentShield + this.combatStats.shieldRegenRate * deltaTime,
        this.combatStats.maxShield
      );
    }

    // Уменьшаем перезарядку
    if (this.weaponStats.currentCooldown > 0) {
      this.weaponStats.currentCooldown = Math.max(0, this.weaponStats.currentCooldown - deltaTime);
    }
  }

}
