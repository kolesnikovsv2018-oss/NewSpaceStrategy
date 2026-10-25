import { HULLS, createComponentWithId, calculateShipStats, validateDesign, withTacticalVariant, type ShipDesign, type ComponentDefinition } from './shipDesign';
import { COMBAT_SIMULATION_MAX_SECONDS, COMBAT_SIMULATION_MAX_STEPS, COMBAT_SIMULATION_STEP, getCombatCooldownSteps, getCombatApproachSeconds } from './combatSimulation';
import type { Treasury } from './campaignEconomy';
import { getCampaignVariantProfile, getCampaignVariantTier, getResearchAccess, isCampaignDesignAvailable, getResearchProgress, hasCompactEquipment,
  hasTacticalVariant, hasColonizationAccess, type ResearchState, type ResearchTree } from './campaignResearch';
import { getProductionQuote } from './production';
import { getColonyProductionQuote } from './campaignOutput';
import { createOperationalState } from './campaignOperations';
import { conquestSchema, executeConquestAction, getConquestOutcome, getConquestView, type ConquestCommand, type ConquestView, type ConquestResult } from './conquest';
import { factionIdSchema } from './campaign';
import type { BattleFrame } from './conquestBattle';
import { calculateColonyValue } from './campaignColonyEffects';
import { getWorldDistance, isWorldInRange, createStrategicEquipment, getTravelCapabilities,
  getTravelQuote, getFleetTravelQuotes, getStrategicRefuelQuote, type StrategicEquipment, type TravelCapabilities } from './campaignTravel';
import { createColonizerDesign } from './civilianPresets';
import { MAX_CAMPAIGN_SHIPS } from './campaignShips';
import { MAX_FLEET_SHIPS } from './campaignFleets';

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

type AiShip = ConquestView['ships'][number];
type AiWorld = ConquestView['galaxy']['systems'][number];
type ConquestMission = { kind: 'defend' | 'attack' | 'recon' | 'return'; destination: AiWorld; shipsNeeded: number } |
  { kind: 'hold' };

function hasCombatReadiness(view: ConquestView, ship: AiShip): boolean {
  const operation = view.operations[String(ship.id)];
  return ship.design.hullId !== 'colonizer' && operation.hull > 0 &&
    !view.workProjects.some(project => project.kind === 'refit' && project.shipId === ship.id) &&
    ship.design.slots.some(slot => slot.component?.kind === 'beam' ||
      slot.component?.kind === 'projectile' && operation.ammunition.some(weapon => weapon.slotId === slot.id && weapon.amount > 0));
}

function selectConquestRally(view: ConquestView): AiWorld | undefined {
  const ready = view.ships.filter(ship => !ship.transit && hasCombatReadiness(view, ship));
  const colonies = view.galaxy.systems.filter(world => world.visibility === 'explored' &&
    world.ownerId === view.galaxy.factionId);
  const objectives = view.galaxy.systems.filter(world => world.visibility === 'unknown'
    ? view.environmentKnowledge[world.id] !== 'barren'
    : world.ownerId !== null && world.ownerId !== view.galaxy.factionId);
  if (objectives.length < 2) return undefined;
  if (view.enemies.some(enemy => colonies.some(colony => colony.id === enemy.systemId))) return undefined;
  const occupied = colonies.filter(world => ready.some(ship => ship.systemId === world.id));
  if (occupied.length < 2) return undefined;
  return occupied.sort((left, right) =>
    ready.filter(ship => ship.systemId === right.id).length - ready.filter(ship => ship.systemId === left.id).length ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).find(world =>
    ready.some(ship => ship.systemId !== world.id &&
      getTravelQuote(getWorldDistance(view.galaxy.systems, ship.systemId, world.id),
        getTravelCapabilities(ship.design.strategicEquipment), ship.fuel).ok));
}

function selectConquestMission(view: ConquestView, ship: AiShip, reachable: readonly AiWorld[]): ConquestMission | undefined {
  const faction = view.galaxy.factionId;
  const combatShips = view.ships.filter(candidate => hasCombatReadiness(view, candidate));
  const arrivals = combatShips.filter(candidate => candidate.transit);
  const targets = view.galaxy.systems.filter(world =>
    world.visibility === 'explored' ? world.ownerId !== null && world.ownerId !== faction ||
      world.ownerId === faction && view.enemies.some(enemy => enemy.systemId === world.id)
      : view.environmentKnowledge[world.id] !== 'barren');
  const committed = (world: AiWorld) => view.ships.filter(candidate => candidate.transit?.destinationId === world.id).length;
  const combatCommitted = (world: AiWorld) => arrivals.filter(candidate => candidate.transit!.destinationId === world.id).length;
  const enemies = (world: AiWorld) => view.enemies.filter(enemy => enemy.systemId === world.id).length;
  const rank = (world: AiWorld) => world.visibility === 'explored' && world.ownerId === faction ? 0
    : enemies(world) > combatCommitted(world) ? 1 : committed(world) ? 3 : 2;
  const candidates = targets.filter(world => reachable.some(candidate => candidate.id === world.id));
  const target = candidates.sort((left, right) =>
    rank(left) - rank(right) || committed(left) - committed(right) ||
    (left.visibility === 'explored' ? 0 : view.environmentKnowledge[left.id] ? 1 : 2) -
      (right.visibility === 'explored' ? 0 : view.environmentKnowledge[right.id] ? 1 : 2) ||
    getWorldDistance(view.galaxy.systems, ship.systemId, left.id) - getWorldDistance(view.galaxy.systems, ship.systemId, right.id) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0];
  if (view.enemies.some(enemy => enemy.systemId === ship.systemId) &&
    view.galaxy.systems.some(world => world.id === ship.systemId && world.visibility === 'explored' && world.ownerId === faction)) {
    return { kind: 'hold' };
  }
  const rally = selectConquestRally(view);
  if (rally && rally.id !== ship.systemId && reachable.some(world => world.id === rally.id)) {
    return { kind: 'return', destination: rally, shipsNeeded: MAX_FLEET_SHIPS };
  }
  if (target) {
    const incoming = arrivals.filter(candidate => candidate.transit!.destinationId === ship.systemId);
    if (incoming.length) return { kind: 'hold' };
    const available = combatShips.filter(candidate => !candidate.transit && candidate.systemId === ship.systemId).length;
    const objectives = Math.max(1, candidates.filter(world => committed(world) === 0).length);
    const shipsNeeded = Math.max(1, enemies(target) - combatCommitted(target), Math.floor(available / objectives));
    return { kind: target.visibility === 'unknown' ? 'recon' : target.ownerId === faction ? 'defend' : 'attack',
      destination: target, shipsNeeded };
  }
  return undefined;
}

export function planConquestAction(view: ConquestView): ConquestCommand {
  const factionId = view.galaxy.factionId, expectedTurn = view.turn, fields = { factionId, expectedTurn };
  const colonies = view.galaxy.systems.filter(system => system.visibility === 'explored' && system.ownerId === factionId);
  const potentialUnknownTarget = (id: string) => view.environmentKnowledge[id] !== 'barren';
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
    const idleGrowth = workforce.industry > 0 && workforce.research === research && workforce.culture === culture &&
      view.colonyOutput.forecast.production.find(row => row.systemId === colony.id)!.orderId === undefined;
    if (idleGrowth) continue;
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
  const rally = selectConquestRally(view);
  const ships = rally ? [...view.ships].sort((left, right) =>
    Number(left.systemId === rally.id) - Number(right.systemId === rally.id)) : view.ships;
  for (const ship of ships) {
    if (ship.transit) continue;
    if (view.workProjects.some(project => project.kind === 'refit' && project.shipId === ship.id)) continue;
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
    const fleet = view.fleets.find(fleet => fleet.shipIds.includes(ship.id));
    if (!ship.fuel && !fleet) continue;
    if (fleet && fleet.shipIds[0] !== ship.id) continue;
    const members = fleet ? fleet.shipIds.map(id => view.ships.find(candidate => candidate.id === id)!) : [ship];
    if (fleet && members.some(member => !hasCombatReadiness(view, member))) {
      return { ...fields, kind: 'disbandFleet', fleetId: fleet.id, systemId: fleet.systemId };
    }
    if (fleet && home && members.some(member => {
      const maximum = createOperationalState(member.design), operation = view.operations[String(member.id)];
      const missing = maximum.hull - operation.hull;
      const rounds = maximum.ammunition.reduce((sum, weapon) =>
        sum + weapon.amount - operation.ammunition.find(item => item.slotId === weapon.slotId)!.amount, 0);
      const caps = getTravelCapabilities(member.design.strategicEquipment);
      const refuel = getStrategicRefuelQuote(member.fuel, caps.fuelCapacity);
      return operation.hull < maximum.hull * 0.8 && afford(Math.ceil(missing / 10), Math.ceil(missing / 25)) ||
        rounds > 0 && afford(rounds, rounds) || refuel.amount > 0 && afford(refuel.cost.credits, refuel.cost.minerals);
    })) continue;
    const distance = (id: string) => getWorldDistance(view.galaxy.systems, ship.systemId, id);
    const compare = (left: { id: string }, right: { id: string }) => distance(left.id) - distance(right.id) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const colonizationPriority = (world: AiWorld) => {
      const type = Object.prototype.hasOwnProperty.call(view.environmentKnowledge, world.id) ? view.environmentKnowledge[world.id] : undefined;
      if (type && !hasColonizationAccess(type, view.research, view.researchTree)) return 4;
      return world.visibility === 'explored' ? 0 : !type && !view.knownSystems.includes(world.id) ? 1 : type ? 2 : 3;
    };
    const reachable = view.galaxy.systems.filter(system => getFleetTravelQuotes(distance(system.id),
      members.map(member => ({ capabilities: getTravelCapabilities(member.design.strategicEquipment), fuel: member.fuel })))
      .every(item => item.quote.ok));
    const targets = reachable.filter(system => {
      const mission = system.visibility === 'unknown' ? potentialUnknownTarget(system.id)
        : colonizer ? system.habitable && !system.ownerId && !view.enemies.some(enemy => enemy.systemId === system.id)
          : !!system.ownerId && system.ownerId !== factionId;
      return mission && (home || system.visibility !== 'unknown' ||
        hasReturnReserve(ship.systemId, system.id, capabilities, ship.fuel));
    }).sort((left, right) => (colonizer ? colonizationPriority(left) - colonizationPriority(right) : 0) || compare(left, right));
    const nearest = targets.filter(target => distance(target.id) === distance(targets[0].id) &&
      (!colonizer || colonizationPriority(target) === colonizationPriority(targets[0])));
    const rank = view.ships.filter(other => other.id < ship.id).length;
    const mission = !colonizer && hasCombatReadiness(view, ship)
      ? selectConquestMission(view, ship, reachable.filter(system => home || system.visibility !== 'unknown' ||
        members.every(member => hasReturnReserve(member.systemId, system.id,
          getTravelCapabilities(member.design.strategicEquipment), member.fuel)))) : undefined;
    if (mission?.kind === 'hold') continue;
    if (fleet && mission && members.length > mission.shipsNeeded) {
      return { ...fields, kind: 'disbandFleet', fleetId: fleet.id, systemId: fleet.systemId };
    }
    let destination = mission?.destination ?? (colonizer && nearest.length ? nearest[rank % nearest.length] : undefined);
    if (!home && !destination) {
      destination = reachable.filter(system => colonies.some(colony => colony.id === system.id)).sort(compare)[0];
    }
    if (fleet && !destination && members.some(member => colonies.some(colony =>
      getTravelQuote(distance(colony.id), getTravelCapabilities(member.design.strategicEquipment), member.fuel).ok))) {
      return { ...fields, kind: 'disbandFleet', fleetId: fleet.id, systemId: fleet.systemId };
    }
    if (destination) {
      if (fleet) return { ...fields, kind: 'sendFleet', systemId: ship.systemId, fleetId: fleet.id, destinationId: destination.id };
      if (mission && view.canCreateFleet) {
        const partners = view.ships.filter(candidate => !candidate.transit && candidate.systemId === ship.systemId &&
          hasCombatReadiness(view, candidate) && !view.fleets.some(fleet => fleet.shipIds.includes(candidate.id)) &&
          getTravelQuote(distance(destination.id), getTravelCapabilities(candidate.design.strategicEquipment), candidate.fuel).ok &&
          (home || destination.visibility !== 'unknown' || hasReturnReserve(candidate.systemId, destination.id,
            getTravelCapabilities(candidate.design.strategicEquipment), candidate.fuel))).slice(0, Math.min(MAX_FLEET_SHIPS, mission.shipsNeeded));
        if (partners.length > 1) return { ...fields, kind: 'createFleet', systemId: ship.systemId, shipIds: partners.map(member => member.id) };
      }
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