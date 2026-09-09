import {
  type IPowerSource, type IEngine, type ICargo, type IEquipment,
  PowerSourceType, EngineType, CargoType, EquipmentType
} from '../entities/interfaces/ShipComponents';
import { legacyCargoTypeSchema, legacyEngineTypeSchema, legacyEquipmentLevelSchema,
  legacyEquipmentTypeSchema, legacyPowerTypeSchema } from './legacyShipConfig';

/** Frozen legacy formulas: not canonical ComponentDefinition builders or a migration to ShipDesign. */
export class LegacyShipComponentFactory {
  private static equipmentSequence = 0;

  static createPowerSource(type: PowerSourceType): IPowerSource {
    const parsed = legacyPowerTypeSchema.parse(type);
    const configs: Record<PowerSourceType, IPowerSource> = {
      [PowerSourceType.SOLAR]: { name: 'Солнечные панели', cost: 1000, weight: 50,
        energyCapacity: 100, energyOutput: 5, currentEnergy: 100 },
      [PowerSourceType.NUCLEAR]: { name: 'Ядерный реактор', cost: 5000, weight: 200,
        energyCapacity: 500, energyOutput: 20, currentEnergy: 500 },
      [PowerSourceType.FUSION]: { name: 'Термоядерный реактор', cost: 15000, weight: 300,
        energyCapacity: 1500, energyOutput: 50, currentEnergy: 1500 }
    };
    return configs[parsed];
  }

  static createEngine(type: EngineType): IEngine {
    const parsed = legacyEngineTypeSchema.parse(type);
    const configs: Record<EngineType, IEngine> = {
      [EngineType.CHEMICAL]: { name: 'Химический двигатель', cost: 800, weight: 100,
        thrust: 50, energyConsumption: 2, maxSpeed: 100 },
      [EngineType.ION]: { name: 'Ионный двигатель', cost: 3000, weight: 150,
        thrust: 100, energyConsumption: 5, maxSpeed: 200 },
      [EngineType.PLASMA]: { name: 'Плазменный двигатель', cost: 10000, weight: 250,
        thrust: 250, energyConsumption: 15, maxSpeed: 400 }
    };
    return configs[parsed];
  }

  static createCargoHold(type: CargoType): ICargo {
    const parsed = legacyCargoTypeSchema.parse(type);
    const configs: Record<CargoType, ICargo> = {
      [CargoType.BASIC]: { name: 'Базовый грузовой отсек', cost: 500, weight: 80,
        capacity: 100, usedSpace: 0, maxWeight: 50, currentWeight: 0 },
      [CargoType.REINFORCED]: { name: 'Укрепленный грузовой отсек', cost: 2000, weight: 150,
        capacity: 250, usedSpace: 0, maxWeight: 150, currentWeight: 0 },
      [CargoType.ADVANCED]: { name: 'Продвинутый грузовой отсек', cost: 8000, weight: 200,
        capacity: 500, usedSpace: 0, maxWeight: 300, currentWeight: 0 },
      [CargoType.CAPITAL]: { name: 'Тяжёлый грузовой отсек', cost: 12000, weight: 300,
        capacity: 750, usedSpace: 0, maxWeight: 450, currentWeight: 0 }
    };
    return configs[parsed];
  }

  static createEquipment(type: EquipmentType, level = 1): IEquipment {
    const parsedType = legacyEquipmentTypeSchema.parse(type);
    const parsedLevel = legacyEquipmentLevelSchema.parse(level);
    const configs: Record<EquipmentType, Omit<IEquipment, 'id'>> = {
      [EquipmentType.WEAPON]: { name: `Лазерное орудие Mk${parsedLevel}`, type: EquipmentType.WEAPON,
        slotsRequired: 2, weight: 30 * parsedLevel, cost: 2000 * parsedLevel,
        description: 'Боевое орудие для защиты и атаки', effect: { damage: 50 * parsedLevel, range: 100 * parsedLevel } },
      [EquipmentType.SHIELD]: { name: `Энергощит Mk${parsedLevel}`, type: EquipmentType.SHIELD,
        slotsRequired: 3, weight: 40 * parsedLevel, cost: 3000 * parsedLevel,
        description: 'Защитное силовое поле', effect: { protection: 100 * parsedLevel, regenRate: 5 * parsedLevel } },
      [EquipmentType.SCANNER]: { name: `Сканер Mk${parsedLevel}`, type: EquipmentType.SCANNER,
        slotsRequired: 1, weight: 10 * parsedLevel, cost: 1500 * parsedLevel,
        description: 'Сканер для обнаружения объектов', effect: { range: 200 * parsedLevel, accuracy: 80 + parsedLevel * 5 } },
      [EquipmentType.MINING]: { name: `Добывающий модуль Mk${parsedLevel}`, type: EquipmentType.MINING,
        slotsRequired: 4, weight: 60 * parsedLevel, cost: 4000 * parsedLevel,
        description: 'Оборудование для добычи ресурсов', effect: { miningSpeed: 10 * parsedLevel, efficiency: 70 + parsedLevel * 10 } },
      [EquipmentType.REPAIR]: { name: `Ремонтный модуль Mk${parsedLevel}`, type: EquipmentType.REPAIR,
        slotsRequired: 2, weight: 25 * parsedLevel, cost: 2500 * parsedLevel,
        description: 'Автоматический ремонт корпуса', effect: { repairRate: 5 * parsedLevel } },
      [EquipmentType.CARGO_EXPANSION]: { name: `Расширение грузового отсека Mk${parsedLevel}`, type: EquipmentType.CARGO_EXPANSION,
        slotsRequired: 2, weight: 20 * parsedLevel, cost: 1000 * parsedLevel,
        description: 'Увеличивает вместимость грузового отсека', effect: { bonusCapacity: 50 * parsedLevel } }
    };
    return { id: `${parsedType}_${parsedLevel}_${Date.now()}_${++this.equipmentSequence}`, ...configs[parsedType] };
  }

  static getAllPowerSources(): IPowerSource[] {
    return [PowerSourceType.SOLAR, PowerSourceType.NUCLEAR, PowerSourceType.FUSION].map(type => this.createPowerSource(type));
  }

  static getAllEngines(): IEngine[] {
    return [EngineType.CHEMICAL, EngineType.ION, EngineType.PLASMA].map(type => this.createEngine(type));
  }

  static getAllCargoHolds(): ICargo[] {
    return [CargoType.BASIC, CargoType.REINFORCED, CargoType.ADVANCED, CargoType.CAPITAL].map(type => this.createCargoHold(type));
  }
}