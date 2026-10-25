import { z } from 'zod';
import { componentSchema, createComponentWithId, hullIdSchema, designSchema, validateDesign, HULLS,
  type ComponentDefinition, type ComponentKind, type ShipDesign } from './shipDesign';
import { isCombatPresetDesign } from './combatPresets';
import { isCivilianPresetDesign } from './civilianPresets';
import { createDefaultRulesSnapshot, COLONY_EFFECT_TARGETS, type RulesEffect, type RulesSnapshot } from './campaignRules';

export const researchIdSchema = z.string().min(1).max(64).refine(value => !/[^a-z0-9-]/.test(value));
const kindSchema = z.enum(['engine', 'beam', 'projectile', 'shield', 'armor', 'mining', 'repair', 'scanner', 'cargoExpansion']);
const unlockSchema = z.object({ hulls: z.array(hullIdSchema).max(7), components: z.array(kindSchema).max(9) }).strict();
export const MAX_RESEARCH_COST = 1_000_000_000;
const pointsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const researchEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hull-unlock'), hullId: hullIdSchema }).strict(),
  z.object({ kind: z.literal('component-unlock'), component: kindSchema }).strict(),
  z.object({ kind: z.literal('variant-tier'), tier: z.number().int().min(2).max(4) }).strict(),
  z.object({ kind: z.literal('colony-effect'), effectId: researchIdSchema }).strict(),
  z.object({ kind: z.literal('colonization-unlock'), worldType: z.literal('toxic') }).strict(),
  z.object({ kind: z.literal('strategic-range'), maxJumpDistance: z.union([z.literal(400), z.literal(800), z.literal(1500)]) }).strict()
]);
export type ResearchEffect = z.infer<typeof researchEffectSchema>;
const researchNodeSchema = z.object({
  id: researchIdSchema, name: z.string().trim().min(1).max(80),
  prerequisites: z.array(researchIdSchema).max(64),
  researchCost: z.number().int().min(1).max(MAX_RESEARCH_COST),
  effects: z.array(researchEffectSchema).min(1).max(32)
}).strict();
const variantTierSchema = z.object({
  level: z.number().int().min(1).max(4),
  magnitude: z.number().finite().min(0).max(1), ratioStep: z.number().finite().min(0).max(1),
  ammo: z.number().finite().min(0).max(1), rechargeDelay: z.number().finite().min(0).max(60)
}).strict();
export const researchTreeSchema = z.object({
  version: z.literal(6), id: researchIdSchema, initial: unlockSchema,
  nodes: z.array(researchNodeSchema).min(1).max(64),
  variantPolicy: z.object({ id: z.literal('component-bands-v1'), tiers: z.array(variantTierSchema).length(4) }).strict()
}).strict().superRefine((tree, context) => {
  const nodes = new Map(tree.nodes.map(node => [node.id, node]));
  const fail = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'Недопустимое дерево исследований' });
  if (nodes.size !== tree.nodes.length || !tree.initial.hulls.includes('fighter') || !tree.initial.hulls.includes('colonizer') ||
    !tree.initial.components.includes('engine') || !tree.initial.components.includes('beam')) fail();
  const effects = tree.nodes.flatMap(node => node.effects);
  if (!effects.some(effect => effect.kind === 'colonization-unlock' && effect.worldType === 'toxic')) fail();
  const ranges = new Set<number>(effects.flatMap(effect => effect.kind === 'strategic-range' ? [effect.maxJumpDistance] : []));
  if (![400, 800, 1500].every(range => ranges.has(range))) fail();
  const registeredIds = new Set(createDefaultRulesSnapshot().effects.filter(effect =>
    COLONY_EFFECT_TARGETS.some(target => target === effect.target)).map(effect => effect.id));
  if (effects.some(effect => effect.kind === 'colony-effect' && !registeredIds.has(effect.effectId))) fail();
  const hulls = new Set([...tree.initial.hulls, ...effects.flatMap(effect => effect.kind === 'hull-unlock' ? [effect.hullId] : [])]);
  const kinds = new Set([...tree.initial.components, ...effects.flatMap(effect => effect.kind === 'component-unlock' ? [effect.component] : [])]);
  if (new Set(tree.initial.hulls).size !== tree.initial.hulls.length ||
    new Set(tree.initial.components).size !== tree.initial.components.length ||
    hulls.size !== hullIdSchema.options.length || kinds.size !== kindSchema.options.length) fail();
  for (const node of tree.nodes) {
    if (new Set(node.prerequisites).size !== node.prerequisites.length ||
      node.prerequisites.some(id => !nodes.has(id))) fail();
    const keys = node.effects.map(effect => JSON.stringify(effect));
    if (new Set(keys).size !== keys.length) fail();
    if (node.effects.some(effect => effect.kind === 'hull-unlock' ? tree.initial.hulls.includes(effect.hullId)
      : effect.kind === 'component-unlock' ? tree.initial.components.includes(effect.component) : false)) fail();
  }
  const resolved = new Set<string>();
  for (let pass = 0; pass < tree.nodes.length; pass++) {
    for (const node of tree.nodes) if (node.prerequisites.every(id => resolved.has(id))) resolved.add(node.id);
  }
  if (resolved.size !== nodes.size) fail();
  const fields = ['magnitude', 'ratioStep', 'ammo', 'rechargeDelay'] as const;
  if (tree.variantPolicy.tiers.some((tier, index, tiers) => tier.level !== index + 1 ||
    (index > 0 && fields.some(field => tier[field] < tiers[index - 1][field])))) fail();
});
export type ResearchTree = z.infer<typeof researchTreeSchema>;
export type ProfiledResearchTree = ResearchTree;
export function parseProfiledResearchTree(input: unknown): ProfiledResearchTree {
  return researchTreeSchema.parse(input);
}

const defaultTree: ResearchTree = {
  version: 6, id: 'orion-technologies-v6',
  initial: { hulls: ['fighter', 'corvette', 'colonizer'], components: ['engine', 'beam'] },
  nodes: [
    { id: 'engineering', name: 'Инженерные методы', prerequisites: [], researchCost: 2000,
      effects: [{ kind: 'variant-tier', tier: 2 }, { kind: 'strategic-range', maxJumpDistance: 400 }] },
    { id: 'applied', name: 'Прикладные службы', prerequisites: [], researchCost: 2000,
      effects: ['mining', 'repair', 'scanner', 'cargoExpansion'].map(component =>
        ({ kind: 'component-unlock' as const, component: kindSchema.parse(component) })) },
    { id: 'support', name: 'Флотская инфраструктура', prerequisites: [], researchCost: 3000,
      effects: [{ kind: 'hull-unlock', hullId: 'frigate' }, { kind: 'component-unlock', component: 'shield' },
        { kind: 'component-unlock', component: 'armor' }] },
    { id: 'ordnance', name: 'Тяжёлое вооружение', prerequisites: ['engineering', 'support'], researchCost: 6000,
      effects: [{ kind: 'hull-unlock', hullId: 'destroyer' }, { kind: 'hull-unlock', hullId: 'cruiser' },
        { kind: 'component-unlock', component: 'projectile' }, { kind: 'variant-tier', tier: 3 },
        { kind: 'strategic-range', maxJumpDistance: 800 }] },
    { id: 'capital', name: 'Линейные корабли', prerequisites: ['ordnance'], researchCost: 12000,
      effects: [{ kind: 'hull-unlock', hullId: 'battleship' }, { kind: 'variant-tier', tier: 4 },
        { kind: 'strategic-range', maxJumpDistance: 1500 }] },
    { id: 'biology', name: 'Биология', prerequisites: [], researchCost: 2000,
      effects: [{ kind: 'colony-effect', effectId: 'biology-growth' }] },
    { id: 'biosphere', name: 'Биосфера', prerequisites: ['biology'], researchCost: 4000,
      effects: [{ kind: 'colony-effect', effectId: 'biosphere-capacity' }] },
    { id: 'automation', name: 'Автоматизация', prerequisites: ['engineering'], researchCost: 3000,
      effects: [{ kind: 'colony-effect', effectId: 'automation-output' }] },
    { id: 'scientific-method', name: 'Научные методы', prerequisites: ['applied'], researchCost: 3000,
      effects: [{ kind: 'colony-effect', effectId: 'scientific-output' }] },
    { id: 'cultural-practices', name: 'Культурные практики', prerequisites: [], researchCost: 2000,
      effects: [{ kind: 'colony-effect', effectId: 'cultural-output' }] },
    { id: 'toxic-adaptation', name: 'Адаптация к токсичной среде', prerequisites: [], researchCost: 3000,
      effects: [{ kind: 'colonization-unlock', worldType: 'toxic' }] }
  ],
  variantPolicy: { id: 'component-bands-v1', tiers: [
    { level: 1, magnitude: 0.1, ratioStep: 0.05, ammo: 0.1, rechargeDelay: 0.5 },
    { level: 2, magnitude: 0.2, ratioStep: 0.1, ammo: 0.2, rechargeDelay: 1 },
    { level: 3, magnitude: 0.3, ratioStep: 0.15, ammo: 0.3, rechargeDelay: 1.5 },
    { level: 4, magnitude: 0.4, ratioStep: 0.2, ammo: 0.4, rechargeDelay: 2 }
  ] }
};

export function getDefaultResearchTree(): ResearchTree { return researchTreeSchema.parse(defaultTree); }

export function getStrategicRange(state: ResearchState, tree: ResearchTree, rules: RulesSnapshot): number {
  return Math.max(rules.travel.initialRange, ...tree.nodes.filter(node => state.completed.includes(node.id))
    .flatMap(node => node.effects.flatMap(effect => effect.kind === 'strategic-range' ? [effect.maxJumpDistance] : [])));
}

export const researchStateSchema = z.object({
  completed: z.array(researchIdSchema).max(64),
  activeId: researchIdSchema.nullable(),
  progress: z.record(researchIdSchema, z.number().int().min(0).max(MAX_RESEARCH_COST - 1))
    .refine(value => Object.keys(value).length <= 64)
}).strict();
export type ResearchState = z.infer<typeof researchStateSchema>;
export function createResearchState(): ResearchState { return { completed: [], activeId: null, progress: {} }; }
export function getResearchProgress(state: ResearchState, id: string): number {
  return Object.prototype.hasOwnProperty.call(state.progress, id) ? state.progress[id] : 0;
}

export function isResearchStateValid(state: ResearchState, tree: ResearchTree): boolean {
  if (new Set(state.completed).size !== state.completed.length) return false;
  if (state.completed.some(id => {
    const node = tree.nodes.find(item => item.id === id);
    return !node || node.prerequisites.some(required => !state.completed.includes(required));
  })) return false;
  const available = (id: string): boolean => {
    const node = tree.nodes.find(item => item.id === id);
    return !!node && !state.completed.includes(id) && node.prerequisites.every(required => state.completed.includes(required));
  };
  return Object.entries(state.progress).every(([id, progress]) =>
    available(id) && progress < tree.nodes.find(node => node.id === id)!.researchCost) &&
    (state.activeId === null || (available(state.activeId) && Object.prototype.hasOwnProperty.call(state.progress, state.activeId)));
}

export function getResearchAccess(state: ResearchState, tree: ResearchTree): ResearchTree['initial'] {
  if (!isResearchStateValid(state, tree)) throw new Error('Недопустимый прогресс исследований');
  const effects = tree.nodes.filter(node => state.completed.includes(node.id)).flatMap(node => node.effects);
  return { hulls: [...new Set([...tree.initial.hulls, ...effects.flatMap(effect => effect.kind === 'hull-unlock' ? [effect.hullId] : [])])],
    components: [...new Set([...tree.initial.components, ...effects.flatMap(effect => effect.kind === 'component-unlock' ? [effect.component] : [])])] };
}

export function getCampaignVariantTier(state: ResearchState, tree: ResearchTree): number {
  return tree.nodes.filter(node => state.completed.includes(node.id)).flatMap(node => node.effects)
    .reduce((level, effect) => effect.kind === 'variant-tier' ? Math.max(level, effect.tier) : level, 1);
}

export function getCampaignVariantProfile(tree: ProfiledResearchTree, tier: number) {
  if (!Number.isInteger(tier) || tier < 1 || tier > tree.variantPolicy.tiers.length) {
    throw new RangeError('Недопустимый уровень профиля вариантов');
  }
  return tree.variantPolicy.tiers.slice(0, tier).reduce((effective, profile) => ({
    magnitude: Math.max(effective.magnitude, profile.magnitude),
    ratioStep: Math.max(effective.ratioStep, profile.ratioStep),
    ammo: Math.max(effective.ammo, profile.ammo),
    rechargeDelay: Math.max(effective.rechargeDelay, profile.rechargeDelay)
  }), { magnitude: 0, ratioStep: 0, ammo: 0, rechargeDelay: 0 });
}

const magnitudeFields: Partial<Record<ComponentKind, readonly string[]>> = {
  beam: ['damage', 'range', 'fireRate'], projectile: ['damage', 'range', 'fireRate'],
  engine: ['thrust', 'maxSpeed', 'powerGeneration'], shield: ['capacity', 'rechargeRate'],
  armor: ['armorPoints'], mining: ['miningSpeed'], repair: ['repairRate'], scanner: ['range'],
  cargoExpansion: ['bonusCapacity']
};
const ratioFields: Partial<Record<ComponentKind, readonly string[]>> = {
  beam: ['accuracy'], projectile: ['accuracy'], engine: ['maneuverability'], shield: ['beamResistance'],
  armor: ['beamResistance', 'projectileResistance'], mining: ['efficiency'], scanner: ['accuracy']
};

function componentWithinVariantTier(component: ComponentDefinition, tier: number, tree: ResearchTree): boolean {
  const profile = getCampaignVariantProfile(tree, tier);
  const defaults = createComponentWithId(component.kind, 'campaign-variant-default') as unknown as Record<string, number>;
  const values = component as unknown as Record<string, number>;
  for (const key of magnitudeFields[component.kind] ?? []) {
    const baseline = defaults[key], limit = baseline * profile.magnitude;
    if (values[key] < baseline - limit - 1e-9 || values[key] > baseline + limit + 1e-9) return false;
  }
  for (const key of ratioFields[component.kind] ?? []) {
    if (Math.abs(values[key] - defaults[key]) > profile.ratioStep + 1e-9) return false;
  }
  if (component.kind === 'projectile') {
    const limit = defaults.ammoCapacity * profile.ammo;
    if (component.ammoCapacity < Math.max(1, Math.floor(defaults.ammoCapacity - limit)) ||
      component.ammoCapacity > Math.ceil(defaults.ammoCapacity + limit)) return false;
  }
  if (component.kind === 'shield' &&
    Math.abs(component.rechargeDelay - defaults.rechargeDelay) > profile.rechargeDelay + 1e-9) return false;
  return true;
}

export function isCampaignComponentVariantAvailable(component: ComponentDefinition, state: ResearchState, tree: ResearchTree): boolean {
  if (!componentSchema.safeParse(component).success) return false;
  const access = getResearchAccess(state, tree);
  if (!access.components.includes(component.kind)) return false;
  return componentWithinVariantTier(component, getCampaignVariantTier(state, tree), tree);
}

export function isCampaignDesignAvailable(design: ShipDesign, state: ResearchState, tree: ResearchTree): boolean {
  return validateDesign(design, 'flight').length === 0 && isCampaignDraftAvailable(design, state, tree);
}

export function isCampaignDraftAvailable(design: ShipDesign, state: ResearchState, tree: ResearchTree): boolean {
  if (!designSchema.safeParse(design).success || validateDesign(design, 'draft').length) return false;
  const access = getResearchAccess(state, tree);
  if (!access.hulls.includes(design.hullId)) return false;
  const components = design.slots.flatMap(slot => slot.component ? [slot.component] : []);
  if (components.some(component => !access.components.includes(component.kind))) return false;
  if (isCombatPresetDesign(design) || isCivilianPresetDesign(design)) return true;
  return components.every(component => componentWithinVariantTier(component, getCampaignVariantTier(state, tree), tree));
}

export interface ResearchTurnReceipt {
  reserveBefore: number; produced: number; spent: number; overflow: number; reserveAfter: number;
  cap: number; activeId: string | null; progressBefore: number; progressAfter: number;
  completedId: string | null; accepted: number;
}
export type ResearchTiming = { status: 'idle' | 'paused'; reason: 'no-project' | 'no-colonies' | 'no-science' }
  | { status: 'unavailable'; reason: 'turn-limit' | 'campaign-completed' }
  | { status: 'progressing' | 'completes'; remainingOwnTurns: number };

export function calculateResearchTurn(state: ResearchState, tree: ResearchTree, reserveInput: number,
  producedInput: number, capInput: number, hasColonies: boolean): {
    state: ResearchState; receipt: ResearchTurnReceipt; timing: ResearchTiming;
  } {
  const next = researchStateSchema.parse(state);
  if (!isResearchStateValid(next, tree)) throw new Error('Недопустимый прогресс исследований');
  const reserve = pointsSchema.parse(reserveInput), produced = pointsSchema.parse(producedInput), cap = pointsSchema.parse(capInput);
  if (!hasColonies && produced !== 0) throw new Error('Научный выпуск без колоний');
  const node = tree.nodes.find(item => item.id === next.activeId);
  const progressBefore = node ? next.progress[node.id] : 0;
  const remaining = node ? node.researchCost - progressBefore : 0;
  const fromReserve = node && hasColonies ? Math.min(reserve, remaining) : 0;
  const fromOutput = node && hasColonies ? Math.min(produced, remaining - fromReserve) : 0;
  const spent = fromReserve + fromOutput, afterSpend = reserve - fromReserve;
  const accepted = Math.min(produced - fromOutput, Math.max(0, cap - afterSpend));
  const progressAfter = progressBefore + spent;
  const completedId = node && progressAfter === node.researchCost ? node.id : null;
  let timing: ResearchTiming;
  if (!node) timing = { status: 'idle', reason: 'no-project' };
  else if (!hasColonies) timing = { status: 'paused', reason: 'no-colonies' };
  else if (completedId) timing = { status: 'completes', remainingOwnTurns: 1 };
  else if (produced === 0) timing = { status: 'paused', reason: 'no-science' };
  else timing = { status: 'progressing', remainingOwnTurns: 1 + Math.ceil((remaining - spent) / produced) };
  if (node) {
    if (completedId) { next.completed.push(node.id); delete next.progress[node.id]; next.activeId = null; }
    else next.progress[node.id] = progressAfter;
  }
  return { state: next, timing, receipt: { reserveBefore: reserve, produced, spent,
    overflow: produced - fromOutput - accepted, reserveAfter: afterSpend + accepted,
    cap, activeId: state.activeId, progressBefore, progressAfter, completedId, accepted } };
}

export function describeResearchEffect(effect: ResearchEffect, tree: ResearchTree,
  catalog: readonly RulesEffect[] = createDefaultRulesSnapshot().effects): string {
  if (effect.kind === 'colonization-unlock') return 'основание колоний: токсичные миры, без изменения среды';
  if (effect.kind === 'strategic-range') return `стратегическая дальность ${effect.maxJumpDistance} гал. ед.`;
  if (effect.kind === 'hull-unlock') return `корпус ${HULLS[effect.hullId].name}`;
  if (effect.kind === 'component-unlock') return `семейство ${createComponentWithId(effect.component, 'research-label').name}`;
  if (effect.kind === 'colony-effect') {
    const entry = catalog.find(item => item.id === effect.effectId);
    if (!entry) throw new Error('Неизвестный колониальный эффект');
    return `${entry.description ?? entry.target}: ${entry.operation} ${entry.unit === 'percent' ? `${entry.value * 100}%` : entry.value}`;
  }
  const profile = getCampaignVariantProfile(tree, effect.tier);
  return `все модули: параметры ±${Math.round(profile.magnitude * 100)}%, доли ±${profile.ratioStep}, боезапас ±${Math.round(profile.ammo * 100)}%, задержка щита ±${profile.rechargeDelay}с`;
}

export interface ResearchTreeSource { load(): Promise<unknown> }
export async function loadResearchTree(source: ResearchTreeSource): Promise<ProfiledResearchTree> {
  return parseProfiledResearchTree(await source.load());
}