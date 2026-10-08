export const COMBAT_SIMULATION_STEP = 0.05;
export const COMBAT_SIMULATION_MAX_SECONDS = 120;
export const COMBAT_SIMULATION_MAX_STEPS = COMBAT_SIMULATION_MAX_SECONDS / COMBAT_SIMULATION_STEP;

function cooldownTolerance(period: number, step: number): number {
  if (!Number.isFinite(period) || period <= 0 || !Number.isFinite(step) || step <= 0) {
    throw new RangeError('Период и шаг перезарядки должны быть конечными положительными числами');
  }
  // Bound accumulated subtraction roundoff, never discard half of a real simulation step.
  return Math.min(step / 2, Number.EPSILON * period * (Math.ceil(period / step) + 1));
}

export function advanceCombatCooldown(remaining: number, step: number, period: number): number {
  if (!Number.isFinite(remaining) || remaining < 0) throw new RangeError('Недопустимая перезарядка');
  const tolerance = cooldownTolerance(period, step);
  const next = remaining - step;
  return next <= tolerance ? 0 : next;
}

export function getCombatCooldownSteps(period: number, step = COMBAT_SIMULATION_STEP): number {
  const tolerance = cooldownTolerance(period, step);
  return Math.max(1, Math.ceil((period - tolerance) / step));
}