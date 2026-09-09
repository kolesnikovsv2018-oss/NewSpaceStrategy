import type { Ship } from './Ship';
import { DesignedShip } from './DesignedShip';
import type { PowerSourceType, EngineType, CargoType } from './interfaces/ShipComponents';
import { LegacyShipFactory } from '../legacy/LegacyShipFactory';
import { createCivilianDesign } from '../domain/civilianPresets';
import { createCombatDesign } from '../domain/combatPresets';
import type { ShipDesign } from '../domain/shipDesign';

export class ShipFactory {
  /** Canonical flight construction; unarmed designs are allowed, invalid designs are not. */
  static createFromDesign(design: ShipDesign, factionId = 'neutral'): DesignedShip {
    return new DesignedShip(design, factionId, 'flight');
  }

  static createScout(): DesignedShip {
    return this.createFromDesign(createCivilianDesign('scout'));
  }

  static createFreighter(): DesignedShip {
    return this.createFromDesign(createCivilianDesign('freighter'));
  }

  static createWarship(): DesignedShip {
    return new DesignedShip(createCombatDesign('cruiser'), 'neutral');
  }

  static createMiner(): DesignedShip {
    return this.createFromDesign(createCivilianDesign('miner'));
  }

  /** @deprecated Legacy-only compatibility API. Use createFromDesign for canonical projects, or LegacyShipFactory explicitly. */
  static createCustomShip(name: string, powerSourceType: PowerSourceType, engineType: EngineType, cargoType: CargoType): Ship {
    return LegacyShipFactory.createCustomShip(name, powerSourceType, engineType, cargoType);
  }
}
