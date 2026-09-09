import { nonNegativeFinite } from './runtimeNumbers';

/** Continuous, movement-only tactical estimate: energy EU, power EU/s, speed tactical units/s.
 * Excludes weapons/shields/service actions and discrete step/battery-size constraints; not strategic fuel.
 */
export type FlightEstimate =
  | { kind: 'unavailable' }
  | { kind: 'stationary' }
  | { kind: 'sustained' }
  | { kind: 'limited'; seconds: number; distance: number };

export function estimateFlight(energy: number, generation: number, movementPower: number, speed: number): FlightEstimate {
  if (![energy, generation, movementPower, speed].every(nonNegativeFinite)) return { kind: 'unavailable' };
  if (speed === 0) return { kind: 'stationary' };
  if (generation >= movementPower) return { kind: 'sustained' };
  const seconds = energy / (movementPower - generation);
  const distance = seconds * speed;
  if (!Number.isFinite(seconds) || !Number.isFinite(distance)) return { kind: 'unavailable' };
  return { kind: 'limited', seconds, distance };
}

export function formatFlightEstimate(estimate: FlightEstimate): string {
  switch (estimate.kind) {
    case 'unavailable': return 'Оценка полёта недоступна';
    case 'stationary': return 'Нет скорости для полёта';
    case 'sustained': return 'Генерация покрывает движение';
    case 'limited': return `${estimate.seconds.toFixed(1)} с / ${estimate.distance.toFixed(1)} такт. ед.`;
  }
}