import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createConquest, getConquestView, type Conquest } from '../src/domain/conquest';
import { executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { hasColonizationAccess } from '../src/domain/campaignResearch';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';
import { createColonizerDesign } from '../src/domain/civilianPresets';
import { workCommand as apply } from './fixtures/colonyWork';

// Н15: диагностические fixtures Д16 (save16/tree10) не читаются актуальным форматом 17/14;
// свойства перебазированы на процедурные состояния текущей схемы + новые чекпоинты 40 миров.
function completedResearch(state: Conquest, faction: 'blue' | 'red'): Conquest {
  state.research[faction].completed = state.researchTree.nodes.map(node => node.id);
  state.researchJournal[faction] = Object.fromEntries(state.research[faction].completed.map(id => [id, 1]));
  return state;
}
function lateState(size: 40 | 256, faction: 'blue' | 'red' = 'blue') {
  const generated = generateBrowserGalaxy(size, 41);
  if (!generated.ok) throw new Error(generated.message);
  let state = createConquest(undefined, undefined, 41, generated.map);
  state.session.turn = faction === 'blue' ? 1 : 2;
  state = completedResearch(state, faction);
  state.session.treasuries[faction] = { credits: 200000, minerals: 100000 };
  const map = state.session.galaxy.map!;
  const home = map.participants[faction === 'blue' ? 0 : 1].homeWorldId;
  return { state, home, map };
}
function plan(state: Conquest) {
  return planConquestAction(getConquestView(state, state.session.turn % 2 ? 'blue' : 'red'));
}

function paidCheckpoint(turn: 199 | 200): Conquest {
  return decodeConquestSave(readFileSync(
    `reports/2026-11-06/n15-ai-development/replays/40-41-current-ai-direct.before-${turn}.save.json`, 'utf8'));
}

describe('AI development under the existing turn budget', () => {
  it('shares the actual environment unlock query rather than treating surveyed toxic worlds as already unlocked', () => {
    const state = createConquest();
    expect(hasColonizationAccess('habitable', state.research.blue, state.researchTree)).toBe(true);
    expect(hasColonizationAccess('barren', state.research.blue, state.researchTree)).toBe(false);
    expect(hasColonizationAccess('toxic', state.research.blue, state.researchTree)).toBe(false);
    expect(hasColonizationAccess('toxic', { ...state.research.blue, completed: ['toxic-adaptation'] }, state.researchTree)).toBe(true);
  });

  it.each([40, 256] as const)('does not spend %i-world budget assigning idle industrial growth with no output destination', size => {
    const { state, home } = lateState(size);
    const population = state.population[home].population;
    state.colonyOutput.assignments[home] = { industry: population, research: 0, culture: 0 };
    const before = structuredClone(state);
    const view = getConquestView(state, 'blue');
    const command = plan(state);
    expect(view.research.completed).toHaveLength(view.researchTree.nodes.length);
    if (command.kind === 'assignWorkers') {
      const current = view.colonyOutput.assignments[command.systemId];
      const work = [...view.production.orders, ...view.workProjects].some(order => order.systemId === command.systemId);
      expect(current.industry === 0 || work || current.research !== command.workers.research ||
        current.culture !== command.workers.culture).toBe(true);
    } else expect(command.kind).not.toBe('assignWorkers');
    expect(state).toEqual(before);
  });

  it('fills new industrial workers when a real paid ship order needs the output', () => {
    const { state, home } = lateState(40);
    state.colonyOutput.assignments[home] = { industry: 0, research: 0, culture: 0 };
    const queued = apply(state, { kind: 'enqueueProduction', systemId: home, design: createColonizerDesign() });
    const view = getConquestView(queued, 'blue'), command = plan(queued);
    expect(command).toMatchObject({ kind: 'assignWorkers', systemId: home });
    if (command.kind !== 'assignWorkers') throw new Error('Expected useful industry assignment');
    expect(command.workers.industry).toBe(view.colonyOutput.assignments[home].population);
  });

  it('fills new industrial workers for a real paid refit, not just ship orders', () => {
    const { state, home } = lateState(40);
    state.colonyOutput.assignments[home] = { industry: 0, research: 0, culture: 0 };
    const ship = state.session.ships.find(ship => ship.factionId === 'blue' && !ship.transit && ship.systemId === home)!;
    const queued = apply(state, { kind: 'startRefit', systemId: home, shipId: ship.id, design: ship.design });
    expect(plan(queued)).toMatchObject({ kind: 'assignWorkers', systemId: home });
  });

  it('fills new industrial workers for a real paid building head introduced by Н15', () => {
    const { state, home } = lateState(40);
    state.colonyOutput.assignments[home] = { industry: 0, research: 0, culture: 0 };
    const def = state.rules.buildings.find(item => item.id === 'science-lab')!;
    const queued = apply(state, { kind: 'startBuilding', systemId: home, buildingId: def.id });
    const view = getConquestView(queued, 'blue'), command = plan(queued);
    expect(command).toMatchObject({ kind: 'assignWorkers', systemId: home });
    if (command.kind !== 'assignWorkers') throw new Error('Expected useful industry assignment for building head');
    expect(command.workers.industry).toBeGreaterThan(0);
    const forecast = view.colonyOutput.forecast.production.find(row => row.systemId === home)!;
    expect(forecast.orderId).toBe(queued.colonyOutput.projects[0].id);
  });

  it('keeps the bounded building choice inside the shared queue and slot caps', () => {
    const { state, home } = lateState(40);
    const full = structuredClone(state);
    full.colonyOutput.buildings[home] = [
      { buildingId: 'science-lab', level: 2 }, { buildingId: 'factory', level: 2 }];
    expect(() => apply(full, { kind: 'startBuilding', systemId: home, buildingId: 'cultural-center' })).toThrow(/мест зданий/);
    const leveled = structuredClone(state);
    leveled.colonyOutput.buildings[home] = [{ buildingId: 'science-lab', level: 2 }];
    expect(() => apply(leveled, { kind: 'startBuilding', systemId: home, buildingId: 'science-lab' })).toThrow(/уровней/);
    const pendingSame = structuredClone(state);
    const def = pendingSame.rules.buildings.find(item => item.id === 'science-lab')!;
    pendingSame.session.production.lastOrderId += 1;
    pendingSame.colonyOutput.projects.push({ kind: 'building' as const, id: pendingSame.session.production.lastOrderId,
      factionId: 'blue', systemId: home, buildingId: def.id, cost: { ...def.cost },
      productionCost: def.productionCost, productionProgress: 0 });
    expect(() => apply(pendingSame, { kind: 'startBuilding', systemId: home, buildingId: def.id })).toThrow(/уже поставлен/);
    const result = executeConquestAiTurn(state, 'blue', state.session.turn);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [systemId, levels] of Object.entries(result.state.colonyOutput.buildings)) {
      const pending = result.state.colonyOutput.projects.filter(p => p.kind === 'building' && p.systemId === systemId).length;
      expect(levels.reduce((sum, entry) => sum + entry.level, 0) + pending)
        .toBeLessThanOrEqual(result.state.rules.colonyOutput.colonyBuildingSlots);
      for (const entry of levels) {
        const building = result.state.rules.buildings.find(item => item.id === entry.buildingId)!;
        const pendingSameLevels = result.state.colonyOutput.projects.filter(p => p.kind === 'building' &&
          p.systemId === systemId && p.buildingId === entry.buildingId).length;
        expect(entry.level + pendingSameLevels).toBeLessThanOrEqual(building.maxLevels);
      }
    }
  });

  it('continues the paid late packet identically after strict save/load without adding an endTurn', () => {
    const state = paidCheckpoint(199), before = structuredClone(state);
    const first = executeConquestAiTurn(state, 'blue', state.session.turn);
    expect(first.ok).toBe(true);
    expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), 'blue', state.session.turn)).toEqual(first);
    expect(state).toEqual(before);
    if (first.ok) expect(first.state.session.turn).toBe(200);
  });
});
