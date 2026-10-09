import { z } from 'zod';
import { createSeededRandomStream } from './seededRandom.ts';
import {
  GALAXY_GENERATOR_VERSION,
  GALAXY_MAP_FORMAT,
  GALAXY_MAP_RULES_VERSION,
  GALAXY_MAP_SCHEMA_VERSION,
  GALAXY_PROFILE_ID,
  GUARANTEED_NEUTRAL_WORLDS,
  MAP_MIN_COORDINATE,
  MAP_MAX_COORDINATE,
  MAP_MINIMUM_SEPARATION,
  MAX_GALAXY_WORLDS,
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
  getNearestNeutralWorlds,
  validateGalaxyMap,
  type GalaxyMap,
  type GalaxyParticipant,
  type GalaxyWorld
} from './galaxyMap.ts';

const requestSchema = z.object({
  worldCount: z.number().int().safe().min(1).max(MAX_GALAXY_WORLDS),
  participantCount: z.number().int().min(MIN_PARTICIPANTS).max(MAX_PARTICIPANTS),
  seed: z.number().int().min(1).max(0xffffffff),
  generatorVersion: z.literal(GALAXY_GENERATOR_VERSION),
  profileId: z.literal(GALAXY_PROFILE_ID)
}).strict();

export type GalaxyGeneratorErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_PROFILE'
  | 'UNSUPPORTED_GENERATOR_VERSION'
  | 'START_CONSTRAINTS_UNSATISFIED'
  | 'GENERATION_FAILED';

export type GalaxyGeneratorResult =
  | { ok: true; map: GalaxyMap }
  | { ok: false; code: GalaxyGeneratorErrorCode; message: string };

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function squaredDistance(left: Pick<GalaxyWorld, 'x' | 'y'>, right: Pick<GalaxyWorld, 'x' | 'y'>): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  return x * x + y * y;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function createWorldId(index: number): string {
  return `world-${String(index + 1).padStart(3, '0')}`;
}

function createMapProfile(participantCount: number): GalaxyMap['profile'] {
  return {
    id: GALAXY_PROFILE_ID,
    participantCount,
    guaranteedNeutralWorldsPerParticipant: GUARANTEED_NEUTRAL_WORLDS,
    habitableExtraWorldPercent: 70,
    minimumWorldCountMultiplier: GUARANTEED_NEUTRAL_WORLDS + 1,
    maxWorldCount: MAX_GALAXY_WORLDS,
    minimumCoordinate: MAP_MIN_COORDINATE,
    maximumCoordinate: MAP_MAX_COORDINATE,
    minimumSeparation: MAP_MINIMUM_SEPARATION,
    placementGridDivisions: 32,
    topology: 'cycle-plus-starter-links-v1',
    maxDegree: 4,
    initialTravel: { policy: 'initial-lanes-v1', fuelCapacity: 3, fuelPerLane: 1 }
  };
}

function makeLane(from: string, to: string): [string, string] {
  return asciiCompare(from, to) < 0 ? [from, to] : [to, from];
}

function addLane(lanes: Map<string, [string, string]>, from: string, to: string): void {
  const lane = makeLane(from, to);
  lanes.set(`${lane[0]}:${lane[1]}`, lane);
}

function createGridCandidates(): { x: number; y: number }[] {
  const divisions = 32;
  const candidates: { x: number; y: number }[] = [];
  for (let row = 0; row <= divisions; row++) {
    for (let column = 0; column <= divisions; column++) {
      candidates.push({
        x: roundCoordinate(MAP_MAX_COORDINATE * column / divisions),
        y: roundCoordinate(MAP_MAX_COORDINATE * row / divisions)
      });
    }
  }
  return candidates;
}

function createStarterWorlds(participantCount: number, random: () => number): {
  participants: GalaxyParticipant[];
  worlds: GalaxyWorld[];
} {
  const slots = shuffle(Array.from({ length: participantCount }, (_, index) => index), random);
  const phase = random() * Math.PI * 2;
  const participants: GalaxyParticipant[] = [];
  const worlds: GalaxyWorld[] = [];

  for (let participantIndex = 0; participantIndex < participantCount; participantIndex++) {
    const participantId = `player-${String(participantIndex + 1).padStart(2, '0')}`;
    const slot = slots[participantIndex];
    const homeAngle = phase + slot * Math.PI * 2 / participantCount;
    const homeX = roundCoordinate(MAP_MAX_COORDINATE / 2 + 360 * Math.cos(homeAngle));
    const homeY = roundCoordinate(MAP_MAX_COORDINATE / 2 + 360 * Math.sin(homeAngle));
    const radialAngle = Math.atan2(homeY - MAP_MAX_COORDINATE / 2, homeX - MAP_MAX_COORDINATE / 2);
    const homeWorldId = createWorldId(worlds.length);
    const home = {
      id: homeWorldId,
      name: participantIndex % 2 === 0 ? `Мир ${String(worlds.length + 1).padStart(3, '0')}` :
        `World ${String(worlds.length + 1).padStart(3, '0')}`,
      x: homeX,
      y: homeY,
      type: 'habitable' as const,
      ownerId: participantId
    };
    participants.push({
      id: participantId,
      name: participantIndex % 2 === 0 ? `Участник ${String(participantIndex + 1).padStart(2, '0')}` :
        `Player ${String(participantIndex + 1).padStart(2, '0')}`,
      homeWorldId
    });
    worlds.push(home);

    const targetAngles = [radialAngle, radialAngle + Math.PI / 2];
    for (let targetIndex = 0; targetIndex < GUARANTEED_NEUTRAL_WORLDS; targetIndex++) {
      const angle = targetAngles[targetIndex];
      worlds.push({
        id: createWorldId(worlds.length),
        name: worlds.length % 2 === 0 ? `Мир ${String(worlds.length + 1).padStart(3, '0')}` :
          `World ${String(worlds.length + 1).padStart(3, '0')}`,
        x: roundCoordinate(homeX + 18 * Math.cos(angle)),
        y: roundCoordinate(homeY + 18 * Math.sin(angle)),
        type: 'habitable',
        ownerId: null
      });
    }
  }

  return { participants, worlds };
}

function buildGalaxy(input: z.infer<typeof requestSchema>): GalaxyMap | null {
  const placementRandom = createSeededRandomStream(input.seed, 'galaxy-placement-v1');
  const topologyRandom = createSeededRandomStream(input.seed, 'galaxy-topology-v1');
  const typeRandom = createSeededRandomStream(input.seed, 'galaxy-world-types-v1');
  const { participants, worlds } = createStarterWorlds(input.participantCount, placementRandom);
  const candidates = shuffle(createGridCandidates(), placementRandom);
  const minimumSeparationSquared = MAP_MINIMUM_SEPARATION * MAP_MINIMUM_SEPARATION;
  const starterExclusionSquared = 40 * 40;

  for (const candidate of candidates) {
    if (worlds.length === input.worldCount) break;
    const tooCloseToHome = participants.some(participant => {
      const home = worlds.find(world => world.id === participant.homeWorldId);
      return home !== undefined && squaredDistance(home, candidate) <= starterExclusionSquared;
    });
    if (tooCloseToHome || worlds.some(world =>
      squaredDistance(world, candidate) < minimumSeparationSquared)) continue;

    const index = worlds.length;
    worlds.push({
      id: createWorldId(index),
      name: index % 2 === 0 ? `Мир ${String(index + 1).padStart(3, '0')}` :
        `World ${String(index + 1).padStart(3, '0')}`,
      x: candidate.x,
      y: candidate.y,
      type: 'barren',
      ownerId: null
    });
  }
  if (worlds.length !== input.worldCount) return null;

  const extraWorlds = worlds.slice(input.participantCount * (GUARANTEED_NEUTRAL_WORLDS + 1));
  const habitableExtraCount = Math.floor(extraWorlds.length * 70 / 100);
  const extraTypes = shuffle([
    ...Array.from({ length: habitableExtraCount }, () => 'habitable' as const),
    ...Array.from({ length: extraWorlds.length - habitableExtraCount }, () => 'barren' as const)
  ], typeRandom);
  extraWorlds.forEach((world, index) => { world.type = extraTypes[index]; });

  const starterMap: GalaxyMap = {
    format: GALAXY_MAP_FORMAT,
    schemaVersion: GALAXY_MAP_SCHEMA_VERSION,
    rulesVersion: GALAXY_MAP_RULES_VERSION,
    generatorVersion: GALAXY_GENERATOR_VERSION,
    seed: input.seed,
    profile: createMapProfile(input.participantCount),
    participants,
    worlds,
    lanes: []
  };

  const lanes = new Map<string, [string, string]>();
  for (const participant of participants) {
    for (const target of getNearestNeutralWorlds(starterMap, participant.homeWorldId)) {
      addLane(lanes, participant.homeWorldId, target.id);
    }
  }

  const ring = shuffle(worlds.map(world => world.id), topologyRandom);
  for (let index = 0; index < ring.length; index++) {
    addLane(lanes, ring[index], ring[(index + 1) % ring.length]);
  }
  starterMap.lanes = [...lanes.values()].sort((left, right) =>
    asciiCompare(left[0], right[0]) || asciiCompare(left[1], right[1]));
  return starterMap;
}

export function generateGalaxy(input: unknown): GalaxyGeneratorResult {
  const request = requestSchema.safeParse(input);
  if (!request.success) {
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      const header = z.record(z.string(), z.unknown()).safeParse(input);
      if (header.success) {
        if (Object.prototype.hasOwnProperty.call(header.data, 'profileId') &&
            header.data.profileId !== GALAXY_PROFILE_ID) {
          return { ok: false, code: 'UNSUPPORTED_PROFILE', message: 'Профиль генерации не поддерживается' };
        }
        if (Object.prototype.hasOwnProperty.call(header.data, 'generatorVersion') &&
            header.data.generatorVersion !== GALAXY_GENERATOR_VERSION) {
          return { ok: false, code: 'UNSUPPORTED_GENERATOR_VERSION', message: 'Версия генератора не поддерживается' };
        }
      }
    }
    return { ok: false, code: 'INVALID_REQUEST', message: 'Недопустимые параметры генерации' };
  }

  const { worldCount, participantCount } = request.data;
  if (worldCount < participantCount * (GUARANTEED_NEUTRAL_WORLDS + 1)) {
    return {
      ok: false,
      code: 'START_CONSTRAINTS_UNSATISFIED',
      message: 'Недостаточно миров для домашних миров и гарантированных стартовых целей'
    };
  }

  const map = buildGalaxy(request.data);
  if (!map) {
    return { ok: false, code: 'GENERATION_FAILED', message: 'Не удалось разместить все миры в пределах профиля' };
  }
  const validation = validateGalaxyMap(map);
  if (!validation.ok) {
    return { ok: false, code: 'GENERATION_FAILED', message: validation.message };
  }
  return { ok: true, map: validation.map };
}
