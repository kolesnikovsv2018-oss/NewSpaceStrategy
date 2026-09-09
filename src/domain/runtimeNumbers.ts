import type { ShipPosition, ShipState } from './shipState';

export function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function positiveFinite(value: unknown): value is number {
  return nonNegativeFinite(value) && value > 0;
}

export function finitePosition(value: ShipPosition): boolean {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

export function assertNonNegative(value: number, label: string): void {
  if (!nonNegativeFinite(value)) throw new RangeError(`${label}: нужно конечное неотрицательное число`);
}

export function assertPosition(value: ShipPosition): void {
  if (!finitePosition(value)) throw new RangeError('Координаты должны быть конечными числами');
}

/** Compatibility setters throw before writing, rather than silently clamping invalid state. */
export function writeEnergy(state: ShipState, value: number, capacity: number): void {
  if (!nonNegativeFinite(capacity) || !nonNegativeFinite(value) || value > capacity) {
    throw new RangeError('Энергия должна быть конечной и находиться в пределах ёмкости');
  }
  state.energy = value;
}