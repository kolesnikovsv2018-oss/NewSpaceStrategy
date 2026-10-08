import { describe, expect, it, vi } from 'vitest';
import { runCombatSeries } from '../src/domain/combatSeries';
import { createSeededRandomStream } from '../src/domain/seededRandom';

describe('seeded combat series', () => {
  it('repeats each fixed-step battle and aggregate without global RNG', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('unexpected global RNG'); });
    const request = { blue: { fighters: 2 }, red: { fighters: 2 }, seeds: [731, 732, 731] };
    const first = runCombatSeries(request);
    const second = runCombatSeries(request);

    expect(first).toEqual(second);
    expect(first.battles[0]).toEqual(first.battles[2]);
    const { seed: firstSeed, ...firstBattle } = first.battles[0];
    const { seed: secondSeed, ...secondBattle } = first.battles[1];
    expect(firstSeed).not.toBe(secondSeed);
    expect(firstBattle).not.toEqual(secondBattle);
    expect(first.battles).toHaveLength(3);
    expect(first.summary.blueWins + first.summary.redWins + first.summary.draws).toBe(3);
    expect(first.summary.timeouts).toBeLessThanOrEqual(first.summary.draws);
    expect(first.battles.every(battle => battle.steps <= 2400 && battle.durationMs === battle.steps * 50)).toBe(true);
  });

  it('rejects empty fleets and invalid seeds before starting a series', () => {
    expect(() => runCombatSeries({ blue: {}, red: { fighters: 1 }, seeds: [1] })).toThrow();
    expect(() => runCombatSeries({ blue: { fighters: 1 }, red: { fighters: 1 }, seeds: [0] })).toThrow();
    expect(() => runCombatSeries({ blue: { fighters: 1 }, red: { fighters: 1 }, seeds: Array(101).fill(1) })).toThrow();
  });

  it('keeps each ship random stream independent of another ship consuming extra rolls', () => {
    const baseline = createSeededRandomStream(74, 'blue:0');
    const expected = [baseline(), baseline(), baseline()];
    const actual = createSeededRandomStream(74, 'blue:0');
    const otherShip = createSeededRandomStream(74, 'blue:1');
    const interleaved = [actual(), otherShip(), otherShip(), otherShip(), actual(), actual()];
    expect([interleaved[0], interleaved[4], interleaved[5]]).toEqual(expected);
    expect(interleaved[1]).not.toBe(interleaved[0]);
  });

  it('balances initial initiative across a deterministic seed set', () => {
    const result = runCombatSeries({
      blue: { fighters: 1 },
      red: { fighters: 1 },
      seeds: Array.from({ length: 100 }, (_, index) => index + 1)
    });
    const blueStarts = result.battles.filter(battle => battle.firstFactionId === 'blue').length;
    expect(blueStarts).toBeGreaterThanOrEqual(40);
    expect(blueStarts).toBeLessThanOrEqual(60);
  });
});