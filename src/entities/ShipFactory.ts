import { Ship } from './Ship';
import { DesignedShip } from './DesignedShip';
import { ShipComponentFactory } from './ShipComponentFactory';
import { PowerSourceType, EngineType, CargoType, EquipmentType } from './interfaces/ShipComponents';
import { createCivilianDesign } from '../domain/civilianPresets';
import { createCombatDesign } from '../domain/combatPresets';
import { newId } from '../domain/shipDesign';

export class ShipFactory {
  static createScout(): DesignedShip {
    return new DesignedShip(createCivilianDesign('scout'), 'neutral', 'flight');
  }

  static createFreighter(): DesignedShip {
    return new DesignedShip(createCivilianDesign('freighter'), 'neutral', 'flight');
  }

  static createWarship(): DesignedShip {
    return new DesignedShip(createCombatDesign('cruiser'), 'neutral');
  }

  // Mining is not yet represented by the canonical component schema. Keep it explicit, not silently dropped.
  static createMiner(): Ship {
    const ship = ShipFactory.createCustomShip('Добытчик', PowerSourceType.NUCLEAR, EngineType.ION, CargoType.REINFORCED);
    const module = ShipComponentFactory.createEquipment(EquipmentType.MINING, 1);
    if (!ship.installEquipment(module)) throw new Error('Недопустимая комплектация добытчика');
    return ship;
  }

  /** Legacy custom component API until service modules and component catalogues are migrated. */
  static createCustomShip(name: string, powerSourceType: PowerSourceType, engineType: EngineType, cargoType: CargoType): Ship {
    return new Ship(newId('custom'), name, ShipComponentFactory.createPowerSource(powerSourceType),
      ShipComponentFactory.createEngine(engineType), ShipComponentFactory.createCargoHold(cargoType));
  }
}
