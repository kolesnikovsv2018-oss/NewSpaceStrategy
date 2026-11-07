import { z } from 'zod';
import type { GalaxyMap } from './galaxyMap';
import { MAX_PARTICIPANTS } from './galaxyMap';
import { participantIdSchema, systemIdSchema, getGalaxyDefinition, getCampaignParticipants, getParticipantColor,
  type ParticipantId, type SystemId } from './campaign';
import { getActiveParticipant } from './campaignSchedule';
import { conquestSessionSchema, createConquestSession, executeConquestSessionCommand, getConquestSessionView,
  conquestSessionCommandSchema, MAX_TURN, type ConquestSessionView, type SessionErrorCode } from './campaignSession';
import { treasurySchema, type Treasury } from './campaignEconomy';
import { researchTreeSchema, researchStateSchema, researchIdSchema, createResearchState, getDefaultResearchTree,
  isResearchStateValid, isCampaignDesignAvailable, isCampaignDraftAvailable, calculateResearchTurn,
  getStrategicRange, hasColonizationAccess, type ResearchTurnReceipt } from './campaignResearch';
import { operationalStateSchema, createOperationalState, readOperationalState, getRepairQuote, getAmmunitionQuote,
  getRefitQuote, getRefitOperationalState } from './campaignOperations';
import { designSchema } from './shipDesign';
import { resolveConquestBattle, type BattleFrame } from './conquestBattle';
import type { CampaignShip } from './campaignShips';
import { conquestProjectsSchema, createConquestProjects, conquestProjectCommandSchema, editConquestProject,
  type ProjectErrorCode } from './campaignProjects';
import { createDefaultRulesSnapshot, rulesSnapshotSchema, ruleIdentifierSchema } from './campaignRules';
import { diplomacyStateSchema, createInitialDiplomacyState, proposeDiplomacy, acceptDiplomacyProposal,
  declineDiplomacyProposal, withdrawDiplomacyProposal, declareDiplomacyWar, declareWarByCapture, recordPeaceBattle,
  hasActiveArmistice, grantCoopBonus, computeCultureTransfer, recordDiplomacyContact, getDiplomacyOwnView,
  advanceDiplomacyRound, diplomacyProposalKindSchema, diplomacyPayloadSchema, DIPLOMACY_PROPOSAL_ID_LIMIT,
  type DiplomacyFactionId } from './campaignDiplomacy';
import { populationStateSchema, createPopulation, advancePopulation, populationGrowth, getPopulationTechnologyForecast, quoteFounding, transferSettlers,
  type FoundingErrorCode } from './campaignPopulation';
import { advanceConquestColonyOutput, calculateColonyEndTurnBudget, conquestColonyOutputStateSchema,
  createConquestColonyOutputState,
  getConquestColonyOutputForecast, getColonyProductionQuote, getColonyProjectRefund,
  colonyWorkQueue, reduceWorkforce, validateConquestColonyOutputState, workforceSchema, emptyWorkforce,
  type ConquestColonyOutputForecast, type Workforce } from './campaignOutput';
import { MAX_ORDER_ID } from './production';
import { MAX_CAMPAIGN_SHIPS } from './campaignShips';
import { MAX_CAMPAIGN_FLEETS, MAX_FLEET_ID } from './campaignFleets';
import { getColonyWorldType, getCompletedColonyEffects, isColonyEffect } from './campaignColonyEffects';
import { isWorldInRange, getTravelCapabilities, STRATEGIC_TRAVEL_POLICY } from './campaignTravel';
import { createColonizerDesign } from './civilianPresets';
import { environmentStateSchema, getEnvironmentType, type EnvironmentState } from './worldEnvironment';
import { conquestControlSchema } from './campaignControl';
export { conquestControlSchema, getConquestControllerKind, type ConquestControl } from './campaignControl';

export const conquestVictorySchema = z.object({ kind: z.literal('all-planets-v1') }).strict();
export const conquestBattlePolicySchema = z.enum(['campaign-v1', 'campaign-v2']);
export type ConquestOutcome = { status: 'ongoing' } | { status: 'completed'; winner: ParticipantId; reason: 'all-planets' };
export interface WorkforceAdjustment {
  systemId: SystemId;
  populationBefore: number;
  populationAfter: number;
  before: Workforce;
  after: Workforce;
}
export interface ConquestTurnReceipt {
  completedWorldProjectIds: number[];
  cancelledWorldProjectIds: number[];
  factionId: ParticipantId;
  turn: number;
  population: number;
  populationIncome: Treasury;
  miningMinerals: number;
  populationUpkeepCredits: number;
  shipUpkeepCredits: number;
  creditsPaid: number;
  creditsShortfall: number;
  productionPoints: number;
  reserves: ConquestColonyOutputForecast['reserves'];
  research: ResearchTurnReceipt;
  completedProductionIds: number[];
  workforceAdjustments: WorkforceAdjustment[];
  treasuryAfter: Treasury;
}
const battleReportSchema = z.object({ id: z.number().int().positive().max(MAX_TURN), turn: z.number().int().positive().max(MAX_TURN),
  tacticalRules: z.literal('design-combat-v1'),
  systemId: systemIdSchema, winner: participantIdSchema.nullable(), timedOut: z.boolean(),
  participants: z.array(z.object({ id: z.number().int().positive(), factionId: participantIdSchema }).strict()).max(200),
  destroyed: z.array(z.number().int().positive()).max(200) }).strict();
export const participantMetadataSchema = z.object({
  id: participantIdSchema,
  name: z.string().min(1).max(80),
  color: z.number().int().min(0).max(0xffffff)
}).strict();
export type ParticipantMetadata = z.infer<typeof participantMetadataSchema>;

export const conquestSchema = z.object({
  scenario: z.literal('conquest-v1'), victory: conquestVictorySchema, control: conquestControlSchema,
  battlePolicy: conquestBattlePolicySchema,
  tacticalRules: z.literal('design-combat-v1'),
  participants: z.array(participantMetadataSchema).min(2).max(MAX_PARTICIPANTS),
  session: conquestSessionSchema, projects: conquestProjectsSchema, researchTree: researchTreeSchema,
  rules: rulesSnapshotSchema.refine(rules => rules.effects.every(isColonyEffect), 'Нет игрового исполнителя эффекта'),
  population: populationStateSchema,
  environment: environmentStateSchema,
  surveys: z.record(participantIdSchema, environmentStateSchema),
  colonyOutput: conquestColonyOutputStateSchema,
  research: z.record(participantIdSchema, researchStateSchema),
  researchJournal: z.record(participantIdSchema,
    z.record(researchIdSchema, z.number().int().min(1).max(MAX_TURN))),
  operations: z.record(operationalStateSchema), seed: z.number().int().min(1).max(0xffffffff),
  lastBattleId: z.number().int().min(0).max(MAX_TURN), battles: z.array(battleReportSchema).max(12),
  diplomacy: diplomacyStateSchema,
}).strict().superRefine((state, context) => {
  const fail = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'Нарушена целостность военной кампании' });
  const worlds = state.session.galaxy.systems;
  const refs = getCampaignParticipants(state.session.galaxy);
  const participants = refs.map(participant => participant.id);
  const sameKeys = (record: Record<string, unknown>) =>
    Object.keys(record).sort().join('\n') === [...participants].sort().join('\n');
  // Ровно участники кампании: никаких чужих или недостающих ключей в любом record.
  if (!sameKeys(state.surveys) || !sameKeys(state.research) || !sameKeys(state.researchJournal) ||
    !sameKeys(state.projects) || !sameKeys(state.colonyOutput.reserves)) { fail(); return; }
  if (state.participants.length !== refs.length || state.participants.some((metadata, index) =>
    metadata.id !== participants[index] || metadata.name !== refs[index].name ||
    metadata.color !== getParticipantColor(index))) { fail(); return; }
  if (Object.keys(state.environment).length !== worlds.length ||
    worlds.some(world => !Object.prototype.hasOwnProperty.call(state.environment, world.id))) { fail(); return; }
  for (const faction of participants) {
    if (Object.keys(state.surveys[faction]).some(id => !worlds.some(world => world.id === id))) fail();
  }
  if (worlds.some(world => world.ownerId !== null && (getEnvironmentType(state.environment, world.id) === 'barren' ||
    !Object.prototype.hasOwnProperty.call(state.surveys[world.ownerId], world.id)))) fail();
  const inhabited = worlds.filter(system => getEnvironmentType(state.environment, system.id) !== 'barren');
  if (Object.keys(state.population).length !== inhabited.length ||
    inhabited.some(system => !Object.prototype.hasOwnProperty.call(state.population, system.id))) { fail(); return; }
  if (state.rules.treeId !== state.researchTree.id) fail();
  const references = new Set(state.researchTree.nodes.flatMap(node => node.effects.flatMap(effect =>
    effect.kind === 'colony-effect' ? [effect.effectId] : [])));
  if (state.rules.effects.length !== references.size ||
    state.rules.effects.some(effect => !references.has(effect.id))) fail();
  const buildingUnlocks = new Map<string, string>();
  for (const node of state.researchTree.nodes) for (const effect of node.effects)
    if (effect.kind === 'building-unlock') {
      if (buildingUnlocks.has(effect.buildingId)) fail();
      buildingUnlocks.set(effect.buildingId, node.id);
    }
  if (state.rules.buildings.some(def => buildingUnlocks.get(def.id) !== def.unlockResearchId)) fail();
  if (participants.some(faction => !isResearchStateValid(state.research[faction], state.researchTree))) { fail(); return; }
  for (const faction of participants) {
    const journal = state.researchJournal[faction];
    if (Object.keys(journal).length !== state.research[faction].completed.length ||
      state.research[faction].completed.some(id => !Object.prototype.hasOwnProperty.call(journal, id)) ||
      Object.values(journal).some(turn => turn > state.session.schedule.turn)) fail();
  }
  if (Object.keys(state.operations).length !== state.session.ships.length) fail();
  if (state.session.production.orders.length || state.session.production.completed.length) fail();
  try {
    validateConquestColonyOutputState(state.colonyOutput, state.session.galaxy, state.population,
      state.session.production.lastOrderId, state.rules.colonyOutput, state.rules.buildings, participants);
  } catch { fail(); }
  const outputRecordIds = new Set([...state.colonyOutput.production.orders, ...state.colonyOutput.production.completed, ...state.colonyOutput.projects]
    .map(record => record.id));
  const terraformed = new Set<string>();
  const refitted = new Set<number>();
  for (const project of state.colonyOutput.projects) {
    if (project.kind === 'refit') {
      const ship = state.session.ships.find(ship => ship.id === project.shipId && ship.systemId === project.systemId &&
        ship.factionId === project.factionId);
      if (!ship || ship.transit || refitted.has(project.shipId) ||
        state.session.fleets.items.some(fleet => fleet.shipIds.includes(project.shipId)) ||
        !isCampaignDesignAvailable(project.design, state.research[project.factionId], state.researchTree)) { fail(); continue; }
      refitted.add(project.shipId);
      try {
        if (getTravelCapabilities(project.design.strategicEquipment).fuelCapacity < ship.fuel) fail();
        const quote = getRefitQuote(ship.design, project.design, state.rules.colonyOutput.productionCreditsPerPoint);
        getRefitOperationalState(ship.design, project.design, state.operations[String(ship.id)]);
        if (quote.cost.credits !== project.cost.credits || quote.cost.minerals !== project.cost.minerals ||
          quote.productionCost !== project.productionCost) fail();
      } catch { fail(); }
      continue;
    }
    if (project.kind === 'building') {
      const def = state.rules.buildings.find(item => item.id === project.buildingId);
      if (!def || def.cost.credits !== project.cost.credits || def.cost.minerals !== project.cost.minerals ||
        def.productionCost !== project.productionCost ||
        !state.research[project.factionId].completed.includes(def.unlockResearchId)) fail();
      continue;
    }
    const rule = state.rules.terraforming;
    if (!Object.prototype.hasOwnProperty.call(state.environment, project.systemId)) { fail(); continue; }
    if (terraformed.has(project.systemId) || state.population[project.systemId]?.population === 0 ||
      project.source !== getEnvironmentType(state.environment, project.systemId) ||
      project.target !== rule.target || project.cost.credits !== rule.cost.credits ||
      project.cost.minerals !== rule.cost.minerals || project.productionCost !== rule.productionCost ||
      !terraformUnlocked(state, project.factionId)) fail();
    terraformed.add(project.systemId);
  }
  if (state.session.ships.some(ship => outputRecordIds.has(ship.id))) fail();
  for (const ship of state.session.ships) {
    try { readOperationalState(state.operations[String(ship.id)], ship.design); } catch { fail(); }
    if (!isCampaignDesignAvailable(ship.design, state.research[ship.factionId], state.researchTree)) fail();
  }
  for (const record of [...state.colonyOutput.production.orders, ...state.colonyOutput.production.completed]) {
    if (!isCampaignDesignAvailable(record.design, state.research[record.factionId], state.researchTree)) fail();
  }
  for (const faction of participants) {
    // Каталог Н05а содержит только собственные проекты участника-ключа.
    if (state.projects[faction].items.some(project => project.factionId !== faction)) fail();
    for (const project of state.projects[faction].items) {
      if (!isCampaignDraftAvailable(project.design, state.research[faction], state.researchTree)) fail();
    }
  }
  if (new Set(state.battles.map(battle => battle.id)).size !== state.battles.length || state.battles.some(battle =>
    !state.session.galaxy.systems.some(system => system.id === battle.systemId) ||
    battle.id > state.lastBattleId || battle.turn >= state.session.schedule.turn ||
    new Set(battle.participants.map(ship => ship.id)).size !== battle.participants.length ||
    new Set(battle.destroyed).size !== battle.destroyed.length ||
    battle.destroyed.some(id => !battle.participants.some(ship => ship.id === id)))) fail();
});
export type Conquest = z.infer<typeof conquestSchema>;
export type ConquestErrorCode = SessionErrorCode | ProjectErrorCode | FoundingErrorCode | 'CONTROLLER_FORBIDDEN' | 'CAMPAIGN_COMPLETED' | 'RULE_REJECTED' | 'COLONIZER_REQUIRED' |
  'NOT_SURVEYED' | 'ALREADY_SURVEYED' | 'ADAPTATION_REQUIRED' | 'DIPLOMACY_NO_CONTACT' | 'DIPLOMACY_PENDING_LIMIT' |
  'DIPLOMACY_EXCHANGE_EMPTY' | 'DIPLOMACY_EXCHANGE_LIMIT' | 'DIPLOMACY_INSUFFICIENT_TREASURY' | 'DIPLOMACY_WAR_STATE' |
  'DIPLOMACY_PEACE_STATE' | 'DIPLOMACY_PROPOSAL_NOT_FOUND' | 'DIPLOMACY_NOT_RECIPIENT' | 'DIPLOMACY_NOT_AUTHOR' |
  'DIPLOMACY_NOT_PENDING' | 'DIPLOMACY_PROPOSAL_EXPIRED' | 'DIPLOMACY_TREASURY_LIMIT';
const diplomacyCommandErrors: Record<string, ConquestErrorCode> = {
  'no-contact': 'DIPLOMACY_NO_CONTACT',
  'not-at-war': 'DIPLOMACY_PEACE_STATE',
  'war-blocks-coop': 'DIPLOMACY_WAR_STATE',
  'already-at-war': 'DIPLOMACY_WAR_STATE',
  'pending-limit': 'DIPLOMACY_PENDING_LIMIT',
  'exchange-empty': 'DIPLOMACY_EXCHANGE_EMPTY',
  'exchange-invalid': 'DIPLOMACY_EXCHANGE_EMPTY',
  'exchange-limit': 'DIPLOMACY_EXCHANGE_LIMIT',
  'insufficient-treasury': 'DIPLOMACY_INSUFFICIENT_TREASURY',
  'not-found': 'DIPLOMACY_PROPOSAL_NOT_FOUND',
  'not-recipient': 'DIPLOMACY_NOT_RECIPIENT',
  'not-author': 'DIPLOMACY_NOT_AUTHOR',
  'not-pending': 'DIPLOMACY_NOT_PENDING',
  'expired': 'DIPLOMACY_PROPOSAL_EXPIRED',
};
export type FoundingNotice = { factionId: ParticipantId; systemId: SystemId; code: FoundingErrorCode };
export type ConquestResult = { ok: true; state: Conquest; frames?: BattleFrame[]; notices?: FoundingNotice[];
  workforceAdjustments?: WorkforceAdjustment[]; turnReceipt?: ConquestTurnReceipt } |
  { ok: false; code: ConquestErrorCode; message: string };
const fields = { factionId: participantIdSchema, expectedTurn: z.number().int().min(1).max(MAX_TURN) };
export const conquestCommandSchema = z.union([
  z.object({ ...fields, kind: z.literal('startRefit'), systemId: systemIdSchema,
    shipId: z.number().int().positive().max(MAX_ORDER_ID), design: designSchema }).strict(),
  z.object({ ...fields, kind: z.literal('startTerraform'), systemId: systemIdSchema }).strict(),
  z.object({ ...fields, kind: z.literal('startBuilding'), systemId: systemIdSchema,
    buildingId: ruleIdentifierSchema }).strict(),
  z.object({ ...fields, kind: z.literal('demolishBuilding'), systemId: systemIdSchema,
    buildingId: ruleIdentifierSchema }).strict(),
  z.object({ ...fields, kind: z.literal('cancelColonyProject'), systemId: systemIdSchema,
    projectId: z.number().int().positive().max(MAX_ORDER_ID) }).strict(),
  z.object({ ...fields, kind: z.literal('survey'), systemId: systemIdSchema }).strict(),
  z.object({ ...fields, kind: z.literal('colonize'), systemId: systemIdSchema,
    shipId: z.number().int().positive().max(MAX_ORDER_ID) }).strict(),
  conquestProjectCommandSchema,
  ...conquestSessionCommandSchema.options.filter(command => command.shape.kind.value !== 'colonize'),
  z.object({ ...fields, kind: z.literal('assignWorkers'), systemId: systemIdSchema, workers: workforceSchema }).strict(),
  z.object({ ...fields, kind: z.literal('research'), technologyId: researchIdSchema }).strict(),
  z.object({ ...fields, kind: z.literal('pauseResearch') }).strict(),
  z.object({ ...fields, kind: z.enum(['repairShip', 'resupplyShip']), shipId: z.number().int().positive().max(MAX_TURN), systemId: systemIdSchema }).strict(),
  z.object({ ...fields, kind: z.literal('proposeDiplomacy'), offerKind: diplomacyProposalKindSchema,
    payload: diplomacyPayloadSchema.nullable().default(null) }).strict(),
  z.object({ ...fields, kind: z.literal('acceptDiplomacy'),
    proposalId: z.number().int().min(1).max(DIPLOMACY_PROPOSAL_ID_LIMIT) }).strict(),
  z.object({ ...fields, kind: z.literal('declineDiplomacy'),
    proposalId: z.number().int().min(1).max(DIPLOMACY_PROPOSAL_ID_LIMIT) }).strict(),
  z.object({ ...fields, kind: z.literal('withdrawDiplomacy'),
    proposalId: z.number().int().min(1).max(DIPLOMACY_PROPOSAL_ID_LIMIT) }).strict(),
  z.object({ ...fields, kind: z.literal('declareWar') }).strict()
]);
export type ConquestCommand = z.infer<typeof conquestCommandSchema>;

function terraformUnlocked(state: { research: Record<string, { completed: string[] }>;
  researchTree: { nodes: { id: string; effects: { kind: string }[] }[] } }, faction: ParticipantId): boolean {
  return state.researchTree.nodes.some(node => state.research[faction].completed.includes(node.id) &&
    node.effects.some(effect => effect.kind === 'terraform-unlock'));
}

function terraformAvailability(state: Conquest, faction: ParticipantId, systemId: SystemId) {
  if (state.session.galaxy.systems.find(world => world.id === systemId)?.ownerId !== faction) {
    return { ok: false as const, reason: 'Нужна собственная колония' };
  }
  if (getEnvironmentType(state.environment, systemId) !== state.rules.terraforming.source ||
    state.population[systemId].population === 0) return { ok: false as const, reason: 'Нужна населённая токсичная колония' };
  if (!terraformUnlocked(state, faction)) return { ok: false as const, reason: 'Терраформирование ещё не изучено' };
  if (state.colonyOutput.projects.some(project => project.kind === 'terraform' && project.systemId === systemId)) {
    return { ok: false as const, reason: 'Проект мира уже поставлен в очередь' };
  }
  return { ok: true as const, ...structuredClone(state.rules.terraforming) };
}

function buildingAvailability(state: Conquest, faction: ParticipantId, systemId: SystemId, buildingId: string) {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (state.session.galaxy.systems.find(world => world.id === systemId)?.ownerId !== faction) {
    return fail('Нужна собственная колония');
  }
  if (state.population[systemId]?.population === 0) return fail('Нужна населённая колония');
  const def = state.rules.buildings.find(item => item.id === buildingId);
  if (!def) return fail('Здание отсутствует в каталоге правил');
  if (!state.research[faction].completed.includes(def.unlockResearchId)) return fail('Здание ещё не изучено');
  if (!def.worlds.includes(getColonyWorldType(state.session.galaxy, systemId, state.environment))) {
    return fail('Среда мира несовместима со зданием');
  }
  const installed = state.colonyOutput.buildings[systemId] ?? [];
  const current = installed.find(entry => entry.buildingId === buildingId)?.level ?? 0;
  const pending = state.colonyOutput.projects.filter(project => project.kind === 'building' &&
    project.systemId === systemId);
  if (current + pending.filter(project => project.kind === 'building' && project.buildingId === buildingId).length >=
    def.maxLevels) return fail('Достигнут предел уровней здания');
  if (pending.some(project => project.kind === 'building' && project.buildingId === buildingId)) {
    return fail('Проект здания уже поставлен в очередь');
  }
  if (installed.reduce((sum, entry) => sum + entry.level, 0) + pending.length >=
    state.rules.colonyOutput.colonyBuildingSlots) {
    return fail('Достигнут предел мест зданий колонии');
  }
  return { ok: true as const, def: structuredClone(def) };
}

class ConquestRuleError extends Error {
  constructor(message: string, readonly code: ConquestErrorCode = 'RULE_REJECTED') { super(message); }
}

/** Н17.2: `createConquest` создаёт казны, знания, исследования, каталоги и стартовые корабли для всех участников карты. */
export function createConquest(control: unknown = { mode: 'local' }, tree: unknown = getDefaultResearchTree(), seed = 1, map?: GalaxyMap): Conquest {
  const session = createConquestSession(map), rules = createDefaultRulesSnapshot(), researchTree = researchTreeSchema.parse(tree);
  const participants = getCampaignParticipants(session.galaxy);
  const population = createPopulation(session.galaxy, rules.population);
  const snapshot = session.galaxy.map;
  const environment: EnvironmentState = Object.fromEntries(getGalaxyDefinition(session.galaxy).systems.map(world => [
    world.id, snapshot ? snapshot.worlds.find(item => item.id === world.id)!.type : world.habitable ? 'habitable' : 'barren'
  ]));
  const surveys: Record<string, EnvironmentState> = Object.fromEntries(participants.map(p => [p.id, {}]));
  for (const world of session.galaxy.systems) if (world.ownerId) surveys[world.ownerId][world.id] = environment[world.id];
  const operations: Record<string, ReturnType<typeof createOperationalState>> = {};
  for (const participant of participants) {
    const id = ++session.production.lastOrderId, design = createColonizerDesign();
    session.ships.push({ id, factionId: participant.id, systemId: participant.homeSystemId, design, fuel: getTravelCapabilities(design.strategicEquipment).fuelCapacity });
    operations[String(id)] = createOperationalState(design);
  }
  const references = new Set(researchTree.nodes.flatMap(node => node.effects.flatMap(effect =>
    effect.kind === 'colony-effect' ? [effect.effectId] : [])));
  rules.effects = rules.effects.filter(effect => isColonyEffect(effect) && references.has(effect.id));
  rules.treeId = researchTree.id;
  return conquestSchema.parse({ scenario: 'conquest-v1', victory: { kind: 'all-planets-v1' }, control,
    battlePolicy: 'campaign-v2', tacticalRules: 'design-combat-v1',
    participants: participants.map((participant, index) => ({ id: participant.id, name: participant.name, color: getParticipantColor(index) })),
    session, rules, population, environment, surveys,
    colonyOutput: createConquestColonyOutputState(session.galaxy, population, participants.map(p => p.id)),
    projects: createConquestProjects(participants.map(p => p.id)), researchTree,
    research: Object.fromEntries(participants.map(p => [p.id, createResearchState()])),
    researchJournal: Object.fromEntries(participants.map(p => [p.id, {}])),
    operations, seed, lastBattleId: 0, battles: [],
    diplomacy: createInitialDiplomacyState() });
}

export function getConquestOutcome(state: Conquest): ConquestOutcome {
  const planets = getGalaxyDefinition(state.session.galaxy).systems.filter(system => system.habitable);
  for (const { id: winner } of getCampaignParticipants(state.session.galaxy)) if (planets.every(planet =>
    state.session.galaxy.systems.find(system => system.id === planet.id)?.ownerId === winner)) {
    return { status: 'completed', winner, reason: 'all-planets' };
  }
  return { status: 'ongoing' };
}

export function visibleConquestSystems(state: Conquest, faction: ParticipantId): Set<SystemId> {
  const visible = new Set(state.session.galaxy.systems.filter(system => system.ownerId === faction).map(system => system.id));
  for (const ship of state.session.ships) {
    if (ship.factionId !== faction || ship.transit) continue;
    visible.add(ship.systemId);
    if (ship.design.slots.some(slot => slot.component?.kind === 'scanner' && slot.component.range > 0 && slot.component.accuracy > 0)) {
      for (const system of getGalaxyDefinition(state.session.galaxy).systems) {
        if (isWorldInRange(getGalaxyDefinition(state.session.galaxy).systems, ship.systemId, system.id,
          getStrategicRange(state.research[faction], state.researchTree, state.rules))) visible.add(system.id);
      }
    }
  }
  return visible;
}

function colonizationAvailability(state: Conquest, faction: ParticipantId, systemId: SystemId,
  visible: ReadonlySet<SystemId>, shipId?: number) {
  const fail = (code: ConquestErrorCode, message: string) => ({ ok: false as const, code, message });
  if (!visible.has(systemId)) return fail('OUT_OF_REACH', 'Нет текущего наблюдения: нужен корабль или разрешённый сканер');
  if (!Object.prototype.hasOwnProperty.call(state.surveys[faction], systemId)) return fail('NOT_SURVEYED', 'Сначала изучите среду мира');
  const world = state.session.galaxy.systems.find(world => world.id === systemId)!;
  if (world.ownerId) return fail('OCCUPIED', 'Мир уже занят колонией');
  const type = getEnvironmentType(state.environment, systemId);
  if (type === 'barren') return fail('UNINHABITABLE', 'Эта среда недоступна для основания колонии');
  if (state.session.ships.some(ship => ship.systemId === systemId && !ship.transit && ship.factionId !== faction)) {
    return fail('RULE_REJECTED', 'Основание блокируется вражеским присутствием');
  }
  const colonizer = state.session.ships.filter(ship => ship.factionId === faction && ship.systemId === systemId &&
    !ship.transit && ship.design.hullId === 'colonizer' && (shipId === undefined || ship.id === shipId))
    .sort((a, b) => a.id - b.id)[0];
  if (!colonizer) return fail('COLONIZER_REQUIRED', 'Нужен свой стоящий корабль-колонизатор');
  if (!hasColonizationAccess(type, state.research[faction], state.researchTree)) {
    return fail('ADAPTATION_REQUIRED', 'Нужна технология адаптации к токсичной среде');
  }
  const quote = quoteFounding(state.session.galaxy, state.population, faction, systemId,
    state.session.treasuries[faction], state.rules.population);
  if (!quote.ok) return fail(quote.code, quote.code === 'NO_SETTLERS' ? 'Нет своей колонии с достаточным населением'
    : 'Для основания не хватает кредитов или минералов');
  return { ...quote, shipId: colonizer.id };
}

export function getConquestView(input: unknown, faction: ParticipantId) {
  const state = conquestSchema.parse(input);
  const side = participantIdSchema.parse(faction);
  const view: ConquestSessionView = getConquestSessionView(state.session, side);
  const mined = miningYield(state, side, true);
  const effects = getCompletedColonyEffects(state.researchTree, state.research[side], state.rules);
  const outputForecast = getConquestColonyOutputForecast(state.session.galaxy, state.population, state.colonyOutput, side,
    state.rules.colonyOutput, state.session.ships.filter(ship => ship.factionId === side).length, effects, state.environment,
    state.rules.buildings, state.session.treasuries[side]);
  const researchForecast = forecastResearch(state, side, outputForecast);
  view.income = { credits: outputForecast.income.credits, minerals: outputForecast.income.minerals + mined };
  const baseBudget = state.session.schedule.turn === MAX_TURN ? { ok: false as const, code: 'TURN_LIMIT' as const }
    : calculateColonyEndTurnBudget(state.session.treasuries[side], outputForecast);
  if (baseBudget.ok) {
    baseBudget.treasuryAfter.minerals += mined;
    if (!treasurySchema.safeParse(baseBudget.treasuryAfter).success) view.economyForecast = { ok: false, code: 'RESOURCE_LIMIT' };
    else view.economyForecast = { ...baseBudget, income: { credits: outputForecast.income.credits,
      minerals: outputForecast.income.minerals + mined } };
  } else view.economyForecast = baseBudget;
  const visible = visibleConquestSystems(state, side);
  const environmentKnowledge = structuredClone(state.surveys[side]);
  for (const id of visible) if (Object.prototype.hasOwnProperty.call(environmentKnowledge, id)) {
    environmentKnowledge[id] = getEnvironmentType(state.environment, id);
  }
  view.galaxy.systems = view.galaxy.systems.map(system => {
    if (!visible.has(system.id)) return { id: system.id, name: system.name, x: system.x, y: system.y, visibility: 'unknown' as const };
    const ownerId = state.session.galaxy.systems.find(world => world.id === system.id)!.ownerId;
    const known = environmentKnowledge[system.id];
    return { ...system, visibility: 'explored' as const, ownerId, habitable: known !== undefined && known !== 'barren' };
  });
  const population = view.galaxy.systems.filter(system => system.visibility === 'explored' && system.ownerId === side).map(system => ({
    systemId: system.id, population: state.population[system.id].population, remainder: state.population[system.id].remainder,
    worldType: getColonyWorldType(state.session.galaxy, system.id, state.environment),
    technology: getPopulationTechnologyForecast(state.rules.population, getColonyWorldType(state.session.galaxy, system.id, state.environment), effects),
    ...populationGrowth(state.population[system.id], state.rules.population,
      getColonyWorldType(state.session.galaxy, system.id, state.environment), effects)
  }));
  const colonization = view.galaxy.systems.filter(system => system.visibility === 'explored' && !system.ownerId)
    .map(system => ({ systemId: system.id, quote: colonizationAvailability(state, side, system.id, visible) }));
  const { lanes: _lanes, ...galaxy } = view.galaxy;
  return { ...view, galaxy, strategicRange: getStrategicRange(state.research[side], state.researchTree, state.rules), production: {
    orders: structuredClone(state.colonyOutput.production.orders.filter(record => record.factionId === side)),
    completed: structuredClone(state.colonyOutput.production.completed.filter(record => record.factionId === side))
  },
    colonyOutput: { assignments: Object.fromEntries(outputForecast.production.map(row => [row.systemId,
      { population: state.population[row.systemId].population, ...row.workers }])),
      reserves: structuredClone(state.colonyOutput.reserves[side]),
      reserveCaps: { research: outputForecast.reserves.research.cap, culture: outputForecast.reserves.culture.cap },
      forecast: outputForecast, rules: state.rules.colonyOutput },
    workProjects: structuredClone(state.colonyOutput.projects.filter(project => project.factionId === side)),
    terraforming: population.map(world => ({ systemId: world.systemId, quote: terraformAvailability(state, side, world.systemId) })),
    population, colonization, foundingCost: { ...state.rules.population.foundingCost },
    knownSystems: state.session.galaxy.systems.filter(system => system.exploredBy.includes(side)).map(system => system.id),
    knownHabitableSystems: Object.entries(environmentKnowledge).filter(([, type]) => type !== 'barren').map(([id]) => id),
    environmentKnowledge,
    surveyCost: { ...state.rules.planetology.surveyCost },
    projects: structuredClone(state.projects[side].items), researchTree: state.researchTree, research: state.research[side],
    colonyTechnologyEffects: state.rules.effects, buildings: state.rules.buildings,
    researchJournal: Object.entries(state.researchJournal[side]).map(([technologyId, turn]) => ({
      technologyId, turn, activationTurn: turn <= MAX_TURN - 2 ? turn + 2 : null
    })).sort((a, b) => a.turn - b.turn || (a.technologyId < b.technologyId ? -1 : a.technologyId > b.technologyId ? 1 : 0)),
    researchForecast: { timing: researchForecast.timing, receipt: researchForecast.receipt },
    operations: Object.fromEntries(view.ships.map(ship => [String(ship.id), state.operations[String(ship.id)]])),
    canCreateFleet: state.session.fleets.lastFleetId < MAX_FLEET_ID && view.fleets.length < MAX_CAMPAIGN_FLEETS,
    enemies: state.session.ships.filter(ship => ship.factionId !== side && !ship.transit && visible.has(ship.systemId))
      .map(ship => ({ id: ship.id, systemId: ship.systemId, factionId: ship.factionId, hullId: ship.design.hullId })),
    battles: state.battles.filter(battle => battle.participants.some(ship => ship.factionId === side)),
    diplomacy: getDiplomacyOwnView(state.diplomacy, diplomacySideOf(side, state), state.rules.diplomacy),
    totalHabitableWorlds: getGalaxyDefinition(state.session.galaxy).systems.filter(system => system.habitable).length,
    outcome: getConquestOutcome(state) };
}
export type ConquestView = ReturnType<typeof getConquestView>;

function forecastResearch(state: Conquest, faction: ParticipantId, output: ConquestColonyOutputForecast, coopBonus = 0) {
  const science = output.reserves.research;
  const result = calculateResearchTurn(state.research[faction], state.researchTree, science.current,
    science.produced + coopBonus, science.cap, output.production.length > 0);
  if (state.session.schedule.turn === MAX_TURN) result.timing = { status: 'unavailable', reason: 'turn-limit' };
  else if (getConquestOutcome(state).status === 'completed') result.timing = { status: 'unavailable', reason: 'campaign-completed' };
  Object.assign(science, { accepted: result.receipt.accepted, spent: result.receipt.spent,
    overflow: result.receipt.overflow, after: result.receipt.reserveAfter });
  return result;
}

function armed(ship: CampaignShip): boolean {
  return ship.design.slots.some(slot => slot.component?.kind === 'beam' || slot.component?.kind === 'projectile');
}
function reveal(state: Conquest): void {
  for (const faction of getCampaignParticipants(state.session.galaxy).map(participant => participant.id)) {
    const visible = visibleConquestSystems(state, faction);
    for (const id of visible) {
      const system = state.session.galaxy.systems.find(item => item.id === id)!;
      if (!system.exploredBy.includes(faction)) system.exploredBy.push(faction);
      if (Object.prototype.hasOwnProperty.call(state.surveys[faction], id)) {
        state.surveys[faction][id] = getEnvironmentType(state.environment, id);
      }
      if (system.ownerId !== null && system.ownerId !== faction) recordDiplomacyContact(state.diplomacy, diplomacySideOf(faction, state));
    }
    if (state.session.ships.some(ship => ship.factionId !== faction && !ship.transit && visible.has(ship.systemId))) {
      recordDiplomacyContact(state.diplomacy, diplomacySideOf(faction, state));
    }
  }
}
function debit(state: Conquest, faction: ParticipantId, credits: number, minerals: number,
  code: ConquestErrorCode = 'RULE_REJECTED'): void {
  const treasury = state.session.treasuries[faction];
  if (treasury.credits < credits || treasury.minerals < minerals) throw new ConquestRuleError('Недостаточно ресурсов', code);
  treasury.credits -= credits; treasury.minerals -= minerals;
}
function miningYield(state: Conquest, faction: ParticipantId, forecast = false): number {
  return state.session.ships.filter(ship => ship.factionId === faction &&
    (!ship.transit || forecast && ship.transit.remainingTurns === 1) &&
    state.surveys[faction][ship.transit?.destinationId ?? ship.systemId] === 'barren' &&
    getEnvironmentType(state.environment, ship.transit?.destinationId ?? ship.systemId) === 'barren').reduce((total, ship) => total +
      Math.floor(Math.min(10, ship.design.slots.reduce((sum, slot) => sum +
        (slot.component?.kind === 'mining' ? slot.component.miningSpeed * slot.component.efficiency : 0), 0))), 0);
}
function foundColony(state: Conquest, faction: ParticipantId, target: SystemId): {
  quote: ReturnType<typeof quoteFounding>;
  workforceAdjustment?: WorkforceAdjustment;
} {
  const quote = quoteFounding(state.session.galaxy,
    state.population, faction, target, state.session.treasuries[faction], state.rules.population);
  let workforceAdjustment: WorkforceAdjustment | undefined;
  if (quote.ok) {
    const populationBefore = state.population[quote.sourceId].population;
    const before = structuredClone(state.colonyOutput.assignments[quote.sourceId]);
    debit(state, faction, quote.cost.credits, quote.cost.minerals);
    transferSettlers(state.population, quote.sourceId, target, state.rules.population);
    const populationAfter = state.population[quote.sourceId].population;
    const after = reduceWorkforce(before, populationAfter);
    state.colonyOutput.assignments[quote.sourceId] = after;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      workforceAdjustment = { systemId: quote.sourceId, populationBefore, populationAfter, before, after };
    }
  }
  return { quote, ...(workforceAdjustment ? { workforceAdjustment } : {}) };
}
/**
 * До Н17.4 дипломатия Н16 сохраняет принятую однопарную семантику: её состояние адресуется
 * сторонам blue/red, а граница conquest отображает участников позиционно (индекс 0 → blue,
 * остальные → red). Н17.4 переведёт дипломатию на пары участников.
 */
function diplomacySideOf(participant: ParticipantId, state: Conquest): DiplomacyFactionId {
  return getCampaignParticipants(state.session.galaxy).findIndex(item => item.id === participant) === 0 ? 'blue' : 'red';
}

function settleEncounters(state: Conquest, turn: number): BattleFrame[] | undefined {
  let frames: BattleFrame[] | undefined;
  for (const definition of getGalaxyDefinition(state.session.galaxy).systems) {
    let present = state.session.ships.filter(ship => !ship.transit && ship.systemId === definition.id);
    if (new Set(present.map(ship => ship.factionId)).size > 1) {
      if (hasActiveArmistice(state.diplomacy)) continue;
      if (state.lastBattleId === MAX_TURN) throw new ConquestRuleError('Достигнут предел идентификаторов боёв');
      const seed = ((state.seed ^ Math.imul(turn, 2654435761) ^ (state.lastBattleId + 1)) >>> 0) || 1;
      const result = resolveConquestBattle(present, state.operations, seed, state.battlePolicy);
      frames = result.frames;
      if (!state.diplomacy.war) recordPeaceBattle(state.diplomacy, diplomacySideOf(present[0].factionId, state));
      state.battles.push({ id: ++state.lastBattleId, tacticalRules: 'design-combat-v1', turn, systemId: definition.id, winner: result.winner,
        timedOut: result.timedOut, participants: present.map(ship => ({ id: ship.id, factionId: ship.factionId })), destroyed: result.destroyed });
      state.battles = state.battles.slice(-12);
      state.session.ships = state.session.ships.filter(ship => !result.destroyed.includes(ship.id));
      for (const id of result.destroyed) delete state.operations[String(id)];
      for (const survivor of result.survivors) state.operations[String(survivor.id)] = survivor.operational;
      for (const fleet of state.session.fleets.items) fleet.shipIds = fleet.shipIds.filter(id => !result.destroyed.includes(id));
      state.session.fleets.items = state.session.fleets.items.filter(fleet => fleet.shipIds.length >= 2);
      present = state.session.ships.filter(ship => !ship.transit && ship.systemId === definition.id);
    }
    const sides = new Set(present.map(ship => ship.factionId));
    if (getEnvironmentType(state.environment, definition.id) !== 'barren' && sides.size === 1 && present.some(armed) &&
      state.session.galaxy.systems.find(system => system.id === definition.id)!.ownerId !== null) {
      if (hasActiveArmistice(state.diplomacy)) continue;
      const owner = present[0].factionId;
      const system = state.session.galaxy.systems.find(item => item.id === definition.id)!;
      const previousOwner = system.ownerId;
      system.ownerId = owner;
      state.surveys[owner][system.id] = getEnvironmentType(state.environment, system.id);
      if (!system.exploredBy.includes(owner)) system.exploredBy.push(owner);
      if (previousOwner !== owner) {
        if (!state.diplomacy.war) declareWarByCapture(state.diplomacy, diplomacySideOf(owner, state), state.rules.diplomacy);
        state.colonyOutput.projects = state.colonyOutput.projects.filter(project => project.systemId !== system.id);
        state.colonyOutput.assignments[system.id] = emptyWorkforce();
        state.colonyOutput.production.orders = state.colonyOutput.production.orders
          .filter(record => record.systemId !== system.id || record.factionId === owner);
        state.colonyOutput.production.completed = state.colonyOutput.production.completed
          .filter(record => record.systemId !== system.id || record.factionId === owner);
      }
    }
  }
  return frames;
}

function runColonyProductionCommand(state: Conquest,
  command: Extract<ConquestCommand, { kind: 'enqueueProduction' | 'cancelProduction' | 'deployProduction' }>): void {
  const { factionId, systemId } = command;
  if (state.session.galaxy.systems.find(system => system.id === systemId)?.ownerId !== factionId) {
    throw new ConquestRuleError('Производство доступно только в своей колонии', 'NOT_OWN_COLONY');
  }
  const production = state.colonyOutput.production;
  if (command.kind === 'enqueueProduction') {
    let quote;
    try { quote = getColonyProductionQuote(command.design, state.rules.colonyOutput); } catch {
      throw new ConquestRuleError('Нужен допустимый полётный проект', 'INVALID_DESIGN');
    }
    if (colonyWorkQueue(state.colonyOutput, systemId).length >= 3) {
      throw new ConquestRuleError('Очередь колонии заполнена', 'QUEUE_FULL');
    }
    if ([...production.orders, ...production.completed, ...state.colonyOutput.projects].filter(record => record.factionId === factionId).length >= 100) {
      throw new ConquestRuleError('Достигнут предел производственных записей стороны', 'PRODUCTION_LIMIT');
    }
    if (state.session.production.lastOrderId === MAX_ORDER_ID) {
      throw new ConquestRuleError('Достигнут предел идентификаторов заказов', 'ORDER_ID_LIMIT');
    }
    const treasury = state.session.treasuries[factionId];
    if (treasury.credits < quote.cost.credits || treasury.minerals < quote.cost.minerals) {
      throw new ConquestRuleError('Недостаточно ресурсов для полной оплаты проекта', 'INSUFFICIENT_RESOURCES');
    }
    treasury.credits -= quote.cost.credits;
    treasury.minerals -= quote.cost.minerals;
    const id = ++state.session.production.lastOrderId;
    production.orders.push({ id, factionId, systemId, design: structuredClone(command.design),
      cost: quote.cost, productionCost: quote.productionCost, productionProgress: 0 });
    return;
  }
  if (command.kind === 'cancelProduction') {
    const index = production.orders.findIndex(order => order.id === command.orderId &&
      order.factionId === factionId && order.systemId === systemId);
    if (index < 0) throw new ConquestRuleError('Заказ не найден в очереди колонии', 'ORDER_NOT_FOUND');
    // Возврат зависит только от цены/прогресса записи и не зависит от идентичности стороны.
    const refund = getColonyProjectRefund(production.orders[index]);
    const next = { credits: state.session.treasuries[factionId].credits + refund.credits,
      minerals: state.session.treasuries[factionId].minerals + refund.minerals };
    if (!treasurySchema.safeParse(next).success) {
      throw new ConquestRuleError('Возврат превысит предел ресурсов; заказ не отменён', 'RESOURCE_LIMIT');
    }
    state.session.treasuries[factionId] = next;
    production.orders.splice(index, 1);
    return;
  }
  const index = production.completed.findIndex(record => record.id === command.orderId &&
    record.factionId === factionId && record.systemId === systemId);
  if (index < 0) throw new ConquestRuleError('Готовый проект не найден в колонии', 'COMPLETED_NOT_FOUND');
  if (state.session.ships.filter(ship => ship.factionId === factionId).length >= MAX_CAMPAIGN_SHIPS) {
    throw new ConquestRuleError('Достигнут предел стратегических кораблей стороны', 'SHIP_LIMIT');
  }
  const [completed] = production.completed.splice(index, 1);
  state.session.ships.push({ ...completed, fuel: getTravelCapabilities(completed.design.strategicEquipment).fuelCapacity });
  state.operations[String(completed.id)] = createOperationalState(completed.design);
}

export function executeConquestCommand(input: unknown, payload: unknown): ConquestResult {
  return executeConquestAction(input, payload, false);
}

export function executeConquestAction(input: unknown, payload: unknown, automated: boolean): ConquestResult {
  try {
    const parsedState = conquestSchema.safeParse(input);
    if (!parsedState.success) return { ok: false, code: 'INVALID_STATE', message: 'Недопустимое состояние военной кампании' };
    const parsedCommand = conquestCommandSchema.safeParse(payload);
    if (!parsedCommand.success) return { ok: false, code: 'INVALID_COMMAND', message: 'Недопустимая команда военной кампании' };
    const state = parsedState.data, command = parsedCommand.data;
    const faction = command.factionId;
    if (command.expectedTurn !== state.session.schedule.turn) throw new ConquestRuleError('Номер хода изменился', 'STALE_TURN');
    if (faction !== getActiveParticipant(state.session.schedule)) throw new ConquestRuleError('Сейчас ход другой стороны', 'NOT_ACTIVE_FACTION');
    // Авторизация по контролю до действий: человек не командует AI-стороной, AI — человеческой.
    if (state.control.mode === 'campaign' && (automated ? faction === state.control.human : faction !== state.control.human)) {
      throw new ConquestRuleError('Команда недоступна этому контроллеру', 'CONTROLLER_FORBIDDEN');
    }
    if (getConquestOutcome(state).status === 'completed') throw new ConquestRuleError('Партия завершена', 'CAMPAIGN_COMPLETED');
    if (('systemId' in command && !state.session.galaxy.systems.some(system => system.id === command.systemId)) ||
      ('destinationId' in command && !state.session.galaxy.systems.some(system => system.id === command.destinationId))) {
      throw new ConquestRuleError('Система отсутствует на карте партии');
    }
    let frames: BattleFrame[] | undefined;
    const notices: FoundingNotice[] = [];
    const workforceAdjustments: WorkforceAdjustment[] = [];
    let turnReceipt: ConquestTurnReceipt | undefined;
    if (command.kind === 'sendShip' || command.kind === 'createFleet') {
      const ids = command.kind === 'sendShip' ? [command.shipId] : command.shipIds;
      if (state.colonyOutput.projects.some(project => project.kind === 'refit' && ids.includes(project.shipId))) {
        throw new ConquestRuleError('Корабль зарезервирован для переоснащения');
      }
    }
    if (command.kind === 'startRefit') {
      if (state.session.galaxy.systems.find(world => world.id === command.systemId)?.ownerId !== faction) {
        throw new ConquestRuleError('Переоснащение только в своей колонии', 'NOT_OWN_COLONY');
      }
      const ship = state.session.ships.find(ship => ship.id === command.shipId && ship.factionId === faction && ship.systemId === command.systemId);
      if (!ship) throw new ConquestRuleError('Свой корабль не найден', 'SHIP_NOT_FOUND');
      if (ship.transit) throw new ConquestRuleError('Корабль уже в пути', 'SHIP_IN_TRANSIT');
      if (state.session.fleets.items.some(fleet => fleet.shipIds.includes(ship.id))) throw new ConquestRuleError('Сначала расформируйте группу', 'SHIP_IN_FLEET');
      if (state.colonyOutput.projects.some(project => project.kind === 'refit' && project.shipId === ship.id)) {
        throw new ConquestRuleError('Переоснащение уже поставлено в очередь');
      }
      if (!isCampaignDesignAvailable(command.design, state.research[faction], state.researchTree) || command.design.hullId !== ship.design.hullId) {
        throw new ConquestRuleError('Нужен доступный полётный проект того же корпуса', 'INVALID_DESIGN');
      }
      const quote = getRefitQuote(ship.design, command.design, state.rules.colonyOutput.productionCreditsPerPoint);
      if (getTravelCapabilities(command.design.strategicEquipment).fuelCapacity < ship.fuel) {
        throw new ConquestRuleError('Новый бак меньше текущего запаса топлива', 'INVALID_DESIGN');
      }
      getRefitOperationalState(ship.design, command.design, state.operations[String(ship.id)]);
      if (colonyWorkQueue(state.colonyOutput, command.systemId).length >= 3) throw new ConquestRuleError('Общая очередь заполнена', 'QUEUE_FULL');
      if ([...state.colonyOutput.projects, ...state.colonyOutput.production.orders, ...state.colonyOutput.production.completed]
        .filter(item => item.factionId === faction).length >= 100) throw new ConquestRuleError('Достигнут предел работ', 'PRODUCTION_LIMIT');
      if (state.session.production.lastOrderId === MAX_ORDER_ID) throw new ConquestRuleError('Достигнут предел ID', 'ORDER_ID_LIMIT');
      debit(state, faction, quote.cost.credits, quote.cost.minerals, 'INSUFFICIENT_RESOURCES');
      state.colonyOutput.projects.push({ kind: 'refit', id: ++state.session.production.lastOrderId, shipId: ship.id,
        factionId: faction, systemId: command.systemId, design: structuredClone(command.design),
        cost: quote.cost, productionCost: quote.productionCost, productionProgress: 0 });
    } else if (command.kind === 'startTerraform' || command.kind === 'cancelColonyProject') {
      if (state.session.galaxy.systems.find(world => world.id === command.systemId)?.ownerId !== faction) {
        throw new ConquestRuleError('Нужна собственная колония', 'NOT_OWN_COLONY');
      }
      if (command.kind === 'cancelColonyProject') {
        const project = state.colonyOutput.projects.find(item => item.id === command.projectId &&
          item.systemId === command.systemId && item.factionId === faction);
        if (!project) throw new ConquestRuleError('Работа не найдена', 'ORDER_NOT_FOUND');
        const refund = getColonyProjectRefund(project), treasury = state.session.treasuries[faction];
        const next = { credits: treasury.credits + refund.credits, minerals: treasury.minerals + refund.minerals };
        if (!treasurySchema.safeParse(next).success) throw new ConquestRuleError('Возврат превысит предел ресурсов', 'RESOURCE_LIMIT');
        state.session.treasuries[faction] = next;
        state.colonyOutput.projects = state.colonyOutput.projects.filter(item => item.id !== project.id);
      } else {
        const quote = terraformAvailability(state, faction, command.systemId);
        if (!quote.ok) throw new ConquestRuleError(quote.reason);
        if (colonyWorkQueue(state.colonyOutput, command.systemId).length >= 3) throw new ConquestRuleError('Общая очередь заполнена', 'QUEUE_FULL');
        if ([...state.colonyOutput.projects, ...state.colonyOutput.production.orders, ...state.colonyOutput.production.completed]
          .filter(item => item.factionId === faction).length >= 100) throw new ConquestRuleError('Достигнут предел работ', 'PRODUCTION_LIMIT');
        if (state.session.production.lastOrderId === MAX_ORDER_ID) throw new ConquestRuleError('Достигнут предел ID', 'ORDER_ID_LIMIT');
        debit(state, faction, quote.cost.credits, quote.cost.minerals, 'INSUFFICIENT_RESOURCES');
        state.colonyOutput.projects.push({ kind: 'terraform', id: ++state.session.production.lastOrderId,
          factionId: faction, systemId: command.systemId, source: quote.source, target: quote.target,
          cost: quote.cost, productionCost: quote.productionCost, productionProgress: 0 });
      }
    } else if (command.kind === 'startBuilding' || command.kind === 'demolishBuilding') {
      if (state.session.galaxy.systems.find(world => world.id === command.systemId)?.ownerId !== faction) {
        throw new ConquestRuleError('Нужна собственная колония', 'NOT_OWN_COLONY');
      }
      if (command.kind === 'startBuilding') {
        const quote = buildingAvailability(state, faction, command.systemId, command.buildingId);
        if (!quote.ok) throw new ConquestRuleError(quote.reason);
        if (colonyWorkQueue(state.colonyOutput, command.systemId).length >= 3) {
          throw new ConquestRuleError('Общая очередь заполнена', 'QUEUE_FULL');
        }
        if ([...state.colonyOutput.projects, ...state.colonyOutput.production.orders, ...state.colonyOutput.production.completed]
          .filter(item => item.factionId === faction).length >= 100) {
          throw new ConquestRuleError('Достигнут предел работ', 'PRODUCTION_LIMIT');
        }
        if (state.session.production.lastOrderId === MAX_ORDER_ID) {
          throw new ConquestRuleError('Достигнут предел ID', 'ORDER_ID_LIMIT');
        }
        debit(state, faction, quote.def.cost.credits, quote.def.cost.minerals, 'INSUFFICIENT_RESOURCES');
        state.colonyOutput.projects.push({ kind: 'building', id: ++state.session.production.lastOrderId,
          factionId: faction, systemId: command.systemId, buildingId: command.buildingId,
          cost: quote.def.cost, productionCost: quote.def.productionCost, productionProgress: 0 });
      } else {
        const levels = state.colonyOutput.buildings[command.systemId] ?? [];
        const entry = levels.find(item => item.buildingId === command.buildingId);
        if (!entry) throw new ConquestRuleError('Здание не установлено в колонии', 'ORDER_NOT_FOUND');
        const def = state.rules.buildings.find(item => item.id === command.buildingId);
        if (!def) throw new ConquestRuleError('Здание отсутствует в каталоге правил');
        const refund = { credits: Math.floor(def.cost.credits / 2), minerals: Math.floor(def.cost.minerals / 2) };
        const treasury = state.session.treasuries[faction];
        const next = { credits: treasury.credits + refund.credits, minerals: treasury.minerals + refund.minerals };
        if (!treasurySchema.safeParse(next).success) {
          throw new ConquestRuleError('Возврат превысит предел ресурсов', 'RESOURCE_LIMIT');
        }
        state.session.treasuries[faction] = next;
        const nextLevel = entry.level - 1;
        state.colonyOutput.buildings[command.systemId] = nextLevel === 0
          ? levels.filter(item => item.buildingId !== command.buildingId)
          : levels.map(item => item.buildingId === command.buildingId ? { ...item, level: nextLevel } : item);
      }
    } else if (command.kind === 'createProject'  || command.kind === 'copyProject' || command.kind === 'renameProject' ||
      command.kind === 'replaceProject' || command.kind === 'deleteProject') {
      if ((command.kind === 'createProject' || command.kind === 'replaceProject') &&
        !isCampaignDraftAvailable(command.design, state.research[faction], state.researchTree)) {
        throw new ConquestRuleError('Черновик требует доступный корпус, семейства и параметры оборудования', 'INVALID_DESIGN');
      }
      const result = editConquestProject(state.projects, command);
      if (!result.ok) return result;
      state.projects = result.projects;
    } else if (command.kind === 'research') {
      const research = state.research[faction], node = state.researchTree.nodes.find(item => item.id === command.technologyId);
      if (!node || research.completed.includes(node.id) || !node.prerequisites.every(id => research.completed.includes(id))) {
        throw new ConquestRuleError('Исследование недоступно');
      }
      research.activeId = node.id;
      if (!Object.prototype.hasOwnProperty.call(research.progress, node.id)) research.progress[node.id] = 0;
    } else if (command.kind === 'pauseResearch') {
      state.research[faction].activeId = null;
    } else if (command.kind === 'repairShip' || command.kind === 'resupplyShip') {
      const ship = state.session.ships.find(item => item.id === command.shipId && item.systemId === command.systemId && item.factionId === faction);
      if (!ship || ship.transit) throw new ConquestRuleError('Нет своего стоящего корабля');
      const home = state.session.galaxy.systems.some(system => system.id === ship.systemId && system.ownerId === faction);
      const repairRate = state.session.ships.filter(item => !item.transit && item.factionId === faction && item.systemId === ship.systemId)
        .flatMap(item => item.design.slots).reduce((sum, slot) => sum + (slot.component?.kind === 'repair' ? slot.component.repairRate : 0), 0);
      const operation = state.operations[String(ship.id)], maximum = createOperationalState(ship.design);
      if (command.kind === 'repairShip') {
        const quote = getRepairQuote(ship.design, operation, home, repairRate);
        if (quote.amount <= 0) throw new ConquestRuleError('Ремонт недоступен или корпус цел');
        debit(state, faction, quote.cost.credits, quote.cost.minerals);
        operation.hull += quote.amount;
      } else {
        if (!home) throw new ConquestRuleError('Боезапас пополняется только в своей колонии');
        const quote = getAmmunitionQuote(ship.design, operation);
        if (!quote.amount) throw new ConquestRuleError('Боезапас уже полон');
        debit(state, faction, quote.cost.credits, quote.cost.minerals);
        operation.ammunition = maximum.ammunition;
      }
    } else if (command.kind === 'survey') {
      if (!visibleConquestSystems(state, faction).has(command.systemId)) throw new ConquestRuleError('Нужно текущее наблюдение корабля или сканера', 'OUT_OF_REACH');
      if (Object.prototype.hasOwnProperty.call(state.surveys[faction], command.systemId)) throw new ConquestRuleError('Среда уже изучена', 'ALREADY_SURVEYED');
      if (state.session.ships.some(ship => !ship.transit && ship.systemId === command.systemId && ship.factionId !== faction)) {
        throw new ConquestRuleError('Изучение блокируется вражеским присутствием');
      }
      const cost = state.rules.planetology.surveyCost, treasury = state.session.treasuries[faction];
      if (treasury.credits < cost.credits || treasury.minerals < cost.minerals) throw new ConquestRuleError('Для изучения среды не хватает ресурсов', 'INSUFFICIENT_RESOURCES');
      debit(state, faction, cost.credits, cost.minerals);
      state.surveys[faction][command.systemId] = getEnvironmentType(state.environment, command.systemId);
    } else if (command.kind === 'explore' || command.kind === 'colonize') {
      if (!visibleConquestSystems(state, faction).has(command.systemId)) throw new ConquestRuleError('Нужен корабль или сканер в зоне системы');
      const system = state.session.galaxy.systems.find(item => item.id === command.systemId)!;
      if (command.kind === 'colonize') {
        if (!('shipId' in command)) throw new ConquestRuleError('Выберите колонизатор', 'INVALID_COMMAND');
        const availability = colonizationAvailability(state, faction, system.id, visibleConquestSystems(state, faction), command.shipId);
        if (!availability.ok) throw new ConquestRuleError(availability.message, availability.code);
        const founding = foundColony(state, faction, system.id);
        if (!founding.quote.ok) throw new ConquestRuleError(founding.quote.code === 'NO_SETTLERS'
          ? 'Нет своей колонии с достаточным населением для переселения' : 'Для основания нужны кредиты и минералы', founding.quote.code);
        if (founding.workforceAdjustment) workforceAdjustments.push(founding.workforceAdjustment);
        system.ownerId = faction;
        state.session.ships = state.session.ships.filter(ship => ship.id !== availability.shipId);
        delete state.operations[String(availability.shipId)];
        for (const fleet of state.session.fleets.items) fleet.shipIds = fleet.shipIds.filter(id => id !== availability.shipId);
        state.session.fleets.items = state.session.fleets.items.filter(fleet => fleet.shipIds.length >= 2);
      }
      if (!system.exploredBy.includes(faction)) system.exploredBy.push(faction);
    } else if (command.kind === 'assignWorkers') {
      if (state.session.galaxy.systems.find(system => system.id === command.systemId)?.ownerId !== faction) {
        throw new ConquestRuleError('Назначать рабочих можно только в своей колонии', 'NOT_OWN_COLONY');
      }
      const assigned = command.workers.industry + command.workers.research + command.workers.culture;
      if (assigned > state.population[command.systemId].population) {
        throw new ConquestRuleError('Назначено больше рабочих, чем доступно населения');
      }
      state.colonyOutput.assignments[command.systemId] = { ...command.workers };
    } else if (command.kind === 'enqueueProduction' || command.kind === 'cancelProduction' || command.kind === 'deployProduction') {
      if (command.kind === 'enqueueProduction' &&
        !isCampaignDesignAvailable(command.design, state.research[faction], state.researchTree)) {
        throw new ConquestRuleError('Проект требует неоткрытые технологии или полётную готовность', 'INVALID_DESIGN');
      }
      runColonyProductionCommand(state, command);
    } else if (command.kind === 'proposeDiplomacy') {
      const proposalResult = proposeDiplomacy({ state: state.diplomacy, author: diplomacySideOf(faction, state), kind: command.offerKind,
        payload: command.payload, authorTreasury: state.session.treasuries[faction], rules: state.rules.diplomacy });
      if (!proposalResult.ok) throw new ConquestRuleError(proposalResult.reason, diplomacyCommandErrors[proposalResult.code] ?? 'RULE_REJECTED');
    } else if (command.kind === 'acceptDiplomacy') {
      const other: DiplomacyFactionId = diplomacySideOf(faction, state) === 'blue' ? 'red' : 'blue';
      const proposal = state.diplomacy.proposals.find(item => item.id === command.proposalId);
      if (proposal && proposal.kind === 'exchange' && proposal.payload) {
        // Ёмкость казни получателя проверяется до любых мутаций — обмен атомарен.
        const treasury = state.session.treasuries[faction];
        const next = { credits: treasury.credits + proposal.payload.credits,
          minerals: treasury.minerals + proposal.payload.minerals };
        if (!treasurySchema.safeParse(next).success) {
          throw new ConquestRuleError('Получение превысит предел ресурсов; обмен отклонён целиком', 'DIPLOMACY_TREASURY_LIMIT');
        }
      }
      const acceptResult = acceptDiplomacyProposal({ state: state.diplomacy, actor: diplomacySideOf(faction, state), proposalId: command.proposalId,
        authorTreasury: state.session.treasuries[other], rules: state.rules.diplomacy });
      if (!acceptResult.ok) throw new ConquestRuleError(acceptResult.reason, diplomacyCommandErrors[acceptResult.code] ?? 'RULE_REJECTED');
      if (acceptResult.transfer) {
        const authorTreasury = state.session.treasuries[other];
        authorTreasury.credits -= acceptResult.transfer.credits;
        authorTreasury.minerals -= acceptResult.transfer.minerals;
        const treasury = state.session.treasuries[faction];
        treasury.credits += acceptResult.transfer.credits;
        treasury.minerals += acceptResult.transfer.minerals;
        treasurySchema.parse(treasury);
      }
    } else if (command.kind === 'declineDiplomacy') {
      const declineResult = declineDiplomacyProposal(state.diplomacy, diplomacySideOf(faction, state), command.proposalId);
      if (!declineResult.ok) throw new ConquestRuleError(declineResult.reason, diplomacyCommandErrors[declineResult.code] ?? 'RULE_REJECTED');
    } else if (command.kind === 'withdrawDiplomacy') {
      const withdrawResult = withdrawDiplomacyProposal(state.diplomacy, diplomacySideOf(faction, state), command.proposalId);
      if (!withdrawResult.ok) throw new ConquestRuleError(withdrawResult.reason, diplomacyCommandErrors[withdrawResult.code] ?? 'RULE_REJECTED');
    } else if (command.kind === 'declareWar') {
      const warResult = declareDiplomacyWar(state.diplomacy, diplomacySideOf(faction, state), state.rules.diplomacy);
      if (!warResult.ok) throw new ConquestRuleError(warResult.reason, diplomacyCommandErrors[warResult.code] ?? 'RULE_REJECTED');
    } else {
      let turnForecast: ConquestColonyOutputForecast | undefined;
      let endTurnBudget: ReturnType<typeof calculateColonyEndTurnBudget> | undefined;
      const effects = getCompletedColonyEffects(state.researchTree, state.research[faction], state.rules);
      let treasuryBefore: Treasury | undefined;
      if (command.kind === 'endTurn' && state.session.schedule.turn !== MAX_TURN) {
        treasuryBefore = structuredClone(state.session.treasuries[faction]);
        turnForecast = getConquestColonyOutputForecast(state.session.galaxy, state.population, state.colonyOutput, faction,
          state.rules.colonyOutput, state.session.ships.filter(ship => ship.factionId === faction).length, effects,
          state.environment, state.rules.buildings, treasuryBefore);
        endTurnBudget = calculateColonyEndTurnBudget(state.session.treasuries[faction], turnForecast);
        if (!endTurnBudget.ok) throw new ConquestRuleError('Валовой доход превысит предел ресурсов; ход не завершён', 'RESOURCE_LIMIT');
      }
      const roundBefore = state.session.schedule.round;
      const result = executeConquestSessionCommand(state.session, command,
        endTurnBudget?.ok ? endTurnBudget : undefined, STRATEGIC_TRAVEL_POLICY);
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      state.session = result.state;
      if (command.kind === 'endTurn') {
        const endingProjectIds = state.colonyOutput.projects.filter(project => project.factionId === faction).map(project => project.id);
        const output = advanceConquestColonyOutput(state.colonyOutput, parsedState.data.session.galaxy,
          parsedState.data.population, faction, state.rules.colonyOutput,
          parsedState.data.session.ships.filter(ship => ship.factionId === faction).length, effects, state.environment,
          state.rules.buildings, treasuryBefore);
        const coop = grantCoopBonus(state.diplomacy, diplomacySideOf(faction, state), state.rules.diplomacy);
        const research = forecastResearch(parsedState.data, faction, output.forecast, coop.bonus);
        state.colonyOutput = output.state;
        state.colonyOutput.reserves[faction].research = research.receipt.reserveAfter;
        state.research[faction] = research.state;
        if (research.receipt.completedId) state.researchJournal[faction][research.receipt.completedId] = command.expectedTurn;
        const culturePoints = output.forecast.production.reduce((sum, item) => sum + item.culturePoints, 0);
        const cultureTransfer = computeCultureTransfer(state.diplomacy.influence[diplomacySideOf(faction, state)],
          culturePoints, state.rules.diplomacy);
        state.diplomacy.influence[diplomacySideOf(faction, state)] += cultureTransfer.influenceDelta;
        state.population = advancePopulation(parsedState.data.session.galaxy, state.population, faction, state.rules.population, effects, state.environment);
        const miningMinerals = miningYield(state, faction);
        state.session.treasuries[faction].minerals += miningMinerals;
        treasurySchema.parse(state.session.treasuries[faction]);
        frames = settleEncounters(state, command.expectedTurn);
        // Единая точка дипломатического раунда: endTurn последнего участника круга расписания.
        if (state.session.schedule.round > roundBefore) advanceDiplomacyRound(state.diplomacy);
        state.colonyOutput.projects = state.colonyOutput.projects.filter(project =>
          project.kind !== 'refit' || state.session.ships.some(ship => ship.id === project.shipId));
        const completedWorldProjectIds: number[] = [];
        for (const project of output.completedProjects) {
          if (project.kind === 'refit') {
            const ship = state.session.ships.find(ship => ship.id === project.shipId && ship.systemId === project.systemId);
            if (ship && state.session.galaxy.systems.find(world => world.id === project.systemId)?.ownerId === project.factionId) {
              state.operations[String(ship.id)] = getRefitOperationalState(ship.design, project.design, state.operations[String(ship.id)]);
              ship.design = structuredClone(project.design);
              completedWorldProjectIds.push(project.id);
            }
            continue;
          }
          if (project.kind === 'building') continue;
          if (state.session.galaxy.systems.find(world => world.id === project.systemId)?.ownerId === project.factionId &&
            getEnvironmentType(state.environment, project.systemId) === project.source && state.population[project.systemId].population > 0) {
            state.environment[project.systemId] = project.target;
            completedWorldProjectIds.push(project.id);
          }
        }
        turnReceipt = {
          completedWorldProjectIds,
          cancelledWorldProjectIds: endingProjectIds.filter(id => !completedWorldProjectIds.includes(id) &&
            !state.colonyOutput.projects.some(current => current.id === id)),
          factionId: faction, turn: command.expectedTurn, population: output.forecast.population,
          populationIncome: output.forecast.income, miningMinerals,
          populationUpkeepCredits: output.forecast.upkeep.populationCredits,
          shipUpkeepCredits: output.forecast.upkeep.shipCredits,
          creditsPaid: endTurnBudget?.ok ? endTurnBudget.upkeep.paidCredits : 0,
          creditsShortfall: endTurnBudget?.ok ? endTurnBudget.upkeep.shortfallCredits : 0,
          productionPoints: output.forecast.production.reduce((total, colony) => total + colony.productionPoints, 0),
          reserves: output.forecast.reserves, research: research.receipt, completedProductionIds: output.completedIds,
          workforceAdjustments: [...workforceAdjustments],
          treasuryAfter: { ...state.session.treasuries[faction] }
        };
      }
    }
    reveal(state);
    return { ok: true, state: conquestSchema.parse(state), ...(frames ? { frames } : {}), ...(notices.length ? { notices } : {}),
      ...(workforceAdjustments.length ? { workforceAdjustments } : {}), ...(turnReceipt ? { turnReceipt } : {}) };
  } catch (error) {
    return { ok: false, code: error instanceof ConquestRuleError ? error.code : 'INVALID_STATE',
      message: error instanceof ConquestRuleError ? error.message : 'Недопустимые данные военной кампании' };
  }
}

export function convertConquestToLocal(input: unknown): Conquest {
  const state = conquestSchema.parse(input);
  state.control = { mode: 'local' };
  return state;
}