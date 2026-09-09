import { Ship } from '../entities/Ship';
import type { CargoType, EngineType, PowerSourceType } from '../entities/interfaces/ShipComponents';
import { newId } from '../domain/shipDesign';
import { LegacyShipComponentFactory } from './LegacyShipComponentFactory';
import { legacyShipConfigSchema } from './legacyShipConfig';

/** Explicit compatibility boundary. Preserves old numerical configurations; does not invent a hull/design. */
export class LegacyShipFactory {
  static createCustomShip(name: string, powerSourceType: PowerSourceType, engineType: EngineType, cargoType: CargoType): Ship {
    // Validate the complete request before allocating components or a runtime ship.
    const input = legacyShipConfigSchema.parse({ name, powerSourceType, engineType, cargoType });
    return new Ship(newId('custom'), input.name,
      LegacyShipComponentFactory.createPowerSource(input.powerSourceType),
      LegacyShipComponentFactory.createEngine(input.engineType),
      LegacyShipComponentFactory.createCargoHold(input.cargoType));
  }
}