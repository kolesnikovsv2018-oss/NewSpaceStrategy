import { z } from 'zod';
import { factionIdSchema, systemIdSchema, type CampaignFactionId, type CampaignState, type SystemId } from './campaign';
import { treasurySchema, type Treasury } from './campaignEconomy';
import type { EndTurnBudget, EconomyCalculation } from './campaignUpkeep';
import { flightDesignSchema, getProductionQuote, MAX_COLONY_QUEUE, MAX_PRODUCTION_RECORDS, orderIdSchema } from './production';
import { ruleIdentifierSchema, type BuildingDefinition, type ColonyOutputRules } from './campaignRules';
import type { PopulationState } from './campaignPopulation';
import { calculateColonyValue, getColonyWorldType, type ColonyValueBreakdown } from './campaignColonyEffects';
import type { EnvironmentState } from './worldEnvironment';
import type { RulesEffect } from './campaignRules';

const amountSchema = z.number().int().min(0).max(1_000_000_000);

export const workforceSchema = z.object({
  industry: amountSchema,
  research: amountSchema,
  culture: amountSchema
}).strict();
export type Workforce = z.infer<typeof workforceSchema>;

const reserveAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const reserveSchema = z.object({ research: reserveAmountSchema, culture: reserveAmountSchema }).strict();
const productionOrderSchema = z.object({
  id: orderIdSchema,
  factionId: factionIdSchema,
  systemId: systemIdSchema,
  design: flightDesignSchema,
  cost: treasurySchema,
  productionCost: amountSchema.positive(),
  productionProgress: amountSchema
}).strict().superRefine((order, context) => {
  if (order.productionProgress >= order.productionCost) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Готовый заказ не может оставаться в очереди' });
  }
});
const completedProductionSchema = z.object({
  id: orderIdSchema,
  factionId: factionIdSchema,
  systemId: systemIdSchema,
  design: flightDesignSchema
}).strict();
export type ColonyProductionOrder = z.infer<typeof productionOrderSchema>;
export type ColonyCompletedProduction = z.infer<typeof completedProductionSchema>;
export const colonyBuildingLevelSchema = z.object({
  buildingId: ruleIdentifierSchema,
  level: z.number().int().min(1).max(8)
}).strict();
export type ColonyBuildingLevel = z.infer<typeof colonyBuildingLevelSchema>;
const workFields = {
  id: orderIdSchema, factionId: factionIdSchema, systemId: systemIdSchema,
  cost: treasurySchema, productionCost: amountSchema.positive(), productionProgress: amountSchema
};
export const colonyProjectSchema = z.discriminatedUnion('kind', [
  z.object({ ...workFields, kind: z.literal('terraform'), source: z.literal('toxic'), target: z.literal('habitable') }).strict(),
  z.object({ ...workFields, kind: z.literal('refit'), shipId: orderIdSchema, design: flightDesignSchema }).strict(),
  z.object({ ...workFields, kind: z.literal('building'), buildingId: ruleIdentifierSchema }).strict()
]).refine(project => project.productionProgress < project.productionCost, 'Проект уже завершён');
export type ColonyProject = z.infer<typeof colonyProjectSchema>;

const productionSchema = z.object({
  orders: z.array(productionOrderSchema).max(MAX_PRODUCTION_RECORDS * 2),
  completed: z.array(completedProductionSchema).max(MAX_PRODUCTION_RECORDS * 2)
}).strict().superRefine((production, context) => {
  const records = [...production.orders, ...production.completed];
  if (new Set(records.map(record => record.id)).size !== records.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Идентификаторы производственных записей должны быть уникальны' });
  }
  for (const faction of factionIdSchema.options) {
    if (records.filter(record => record.factionId === faction).length > MAX_PRODUCTION_RECORDS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Превышен предел производственных записей стороны' });
    }
  }
  if (production.orders.some((order, index) => index > 0 && order.id <= production.orders[index - 1].id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Нарушен порядок FIFO-заказов' });
  }
  const colonyCounts = new Map<string, number>();
  for (const order of production.orders) {
    const key = `${order.factionId}:${order.systemId}`;
    const count = (colonyCounts.get(key) ?? 0) + 1;
    colonyCounts.set(key, count);
    if (count > MAX_COLONY_QUEUE) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Очередь колонии заполнена' });
    if (count > 1 && order.productionProgress !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Ожидающий FIFO-заказ не может иметь прогресс' });
    }
  }
});

export const colonyOutputStateSchema = z.object({
  assignments: z.record(systemIdSchema, workforceSchema),
  reserves: z.object({ blue: reserveSchema, red: reserveSchema }).strict(),
  buildings: z.record(systemIdSchema, z.array(colonyBuildingLevelSchema)),
  projects: z.array(colonyProjectSchema).max(MAX_PRODUCTION_RECORDS * 2),
  production: productionSchema
}).strict();
export type ColonyOutputState = z.infer<typeof colonyOutputStateSchema>;

export interface ColonyProductionQuote {
  cost: Treasury;
  productionCost: number;
}

export function getColonyProductionQuote(design: unknown, rules: ColonyOutputRules): ColonyProductionQuote {
  const quote = getProductionQuote(design);
  return { cost: quote.cost, productionCost: Math.ceil(quote.cost.credits / rules.productionCreditsPerPoint) };
}

export function getColonyProductionRefund(orderInput: ColonyProductionOrder): Treasury {
  const order = productionOrderSchema.parse(orderInput);
  return getColonyProjectRefund(order);
}

export function getColonyProjectRefund(project: Pick<ColonyProject, 'cost' | 'productionCost' | 'productionProgress'>): Treasury {
  const unused = project.productionCost - project.productionProgress;
  return {
    credits: Number(BigInt(project.cost.credits) * BigInt(unused) / BigInt(project.productionCost)),
    minerals: Number(BigInt(project.cost.minerals) * BigInt(unused) / BigInt(project.productionCost))
  };
}

export function colonyWorkQueue(state: ColonyOutputState, systemId: SystemId) {
  return [...state.production.orders, ...state.projects].filter(work => work.systemId === systemId).sort((a, b) => a.id - b.id);
}

export function createColonyOutputState(galaxy: CampaignState, population: PopulationState): ColonyOutputState {
  const assignments = Object.fromEntries(galaxy.systems.filter(system => population[system.id]).map(system => {
    const workers = system.ownerId ? population[system.id].population : 0;
    return [system.id, { industry: workers, research: 0, culture: 0 }];
  }));
  return { assignments, reserves: { blue: { research: 0, culture: 0 }, red: { research: 0, culture: 0 } },
    buildings: {}, production: { orders: [], completed: [] }, projects: [] };
}

export function validateColonyOutputState(input: unknown, galaxy: CampaignState, population: PopulationState,
  sessionLastOrderId: number, rules: ColonyOutputRules, buildings: readonly BuildingDefinition[] = []): ColonyOutputState {
  const output = colonyOutputStateSchema.parse(input);
  const habitable = galaxy.systems.filter(system => population[system.id]);
  if (Object.keys(output.assignments).length !== habitable.length ||
    habitable.some(system => !Object.prototype.hasOwnProperty.call(output.assignments, system.id))) {
    throw new Error('Назначения должны содержать ровно пригодные миры карты');
  }
  for (const system of habitable) {
    const assignment = output.assignments[system.id];
    const owner = system.ownerId;
    const assigned = assignment.industry + assignment.research + assignment.culture;
    if (!owner) {
      if (assigned !== 0) throw new Error('Нейтральный мир не может иметь назначенных рабочих');
      continue;
    }
    if (assigned > population[system.id].population) {
      throw new Error('Назначено больше рабочих, чем доступно населения');
    }
  }
  const ids = new Set<number>();
  for (const record of [...output.production.orders, ...output.production.completed, ...output.projects]) {
    const colony = galaxy.systems.find(system => system.id === record.systemId);
    if (!colony || colony.ownerId !== record.factionId || record.id > sessionLastOrderId ||
      ids.has(record.id)) throw new Error('Производственная запись не согласована с владельцем или счётчиком');
    ids.add(record.id);
  }
  for (const system of habitable) {
    const queue = colonyWorkQueue(output, system.id);
    if (queue.length > MAX_COLONY_QUEUE || queue.slice(1).some(work => work.productionProgress !== 0)) {
      throw new Error('Нарушена общая промышленная FIFO-очередь');
    }
  }
  const buildingCatalog = new Map(buildings.map(def => [def.id, def]));
  const pendingByColony = new Map<string, number>();
  const pendingByBuilding = new Map<string, number>();
  for (const project of output.projects) if (project.kind === 'building') {
    pendingByColony.set(project.systemId, (pendingByColony.get(project.systemId) ?? 0) + 1);
    const key = `${project.systemId}:${project.buildingId}`;
    pendingByBuilding.set(key, (pendingByBuilding.get(key) ?? 0) + 1);
  }
  const colonyIds = new Set<string>([...Object.keys(output.buildings), ...pendingByColony.keys()]);
  for (const systemId of colonyIds) {
    const system = galaxy.systems.find(item => item.id === systemId);
    if (!system || system.ownerId === null || !population[systemId]) {
      throw new Error('Здания могут существовать только в населённой колонии владельца');
    }
    const levels = output.buildings[systemId] ?? [];
    const seen = new Set<string>();
    for (const entry of levels) {
      if (seen.has(entry.buildingId)) throw new Error('Дубликат здания в колонии');
      seen.add(entry.buildingId);
      const def = buildingCatalog.get(entry.buildingId);
      if (!def) throw new Error(`Неизвестное здание: ${entry.buildingId}`);
      if (entry.level < 1 || entry.level > def.maxLevels) throw new Error('Уровень здания вне пределов каталога');
      if (entry.level + (pendingByBuilding.get(`${systemId}:${entry.buildingId}`) ?? 0) > def.maxLevels) {
        throw new Error('Установленные и строящиеся уровни здания превышают предел каталога');
      }
    }
    if (levels.reduce((sum, entry) => sum + entry.level, 0) + (pendingByColony.get(systemId) ?? 0) >
      rules.colonyBuildingSlots) {
      throw new Error('Превышен предел мест зданий колонии');
    }
  }
  for (const project of output.projects) if (project.kind === 'building') {
    const def = buildingCatalog.get(project.buildingId);
    if (!def) throw new Error(`Неизвестное здание: ${project.buildingId}`);
    if (project.cost.credits !== def.cost.credits || project.cost.minerals !== def.cost.minerals ||
      project.productionCost !== def.productionCost) {
      throw new Error('Закреплённая цена здания не совпадает с каталогом правил');
    }
    const installed = output.buildings[project.systemId]?.find(entry => entry.buildingId === project.buildingId)?.level ?? 0;
    if (installed >= def.maxLevels) throw new Error('Уровень здания уже достиг предела каталога');
  }
  for (const faction of factionIdSchema.options) {
    if ([...output.production.orders, ...output.production.completed, ...output.projects]
      .filter(work => work.factionId === faction).length > MAX_PRODUCTION_RECORDS) {
      throw new Error('Превышен общий предел производственных записей');
    }
  }
  for (const order of output.production.orders) {
    const quote = getColonyProductionQuote(order.design, rules);
    if (order.cost.credits !== quote.cost.credits || order.cost.minerals !== quote.cost.minerals ||
      order.productionCost !== quote.productionCost) {
      throw new Error('Закреплённая цена заказа не совпадает с его проектом и правилами');
    }
  }
  for (const faction of factionIdSchema.options) {
    const reserve = output.reserves[faction];
    if (!Number.isSafeInteger(reserve.research) || !Number.isSafeInteger(reserve.culture)) {
      throw new Error('Научный и культурный резервы должны быть целыми безопасными числами');
    }
  }
  return output;
}

export function reduceWorkforce(assignmentInput: Workforce, populationInput: number): Workforce {
  const assignment = workforceSchema.parse(assignmentInput);
  const population = amountSchema.parse(populationInput);
  const total = assignment.industry + assignment.research + assignment.culture;
  if (total <= population) return { ...assignment };
  if (population === 0) return { industry: 0, research: 0, culture: 0 };
  const values = [assignment.industry, assignment.research, assignment.culture];
  const reduced = values.map(value => Number(BigInt(value) * BigInt(population) / BigInt(total)));
  let remaining = population - reduced.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remaining > 0; index = (index + 1) % values.length) {
    if (reduced[index] < values[index]) {
      reduced[index] += 1;
      remaining -= 1;
    }
  }
  return { industry: reduced[0], research: reduced[1], culture: reduced[2] };
}

export interface ColonyOutputForecast {
  factionId: CampaignFactionId;
  population: number;
  income: Treasury;
  upkeep: { populationCredits: number; shipCount: number; shipCredits: number; dueCredits: number;
    buildingPaidCredits: number; buildingShortfallCredits: number };
  production: Array<{
    systemId: SystemId;
    workers: Workforce & { unassigned: number };
    productionPoints: number;
    sciencePoints: number;
    culturePoints: number;
    breakdown: { production: ColonyValueBreakdown; science: ColonyValueBreakdown; culture: ColonyValueBreakdown };
    buildings: Array<{ buildingId: string; levels: number; active: boolean; upkeep: number }>;
    buildingOutput: { production: number; science: number; culture: number };
    orderId?: number;
    productionProgress?: number;
    productionCost?: number;
    remainingOwnTurns?: number | null;
    productionStatus: 'idle' | 'paused' | 'progressing' | 'completes';
  }>;
  reserves: {
    research: { current: number; cap: number; produced: number; accepted: number; spent: number; overflow: number; after: number };
    culture: { current: number; cap: number; produced: number; accepted: number; spent: number; overflow: number; after: number };
  };
}

export function getColonyOutputForecast(galaxy: CampaignState, population: PopulationState, outputInput: unknown,
  factionInput: unknown, rules: ColonyOutputRules, shipCount: number, effects: readonly RulesEffect[] = [],
  environment?: EnvironmentState, buildings: readonly BuildingDefinition[] = [], treasury?: Treasury): ColonyOutputForecast {
  const faction = factionIdSchema.parse(factionInput);
  const output = colonyOutputStateSchema.parse(outputInput);
  const colonies = galaxy.systems.filter(system => system.ownerId === faction && population[system.id]);
  const totalPopulation = colonies.reduce((sum, system) => sum + population[system.id].population, 0);
  const income = { credits: totalPopulation * rules.creditsPerPopulation, minerals: totalPopulation * rules.mineralsPerPopulation };
  const populationCredits = totalPopulation * rules.populationUpkeepPerPopulation;
  const shipCredits = shipCount * 1;
  const catalog = new Map(buildings.map((def, index) => [def.id, { def, index }]));
  const installedFor = (systemId: SystemId) => (output.buildings[systemId] ?? []).slice()
    .sort((left, right) => (catalog.get(left.buildingId)?.index ?? Number.MAX_SAFE_INTEGER) -
      (catalog.get(right.buildingId)?.index ?? Number.MAX_SAFE_INTEGER));
  // Deterministic building upkeep: catalog order per colony, colony order per faction; unpaid buildings are inactive.
  let buildingBudget = treasury ? Math.max(0, treasury.credits + income.credits - populationCredits - shipCredits) : undefined;
  let buildingDue = 0, buildingPaid = 0;
  const paidKeys = new Set<string>();
  for (const system of colonies) {
    const worldType = getColonyWorldType(galaxy, system.id, environment);
    for (const entry of installedFor(system.id)) {
      const item = catalog.get(entry.buildingId);
      if (!item || !item.def.worlds.includes(worldType)) continue;
      const due = item.def.upkeep * entry.level;
      buildingDue += due;
      if (buildingBudget === undefined || buildingBudget >= due) {
        if (buildingBudget !== undefined) buildingBudget -= due;
        buildingPaid += due;
        paidKeys.add(`${system.id}:${entry.buildingId}`);
      }
    }
  }
  const rows = colonies.map(system => {
    const workforce = output.assignments[system.id];
    const totalAssigned = workforce.industry + workforce.research + workforce.culture;
    const head = colonyWorkQueue(output, system.id)[0];
    const worldType = getColonyWorldType(galaxy, system.id, environment);
    const buildingRows = installedFor(system.id).flatMap(entry => {
      const item = catalog.get(entry.buildingId);
      if (!item) return [];
      const active = item.def.worlds.includes(worldType) && paidKeys.has(`${system.id}:${entry.buildingId}`);
      return [{ buildingId: entry.buildingId, levels: entry.level, active, upkeep: item.def.upkeep * entry.level }];
    });
    const buildingOutput = (target: BuildingDefinition['target']) => buildingRows.filter(row => row.active &&
      catalog.get(row.buildingId)!.def.target === target)
      .reduce((sum, row) => sum + row.levels * catalog.get(row.buildingId)!.def.outputPerLevel, 0);
    const production = calculateColonyValue(rules.pointsPerWorker, workforce.industry, 'production-output', worldType,
      effects, undefined, buildingOutput('production-output'));
    const science = calculateColonyValue(rules.pointsPerWorker, workforce.research, 'science-output', worldType,
      effects, undefined, buildingOutput('science-output'));
    const culture = calculateColonyValue(rules.pointsPerWorker, workforce.culture, 'culture-output', worldType,
      effects, undefined, buildingOutput('culture-output'));
    const productionPoints = production.total;
    const nextProgress = head ? Math.min(head.productionCost, head.productionProgress + productionPoints) : undefined;
    return {
      systemId: system.id,
      workers: { ...workforce, unassigned: population[system.id].population - totalAssigned },
      productionPoints,
      sciencePoints: science.total, culturePoints: culture.total, breakdown: { production, science, culture },
      buildings: buildingRows,
      buildingOutput: { production: buildingOutput('production-output'),
        science: buildingOutput('science-output'), culture: buildingOutput('culture-output') },
      ...(head ? { orderId: head.id, productionProgress: head.productionProgress, productionCost: head.productionCost,
        remainingOwnTurns: productionPoints === 0 ? null :
          Math.ceil((head.productionCost - head.productionProgress) / productionPoints) } : {}),
      productionStatus: !head ? 'idle' as const : productionPoints === 0 ? 'paused' as const
        : nextProgress === head.productionCost ? 'completes' as const : 'progressing' as const
    };
  });
  const reserveForecast = (kind: 'research' | 'culture') => {
    const current = output.reserves[faction][kind], produced = rows.reduce((sum, row) => sum +
      (kind === 'research' ? row.sciencePoints : row.culturePoints), 0);
    const cap = totalPopulation * rules.reserveWorkerTurns;
    const accepted = current > cap ? 0 : Math.min(produced, cap - current);
    return { current, cap, produced, accepted, spent: 0, overflow: produced - accepted, after: current + accepted };
  };
  return { factionId: faction, population: totalPopulation, income,
    upkeep: { populationCredits, shipCount, shipCredits, dueCredits: populationCredits + shipCredits + buildingPaid,
      buildingPaidCredits: buildingPaid, buildingShortfallCredits: buildingDue - buildingPaid },
    production: rows, reserves: { research: reserveForecast('research'), culture: reserveForecast('culture') } };
}

export function calculateColonyEndTurnBudget(treasury: Treasury, forecast: ColonyOutputForecast): EconomyCalculation {
  const gross = { credits: treasury.credits + forecast.income.credits,
    minerals: treasury.minerals + forecast.income.minerals };
  if (!treasurySchema.safeParse(gross).success) return { ok: false, code: 'RESOURCE_LIMIT' };
  const paidCredits = Math.min(gross.credits, forecast.upkeep.dueCredits);
  const budget: EndTurnBudget = {
    income: { ...forecast.income },
    upkeep: {
      shipCount: forecast.upkeep.shipCount,
      dueCredits: forecast.upkeep.dueCredits,
      paidCredits,
      shortfallCredits: forecast.upkeep.dueCredits - paidCredits
    },
    treasuryAfter: { credits: gross.credits - paidCredits, minerals: gross.minerals }
  };
  return { ok: true, ...budget };
}

export function advanceColonyOutput(input: unknown, galaxy: CampaignState, population: PopulationState,
  faction: CampaignFactionId, rules: ColonyOutputRules, shipCount: number, effects: readonly RulesEffect[] = [],
  environment?: EnvironmentState, buildings: readonly BuildingDefinition[] = [], treasury?: Treasury): {
    state: ColonyOutputState;
    forecast: ColonyOutputForecast;
    completedIds: number[];
    completedProjects: ColonyProject[];
  } {
  const state = colonyOutputStateSchema.parse(input);
  const forecast = getColonyOutputForecast(galaxy, population, state, faction, rules, shipCount, effects, environment,
    buildings, treasury);
  const completedIds: number[] = [];
  const completedProjects: ColonyProject[] = [];
  for (const row of forecast.production) {
    const project = state.projects.find(item => item.id === row.orderId);
    if (project) {
      const progress = Math.min(project.productionCost, project.productionProgress + row.productionPoints);
      if (progress === project.productionCost) {
        completedProjects.push(structuredClone(project));
        state.projects = state.projects.filter(item => item.id !== project.id);
        if (project.kind === 'building') {
          const levels = state.buildings[project.systemId] ?? [];
          const existing = levels.find(entry => entry.buildingId === project.buildingId);
          if (existing) existing.level += 1;
          else state.buildings[project.systemId] = [...levels, { buildingId: project.buildingId, level: 1 }];
        }
      } else project.productionProgress = progress;
      continue;
    }
    const order = state.production.orders.find(item => item.factionId === faction && item.systemId === row.systemId);
    if (!order || row.productionStatus === 'paused' || row.productionStatus === 'idle') continue;
    order.productionProgress = Math.min(order.productionCost, order.productionProgress + row.productionPoints);
    if (order.productionProgress === order.productionCost) {
      completedIds.push(order.id);
      state.production.orders = state.production.orders.filter(item => item.id !== order.id);
      state.production.completed.push({ id: order.id, factionId: order.factionId, systemId: order.systemId, design: order.design });
    }
  }
  for (const kind of ['research', 'culture'] as const) {
    state.reserves[faction][kind] = forecast.reserves[kind].after;
  }
  return { state, forecast, completedIds, completedProjects };
}

export function emptyWorkforce(): Workforce { return { industry: 0, research: 0, culture: 0 }; }

export function colonyReserveCap(population: PopulationState, galaxy: CampaignState, faction: CampaignFactionId,
  rules: ColonyOutputRules): number {
  return galaxy.systems.filter(system => system.ownerId === faction && population[system.id])
    .reduce((sum, system) => sum + population[system.id].population * rules.reserveWorkerTurns, 0);
}
