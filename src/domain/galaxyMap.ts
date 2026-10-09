import { z } from 'zod';

export const GALAXY_MAP_FORMAT = 'orion-galaxy-map';
export const GALAXY_MAP_SCHEMA_VERSION = 1;
export const GALAXY_MAP_RULES_VERSION = 1;
export const GALAXY_GENERATOR_VERSION = 'galaxy-generator-v1';
export const GALAXY_PROFILE_ID = 'balanced-start-v1';
export const MAX_GALAXY_WORLDS = 256;
export const MIN_PARTICIPANTS = 2;
export const MAX_PARTICIPANTS = 8;
export const GUARANTEED_NEUTRAL_WORLDS = 2;
export const MAP_MIN_COORDINATE = 0;
export const MAP_MAX_COORDINATE = 1000;
export const MAP_MINIMUM_SEPARATION = 10;

const worldIdSchema = z.string().regex(/^world-[0-9]{3}$/);
const participantIdSchema = z.string().regex(/^player-[0-9]{2}$/);

export const galaxyProfileSchema = z.object({
  id: z.literal(GALAXY_PROFILE_ID),
  participantCount: z.number().int().min(MIN_PARTICIPANTS).max(MAX_PARTICIPANTS),
  guaranteedNeutralWorldsPerParticipant: z.literal(GUARANTEED_NEUTRAL_WORLDS),
  habitableExtraWorldPercent: z.literal(70),
  minimumWorldCountMultiplier: z.literal(GUARANTEED_NEUTRAL_WORLDS + 1),
  maxWorldCount: z.literal(MAX_GALAXY_WORLDS),
  minimumCoordinate: z.literal(MAP_MIN_COORDINATE),
  maximumCoordinate: z.literal(MAP_MAX_COORDINATE),
  minimumSeparation: z.literal(MAP_MINIMUM_SEPARATION),
  placementGridDivisions: z.literal(32),
  topology: z.literal('cycle-plus-starter-links-v1'),
  maxDegree: z.literal(4),
  initialTravel: z.object({
    policy: z.literal('initial-lanes-v1'),
    fuelCapacity: z.literal(3),
    fuelPerLane: z.literal(1)
  }).strict()
}).strict();

const participantSchema = z.object({
  id: participantIdSchema,
  name: z.string().min(1).max(80),
  homeWorldId: worldIdSchema
}).strict();

const worldSchema = z.object({
  id: worldIdSchema,
  name: z.string().min(1).max(80),
  x: z.number().finite().min(MAP_MIN_COORDINATE).max(MAP_MAX_COORDINATE),
  y: z.number().finite().min(MAP_MIN_COORDINATE).max(MAP_MAX_COORDINATE),
  type: z.enum(['habitable', 'barren']),
  ownerId: participantIdSchema.nullable()
}).strict();

const laneSchema = z.tuple([worldIdSchema, worldIdSchema]);

export const galaxyMapSchema = z.object({
  format: z.literal(GALAXY_MAP_FORMAT),
  schemaVersion: z.literal(GALAXY_MAP_SCHEMA_VERSION),
  rulesVersion: z.literal(GALAXY_MAP_RULES_VERSION),
  generatorVersion: z.literal(GALAXY_GENERATOR_VERSION),
  seed: z.number().int().min(1).max(0xffffffff),
  profile: galaxyProfileSchema,
  participants: z.array(participantSchema).min(MIN_PARTICIPANTS).max(MAX_PARTICIPANTS),
  worlds: z.array(worldSchema).min(1).max(MAX_GALAXY_WORLDS),
  lanes: z.array(laneSchema).min(1)
}).strict();

export type GalaxyMap = z.infer<typeof galaxyMapSchema>;
export type GalaxyWorld = GalaxyMap['worlds'][number];
export type GalaxyParticipant = GalaxyMap['participants'][number];
export type GalaxyMapErrorCode = 'INVALID_MAP' | 'UNSUPPORTED_FORMAT' | 'UNSUPPORTED_VERSION';
export type GalaxyMapValidation =
  | { ok: true; map: GalaxyMap }
  | { ok: false; code: GalaxyMapErrorCode; message: string };
export type GalaxyMapCodecResult =
  | { ok: true; map: GalaxyMap; json: string }
  | { ok: false; code: GalaxyMapErrorCode; message: string };

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function squaredDistance(left: GalaxyWorld, right: GalaxyWorld): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  return x * x + y * y;
}

function laneKey(from: string, to: string): string {
  return asciiCompare(from, to) < 0 ? `${from}:${to}` : `${to}:${from}`;
}

function hasLane(map: GalaxyMap, from: string, to: string): boolean {
  const expected = laneKey(from, to);
  return map.lanes.some(([start, end]) => laneKey(start, end) === expected);
}

export function canReachInitialWorld(map: GalaxyMap, fromWorldId: string, toWorldId: string): boolean {
  const { fuelCapacity, fuelPerLane } = map.profile.initialTravel;
  return fromWorldId !== toWorldId && fuelCapacity >= fuelPerLane && hasLane(map, fromWorldId, toWorldId);
}

export function getNearestNeutralWorlds(
  map: GalaxyMap,
  homeWorldId: string,
  count = GUARANTEED_NEUTRAL_WORLDS
): GalaxyWorld[] {
  const home = map.worlds.find(world => world.id === homeWorldId);
  if (!home || !Number.isSafeInteger(count) || count < 0) return [];
  return map.worlds
    .filter(world => world.ownerId === null)
    .slice()
    .sort((left, right) => squaredDistance(home, left) - squaredDistance(home, right) ||
      asciiCompare(left.id, right.id))
    .slice(0, count);
}

function canonicalize(map: GalaxyMap): GalaxyMap {
  return {
    format: map.format,
    schemaVersion: map.schemaVersion,
    rulesVersion: map.rulesVersion,
    generatorVersion: map.generatorVersion,
    seed: map.seed,
    profile: {
      id: map.profile.id,
      participantCount: map.profile.participantCount,
      guaranteedNeutralWorldsPerParticipant: map.profile.guaranteedNeutralWorldsPerParticipant,
      habitableExtraWorldPercent: map.profile.habitableExtraWorldPercent,
      minimumWorldCountMultiplier: map.profile.minimumWorldCountMultiplier,
      maxWorldCount: map.profile.maxWorldCount,
      minimumCoordinate: map.profile.minimumCoordinate,
      maximumCoordinate: map.profile.maximumCoordinate,
      minimumSeparation: map.profile.minimumSeparation,
      placementGridDivisions: map.profile.placementGridDivisions,
      topology: map.profile.topology,
      maxDegree: map.profile.maxDegree,
      initialTravel: {
        policy: map.profile.initialTravel.policy,
        fuelCapacity: map.profile.initialTravel.fuelCapacity,
        fuelPerLane: map.profile.initialTravel.fuelPerLane
      }
    },
    participants: map.participants.slice().sort((left, right) => asciiCompare(left.id, right.id)),
    worlds: map.worlds.slice().sort((left, right) => asciiCompare(left.id, right.id)),
    lanes: map.lanes.slice().sort((left, right) =>
      asciiCompare(left[0], right[0]) || asciiCompare(left[1], right[1]))
  };
}

export function validateGalaxyMap(input: unknown): GalaxyMapValidation {
  const parsed = galaxyMapSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'INVALID_MAP', message: 'Формат или поля карты недопустимы' };
  }

  const map = parsed.data;
  const invalid = (message: string): GalaxyMapValidation => ({ ok: false, code: 'INVALID_MAP', message });
  const participantIds = new Set(map.participants.map(participant => participant.id));
  const worldIds = new Set(map.worlds.map(world => world.id));
  const worldNames = new Set(map.worlds.map(world => world.name));
  const minimumWorldCount = map.profile.participantCount *
    (GUARANTEED_NEUTRAL_WORLDS + 1);

  if (map.participants.length !== map.profile.participantCount ||
      participantIds.size !== map.participants.length ||
      new Set(map.participants.map(participant => participant.homeWorldId)).size !== map.participants.length) {
    return invalid('Число участников или их стартовых миров не согласовано с профилем');
  }
  if (map.worlds.length < minimumWorldCount || map.worlds.length > MAX_GALAXY_WORLDS ||
      worldIds.size !== map.worlds.length || worldNames.size !== map.worlds.length) {
    return invalid('Количество миров, ID или названия нарушают ограничения профиля');
  }

  const homeIds = new Set(map.participants.map(participant => participant.homeWorldId));
  for (const participant of map.participants) {
    const home = map.worlds.find(world => world.id === participant.homeWorldId);
    if (!home || home.ownerId !== participant.id || home.type !== 'habitable') {
      return invalid('Домашний мир должен существовать, принадлежать участнику и быть пригодным');
    }
  }
  if (map.worlds.some(world => world.ownerId !== null &&
    (!participantIds.has(world.ownerId) || !homeIds.has(world.id)))) {
    return invalid('Владение разрешено только участникам и их домашним мирам');
  }

  const minimumSeparationSquared = MAP_MINIMUM_SEPARATION * MAP_MINIMUM_SEPARATION;
  for (let leftIndex = 0; leftIndex < map.worlds.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < map.worlds.length; rightIndex++) {
      if (squaredDistance(map.worlds[leftIndex], map.worlds[rightIndex]) < minimumSeparationSquared) {
        return invalid('Центры миров ближе минимально допустимого расстояния');
      }
    }
  }

  const laneKeys = new Set<string>();
  const degrees = new Map<string, number>(map.worlds.map(world => [world.id, 0]));
  for (const [from, to] of map.lanes) {
    const key = laneKey(from, to);
    if (from === to || !worldIds.has(from) || !worldIds.has(to) || laneKeys.has(key) ||
        asciiCompare(from, to) >= 0) {
      return invalid('Линии должны быть уникальными, канонически упорядоченными и соединять разные существующие миры');
    }
    laneKeys.add(key);
    degrees.set(from, (degrees.get(from) ?? 0) + 1);
    degrees.set(to, (degrees.get(to) ?? 0) + 1);
  }
  if ([...degrees.values()].some(degree => degree > map.profile.maxDegree)) {
    return invalid('Степень связности мира превышает предел профиля');
  }

  const reached = new Set<string>([map.worlds[0].id]);
  for (let pass = 0; pass < map.worlds.length; pass++) {
    for (const [from, to] of map.lanes) {
      if (reached.has(from)) reached.add(to);
      if (reached.has(to)) reached.add(from);
    }
  }
  if (reached.size !== map.worlds.length) return invalid('Галактическая сеть должна быть связной');

  const reserved = new Set<string>();
  for (const participant of map.participants) {
    const nearest = getNearestNeutralWorlds(map, participant.homeWorldId);
    if (nearest.length !== GUARANTEED_NEUTRAL_WORLDS) {
      return invalid('Недостаточно нейтральных миров для стартового профиля');
    }
    for (const world of nearest) {
      if (world.type !== 'habitable' ||
          !canReachInitialWorld(map, participant.homeWorldId, world.id)) {
        return invalid('Ближайшие нейтральные миры должны быть пригодны и доступны начальным кораблём');
      }
      if (reserved.has(world.id)) return invalid('Стартовые резервы участников не должны пересекаться');
      reserved.add(world.id);
    }
  }

  const extras = map.worlds.filter(world => !homeIds.has(world.id) && !reserved.has(world.id));
  const expectedHabitableExtras = Math.floor(extras.length * map.profile.habitableExtraWorldPercent / 100);
  if (extras.filter(world => world.type === 'habitable').length !== expectedHabitableExtras) {
    return invalid('Доля пригодных дополнительных миров не соответствует профилю');
  }

  return { ok: true, map: canonicalize(map) };
}

export function encodeGalaxyMap(input: unknown): GalaxyMapCodecResult {
  const validation = validateGalaxyMap(input);
  if (!validation.ok) return validation;
  return { ok: true, map: validation.map, json: `${JSON.stringify(validation.map, null, 2)}\n` };
}

export function decodeGalaxyMap(input: unknown): GalaxyMapCodecResult {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, code: 'INVALID_MAP', message: 'JSON карты не удалось разобрать' };
    }
  }

  const header = z.record(z.string(), z.unknown()).safeParse(value);
  if (header.success) {
    if (Object.prototype.hasOwnProperty.call(header.data, 'format') &&
        header.data.format !== GALAXY_MAP_FORMAT) {
      return { ok: false, code: 'UNSUPPORTED_FORMAT', message: 'Формат карты не поддерживается' };
    }
    if ((Object.prototype.hasOwnProperty.call(header.data, 'schemaVersion') &&
        header.data.schemaVersion !== GALAXY_MAP_SCHEMA_VERSION) ||
        (Object.prototype.hasOwnProperty.call(header.data, 'rulesVersion') &&
        header.data.rulesVersion !== GALAXY_MAP_RULES_VERSION) ||
        (Object.prototype.hasOwnProperty.call(header.data, 'generatorVersion') &&
        header.data.generatorVersion !== GALAXY_GENERATOR_VERSION)) {
      return { ok: false, code: 'UNSUPPORTED_VERSION', message: 'Версия карты не поддерживается' };
    }
  }

  const validation = validateGalaxyMap(value);
  if (!validation.ok) return validation;
  return encodeGalaxyMap(validation.map);
}
