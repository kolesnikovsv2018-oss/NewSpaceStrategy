import { HULLS, createComponentWithId, calculateShipStats, validateDesign, withTacticalVariant, type ShipDesign, type ComponentDefinition } from './shipDesign';
import { COMBAT_SIMULATION_MAX_SECONDS, COMBAT_SIMULATION_MAX_STEPS, COMBAT_SIMULATION_STEP, getCombatCooldownSteps, getCombatApproachSeconds } from './combatSimulation';
import type { Treasury } from './campaignEconomy';
import { getCampaignVariantProfile, getCampaignVariantTier, getResearchAccess, isCampaignDesignAvailable, getResearchProgress, hasCompactEquipment,
  hasTacticalVariant, type ResearchState, type ResearchTree } from './campaignResearch';
import { getProductionQuote } from './production';
import { getColonyProductionQuote } from './campaignOutput';
import { createOperationalState } from './campaignOperations';
import { conquestSchema, executeConquestAction, getConquestOutcome, getConquestView, type ConquestCommand, type ConquestView, type ConquestResult } from './conquest';
import { factionIdSchema } from './campaign';
import type { BattleFrame } from './conquestBattle';
import { calculateColonyValue } from './campaignColonyEffects';
import { getWorldDistance, isWorldInRange, createStrategicEquipment, getTravelCapabilities,
  getTravelQuote, getStrategicRefuelQuote, type StrategicEquipment, type TravelCapabilities } from './campaignTravel';
import { createColonizerDesign } from './civilianPresets';
import { MAX_CAMPAIGN_SHIPS } from './campaignShips';

function getAiStrategicEquipment(research: ResearchState, tree: ResearchTree, improved: boolean): StrategicEquipment {
  const equipment = createStrategicEquipment();
  if (!improved) return equipment;
  const effects = tree.nodes.filter(node => research.completed.includes(node.id)).flatMap(node => node.effects);
  if (effects.some(effect => effect.kind === 'strategic-equipment-unlock' && effect.option === 'fast')) equipment.drive = 'fast';
  if (effects.some(effect => effect.kind === 'strategic-equipment-unlock' && effect.option === 'extended-tank')) equipment.tank = 'extended';
  const range = effects.reduce((maximum, effect) => effect.kind === 'strategic-range' ? Math.max(maximum, effect.maxJumpDistance) : maximum, 200);
  equipment.jump = range >= 1500 ? 'galactic' : range >= 800 ? 'deep' : range >= 400 ? 'extended' : 'standard';
  return equipment;
}

export function getConquestResearchUtility(view: ConquestView, node: ResearchTree['nodes'][number]): number {
  const activeIds = new Set(view.researchTree.nodes.filter(item => view.research.completed.includes(item.id))
    .flatMap(item => item.effects.flatMap(effect => effect.kind === 'colony-effect' ? [effect.effectId] : [])));
  const proposedIds = new Set([...activeIds, ...node.effects.flatMap(effect => effect.kind === 'colony-effect' ? [effect.effectId] : [])]);
  const proposed = view.colonyTechnologyEffects.filter(effect => proposedIds.has(effect.id));
  let score = node.effects.reduce((sum, effect) => sum + (effect.kind === 'tactical-variant-unlock' || effect.kind === 'hull-variant-unlock' ? 3 :
    effect.kind === 'strategic-equipment-unlock' ? (view.galaxy.systems.some(system =>
      view.ships.some(ship => !ship.transit && getWorldDistance(view.galaxy.systems, ship.systemId, system.id) >
        (effect.option === 'extended-tank' ? 600 : 100))) ? (effect.option === 'extended-tank' ? 6 : 3) : 0) :
    effect.kind === 'equipment-variant-unlock' ? 2 : effect.kind === 'variant-tier' ? 4 :
    effect.kind === 'colonization-unlock' ? 5 * Object.values(view.environmentKnowledge).filter(type => type === effect.worldType).length :
    effect.kind === 'strategic-range' ? Math.min(10, view.galaxy.systems.filter(system =>
      view.ships.some(ship => !ship.transit && isWorldInRange(view.galaxy.systems, ship.systemId, system.id, effect.maxJumpDistance) &&
        !isWorldInRange(view.galaxy.systems, ship.systemId, system.id, view.strategicRange))).length) :
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
  const compactAvailable = hasCompactEquipment(research, tree);
  for (const kind of access.components) {
    const component = createComponentWithId(kind, `conquest-${kind}-v1`);
    components.set(kind, component);
  }
  for (let variant = 0; variant < 8; variant++) for (const hullId of access.hulls.filter(id => id !== 'colonizer')) {
    const profile = getCampaignVariantProfile(tree, Math.min(unlockedTier, 1 + Math.floor(variant / 2)));
    const variantComponents = new Map<string, ComponentDefinition>();
    for (const [kind, component] of components) {
      let candidate = structuredClone(component);
      if (compactAvailable && variant % 2) candidate.technologyVariant = 'compact';
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
      if (variant >= 4 || ((variant === 2 || variant === 3) && candidate.kind === 'projectile')) {
        const advanced = withTacticalVariant(candidate);
        if (hasTacticalVariant(advanced.tacticalVariant, research, tree)) candidate = advanced;
      }
      variantComponents.set(kind, candidate);
    }
    const design: ShipDesign = { id: `conquest-${hullId}-${variant}`, name: `${HULLS[hullId].name} ${variant + 1}`,
      schemaVersion: 5, tacticalRules: 'design-combat-v1', strategicEquipment: getAiStrategicEquipment(research, tree, variant > 0),
      hullVariant: variant === 7 && hasTacticalVariant('reinforced', research, tree) ? 'reinforced' : 'standard',
      hullId, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
      slots: HULLS[hullId].slots.map(slot => {
        let component: ComponentDefinition | undefined;
        if (slot.kind === 'engine' || (slot.id === 'beam_1' && !((variant === 2 || variant === 3) && access.components.includes('projectile')))) component = variantComponents.get(slot.kind);
        if (slot.id === 'beam_2' && variant % 2) component = variantComponents.get('beam');
        if (slot.kind === 'armor' && (variant === 4 || variant === 6)) component = variantComponents.get('armor');
        if (slot.kind === 'shield' && (variant === 5 || variant === 7)) component = variantComponents.get('shield');
        if (slot.kind === 'projectile' && (variant === 2 || variant === 3)) component = variantComponents.get('projectile');
        return { id: slot.id, component: component ? structuredClone(component) : null };
      }) };
    const signature = JSON.stringify([design.hullId, design.hullVariant, design.strategicEquipment, design.slots]);
    if (!signatures.has(signature) && !validateDesign(design, 'battle').length && isCampaignDesignAvailable(design, research, tree)) {
      signatures.add(signature); designs.push(design);
    }
  }
  return designs.slice(0, 47);
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
  const approachSeconds = getCombatApproachSeconds(Math.max(0, (600 - engagementRange) / 2),
    stats.speed, stats.thrust / stats.mass);
  const firstFiringStep = Math.ceil(approachSeconds / COMBAT_SIMULATION_STEP);
  const activeSteps = Math.max(0, COMBAT_SIMULATION_MAX_STEPS - firstFiringStep);
  let expectedDamage = 0;
  let availableEnergy = Math.max(0, stats.energyCapacity + stats.powerGeneration * COMBAT_SIMULATION_MAX_SECONDS -
    stats.movementPower * approachSeconds);

  for (const weapon of stats.weapons) {
    const cooldownSteps = getCombatCooldownSteps(1 / weapon.definition.fireRate);
    const possibleShots = activeSteps === 0 ? 0 : Math.floor((activeSteps - 1) / cooldownSteps) + 1;
    const ammunition = weapon.definition.kind === 'projectile' ? weapon.definition.ammoCapacity : possibleShots;
    const shots = Math.min(possibleShots, ammunition, Math.floor(availableEnergy / weapon.energyPerShot));
    availableEnergy -= shots * weapon.energyPerShot;
    expectedDamage += weapon.definition.damage * weapon.definition.accuracy * shots;
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

export function planConquestAction(view: ConquestView): ConquestCommand {
  const factionId = view.galaxy.factionId, expectedTurn = view.turn, fields = { factionId, expectedTurn };
  const colonies = view.galaxy.systems.filter(system => system.visibility === 'explored' && system.ownerId === factionId);
  const potentialUnknownTarget = (id: string) => !view.knownSystems.includes(id) || view.knownHabitableSystems.includes(id);
  const hasReturnReserve = (from: string, to: string, caps: TravelCapabilities, fuel: number) => {
    const outgoing = getTravelQuote(getWorldDistance(view.galaxy.systems, from, to), caps, fuel);
    return outgoing.ok && colonies.some(colony =>
      getTravelQuote(getWorldDistance(view.galaxy.systems, to, colony.id), caps, fuel - outgoing.fuelCost).ok);
  };
  const afford = (credits: number, minerals = 0) => view.treasury.credits >= credits && view.treasury.minerals >= minerals;
  const completed = view.production.completed[0];
  if (completed && view.ships.length < MAX_CAMPAIGN_SHIPS) return { ...fields, kind: 'deployProduction', orderId: completed.id, systemId: completed.systemId };
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
  const survey = view.galaxy.systems.filter(system => system.visibility === 'explored' && !system.ownerId &&
    !Object.prototype.hasOwnProperty.call(view.environmentKnowledge, system.id) &&
    !view.enemies.some(enemy => enemy.systemId === system.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
  if (survey && afford(view.surveyCost.credits, view.surveyCost.minerals)) {
    return { ...fields, kind: 'survey', systemId: survey.id };
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
    const colonizer = ship.design.hullId === 'colonizer';
    if (colonizer && founding?.quote.ok && !view.enemies.some(enemy => enemy.systemId === ship.systemId)) {
      return { ...fields, kind: 'colonize', systemId: ship.systemId, shipId: ship.id };
    }
    const home = colonies.some(system => system.id === ship.systemId), maximum = createOperationalState(ship.design);
    const operation = view.operations[String(ship.id)];
    if (home && operation.hull < maximum.hull * 0.8) {
      const missing = maximum.hull - operation.hull;
      if (afford(Math.ceil(missing / 10), Math.ceil(missing / 25))) return { ...fields, kind: 'repairShip', systemId: ship.systemId, shipId: ship.id };
    }
    const rounds = maximum.ammunition.reduce((sum, weapon) => sum + weapon.amount - operation.ammunition.find(item => item.slotId === weapon.slotId)!.amount, 0);
    if (home && rounds && afford(rounds, rounds)) return { ...fields, kind: 'resupplyShip', systemId: ship.systemId, shipId: ship.id };
    const capabilities = getTravelCapabilities(ship.design.strategicEquipment);
    if (home && ship.fuel < capabilities.fuelCapacity) {
      const quote = getStrategicRefuelQuote(ship.fuel, capabilities.fuelCapacity);
      if (afford(quote.cost.credits, quote.cost.minerals)) return { ...fields, kind: 'refuelShip', systemId: ship.systemId, shipId: ship.id };
    }
    if (!ship.fuel) continue;
    const distance = (id: string) => getWorldDistance(view.galaxy.systems, ship.systemId, id);
    const compare = (left: { id: string }, right: { id: string }) => distance(left.id) - distance(right.id) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const reachable = view.galaxy.systems.filter(system =>
      getTravelQuote(distance(system.id), capabilities, ship.fuel).ok);
    const targets = reachable.filter(system => {
      const mission = system.visibility === 'unknown' ? potentialUnknownTarget(system.id)
        : system.habitable && (colonizer ? !system.ownerId && !view.enemies.some(enemy => enemy.systemId === system.id)
          : !!system.ownerId && system.ownerId !== factionId);
      return mission && (home || system.visibility !== 'unknown' ||
        hasReturnReserve(ship.systemId, system.id, capabilities, ship.fuel));
    }).sort(compare);
    const nearest = targets.filter(target => distance(target.id) === distance(targets[0].id));
    const rank = view.ships.filter(other => other.id < ship.id).length;
    let destination = nearest.length ? nearest[rank % nearest.length] : undefined;
    if (!home && !destination) {
      destination = reachable.filter(system => colonies.some(colony => colony.id === system.id)).sort(compare)[0];
    }
    if (destination) {
      return { ...fields, kind: 'sendShip', systemId: ship.systemId, shipId: ship.id, destinationId: destination.id };
    }
  }
  const orders = view.production.orders, completedRecords = view.production.completed;
  const allRecords = [...view.ships, ...orders, ...completedRecords];
  const source = colonies.find(system => orders.filter(order => order.systemId === system.id).length < 3);
  const colonizationTargets = view.galaxy.systems.filter(system => system.visibility === 'unknown'
    ? potentialUnknownTarget(system.id) : system.habitable && system.ownerId === null);
  const fullReach = (design: ShipDesign, from: string, to: string) => {
    const caps = getTravelCapabilities(design.strategicEquipment);
    return getTravelQuote(getWorldDistance(view.galaxy.systems, from, to), caps, caps.fuelCapacity).ok;
  };
  const hasActiveColonizer = view.ships.some(ship => {
    if (ship.design.hullId !== 'colonizer') return false;
    const caps = getTravelCapabilities(ship.design.strategicEquipment);
    const position = ship.transit?.destinationId ?? ship.systemId;
    const atColony = colonies.some(colony => colony.id === position);
    const arrival = ship.transit && view.galaxy.systems.find(world => world.id === position);
    // Arrival restores observation and permits survey of a previously detected, unstudied world.
    if (arrival?.visibility === 'unknown' && view.environmentKnowledge[position] !== 'barren') return true;
    const reachable = (from: string, to: string, availableFuel: number) =>
      getTravelQuote(getWorldDistance(view.galaxy.systems, from, to), caps, availableFuel).ok;
    return colonizationTargets.some(target => target.id === position ||
      reachable(position, target.id, ship.fuel) && (atColony || target.visibility !== 'unknown' ||
        hasReturnReserve(position, target.id, caps, ship.fuel)) ||
      colonies.some(colony => (colony.id === position || reachable(position, colony.id, ship.fuel)) &&
        reachable(colony.id, target.id, caps.fuelCapacity)));
  });
  const hasProductionColonizer = [...orders, ...completedRecords].some(record => record.design.hullId === 'colonizer' &&
    colonizationTargets.some(target => fullReach(record.design, record.systemId, target.id)));
  if (source && colonizationTargets.length && !hasActiveColonizer && !hasProductionColonizer) {
    const design = { ...createColonizerDesign(), strategicEquipment: getAiStrategicEquipment(view.research, view.researchTree, true) },
      quote = getColonyProductionQuote(design, view.colonyOutput.rules);
    if (colonizationTargets.some(target => fullReach(design, source.id, target.id)) && afford(quote.cost.credits + 5, quote.cost.minerals)) {
      return { ...fields, kind: 'enqueueProduction', systemId: source.id, design };
    }
  }
  const combatRecords = allRecords.filter(record => record.design.hullId !== 'colonizer');
  const desired = getTravelCapabilities(getAiStrategicEquipment(view.research, view.researchTree, true));
  const needsUpgrade = combatRecords.length > 0 && combatRecords.every(record => {
    const caps = getTravelCapabilities(record.design.strategicEquipment);
    return caps.maxJumpDistance < desired.maxJumpDistance || caps.fuelCapacity < desired.fuelCapacity;
  });
  if (colonies.length && (combatRecords.length < 4 || needsUpgrade && combatRecords.length < 8)) {
    const designs = buildConquestDesigns(view.research, view.researchTree).filter(design => {
      const caps = getTravelCapabilities(design.strategicEquipment);
      if (needsUpgrade && (caps.maxJumpDistance < desired.maxJumpDistance || caps.fuelCapacity < desired.fuelCapacity)) return false;
      const quote = getColonyProductionQuote(design, view.colonyOutput.rules);
      return afford(quote.cost.credits + 5, quote.cost.minerals);
    }).map(design => ({ design, value: calculateConquestDesignScore(design,
      { credits: view.treasury.credits - 5, minerals: view.treasury.minerals }) }))
      .sort((left, right) => right.value.score - left.value.score ||
        (left.design.id < right.design.id ? -1 : left.design.id > right.design.id ? 1 : 0));
    const colony = colonies.find(system => orders.filter(order => order.systemId === system.id).length < 3);
    if (designs[0] && colony) return { ...fields, kind: 'enqueueProduction', systemId: colony.id, design: designs[0].design };
  }
  const terraform = view.terraforming.find(candidate => candidate.quote.ok &&
    view.population.some(colony => colony.systemId === candidate.systemId &&
      (colony.reason === 'at-capacity' || colony.reason === 'over-capacity')) &&
    !view.production.orders.some(order => order.systemId === candidate.systemId) &&
    !view.workProjects.some(project => project.systemId === candidate.systemId));
  if (terraform?.quote.ok && afford(terraform.quote.cost.credits + 5, terraform.quote.cost.minerals)) {
    return { ...fields, kind: 'startTerraform', systemId: terraform.systemId };
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
      if (command.kind === 'endTurn' || getConquestOutcome(state).status === 'completed') return { ...result, ...(frames ? { frames } : {}),
        ...(notices.length ? { notices } : {}), ...(workforceAdjustments.length ? { workforceAdjustments } : {}) };
    }
    return { ok: false, code: 'RULE_REJECTED', message: 'Превышен бюджет AI-хода' };
  } catch { return { ok: false, code: 'INVALID_STATE', message: 'Не удалось выполнить AI-ход' }; }
}