import { HULLS, createComponentWithId, calculateShipStats, validateDesign, type ShipDesign, type ComponentDefinition } from './shipDesign';
import { getResearchAccess, isCampaignDesignAvailable, type ResearchState, type ResearchTree } from './campaignResearch';
import { getProductionQuote } from './production';
import { getRefuelQuote } from './campaignShips';
import { createOperationalState } from './campaignOperations';
import { conquestSchema, executeConquestAction, getConquestOutcome, getConquestView, type ConquestCommand, type ConquestView, type ConquestResult } from './conquest';
import { factionIdSchema, type SystemId } from './campaign';
import type { BattleFrame } from './conquestBattle';

export function buildConquestDesigns(research: ResearchState, tree: ResearchTree): ShipDesign[] {
  const access = getResearchAccess(research, tree), designs: ShipDesign[] = [];
  const signatures = new Set<string>();
  const components = new Map<string, ComponentDefinition>();
  for (const kind of access.components) {
    const component = createComponentWithId(kind, `conquest-${kind}-v1`);
    if (component.kind === 'engine') Object.assign(component, { thrust: 100, maxSpeed: 100, maneuverability: 0.4, powerGeneration: 150 });
    if (component.kind === 'beam') Object.assign(component, { damage: 8, range: 300, fireRate: 1, accuracy: 0.85 });
    if (component.kind === 'projectile') Object.assign(component, { damage: 12, range: 300, fireRate: 0.5, accuracy: 0.9, ammoCapacity: 20 });
    if (component.kind === 'armor') Object.assign(component, { armorPoints: 30, beamResistance: 0.1, projectileResistance: 0.1 });
    components.set(kind, component);
  }
  for (const hullId of access.hulls) for (let variant = 0; variant < 8; variant++) {
    const design: ShipDesign = { id: `conquest-${hullId}-${variant}`, name: `${HULLS[hullId].name} ${variant + 1}`,
      schemaVersion: 2, hullId, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
      slots: HULLS[hullId].slots.map(slot => {
        let component: ComponentDefinition | undefined;
        if (slot.kind === 'engine' || slot.id === 'beam_1') component = components.get(slot.kind);
        if (slot.id === 'beam_2' && variant % 2) component = components.get('beam');
        if (slot.kind === 'armor' && variant >= 4) component = components.get('armor');
        if (slot.kind === 'projectile' && variant % 4 >= 2) component = components.get('projectile');
        return { id: slot.id, component: component ? structuredClone(component) : null };
      }) };
    const signature = JSON.stringify([design.hullId, design.slots]);
    if (!signatures.has(signature) && !validateDesign(design, 'battle').length && isCampaignDesignAvailable(design, research, tree)) {
      signatures.add(signature); designs.push(design);
    }
  }
  return designs;
}

function pathTo(view: ConquestView, start: SystemId, target: SystemId): SystemId[] | undefined {
  const queue: SystemId[][] = [[start]], visited = new Set<SystemId>([start]);
  for (let index = 0; index < queue.length; index++) {
    const route = queue[index], here = route[route.length - 1];
    if (here === target) return route;
    const neighbours = view.galaxy.lanes.flatMap(([from, to]) => from === here ? [to] : to === here ? [from] : []).sort();
    for (const neighbour of neighbours) if (!visited.has(neighbour)) { visited.add(neighbour); queue.push([...route, neighbour]); }
  }
  return undefined;
}

export function planConquestAction(view: ConquestView): ConquestCommand {
  const factionId = view.galaxy.factionId, expectedTurn = view.turn, fields = { factionId, expectedTurn };
  const colonies = view.galaxy.systems.filter(system => system.visibility === 'explored' && system.ownerId === factionId);
  const afford = (credits: number, minerals = 0) => view.treasury.credits >= credits && view.treasury.minerals >= minerals;
  const completed = view.production.completed[0];
  if (completed && view.ships.length < 8) return { ...fields, kind: 'deployProduction', orderId: completed.id, systemId: completed.systemId };
  if (!view.research.active && colonies.length) {
    const node = view.researchTree.nodes.find(item => !view.research.completed.includes(item.id) &&
      item.prerequisites.every(id => view.research.completed.includes(id)) && afford(item.credits));
    if (node) return { ...fields, kind: 'research', technologyId: node.id };
  }
  const fleet = view.fleets.find(item => !view.ships.some(ship => item.shipIds.includes(ship.id) && ship.transit));
  if (fleet) return { ...fields, kind: 'disbandFleet', fleetId: fleet.id, systemId: fleet.systemId };
  for (const ship of view.ships) {
    if (ship.transit) continue;
    const home = colonies.some(system => system.id === ship.systemId), maximum = createOperationalState(ship.design);
    const operation = view.operations[String(ship.id)];
    if (home && operation.hull < maximum.hull * 0.8) {
      const missing = maximum.hull - operation.hull;
      if (afford(Math.ceil(missing / 10), Math.ceil(missing / 25))) return { ...fields, kind: 'repairShip', systemId: ship.systemId, shipId: ship.id };
    }
    const rounds = maximum.ammunition.reduce((sum, weapon) => sum + weapon.amount - operation.ammunition.find(item => item.slotId === weapon.slotId)!.amount, 0);
    if (home && rounds && afford(rounds, rounds)) return { ...fields, kind: 'resupplyShip', systemId: ship.systemId, shipId: ship.id };
    if (home && ship.fuel < 3) {
      const quote = getRefuelQuote(ship.fuel);
      if (afford(quote.cost.credits, quote.cost.minerals)) return { ...fields, kind: 'refuelShip', systemId: ship.systemId, shipId: ship.id };
    }
    if (!ship.fuel) continue;
    const targets = view.galaxy.systems.filter(system => system.id !== ship.systemId &&
      (system.visibility === 'unknown' || (system.habitable && system.ownerId !== factionId)))
      .map(system => pathTo(view, ship.systemId, system.id)).filter((route): route is SystemId[] => !!route)
      .sort((left, right) => left.length - right.length || (left[left.length - 1] < right[right.length - 1] ? -1 : 1));
    let route = targets[0];
    if (!home && ship.fuel === 1) {
      const retreat = colonies.map(system => pathTo(view, ship.systemId, system.id)).find(item => item?.length === 2);
      if (retreat) route = retreat;
    }
    if (route && route.length > 1) return { ...fields, kind: 'sendShip', systemId: ship.systemId, shipId: ship.id, destinationId: route[1] };
  }
  if (colonies.length && view.ships.length + view.production.orders.length + view.production.completed.length < 4) {
    const designs = buildConquestDesigns(view.research, view.researchTree).filter(design => {
      const quote = getProductionQuote(design);
      return afford(quote.cost.credits + 5, quote.cost.minerals);
    }).sort((left, right) => {
      const score = (design: ShipDesign) => { const stats = calculateShipStats(design); return stats.hitPoints * stats.dps / getProductionQuote(design).cost.credits; };
      return score(right) - score(left) || (left.id < right.id ? -1 : 1);
    });
    const colony = colonies.find(system => view.production.orders.filter(order => order.systemId === system.id).length < 3);
    if (designs[0] && colony) return { ...fields, kind: 'enqueueProduction', systemId: colony.id, design: designs[0] };
  }
  return { ...fields, kind: 'endTurn' };
}

export function executeConquestAiTurn(input: unknown, factionInput: unknown, expectedTurn: number): ConquestResult {
  try {
    let state = conquestSchema.parse(input);
    const faction = factionIdSchema.parse(factionInput);
    if (expectedTurn !== state.session.turn || faction !== (expectedTurn % 2 ? 'blue' : 'red') ||
      (state.control.mode === 'human-vs-ai' && faction !== 'red') || getConquestOutcome(state).status === 'completed') {
      return { ok: false, message: 'AI-ход недоступен' };
    }
    let frames: BattleFrame[] | undefined;
    for (let action = 0; action < 24; action++) {
      const command = action === 23 ? { kind: 'endTurn' as const, factionId: faction, expectedTurn } : planConquestAction(getConquestView(state, faction));
      const result = executeConquestAction(state, command, true);
      if (!result.ok) return { ok: false, message: 'Не удалось выполнить AI-ход' };
      state = result.state;
      frames = result.frames ?? frames;
      if (command.kind === 'endTurn') return { ok: true, state, ...(frames ? { frames } : {}) };
    }
    return { ok: false, message: 'Превышен бюджет AI-хода' };
  } catch { return { ok: false, message: 'Не удалось выполнить AI-ход' }; }
}