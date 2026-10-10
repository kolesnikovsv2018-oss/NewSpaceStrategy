import { z } from 'zod';
import { componentSchema, createComponentWithId, hullIdSchema, designSchema, validateDesign,
  type ComponentDefinition, type ComponentKind, type ShipDesign } from './shipDesign';
import { isCombatPresetDesign } from './combatPresets';
import { isCivilianPresetDesign } from './civilianPresets';

export const researchIdSchema = z.string().min(1).max(64).refine(value => !/[^a-z0-9-]/.test(value));
const kindSchema = z.enum(['engine', 'beam', 'projectile', 'shield', 'armor', 'mining', 'repair', 'scanner', 'cargoExpansion']);
const unlockSchema = z.object({ hulls: z.array(hullIdSchema).max(6), components: z.array(kindSchema).max(9) }).strict();
const researchNodeSchema = z.object({
  id: researchIdSchema, name: z.string().trim().min(1).max(80),
  prerequisites: z.array(researchIdSchema).max(64),
  credits: z.number().int().min(1).max(1000000),
  turns: z.number().int().min(1).max(1000), unlocks: unlockSchema
}).strict();
const treeFields = { id: researchIdSchema, initial: unlockSchema,
  nodes: z.array(researchNodeSchema).min(1).max(64) };
const legacyResearchTreeSchema = z.object({ ...treeFields, version: z.literal(1) }).strict();
const variantTierSchema = z.object({
  level: z.number().int().min(1).max(4), researchId: researchIdSchema.nullable(),
  magnitude: z.number().finite().min(0).max(1), ratioStep: z.number().finite().min(0).max(1),
  ammo: z.number().finite().min(0).max(1), rechargeDelay: z.number().finite().min(0).max(60)
}).strict();
const profiledResearchTreeSchema = z.object({ ...treeFields, version: z.literal(2),
  variantPolicy: z.object({ id: z.literal('component-bands-v1'), tiers: z.array(variantTierSchema).length(4) }).strict()
}).strict();

export const researchTreeSchema = z.union([legacyResearchTreeSchema, profiledResearchTreeSchema]).superRefine((tree, context) => {
  const nodes = new Map(tree.nodes.map(node => [node.id, node]));
  const fail = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'Недопустимое дерево исследований' });
  if (nodes.size !== tree.nodes.length || !tree.initial.hulls.includes('fighter') ||
    !tree.initial.components.includes('engine') || !tree.initial.components.includes('beam')) fail();
  const hulls = [...tree.initial.hulls, ...tree.nodes.flatMap(node => node.unlocks.hulls)];
  const kinds = [...tree.initial.components, ...tree.nodes.flatMap(node => node.unlocks.components)];
  if (new Set(hulls).size !== hulls.length || new Set(kinds).size !== kinds.length ||
    hulls.length !== hullIdSchema.options.length || kinds.length !== kindSchema.options.length) fail();
  for (const node of tree.nodes) {
    if (new Set(node.prerequisites).size !== node.prerequisites.length ||
      node.prerequisites.some(id => !nodes.has(id))) fail();
  }
  const resolved = new Set<string>();
  for (let pass = 0; pass < tree.nodes.length; pass++) {
    for (const node of tree.nodes) if (node.prerequisites.every(id => resolved.has(id))) resolved.add(node.id);
  }
  if (resolved.size !== nodes.size) fail();
  if (tree.version === 2) {
    const tiers = tree.variantPolicy.tiers;
    if (tiers.some((tier, index) => tier.level !== index + 1 || (index === 0) !== (tier.researchId === null)) ||
      new Set(tiers.flatMap(tier => tier.researchId ? [tier.researchId] : [])).size !== 3 ||
      tiers.some(tier => tier.researchId !== null && !nodes.has(tier.researchId))) fail();
  }
});
export type ResearchTree = z.infer<typeof researchTreeSchema>;
export type ProfiledResearchTree = Extract<ResearchTree, { version: 2 }>;

/** New imports require v2 with monotonic profiles; saved v2 snapshots remain structurally readable. */
export function parseProfiledResearchTree(input: unknown): ProfiledResearchTree {
  const tree = researchTreeSchema.parse(input);
  if (tree.version !== 2) throw new Error('Новая кампания требует дерево с профилями вариантов');
  const fields = ['magnitude', 'ratioStep', 'ammo', 'rechargeDelay'] as const;
  if (tree.variantPolicy.tiers.some((tier, index, tiers) => index > 0 &&
    fields.some(field => tier[field] < tiers[index - 1][field]))) {
    throw new Error('Диапазоны вариантов не могут сужаться в новом дереве исследований');
  }
  return tree;
}

const defaultTree: ResearchTree = {
  version: 2, id: 'orion-technologies-v2',
  initial: { hulls: ['fighter', 'corvette'], components: ['engine', 'beam'] },
  nodes: [
    { id: 'support', name: 'Флотская инфраструктура', prerequisites: [], credits: 10, turns: 2,
      unlocks: { hulls: ['frigate'], components: ['shield', 'armor', 'mining', 'repair', 'scanner', 'cargoExpansion'] } },
    { id: 'ordnance', name: 'Тяжёлое вооружение', prerequisites: ['support'], credits: 20, turns: 3,
      unlocks: { hulls: ['destroyer', 'cruiser'], components: ['projectile'] } },
    { id: 'capital', name: 'Линейные корабли', prerequisites: ['ordnance'], credits: 30, turns: 4,
      unlocks: { hulls: ['battleship'], components: [] } }
  ],
  variantPolicy: { id: 'component-bands-v1', tiers: [
    { level: 1, researchId: null, magnitude: 0.1, ratioStep: 0.05, ammo: 0.1, rechargeDelay: 0.5 },
    { level: 2, researchId: 'support', magnitude: 0.2, ratioStep: 0.1, ammo: 0.2, rechargeDelay: 1 },
    { level: 3, researchId: 'ordnance', magnitude: 0.3, ratioStep: 0.15, ammo: 0.3, rechargeDelay: 1.5 },
    { level: 4, researchId: 'capital', magnitude: 0.4, ratioStep: 0.2, ammo: 0.4, rechargeDelay: 2 }
  ] }
};

export function getDefaultResearchTree(): ResearchTree { return researchTreeSchema.parse(defaultTree); }

export const researchStateSchema = z.object({
  completed: z.array(researchIdSchema).max(64),
  active: z.object({ id: researchIdSchema, progress: z.number().int().min(0).max(999) }).strict().nullable()
}).strict();
export type ResearchState = z.infer<typeof researchStateSchema>;
export function createResearchState(): ResearchState { return { completed: [], active: null }; }

export function isResearchStateValid(state: ResearchState, tree: ResearchTree): boolean {
  if (new Set(state.completed).size !== state.completed.length) return false;
  if (state.completed.some(id => {
    const node = tree.nodes.find(item => item.id === id);
    return !node || node.prerequisites.some(required => !state.completed.includes(required));
  })) return false;
  if (!state.active) return true;
  const node = tree.nodes.find(item => item.id === state.active!.id);
  return !!node && !state.completed.includes(node.id) && state.active.progress < node.turns &&
    node.prerequisites.every(id => state.completed.includes(id));
}

export function getResearchAccess(state: ResearchState, tree: ResearchTree): ResearchTree['initial'] {
  if (!isResearchStateValid(state, tree)) throw new Error('Недопустимый прогресс исследований');
  return {
    hulls: [...tree.initial.hulls, ...tree.nodes.filter(node => state.completed.includes(node.id)).flatMap(node => node.unlocks.hulls)],
    components: [...tree.initial.components, ...tree.nodes.filter(node => state.completed.includes(node.id)).flatMap(node => node.unlocks.components)]
  };
}

export function getCampaignVariantTier(state: ResearchState, tree: ResearchTree): number {
  if (tree.version === 1) return 4;
  return tree.variantPolicy.tiers.reduce((level, tier) =>
    tier.researchId && state.completed.includes(tier.researchId) ? tier.level : level, 1);
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
  if (tree.version === 1) return true;
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
  return tree.version === 1 || componentWithinVariantTier(component, getCampaignVariantTier(state, tree), tree);
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
  if (tree.version === 1 || isCombatPresetDesign(design) || isCivilianPresetDesign(design)) return true;
  return components.every(component => componentWithinVariantTier(component, getCampaignVariantTier(state, tree), tree));
}

export function advanceResearch(state: ResearchState, tree: ResearchTree): ResearchState {
  const next = researchStateSchema.parse(state);
  if (!isResearchStateValid(next, tree)) throw new Error('Недопустимый прогресс исследований');
  if (next.active) {
    const node = tree.nodes.find(item => item.id === next.active!.id)!;
    next.active.progress++;
    if (next.active.progress === node.turns) { next.completed.push(node.id); next.active = null; }
  }
  return next;
}

export interface ResearchTreeSource { load(): Promise<unknown> }
export async function loadResearchTree(source: ResearchTreeSource): Promise<ProfiledResearchTree> {
  return parseProfiledResearchTree(await source.load());
}