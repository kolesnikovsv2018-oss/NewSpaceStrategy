export interface IShipComponent {
  name: string;
  cost: number;
  weight: number;
}

export interface IPowerSource extends IShipComponent {
  energyCapacity: number;    // Максимальный запас энергии
  energyOutput: number;      // Выработка энергии в единицу времени
  currentEnergy: number;     // Текущий запас энергии
}

export interface IEngine extends IShipComponent {
  thrust: number;           // Тяга двигателя
  energyConsumption: number; // Потребление энергии
  maxSpeed: number;         // Максимальная скорость
}

export interface ICargo extends IShipComponent {
  capacity: number;         // Максимальная вместимость в кубических метрах
  usedSpace: number;       // Занятое пространство
  maxWeight: number;       // Максимальный вес груза
  currentWeight: number;   // Текущий вес груза
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
  ADVANCED = 'Advanced Hold'
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
  effect?: any;            // Эффект от оборудования
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