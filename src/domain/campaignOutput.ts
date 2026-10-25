import { z } from 'zod';
import { factionIdSchema, systemIdSchema, type CampaignFactionId, type CampaignState, type SystemId } from './campaign';
import { treasurySchema, type Treasury } from './campaignEconomy';
import type { EndTurnBudget, EconomyCalculation } from './campaignUpkeep';
import { flightDesignSchema, getProductionQuote, MAX_COLONY_QUEUE, MAX_PRODUCTION_RECORDS, orderIdSchema } from './production';
import type { ColonyOutputRules } from './campaignRules';
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
  const unused = order.productionCost - order.productionProgress;
  const share = (cost: number) => Number(BigInt(cost) * BigInt(unused) / BigInt(order.productionCost));
  return {
    credits: share(order.cost.credits),
    minerals: share(order.cost.minerals)
  };
}

export function createColonyOutputState(galaxy: CampaignState, population: PopulationState): ColonyOutputState {
  const assignments = Object.fromEntries(galaxy.systems.filter(system => population[system.id]).map(system => {
    const workers = system.ownerId ? population[system.id].population : 0;
    return [system.id, { industry: workers, research: 0, culture: 0 }];
  }));
  return { assignments, reserves: { blue: { research: 0, culture: 0 }, red: { research: 0, culture: 0 } },
    production: { orders: [], completed: [] } };
}

export function validateColonyOutputState(input: unknown, galaxy: CampaignState, population: PopulationState,
  sessionLastOrderId: number, rules: ColonyOutputRules): ColonyOutputState {
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
  for (const record of [...output.production.orders, ...output.production.completed]) {
    const colony = galaxy.systems.find(system => system.id === record.systemId);
    if (!colony || colony.ownerId !== record.factionId || record.id > sessionLastOrderId ||
      ids.has(record.id)) throw new Error('Производственная запись не согласована с владельцем или счётчиком');
    ids.add(record.id);
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
  upkeep: { populationCredits: number; shipCount: number; shipCredits: number; dueCredits: number };
  production: Array<{
    systemId: SystemId;
    workers: Workforce & { unassigned: number };
    productionPoints: number;
    sciencePoints: number;
    culturePoints: number;
    breakdown: { production: ColonyValueBreakdown; science: ColonyValueBreakdown; culture: ColonyValueBreakdown };
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
  environment?: EnvironmentState): ColonyOutputForecast {
  const faction = factionIdSchema.parse(factionInput);
  const output = colonyOutputStateSchema.parse(outputInput);
  const colonies = galaxy.systems.filter(system => system.ownerId === faction && population[system.id]);
  const totalPopulation = colonies.reduce((sum, system) => sum + population[system.id].population, 0);
  const income = { credits: totalPopulation * rules.creditsPerPopulation, minerals: totalPopulation * rules.mineralsPerPopulation };
  const populationCredits = totalPopulation * rules.populationUpkeepPerPopulation;
  const shipCredits = shipCount * 1;
  const rows = colonies.map(system => {
    const workforce = output.assignments[system.id];
    const totalAssigned = workforce.industry + workforce.research + workforce.culture;
    const head = output.production.orders.find(order => order.factionId === faction && order.systemId === system.id);
    const worldType = getColonyWorldType(galaxy, system.id, environment);
    const production = calculateColonyValue(rules.pointsPerWorker, workforce.industry, 'production-output', worldType, effects);
    const science = calculateColonyValue(rules.pointsPerWorker, workforce.research, 'science-output', worldType, effects);
    const culture = calculateColonyValue(rules.pointsPerWorker, workforce.culture, 'culture-output', worldType, effects);
    const productionPoints = production.total;
    const nextProgress = head ? Math.min(head.productionCost, head.productionProgress + productionPoints) : undefined;
    return {
      systemId: system.id,
      workers: { ...workforce, unassigned: population[system.id].population - totalAssigned },
      productionPoints,
      sciencePoints: science.total, culturePoints: culture.total, breakdown: { production, science, culture },
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
    upkeep: { populationCredits, shipCount, shipCredits, dueCredits: populationCredits + shipCredits },
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
  environment?: EnvironmentState): {
    state: ColonyOutputState;
    forecast: ColonyOutputForecast;
    completedIds: number[];
  } {
  const state = colonyOutputStateSchema.parse(input);
  const forecast = getColonyOutputForecast(galaxy, population, state, faction, rules, shipCount, effects, environment);
  const completedIds: number[] = [];
  for (const row of forecast.production) {
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
  return { state, forecast, completedIds };
}

export function emptyWorkforce(): Workforce { return { industry: 0, research: 0, culture: 0 }; }

export function colonyReserveCap(population: PopulationState, galaxy: CampaignState, faction: CampaignFactionId,
  rules: ColonyOutputRules): number {
  return galaxy.systems.filter(system => system.ownerId === faction && population[system.id])
    .reduce((sum, system) => sum + population[system.id].population * rules.reserveWorkerTurns, 0);
}
