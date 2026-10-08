import { z } from 'zod';
import { DesignedShip } from './DesignedShip';
import { createCombatDesign } from '../domain/combatPresets';
import type { ShipDesign } from '../domain/shipDesign';

const countSchema = z.number().int().min(0).max(128);
export const fleetCompositionSchema = z.object({
  fighters: countSchema.optional(), frigates: countSchema.optional(),
  cruisers: countSchema.optional(), dreadnoughts: countSchema.optional()
}).strict().refine(composition => Object.values(composition).reduce<number>((sum, count) => sum + (count ?? 0), 0) <= 128,
  'Во флоте допускается не более 128 кораблей');
export type FleetComposition = z.infer<typeof fleetCompositionSchema>;
export interface CombatShipCreationOptions {
  random?: () => number;
  id?: string;
}
export interface CombatFleetCreationOptions {
  random?: () => number;
  randomForShip?: (factionId: string, index: number) => () => number;
  idPrefix?: string;
}

/** All production combat presets use the same blueprint, validator and runtime as the yard. */
export class CombatShipFactory {
  static createFromDesign(design: ShipDesign, factionId: string, options: CombatShipCreationOptions = {}): DesignedShip {
    return new DesignedShip(design, factionId, 'battle', options);
  }

  static createFighter(factionId: string, index = 0, options: CombatShipCreationOptions = {}): DesignedShip {
    return CombatShipFactory.createFromDesign(createCombatDesign('fighter', index), factionId, options);
  }
  static createFrigate(factionId: string, index = 0, options: CombatShipCreationOptions = {}): DesignedShip {
    return CombatShipFactory.createFromDesign(createCombatDesign('frigate', index), factionId, options);
  }
  static createCruiser(factionId: string, index = 0, options: CombatShipCreationOptions = {}): DesignedShip {
    return CombatShipFactory.createFromDesign(createCombatDesign('cruiser', index), factionId, options);
  }
  static createDreadnought(factionId: string, index = 0, options: CombatShipCreationOptions = {}): DesignedShip {
    return CombatShipFactory.createFromDesign(createCombatDesign('dreadnought', index), factionId, options);
  }

  static createFighterSquadron(factionId: string, count: number, options: CombatFleetCreationOptions = {}): DesignedShip[] {
    return this.createFleet(factionId, { fighters: count }, options);
  }

  static createFleet(factionId: string, input: FleetComposition, options: CombatFleetCreationOptions = {}): DesignedShip[] {
    // Validate all counts before creating anything; NaN/Infinity/fractions cannot start unbounded loops.
    const composition = fleetCompositionSchema.parse(input);
    const presets = [
      ['fighter', composition.fighters ?? 0], ['frigate', composition.frigates ?? 0],
      ['cruiser', composition.cruisers ?? 0], ['dreadnought', composition.dreadnoughts ?? 0]
    ] as const;
    const ships: DesignedShip[] = [];
    let shipIndex = 0;
    for (const [preset, count] of presets) {
      for (let index = 0; index < count; index++) {
        const id = options.idPrefix ? `${options.idPrefix}-${factionId}-${shipIndex}` : undefined;
        ships.push(this.createFromDesign(createCombatDesign(preset, index), factionId, {
          random: options.randomForShip?.(factionId, shipIndex) ?? options.random,
          ...(id ? { id } : {})
        }));
        shipIndex++;
      }
    }
    return ships;
  }

  static createRandomShip(factionId: string): DesignedShip {
    const random = Math.random();
    if (random < 0.4) return this.createFighter(factionId);
    if (random < 0.7) return this.createFrigate(factionId);
    if (random < 0.95) return this.createCruiser(factionId);
    return this.createDreadnought(factionId);
  }

  static createRandomFleet(factionId: string, shipCount: number): DesignedShip[] {
    return Array.from({ length: countSchema.parse(shipCount) }, () => this.createRandomShip(factionId));
  }
}
