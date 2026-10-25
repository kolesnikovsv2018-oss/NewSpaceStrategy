import { getGalaxyDefinition, type CampaignState, type SystemId } from './campaign';
import { activateRulesEffects, applyNumericEffects, COLONY_EFFECT_TARGETS,
  type ColonyEffectTarget, type RulesEffect, type RulesSnapshot } from './campaignRules';
import type { ResearchState, ResearchTree } from './campaignResearch';
import { getEnvironmentType, type EnvironmentState, type WorldType } from './worldEnvironment';

export type ColonyWorldType = WorldType;
export interface ColonyValueBreakdown {
  base: number;
  workers: number;
  labor: number;
  technology: number;
  limit: number;
  total: number;
  effectIds: string[];
}

export function getColonyWorldType(galaxy: CampaignState, systemId: SystemId, environment?: EnvironmentState): ColonyWorldType {
  if (environment) return getEnvironmentType(environment, systemId);
  if (galaxy.map) {
    const world = galaxy.map.worlds.find(world => world.id === systemId);
    if (!world) throw new Error('Тип отсутствующего мира недоступен');
    return world.type;
  }
  const world = getGalaxyDefinition(galaxy).systems.find(system => system.id === systemId);
  if (!world) throw new Error('Тип отсутствующего мира недоступен');
  return world.habitable ? 'habitable' : 'barren';
}

export function getCompletedColonyEffects(tree: ResearchTree, research: ResearchState, rules: RulesSnapshot): RulesEffect[] {
  const ids = new Set(tree.nodes.filter(node => research.completed.includes(node.id))
    .flatMap(node => node.effects.flatMap(effect => effect.kind === 'colony-effect' ? [effect.effectId] : [])));
  return activateRulesEffects(rules, [...ids], ['colony-technologies-v1']);
}

export function isColonyEffect(effect: RulesEffect): boolean {
  return effect.kind === 'modifier' && COLONY_EFFECT_TARGETS.some(target => target === effect.target);
}

export function calculateColonyValue(base: number, workers: number, target: ColonyEffectTarget,
  worldType: ColonyWorldType, effects: readonly RulesEffect[], absoluteLimit?: number): ColonyValueBreakdown {
  const labor = base * workers;
  if (!Number.isSafeInteger(labor) || labor < 0) throw new Error('Недопустимая база колониального расчёта');
  const selected = effects.filter(effect => effect.kind === 'modifier' &&
    effect.target === target && effect.worldTypes?.includes(worldType))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const modified = applyNumericEffects(labor, selected, { phase: 'on-turn-start' });
  const limit = target === 'capacity-add' ? absoluteLimit : Math.min(labor * 2, absoluteLimit ?? Number.MAX_SAFE_INTEGER);
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 0) throw new Error('Не задан допустимый предел колонии');
  return { base, workers, labor, technology: modified - labor, limit, total: Math.min(modified, limit),
    effectIds: selected.map(effect => effect.id) };
}
