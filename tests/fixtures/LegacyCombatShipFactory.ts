import { CombatShip } from '../../src/entities/CombatShip';
import { ShipComponentFactory } from '../../src/entities/ShipComponentFactory';
import { PowerSourceType, EngineType, CargoType, EquipmentType } from '../../src/entities/interfaces/ShipComponents';

/** Historical S1 loadouts, kept only to test the still-supported legacy model/refitting API. */
export class LegacyCombatShipFactory {
  private static sequence = 0;

  private static build(name: string, faction: string, index: number, power: PowerSourceType,
    engine: EngineType, cargo: CargoType, modules: Array<[EquipmentType, number]>): CombatShip {
    const ship = new CombatShip(`legacy_${Date.now()}_${++this.sequence}`, `${name}-${index + 1}`,
      ShipComponentFactory.createPowerSource(power), ShipComponentFactory.createEngine(engine),
      ShipComponentFactory.createCargoHold(cargo), faction);
    for (const [kind, tier] of modules) {
      const item = ShipComponentFactory.createEquipment(kind, tier);
      if (!ship.installEquipment(item)) throw new Error(`Недопустимая комплектация ${ship.name}: ${item.name}`);
    }
    ship.combatStats.currentShield = ship.combatStats.maxShield;
    return ship;
  }

  static createFighter(faction: string, index = 0): CombatShip {
    return LegacyCombatShipFactory.build('Истребитель', faction, index, PowerSourceType.SOLAR, EngineType.ION, CargoType.BASIC,
      [[EquipmentType.WEAPON, 1]]);
  }
  static createFrigate(faction: string, index = 0): CombatShip {
    return LegacyCombatShipFactory.build('Фрегат', faction, index, PowerSourceType.NUCLEAR, EngineType.ION, CargoType.REINFORCED,
      [[EquipmentType.WEAPON, 2], [EquipmentType.SHIELD, 1]]);
  }
  static createCruiser(faction: string, index = 0): CombatShip {
    return LegacyCombatShipFactory.build('Крейсер', faction, index, PowerSourceType.FUSION, EngineType.PLASMA, CargoType.ADVANCED,
      [[EquipmentType.WEAPON, 2], [EquipmentType.WEAPON, 2], [EquipmentType.SHIELD, 2]]);
  }
  static createDreadnought(faction: string, index = 0): CombatShip {
    return LegacyCombatShipFactory.build('Дредноут', faction, index, PowerSourceType.FUSION, EngineType.PLASMA, CargoType.CAPITAL,
      [[EquipmentType.WEAPON, 3], [EquipmentType.WEAPON, 3], [EquipmentType.WEAPON, 2], [EquipmentType.SHIELD, 3], [EquipmentType.REPAIR, 2]]);
  }
}
