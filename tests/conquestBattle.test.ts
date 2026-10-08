import { expect, it, vi } from 'vitest';
import { createDesign } from '../src/domain/shipDesign';
import { createOperationalState, readOperationalState } from '../src/domain/campaignOperations';
import { resolveConquestBattle } from '../src/domain/conquestBattle';
import type { CampaignShip } from '../src/domain/campaignShips';

it('resolves reproducibly through real tactics without wall clock, global RNG or healing', () => {
  const design = createDesign('fighter', true);
  const ships: CampaignShip[] = [
    { id: 1, factionId: 'blue', systemId: 'eden', design, fuel: 2 },
    { id: 2, factionId: 'red', systemId: 'eden', design, fuel: 2 }
  ];
  const operations = { '1': { ...createOperationalState(design), hull: 75 }, '2': createOperationalState(design) };
  const before = structuredClone(operations);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
  const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
  try {
    const result = resolveConquestBattle(ships, operations, 123);
    expect(resolveConquestBattle(ships, operations, 123)).toEqual(result);
    expect(result.frames[0].ships[0].hull).toBe(75);
    expect(result.destroyed.length + result.survivors.length).toBe(2);
    expect(result.frames.length).toBeLessThanOrEqual(121);
    expect(operations).toEqual(before);
  } finally { clock.mockRestore(); random.mockRestore(); }
});

it('bounds unarmed combat and rejects corrupt persistent state', () => {
  const design = createDesign('fighter', true);
  design.slots.find(slot => slot.id === 'beam_1')!.component = null;
  const ships: CampaignShip[] = [
    { id: 1, factionId: 'blue', systemId: 'eden', design, fuel: 2 },
    { id: 2, factionId: 'red', systemId: 'eden', design, fuel: 2 }
  ];
  const operations = { '1': createOperationalState(design), '2': createOperationalState(design) };
  const result = resolveConquestBattle(ships, operations, 1);
  expect(result.timedOut).toBe(true);
  expect(result.winner).toBeNull();
  expect(result.destroyed).toEqual([]);
  expect(() => readOperationalState({ hull: 999999, ammunition: [] }, design)).toThrow();
  expect(() => resolveConquestBattle(ships, {}, 1)).toThrow();
});