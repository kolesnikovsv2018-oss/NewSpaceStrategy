import { describe, expect, it, vi } from 'vitest';
import { generateGalaxy } from '../src/domain/galaxyGenerator';
import { encodeGalaxyMap, getNearestNeutralWorlds, type GalaxyMap } from '../src/domain/galaxyMap';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';
import { LocalGalaxyMapRepository } from '../src/utils/GalaxyMapRepository';
import { createConquest, conquestSchema, executeConquestCommand, getConquestOutcome, getConquestView,
  type Conquest } from '../src/domain/conquest';
import { executeConquestAiTurn } from '../src/domain/conquestAi';
import { getGalaxyDefinition, areSystemsAdjacent, type CampaignFactionId } from '../src/domain/campaign';
import { createDesign } from '../src/domain/shipDesign';
import { getProductionQuote } from '../src/domain/production';
import { encodeConquestSave, decodeConquestSave } from '../src/utils/ConquestSaveManager';
import { campaignSessionSchema } from '../src/domain/campaignSession';
import { createOperationalState } from '../src/domain/campaignOperations';
import { createComponentWithId } from '../src/domain/shipDesign';
import { buildConquestDesigns } from '../src/domain/conquestAi';

function map(count = 12, seed = 12345): GalaxyMap {
  const generated = generateBrowserGalaxy(count, seed);
  if (!generated.ok) throw new Error(generated.message);
  return generated.map;
}

function command(state: Conquest, payload: Record<string, unknown>): Conquest {
  const before = structuredClone(state);
  const result = executeConquestCommand(state, {
    factionId: state.session.turn % 2 ? 'blue' : 'red', expectedTurn: state.session.turn, ...payload
  });
  expect(state).toEqual(before);
  if (!result.ok) throw new Error(result.message);
  expect(conquestSchema.safeParse(result.state).success).toBe(true);
  return result.state;
}

function round(state: Conquest): Conquest {
  return command(command(state, { kind: 'endTurn' }), { kind: 'endTurn' });
}

function payAndBuild(count: number, faction: CampaignFactionId = 'blue'): Conquest {
  let state = createConquest({ mode: 'local' }, undefined, 12345, map());
  if (faction === 'red') state = command(state, { kind: 'endTurn' });
  const design = createDesign('fighter', true);
  const quote = getProductionQuote(design);
  const home = getGalaxyDefinition(state.session.galaxy).factions.find(side => side.id === faction)!.homeSystemId;
  while (state.session.treasuries[faction].credits < quote.cost.credits * count) state = round(state);
  for (let index = 0; index < count; index++) state = command(state, { kind: 'enqueueProduction', systemId: home, design });
  while (state.session.production.completed.length !== count) state = round(state);
  for (const record of [...state.session.production.completed]) {
    state = command(state, { kind: 'deployProduction', systemId: home, orderId: record.id });
  }
  return state;
}

describe('shared browser generator and latest-map repository', () => {
  it.each([6, 40, 256])('uses exactly the shared algorithm and canonical JSON for %i worlds', count => {
    const browser = map(count);
    const shared = generateGalaxy({ worldCount: count, participantCount: 2, seed: browser.seed,
      generatorVersion: browser.generatorVersion, profileId: browser.profile.id });
    expect(shared).toEqual({ ok: true, map: browser });
    const bytes = new Map<string, string>(), setItem = vi.fn((key: string, value: string) => { bytes.set(key, value); });
    const repository = new LocalGalaxyMapRepository({ getItem: key => bytes.get(key) ?? null, setItem });
    expect(setItem).not.toHaveBeenCalled();
    expect(repository.save(browser)).toEqual({ ok: true });
    const encoded = encodeGalaxyMap(browser);
    if (!encoded.ok) throw new Error(encoded.message);
    expect(setItem).toHaveBeenCalledExactlyOnceWith(LocalGalaxyMapRepository.STORAGE_KEY, encoded.json);
    expect(repository.load()).toEqual({ ok: true, map: browser });
  });

  it('replaces only the latest-map slot and loads independent snapshots', () => {
    const bytes = new Map<string, string>([['other', 'keep']]);
    const port = { getItem: (key: string) => bytes.get(key) ?? null,
      setItem: (key: string, value: string) => { bytes.set(key, value); } };
    const repository = new LocalGalaxyMapRepository(port);
    repository.save(map(6)); repository.save(map(40));
    expect(bytes.size).toBe(2);
    const loaded = new LocalGalaxyMapRepository(port).load();
    if (!loaded.ok) throw new Error(loaded.message);
    loaded.map.worlds[0].name = 'Changed';
    expect(repository.load()).toEqual({ ok: true, map: map(40) });
    expect(bytes.get('other')).toBe('keep');
  });

  it('reports invalid maps, missing data, read failures, quota and denied host storage without erasing bytes', () => {
    const valid = map(), encoded = encodeGalaxyMap(valid);
    if (!encoded.ok) throw new Error(encoded.message);
    let bytes = encoded.json;
    const write = vi.fn(() => { throw new Error('quota'); });
    const repository = new LocalGalaxyMapRepository({ getItem: () => bytes, setItem: write });
    expect(repository.save({ ...valid, worlds: [] }).ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(repository.save(valid).ok).toBe(false);
    expect(bytes).toBe(encoded.json);
    bytes = JSON.stringify({ ...valid, schemaVersion: 999 });
    expect(repository.load().ok).toBe(false);
    expect(new LocalGalaxyMapRepository({ getItem: () => null, setItem: write }).load().ok).toBe(false);
    expect(new LocalGalaxyMapRepository({ getItem: () => { throw new Error('denied'); }, setItem: write }).load().ok).toBe(false);
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(new LocalGalaxyMapRepository().save(valid).ok).toBe(false);
      expect(new LocalGalaxyMapRepository().load().ok).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('generated campaign snapshots', () => {
  it('initializes only two owned/explored homes, validates all references and rejects more participants', () => {
    const snapshot = map(), state = createConquest(undefined, undefined, snapshot.seed, snapshot);
    expect(state.session.galaxy.map).toEqual(snapshot);
    expect(campaignSessionSchema.safeParse(state.session).success).toBe(false);
    const reordered = structuredClone(snapshot);
    reordered.participants.reverse(); reordered.worlds.reverse(); reordered.lanes.reverse();
    expect(createConquest(undefined, undefined, snapshot.seed, reordered)).toEqual(state);
    expect(state.session.galaxy.systems.filter(system => system.ownerId)).toHaveLength(2);
    for (const system of state.session.galaxy.systems) {
      expect(system.exploredBy).toEqual(system.ownerId ? [system.ownerId] : []);
    }
    expect(executeConquestCommand(state, { kind: 'explore', factionId: 'blue', expectedTurn: 1, systemId: 'world-999' }).ok).toBe(false);
    expect(conquestSchema.safeParse({ ...state, session: { ...state.session,
      galaxy: { ...state.session.galaxy, systems: state.session.galaxy.systems.slice(1) } } }).success).toBe(false);
    const three = generateGalaxy({ worldCount: 12, participantCount: 3, seed: snapshot.seed,
      generatorVersion: snapshot.generatorVersion, profileId: snapshot.profile.id });
    if (!three.ok) throw new Error(three.message);
    expect(() => createConquest(undefined, undefined, snapshot.seed, three.map)).toThrow();
    snapshot.worlds[0].name = 'External change';
    expect(state.session.galaxy.map!.worlds[0].name).not.toBe('External change');
  });

  it('keeps two simultaneous maps independent and does not expose their snapshots in own-view', () => {
    const first = createConquest(undefined, undefined, 1, map(12, 1));
    const second = createConquest(undefined, undefined, 2, map(12, 2));
    const firstDefinition = getGalaxyDefinition(first.session.galaxy);
    const uniqueLane = firstDefinition.lanes.find(([a, b]) => !areSystemsAdjacent(a, b, second.session.galaxy))!;
    expect(uniqueLane).toBeDefined();
    expect(areSystemsAdjacent(...uniqueLane, first.session.galaxy)).toBe(true);
    expect(areSystemsAdjacent(...uniqueLane, second.session.galaxy)).toBe(false);
    expect(getGalaxyDefinition(first.session.galaxy)).toEqual(firstDefinition);
    const view = getConquestView(first, 'blue');
    expect(view).not.toHaveProperty('map'); expect(view.galaxy).not.toHaveProperty('map');
    expect(view.galaxy.systems.filter(system => system.visibility === 'unknown').every(system =>
      !('ownerId' in system) && !('habitable' in system))).toBe(true);
  });

  it.each(['blue', 'red'] as const)('pays for %s ships, creates a fleet and reaches both guaranteed nearest worlds', faction => {
    let state = payAndBuild(2, faction);
    const snapshot = structuredClone(state.session.galaxy.map!);
    const participant = snapshot.participants[faction === 'blue' ? 0 : 1];
    const nearest = getNearestNeutralWorlds(snapshot, participant.homeWorldId, 2);
    state = command(state, { kind: 'createFleet', systemId: participant.homeWorldId, shipIds: state.session.ships.map(ship => ship.id) });
    for (const target of nearest) {
      const start = state.session.ships[0].systemId;
      state = command(state, { kind: 'sendFleet', fleetId: 1, systemId: start, destinationId: target.id });
      expect(state.session.ships.every(ship => ship.fuel === 2)).toBe(true);
      const restored = decodeConquestSave(encodeConquestSave(state));
      expect(round(restored)).toEqual(round(state));
      state = round(state);
      expect(state.session.fleets.items[0].systemId).toBe(target.id);
      expect(state.session.galaxy.systems.find(system => system.id === target.id)?.ownerId).toBe(faction);
      state = command(state, { kind: 'sendFleet', fleetId: 1, systemId: target.id, destinationId: participant.homeWorldId });
      state = round(state);
      for (const ship of state.session.ships) state = command(state, { kind: 'refuelShip', systemId: participant.homeWorldId, shipId: ship.id });
    }
    expect(state.session.galaxy.map).toEqual(snapshot);
    const invalid = structuredClone(state);
    invalid.session.ships[0].transit = { destinationId: 'world-999', remainingTurns: 1 };
    expect(conquestSchema.safeParse(invalid).success).toBe(false);
  });

  it.each(['blue', 'red'] as const)('reaches a legitimate %s victory on a generated galaxy through the real AI', faction => {
    const snapshot = map(6, faction === 'blue' ? 51 : 52);
    let state = createConquest(undefined, undefined, snapshot.seed, snapshot);
    for (let step = 0; step < 600 && getConquestOutcome(state).status === 'ongoing'; step++) {
      const active = state.session.turn % 2 ? 'blue' : 'red';
      if (active === faction) {
        const result = executeConquestAiTurn(state, faction, state.session.turn);
        if (!result.ok) throw new Error(`turn ${state.session.turn}: ${result.message}`);
        state = result.state;
      } else state = command(state, { kind: 'endTurn' });
      if (step % 20 === 0) state = decodeConquestSave(encodeConquestSave(state));
    }
    expect(getConquestOutcome(state)).toEqual({ status: 'completed', winner: faction, reason: 'all-planets' });
    expect(state.session.galaxy.systems.every(system => system.ownerId === faction)).toBe(true);
    expect(state.session.galaxy.map).toEqual(snapshot);
    expect(executeConquestCommand(state, { kind: 'endTurn', factionId: state.session.turn % 2 ? 'blue' : 'red',
      expectedTurn: state.session.turn }).ok).toBe(false);
  });

  it('uses every habitable world, not six IDs or the enemy capital alone, for the victory denominator', () => {
    const state = createConquest(undefined, undefined, 12345, map());
    for (const system of state.session.galaxy.systems) {
      const habitable = state.session.galaxy.map!.worlds.find(world => world.id === system.id)!.type === 'habitable';
      if (habitable) { system.ownerId = 'blue'; system.exploredBy = ['blue']; }
    }
    const checked = conquestSchema.parse(state);
    expect(getConquestView(checked, 'blue').totalHabitableWorlds).toBe(10);
    expect(getConquestOutcome(checked).status).toBe('completed');
    const target = checked.session.galaxy.systems.find(system => getGalaxyDefinition(checked.session.galaxy).systems
      .some(definition => definition.id === system.id && definition.habitable))!;
    target.ownerId = null;
    expect(getConquestOutcome(checked).status).toBe('ongoing');
  });

  it('diagnostic battles use the same open-field geometry and result irrespective of galaxy coordinates', () => {
    const design = createDesign('fighter', true), weak = structuredClone(design);
    weak.slots.find(slot => slot.id === 'beam_1')!.component = null;
    const run = (snapshot: GalaxyMap) => {
      const state = createConquest(undefined, undefined, 99, snapshot);
      state.session.production.lastOrderId = 2;
      state.session.ships = [
        { id: 1, factionId: 'blue', systemId: 'world-003', fuel: 3, design },
        { id: 2, factionId: 'red', systemId: 'world-003', fuel: 3, design: weak }
      ];
      state.operations = { '1': createOperationalState(design), '2': { ...createOperationalState(weak), hull: 1 } };
      const result = executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
      if (!result.ok) throw new Error(result.message);
      return result;
    };
    const first = run(map(6, 1)), second = run(map(6, 2));
    expect(first.state.battles).toHaveLength(1);
    expect(first.state.battles).toEqual(second.state.battles);
    expect(first.frames).toEqual(second.frames);
    expect(first.state.operations).toEqual(second.state.operations);
    expect(first.state.session.ships).toEqual(second.state.session.ships);
    expect(first.state.session.galaxy.systems.find(system => system.id === 'world-003')?.ownerId).toBe('blue');
  });

  it('diagnostic mining and scanner queries use the generated map and conceal unseen enemy details', () => {
    const snapshot = map(), state = createConquest(undefined, undefined, snapshot.seed, snapshot);
    const barren = snapshot.worlds.find(world => world.type === 'barren')!;
    state.research.blue.completed = ['support', 'ordnance'];
    const design = buildConquestDesigns(state.research.blue, state.researchTree).find(item => item.hullId === 'corvette')!;
    design.slots.find(slot => slot.id === 'service_1')!.component = createComponentWithId('mining', 'miner');
    design.slots.find(slot => slot.id === 'service_2')!.component = createComponentWithId('scanner', 'scanner');
    state.session.production.lastOrderId = 1;
    state.session.ships = [{ id: 1, factionId: 'blue', systemId: barren.id, fuel: 3, design }];
    state.operations = { '1': createOperationalState(design) };
    let checked = conquestSchema.parse(state);
    const view = getConquestView(checked, 'blue');
    expect(view.income.minerals).toBe(13);
    expect(view.economyForecast.ok && view.economyForecast.treasuryAfter.minerals).toBe(63);
    const neighbour = snapshot.lanes.flatMap(([a, b]) => a === barren.id ? [b] : b === barren.id ? [a] : [])[0];
    checked = command(checked, { kind: 'explore', systemId: neighbour });
    expect(getConquestView(checked, 'blue').galaxy.systems.find(system => system.id === neighbour)?.visibility).toBe('explored');
    const next = command(checked, { kind: 'endTurn' });
    expect(next.session.treasuries.blue.minerals).toBe(63);
    expect(next.session.galaxy.systems.find(system => system.id === barren.id)?.ownerId).toBeNull();
    expect(decodeConquestSave(encodeConquestSave(next))).toEqual(next);
    expect(getConquestView(next, 'blue')).not.toHaveProperty('treasuries');
  });
});
