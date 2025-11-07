import { Ship } from './Ship';
import { ShipComponentFactory } from './ShipComponentFactory';
import { PowerSourceType, EngineType, CargoType } from './interfaces/ShipComponents';

/**
 * Фабрика для создания готовых кораблей
 */
export class ShipFactory {
  
  /**
   * Создать легкий разведывательный корабль
   */
  static createScout(): Ship {
    const powerSource = ShipComponentFactory.createPowerSource(PowerSourceType.SOLAR);
    const engine = ShipComponentFactory.createEngine(EngineType.ION);
    const cargoHold = ShipComponentFactory.createCargoHold(CargoType.BASIC);
    
    return new Ship(
      `scout_${Date.now()}`,
      'Разведчик',
      powerSource,
      engine,
      cargoHold
    );
  }
  
  /**
   * Создать грузовой корабль
   */
  static createFreighter(): Ship {
    const powerSource = ShipComponentFactory.createPowerSource(PowerSourceType.NUCLEAR);
    const engine = ShipComponentFactory.createEngine(EngineType.CHEMICAL);
    const cargoHold = ShipComponentFactory.createCargoHold(CargoType.ADVANCED);
    
    return new Ship(
      `freighter_${Date.now()}`,
      'Грузовоз',
      powerSource,
      engine,
      cargoHold
    );
  }
  
  /**
   * Создать боевой корабль
   */
  static createWarship(): Ship {
    const powerSource = ShipComponentFactory.createPowerSource(PowerSourceType.FUSION);
    const engine = ShipComponentFactory.createEngine(EngineType.PLASMA);
    const cargoHold = ShipComponentFactory.createCargoHold(CargoType.REINFORCED);
    
    return new Ship(
      `warship_${Date.now()}`,
      'Крейсер',
      powerSource,
      engine,
      cargoHold
    );
  }
  
  /**
   * Создать добывающий корабль
   */
  static createMiner(): Ship {
    const powerSource = ShipComponentFactory.createPowerSource(PowerSourceType.NUCLEAR);
    const engine = ShipComponentFactory.createEngine(EngineType.ION);
    const cargoHold = ShipComponentFactory.createCargoHold(CargoType.REINFORCED);
    
    const ship = new Ship(
      `miner_${Date.now()}`,
      'Добытчик',
      powerSource,
      engine,
      cargoHold
    );
    
    // Устанавливаем добывающий модуль
    const miningEquipment = ShipComponentFactory.createEquipment('MINING' as any, 1);
    ship.installEquipment(miningEquipment);
    
    return ship;
  }
  
  /**
   * Создать пользовательский корабль
   */
  static createCustomShip(
    name: string,
    powerSourceType: PowerSourceType,
    engineType: EngineType,
    cargoType: CargoType
  ): Ship {
    const powerSource = ShipComponentFactory.createPowerSource(powerSourceType);
    const engine = ShipComponentFactory.createEngine(engineType);
    const cargoHold = ShipComponentFactory.createCargoHold(cargoType);
    
    return new Ship(
      `custom_${Date.now()}`,
      name,
      powerSource,
      engine,
      cargoHold
    );
  }
}
