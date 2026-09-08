import { Ship } from './Ship';
import { ICombatStats, IWeaponStats, IAttackResult } from './interfaces/CombatSystem';
import { IPowerSource, IEngine, ICargo, IEquipment, EquipmentType } from './interfaces/ShipComponents';

/**
 * Боевой корабль с возможностью сражаться
 */
export class CombatShip extends Ship {
  private combatStatsView!: ICombatStats;
  private weaponStatsView!: IWeaponStats;

  // Compatibility views: current values live only in ShipState, maxima/configuration stay here.
  get combatStats(): ICombatStats { return this.combatStatsView; }
  set combatStats(stats: ICombatStats) {
    const ship = this;
    const { currentHull, currentShield, ...configuration } = stats;
    this.state.hull = currentHull;
    this.state.shield = currentShield;
    this.combatStatsView = { ...configuration,
      get currentHull() { return ship.state.hull; },
      set currentHull(value: number) { ship.state.hull = value; },
      get currentShield() { return ship.state.shield; },
      set currentShield(value: number) { ship.state.shield = value; }
    };
  }

  get weaponStats(): IWeaponStats { return this.weaponStatsView; }
  set weaponStats(stats: IWeaponStats) {
    const ship = this;
    const { currentCooldown, ...configuration } = stats;
    this.state.weapons.forEach(weapon => { weapon.cooldown = currentCooldown; });
    this.weaponStatsView = { ...configuration,
      // Legacy has one entry; designed ships expose the slowest remaining cooldown in this summary.
      get currentCooldown() { return Math.max(0, ...ship.state.weapons.map(weapon => weapon.cooldown)); },
      set currentCooldown(value: number) { ship.state.weapons.forEach(weapon => { weapon.cooldown = value; }); }
    };
  }
  factionId: string;
  target?: CombatShip;
  get isDestroyed(): boolean { return this.state.isDestroyed; }
  set isDestroyed(value: boolean) { this.state.isDestroyed = value; }

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

  attack(target: CombatShip): IAttackResult | null {
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
   * Получить расстояние до цели
   */
  getDistanceTo(target: CombatShip): number {
    const dx = target.position.x - this.position.x;
    const dy = target.position.y - this.position.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Выбрать ближайшую вражескую цель
   */
  findNearestEnemy(enemies: CombatShip[]): CombatShip | undefined {
    let nearest: CombatShip | undefined;
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

  /**
   * Двигаться к цели
   */
  moveToTarget(target: CombatShip, optimalRange: number = 0.8): void {
    const distance = this.getDistanceTo(target);
    const targetDistance = this.weaponStats.range * optimalRange;

    // Если слишком далеко - приближаемся
    if (distance > targetDistance) {
      this.startMoving(target.position.x, target.position.y);
    }
    // Если слишком близко - отходим
    else if (distance < this.weaponStats.range * 0.5) {
      const dx = this.position.x - target.position.x;
      const dy = this.position.y - target.position.y;
      const angle = Math.atan2(dy, dx);
      const retreatX = this.position.x + Math.cos(angle) * 50;
      const retreatY = this.position.y + Math.sin(angle) * 50;
      this.startMoving(retreatX, retreatY);
    }
    // Оптимальная дистанция - останавливаемся
    else {
      this.stopMoving();
    }
  }

  /**
   * Обновление боевого корабля
   */
  update(deltaTime: number): void {
    if (this.isDestroyed) return;
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

  /**
   * Получить прочность корпуса в процентах
   */
  getHullPercent(): number {
    return (this.combatStats.currentHull / this.combatStats.maxHull) * 100;
  }

  /**
   * Получить прочность щита в процентах
   */
  getShieldPercent(): number {
    return this.combatStats.maxShield > 0 ? (this.combatStats.currentShield / this.combatStats.maxShield) * 100 : 0;
  }

  /**
   * Получить боевую информацию
   */
  getCombatInfo(): string {
    return `
${this.name} [${this.factionId}]
Корпус: ${this.combatStats.currentHull.toFixed(0)}/${this.combatStats.maxHull} (${this.getHullPercent().toFixed(0)}%)
Щит: ${this.combatStats.currentShield.toFixed(0)}/${this.combatStats.maxShield} (${this.getShieldPercent().toFixed(0)}%)
Броня: ${this.combatStats.armor.toFixed(1)}
Урон: ${this.weaponStats.damage}
Дальность: ${this.weaponStats.range}
Статус: ${this.isDestroyed ? '💀 Уничтожен' : '✓ Активен'}
    `.trim();
  }
}
