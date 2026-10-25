import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createConquest, getConquestView, type Conquest, type ConquestCommand } from '../src/domain/conquest';
import { planConquestAction, executeConquestAiTurn } from '../src/domain/conquestAi';
import { getTravelCapabilities, getTravelQuote, getWorldDistance } from '../src/domain/campaignTravel';
import { hasColonizationAccess } from '../src/domain/campaignResearch';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { workCommand as apply } from './fixtures/colonyWork';

function paidCheckpoint(size: 40 | 256, turn: 199 | 200): Conquest {
  return decodeConquestSave(readFileSync(
    `reports/2026-10-26/d16-ai-development/replays/${size}-41-current-ai-direct.before-${turn}.save.json`, 'utf8'));
}

function plan(state: Conquest) {
  return planConquestAction(getConquestView(state, state.session.turn % 2 ? 'blue' : 'red'));
}

function isDeparture(command: ConquestCommand): command is Extract<ConquestCommand, { kind: 'sendShip' | 'sendFleet' }> {
  return command.kind === 'sendShip' || command.kind === 'sendFleet';
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
    for (const turn of [199, 200] as const) {
      const state = paidCheckpoint(size, turn), before = structuredClone(state);
      const side = turn % 2 ? 'blue' : 'red', view = getConquestView(state, side);
      const command = plan(state);
      expect(view.research.completed).toHaveLength(view.researchTree.nodes.length);
      if (command.kind === 'assignWorkers') {
        const current = view.colonyOutput.assignments[command.systemId];
        const work = [...view.production.orders, ...view.workProjects].some(order => order.systemId === command.systemId);
        expect(current.industry === 0 || work || current.research !== command.workers.research ||
          current.culture !== command.workers.culture).toBe(true);
      }
      expect(state).toEqual(before);
    }
  });

  it('fills new industrial workers when a real paid ship order needs the output', () => {
    const state = paidCheckpoint(40, 199), ship = state.session.ships.find(ship => ship.factionId === 'blue')!;
    const queued = apply(state, { kind: 'enqueueProduction', systemId: 'world-001', design: ship.design });
    const view = getConquestView(queued, 'blue'), command = plan(queued);
    expect(command).toMatchObject({ kind: 'assignWorkers', systemId: 'world-001' });
    if (command.kind !== 'assignWorkers') throw new Error('Expected useful industry assignment');
    expect(command.workers.industry).toBe(view.colonyOutput.assignments['world-001'].population);
  });

  it('fills new industrial workers for a real paid refit, not just ship orders', () => {
    const state = paidCheckpoint(40, 199);
    const ship = state.session.ships.find(ship => ship.factionId === 'blue' && !ship.transit &&
      state.session.galaxy.systems.some(world => world.id === ship.systemId && world.ownerId === 'blue'))!;
    const queued = apply(state, { kind: 'startRefit', systemId: ship.systemId, shipId: ship.id, design: ship.design });
    expect(plan(queued)).toMatchObject({ kind: 'assignWorkers', systemId: ship.systemId });
  });

  it('allows genuinely earlier relief instead of mistaking different arrival times for redundant defence', () => {
    let state = paidCheckpoint(40, 199);
    let first: Extract<ConquestCommand, { kind: 'sendShip' | 'sendFleet' }> | undefined;
    for (let action = 0; action < 23; action++) {
      const command = plan(state);
      if (command.kind === 'endTurn') break;
      if (isDeparture(command)) {
        const view = getConquestView(state, 'blue');
        const target = view.galaxy.systems.find(world => world.id === command.destinationId)!;
        if (!first && target.visibility === 'explored' && target.ownerId === 'blue' &&
          view.enemies.filter(enemy => enemy.systemId === target.id).length === 1) {
          first = command;
        } else if (first) {
          expect(command.destinationId).toBe(first.destinationId);
          if (first.kind !== 'sendShip' || command.kind !== 'sendShip') throw new Error('Expected actual paid detachments');
          const earlierId = first.shipId;
          const earlier = state.session.ships.find(ship => ship.id === earlierId)!.transit!;
          const faster = state.session.ships.find(ship => ship.id === command.shipId)!;
          const quote = getTravelQuote(getWorldDistance(view.galaxy.systems, command.systemId, command.destinationId),
            getTravelCapabilities(faster.design.strategicEquipment), faster.fuel);
          if (!quote.ok) throw new Error(quote.message);
          expect(quote.totalTurns).toBeLessThan(earlier.remainingTurns);
          return;
        }
      }
      state = apply(state, command);
    }
    expect(first).toBeDefined();
    throw new Error('Expected both real departures');
  });

  it('prefers new reachable discovery over repeatedly revisiting worlds with stale ownership', () => {
    const state = decodeConquestSave(readFileSync(
      'reports/2026-10-26/d16-ai-development/frontier.before.save.json', 'utf8'));
    const view = getConquestView(state, 'blue'), command = plan(state);
    expect(command.kind).toBe('sendShip');
    if (command.kind !== 'sendShip') throw new Error('Expected paid colonizer departure');
    const ship = view.ships.find(ship => ship.id === command.shipId)!;
    expect(ship.design.hullId).toBe('colonizer');
    const caps = getTravelCapabilities(ship.design.strategicEquipment);
    const colonies = view.galaxy.systems.filter(world => world.visibility === 'explored' && world.ownerId === 'blue');
    const candidates = view.galaxy.systems.filter(world => world.visibility === 'unknown' &&
      !view.knownSystems.includes(world.id) && view.environmentKnowledge[world.id] !== 'barren')
      .filter(world => {
        const outgoing = getTravelQuote(getWorldDistance(view.galaxy.systems, ship.systemId, world.id), caps, ship.fuel);
        return outgoing.ok && colonies.some(home => getTravelQuote(
          getWorldDistance(view.galaxy.systems, world.id, home.id), caps, ship.fuel - outgoing.fuelCost).ok);
      });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map(world => world.id)).toContain(command.destinationId);
  });

  it('continues the paid late packet identically after strict save/load without adding an endTurn', () => {
    const state = paidCheckpoint(256, 199), before = structuredClone(state);
    const first = executeConquestAiTurn(state, 'blue', state.session.turn);
    expect(first.ok).toBe(true);
    expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), 'blue', state.session.turn)).toEqual(first);
    expect(state).toEqual(before);
    if (first.ok) expect(first.state.session.turn).toBe(200);
  });
});
