import type { ShipView } from './ShipView';

/**
 * Боевые характеристики корабля
 */
export interface ICombatStats {
  maxHull: number;           // Максимальная прочность корпуса
  currentHull: number;       // Текущая прочность корпуса
  maxShield: number;         // Максимальная прочность щита
  currentShield: number;     // Текущая прочность щита
  shieldRegenRate: number;   // Скорость восстановления щита
  armor: number;             // Броня (снижает урон)
  evasion: number;           // Уклонение (шанс избежать урона)
}

/**
 * Характеристики оружия
 */
export interface IWeaponStats {
  damage: number;            // Базовый урон
  range: number;             // Дальность атаки, тактические единицы
  fireRate: number;          // Скорострельность (атак в секунду)
  accuracy: number;          // Точность (0-1)
  energyCost: number;        // Энергия одного выстрела, ЭЕ
  cooldown: number;          // Перезарядка, секунды симуляции
  currentCooldown: number;   // Остаток перезарядки, секунды симуляции
}

/**
 * Результат атаки
 */
export interface IAttackResult {
  hit: boolean;              // Попадание
  damage: number;            // Фактически снятые щиты + HP, без брони и overkill
  shieldDamage: number;      // Урон по щиту
  hullDamage: number;        // Урон по корпусу
  critical: boolean;         // Критическое попадание
  evaded: boolean;           // Уклонение
}

/** Rejected/zero damage is neither a hit nor an evasion and must not alter combat state. */
export function noDamageResult(): IAttackResult {
  return { hit: false, damage: 0, shieldDamage: 0, hullDamage: 0, critical: false, evaded: false };
}

/**
 * Сторона конфликта
 */
export interface ICombatant extends ShipView {
  factionId: string;
  target?: ICombatant;
  isDestroyed: boolean;
  combatStats: ICombatStats;
  weaponStats: IWeaponStats;
  getCombatInfo(): string;
  update(deltaTime: number): void;
  getAttackAttemptsPerStep(): number;
  attack(target: ICombatant): IAttackResult | null;
  takeDamage(damage: number, critical?: boolean, damageType?: 'beam' | 'projectile'): IAttackResult;
  findNearestEnemy(enemies: readonly ICombatant[]): ICombatant | undefined;
  moveToTarget(target: ICombatant, optimalRange?: number): void;
}

export interface IFaction {
  id: string;
  name: string;
  color: number;             // Цвет для визуализации
  ships: ICombatant[];       // Любые реализации боевого контракта, не конкретный класс
}

/**
 * Конфигурация боя
 */
export interface IBattleConfig {
  factions: IFaction[];      // Стороны конфликта
  battlefieldWidth: number;  // Ширина поля боя
  battlefieldHeight: number; // Высота поля боя
  autoTarget: boolean;       // Автоматический выбор целей
  friendlyFire: boolean;     // Дружественный огонь
}

/**
 * Статистика боя
 */
export interface IBattleStats {
  startTime: number;
  duration: number;
  totalShips: number;
  shipsDestroyed: number;
  totalDamage: number;
  factionStats: Map<string, {
    shipsAlive: number;
    shipsDestroyed: number; // Собственные потери
    kills: number;          // Уничтоженные противники
    damageDealt: number;
    damageTaken: number;
  }>;
}

/** Снимки позиций не меняются после шага симуляции. */
export interface IBattlePosition {
  x: number;
  y: number;
}

export type BattleEvent =
  | {
    type: 'WeaponFired';
    attackerId: string;
    targetId: string;
    from: IBattlePosition;
    to: IBattlePosition;
    hit: boolean;
  }
  | {
    type: 'ShipDestroyed';
    shipId: string;
    position: IBattlePosition;
  };
