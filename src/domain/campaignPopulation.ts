import { z } from 'zod';
import { getGalaxyDefinition, type CampaignFactionId, type CampaignState, type SystemId } from './campaign';
import type { PopulationRules } from './campaignRules';
import type { Treasury } from './campaignEconomy';
import { calculateColonyValue, getColonyWorldType, type ColonyWorldType } from './campaignColonyEffects';
import type { RulesEffect } from './campaignRules';
import { getWorldDistance } from './campaignTravel';
import type { EnvironmentState } from './worldEnvironment';

export const populationRecordSchema = z.object({
  population: z.number().int().min(0).max(1_000_000_000),
  remainder: z.number().finite().min(0).lt(100).refine(value =>
    value === Math.round(value * 100) / 100)
}).strict();
export const populationStateSchema = z.record(populationRecordSchema);
export type PopulationRecord = z.infer<typeof populationRecordSchema>;
export type PopulationState = z.infer<typeof populationStateSchema>;
export type GrowthReason = 'growing' | 'empty' | 'at-capacity' | 'over-capacity';
export type FoundingErrorCode = 'NO_SETTLERS' | 'INSUFFICIENT_RESOURCES';
export type FoundingQuote = { ok: true; sourceId: SystemId; cost: Treasury } |
  { ok: false; code: FoundingErrorCode };

export function createPopulation(galaxy: CampaignState, rules: PopulationRules): PopulationState {
  return Object.fromEntries(getGalaxyDefinition(galaxy).systems.filter(system => system.habitable).map(system =>
    [system.id, { population: galaxy.systems.find(item => item.id === system.id)!.ownerId ? rules.home : 0, remainder: 0 }]));
}

export function getPopulationTechnologyForecast(rules: PopulationRules, worldType: ColonyWorldType,
  effects: readonly RulesEffect[]) {
  const limits = rules.capacities[worldType];
  return {
    capacity: calculateColonyValue(limits.base, 1, 'capacity-add', worldType, effects, limits.absolute),
    growthRate: calculateColonyValue(rules.growthPercent * 100, 1, 'growth-rate', worldType, effects, 10000)
  };
}

export function populationGrowth(record: PopulationRecord, rules: PopulationRules, habitable: boolean | ColonyWorldType = true,
  effects: readonly RulesEffect[] = []) {
  const forecast = getPopulationTechnologyForecast(rules, typeof habitable === 'boolean'
    ? habitable ? 'habitable' : 'barren' : habitable, effects);
  const capacity = forecast.capacity.total;
  const reason: GrowthReason = record.population === 0 ? 'empty' : record.population > capacity
    ? 'over-capacity' : record.population === capacity ? 'at-capacity' : 'growing';
  if (reason !== 'growing') return { capacity, delta: 0, reason, next: { ...record } };
  const numerator = BigInt(record.population) * BigInt(forecast.growthRate.total) + BigInt(Math.round(record.remainder * 100));
  const delta = Math.min(capacity - record.population, Number(numerator / 10000n));
  return { capacity, delta, reason, next: { population: record.population + delta,
    remainder: record.population + delta === capacity ? 0 : Number(numerator % 10000n) / 100 } };
}

export function advancePopulation(galaxy: CampaignState, input: PopulationState, faction: CampaignFactionId,
  rules: PopulationRules, effects: readonly RulesEffect[] = [], environment?: EnvironmentState): PopulationState {
  const next = structuredClone(input);
  for (const system of galaxy.systems) if (system.ownerId === faction) {
    next[system.id] = populationGrowth(input[system.id], rules, getColonyWorldType(galaxy, system.id, environment), effects).next;
  }
  return next;
}

export function quoteFounding(galaxy: CampaignState,
  population: PopulationState, faction: CampaignFactionId, target: SystemId, treasury: Treasury,
  rules: PopulationRules): FoundingQuote {
  const worlds = getGalaxyDefinition(galaxy).systems;
  const distance = (id: SystemId) => getWorldDistance(worlds, target, id);
  const source = galaxy.systems.filter(system => system.ownerId === faction && system.id !== target &&
    population[system.id]?.population >= rules.minimumSource)
    .sort((left, right) => distance(left.id) - distance(right.id) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0];
  if (!source) return { ok: false, code: 'NO_SETTLERS' };
  if (treasury.credits < rules.foundingCost.credits || treasury.minerals < rules.foundingCost.minerals) {
    return { ok: false, code: 'INSUFFICIENT_RESOURCES' };
  }
  return { ok: true, sourceId: source.id, cost: { ...rules.foundingCost } };
}

export function transferSettlers(population: PopulationState, sourceId: SystemId, target: SystemId,
  rules: PopulationRules): void {
  population[sourceId].population -= rules.settlers;
  population[target] = { population: rules.settlers, remainder: 0 };
}
