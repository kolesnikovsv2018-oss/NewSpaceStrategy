import { expect, it } from 'vitest';
import { getWorldDistance, isWorldInRange } from '../src/domain/campaignTravel';
import { createConquest, executeConquestCommand, getConquestView, type Conquest } from '../src/domain/conquest';
import { createColonizerDesign, createCivilianDesign } from '../src/domain/civilianPresets';
import { calculateShipStats, validateDesign } from '../src/domain/shipDesign';
import { getColonyProductionQuote } from '../src/domain/campaignOutput';
import { encodeConquestSave, decodeConquestSave } from '../src/utils/ConquestSaveManager';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';
import { validateGalaxyMap, canReachInitialWorld, getNearestNeutralWorlds } from '../src/domain/galaxyMap';

function apply(state: Conquest, payload: Record<string, unknown>): Conquest {
  const before = structuredClone(state);
  const result = executeConquestCommand(state, { factionId: state.session.turn % 2 ? 'blue' : 'red',
    expectedTurn: state.session.turn, ...payload });
  expect(state).toEqual(before);
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
function round(state: Conquest): Conquest {
  return apply(apply(state, { kind: 'endTurn' }), { kind: 'endTurn' });
}

it('uses actual Euclidean distance, exact thresholds and no adjacency or display coordinates', () => {
  const worlds = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 120, y: 160 },
    { id: 'c', x: 120, y: 160.001 }];
  expect(getWorldDistance(worlds, 'a', 'b')).toBe(200);
  expect(isWorldInRange(worlds, 'a', 'b', 200)).toBe(true);
  expect(isWorldInRange(worlds, 'a', 'c', 200)).toBe(false);
  expect(isWorldInRange(worlds, 'a', 'a', 200)).toBe(false);
  expect(() => getWorldDistance(worlds, 'a', 'missing')).toThrow();
  expect(() => isWorldInRange(worlds, 'a', 'b', NaN)).toThrow();
});

it('provides an independent valid colonizer project and exactly two full starting ships', () => {
  const state = createConquest(), design = createColonizerDesign();
  expect(validateDesign(design, 'flight')).toEqual([]);
  expect(validateDesign(design, 'battle').some(issue => issue.code === 'weapon')).toBe(true);
  expect(calculateShipStats(design)).toMatchObject({ mass: 182, cost: 22900, hitPoints: 500,
    cargoVolume: 100, cargoMassLimit: 100 });
  expect(getColonyProductionQuote(design, state.rules.colonyOutput)).toMatchObject({
    cost: { credits: 229, minerals: 19 }, productionCost: 23
  });
  expect(state.session.production.lastOrderId).toBe(2);
  expect(state.session.ships.map(ship => [ship.id, ship.factionId, ship.systemId, ship.fuel, ship.design.hullId]))
    .toEqual([[1, 'blue', 'sol', 3000, 'colonizer'], [2, 'red', 'vega', 3000, 'colonizer']]);
  expect(Object.keys(state.operations)).toEqual(['1', '2']);
  state.session.ships[0].design.name = 'Changed';
  expect(state.session.ships[1].design.name).toBe('Колонизатор');
  expect(createColonizerDesign()).toEqual(design);
  expect(createCivilianDesign('colonizer').id).not.toBe(createCivilianDesign('colonizer').id);
  expect(calculateShipStats(createCivilianDesign('colonizer'))).toEqual(calculateShipStats(design));
});

it('requires an explicit selected colonizer and consumes it only after successful paid founding', () => {
  let state = apply(createConquest(), { kind: 'sendShip', systemId: 'sol', shipId: 1, destinationId: 'eden' });
  expect(state.session.ships[0].fuel).toBe(2992);
  state = round(state);
  expect(state.session.galaxy.systems.find(system => system.id === 'eden')!.ownerId).toBeNull();
  expect(executeConquestCommand(state, { kind: 'colonize', systemId: 'eden', shipId: 1,
    factionId: 'blue', expectedTurn: 3 })).toMatchObject({ ok: false, code: 'NOT_SURVEYED' });
  state = apply(state, { kind: 'survey', systemId: 'eden' });
  const before = structuredClone(state), treasury = state.session.treasuries.blue;
  const missingId = executeConquestCommand(state, { kind: 'colonize', systemId: 'eden', factionId: 'blue', expectedTurn: 3 });
  expect(missingId).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  const wrongId = executeConquestCommand(state, { kind: 'colonize', systemId: 'eden', shipId: 2, factionId: 'blue', expectedTurn: 3 });
  expect(wrongId).toMatchObject({ ok: false, code: 'COLONIZER_REQUIRED' });
  expect(state).toEqual(before);
  const restored = decodeConquestSave(encodeConquestSave(state));
  const next = apply(restored, { kind: 'colonize', systemId: 'eden', shipId: 1 });
  expect(next).toEqual(apply(state, { kind: 'colonize', systemId: 'eden', shipId: 1 }));
  expect(next.session.treasuries.blue).toEqual({ credits: treasury.credits - 20, minerals: treasury.minerals - 10 });
  expect(next.population.sol.population).toBe(state.population.sol.population - 1000);
  expect(next.population.eden).toEqual({ population: 1000, remainder: 0 });
  expect(next.session.ships.map(ship => ship.id)).toEqual([2]);
  expect(next.operations).not.toHaveProperty('1');
  expect(next.session.production.lastOrderId).toBe(2);
  expect(executeConquestCommand(next, { kind: 'colonize', systemId: 'eden', shipId: 1,
    factionId: 'blue', expectedTurn: 3 }).ok).toBe(false);
});

it('earns all four range levels by real scientific spending without changing ship definitions', () => {
  let state = apply(createConquest(), { kind: 'assignWorkers', systemId: 'sol',
    workers: { industry: 0, research: 5000, culture: 0 } });
  const ships = structuredClone(state.session.ships);
  expect(getConquestView(state, 'blue').strategicRange).toBe(200);
  for (const [id, range] of [['engineering', 400], ['support', 400], ['ordnance', 800], ['capital', 1500]] as const) {
    state = apply(state, { kind: 'research', technologyId: id });
    for (let step = 0; step < 10 && !state.research.blue.completed.includes(id); step++) state = round(state);
    expect(state.research.blue.completed).toContain(id);
    expect(getConquestView(state, 'blue').strategicRange).toBe(range);
    expect(getConquestView(state, 'red').strategicRange).toBe(200);
    state = decodeConquestSave(encodeConquestSave(state));
  }
  expect(state.session.ships).toEqual(ships);
});

it.each([[40, 87], [256, 1], [256, 2]])('removes fuel-network traps from %i worlds/seed%i without retaining links', (count, seed) => {
  const result = generateBrowserGalaxy(count, seed);
  if (!result.ok) throw new Error(result.message);
  const map = result.map;
  expect(map).not.toHaveProperty('lanes');
  expect(validateGalaxyMap({ ...map, lanes: [] }).ok).toBe(false);
  for (const participant of map.participants) {
    expect(getNearestNeutralWorlds(map, participant.homeWorldId)
      .every(world => canReachInitialWorld(map, participant.homeWorldId, world.id))).toBe(true);
    expect(map.worlds.every(world => world.id === participant.homeWorldId ||
      isWorldInRange(map.worlds, participant.homeWorldId, world.id, 1500))).toBe(true);
  }
});
