import type { ShipDesign } from '../../domain/shipDesign';
import type { ShipPosition } from '../../domain/shipState';
import type { FlightEstimate } from '../../domain/flightEstimate';

/** Read-only model surface for Phaser views. No simulation commands or concrete model classes. */
export interface ShipView {
  readonly id: string;
  readonly name: string;
  readonly position: Readonly<ShipPosition>;
  readonly velocity: Readonly<ShipPosition>;
  readonly isMoving: boolean;
  readonly powerSource: Readonly<{
    name: string; currentEnergy: number; energyCapacity: number; energyOutput: number;
  }>;
  readonly engine: Readonly<{ name: string; thrust: number; energyConsumption: number }>;
  readonly cargoHold: Readonly<{
    name: string; capacity: number; usedSpace: number; currentWeight: number; maxWeight: number;
  }>;
  getDesign(): ShipDesign | undefined;
  getInfo(): string;
  getTotalCost(): number;
  getTotalWeight(): number;
  getCurrentMaxSpeed(): number;
  /** @deprecated Historical battery-only compatibility query. UI uses getFlightEstimate. */
  getMaxRange(): number;
  getFlightEstimate(): FlightEstimate;
  getInstalledModuleNames(): string[];
}