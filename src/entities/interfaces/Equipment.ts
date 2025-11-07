/**
 * Интерфейсы для оборудования кораблей
 */

/**
 * Базовый интерфейс для любого оборудования
 */
export interface IEquipment {
  id: string;
  name: string;
  description: string;
  mass: number;           // Масса в тоннах
  powerConsumption: number; // Потребление энергии
  cost: number;           // Стоимость
  rarity: EquipmentRarity;
  manufacturer?: string;
}

/**
 * Редкость оборудования
 */
export enum EquipmentRarity {
  Common = 'common',
  Uncommon = 'uncommon',
  Rare = 'rare',
  Epic = 'epic',
  Legendary = 'legendary'
}

/**
 * Тип слота для оборудования
 */
export enum EquipmentSlotType {
  Weapon = 'weapon',
  ProjectileWeapon = 'projectileWeapon',
  Engine = 'engine',
  Shield = 'shield',
  Armor = 'armor',
  Sensor = 'sensor',
  Computer = 'computer',
  PowerCore = 'powerCore',
  Cargo = 'cargo',
  Special = 'special'
}

/**
 * Размер слота
 */
export enum SlotSize {
  Small = 'small',
  Medium = 'medium',
  Large = 'large',
  Capital = 'capital'
}

/**
 * Тип оружия
 */
export enum WeaponType {
  Beam = 'beam',        // Лучевое оружие (потребляет энергию)
  Projectile = 'projectile' // Оружие со снарядами
}

/**
 * Характеристики снаряда
 */
export interface IProjectile {
  damage: number;       // Урон снаряда (редактируемое)
  range: number;        // Дальность снаряда (редактируемое)
  mass: number;         // Масса снаряда (вычисляемое)
  size: number;         // Размер снаряда (вычисляемое)
}

/**
 * Базовый интерфейс оружия
 */
export interface IWeaponBase extends IEquipment {
  weaponType: WeaponType;
  fireRate: number;      // Выстрелов в секунду
  accuracy: number;      // 0-1
  slotSize: SlotSize;
}

/**
 * Лучевое оружие (потребляет энергию напрямую)
 */
export interface IBeamWeapon extends IWeaponBase {
  weaponType: WeaponType.Beam;
  damage: number;        // Урон (редактируемое)
  range: number;         // Дальность (редактируемое)
  energyConsumption: number; // Потребление энергии (вычисляемое)
}

/**
 * Оружие со снарядами
 */
export interface IProjectileWeapon extends IWeaponBase {
  weaponType: WeaponType.Projectile;
  projectile: IProjectile; // Характеристики снаряда
  ammoCapacity: number;    // Запас зарядов (редактируемое)
  energyPerShot: number;   // Энергия на выстрел (вычисляемое)
}

/**
 * Объединенный тип оружия
 */
export type IWeapon = IBeamWeapon | IProjectileWeapon;

/**
 * Эффекты оружия (пока не используется)
 */
export enum WeaponEffect {
  ArmorPiercing = 'armorPiercing',
  ShieldPenetration = 'shieldPenetration',
  EMP = 'emp',
  Fire = 'fire',
  Explosive = 'explosive'
}

/**
 * Двигатель
 */
export interface IEngine extends IEquipment {
  thrust: number;        // Тяга
  maxSpeed: number;      // Максимальная скорость
  maneuverability: number; // Маневренность (0-1)
  fuelConsumption: number; // Расход топлива (вычисляемое)
  powerGeneration: number; // Вырабатываемая энергия (редактируемое)
  slotSize: SlotSize;
  engineType: EngineType;
}

/**
 * Тип двигателя
 */
export enum EngineType {
  Ion = 'ion',
  Fusion = 'fusion',
  Antimatter = 'antimatter',
  Warp = 'warp',
  Chemical = 'chemical'
}

/**
 * Щит (защита от лучевого оружия)
 */
export interface IShield extends IEquipment {
  capacity: number;      // Максимальная емкость щита
  rechargeRate: number;  // Скорость восстановления
  rechargeDelay: number; // Задержка перед восстановлением (сек)
  beamResistance: number; // Сопротивление лучевому оружию (0-1), уменьшает урон
  slotSize: SlotSize;
}

/**
 * Броня (защита от всех типов урона)
 */
export interface IArmor extends IEquipment {
  armorPoints: number;   // Очки брони
  beamResistance: number; // Сопротивление лучевому оружию (0-1)
  projectileResistance: number; // Сопротивление снарядам (0-1)
  durability: number;    // Прочность
  repairRate: number;    // Скорость самовосстановления
}

/**
 * Сопротивление щита разным типам урона (устарело, но оставлено для совместимости)
 */
export interface ShieldResistance {
  kinetic: number;       // 0-1
  energy: number;        // 0-1
  explosive: number;     // 0-1
}

/**
 * Сопротивление брони (устарело, но оставлено для совместимости)
 */
export interface ArmorResistance {
  kinetic: number;
  energy: number;
  explosive: number;
}

/**
 * Сенсор
 */
export interface ISensor extends IEquipment {
  range: number;         // Дальность обнаружения
  accuracy: number;      // Точность (0-1)
  scanSpeed: number;     // Скорость сканирования
  stealthDetection: number; // Обнаружение скрытых объектов (0-1)
  slotSize: SlotSize;
}

/**
 * Компьютер (управляющая система)
 */
export interface IComputer extends IEquipment {
  processingPower: number; // Вычислительная мощность
  targetingBonus: number;  // Бонус к точности оружия
  evasionBonus: number;    // Бонус к уклонению
  commandSlots: number;    // Количество одновременных команд
  slotSize: SlotSize;
}

/**
 * Энергетическое ядро
 */
export interface IPowerCore extends IEquipment {
  maxPower: number;      // Максимальная выходная мощность
  efficiency: number;    // Эффективность (0-1)
  overloadCapacity: number; // Возможность перегрузки
  slotSize: SlotSize;
}

/**
 * Грузовой отсек
 */
export interface ICargoHold extends IEquipment {
  capacity: number;      // Вместимость в тоннах
  specialization?: CargoType; // Специализация
  refrigerated: boolean; // Рефрижератор
  protected: boolean;    // Защищенный
}

/**
 * Тип груза
 */
export enum CargoType {
  General = 'general',
  Liquid = 'liquid',
  Gas = 'gas',
  Hazardous = 'hazardous',
  Passengers = 'passengers',
  Military = 'military'
}

/**
 * Слот для установки оборудования
 */
export interface IEquipmentSlot {
  id: string;
  type: EquipmentSlotType;
  size: SlotSize;
  equipment?: IEquipment;
  locked: boolean;       // Заблокирован ли слот
  position?: { x: number; y: number }; // Позиция на схеме корабля
}

/**
 * Конфигурация корабля (компоновка оборудования)
 */
export interface IShipConfiguration {
  id: string;
  name: string;
  description: string;
  hullType: string;      // Тип корпуса
  hull: IHull;           // Характеристики корпуса
  slots: IEquipmentSlot[];
  totalMass: number;
  totalPowerConsumption: number;
  created: Date;
  modified: Date;
}

/**
 * Корпус корабля
 */
export interface IHull {
  size: HullSize;        // Размер корпуса
  structuralIntegrity: number; // Прочность корпуса
  maxHitPoints: number;  // Максимальный урон до уничтожения (вычисляется из size и structuralIntegrity)
}

/**
 * Размер корпуса
 */
export enum HullSize {
  Fighter = 'fighter',       // Истребитель (малый)
  Corvette = 'corvette',     // Корвет (средний)
  Frigate = 'frigate',       // Фрегат (большой)
  Destroyer = 'destroyer',   // Эсминец (очень большой)
  Cruiser = 'cruiser',       // Крейсер (огромный)
  Battleship = 'battleship'  // Линкор (гигантский)
}

/**
 * Пресет оборудования
 */
export interface IEquipmentPreset {
  id: string;
  name: string;
  description: string;
  category: EquipmentSlotType;
  equipment: IEquipment[];
  tags: string[];
}
