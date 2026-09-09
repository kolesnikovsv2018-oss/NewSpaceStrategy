import { createShipState, snapshotShipState, type ShipPosition, type ShipState } from '../domain/shipState';
import { loadCargo, unloadCargo, type CargoItem, type CargoLimits, type CargoResult } from '../domain/cargo';
import type { ShipDesign } from '../domain/shipDesign';
import type { ShipView } from './interfaces/ShipView';
import { assertNonNegative, assertPosition, finitePosition, nonNegativeFinite, positiveFinite, writeEnergy } from '../domain/runtimeNumbers';
import { estimateFlight, type FlightEstimate } from '../domain/flightEstimate';

/** State owner and neutral operations. No legacy components, equipment or Phaser dependency. */
export abstract class ShipRuntime implements ShipView {
  protected readonly state: ShipState;
  private cargoMessage = '';

  constructor(public id: string, public name: string, initialState = createShipState()) {
    assertPosition(initialState.position);
    assertPosition(initialState.velocity);
    assertNonNegative(initialState.energy, 'Энергия');
    this.state = snapshotShipState(initialState);
  }

  getState(): ShipState { return snapshotShipState(this.state); }
  getCargo(): CargoItem[] { return this.state.cargo.map(item => ({ ...item })); }
  getEnergy(): number { return this.state.energy; }
  setEnergy(value: number): void { writeEnergy(this.state, value, this.getEnergyCapacity()); }
  getFlightEstimate(): FlightEstimate {
    return estimateFlight(this.getEnergy(), this.getEnergyGeneration(), this.getMovementPower(), this.getCurrentMaxSpeed());
  }
  getCargoMessage(): string { return this.cargoMessage; }
  get position(): ShipPosition { return this.state.position; }
  set position(value: ShipPosition) { assertPosition(value); this.state.position = { ...value }; }
  get velocity(): ShipPosition { return this.state.velocity; }
  set velocity(value: ShipPosition) { assertPosition(value); this.state.velocity = { ...value }; }
  get isMoving(): boolean { return this.state.isMoving; }
  set isMoving(value: boolean) { this.state.isMoving = value; }

  abstract getEnergyCapacity(): number;
  abstract getEnergyGeneration(): number;
  abstract getMovementPower(): number;
  abstract getCargoLimits(): CargoLimits;
  abstract getCurrentMaxSpeed(): number;
  abstract update(deltaTime: number): void;

  // Presentation queries are implemented by each model; operations below never read compatibility views.
  abstract readonly powerSource: ShipView['powerSource'];
  abstract readonly engine: ShipView['engine'];
  abstract readonly cargoHold: ShipView['cargoHold'];
  abstract getDesign(): ShipDesign | undefined;
  abstract getInstalledModuleNames(): string[];
  abstract getTotalCost(): number;
  abstract getTotalWeight(): number;
  abstract getMaxRange(): number;
  abstract getInfo(): string;

  loadCargoLot(input: unknown): boolean {
    return this.applyCargoResult(loadCargo(this.state.cargo, input, this.getCargoLimits()));
  }

  unloadCargo(resourceType: string, amount: number): boolean {
    return this.applyCargoResult(unloadCargo(this.state.cargo, resourceType, amount));
  }

  protected applyCargoResult(result: CargoResult): boolean {
    if (!result.ok) { this.cargoMessage = result.message; return false; }
    this.state.cargo = result.cargo;
    this.cargoMessage = 'Грузовая операция выполнена';
    this.refreshVelocityForMass();
    return true;
  }

  protected refreshVelocityForMass(): void {
    if (!this.isMoving) return;
    const length = Math.hypot(this.velocity.x, this.velocity.y);
    if (!positiveFinite(length)) return;
    const speed = this.getCurrentMaxSpeed();
    if (!nonNegativeFinite(speed)) return;
    this.velocity = { x: this.velocity.x / length * speed, y: this.velocity.y / length * speed };
  }

  consumeEnergy(amount: number): boolean {
    if (!nonNegativeFinite(amount) || !nonNegativeFinite(this.state.energy) || this.state.energy < amount) return false;
    this.state.energy -= amount;
    return true;
  }

  rechargeEnergy(deltaTime: number): void {
    if (!positiveFinite(deltaTime)) return;
    const generation = this.getEnergyGeneration(), capacity = this.getEnergyCapacity();
    if (![generation, capacity, this.state.energy].every(nonNegativeFinite)) return;
    // Positive overflow safely saturates at finite capacity, rather than entering state as Infinity.
    this.state.energy = Math.min(this.state.energy + generation * deltaTime, capacity);
  }

  /** Caller controls historical ordering: canonical pays first; legacy still moves before payment. */
  protected advanceMovement(deltaTime: number, payBeforeMoving: boolean): void {
    if (!this.isMoving || !positiveFinite(deltaTime)) return;
    const power = this.getMovementPower();
    if (!nonNegativeFinite(power) || !finitePosition(this.position) || !finitePosition(this.velocity)) return;
    const consumption = power * deltaTime;
    const next = { x: this.position.x + this.velocity.x * deltaTime, y: this.position.y + this.velocity.y * deltaTime };
    if (!nonNegativeFinite(consumption) || !finitePosition(next)) return;
    if (payBeforeMoving && !this.consumeEnergy(consumption)) { this.stopMoving(); return; }
    this.position.x = next.x;
    this.position.y = next.y;
    if (!payBeforeMoving && !this.consumeEnergy(consumption)) this.stopMoving();
  }

  startMoving(targetX: number, targetY: number): boolean {
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || !finitePosition(this.position)) return false;
    const dx = targetX - this.position.x;
    const dy = targetY - this.position.y;
    const distance = Math.hypot(dx, dy);
    if (!positiveFinite(distance)) return false;
    const speed = this.getCurrentMaxSpeed();
    if (!nonNegativeFinite(speed)) return false;
    this.velocity.x = dx / distance * speed;
    this.velocity.y = dy / distance * speed;
    this.isMoving = true;
    return true;
  }

  stopMoving(): void {
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.isMoving = false;
  }
}