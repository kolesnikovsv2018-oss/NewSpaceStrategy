import { CombatShip } from './CombatShip';
import { ShipComponentFactory } from './ShipComponentFactory';
import { PowerSourceType, EngineType, CargoType, EquipmentType } from './interfaces/ShipComponents';

/**
 * Фабрика для создания боевых кораблей
 */
export class CombatShipFactory {
  
  /**
   * Создать легкий истребитель
   */
  static createFighter(factionId: string, index: number = 0): CombatShip {
    const powerSource = ShipComponentFactory.createPowerSource(PowerSourceType.SOLAR);
    const engine = ShipComponentFactory.createEngine(EngineType.ION);
    const cargoHold = ShipComponentFactory.createCargoHold(CargoType.BASIC);
    
    const ship = new CombatShip(
      `fighter_${factionId}_${index}_${Date.now()}`,
      `Истребитель-${index + 1}`,
      powerSource,
      engine,
      cargoHold,
      factionId
    );

    // Легкое вооружение
    const weapon = ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 1);
    ship.installEquipment(weapon);

    return ship;
  }

  /**
   * Создать тяжелый крейсер
   */
  static createCruiser(factionId: string, index: number = 0): CombatShip {
    const powerSource = ShipComponentFactory.createPowerSource(PowerSourceType.FUSION);
    const engine = ShipComponentFactory.createEngine(EngineType.PLASMA);
    const cargoHold = ShipComponentFactory.createCargoHold(CargoType.REINFORCED);
    
    const ship = new CombatShip(
      `cruiser_${factionId}_${index}_${Date.now()}`,
      `Крейсер-${index + 1}`,
      powerSource,
      engine,
      cargoHold,
      factionId
    );

    // Мощное вооружение и щиты
    const weapon1 = ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 2);
    const weapon2 = ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 2);
    const shield = ShipComponentFactory.createEquipment(EquipmentType.SHIELD, 2);
    
    ship.installEquipment(weapon1);
    ship.installEquipment(weapon2);
    ship.installEquipment(shield);

    return ship;
  }

  /**
   * Создать фрегат (средний корабль)
   */
  static createFrigate(factionId: string, index: number = 0): CombatShip {
    const powerSource = ShipComponentFactory.createPowerSource(PowerSourceType.NUCLEAR);
    const engine = ShipComponentFactory.createEngine(EngineType.ION);
    const cargoHold = ShipComponentFactory.createCargoHold(CargoType.REINFORCED);
    
    const ship = new CombatShip(
      `frigate_${factionId}_${index}_${Date.now()}`,
      `Фрегат-${index + 1}`,
      powerSource,
      engine,
      cargoHold,
      factionId
    );

    // Сбалансированное вооружение
    const weapon = ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 2);
    const shield = ShipComponentFactory.createEquipment(EquipmentType.SHIELD, 1);
    
    ship.installEquipment(weapon);
    ship.installEquipment(shield);

    return ship;
  }

  /**
   * Создать дредноут (супер тяжелый корабль)
   */
  static createDreadnought(factionId: string, index: number = 0): CombatShip {
    const powerSource = ShipComponentFactory.createPowerSource(PowerSourceType.FUSION);
    const engine = ShipComponentFactory.createEngine(EngineType.PLASMA);
    const cargoHold = ShipComponentFactory.createCargoHold(CargoType.ADVANCED);
    
    const ship = new CombatShip(
      `dreadnought_${factionId}_${index}_${Date.now()}`,
      `Дредноут-${index + 1}`,
      powerSource,
      engine,
      cargoHold,
      factionId
    );

    // Максимальное вооружение
    const weapon1 = ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 3);
    const weapon2 = ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 3);
    const weapon3 = ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 2);
    const shield = ShipComponentFactory.createEquipment(EquipmentType.SHIELD, 3);
    const repair = ShipComponentFactory.createEquipment(EquipmentType.REPAIR, 2);
    
    ship.installEquipment(weapon1);
    ship.installEquipment(weapon2);
    ship.installEquipment(weapon3);
    ship.installEquipment(shield);
    ship.installEquipment(repair);

    return ship;
  }

  /**
   * Создать эскадрилью истребителей
   */
  static createFighterSquadron(factionId: string, count: number): CombatShip[] {
    const ships: CombatShip[] = [];
    for (let i = 0; i < count; i++) {
      ships.push(this.createFighter(factionId, i));
    }
    return ships;
  }

  /**
   * Создать флот
   */
  static createFleet(
    factionId: string,
    composition: {
      fighters?: number;
      frigates?: number;
      cruisers?: number;
      dreadnoughts?: number;
    }
  ): CombatShip[] {
    const fleet: CombatShip[] = [];

    // Добавляем истребители
    if (composition.fighters) {
      for (let i = 0; i < composition.fighters; i++) {
        fleet.push(this.createFighter(factionId, i));
      }
    }

    // Добавляем фрегаты
    if (composition.frigates) {
      for (let i = 0; i < composition.frigates; i++) {
        fleet.push(this.createFrigate(factionId, i));
      }
    }

    // Добавляем крейсеры
    if (composition.cruisers) {
      for (let i = 0; i < composition.cruisers; i++) {
        fleet.push(this.createCruiser(factionId, i));
      }
    }

    // Добавляем дредноуты
    if (composition.dreadnoughts) {
      for (let i = 0; i < composition.dreadnoughts; i++) {
        fleet.push(this.createDreadnought(factionId, i));
      }
    }

    return fleet;
  }

  /**
   * Создать случайный корабль
   */
  static createRandomShip(factionId: string): CombatShip {
    const random = Math.random();
    
    if (random < 0.4) {
      return this.createFighter(factionId);
    } else if (random < 0.7) {
      return this.createFrigate(factionId);
    } else if (random < 0.95) {
      return this.createCruiser(factionId);
    } else {
      return this.createDreadnought(factionId);
    }
  }

  /**
   * Создать случайный флот
   */
  static createRandomFleet(factionId: string, shipCount: number): CombatShip[] {
    const fleet: CombatShip[] = [];
    for (let i = 0; i < shipCount; i++) {
      fleet.push(this.createRandomShip(factionId));
    }
    return fleet;
  }
}
