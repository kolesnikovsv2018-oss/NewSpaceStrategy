import { describe, expect, it, vi } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand, getConquestView, type Conquest } from '../src/domain/conquest';
import { createDesign, createComponentWithId, installComponent } from '../src/domain/shipDesign';
import { MAX_CAMPAIGN_PROJECTS, MAX_PROJECT_ID } from '../src/domain/campaignProjects';
import { isCampaignDraftAvailable, isCampaignDesignAvailable } from '../src/domain/campaignResearch';
import { createCombatDesign } from '../src/domain/combatPresets';
import { getProductionQuote } from '../src/domain/production';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';
import { ConquestSaveManager, decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { getGalaxyDefinition, type CampaignFactionId, type SystemId } from '../src/domain/campaign';

function apply(state: Conquest, payload: Record<string, unknown>): Conquest {
  const before = structuredClone(state);
  const result = executeConquestCommand(state, {
    factionId: state.session.turn % 2 ? 'blue' : 'red', expectedTurn: state.session.turn, ...payload
  });
  expect(state).toEqual(before);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
function round(state: Conquest): Conquest {
  return apply(apply(state, { kind: 'endTurn' }), { kind: 'endTurn' });
}
function save(state: Conquest, design = createDesign('fighter')): Conquest {
  return apply(state, { kind: 'createProject', name: design.name, design });
}
function freeze(value: object): void {
  Object.values(value).forEach(item => { if (item && typeof item === 'object') freeze(item); });
  Object.freeze(value);
}
function reject(state: Conquest, payload: Record<string, unknown>, code: string): void {
  const before = structuredClone(state);
  expect(executeConquestCommand(state, {
    factionId: state.session.turn % 2 ? 'blue' : 'red', expectedTurn: state.session.turn, ...payload
  })).toMatchObject({ ok: false, code });
  expect(state).toEqual(before);
}

describe('campaign-owned project contract', () => {
  it.each(['blue', 'red'] as const)('keeps %s drafts local and independent without money, production, ships or clock access', faction => {
    let source = createConquest();
    if (faction === 'red') source = apply(source, { kind: 'endTurn' });
    const design = createDesign('fighter'), before = structuredClone(source);
    freeze(source); freeze(design);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock forbidden'); });
    const host = vi.spyOn(ConquestSaveManager.prototype, 'save');
    let next: Conquest;
    try { next = save(source, design); } finally { clock.mockRestore(); }
    expect(host).not.toHaveBeenCalled(); host.mockRestore();
    expect(next.projects[faction].items[0]).toMatchObject({ id: 1, factionId: faction, design });
    expect({ ...next, projects: before.projects }).toEqual(before);
    expect(getConquestView(next, faction === 'blue' ? 'red' : 'blue').projects).toEqual([]);
    const view = getConquestView(next, faction);
    view.projects[0].design.slots[0].component = createComponentWithId('beam', 'mutated');
    view.projects[0].name = 'Mutated';
    expect(next.projects[faction].items[0].design).toEqual(design);
    expect(createConquest().projects[faction].items).toEqual([]);
  });

  it('copies, renames, replaces and deletes without aliases or ID reuse', () => {
    let state = save(createConquest());
    state = apply(state, { kind: 'copyProject', projectId: 1 });
    expect(state.projects.blue.items.map(item => item.id)).toEqual([1, 2]);
    expect(state.projects.blue.items[1].design).not.toBe(state.projects.blue.items[0].design);
    state = apply(state, { kind: 'renameProject', projectId: 2, name: 'Civilian' });
    expect(state.projects.blue.items[1].design.name).toBe('Civilian');
    const replacement = createDesign('fighter', true);
    state = apply(state, { kind: 'replaceProject', projectId: 1, design: replacement });
    expect(state.projects.blue.items[0].name).toBe(replacement.name);
    state = apply(state, { kind: 'deleteProject', projectId: 1 });
    state = save(state);
    expect(state.projects.blue.items.map(item => item.id)).toEqual([2, 3]);
    expect(state.session.production.lastOrderId).toBe(0);
    reject(state, { kind: 'deleteProject', projectId: 1 }, 'PROJECT_NOT_FOUND');
  });

  it('accepts exactly 25 and rejects 26 and an exhausted independent counter atomically', () => {
    let state = createConquest();
    for (let index = 0; index < MAX_CAMPAIGN_PROJECTS; index++) state = save(state);
    expect(state.projects.blue.items).toHaveLength(25);
    reject(state, { kind: 'createProject', name: 'Extra', design: createDesign('fighter') }, 'PROJECT_LIMIT');
    reject(state, { kind: 'copyProject', projectId: 1 }, 'PROJECT_LIMIT');
    state = apply(state, { kind: 'deleteProject', projectId: 1 });
    state.projects.blue.lastProjectId = MAX_PROJECT_ID;
    reject(state, { kind: 'copyProject', projectId: 2 }, 'PROJECT_ID_LIMIT');
    reject(state, { kind: 'createProject', name: 'Extra', design: createDesign('fighter') }, 'PROJECT_ID_LIMIT');
    expect(apply(state, { kind: 'renameProject', projectId: 2, name: 'Still editable' }).projects.blue.lastProjectId).toBe(MAX_PROJECT_ID);
  });

  it.each(['createProject', 'replaceProject'] as const)('rejects closed hull/family/numbers at direct %s', kind => {
    const state = save(createConquest());
    const closedHull = createDesign('battleship');
    const closedFamily = installComponent(createDesign('fighter'), 'armor_1', createComponentWithId('armor', 'armor'));
    const oversized = installComponent(createDesign('fighter'), 'beam_1', {
      ...createComponentWithId('beam', 'beam'), kind: 'beam', damage: 50, range: 800, fireRate: 2, accuracy: 0.9
    });
    for (const design of [closedHull, closedFamily, oversized]) {
      reject(state, { kind, ...(kind === 'createProject' ? { name: 'Blocked' } : { projectId: 1 }), design }, 'INVALID_DESIGN');
    }
  });

  it('saves incomplete legal draft, blocks its order and permits unarmed flight-ready civilian designs', () => {
    let state = save(createConquest());
    reject(state, { kind: 'enqueueProduction', systemId: 'sol', design: state.projects.blue.items[0].design }, 'INVALID_DESIGN');
    const civilian = installComponent(createDesign('fighter'), 'engine_1', createComponentWithId('engine', 'engine'));
    expect(isCampaignDraftAvailable(civilian, state.research.blue, state.researchTree)).toBe(true);
    expect(isCampaignDesignAvailable(civilian, state.research.blue, state.researchTree)).toBe(true);
    state = apply(state, { kind: 'replaceProject', projectId: 1, design: civilian });
    while (state.session.treasuries.blue.credits < getProductionQuote(civilian).cost.credits) state = round(state);
    expect(apply(state, { kind: 'enqueueProduction', systemId: 'sol', design: civilian }).session.production.orders).toHaveLength(1);
  });

  it('keeps exact preset exemption but rejects modified numeric values', () => {
    const state = createConquest();
    state.research.blue.completed = ['support', 'ordnance', 'capital'];
    const preset = createCombatDesign('dreadnought');
    expect(isCampaignDraftAvailable(preset, state.research.blue, state.researchTree)).toBe(true);
    expect(save(state, preset).projects.blue.items).toHaveLength(1);
    const changed = structuredClone(preset);
    const beam = changed.slots.find(slot => slot.component?.kind === 'beam')!.component!;
    if (beam.kind !== 'beam') throw new Error('Missing beam');
    beam.damage += 0.01;
    reject(state, { kind: 'createProject', name: 'Edited', design: changed }, 'INVALID_DESIGN');
  });

  it('accepts the current numeric boundary and rejects just beyond it without losing the prior record', () => {
    const state = save(createConquest());
    const base = createComponentWithId('beam', 'boundary');
    if (base.kind !== 'beam') throw new Error('Missing beam');
    const atBoundary = installComponent(createDesign('fighter'), 'beam_1', { ...base, damage: 27.5 });
    const accepted = apply(state, { kind: 'replaceProject', projectId: 1, design: atBoundary });
    expect(accepted.projects.blue.items[0].design).toEqual(atBoundary);
    const beyond = installComponent(atBoundary, 'beam_1', { ...base, damage: 27.500001 });
    reject(accepted, { kind: 'replaceProject', projectId: 1, design: beyond }, 'INVALID_DESIGN');
    expect(accepted.projects.blue.items[0].design).toEqual(atBoundary);
  });

  it('enforces stale, own, controller and completed gates before mutation', () => {
    let state = save(createConquest());
    reject(state, { kind: 'renameProject', projectId: 1, name: 'Late', expectedTurn: 2 }, 'STALE_TURN');
    reject(state, { kind: 'deleteProject', projectId: 1, factionId: 'red' }, 'NOT_ACTIVE_FACTION');
    state = apply(state, { kind: 'endTurn' });
    reject(state, { kind: 'deleteProject', projectId: 1 }, 'PROJECT_NOT_FOUND');
    state.control = { mode: 'human-vs-ai', aiPolicy: 'conquest-v1' };
    reject(state, { kind: 'createProject', name: 'Forbidden', design: createDesign('fighter') }, 'CONTROLLER_FORBIDDEN');
    state.control = { mode: 'local' }; state.session.turn = 3;
    for (const system of state.session.galaxy.systems) {
      if (getGalaxyDefinition(state.session.galaxy).systems.find(item => item.id === system.id)!.habitable) {
        system.ownerId = 'blue'; system.exploredBy = ['blue', 'red'];
      }
    }
    expect(getConquestView(state, 'blue').projects).toHaveLength(1);
    reject(state, { kind: 'deleteProject', projectId: 1 }, 'CAMPAIGN_COMPLETED');
  });

  it.each(['duplicate', 'owner', 'counter', 'invalid-draft', 'missing'] as const)('rejects hidden invalid catalog: %s', error => {
    const state = save(createConquest());
    const catalog = state.projects.blue;
    if (error === 'duplicate') catalog.items.push(structuredClone(catalog.items[0]));
    if (error === 'owner') catalog.items[0].factionId = 'red';
    if (error === 'counter') catalog.lastProjectId = 0;
    if (error === 'invalid-draft') catalog.items[0].design = createDesign('battleship');
    const input = error === 'missing' ? { ...state, projects: undefined } : state;
    expect(conquestSchema.safeParse(input).success).toBe(false);
    expect(() => encodeConquestSave(input)).toThrow();
    expect(executeConquestCommand(input, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('project command rejection and save-port failure preserve different accepted state and bytes', () => {
    const state = save(createConquest()), accepted = structuredClone(state);
    let bytes = encodeConquestSave(createConquest());
    const previous = bytes;
    const manager = new ConquestSaveManager({ getItem: () => bytes, setItem: (_key, value) => {
      if (value !== previous) throw new Error('quota');
      bytes = value;
    } });
    expect(manager.save(state).ok).toBe(false);
    expect(bytes).toBe(previous); expect(state).toEqual(accepted);
    reject(state, { kind: 'replaceProject', projectId: 1, design: createDesign('battleship') }, 'INVALID_DESIGN');
    expect(decodeConquestSave(encodeConquestSave(state))).toEqual(accepted);
    const envelope = JSON.parse(encodeConquestSave(state));
    expect(envelope.schemaVersion).toBe(6);
    expect(() => decodeConquestSave(JSON.stringify({ ...envelope, schemaVersion: 5 }))).toThrow();
  });

  it('earned research expands the next draft without changing accepted blue/red designs or paid snapshots', () => {
    let state = save(createConquest(), createDesign('fighter', true));
    const design = structuredClone(state.projects.blue.items[0].design);
    const quote = getProductionQuote(design);
    while (state.session.treasuries.blue.credits < quote.cost.credits + 10) state = round(state);
    state = apply(state, { kind: 'enqueueProduction', systemId: 'sol', design });
    state = apply(state, { kind: 'research', technologyId: 'support' });
    state = round(round(state));
    expect(state.research.blue.completed).toContain('support');
    expect(state.projects.blue.items[0].design).toEqual(design);
    expect([...state.session.production.orders, ...state.session.production.completed][0].design).toEqual(design);
    const next = installComponent(design, 'armor_1', createComponentWithId('armor', 'opened-armor'));
    expect(save(state, next).projects.blue.items).toHaveLength(2);
    expect(state.projects.blue.items).toHaveLength(1);
    expect(state.projects.red.items).toEqual([]);
  });
});

it('paid generated campaign projects survive FIFO, deletion, travel and real battle through independent load branches', () => {
  const generated = generateBrowserGalaxy(6, 41);
  if (!generated.ok) throw new Error(generated.message);
  let state = createConquest({ mode: 'local' }, undefined, 101, generated.map);
  const homes = getGalaxyDefinition(state.session.galaxy).factions;
  const home = (side: CampaignFactionId) => homes.find(item => item.id === side)!.homeSystemId;
  const design = createDesign('fighter', true), quote = getProductionQuote(design);
  state = save(state, design);
  state = apply(state, { kind: 'endTurn' });
  state = save(state, design);
  const checkpoint = (source: Conquest) => {
    const loaded = decodeConquestSave(encodeConquestSave(source));
    expect(loaded).toEqual(source);
    expect(round(loaded)).toEqual(round(source));
    return loaded;
  };
  state = checkpoint(state);
  while (state.session.treasuries.red.credits < quote.cost.credits) state = round(state);
  state = apply(state, { kind: 'enqueueProduction', systemId: home('red'), design: state.projects.red.items[0].design });
  state = apply(state, { kind: 'endTurn' });
  state = apply(state, { kind: 'enqueueProduction', systemId: home('blue'), design: state.projects.blue.items[0].design });
  state = apply(state, { kind: 'deleteProject', projectId: 1 });
  const snapshots = state.session.production.orders.map(item => ({ id: item.id, design: structuredClone(item.design) }));
  state = checkpoint(state);
  while (state.session.production.completed.length < 2) state = round(state);
  expect([...state.session.production.completed].sort((a, b) => a.id - b.id).map(item => ({ id: item.id, design: item.design }))).toEqual(snapshots);
  state = apply(state, { kind: 'deployProduction', systemId: home('blue'), orderId: 2 });
  state = apply(state, { kind: 'endTurn' });
  state = apply(state, { kind: 'deployProduction', systemId: home('red'), orderId: 1 });
  state = apply(state, { kind: 'endTurn' });
  const lanes = getGalaxyDefinition(state.session.galaxy).lanes;
  const paths: SystemId[][] = [[home('blue')]], visited = new Set<SystemId>();
  let route: SystemId[] | undefined;
  while (paths.length) {
    const path = paths.shift()!, last = path[path.length - 1];
    if (last === home('red')) { route = path; break; }
    if (visited.has(last)) continue;
    visited.add(last);
    for (const [a, b] of lanes) if (a === last || b === last) paths.push([...path, a === last ? b : a]);
  }
  if (!route) throw new Error('Missing route');
  for (const destinationId of route.slice(1)) {
    const ship = state.session.ships.find(item => item.id === 2)!;
    state = apply(state, { kind: 'sendShip', systemId: ship.systemId, shipId: ship.id, destinationId });
    state = checkpoint(state);
    state = round(state);
  }
  expect(state.lastBattleId).toBeGreaterThan(0);
  expect(state.projects.red.items[0].design).toEqual(design);
  expect(state.projects.blue.items).toEqual([]);
  expect(decodeConquestSave(encodeConquestSave(state))).toEqual(state);
});
