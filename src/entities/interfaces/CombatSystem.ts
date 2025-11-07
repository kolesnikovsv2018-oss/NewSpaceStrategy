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
  range: number;             // Дальность атаки
  fireRate: number;          // Скорострельность (атак в секунду)
  accuracy: number;          // Точность (0-1)
  energyCost: number;        // Стоимость выстрела в энергии
  cooldown: number;          // Перезарядка
  currentCooldown: number;   // Текущее время до следующего выстрела
}

/**
 * Результат атаки
 */
export interface IAttackResult {
  hit: boolean;              // Попадание
  damage: number;            // Нанесенный урон
  shieldDamage: number;      // Урон по щиту
  hullDamage: number;        // Урон по корпусу
  critical: boolean;         // Критическое попадание
  evaded: boolean;           // Уклонение
}

/**
 * Сторона конфликта
 */
export interface IFaction {
  id: string;
  name: string;
  color: number;             // Цвет для визуализации
  ships: any[];              // Корабли фракции
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
    shipsDestroyed: number;
    damageDealt: number;
    damageTaken: number;
  }>;
}
