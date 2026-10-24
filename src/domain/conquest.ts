import { z } from 'zod';
import type { GalaxyMap } from './galaxyMap';
import { factionIdSchema, systemIdSchema, getGalaxyDefinition, areSystemsAdjacent, type CampaignFactionId, type SystemId } from './campaign';
import { conquestSessionSchema, createCampaignSession, executeConquestSessionCommand, getConquestSessionView,
  sessionCommandSchema, MAX_TURN, type CampaignSessionView, type SessionErrorCode } from './campaignSession';
import { treasurySchema, type Treasury } from './campaignEconomy';
import { researchTreeSchema, researchStateSchema, researchIdSchema, createResearchState, getDefaultResearchTree,
  isResearchStateValid, isCampaignDesignAvailable, isCampaignDraftAvailable, calculateResearchTurn,
  type ResearchTurnReceipt } from './campaignResearch';
import { operationalStateSchema, createOperationalState, readOperationalState, getRepairQuote, getAmmunitionQuote } from './campaignOperations';
import { resolveConquestBattle, type BattleFrame } from './conquestBattle';
import type { CampaignShip } from './campaignShips';
import { campaignProjectsSchema, createCampaignProjects, projectCommandSchema, editCampaignProject,
  type ProjectErrorCode } from './campaignProjects';
import { createDefaultRulesSnapshot, rulesSnapshotSchema } from './campaignRules';
import { populationStateSchema, createPopulation, advancePopulation, populationGrowth, getPopulationTechnologyForecast, quoteFounding, transferSettlers,
  type FoundingErrorCode } from './campaignPopulation';
import { advanceColonyOutput, calculateColonyEndTurnBudget, colonyOutputStateSchema, createColonyOutputState,
  getColonyOutputForecast, getColonyProductionQuote, getColonyProductionRefund, reduceWorkforce,
  validateColonyOutputState, workforceSchema, emptyWorkforce, type ColonyOutputForecast,
  type ColonyProductionOrder, type Workforce } from './campaignOutput';
import { MAX_ORDER_ID } from './production';
import { CAMPAIGN_FUEL_CAPACITY, MAX_CAMPAIGN_SHIPS } from './campaignShips';
import { getColonyWorldType, getCompletedColonyEffects, isColonyEffect } from './campaignColonyEffects';

export const conquestControlSchema = z.union([
  z.object({ mode: z.literal('local') }).strict(),
  z.object({ mode: z.literal('human-vs-ai'), aiPolicy: z.literal('conquest-v1') }).strict()
]);
export const conquestVictorySchema = z.object({ kind: z.literal('all-planets-v1') }).strict();
export const conquestBattlePolicySchema = z.enum(['campaign-v1', 'campaign-v2']);
export type ConquestOutcome = { status: 'ongoing' } | { status: 'completed'; winner: CampaignFactionId; reason: 'all-planets' };
export interface WorkforceAdjustment {
  systemId: SystemId;
  populationBefore: number;
  populationAfter: number;
  before: Workforce;
  after: Workforce;
}
export interface ConquestTurnReceipt {
  factionId: CampaignFactionId;
  turn: number;
  population: number;
  populationIncome: Treasury;
  miningMinerals: number;
  populationUpkeepCredits: number;
  shipUpkeepCredits: number;
  creditsPaid: number;
  creditsShortfall: number;
  productionPoints: number;
  reserves: ColonyOutputForecast['reserves'];
  research: ResearchTurnReceipt;
  completedProductionIds: number[];
  workforceAdjustments: WorkforceAdjustment[];
  treasuryAfter: Treasury;
}
const battleReportSchema = z.object({ id: z.number().int().positive().max(MAX_TURN), turn: z.number().int().positive().max(MAX_TURN),
  systemId: systemIdSchema, winner: factionIdSchema.nullable(), timedOut: z.boolean(),
  participants: z.array(z.object({ id: z.number().int().positive(), factionId: factionIdSchema }).strict()).max(200),
  destroyed: z.array(z.number().int().positive()).max(200) }).strict();
export const conquestSchema = z.object({
  scenario: z.literal('conquest-v1'), victory: conquestVictorySchema, control: conquestControlSchema,
  battlePolicy: conquestBattlePolicySchema,
  session: conquestSessionSchema, projects: campaignProjectsSchema, researchTree: researchTreeSchema,
  rules: rulesSnapshotSchema.refine(rules => rules.effects.every(isColonyEffect), 'Нет игрового исполнителя эффекта'),
  population: populationStateSchema,
  colonyOutput: colonyOutputStateSchema,
  research: z.object({ blue: researchStateSchema, red: researchStateSchema }).strict(),
  researchJournal: z.object({
    blue: z.record(researchIdSchema, z.number().int().min(1).max(MAX_TURN)),
    red: z.record(researchIdSchema, z.number().int().min(1).max(MAX_TURN))
  }).strict(),
  operations: z.record(operationalStateSchema), seed: z.number().int().min(1).max(0xffffffff),
  lastBattleId: z.number().int().min(0).max(MAX_TURN), battles: z.array(battleReportSchema).max(12)
}).strict().superRefine((state, context) => {
  const fail = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'Нарушена целостность военной кампании' });
  const inhabited = getGalaxyDefinition(state.session.galaxy).systems.filter(system => system.habitable);
  if (Object.keys(state.population).length !== inhabited.length ||
    inhabited.some(system => !Object.prototype.hasOwnProperty.call(state.population, system.id))) { fail(); return; }
  if (state.rules.treeId !== state.researchTree.id) fail();
  const references = new Set(state.researchTree.nodes.flatMap(node => node.effects.flatMap(effect =>
    effect.kind === 'colony-effect' ? [effect.effectId] : [])));
  if (state.rules.effects.length !== references.size ||
    state.rules.effects.some(effect => !references.has(effect.id))) fail();
  if (factionIdSchema.options.some(faction => !isResearchStateValid(state.research[faction], state.researchTree))) { fail(); return; }
  for (const faction of factionIdSchema.options) {
    const journal = state.researchJournal[faction];
    if (Object.keys(journal).length !== state.research[faction].completed.length ||
      state.research[faction].completed.some(id => !Object.prototype.hasOwnProperty.call(journal, id)) ||
      Object.values(journal).some(turn => turn > state.session.turn)) fail();
  }
  if (Object.keys(state.operations).length !== state.session.ships.length) fail();
  if (state.session.production.orders.length || state.session.production.completed.length) fail();
  try {
    validateColonyOutputState(state.colonyOutput, state.session.galaxy, state.population,
      state.session.production.lastOrderId, state.rules.colonyOutput);
  } catch { fail(); }
  const outputRecordIds = new Set([...state.colonyOutput.production.orders, ...state.colonyOutput.production.completed]
    .map(record => record.id));
  if (state.session.ships.some(ship => outputRecordIds.has(ship.id))) fail();
  for (const ship of state.session.ships) {
    try { readOperationalState(state.operations[String(ship.id)], ship.design); } catch { fail(); }
    if (!isCampaignDesignAvailable(ship.design, state.research[ship.factionId], state.researchTree)) fail();
  }
  for (const record of [...state.colonyOutput.production.orders, ...state.colonyOutput.production.completed]) {
    if (!isCampaignDesignAvailable(record.design, state.research[record.factionId], state.researchTree)) fail();
  }
  for (const faction of factionIdSchema.options) for (const project of state.projects[faction].items) {
    if (!isCampaignDraftAvailable(project.design, state.research[faction], state.researchTree)) fail();
  }
  if (new Set(state.battles.map(battle => battle.id)).size !== state.battles.length || state.battles.some(battle =>
    !state.session.galaxy.systems.some(system => system.id === battle.systemId) ||
    battle.id > state.lastBattleId || battle.turn >= state.session.turn ||
    new Set(battle.participants.map(ship => ship.id)).size !== battle.participants.length ||
    new Set(battle.destroyed).size !== battle.destroyed.length ||
    battle.destroyed.some(id => !battle.participants.some(ship => ship.id === id)))) fail();
});
export type Conquest = z.infer<typeof conquestSchema>;
export type ConquestErrorCode = SessionErrorCode | ProjectErrorCode | FoundingErrorCode | 'CONTROLLER_FORBIDDEN' | 'CAMPAIGN_COMPLETED' | 'RULE_REJECTED';
export type FoundingNotice = { factionId: CampaignFactionId; systemId: SystemId; code: FoundingErrorCode };
export type ConquestResult = { ok: true; state: Conquest; frames?: BattleFrame[]; notices?: FoundingNotice[];
  workforceAdjustments?: WorkforceAdjustment[]; turnReceipt?: ConquestTurnReceipt } |
  { ok: false; code: ConquestErrorCode; message: string };
const fields = { factionId: factionIdSchema, expectedTurn: z.number().int().min(1).max(MAX_TURN) };
export const conquestCommandSchema = z.union([sessionCommandSchema, projectCommandSchema,
  z.object({ ...fields, kind: z.literal('assignWorkers'), systemId: systemIdSchema, workers: workforceSchema }).strict(),
  z.object({ ...fields, kind: z.literal('research'), technologyId: researchIdSchema }).strict(),
  z.object({ ...fields, kind: z.literal('pauseResearch') }).strict(),
  z.object({ ...fields, kind: z.enum(['repairShip', 'resupplyShip']), shipId: z.number().int().positive().max(MAX_TURN), systemId: systemIdSchema }).strict()
]);
export type ConquestCommand = z.infer<typeof conquestCommandSchema>;
class ConquestRuleError extends Error {
  constructor(message: string, readonly code: ConquestErrorCode = 'RULE_REJECTED') { super(message); }
}

export function createConquest(control: unknown = { mode: 'local' }, tree: unknown = getDefaultResearchTree(), seed = 1, map?: GalaxyMap): Conquest {
  const session = createCampaignSession(map), rules = createDefaultRulesSnapshot(), researchTree = researchTreeSchema.parse(tree);
  const population = createPopulation(session.galaxy, rules.population);
  const references = new Set(researchTree.nodes.flatMap(node => node.effects.flatMap(effect =>
    effect.kind === 'colony-effect' ? [effect.effectId] : [])));
  rules.effects = rules.effects.filter(effect => isColonyEffect(effect) && references.has(effect.id));
  rules.treeId = researchTree.id;
  return conquestSchema.parse({ scenario: 'conquest-v1', victory: { kind: 'all-planets-v1' }, control,
    battlePolicy: 'campaign-v2',
    session, rules, population, colonyOutput: createColonyOutputState(session.galaxy, population),
    projects: createCampaignProjects(), researchTree, research: { blue: createResearchState(), red: createResearchState() },
    researchJournal: { blue: {}, red: {} },
    operations: {}, seed, lastBattleId: 0, battles: [] });
}

export function getConquestOutcome(state: Conquest): ConquestOutcome {
  const planets = getGalaxyDefinition(state.session.galaxy).systems.filter(system => system.habitable);
  for (const winner of factionIdSchema.options) if (planets.every(planet =>
    state.session.galaxy.systems.find(system => system.id === planet.id)?.ownerId === winner)) {
    return { status: 'completed', winner, reason: 'all-planets' };
  }
  return { status: 'ongoing' };
}

export function visibleConquestSystems(state: Conquest, faction: CampaignFactionId): Set<SystemId> {
  const visible = new Set(state.session.galaxy.systems.filter(system => system.ownerId === faction).map(system => system.id));
  for (const ship of state.session.ships) {
    if (ship.factionId !== faction || ship.transit) continue;
    visible.add(ship.systemId);
    if (ship.design.slots.some(slot => slot.component?.kind === 'scanner' && slot.component.range > 0 && slot.component.accuracy > 0)) {
      for (const system of getGalaxyDefinition(state.session.galaxy).systems) {
        if (areSystemsAdjacent(ship.systemId, system.id, state.session.galaxy)) visible.add(system.id);
      }
    }
  }
  return visible;
}

export function getConquestView(input: unknown, faction: CampaignFactionId) {
  const state = conquestSchema.parse(input);
  const side = factionIdSchema.parse(faction);
  const view: CampaignSessionView = getConquestSessionView(state.session, side);
  const mined = miningYield(state, side);
  const effects = getCompletedColonyEffects(state.researchTree, state.research[side], state.rules);
  const outputForecast = getColonyOutputForecast(state.session.galaxy, state.population, state.colonyOutput, side,
    state.rules.colonyOutput, state.session.ships.filter(ship => ship.factionId === side).length, effects);
  const researchForecast = forecastResearch(state, side, outputForecast);
  view.income = { credits: outputForecast.income.credits, minerals: outputForecast.income.minerals + mined };
  const baseBudget = state.session.turn === MAX_TURN ? { ok: false as const, code: 'TURN_LIMIT' as const }
    : calculateColonyEndTurnBudget(state.session.treasuries[side], outputForecast);
  if (baseBudget.ok) {
    baseBudget.treasuryAfter.minerals += mined;
    if (!treasurySchema.safeParse(baseBudget.treasuryAfter).success) view.economyForecast = { ok: false, code: 'RESOURCE_LIMIT' };
    else view.economyForecast = { ...baseBudget, income: { credits: outputForecast.income.credits,
      minerals: outputForecast.income.minerals + mined } };
  } else view.economyForecast = baseBudget;
  const visible = visibleConquestSystems(state, side);
  view.galaxy.systems = view.galaxy.systems.map(system => !visible.has(system.id)
    ? { id: system.id, name: system.name, x: system.x, y: system.y, visibility: 'unknown' as const } : system);
  const population = view.galaxy.systems.filter(system => system.visibility === 'explored' && system.ownerId === side).map(system => ({
    systemId: system.id, population: state.population[system.id].population, remainder: state.population[system.id].remainder,
    worldType: getColonyWorldType(state.session.galaxy, system.id),
    technology: getPopulationTechnologyForecast(state.rules.population, getColonyWorldType(state.session.galaxy, system.id), effects),
    ...populationGrowth(state.population[system.id], state.rules.population,
      getColonyWorldType(state.session.galaxy, system.id) === 'habitable', effects)
  }));
  const colonization = view.galaxy.systems.filter(system => system.visibility === 'explored' && !system.ownerId && system.habitable)
    .map(system => ({ systemId: system.id, quote: quoteFounding(state.session.galaxy,
      view.galaxy.lanes, state.population, side, system.id, view.treasury, state.rules.population) }));
  return { ...view, production: {
    orders: structuredClone(state.colonyOutput.production.orders.filter(record => record.factionId === side)),
    completed: structuredClone(state.colonyOutput.production.completed.filter(record => record.factionId === side))
  },
    colonyOutput: { assignments: Object.fromEntries(outputForecast.production.map(row => [row.systemId,
      { population: state.population[row.systemId].population, ...row.workers }])),
      reserves: structuredClone(state.colonyOutput.reserves[side]),
      reserveCaps: { research: outputForecast.reserves.research.cap, culture: outputForecast.reserves.culture.cap },
      forecast: outputForecast, rules: state.rules.colonyOutput },
    population, colonization, foundingCost: { ...state.rules.population.foundingCost },
    projects: structuredClone(state.projects[side].items), researchTree: state.researchTree, research: state.research[side],
    colonyTechnologyEffects: state.rules.effects,
    researchJournal: Object.entries(state.researchJournal[side]).map(([technologyId, turn]) => ({
      technologyId, turn, activationTurn: turn <= MAX_TURN - 2 ? turn + 2 : null
    })).sort((a, b) => a.turn - b.turn || (a.technologyId < b.technologyId ? -1 : a.technologyId > b.technologyId ? 1 : 0)),
    researchForecast: { timing: researchForecast.timing, receipt: researchForecast.receipt },
    operations: Object.fromEntries(view.ships.map(ship => [String(ship.id), state.operations[String(ship.id)]])),
    enemies: state.session.ships.filter(ship => ship.factionId !== side && !ship.transit && visible.has(ship.systemId))
      .map(ship => ({ id: ship.id, systemId: ship.systemId, factionId: ship.factionId, hullId: ship.design.hullId })),
    battles: state.battles.filter(battle => battle.participants.some(ship => ship.factionId === side)),
    totalHabitableWorlds: getGalaxyDefinition(state.session.galaxy).systems.filter(system => system.habitable).length,
    outcome: getConquestOutcome(state) };
}
export type ConquestView = ReturnType<typeof getConquestView>;

function forecastResearch(state: Conquest, faction: CampaignFactionId, output: ColonyOutputForecast) {
  const science = output.reserves.research;
  const result = calculateResearchTurn(state.research[faction], state.researchTree, science.current,
    science.produced, science.cap, output.production.length > 0);
  if (state.session.turn === MAX_TURN) result.timing = { status: 'unavailable', reason: 'turn-limit' };
  else if (getConquestOutcome(state).status === 'completed') result.timing = { status: 'unavailable', reason: 'campaign-completed' };
  Object.assign(science, { accepted: result.receipt.accepted, spent: result.receipt.spent,
    overflow: result.receipt.overflow, after: result.receipt.reserveAfter });
  return result;
}

function armed(ship: CampaignShip): boolean {
  return ship.design.slots.some(slot => slot.component?.kind === 'beam' || slot.component?.kind === 'projectile');
}
function reveal(state: Conquest): void {
  for (const faction of factionIdSchema.options) for (const id of visibleConquestSystems(state, faction)) {
    const system = state.session.galaxy.systems.find(item => item.id === id)!;
    if (!system.exploredBy.includes(faction)) system.exploredBy.push(faction);
  }
}
function debit(state: Conquest, faction: CampaignFactionId, credits: number, minerals: number): void {
  const treasury = state.session.treasuries[faction];
  if (treasury.credits < credits || treasury.minerals < minerals) throw new ConquestRuleError('Недостаточно ресурсов');
  treasury.credits -= credits; treasury.minerals -= minerals;
}
function miningYield(state: Conquest, faction: CampaignFactionId): number {
  const definition = getGalaxyDefinition(state.session.galaxy);
  return state.session.ships.filter(ship => ship.factionId === faction && !definition.systems.find(system =>
    system.id === (ship.transit?.destinationId ?? ship.systemId))!.habitable).reduce((total, ship) => total +
      Math.floor(Math.min(10, ship.design.slots.reduce((sum, slot) => sum +
        (slot.component?.kind === 'mining' ? slot.component.miningSpeed * slot.component.efficiency : 0), 0))), 0);
}
function foundColony(state: Conquest, faction: CampaignFactionId, target: SystemId): {
  quote: ReturnType<typeof quoteFounding>;
  workforceAdjustment?: WorkforceAdjustment;
} {
  const quote = quoteFounding(state.session.galaxy, getGalaxyDefinition(state.session.galaxy).lanes,
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
function settleEncounters(state: Conquest, turn: number, notices: FoundingNotice[],
  workforceAdjustments: WorkforceAdjustment[]): BattleFrame[] | undefined {
  let frames: BattleFrame[] | undefined;
  for (const definition of getGalaxyDefinition(state.session.galaxy).systems) {
    let present = state.session.ships.filter(ship => !ship.transit && ship.systemId === definition.id);
    if (new Set(present.map(ship => ship.factionId)).size > 1) {
      if (state.lastBattleId === MAX_TURN) throw new ConquestRuleError('Достигнут предел идентификаторов боёв');
      const seed = ((state.seed ^ Math.imul(turn, 2654435761) ^ (state.lastBattleId + 1)) >>> 0) || 1;
      const result = resolveConquestBattle(present, state.operations, seed, state.battlePolicy);
      frames = result.frames;
      state.battles.push({ id: ++state.lastBattleId, turn, systemId: definition.id, winner: result.winner,
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
    if (definition.habitable && sides.size === 1 && present.some(armed)) {
      const owner = present[0].factionId;
      const system = state.session.galaxy.systems.find(item => item.id === definition.id)!;
      const previousOwner = system.ownerId;
      if (!system.ownerId) {
        const founding = foundColony(state, owner, system.id);
        if (!founding.quote.ok) { notices.push({ factionId: owner, systemId: system.id, code: founding.quote.code }); continue; }
        if (founding.workforceAdjustment) workforceAdjustments.push(founding.workforceAdjustment);
      }
      system.ownerId = owner;
      if (!system.exploredBy.includes(owner)) system.exploredBy.push(owner);
      if (previousOwner !== owner) {
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
    if (production.orders.filter(order => order.factionId === factionId && order.systemId === systemId).length >= 3) {
      throw new ConquestRuleError('Очередь колонии заполнена', 'QUEUE_FULL');
    }
    if ([...production.orders, ...production.completed].filter(record => record.factionId === factionId).length >= 100) {
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
    const order: ColonyProductionOrder = { id, factionId, systemId, design: structuredClone(command.design),
      cost: quote.cost, productionCost: quote.productionCost, productionProgress: 0 };
    production.orders.push(order);
    return;
  }
  if (command.kind === 'cancelProduction') {
    const index = production.orders.findIndex(order => order.id === command.orderId &&
      order.factionId === factionId && order.systemId === systemId);
    if (index < 0) throw new ConquestRuleError('Заказ не найден в очереди колонии', 'ORDER_NOT_FOUND');
    const refund = getColonyProductionRefund(production.orders[index]);
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
  state.session.ships.push({ ...completed, fuel: CAMPAIGN_FUEL_CAPACITY });
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
    if (command.expectedTurn !== state.session.turn) throw new ConquestRuleError('Номер хода изменился', 'STALE_TURN');
    if (faction !== (state.session.turn % 2 ? 'blue' : 'red')) throw new ConquestRuleError('Сейчас ход другой стороны', 'NOT_ACTIVE_FACTION');
    if (state.control.mode === 'human-vs-ai' && (automated ? faction !== 'red' : faction === 'red')) throw new ConquestRuleError('Команда недоступна этому контроллеру', 'CONTROLLER_FORBIDDEN');
    if (getConquestOutcome(state).status === 'completed') throw new ConquestRuleError('Партия завершена', 'CAMPAIGN_COMPLETED');
    if (('systemId' in command && !state.session.galaxy.systems.some(system => system.id === command.systemId)) ||
      ('destinationId' in command && !state.session.galaxy.systems.some(system => system.id === command.destinationId))) {
      throw new ConquestRuleError('Система отсутствует на карте партии');
    }
    let frames: BattleFrame[] | undefined;
    const notices: FoundingNotice[] = [];
    const workforceAdjustments: WorkforceAdjustment[] = [];
    let turnReceipt: ConquestTurnReceipt | undefined;
    if (command.kind === 'createProject' || command.kind === 'copyProject' || command.kind === 'renameProject' ||
      command.kind === 'replaceProject' || command.kind === 'deleteProject') {
      if ((command.kind === 'createProject' || command.kind === 'replaceProject') &&
        !isCampaignDraftAvailable(command.design, state.research[faction], state.researchTree)) {
        throw new ConquestRuleError('Черновик требует доступный корпус, семейства и параметры оборудования', 'INVALID_DESIGN');
      }
      const result = editCampaignProject(state.projects, command);
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
    } else if (command.kind === 'explore' || command.kind === 'colonize') {
      if (!visibleConquestSystems(state, faction).has(command.systemId)) throw new ConquestRuleError('Нужен корабль или сканер в зоне системы');
      const system = state.session.galaxy.systems.find(item => item.id === command.systemId)!;
      if (command.kind === 'colonize') {
        if (system.ownerId || !getGalaxyDefinition(state.session.galaxy).systems.find(item => item.id === system.id)!.habitable ||
          !state.session.ships.some(ship => ship.factionId === faction && !ship.transit && ship.systemId === system.id) ||
          state.session.ships.some(ship => ship.factionId !== faction && !ship.transit && ship.systemId === system.id)) throw new ConquestRuleError('Колонизация недоступна');
        const founding = foundColony(state, faction, system.id);
        if (!founding.quote.ok) throw new ConquestRuleError(founding.quote.code === 'NO_SETTLERS'
          ? 'Нет своей колонии с достаточным населением для переселения' : 'Для основания нужны кредиты и минералы', founding.quote.code);
        if (founding.workforceAdjustment) workforceAdjustments.push(founding.workforceAdjustment);
        system.ownerId = faction;
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
    } else {
      let turnForecast: ColonyOutputForecast | undefined;
      let endTurnBudget: ReturnType<typeof calculateColonyEndTurnBudget> | undefined;
      const effects = getCompletedColonyEffects(state.researchTree, state.research[faction], state.rules);
      if (command.kind === 'endTurn' && state.session.turn !== MAX_TURN) {
        turnForecast = getColonyOutputForecast(state.session.galaxy, state.population, state.colonyOutput, faction,
          state.rules.colonyOutput, state.session.ships.filter(ship => ship.factionId === faction).length, effects);
        endTurnBudget = calculateColonyEndTurnBudget(state.session.treasuries[faction], turnForecast);
        if (!endTurnBudget.ok) throw new ConquestRuleError('Валовой доход превысит предел ресурсов; ход не завершён', 'RESOURCE_LIMIT');
      }
      const result = executeConquestSessionCommand(state.session, command,
        endTurnBudget?.ok ? endTurnBudget : undefined);
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      state.session = result.state;
      if (command.kind === 'endTurn') {
        const output = advanceColonyOutput(state.colonyOutput, parsedState.data.session.galaxy,
          parsedState.data.population, faction, state.rules.colonyOutput,
          parsedState.data.session.ships.filter(ship => ship.factionId === faction).length, effects);
        const research = forecastResearch(parsedState.data, faction, output.forecast);
        state.colonyOutput = output.state;
        state.colonyOutput.reserves[faction].research = research.receipt.reserveAfter;
        state.research[faction] = research.state;
        if (research.receipt.completedId) state.researchJournal[faction][research.receipt.completedId] = command.expectedTurn;
        state.population = advancePopulation(parsedState.data.session.galaxy, state.population, faction, state.rules.population, effects);
        const miningMinerals = miningYield(state, faction);
        state.session.treasuries[faction].minerals += miningMinerals;
        treasurySchema.parse(state.session.treasuries[faction]);
        frames = settleEncounters(state, command.expectedTurn, notices, workforceAdjustments);
        turnReceipt = {
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