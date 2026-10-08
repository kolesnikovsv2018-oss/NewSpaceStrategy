import { describe, expect, it } from 'vitest';
import { advanceCombatCooldown, getCombatCooldownSteps } from '../src/domain/combatSimulation';

describe('combat cooldown boundaries', () => {
  it.each([
    [0.1, 200], [1, 20], [1.5, 14], [2, 10], [4, 5], [5, 4], [20, 1]
  ])('fireRate %s becomes ready after exactly %s fixed steps', (fireRate, steps) => {
    const period = 1 / fireRate;
    expect(getCombatCooldownSteps(period)).toBe(steps);
    let remaining = period;
    for (let index = 1; index <= steps; index++) {
      remaining = advanceCombatCooldown(remaining, 0.05, period);
      if (index < steps) expect(remaining).toBeGreaterThan(0);
    }
    expect(remaining).toBe(0);
  });

  it.each([0.025, 0.05, 0.1])('handles exact periods across step %s', step => {
    let remaining = 0.5;
    const steps = 0.5 / step;
    expect(getCombatCooldownSteps(0.5, step)).toBe(steps);
    for (let index = 0; index < steps; index++) remaining = advanceCombatCooldown(remaining, step, 0.5);
    expect(remaining).toBe(0);
  });

  it('preserves a real positive remainder instead of rounding every nearby period down', () => {
    const period = 0.5 + 1e-10;
    expect(getCombatCooldownSteps(period)).toBe(11);
    let remaining = period;
    for (let index = 0; index < 10; index++) remaining = advanceCombatCooldown(remaining, 0.05, period);
    expect(remaining).toBeGreaterThan(0);
    expect(advanceCombatCooldown(remaining, 0.05, period)).toBe(0);
  });

  it('does not erase a tiny real cooldown when updates are much smaller', () => {
    expect(advanceCombatCooldown(1e-20, 1e-30, 0.5)).toBeGreaterThan(0);
    expect(advanceCombatCooldown(0.5, Number.MIN_VALUE, 0.5)).toBe(0.5);
    expect(advanceCombatCooldown(0.5, Number.MAX_VALUE, 0.5)).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid period or step %s explicitly', invalid => {
    expect(() => advanceCombatCooldown(0.5, invalid, 0.5)).toThrow(RangeError);
    expect(() => advanceCombatCooldown(0.5, 0.05, invalid)).toThrow(RangeError);
    expect(() => getCombatCooldownSteps(invalid)).toThrow(RangeError);
    expect(() => getCombatCooldownSteps(0.5, invalid)).toThrow(RangeError);
  });
});
