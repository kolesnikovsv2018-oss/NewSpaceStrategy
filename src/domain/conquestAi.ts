import { HULLS, createComponentWithId, calculateShipStats, validateDesign, type ShipDesign, type ComponentDefinition } from './shipDesign';
import { COMBAT_SIMULATION_MAX_SECONDS, COMBAT_SIMULATION_MAX_STEPS, COMBAT_SIMULATION_STEP, getCombatCooldownSteps } from './combatSimulation';
import type { Treasury } from './campaignEconomy';
import { getCampaignVariantProfile, getCampaignVariantTier, getResearchAccess, isCampaignDesignAvailable, getResearchProgress,
  type ResearchState, type ResearchTree } from './campaignResearch';
import { getProductionQuote } from './production';
import { getColonyProductionQuote } from './campaignOutput';
import { getRefuelQuote } from './campaignShips';
import { createOperationalState } from './campaignOperations';
import { conquestSchema, executeConquestAction, getConquestOutcome, getConquestView, type ConquestCommand, type ConquestView, type ConquestResult } from './conquest';
import { factionIdSchema, type SystemId } from './campaign';
import type { BattleFrame } from './conquestBattle';
import { calculateColonyValue } from './campaignColonyEffects';

export function getConquestResearchUtility(view: ConquestView, node: ResearchTree['nodes'][number]): number {
  const activeIds = new Set(view.researchTree.nodes.filter(item => view.research.completed.includes(item.id))
    .flatMap(item => item.effects.flatMap(effect => effect.kind === 'colony-effect' ? [effect.effectId] : [])));
  const proposedIds = new Set([...activeIds, ...node.effects.flatMap(effect => effect.kind === 'colony-effect' ? [effect.effectId] : [])]);
  const proposed = view.colonyTechnologyEffects.filter(effect => proposedIds.has(effect.id));
  let score = node.effects.reduce((sum, effect) => sum + (effect.kind === 'variant-tier' ? 4 :
    effect.kind === 'hull-unlock' ? 3 : effect.kind === 'component-unlock'
      ? (effect.component === 'projectile' || effect.component === 'armor' ? 3 : 1) : 0), 0);
  let scienceGain = 0, cultureGain = 0;
  for (const colony of view.population) {
    const row = view.colonyOutput.forecast.production.find(item => item.systemId === colony.systemId)!;
    for (const [role, target] of [
      ['production', 'production-output'], ['science', 'science-output'], ['culture', 'culture-output']
    ] as const) {
      const base = row.breakdown[role];
      const next = calculateColonyValue(base.base, base.workers, target, colony.worldType, proposed).total;
      const gain = Math.max(0, next - base.total);
      if (role === 'science') scienceGain += gain;
      else if (role === 'culture') cultureGain += gain;
      else if (row.orderId !== undefined) score += Math.min(gain,
        Math.max(0, row.productionCost! - row.productionProgress! - row.productionPoints)) / 1000;
    }
    const growth = colony.technology.growthRate, capacity = colony.technology.capacity;
    const nextRate = calculateColonyValue(growth.base, 1, 'growth-rate', colony.worldType, proposed, 10000).total;
    const nextK = calculateColonyValue(capacity.base, 1, 'capacity-add', colony.worldType, proposed, capacity.limit).total;
    const nextGrowth = Math.max(0, Math.min(nextK - colony.population,
      Math.floor((colony.population * nextRate + Math.round(colony.remainder * 100)) / 10000)));
    score += Math.max(0, nextGrowth - colony.delta) / 1000;
  }
  const reserves = view.colonyOutput.forecast.reserves;
  score += Math.min(scienceGain, Math.max(0, reserves.research.cap - reserves.research.after)) / 1000;
  score += Math.min(cultureGain, Math.max(0, reserves.culture.cap - reserves.culture.after)) / 1000;
  return score;
}

export function buildConquestDesigns(research: ResearchState, tree: ResearchTree): ShipDesign[] {
  const access = getResearchAccess(research, tree), designs: ShipDesign[] = [];
  const signatures = new Set<string>();
  const components = new Map<string, ComponentDefinition>();
  const unlockedTier = getCampaignVariantTier(research, tree);
  for (const kind of access.components) {
    const component = createComponentWithId(kind, `conquest-${kind}-v1`);
    components.set(kind, component);
  }
  for (const hullId of access.hulls) for (let variant = 0; variant < 8; variant++) {
    const profile = getCampaignVariantProfile(tree, Math.min(unlockedTier, 1 + Math.floor(variant / 2)));
    const variantComponents = new Map<string, ComponentDefinition>();
    for (const [kind, component] of components) {
      const candidate = structuredClone(component);
      if (profile) {
        const magnitude = profile.magnitude, ratioStep = profile.ratioStep;
        if (candidate.kind === 'engine') Object.assign(candidate, { thrust: candidate.thrust * (1 + magnitude),
          maxSpeed: candidate.maxSpeed * (1 + magnitude), maneuverability: Math.min(1, candidate.maneuverability + ratioStep),
          powerGeneration: candidate.powerGeneration * (1 + magnitude) });
        if (candidate.kind === 'beam') Object.assign(candidate, { damage: candidate.damage * (1 + magnitude),
          range: candidate.range * (1 + magnitude),
          fireRate: variant % 4 >= 2 ? candidate.fireRate : candidate.fireRate * (1 + magnitude),
          accuracy: Math.min(1, candidate.accuracy + ratioStep) });
        if (candidate.kind === 'projectile') Object.assign(candidate, { damage: candidate.damage * (1 + magnitude),
          range: candidate.range * (1 + magnitude),
          accuracy: Math.min(1, candidate.accuracy + ratioStep), ammoCapacity: Math.ceil(candidate.ammoCapacity * (1 + profile.ammo)) });
        if (candidate.kind === 'shield') Object.assign(candidate, { capacity: candidate.capacity * (1 + magnitude),
          rechargeRate: candidate.rechargeRate * (1 + magnitude), rechargeDelay: Math.max(0, candidate.rechargeDelay - profile.rechargeDelay),
          beamResistance: Math.min(1, candidate.beamResistance + ratioStep) });
        if (candidate.kind === 'armor') Object.assign(candidate, { armorPoints: candidate.armorPoints * (1 + magnitude),
          beamResistance: Math.min(1, candidate.beamResistance + ratioStep),
          projectileResistance: Math.min(1, candidate.projectileResistance + ratioStep) });
        if (candidate.kind === 'mining') Object.assign(candidate, { miningSpeed: candidate.miningSpeed * (1 + magnitude),
          efficiency: Math.min(1, candidate.efficiency + ratioStep) });
        if (candidate.kind === 'repair') Object.assign(candidate, { repairRate: candidate.repairRate * (1 + magnitude) });
        if (candidate.kind === 'scanner') Object.assign(candidate, { range: candidate.range * (1 + magnitude),
          accuracy: Math.min(1, candidate.accuracy + ratioStep) });
        if (candidate.kind === 'cargoExpansion') Object.assign(candidate, { bonusCapacity: candidate.bonusCapacity * (1 + magnitude) });
      }
      variantComponents.set(kind, candidate);
    }
    const design: ShipDesign = { id: `conquest-${hullId}-${variant}`, name: `${HULLS[hullId].name} ${variant + 1}`,
      schemaVersion: 2, hullId, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
      slots: HULLS[hullId].slots.map(slot => {
        let component: ComponentDefinition | undefined;
        if (slot.kind === 'engine' || slot.id === 'beam_1') component = variantComponents.get(slot.kind);
        if (slot.id === 'beam_2' && variant % 2) component = variantComponents.get('beam');
        if (slot.kind === 'armor' && variant >= 4) component = variantComponents.get('armor');
        if (slot.kind === 'projectile' && variant % 4 >= 2) component = variantComponents.get('projectile');
        return { id: slot.id, component: component ? structuredClone(component) : null };
      }) };
    const signature = JSON.stringify([design.hullId, design.slots]);
    if (!signatures.has(signature) && !validateDesign(design, 'battle').length && isCampaignDesignAvailable(design, research, tree)) {
      signatures.add(signature); designs.push(design);
    }
  }
  return designs;
}

export interface ConquestDesignScore {
  expectedDamage: number;
  effectiveDurability: number;
  approachSeconds: number;
  resourcePressure: number;
  score: number;
}

/**
 * Bounded candidate heuristic, not a win-probability model. It uses the Conquest
 * start gap and 120s cap, caps projectile shots by ammo, and models defense against
 * a 50/50 beam/projectile stream without shield regeneration. Pair series remain
 * the authority for comparisons between complete fleets.
 */
export function calculateConquestDesignScore(design: ShipDesign, available: Treasury): ConquestDesignScore {
  const stats = calculateShipStats(design);
  const preferredRange = stats.weapons.length
    ? Math.min(...stats.weapons.map(weapon => weapon.definition.range)) : 0;
  const maximumRange = Math.max(0, ...stats.weapons.map(weapon => weapon.definition.range));
  const engagementRange = preferredRange < maximumRange * 0.8 ? preferredRange : maximumRange * 0.8;
  const approachSeconds = stats.speed > 0
    ? Math.min(COMBAT_SIMULATION_MAX_SECONDS, Math.max(0, (600 - engagementRange) / (2 * stats.speed)))
    : COMBAT_SIMULATION_MAX_SECONDS;
  const firstFiringStep = Math.ceil(approachSeconds / COMBAT_SIMULATION_STEP);
  const activeSteps = Math.max(0, COMBAT_SIMULATION_MAX_STEPS - firstFiringStep);
  let expectedDamage = 0;

  for (const weapon of stats.weapons) {
    const cooldownSteps = getCombatCooldownSteps(1 / weapon.definition.fireRate);
    const possibleShots = activeSteps === 0 ? 0 : Math.floor((activeSteps - 1) / cooldownSteps) + 1;
    const ammunition = weapon.definition.kind === 'projectile' ? weapon.definition.ammoCapacity : possibleShots;
    expectedDamage += weapon.definition.damage * weapon.definition.accuracy * Math.min(possibleShots, ammunition);
  }

  const hitRate = 1 - stats.evasion;
  const armorFactor = 100 / (100 + stats.armor);
  const beamHullRate = 0.5 * hitRate * armorFactor * (1 - stats.armorBeamResistance);
  const projectileHullRate = 0.5 * hitRate * armorFactor * (1 - stats.armorProjectileResistance);
  const shieldDrainRate = 0.5 * hitRate * (1 - stats.shieldBeamResistance);
  const shieldDepletionSeconds = stats.shield > 0 && shieldDrainRate > 0
    ? stats.shield / shieldDrainRate : stats.shield > 0 ? Infinity : 0;
  const hullDepletionWhileShielded = projectileHullRate > 0 ? stats.hitPoints / projectileHullRate : Infinity;
  let effectiveDurability: number;
  if (shieldDepletionSeconds < hullDepletionWhileShielded) {
    const remainingHull = stats.hitPoints - projectileHullRate * shieldDepletionSeconds;
    const hullRateAfterShield = beamHullRate + projectileHullRate;
    effectiveDurability = shieldDepletionSeconds + (hullRateAfterShield > 0
      ? remainingHull / hullRateAfterShield : Number.POSITIVE_INFINITY);
  } else {
    effectiveDurability = hullDepletionWhileShielded;
  }
  effectiveDurability = Math.min(Number.MAX_SAFE_INTEGER,
    Number.isFinite(effectiveDurability) ? Math.max(0, effectiveDurability) : Number.MAX_SAFE_INTEGER);

  const quote = getProductionQuote(design);
  const resourcePressure = quote.cost.credits / Math.max(1, available.credits) +
    quote.cost.minerals / Math.max(1, available.minerals);
  return { expectedDamage, effectiveDurability, approachSeconds, resourcePressure,
    score: expectedDamage * effectiveDurability / resourcePressure };
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
  const needsResearch = view.research.completed.length < view.researchTree.nodes.length;
  for (const colony of colonies) {
    const workforce = view.colonyOutput.assignments[colony.id];
    const research = needsResearch ? Math.min(Math.max(0, workforce.population - 1), Math.max(1, Math.floor(workforce.population / 5))) : 0;
    const culture = Math.min(workforce.culture, Math.max(0, workforce.population - research - 1));
    const industry = workforce.population - research - culture;
    if (workforce.industry !== industry || workforce.research !== research || workforce.culture !== culture) {
      return { ...fields, kind: 'assignWorkers', systemId: colony.id,
        workers: { industry, research, culture } };
    }
  }
  const stalledOrder = view.production.orders.find(order =>
    view.colonyOutput.assignments[order.systemId]?.industry === 0);
  if (stalledOrder) {
    const workforce = view.colonyOutput.assignments[stalledOrder.systemId];
    const sourceRole = workforce.research > 0 ? 'research' : workforce.culture > 0 ? 'culture' : undefined;
    if (sourceRole) return { ...fields, kind: 'assignWorkers', systemId: stalledOrder.systemId,
      workers: { industry: 1, research: workforce.research - Number(sourceRole === 'research'),
        culture: workforce.culture - Number(sourceRole === 'culture') } };
  }
  if (!view.research.activeId && colonies.length) {
    const candidates = view.researchTree.nodes.filter(item => !view.research.completed.includes(item.id) &&
      item.prerequisites.every(id => view.research.completed.includes(id)));
    const node = candidates.sort((a, b) => {
      const aCost = a.researchCost - getResearchProgress(view.research, a.id);
      const bCost = b.researchCost - getResearchProgress(view.research, b.id);
      const rank = getConquestResearchUtility(view, b) * aCost - getConquestResearchUtility(view, a) * bCost;
      return rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    })[0];
    if (node) return { ...fields, kind: 'research', technologyId: node.id };
  }
  const fleet = view.fleets.find(item => !view.ships.some(ship => item.shipIds.includes(ship.id) && ship.transit));
  if (fleet) return { ...fields, kind: 'disbandFleet', fleetId: fleet.id, systemId: fleet.systemId };
  for (const ship of view.ships) {
    if (ship.transit) continue;
    const founding = view.colonization.find(item => item.systemId === ship.systemId);
    if (founding?.quote.ok && !view.enemies.some(enemy => enemy.systemId === ship.systemId)) {
      return { ...fields, kind: 'colonize', systemId: ship.systemId };
    }
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
    const homeRoutes = colonies.map(system => pathTo(view, ship.systemId, system.id))
      .filter((route): route is SystemId[] => !!route && route.length > 1)
      .sort((left, right) => left.length - right.length);
    const targets = view.galaxy.systems.filter(system => system.id !== ship.systemId &&
      (system.visibility === 'unknown' || (system.habitable && system.ownerId !== factionId)))
      .map(system => pathTo(view, ship.systemId, system.id)).filter((route): route is SystemId[] => !!route)
      .sort((left, right) => left.length - right.length || (left[left.length - 1] < right[right.length - 1] ? -1 : 1));
    const nearest = targets.filter(route => route.length === targets[0]?.length);
    // Split equally near targets without persistent or hidden exploration memory.
    let route: SystemId[] | undefined = nearest.length ? nearest[(ship.id - 1) % nearest.length] : undefined;
    if (route && route.length > 1) {
      const destination = route[1];
      const reachesColony = colonies.some(system => system.id === destination);
      const returnRoutes = reachesColony ? [] : colonies.map(system => pathTo(view, destination, system.id))
        .filter((candidate): candidate is SystemId[] => !!candidate);
      const canReturnAfterHop = reachesColony || returnRoutes.some(candidate => candidate.length - 1 <= ship.fuel - 1);
      if (!canReturnAfterHop) route = homeRoutes.find(candidate => candidate.length - 1 <= ship.fuel);
    }
    if (route && route.length > 1) return { ...fields, kind: 'sendShip', systemId: ship.systemId, shipId: ship.id, destinationId: route[1] };
  }
  const orders = view.production.orders, completedRecords = view.production.completed;
  if (colonies.length && view.ships.length + orders.length + completedRecords.length < 4) {
    const designs = buildConquestDesigns(view.research, view.researchTree).filter(design => {
      const quote = getColonyProductionQuote(design, view.colonyOutput.rules);
      return afford(quote.cost.credits + 5, quote.cost.minerals);
    }).map(design => ({ design, value: calculateConquestDesignScore(design,
      { credits: view.treasury.credits - 5, minerals: view.treasury.minerals }) }))
      .sort((left, right) => right.value.score - left.value.score ||
        (left.design.id < right.design.id ? -1 : left.design.id > right.design.id ? 1 : 0));
    const colony = colonies.find(system => orders.filter(order => order.systemId === system.id).length < 3);
    if (designs[0] && colony) return { ...fields, kind: 'enqueueProduction', systemId: colony.id, design: designs[0].design };
  }
  return { ...fields, kind: 'endTurn' };
}

export function executeConquestAiTurn(input: unknown, factionInput: unknown, expectedTurn: number): ConquestResult {
  try {
    let state = conquestSchema.parse(input);
    const faction = factionIdSchema.parse(factionInput);
    if (expectedTurn !== state.session.turn || faction !== (expectedTurn % 2 ? 'blue' : 'red') ||
      (state.control.mode === 'human-vs-ai' && faction !== 'red') || getConquestOutcome(state).status === 'completed') {
      return { ok: false, code: 'CONTROLLER_FORBIDDEN', message: 'AI-ход недоступен' };
    }
    let frames: BattleFrame[] | undefined;
    const notices: NonNullable<Extract<ConquestResult, { ok: true }>['notices']> = [];
    const workforceAdjustments: NonNullable<Extract<ConquestResult, { ok: true }>['workforceAdjustments']> = [];
    for (let action = 0; action < 24; action++) {
      const command = action === 23 ? { kind: 'endTurn' as const, factionId: faction, expectedTurn } : planConquestAction(getConquestView(state, faction));
      const result = executeConquestAction(state, command, true);
      if (!result.ok) return { ok: false, code: result.code, message: 'Не удалось выполнить AI-ход' };
      state = result.state;
      notices.push(...result.notices ?? []);
      workforceAdjustments.push(...result.workforceAdjustments ?? []);
      frames = result.frames ?? frames;
      if (command.kind === 'endTurn') return { ...result, ...(frames ? { frames } : {}),
        ...(notices.length ? { notices } : {}), ...(workforceAdjustments.length ? { workforceAdjustments } : {}) };
    }
    return { ok: false, code: 'RULE_REJECTED', message: 'Превышен бюджет AI-хода' };
  } catch { return { ok: false, code: 'INVALID_STATE', message: 'Не удалось выполнить AI-ход' }; }
}