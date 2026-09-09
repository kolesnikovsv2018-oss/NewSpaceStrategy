export interface IShipComponent {
  name: string;
  cost: number;
  weight: number;
}

export interface IPowerSource extends IShipComponent {
  energyCapacity: number;    // Ёмкость батареи, ЭЕ (не стратегическое топливо)
  energyOutput: number;      // Генерация, ЭЕ/с симуляции
  currentEnergy: number;     // Текущий запас, ЭЕ
}

export interface IEngine extends IShipComponent {
  thrust: number;           // Тяга двигателя
  energyConsumption: number; // Мощность движения, ЭЕ/с симуляции
  maxSpeed: number;         // Тактические единицы расстояния / с
}

export interface ICargo extends IShipComponent {
  capacity: number;         // Максимальная вместимость в кубических метрах
  readonly usedSpace: number; // Вычисляется из партий груза
  maxWeight: number;       // Максимальный вес груза
  readonly currentWeight: number; // Вычисляется из груза и legacy-оборудования
}

// Перечисления для типов компонентов
export enum PowerSourceType {
  NUCLEAR = 'Nuclear Reactor',
  SOLAR = 'Solar Panels',
  FUSION = 'Fusion Reactor'
}

export enum EngineType {
  CHEMICAL = 'Chemical Engine',
  ION = 'Ion Engine',
  PLASMA = 'Plasma Engine'
}

export enum CargoType {
  BASIC = 'Basic Hold',
  REINFORCED = 'Reinforced Hold',
  ADVANCED = 'Advanced Hold',
  CAPITAL = 'Capital Hold'
}

/**
 * Оборудование для установки в грузовой отсек
 */
export interface IEquipment {
  id: string;
  name: string;
  type: EquipmentType;
  slotsRequired: number;   // Сколько слотов занимает
  weight: number;          // Вес
  cost: number;            // Стоимость
  description?: string;
  effect?: IEquipmentEffect;
}

// Типизированные эффекты текущей runtime-модели; объединение с Equipment — этап S2.
export interface IEquipmentEffect {
  damage?: number;
  range?: number;
  protection?: number;
  regenRate?: number;
  accuracy?: number;
  miningSpeed?: number;
  efficiency?: number;
  repairRate?: number;
  bonusCapacity?: number;
}

/**
 * Типы оборудования
 */
export enum EquipmentType {
  WEAPON = 'WEAPON',
  SHIELD = 'SHIELD',
  SCANNER = 'SCANNER',
  MINING = 'MINING',
  REPAIR = 'REPAIR',
  CARGO_EXPANSION = 'CARGO_EXPANSION'
}

/**
 * Груз в отсеке
 */
export interface ICargoItem {
  resourceType: string;
  amount: number;
  weight: number;
  volume: number;
}