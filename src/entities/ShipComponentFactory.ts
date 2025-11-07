import { 
  IPowerSource, 
  IEngine, 
  ICargo,
  IEquipment,
  PowerSourceType,
  EngineType,
  CargoType,
  EquipmentType
} from './interfaces/ShipComponents';

/**
 * Фабрика для создания компонентов кораблей
 */
export class ShipComponentFactory {
  
  /**
   * Создать источник энергии
   */
  static createPowerSource(type: PowerSourceType): IPowerSource {
    const configs: Record<PowerSourceType, IPowerSource> = {
      [PowerSourceType.SOLAR]: {
        name: 'Солнечные панели',
        cost: 1000,
        weight: 50,
        energyCapacity: 100,
        energyOutput: 5,
        currentEnergy: 100
      },
      [PowerSourceType.NUCLEAR]: {
        name: 'Ядерный реактор',
        cost: 5000,
        weight: 200,
        energyCapacity: 500,
        energyOutput: 20,
        currentEnergy: 500
      },
      [PowerSourceType.FUSION]: {
        name: 'Термоядерный реактор',
        cost: 15000,
        weight: 300,
        energyCapacity: 1500,
        energyOutput: 50,
        currentEnergy: 1500
      }
    };
    
    return configs[type];
  }
  
  /**
   * Создать двигатель
   */
  static createEngine(type: EngineType): IEngine {
    const configs: Record<EngineType, IEngine> = {
      [EngineType.CHEMICAL]: {
        name: 'Химический двигатель',
        cost: 800,
        weight: 100,
        thrust: 50,
        energyConsumption: 2,
        maxSpeed: 100
      },
      [EngineType.ION]: {
        name: 'Ионный двигатель',
        cost: 3000,
        weight: 150,
        thrust: 100,
        energyConsumption: 5,
        maxSpeed: 200
      },
      [EngineType.PLASMA]: {
        name: 'Плазменный двигатель',
        cost: 10000,
        weight: 250,
        thrust: 250,
        energyConsumption: 15,
        maxSpeed: 400
      }
    };
    
    return configs[type];
  }
  
  /**
   * Создать грузовой отсек
   */
  static createCargoHold(type: CargoType): ICargo {
    const configs: Record<CargoType, ICargo> = {
      [CargoType.BASIC]: {
        name: 'Базовый грузовой отсек',
        cost: 500,
        weight: 80,
        capacity: 100,
        usedSpace: 0,
        maxWeight: 50,
        currentWeight: 0
      },
      [CargoType.REINFORCED]: {
        name: 'Укрепленный грузовой отсек',
        cost: 2000,
        weight: 150,
        capacity: 250,
        usedSpace: 0,
        maxWeight: 150,
        currentWeight: 0
      },
      [CargoType.ADVANCED]: {
        name: 'Продвинутый грузовой отсек',
        cost: 8000,
        weight: 200,
        capacity: 500,
        usedSpace: 0,
        maxWeight: 300,
        currentWeight: 0
      }
    };
    
    return configs[type];
  }
  
  /**
   * Создать оборудование
   */
  static createEquipment(type: EquipmentType, level: number = 1): IEquipment {
    const baseConfigs = {
      [EquipmentType.WEAPON]: {
        name: `Лазерное орудие Mk${level}`,
        type: EquipmentType.WEAPON,
        slotsRequired: 2,
        weight: 30 * level,
        cost: 2000 * level,
        description: 'Боевое орудие для защиты и атаки',
        effect: { damage: 50 * level, range: 100 * level }
      },
      [EquipmentType.SHIELD]: {
        name: `Энергощит Mk${level}`,
        type: EquipmentType.SHIELD,
        slotsRequired: 3,
        weight: 40 * level,
        cost: 3000 * level,
        description: 'Защитное силовое поле',
        effect: { protection: 100 * level, regenRate: 5 * level }
      },
      [EquipmentType.SCANNER]: {
        name: `Сканер Mk${level}`,
        type: EquipmentType.SCANNER,
        slotsRequired: 1,
        weight: 10 * level,
        cost: 1500 * level,
        description: 'Сканер для обнаружения объектов',
        effect: { range: 200 * level, accuracy: 80 + (level * 5) }
      },
      [EquipmentType.MINING]: {
        name: `Добывающий модуль Mk${level}`,
        type: EquipmentType.MINING,
        slotsRequired: 4,
        weight: 60 * level,
        cost: 4000 * level,
        description: 'Оборудование для добычи ресурсов',
        effect: { miningSpeed: 10 * level, efficiency: 70 + (level * 10) }
      },
      [EquipmentType.REPAIR]: {
        name: `Ремонтный модуль Mk${level}`,
        type: EquipmentType.REPAIR,
        slotsRequired: 2,
        weight: 25 * level,
        cost: 2500 * level,
        description: 'Автоматический ремонт корпуса',
        effect: { repairRate: 5 * level }
      },
      [EquipmentType.CARGO_EXPANSION]: {
        name: `Расширение грузового отсека Mk${level}`,
        type: EquipmentType.CARGO_EXPANSION,
        slotsRequired: 2,
        weight: 20 * level,
        cost: 1000 * level,
        description: 'Увеличивает вместимость грузового отсека',
        effect: { bonusCapacity: 50 * level }
      }
    };
    
    return {
      id: `${type}_${level}_${Date.now()}`,
      ...baseConfigs[type]
    };
  }
  
  /**
   * Получить список всех доступных источников энергии
   */
  static getAllPowerSources(): IPowerSource[] {
    return [
      this.createPowerSource(PowerSourceType.SOLAR),
      this.createPowerSource(PowerSourceType.NUCLEAR),
      this.createPowerSource(PowerSourceType.FUSION)
    ];
  }
  
  /**
   * Получить список всех доступных двигателей
   */
  static getAllEngines(): IEngine[] {
    return [
      this.createEngine(EngineType.CHEMICAL),
      this.createEngine(EngineType.ION),
      this.createEngine(EngineType.PLASMA)
    ];
  }
  
  /**
   * Получить список всех доступных грузовых отсеков
   */
  static getAllCargoHolds(): ICargo[] {
    return [
      this.createCargoHold(CargoType.BASIC),
      this.createCargoHold(CargoType.REINFORCED),
      this.createCargoHold(CargoType.ADVANCED)
    ];
  }
}
