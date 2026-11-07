import { z } from 'zod';
import { MAX_PARTICIPANTS, validateGalaxyMap, type GalaxyMap } from './galaxyMap';

export const factionIdSchema = z.enum(['blue', 'red']);
/**
 * Н17.2: канонический идентификатор участника военной кампании — стабильный `player-NN`
 * из снимка карты. Enum blue/red остаётся только в мирной песочнице; новая политика
 * не выводит участников из enum (docs/CAMPAIGN_MULTI_FACTION.md).
 */
export const participantIdSchema = z.string().regex(/^player-[0-9]{2}$/);
export type ParticipantId = z.infer<typeof participantIdSchema>;

/** Фиксированная палитра Н17.1: цвет по позиции участника, не от seed и не из enum. */
export const CAMPAIGN_PARTICIPANT_COLORS = Object.freeze([
  0x55baff, 0xf08070, 0x7fd76a, 0xf2d24b, 0xb07fe8, 0x4fd6c0, 0xe86bb0, 0x9aa8c0
] as const);

/** Цвет участника по его позиции в расписании; позиции вне палитры недопустимы. */
export function getParticipantColor(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= CAMPAIGN_PARTICIPANT_COLORS.length) {
    throw new Error('Позиция участника вне фиксированной палитры');
  }
  return CAMPAIGN_PARTICIPANT_COLORS[index];
}

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
export interface CampaignParticipantRef {
  id: ParticipantId;
  name: string;
  homeSystemId: SystemId;
}
export interface GalaxyDefinition {
  factions: { id: CampaignFactionId | ParticipantId; name: string; homeSystemId: SystemId }[];
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

/**
 * Фиксированные участники военного сценария без карты: канонические преемники blue/red
 * по палитре Н17.1 (позиция 1 — синий, позиция 2 — коралловый). Мирный фиксированный
 * сценарий выше сохраняет blue/red и не мигрирует.
 */
export const fixedCampaignParticipants: readonly CampaignParticipantRef[] = [
  { id: 'player-01', name: 'Синий союз', homeSystemId: 'sol' },
  { id: 'player-02', name: 'Красная лига', homeSystemId: 'vega' }
];

/** Участники военной кампании 1:1 из снимка карты; без карты — фиксированный военный сценарий. */
export function getCampaignParticipants(state?: { map?: GalaxyMap }): CampaignParticipantRef[] {
  return state?.map
    ? state.map.participants.map(participant => ({
        id: participant.id, name: participant.name, homeSystemId: participant.homeWorldId
      }))
    : fixedCampaignParticipants.map(participant => ({ ...participant }));
}

/** Структурное представление состояния галактики для общих операций мира и военной кампании. */
export type GalaxyOwnershipView = {
  map?: GalaxyMap;
  systems: readonly { id: SystemId; ownerId: string | null }[];
};

/** Detached definition; callers cannot change the scenario used by commands.
 * Со снимком карты участники возвращаются 1:1 (`player-NN`), без маппинга «первый blue,
 * остальные red»; фиксированный мирный сценарий сохраняет blue/red. */
export function getGalaxyDefinition(state?: { map?: GalaxyMap }): GalaxyDefinition {
  if (state?.map) {
    const map = state.map;
    return {
      factions: map.participants.map(participant => ({
        id: participant.id, name: participant.name, homeSystemId: participant.homeWorldId
      })),
      systems: map.worlds.map(world => ({
        id: world.id, name: world.name, x: world.x, y: world.y, habitable: world.type !== 'barren'
      })),
      lanes: []
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

/** Н17.2: снимок карты военной кампании — участники 2..8, как поддержано генератором. */
const conquestMapSchema = z.unknown().transform((input, ctx) => {
  const checked = validateGalaxyMap(input);
  if (!checked.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Кампания требует проверенный снимок карты' });
    return z.NEVER;
  }
  return checked.map;
});

/** Мирная песочница: состояние без карты, blue/red, формат не мигрирует. */
function refineGalaxyState(systems: readonly { id: SystemId; ownerId: string | null; exploredBy: readonly string[] }[],
  definition: GalaxyDefinition, dynamicEnvironment: boolean, ctx: z.RefinementCtx): void {
  if (systems.length !== definition.systems.length ||
    new Set(systems.map(system => system.id)).size !== definition.systems.length ||
    systems.some(system => !definition.systems.some(item => item.id === system.id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Нужна ровно одна запись каждой системы' });
    return;
  }
  for (const system of systems) {
    if (new Set(system.exploredBy).size !== system.exploredBy.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Стороны разведки не должны повторяться' });
    }
    if (system.ownerId !== null && (!system.exploredBy.includes(system.ownerId) ||
      !dynamicEnvironment && !definition.systems.find(item => item.id === system.id)?.habitable)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Колония требует пригодную систему, разведанную владельцем' });
    }
  }
}

function makeCampaignStateSchema(dynamicEnvironment: boolean) { return z.object({
  map: campaignMapSchema.optional(),
  systems: z.array(systemStateSchema).min(1).max(256)
}).strict().superRefine((state, ctx) => {
  refineGalaxyState(state.systems, getGalaxyDefinition(state), dynamicEnvironment, ctx);
}); }
export const campaignStateSchema = makeCampaignStateSchema(false);
export type CampaignState = z.infer<typeof campaignStateSchema>;

/** Н17.2: состояние галактики военной кампании — владельцы и разведка по participant IDs. */
const participantSystemStateSchema = z.object({
  id: systemIdSchema,
  ownerId: participantIdSchema.nullable(),
  exploredBy: z.array(participantIdSchema).max(MAX_PARTICIPANTS)
}).strict();

function makeConquestGalaxyStateSchema() { return z.object({
  map: conquestMapSchema.optional(),
  systems: z.array(participantSystemStateSchema).min(1).max(256)
}).strict().superRefine((state, ctx) => {
  refineGalaxyState(state.systems, getGalaxyDefinition(state), true, ctx);
}); }
export const conquestGalaxyStateSchema = makeConquestGalaxyStateSchema();
export type ConquestGalaxyState = z.infer<typeof conquestGalaxyStateSchema>;

/** Мирная песочница: только фиксированный сценарий без карты. */
export function createCampaignState(): CampaignState {
  const definition = getGalaxyDefinition();
  return {
    systems: definition.systems.map(system => {
      // Mapless peace path only: the fixed scenario keeps the blue/red enum literals.
      const ownerId = galaxy.factions.find(faction => faction.homeSystemId === system.id)?.id as CampaignFactionId | null ?? null;
      return { id: system.id, ownerId, exploredBy: ownerId === null ? [] : [ownerId] };
    })
  };
}

/** Военная кампания: участники 1:1 из снимка карты; без карты — фиксированный сценарий. */
export function createConquestState(map?: GalaxyMap): ConquestGalaxyState {
  const snapshot = map ? conquestMapSchema.parse(map) : undefined;
  const definition = getGalaxyDefinition(snapshot ? { map: snapshot } : undefined);
  const participants = getCampaignParticipants(snapshot ? { map: snapshot } : undefined);
  return {
    ...(snapshot ? { map: snapshot } : {}),
    systems: definition.systems.map(system => {
      const ownerId = participants.find(participant => participant.homeSystemId === system.id)?.id ?? null;
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

/** Военная кампания: географические команды по participant IDs (используются сессией). */
export const conquestGalaxyCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explore'), factionId: participantIdSchema, systemId: systemIdSchema }).strict(),
  z.object({ kind: z.literal('colonize'), factionId: participantIdSchema, systemId: systemIdSchema }).strict()
]);
export type ConquestGalaxyCommand = z.infer<typeof conquestGalaxyCommandSchema>;

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
export type ConquestSystemView = PublicSystem & (
  { visibility: 'unknown' } |
  { visibility: 'explored'; habitable: boolean; ownerId: ParticipantId | null }
);
export interface ConquestGalaxyView {
  factionId: ParticipantId;
  systems: ConquestSystemView[];
  lanes: [SystemId, SystemId][];
}

function galaxyView<Side extends string, OwnerId extends string>(
  systems: readonly { id: SystemId; ownerId: OwnerId | null; exploredBy: readonly string[] }[],
  definition: GalaxyDefinition, faction: Side
): {
  systems: (PublicSystem & ({ visibility: 'unknown' } |
    { visibility: 'explored'; habitable: boolean; ownerId: OwnerId | null }))[];
  lanes: [SystemId, SystemId][];
} {
  return {
    systems: definition.systems.map(definition => {
      const system = systems.find(item => item.id === definition.id)!;
      const { id, name, x, y } = definition;
      return system.exploredBy.includes(faction)
        ? { id, name, x, y, visibility: 'explored' as const, habitable: definition.habitable, ownerId: system.ownerId }
        : { id, name, x, y, visibility: 'unknown' as const };
    }),
    lanes: definition.lanes.map(([from, to]) => [from, to])
  };
}

/** Public map topology; only explored systems expose current ownership/habitability.
 * Exploration is permanent in S3.1, not a last-seen intelligence snapshot.
 * Invalid query arguments throw ZodError; commands instead return typed failures.
 */
export function getCampaignView(inputState: CampaignState, factionId: CampaignFactionId): CampaignView {
  const state = campaignStateSchema.parse(inputState);
  const faction = factionIdSchema.parse(factionId);
  return { factionId: faction, ...galaxyView(state.systems, getGalaxyDefinition(state), faction) };
}

/** Военная кампания: проекция карты для участника по participant IDs. */
export function getConquestGalaxyView(inputState: ConquestGalaxyState, participant: ParticipantId): ConquestGalaxyView {
  const state = conquestGalaxyStateSchema.parse(inputState);
  const faction = participantIdSchema.parse(participant);
  return { factionId: faction, ...galaxyView(state.systems, getGalaxyDefinition(state), faction) };
}
