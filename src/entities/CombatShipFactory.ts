import { z } from 'zod';
import { DesignedShip } from './DesignedShip';
import { createCombatDesign } from '../domain/combatPresets';
import type { ShipDesign } from '../domain/shipDesign';

const countSchema = z.number().int().min(0).max(128);
const compositionSchema = z.object({
  fighters: countSchema.optional(), frigates: countSchema.optional(),
  cruisers: countSchema.optional(), dreadnoughts: countSchema.optional()
}).strict().refine(composition => Object.values(composition).reduce<number>((sum, count) => sum + (count ?? 0), 0) <= 128,
  'Во флоте допускается не более 128 кораблей');
export type FleetComposition = z.infer<typeof compositionSchema>;

/** All production combat presets use the same blueprint, validator and runtime as the yard. */
export class CombatShipFactory {
  static createFromDesign(design: ShipDesign, factionId: string): DesignedShip {
    return new DesignedShip(design, factionId);
  }

  static createFighter(factionId: string, index = 0): DesignedShip {
    return CombatShipFactory.createFromDesign(createCombatDesign('fighter', index), factionId);
  }
  static createFrigate(factionId: string, index = 0): DesignedShip {
    return CombatShipFactory.createFromDesign(createCombatDesign('frigate', index), factionId);
  }
  static createCruiser(factionId: string, index = 0): DesignedShip {
    return CombatShipFactory.createFromDesign(createCombatDesign('cruiser', index), factionId);
  }
  static createDreadnought(factionId: string, index = 0): DesignedShip {
    return CombatShipFactory.createFromDesign(createCombatDesign('dreadnought', index), factionId);
  }

  static createFighterSquadron(factionId: string, count: number): DesignedShip[] {
    return this.createFleet(factionId, { fighters: count });
  }

  static createFleet(factionId: string, input: FleetComposition): DesignedShip[] {
    // Validate all counts before creating anything; NaN/Infinity/fractions cannot start unbounded loops.
    const composition = compositionSchema.parse(input);
    return [
      ...Array.from({ length: composition.fighters ?? 0 }, (_, index) => this.createFighter(factionId, index)),
      ...Array.from({ length: composition.frigates ?? 0 }, (_, index) => this.createFrigate(factionId, index)),
      ...Array.from({ length: composition.cruisers ?? 0 }, (_, index) => this.createCruiser(factionId, index)),
      ...Array.from({ length: composition.dreadnoughts ?? 0 }, (_, index) => this.createDreadnought(factionId, index))
    ];
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
