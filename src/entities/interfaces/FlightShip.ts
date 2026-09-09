import type { ShipView } from './ShipView';

/** Commands used by the flight scene, separate from the read-only renderer contract. */
export interface FlightShip extends ShipView {
  update(deltaTime: number): void;
  startMoving(targetX: number, targetY: number): boolean;
  loadCargoLot(input: unknown): boolean;
  unloadCargo(resourceType: string, amount: number): boolean;
  getCargoMessage(): string;
}