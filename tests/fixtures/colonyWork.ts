import { createConquest, executeConquestCommand, type Conquest } from '../../src/domain/conquest';
import { generateBrowserGalaxy } from '../../src/utils/BrowserGalaxyGenerator';
import { getGalaxyDefinition } from '../../src/domain/campaign';
import { getWorldDistance, getTravelCapabilities, getTravelQuote } from '../../src/domain/campaignTravel';
import type { ShipDesign } from '../../src/domain/shipDesign';
import type { CampaignState } from '../../src/domain/campaign';

export function diagnosticTransit(from: string, destinationId: string, design: ShipDesign, galaxy?: CampaignState) {
  const capabilities = getTravelCapabilities(design.strategicEquipment);
  const quote = getTravelQuote(getWorldDistance(getGalaxyDefinition(galaxy).systems, from, destinationId), capabilities, capabilities.fuelCapacity);
  if (!quote.ok) throw new Error(`Diagnostic route: ${quote.message}`);
  return { policy: 'project-travel-v1' as const, destinationId, capabilities,
    distance: quote.distance, totalTurns: quote.totalTurns, remainingTurns: quote.totalTurns, fuelCost: quote.fuelCost };
}
export function finishWorkTravel(state: Conquest, shipId: number): Conquest {
  for (let step = 0; step < 20 && state.session.ships.find(ship => ship.id === shipId)?.transit; step++) state = workRound(state);
  if (state.session.ships.find(ship => ship.id === shipId)?.transit) throw new Error('Travel deadline');
  return state;
}

export function workCommand(state: Conquest, payload: Record<string, unknown>): Conquest {
  const result = executeConquestCommand(state, { factionId: state.session.turn % 2 ? 'blue' : 'red',
    expectedTurn: state.session.turn, ...payload });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
export function workRound(state: Conquest): Conquest {
  return workCommand(workCommand(state, { kind: 'endTurn' }), { kind: 'endTurn' });
}
export function earnWorkTechnology(state: Conquest, technologyId: string): Conquest {
  state = workCommand(state, { kind: 'research', technologyId });
  for (let round = 0; round < 20 && !state.research.blue.completed.includes(technologyId); round++) state = workRound(state);
  if (!state.research.blue.completed.includes(technologyId)) throw new Error(`Research deadline: ${technologyId}`);
  return state;
}
export function paidToxicColony() {
  const generated = generateBrowserGalaxy(8, 41);
  if (!generated.ok) throw new Error(generated.message);
  let state = createConquest(undefined, undefined, 41, generated.map);
  const home = state.session.ships[0].systemId, target = generated.map.worlds.find(world => world.type === 'toxic')!.id;
  state = workCommand(state, { kind: 'assignWorkers', systemId: home, workers: { industry: 1000, research: 4000, culture: 0 } });
  for (const id of ['engineering', 'support', 'ordnance', 'capital', 'toxic-adaptation', 'biology', 'biosphere', 'terraforming']) {
    state = earnWorkTechnology(state, id);
  }
  state = workCommand(state, { kind: 'sendShip', systemId: home, shipId: 1, destinationId: target });
  state = finishWorkTravel(state, 1);
  state = workCommand(state, { kind: 'survey', systemId: target });
  state = workCommand(state, { kind: 'colonize', systemId: target, shipId: 1 });
  state = workCommand(state, { kind: 'assignWorkers', systemId: target, workers: { industry: 1000, research: 0, culture: 0 } });
  return { state, home, target };
}
