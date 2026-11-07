import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createConquest, getConquestView, type Conquest } from '../src/domain/conquest';
import { executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { hasColonizationAccess } from '../src/domain/campaignResearch';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';
import { createColonizerDesign } from '../src/domain/civilianPresets';
import { workCommand as apply } from './fixtures/colonyWork';
import { activeOf } from './fixtures/conquestSides';

// Н17.2: статические фикстуры прежних версий заменены новыми оплаченными сценариями
// актуальной версии 19/15 (прецедент upgrade-n15-fixtures.mjs); сценарий 40 миров seed 41
// сыгран настоящим AI-конвейером до контрольных точек перед ходами 199 и 200.
function completedResearch(state: Conquest, faction: 'player-01' | 'player-02'): Conquest {
  state.research[faction].completed = state.researchTree.nodes.map(node => node.id);
  state.researchJournal[faction] = Object.fromEntries(state.research[faction].completed.map(id => [id, 1]));
  return state;
}
function lateState(size: 40 | 256, faction: 'player-01' | 'player-02' = 'player-01') {
  const generated = generateBrowserGalaxy(size, 41);
  if (!generated.ok) throw new Error(generated.message);
  let state = createConquest(undefined, undefined, 41, generated.map);
  state.session.schedule = faction === 'player-01'
    ? { order: state.session.schedule.order, activeIndex: 0, turn: 1, revision: 0, round: 1 }
    : { order: state.session.schedule.order, activeIndex: 1, turn: 2, revision: 1, round: 1 };
  state = completedResearch(state, faction);
  state.session.treasuries[faction] = { credits: 200000, minerals: 100000 };
  const map = state.session.galaxy.map!;
  const home = map.participants[faction === 'player-01' ? 0 : 1].homeWorldId;
  return { state, home, map };
}
function plan(state: Conquest) {
  return planConquestAction(getConquestView(state, activeOf(state)));
}

function paidCheckpoint(turn: 199 | 200): Conquest {
  return decodeConquestSave(readFileSync(
    `reports/2026-11-06/n17-2-state-platform/replays/40-41-current-ai-direct.before-${turn}.save.json`, 'utf8'));
}

describe('AI development under the existing turn budget', () => {
  it('shares the actual environment unlock query rather than treating surveyed toxic worlds as already unlocked', () => {
    const state = createConquest();
    expect(hasColonizationAccess('habitable', state.research['player-01'], state.researchTree)).toBe(true);
    expect(hasColonizationAccess('barren', state.research['player-01'], state.researchTree)).toBe(false);
    expect(hasColonizationAccess('toxic', state.research['player-01'], state.researchTree)).toBe(false);
    expect(hasColonizationAccess('toxic', { ...state.research['player-01'], completed: ['toxic-adaptation'] }, state.researchTree)).toBe(true);
  });

  it.each([40, 256] as const)('does not spend %i-world budget assigning idle industrial growth with no output destination', size => {
    const { state, home } = lateState(size);
    const population = state.population[home].population;
    state.colonyOutput.assignments[home] = { industry: population, research: 0, culture: 0 };
    const before = structuredClone(state);
    const view = getConquestView(state, 'player-01');
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
    const view = getConquestView(queued, 'player-01'), command = plan(queued);
    expect(command).toMatchObject({ kind: 'assignWorkers', systemId: home });
    if (command.kind !== 'assignWorkers') throw new Error('Expected useful industry assignment');
    expect(command.workers.industry).toBe(view.colonyOutput.assignments[home].population);
  });

  it('fills new industrial workers for a real paid refit, not just ship orders', () => {
    const { state, home } = lateState(40);
    state.colonyOutput.assignments[home] = { industry: 0, research: 0, culture: 0 };
    const ship = state.session.ships.find(ship => ship.factionId === 'player-01' && !ship.transit && ship.systemId === home)!;
    const queued = apply(state, { kind: 'startRefit', systemId: home, shipId: ship.id, design: ship.design });
    expect(plan(queued)).toMatchObject({ kind: 'assignWorkers', systemId: home });
  });

  it('fills new industrial workers for a real paid building head introduced by Н15', () => {
    const { state, home } = lateState(40);
    state.colonyOutput.assignments[home] = { industry: 0, research: 0, culture: 0 };
    const def = state.rules.buildings.find(item => item.id === 'science-lab')!;
    const queued = apply(state, { kind: 'startBuilding', systemId: home, buildingId: def.id });
    const view = getConquestView(queued, 'player-01'), command = plan(queued);
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
      factionId: 'player-01', systemId: home, buildingId: def.id, cost: { ...def.cost },
      productionCost: def.productionCost, productionProgress: 0 });
    expect(() => apply(pendingSame, { kind: 'startBuilding', systemId: home, buildingId: def.id })).toThrow(/уже поставлен/);
    const result = executeConquestAiTurn(state, 'player-01', state.session.schedule.turn);
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
    const first = executeConquestAiTurn(state, 'player-01', state.session.schedule.turn);
    expect(first.ok).toBe(true);
    expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), 'player-01', state.session.schedule.turn)).toEqual(first);
    expect(state).toEqual(before);
    if (first.ok) expect(first.state.session.schedule.turn).toBe(200);
  });
});
