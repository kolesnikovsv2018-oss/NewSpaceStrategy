import { describe, expect, it } from 'vitest';
import { generateGalaxy } from '../src/domain/galaxyGenerator';
import { getNearestNeutralWorlds, validateGalaxyMap } from '../src/domain/galaxyMap';

function request(worldCount: number, participantCount: number, seed = 1) {
  return {
    worldCount,
    participantCount,
    seed,
    generatorVersion: 'galaxy-generator-v1',
    profileId: 'balanced-start-v1'
  };
}

describe('deterministic galaxy generation', () => {
  it.each([
    ['minimum', 6, 2],
    ['medium', 64, 4],
    ['maximum', 256, 8]
  ])('generates 100 checked maps for the %s profile', (_label, worldCount, participantCount) => {
    for (let seed = 1; seed <= 100; seed++) {
      const generated = generateGalaxy(request(worldCount, participantCount, seed));
      expect(generated.ok, `seed ${seed}`).toBe(true);
      if (!generated.ok) throw new Error(`seed ${seed}: ${generated.message}`);
      expect(generated.map.worlds).toHaveLength(worldCount);
      expect(generated.map.participants).toHaveLength(participantCount);
      expect(validateGalaxyMap(generated.map).ok).toBe(true);
      for (const participant of generated.map.participants) {
        const home = generated.map.worlds.find(world => world.id === participant.homeWorldId)!;
        const guaranteed = getNearestNeutralWorlds(generated.map, home.id);
        expect(guaranteed).toHaveLength(2);
        expect(guaranteed.every(world =>
          world.type === 'habitable' && generated.map.lanes.some(([from, to]) =>
            (from === home.id && to === world.id) || (from === world.id && to === home.id))))
          .toBe(true);
      }
    }
  });

  it('produces canonical identical bytes for the same request and different maps for different seeds', () => {
    const first = generateGalaxy(request(40, 3, 12345));
    const repeated = generateGalaxy(request(40, 3, 12345));
    const changedSeed = generateGalaxy(request(40, 3, 12346));
    expect(first.ok && repeated.ok && changedSeed.ok).toBe(true);
    if (!first.ok || !repeated.ok || !changedSeed.ok) return;
    expect(JSON.stringify(first.map)).toBe(JSON.stringify(repeated.map));
    expect(JSON.stringify(first.map)).not.toBe(JSON.stringify(changedSeed.map));
  });

  it('gives every participant the same number of reachable habitable starter worlds', () => {
    const generated = generateGalaxy(request(48, 6, 77));
    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error(generated.message);
    const counts = generated.map.participants.map(participant => {
      const home = generated.map.worlds.find(world => world.id === participant.homeWorldId)!;
      return getNearestNeutralWorlds(generated.map, home.id)
        .filter(world => world.type === 'habitable' && generated.map.lanes.some(([from, to]) =>
          (from === home.id && to === world.id) || (from === world.id && to === home.id))).length;
    });
    expect(new Set(counts)).toEqual(new Set([2]));
  });

  it.each([2, 3, 4, 5, 6, 7, 8])('keeps guaranteed nearest worlds valid for participant count %i', participantCount => {
    for (let seed = 1; seed <= 20; seed++) {
      const generated = generateGalaxy(request(participantCount * 5, participantCount, seed));
      expect(generated.ok, `participants ${participantCount}, seed ${seed}`).toBe(true);
      if (!generated.ok) throw new Error(generated.message);

      const reordered = {
        ...generated.map,
        participants: [...generated.map.participants].reverse(),
        worlds: [...generated.map.worlds].reverse(),
        lanes: [...generated.map.lanes].reverse()
      };
      expect(validateGalaxyMap(reordered).ok, `participants ${participantCount}, seed ${seed}`).toBe(true);
      for (const participant of generated.map.participants) {
        const guaranteed = getNearestNeutralWorlds(generated.map, participant.homeWorldId);
        expect(guaranteed).toHaveLength(2);
        expect(guaranteed.every(world => world.type === 'habitable' &&
          generated.map.lanes.some(([from, to]) =>
            (from === participant.homeWorldId && to === world.id) ||
            (from === world.id && to === participant.homeWorldId))))
          .toBe(true);
      }
    }
  });

  it('rejects impossible counts, malformed requests and unsupported profile versions', () => {
    expect(generateGalaxy(request(5, 2))).toMatchObject({
      ok: false,
      code: 'START_CONSTRAINTS_UNSATISFIED'
    });
    expect(generateGalaxy(request(257, 2))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(generateGalaxy(request(6, 9))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(generateGalaxy({ ...request(6, 2), extra: true })).toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST'
    });
    expect(generateGalaxy({ ...request(6, 2), profileId: 'unknown' })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_PROFILE'
    });
    expect(generateGalaxy({ ...request(6, 2), generatorVersion: 'future' })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_GENERATOR_VERSION'
    });
  });
});
