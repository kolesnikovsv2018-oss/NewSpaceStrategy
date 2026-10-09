import { describe, expect, it } from 'vitest';
import { encodeGalaxyMap, decodeGalaxyMap, getNearestNeutralWorlds, validateGalaxyMap } from '../src/domain/galaxyMap';
import { generateGalaxy } from '../src/domain/galaxyGenerator';

function generatedMap(worldCount = 6, participantCount = 2) {
  const result = generateGalaxy({
    worldCount,
    participantCount,
    seed: 12345,
    generatorVersion: 'galaxy-generator-v1',
    profileId: 'balanced-start-v1'
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.map;
}

describe('galaxy map format and validation', () => {
  it('round-trips canonical UTF-8 JSON with Russian and English names', () => {
    const map = generatedMap();
    const names = map.worlds.map((world, index) => ({
      ...world,
      name: index % 2 === 0 ? `Мир ${String(index + 1).padStart(3, '0')}` :
        `World ${String(index + 1).padStart(3, '0')}`
    }));
    const input = { ...map, participants: map.participants.map(participant => ({ ...participant })), worlds: names };
    const encoded = encodeGalaxyMap(input);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(encoded.message);
    expect(encoded.json).toContain('Мир 001');
    expect(encoded.json).toContain('World 002');
    expect(encoded.json).not.toContain('\\u');
    expect(decodeGalaxyMap(encoded.json)).toMatchObject({ ok: true, map: encoded.map, json: encoded.json });
  });

  it('rejects non-current formats and versions instead of transforming them', () => {
    const map = generatedMap();
    expect(decodeGalaxyMap({ ...map, format: 'old-galaxy' })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_FORMAT'
    });
    expect(decodeGalaxyMap({ ...map, schemaVersion: 2 })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_VERSION'
    });
    expect(decodeGalaxyMap({ ...map, rulesVersion: 2 })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_VERSION'
    });
  });

  it('requires strict fields, unique worlds and links to existing worlds', () => {
    const map = generatedMap();
    expect(validateGalaxyMap({ ...map, unexpected: true })).toMatchObject({ ok: false, code: 'INVALID_MAP' });
    expect(validateGalaxyMap({ ...map, worlds: [map.worlds[0], ...map.worlds] }))
      .toMatchObject({ ok: false, code: 'INVALID_MAP' });
    expect(validateGalaxyMap({ ...map, lanes: [['world-001', 'world-999'], ...map.lanes] }))
      .toMatchObject({ ok: false, code: 'INVALID_MAP' });
  });

  it('rejects maps whose nearest neutral world is barren or unreachable', () => {
    const map = generatedMap();
    const participant = map.participants[0];
    const nearest = getNearestNeutralWorlds(map, participant.homeWorldId);
    const barren = {
      ...map,
      worlds: map.worlds.map(world => world.id === nearest[0].id ? { ...world, type: 'barren' as const } : world)
    };
    expect(validateGalaxyMap(barren)).toMatchObject({ ok: false, code: 'INVALID_MAP' });

    const missingLane = {
      ...map,
      lanes: map.lanes.filter(([from, to]) =>
        !((from === participant.homeWorldId && to === nearest[0].id) ||
          (from === nearest[0].id && to === participant.homeWorldId)))
    };
    expect(validateGalaxyMap(missingLane)).toMatchObject({ ok: false, code: 'INVALID_MAP' });
  });

  it('sorts equal-distance neutral worlds by stable ASCII ID', () => {
    const map = generatedMap();
    const home = map.worlds.find(world => world.id === map.participants[0].homeWorldId)!;
    const first = getNearestNeutralWorlds(map, home.id)[0];
    const second = getNearestNeutralWorlds(map, home.id)[1];
    const symmetric = {
      ...map,
      worlds: map.worlds.map(world => world.id === first.id
        ? { ...world, x: home.x + 24, y: home.y }
        : world.id === second.id ? { ...world, x: home.x - 24, y: home.y } : world)
    };
    expect(getNearestNeutralWorlds(symmetric, home.id).map(world => world.id))
      .toEqual([first.id, second.id].sort());
  });

  it('returns detached maps from decode', () => {
    const map = generatedMap();
    const encoded = encodeGalaxyMap(map);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(encoded.message);
    const decoded = decodeGalaxyMap(encoded.json);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.message);
    decoded.map.worlds[0].name = 'changed';
    expect(map.worlds[0].name).not.toBe('changed');
  });
});
