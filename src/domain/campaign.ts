import { z } from 'zod';
import { validateGalaxyMap, type GalaxyMap } from './galaxyMap';

export const factionIdSchema = z.enum(['blue', 'red']);
export const systemIdSchema = z.union([z.enum(['sol', 'eden', 'rift', 'nexus', 'dust', 'vega']),
  z.string().regex(/^world-[0-9]{3}$/)]);
export type CampaignFactionId = z.infer<typeof factionIdSchema>;
export type SystemId = z.infer<typeof systemIdSchema>;

export interface StarSystemDefinition {
  id: SystemId;
  name: string;
  x: number;
  y: number;
  habitable: boolean;
}
export interface GalaxyDefinition {
  factions: { id: CampaignFactionId; name: string; homeSystemId: SystemId }[];
  systems: StarSystemDefinition[];
  lanes: [SystemId, SystemId][];
}

// Small fixed scenario, not a random generator or a tactical coordinate system.
const galaxy: GalaxyDefinition = {
  factions: [
    { id: 'blue', name: 'Синий союз', homeSystemId: 'sol' },
    { id: 'red', name: 'Красная лига', homeSystemId: 'vega' }
  ],
  systems: [
    { id: 'sol', name: 'Сол', x: 0, y: 0, habitable: true },
    { id: 'eden', name: 'Эдем', x: 1, y: 1, habitable: true },
    { id: 'rift', name: 'Разлом', x: 1, y: -1, habitable: false },
    { id: 'nexus', name: 'Узел', x: 2, y: 0, habitable: true },
    { id: 'dust', name: 'Пыль', x: 2, y: -2, habitable: false },
    { id: 'vega', name: 'Вега', x: 3, y: 0, habitable: true }
  ],
  lanes: [['sol', 'eden'], ['sol', 'rift'], ['eden', 'nexus'], ['rift', 'dust'], ['dust', 'nexus'], ['nexus', 'vega']]
};

/** Detached definition; callers cannot change the scenario used by commands. */
export function getGalaxyDefinition(state?: { map?: GalaxyMap }): GalaxyDefinition {
  if (state?.map) {
    const map = state.map;
    return {
      factions: map.participants.map((participant, index) => ({
        id: index === 0 ? 'blue' : 'red', name: participant.name, homeSystemId: participant.homeWorldId
      })),
      systems: map.worlds.map(world => ({
        id: world.id, name: world.name, x: world.x, y: world.y, habitable: world.type === 'habitable'
      })),
      lanes: map.lanes.map(([from, to]) => [from, to])
    };
  }
  return {
    factions: galaxy.factions.map(faction => ({ ...faction })),
    systems: galaxy.systems.map(system => ({ ...system })),
    lanes: galaxy.lanes.map(([from, to]) => [from, to])
  };
}

const systemStateSchema = z.object({
  id: systemIdSchema,
  ownerId: factionIdSchema.nullable(),
  exploredBy: z.array(factionIdSchema).max(2)
}).strict();

const campaignMapSchema = z.unknown().transform((input, ctx) => {
  const checked = validateGalaxyMap(input);
  if (!checked.ok || checked.map.participants.length !== 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Кампания требует проверенную карту для двух участников' });
    return z.NEVER;
  }
  return checked.map;
});

export const campaignStateSchema = z.object({
  map: campaignMapSchema.optional(),
  systems: z.array(systemStateSchema).min(1).max(256)
}).strict().superRefine((state, ctx) => {
  const definition = getGalaxyDefinition(state);
  if (state.systems.length !== definition.systems.length ||
    new Set(state.systems.map(system => system.id)).size !== definition.systems.length ||
    state.systems.some(system => !definition.systems.some(item => item.id === system.id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Нужна ровно одна запись каждой системы' });
  }
  for (const system of state.systems) {
    if (new Set(system.exploredBy).size !== system.exploredBy.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Стороны разведки не должны повторяться' });
    }
    if (system.ownerId !== null && (!system.exploredBy.includes(system.ownerId) ||
      !definition.systems.find(item => item.id === system.id)?.habitable)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Колония требует пригодную систему, разведанную владельцем' });
    }
  }
});
export type CampaignState = z.infer<typeof campaignStateSchema>;

export function createCampaignState(map?: GalaxyMap): CampaignState {
  const snapshot = map ? campaignMapSchema.parse(map) : undefined;
  const definition = getGalaxyDefinition({ map: snapshot });
  return {
    ...(snapshot ? { map: snapshot } : {}),
    systems: definition.systems.map(system => {
      const ownerId = definition.factions.find(faction => faction.homeSystemId === system.id)?.id ?? null;
      return { id: system.id, ownerId, exploredBy: ownerId === null ? [] : [ownerId] };
    })
  };
}

const commandFields = { factionId: factionIdSchema, systemId: systemIdSchema };
export const campaignCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explore'), ...commandFields }).strict(),
  z.object({ kind: z.literal('colonize'), ...commandFields }).strict()
]);
export type CampaignCommand = z.infer<typeof campaignCommandSchema>;
export type CampaignErrorCode = 'INVALID_STATE' | 'INVALID_COMMAND' | 'ALREADY_EXPLORED' |
  'OUT_OF_REACH' | 'NOT_EXPLORED' | 'OCCUPIED' | 'UNINHABITABLE';
export type CampaignCommandResult = { ok: true; state: CampaignState } |
  { ok: false; code: CampaignErrorCode; message: string };

function hasNeighbour(systemId: SystemId, candidates: readonly SystemId[], state?: { map?: GalaxyMap }): boolean {
  return getGalaxyDefinition(state).lanes.some(([from, to]) =>
    (from === systemId && candidates.includes(to)) || (to === systemId && candidates.includes(from)));
}

/** Party topology; without a snapshot, only the immutable peaceful scenario is used. */
export function areSystemsAdjacent(from: SystemId, to: SystemId, state?: { map?: GalaxyMap }): boolean {
  return hasNeighbour(systemIdSchema.parse(from), [systemIdSchema.parse(to)], state);
}

/** Pure atomic command: validate first, then change only the target in a detached state. */
export function executeCampaignCommand(inputState: unknown, inputCommand: unknown): CampaignCommandResult {
  const parsedState = campaignStateSchema.safeParse(inputState);
  if (!parsedState.success) return { ok: false, code: 'INVALID_STATE', message: 'Недопустимое состояние галактики' };
  const parsedCommand = campaignCommandSchema.safeParse(inputCommand);
  if (!parsedCommand.success) return { ok: false, code: 'INVALID_COMMAND', message: 'Недопустимая команда, сторона или система' };
  const state = parsedState.data;
  const { kind, factionId, systemId } = parsedCommand.data;
  const target = state.systems.find(system => system.id === systemId);
  if (!target) return { ok: false, code: 'INVALID_COMMAND', message: 'Система отсутствует на карте партии' };
  if (kind === 'explore') {
    if (target.exploredBy.includes(factionId)) {
      return { ok: false, code: 'ALREADY_EXPLORED', message: 'Система уже разведана этой стороной' };
    }
    const explored = state.systems.filter(system => system.exploredBy.includes(factionId)).map(system => system.id);
    if (!hasNeighbour(systemId, explored, state)) {
      return { ok: false, code: 'OUT_OF_REACH', message: 'Нет перехода из разведанной системы' };
    }
    target.exploredBy.push(factionId);
  } else {
    // Check visibility before reporting hidden ownership or habitability.
    if (!target.exploredBy.includes(factionId)) {
      return { ok: false, code: 'NOT_EXPLORED', message: 'Сначала разведайте систему' };
    }
    if (target.ownerId !== null) return { ok: false, code: 'OCCUPIED', message: 'Система уже колонизирована' };
    if (!getGalaxyDefinition(state).systems.find(system => system.id === systemId)!.habitable) {
      return { ok: false, code: 'UNINHABITABLE', message: 'Система непригодна для колонизации' };
    }
    const owned = state.systems.filter(system => system.ownerId === factionId).map(system => system.id);
    if (!hasNeighbour(systemId, owned, state)) {
      return { ok: false, code: 'OUT_OF_REACH', message: 'Нет перехода из собственной колонии' };
    }
    target.ownerId = factionId;
  }
  return { ok: true, state };
}

type PublicSystem = Pick<StarSystemDefinition, 'id' | 'name' | 'x' | 'y'>;
export type CampaignSystemView = PublicSystem & (
  { visibility: 'unknown' } |
  { visibility: 'explored'; habitable: boolean; ownerId: CampaignFactionId | null }
);
export interface CampaignView {
  factionId: CampaignFactionId;
  systems: CampaignSystemView[];
  lanes: [SystemId, SystemId][];
}

/** Public map topology; only explored systems expose current ownership/habitability.
 * Exploration is permanent in S3.1, not a last-seen intelligence snapshot.
 * Invalid query arguments throw ZodError; commands instead return typed failures.
 */
export function getCampaignView(inputState: CampaignState, factionId: CampaignFactionId): CampaignView {
  const state = campaignStateSchema.parse(inputState);
  const faction = factionIdSchema.parse(factionId);
  const definition = getGalaxyDefinition(state);
  return {
    factionId: faction,
    systems: definition.systems.map(definition => {
      const system = state.systems.find(item => item.id === definition.id)!;
      const { id, name, x, y } = definition;
      return system.exploredBy.includes(faction)
        ? { id, name, x, y, visibility: 'explored', habitable: definition.habitable, ownerId: system.ownerId }
        : { id, name, x, y, visibility: 'unknown' };
    }),
    lanes: definition.lanes.map(([from, to]) => [from, to])
  };
}
