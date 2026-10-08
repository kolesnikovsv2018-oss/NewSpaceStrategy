import { z } from 'zod';
import { hullIdSchema, designSchema, validateDesign, type ShipDesign } from './shipDesign';

export const researchIdSchema = z.string().min(1).max(64).refine(value => !/[^a-z0-9-]/.test(value));
const kindSchema = z.enum(['engine', 'beam', 'projectile', 'shield', 'armor', 'mining', 'repair', 'scanner', 'cargoExpansion']);
const unlockSchema = z.object({ hulls: z.array(hullIdSchema).max(6), components: z.array(kindSchema).max(9) }).strict();
export const researchTreeSchema = z.object({
  version: z.literal(1), id: researchIdSchema,
  initial: unlockSchema,
  nodes: z.array(z.object({
    id: researchIdSchema, name: z.string().trim().min(1).max(80),
    prerequisites: z.array(researchIdSchema).max(64),
    credits: z.number().int().min(1).max(1000000),
    turns: z.number().int().min(1).max(1000), unlocks: unlockSchema
  }).strict()).min(1).max(64)
}).strict().superRefine((tree, context) => {
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
});
export type ResearchTree = z.infer<typeof researchTreeSchema>;

const defaultTree: ResearchTree = {
  version: 1, id: 'orion-technologies-v1',
  initial: { hulls: ['fighter', 'corvette'], components: ['engine', 'beam'] },
  nodes: [
    { id: 'support', name: 'Флотская инфраструктура', prerequisites: [], credits: 10, turns: 2,
      unlocks: { hulls: ['frigate'], components: ['shield', 'armor', 'mining', 'repair', 'scanner', 'cargoExpansion'] } },
    { id: 'ordnance', name: 'Тяжёлое вооружение', prerequisites: ['support'], credits: 20, turns: 3,
      unlocks: { hulls: ['destroyer', 'cruiser'], components: ['projectile'] } },
    { id: 'capital', name: 'Линейные корабли', prerequisites: ['ordnance'], credits: 30, turns: 4,
      unlocks: { hulls: ['battleship'], components: [] } }
  ]
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

export function isCampaignDesignAvailable(design: ShipDesign, state: ResearchState, tree: ResearchTree): boolean {
  if (!designSchema.safeParse(design).success || validateDesign(design, 'flight').length) return false;
  const access = getResearchAccess(state, tree);
  return access.hulls.includes(design.hullId) && design.slots.every(slot => !slot.component || access.components.includes(slot.component.kind));
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
export async function loadResearchTree(source: ResearchTreeSource): Promise<ResearchTree> {
  return researchTreeSchema.parse(await source.load());
}