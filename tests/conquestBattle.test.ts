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

it('uses seeded initiative, per-ship streams and symmetric placement for campaign-v2', () => {
  const design = createDesign('fighter', true);
  const ships: CampaignShip[] = [
    { id: 1, factionId: 'blue', systemId: 'eden', design, fuel: 2 },
    { id: 2, factionId: 'red', systemId: 'eden', design, fuel: 2 },
    { id: 3, factionId: 'red', systemId: 'eden', design, fuel: 2 },
    { id: 4, factionId: 'blue', systemId: 'eden', design, fuel: 2 }
  ];
  const operations = Object.fromEntries(ships.map(ship => [String(ship.id), createOperationalState(ship.design)]));
  const result = resolveConquestBattle(ships, operations, 0x9e3779b9, 'campaign-v2');
  expect(resolveConquestBattle(ships, operations, 0x9e3779b9, 'campaign-v2')).toEqual(result);
  expect(resolveConquestBattle([...ships].reverse(), operations, 0x9e3779b9, 'campaign-v2')).toEqual(result);
  expect(result.frames[0].ships.filter(ship => ship.factionId === 'blue').map(ship => ship.y)).toEqual([100, 105]);
  expect(result.frames[0].ships.filter(ship => ship.factionId === 'red').map(ship => ship.y)).toEqual([100, 105]);
});

it('avoids a fixed blue-first outcome across dispersed seeds and both hull states', () => {
  const design = createDesign('fighter', true);
  const seeds = Array.from({ length: 60 }, (_, index) => (((index + 1) * 2654435761) >>> 0) || 1);
  for (const hull of [200, 1]) {
    let blueWins = 0, redWins = 0;
    for (const seed of seeds) {
      const ships: CampaignShip[] = [
        { id: 1, factionId: 'blue', systemId: 'eden', design, fuel: 2 },
        { id: 2, factionId: 'red', systemId: 'eden', design, fuel: 2 }
      ];
      const operations = Object.fromEntries(ships.map(ship => {
        const operational = createOperationalState(ship.design);
        operational.hull = hull;
        return [String(ship.id), operational];
      }));
      const winner = resolveConquestBattle(ships, operations, seed, 'campaign-v2').winner;
      if (winner === 'blue') blueWins++;
      if (winner === 'red') redWins++;
    }
    expect(blueWins).toBeGreaterThan(15);
    expect(blueWins).toBeLessThan(45);
    expect(redWins).toBeGreaterThan(15);
    expect(redWins).toBeLessThan(45);
  }
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