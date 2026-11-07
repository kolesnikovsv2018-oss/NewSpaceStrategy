import { expect, it } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand, type Conquest } from '../src/domain/conquest';
import { advanceConquestColonyOutput, getConquestColonyOutputForecast,
  validateConquestColonyOutputState } from '../src/domain/campaignOutput';
import { createDefaultRulesSnapshot, type BuildingDefinition } from '../src/domain/campaignRules';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { createDesign, createComponentWithId } from '../src/domain/shipDesign';
import { createOperationalState } from '../src/domain/campaignOperations';
import { getCompletedColonyEffects } from '../src/domain/campaignColonyEffects';

type Faction = 'player-01' | 'player-02';
const catalog = new Map(createDefaultRulesSnapshot().buildings.map(def => [def.id, def]));

function unlocked(state: Conquest, ids: string[]): Conquest {
  state.research['player-01'].completed = [...new Set([...state.research['player-01'].completed, ...ids])];
  state.researchJournal['player-01'] = Object.fromEntries(state.research['player-01'].completed.map(id => [id, 1]));
  return state;
}

function addSyntheticBuilding(state: Conquest, def: BuildingDefinition, nodeId: string): Conquest {
  state.rules.buildings = [...state.rules.buildings, def];
  state.researchTree.nodes = [...state.researchTree.nodes,
    { id: nodeId, name: nodeId, prerequisites: [], researchCost: 1,
      effects: [{ kind: 'building-unlock' as const, buildingId: def.id }] }];
  return unlocked(state, [def.unlockResearchId, nodeId]);
}

function commandAs(state: Conquest, faction: Faction, payload: Record<string, unknown>) {
  return executeConquestCommand(state, { factionId: faction, expectedTurn: state.session.schedule.turn, ...payload });
}

function expectRejected(state: Conquest, faction: Faction, payload: Record<string, unknown>, fragment: string) {
  const result = commandAs(state, faction, payload);
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (!result.ok) expect(result.message).toContain(fragment);
}

function build(state: Conquest, systemId: string, buildingId: string): Conquest {
  const result = commandAs(state, 'player-01', { kind: 'startBuilding', systemId, buildingId });
  if (!result.ok) throw new Error(buildingId + ': ' + result.message);
  return result.state;
}

function endAs(state: Conquest, faction: Faction): Conquest {
  const result = commandAs(state, faction, { kind: 'endTurn' });
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

function round(state: Conquest): Conquest { return endAs(endAs(state, 'player-01'), 'player-02'); }

function effects(state: Conquest, faction: Faction) {
  return getCompletedColonyEffects(state.researchTree, state.research[faction], state.rules);
}

function forecast(state: Conquest, faction: Faction = 'player-01', treasury?: { credits: number; minerals: number }) {
  return getConquestColonyOutputForecast(state.session.galaxy, state.population, state.colonyOutput, faction,
    state.rules.colonyOutput, state.session.ships.filter(ship => ship.factionId === faction).length,
    effects(state, faction), state.environment, state.rules.buildings, treasury);
}

it('rejects a building before its unlock research and accepts it exactly after', () => {
  const state = createConquest();
  expectRejected(state, 'player-01', { kind: 'startBuilding', systemId: 'sol', buildingId: 'science-lab' },
    'Здание ещё не изучено');
  const ready = unlocked(createConquest(), ['applied']);
  const queued = build(ready, 'sol', 'science-lab');
  expect(queued.colonyOutput.projects[0]).toMatchObject({ kind: 'building', buildingId: 'science-lab',
    systemId: 'sol', cost: { credits: 60, minerals: 30 }, productionCost: 800, productionProgress: 0 });
});

it('rejects an unknown building id and an incompatible world environment', () => {
  const state = unlocked(createConquest(), ['applied']);
  expectRejected(state, 'player-01', { kind: 'startBuilding', systemId: 'sol', buildingId: 'nonexistent' },
    'Здание отсутствует в каталоге правил');
  const synthetic: BuildingDefinition = { ...catalog.get('science-lab')!, id: 'toxic-lab',
    unlockResearchId: 'toxic-lab-node', worlds: ['toxic'] };
  const prepared = addSyntheticBuilding(structuredClone(state), synthetic, 'toxic-lab-node');
  expectRejected(prepared, 'player-01', { kind: 'startBuilding', systemId: 'sol', buildingId: 'toxic-lab' },
    'Среда мира несовместима со зданием');
});

it('installs exactly +1 level per completed project and stops at the catalog level cap', () => {
  let state = unlocked(createConquest(), ['applied']);
  state.session.treasuries['player-01'] = { credits: 10000, minerals: 10000 };
  state = round(build(state, 'sol', 'science-lab'));
  expect(state.colonyOutput.buildings.sol).toEqual([{ buildingId: 'science-lab', level: 1 }]);
  state = round(build(state, 'sol', 'science-lab'));
  // Surplus production points never add a second level in one project.
  expect(state.colonyOutput.buildings.sol).toEqual([{ buildingId: 'science-lab', level: 2 }]);
  expectRejected(state, 'player-01', { kind: 'startBuilding', systemId: 'sol', buildingId: 'science-lab' },
    'Достигнут предел уровней здания');
});

it('enforces colony slots across installed and pending levels', () => {
  let state = unlocked(createConquest(), ['applied', 'engineering', 'automation', 'cultural-practices']);
  state.session.treasuries['player-01'] = { credits: 10000, minerals: 10000 };
  state = round(build(state, 'sol', 'science-lab'));
  state = round(build(state, 'sol', 'science-lab'));
  expect(state.colonyOutput.buildings.sol).toEqual([
    { buildingId: 'science-lab', level: 2 }]);
  expectRejected(state, 'player-01', { kind: 'startBuilding', systemId: 'sol', buildingId: 'science-lab' },
    'Достигнут предел уровней здания');
  // Slots cap counts installed levels even with an empty queue.
  state.colonyOutput.buildings.sol = [
    { buildingId: 'science-lab', level: 2 }, { buildingId: 'factory', level: 2 }];
  expectRejected(state, 'player-01', { kind: 'startBuilding', systemId: 'sol', buildingId: 'cultural-center' },
    'Достигнут предел мест зданий колонии');
});

it('demolishes one level for exactly half of the price and removes the record at level one', () => {
  let state = unlocked(createConquest(), ['applied']);
  const before = { ...state.session.treasuries['player-01'] };
  const queued = build(state, 'sol', 'science-lab');
  expect(queued.session.treasuries['player-01']).toEqual({ credits: before.credits - 60, minerals: before.minerals - 30 });
  state = round(queued);
  const afterRound = { ...state.session.treasuries['player-01'] };
  const demolished = commandAs(state, 'player-01', { kind: 'demolishBuilding', systemId: 'sol', buildingId: 'science-lab' });
  expect(demolished.ok).toBe(true);
  if (!demolished.ok) return;
  expect(demolished.state.colonyOutput.buildings.sol).toEqual([]);
  expect(demolished.state.session.treasuries['player-01'])
    .toEqual({ credits: afterRound.credits + 30, minerals: afterRound.minerals + 15 });
  expectRejected(demolished.state, 'player-01', { kind: 'demolishBuilding', systemId: 'sol', buildingId: 'science-lab' },
    'Здание не установлено в колонии');
});

it('keeps unpaid buildings inactive without output or upkeep in a deterministic catalog order', () => {
  const state = unlocked(createConquest(), ['applied', 'automation']);
  state.population.sol = { population: 2, remainder: 0 };
  state.session.ships = [];
  state.colonyOutput.buildings.sol = [
    { buildingId: 'science-lab', level: 1 }, { buildingId: 'factory', level: 1 }];
  // Gross 6 credits − population 2 → building budget 4: science-lab (2) paid, factory (3) not.
  const poor = forecast(state, 'player-01', { credits: 0, minerals: 0 });
  const poorRow = poor.production.find(row => row.systemId === 'sol');
  expect(poor.upkeep.buildingPaidCredits).toBe(2);
  expect(poor.upkeep.buildingShortfallCredits).toBe(3);
  expect(poorRow?.buildingOutput.science).toBe(2);
  expect(poorRow?.buildingOutput.production).toBe(0);
  expect(poorRow?.buildings).toEqual([
    { buildingId: 'science-lab', levels: 1, active: true, upkeep: 2 },
    { buildingId: 'factory', levels: 1, active: false, upkeep: 3 }]);
  const rich = forecast(state, 'player-01', { credits: 1_000_000, minerals: 0 });
  expect(rich.upkeep.buildingPaidCredits).toBe(5);
  expect(rich.upkeep.buildingShortfallCredits).toBe(0);
  expect(rich.production.find(row => row.systemId === 'sol')?.buildingOutput)
    .toMatchObject({ science: 2, production: 2 });
  // Legacy callers without treasury: every compatible building stays active.
  const legacy = forecast(state);
  expect(legacy.upkeep.buildingShortfallCredits).toBe(0);
});

it('marks a world-incompatible building inactive without touching the save', () => {
  const synthetic: BuildingDefinition = { ...catalog.get('science-lab')!, id: 'toxic-lab',
    unlockResearchId: 'toxic-lab-node', worlds: ['toxic'] };
  let state = addSyntheticBuilding(createConquest(), synthetic, 'toxic-lab-node');
  state.colonyOutput.buildings.sol = [{ buildingId: 'toxic-lab', level: 1 }];
  const rich = forecast(state, 'player-01', { credits: 1_000_000, minerals: 0 });
  const row = rich.production.find(item => item.systemId === 'sol');
  expect(row?.buildings).toEqual([{ buildingId: 'toxic-lab', levels: 1, active: false, upkeep: 2 }]);
  expect(row?.buildingOutput.science).toBe(0);
  expect(rich.upkeep.buildingPaidCredits).toBe(0);
  expect(() => validateConquestColonyOutputState(state.colonyOutput, state.session.galaxy, state.population,
    state.session.production.lastOrderId, state.rules.colonyOutput, state.rules.buildings,
    state.session.schedule.order)).not.toThrow();
});

it('applies a completed building from the next own end turn, not the calculated one', () => {
  let state = unlocked(createConquest(), ['applied']);
  state.colonyOutput.assignments.sol = { industry: 5000, research: 0, culture: 0 };
  const queued = build(state, 'sol', 'science-lab');
  const advanced = advanceConquestColonyOutput(queued.colonyOutput, queued.session.galaxy, queued.population,
    'player-01', state.rules.colonyOutput, queued.session.ships.filter(ship => ship.factionId === 'player-01').length,
    effects(queued, 'player-01'), state.environment, state.rules.buildings, queued.session.treasuries['player-01']);
  const rowT = advanced.forecast.production.find(row => row.systemId === 'sol')!;
  expect(rowT.buildingOutput.science).toBe(0);
  expect(advanced.completedProjects).toHaveLength(1);
  expect(advanced.state.buildings.sol).toEqual([{ buildingId: 'science-lab', level: 1 }]);
  const next = getConquestColonyOutputForecast(queued.session.galaxy, queued.population, advanced.state, 'player-01',
    state.rules.colonyOutput, queued.session.ships.filter(ship => ship.factionId === 'player-01').length,
    effects(queued, 'player-01'), state.environment, state.rules.buildings);
  expect(next.production.find(row => row.systemId === 'sol')?.buildingOutput.science).toBe(2);
});

it('keeps buildings with the colony on capture instead of repairing the save', () => {
  let state = unlocked(createConquest(), ['applied']);
  state = round(build(state, 'sol', 'science-lab'));
  expect(state.colonyOutput.buildings.sol).toEqual([{ buildingId: 'science-lab', level: 1 }]);
  const design = createDesign('corvette', true);
  design.slots[0].component = createComponentWithId('beam', 'conquest-beam-v1');
  const id = ++state.session.production.lastOrderId;
  state.session.ships.push({ id, factionId: 'player-02', systemId: 'sol', design, fuel: 3000 });
  state.operations[String(id)] = createOperationalState(design);
  const removed = state.session.ships.filter(ship => ship.factionId === 'player-01' && ship.systemId === 'sol')
    .map(ship => ship.id);
  state.session.ships = state.session.ships.filter(ship => !(ship.factionId === 'player-01' && ship.systemId === 'sol'));
  for (const removedId of removed) delete state.operations[String(removedId)];
  const captured = endAs(endAs(state, 'player-01'), 'player-02');
  expect(captured.session.galaxy.systems.find(system => system.id === 'sol')?.ownerId).toBe('player-02');
  expect(captured.colonyOutput.buildings.sol).toEqual([{ buildingId: 'science-lab', level: 1 }]);
  expect(() => validateConquestColonyOutputState(captured.colonyOutput, captured.session.galaxy,
    captured.population, captured.session.production.lastOrderId,
    captured.rules.colonyOutput, captured.rules.buildings, captured.session.schedule.order)).not.toThrow();
  const redRow = forecast(captured, 'player-02').production.find(row => row.systemId === 'sol');
  expect(redRow?.buildingOutput.science).toBe(2);
  expect(redRow?.buildings[0]?.active).toBe(true);
});

it('round-trips autonomous buildings and building projects through the conquest save', () => {
  let state = unlocked(createConquest(), ['applied']);
  state = round(build(state, 'sol', 'science-lab'));
  const restored = decodeConquestSave(encodeConquestSave(state));
  expect(restored.colonyOutput.buildings).toEqual(state.colonyOutput.buildings);
  expect(restored.colonyOutput.projects).toEqual(state.colonyOutput.projects);
  expect(conquestSchema.safeParse(restored).success).toBe(true);
});
