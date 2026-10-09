import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { conquestSchema, createConquest, executeConquestCommand, type Conquest } from '../src/domain/conquest';
import { createDesign } from '../src/domain/shipDesign';
import { createOperationalState } from '../src/domain/campaignOperations';
import { decodeConquestSave } from '../src/utils/ConquestSaveManager';
import { CampaignSaveManager } from '../src/utils/CampaignSaveManager';
import { closeShipyardModal } from '../src/ui/ShipyardModal';
import * as ai from '../src/domain/conquestAi';
import { LocalGalaxyMapRepository } from '../src/utils/GalaxyMapRepository';
import { decodeGalaxyMap } from '../src/domain/galaxyMap';
import * as browserGenerator from '../src/utils/BrowserGalaxyGenerator';

vi.stubGlobal('Phaser', { Scene: class {} });
const { ConquestScene } = await import('../src/scenes/ConquestScene');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

class Node extends EventEmitter {
  name = ''; text = ''; destroyed = false; list: Node[] = []; input = { enabled: false };
  context = { measureText: (value: string) => ({ width: value.length * 8 }) };
  constructor(value = '') { super(); this.text = value; }
  add(node: Node) { this.list.push(node); return this; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('destroy'); this.list.forEach(node => node.destroy()); this.removeAllListeners(); }
  removeAll() { this.list.forEach(node => node.destroy()); this.list = []; return this; }
  setName(value: string) { this.name = value; return this; }
  setText(value: string) { this.text = value; return this; }
  setInteractive() { this.input.enabled = true; return this; }
  disableInteractive() { this.input.enabled = false; return this; }
  setAlpha() { return this; }
  setPadding() { return this; }
  setBackgroundColor() { return this; }
  setFixedSize() { return this; }
  setDepth() { return this; }
  setWordWrapWidth() { return this; }
  setStrokeStyle() { return this; }
  fillStyle() { return this; }
  fillRect() { return this; }
  fillRoundedRect() { return this; }
  strokeRoundedRect() { return this; }
  fillCircle() { return this; }
  lineStyle() { return this; }
  lineBetween() { return this; }
}

function fixture(storage = new Map<string, string>(), initialize = true) {
  const nodes: Node[] = [], events = new EventEmitter(), keyboard = new EventEmitter();
  const make = (value = '') => { const node = new Node(value); nodes.push(node); return node; };
  const read = vi.fn((key: string) => storage.get(key) ?? null), write = vi.fn((key: string, value: string) => { storage.set(key, value); });
  vi.stubGlobal('localStorage', { getItem: read, setItem: write });
  const tasks: { callback: () => void; remove: ReturnType<typeof vi.fn> }[] = [];
  const scene = new ConquestScene();
  const owner = scene as unknown as { state: Conquest; phase: string; page: number; tab: string;
    observer: 'blue' | 'red'; selected: string; replace(state: Conquest): void; render(): void };
  Object.assign(scene, { cameras: { main: { width: 1280, height: 720 } }, input: { keyboard }, events,
    scene: { start: () => events.emit('shutdown') }, time: { delayedCall: (_delay: number, callback: () => void) => {
      const task = { callback, remove: vi.fn() }; tasks.push(task); return task;
    } }, add: { container: () => make(), graphics: () => make(), circle: () => make(), rectangle: () => make(),
      text: (_x: number, _y: number, value: string) => make(value) } });
  scene.create();
  if (initialize) { closeShipyardModal(scene); owner.replace(createConquest()); }
  const find = (name: string) => { const found = nodes.find(node => node.name === name && !node.destroyed); if (!found) throw Error(name); return found; };
  const click = (name: string) => { const node = find(name); if (!node.input.enabled) throw Error(`Disabled ${name}`); node.emit('pointerdown'); };
  return { scene, owner, nodes, events, keyboard, tasks, storage, read, write, find, click };
}

it('creates without storage IO and cleans scene state and handlers on shutdown', () => {
  const test = fixture();
  expect(test.read).not.toHaveBeenCalled(); expect(test.write).not.toHaveBeenCalled();
  expect(test.keyboard.listenerCount('keydown-ESC')).toBe(1);
  test.events.emit('shutdown');
  expect(test.nodes.every(node => node.destroyed)).toBe(true);
  expect(test.keyboard.listenerCount('keydown-ESC')).toBe(0);
});

it('starts only after saving the selected generated map and displays two locked participants', () => {
  const test = fixture(new Map(), false);
  expect(test.owner.state).toBeUndefined();
  expect(test.write).not.toHaveBeenCalled();
  expect(test.find('conquest-participants').input.enabled).toBe(false);
  expect(test.find('conquest-world-count').text).toBe('Миров: 40');
  test.click('conquest-worlds-plus'); test.click('conquest-worlds-minus-ten');
  vi.spyOn(browserGenerator, 'createGalaxySeed').mockReturnValue(12345);
  test.click('conquest-new-local');
  expect(test.owner.state.session.galaxy.systems).toHaveLength(31);
  expect(test.write).toHaveBeenCalledTimes(1);
  const decoded = decodeGalaxyMap(test.storage.get(LocalGalaxyMapRepository.STORAGE_KEY)!);
  expect(decoded).toMatchObject({ ok: true, map: test.owner.state.session.galaxy.map });
  expect(test.owner.state.seed).toBe(12345);
  expect(test.nodes.filter(node => !node.destroyed && node.name.startsWith('conquest-system-'))).toHaveLength(31);
  test.click('conquest-select-world');
  test.click('choice-2');
  expect(test.owner.selected).toBe('world-003');
  test.events.emit('shutdown');
});

it('bounds world count and cancel never generates or writes', () => {
  const test = fixture();
  const before = structuredClone(test.owner.state);
  const generate = vi.spyOn(browserGenerator, 'generateBrowserGalaxy');
  test.click('conquest-new');
  for (let index = 0; index < 30; index++) test.click('conquest-worlds-plus-ten');
  expect(test.find('conquest-world-count').text).toBe('Миров: 256');
  for (let index = 0; index < 30; index++) test.click('conquest-worlds-minus-ten');
  expect(test.find('conquest-world-count').text).toBe('Миров: 6');
  test.click('conquest-new-cancel');
  expect(generate).not.toHaveBeenCalled(); expect(test.write).not.toHaveBeenCalled();
  expect(test.owner.state).toEqual(before);
  test.events.emit('shutdown');
});

it('refuses startup on local write failure without changing the current campaign or previous map', () => {
  const test = fixture();
  test.click('conquest-new'); test.click('conquest-new-local');
  const before = structuredClone(test.owner.state), bytes = test.storage.get(LocalGalaxyMapRepository.STORAGE_KEY);
  test.write.mockImplementation(() => { throw new Error('quota'); });
  test.click('conquest-new'); test.click('conquest-worlds-plus'); test.click('conquest-new-ai');
  expect(test.owner.state).toEqual(before);
  expect(test.storage.get(LocalGalaxyMapRepository.STORAGE_KEY)).toBe(bytes);
  expect(test.find('conquest-generation-error').text).toContain('не запущена');
  test.click('conquest-new-cancel');
  test.events.emit('shutdown');
});

it('load restores the saved map rather than generating or reading the latest-map slot', () => {
  const test = fixture();
  test.click('conquest-new'); test.click('conquest-new-ai');
  test.click('conquest-end');
  const saved = structuredClone(test.owner.state);
  test.click('conquest-save'); test.click('conquest-confirm');
  test.click('conquest-new'); test.click('conquest-worlds-plus'); test.click('conquest-new-local');
  const latest = test.storage.get(LocalGalaxyMapRepository.STORAGE_KEY);
  const generate = vi.spyOn(browserGenerator, 'generateBrowserGalaxy');
  test.read.mockClear(); test.write.mockClear();
  test.click('conquest-load'); test.click('conquest-confirm');
  expect(test.owner.state).toEqual(saved);
  expect(test.owner.phase).toBe('paused');
  expect(generate).not.toHaveBeenCalled(); expect(test.write).not.toHaveBeenCalled();
  expect(test.read).toHaveBeenCalledExactlyOnceWith(CampaignSaveManager.STORAGE_KEY);
  expect(test.storage.get(LocalGalaxyMapRepository.STORAGE_KEY)).toBe(latest);
  test.events.emit('shutdown');
});

it('rejects late asynchronous map-repository completion after shutdown and reentry', async () => {
  const test = fixture();
  let resolve!: (value: { ok: true }) => void;
  const save = vi.fn(() => new Promise<{ ok: true }>(done => { resolve = done; }));
  Object.assign(test.scene, { mapRepository: { save } });
  test.click('conquest-new'); test.click('conquest-new-local');
  test.click('conquest-new-ai');
  expect(save).toHaveBeenCalledOnce();
  test.events.emit('shutdown');
  test.scene.create();
  const before = test.owner.state;
  resolve({ ok: true }); await Promise.resolve();
  expect(test.owner.state).toBe(before);
  test.click('conquest-new-cancel');
  test.events.emit('shutdown');
});

it('draws the replay backdrop once and only clears the dynamic layer per frame', () => {
  const test = fixture();
  const graphics: { clear: ReturnType<typeof vi.fn>; fillStyle: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>; lineStyle: ReturnType<typeof vi.fn>; lineBetween: ReturnType<typeof vi.fn>;
    fillTriangle: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const add = test.scene.add as unknown as { graphics(): unknown };
  add.graphics = () => {
    const object = {} as (typeof graphics)[number];
    object.clear = vi.fn(); object.destroy = vi.fn();
    object.fillStyle = vi.fn(() => object); object.fillRect = vi.fn(() => object);
    object.lineStyle = vi.fn(() => object); object.lineBetween = vi.fn(() => object);
    object.fillTriangle = vi.fn(() => object);
    graphics.push(object);
    return object;
  };
  const owner = test.scene as unknown as {
    frames: { seconds: number; ships: { id: number; factionId: 'blue' | 'red'; x: number; y: number; hull: number }[]; events: [] }[];
    openReplay(): void; update(time: number, delta: number): void; pauseAi(): void; render(): void;
  };
  owner.frames = [{ seconds: 0, ships: [{ id: 1, factionId: 'blue', x: 200, y: 200, hull: 100 }], events: [] }];
  owner.pauseAi = vi.fn(); owner.render = vi.fn();

  owner.openReplay();
  owner.update(0, 16); owner.update(16, 16);

  expect(graphics).toHaveLength(2);
  expect(graphics[0].fillRect).toHaveBeenCalledOnce();
  expect(graphics[0].fillRect).toHaveBeenCalledWith(0, 0, 1280, 720);
  expect(graphics[0].clear).not.toHaveBeenCalled();
  expect(graphics[1].clear).toHaveBeenCalledTimes(2);
  closeShipyardModal(test.scene);
  test.events.emit('shutdown');
});

it('guards obsolete callbacks and consumes each scheduled AI ticket only once', () => {
  const test = fixture();
  test.click('conquest-new'); test.click('conquest-new-ai');
  const oldEnd = test.find('conquest-end').listeners('pointerdown')[0];
  test.click('conquest-end');
  expect(test.owner.state.session.turn).toBe(2);
  expect(test.tasks).toHaveLength(1);
  oldEnd(); expect(test.owner.state.session.turn).toBe(2);
  const executor = vi.spyOn(ai, 'executeConquestAiTurn');
  test.tasks[0].callback(); test.tasks[0].callback();
  expect(executor).toHaveBeenCalledTimes(1);
  expect(test.owner.state.session.turn).toBe(3);
});

it('save cancels AI before confirmation and cancel does not reschedule', () => {
  const test = fixture();
  test.click('conquest-new'); test.click('conquest-new-ai'); test.click('conquest-end');
  const before = structuredClone(test.owner.state);
  test.write.mockClear();
  test.click('conquest-save');
  expect(test.tasks[0].remove).toHaveBeenCalledTimes(1);
  expect(test.write).not.toHaveBeenCalled();
  test.click('conquest-cancel'); test.tasks[0].callback();
  expect(test.owner.state).toEqual(before);
  expect(test.owner.phase).toBe('paused');
  expect(test.tasks).toHaveLength(1);
});

it('saves a full version5 snapshot and loads AI-red paused in a fresh scene', () => {
  const test = fixture();
  test.click('conquest-new'); test.click('conquest-new-ai'); test.click('conquest-end');
  const before = structuredClone(test.owner.state);
  test.click('conquest-save'); test.click('conquest-confirm');
  const bytes = test.storage.get(CampaignSaveManager.STORAGE_KEY)!;
  expect(decodeConquestSave(bytes)).toEqual(before);
  test.events.emit('shutdown');
  const restored = fixture(test.storage);
  expect(restored.owner.state.session.turn).toBe(1);
  restored.click('conquest-load'); restored.click('conquest-confirm');
  expect(restored.owner.state).toEqual(before);
  expect(restored.owner.phase).toBe('paused'); expect(restored.tasks).toHaveLength(0);
  restored.click('conquest-resume'); restored.click('conquest-confirm');
  restored.tasks[0].callback();
  expect(restored.owner.state.session.turn).toBe(3);
});

it('completed campaigns remain readonly while save and inspection stay available', () => {
  const test = fixture(), completed = createConquest();
  for (const system of completed.session.galaxy.systems.filter(system => ['sol', 'eden', 'nexus', 'vega'].includes(system.id))) {
    system.ownerId = 'blue'; if (!system.exploredBy.includes('blue')) system.exploredBy.push('blue');
  }
  test.owner.replace(completed);
  expect(test.find('conquest-end').input.enabled).toBe(false);
  expect(test.find('conquest-ai').input.enabled).toBe(false);
  test.click('conquest-tab-fleet'); test.click('conquest-save'); test.click('conquest-confirm');
  expect(test.owner.state).toEqual(completed);
  expect(test.write).toHaveBeenCalledTimes(1);
});

it('clamps production and fleet pages immediately after deploy, arrival and battle losses', () => {
  const test = fixture();
  const design = createDesign('fighter', true);
  const state = test.owner.state;
  state.session.production.lastOrderId = 5;
  state.session.production.completed = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1, factionId: 'blue' as const, systemId: 'sol' as const, design: structuredClone(design)
  }));
  test.owner.state = conquestSchema.parse(state);
  test.click('conquest-tab-production');
  test.click('conquest-page-next');
  expect(test.nodes.some(node => !node.destroyed && node.text === '2 / 2')).toBe(true);
  test.click('conquest-order-5');
  expect(test.nodes.some(node => !node.destroyed && node.text === '1 / 1')).toBe(true);
  expect(test.find('conquest-order-4')).toBeDefined();
  expect(() => test.find('conquest-order-5')).toThrow();
  for (const id of [4, 3, 2, 1]) test.click(`conquest-order-${id}`);
  expect(test.owner.state.session.ships.map(ship => ship.id)).toEqual([5, 4, 3, 2, 1]);
  test.owner.page = 1;
  test.owner.render();
  expect(test.nodes.some(node => !node.destroyed && node.text === '1 / 1')).toBe(true);

  test.click('conquest-tab-fleet');
  test.owner.page = 1;
  test.owner.render();
  expect(test.nodes.some(node => !node.destroyed && node.text === '2 / 2')).toBe(true);
  const movement = executeConquestCommand(test.owner.state, {
    kind: 'sendShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 5, destinationId: 'eden'
  });
  if (!movement.ok) throw new Error(movement.message);
  test.owner.state = movement.state;
  test.owner.render();
  test.click('conquest-end');
  expect(test.owner.state.session.ships.find(ship => ship.id === 5)?.systemId).toBe('eden');
  expect(test.nodes.some(node => !node.destroyed && node.text === '1 / 1')).toBe(true);

  const casualtyDesign = structuredClone(design);
  casualtyDesign.slots.find(slot => slot.id === 'beam_1')!.component = null;
  for (let id = 6; id <= 10; id++) {
    test.owner.state.session.ships.push({ id, factionId: 'red', systemId: 'sol', fuel: 3, design: structuredClone(casualtyDesign) });
    const operation = createOperationalState(casualtyDesign);
    operation.hull = 1;
    test.owner.state.operations[String(id)] = operation;
  }
  test.owner.state.session.production.lastOrderId = 10;
  test.owner.state = conquestSchema.parse(test.owner.state);
  test.owner.observer = 'red';
  test.owner.selected = 'sol';
  test.owner.page = 1;
  test.owner.render();
  expect(test.nodes.some(node => !node.destroyed && node.text === '2 / 2')).toBe(true);
  const battle = executeConquestCommand(test.owner.state, { kind: 'endTurn', factionId: 'red', expectedTurn: 2 });
  if (!battle.ok) throw new Error(battle.message);
  test.owner.state = battle.state;
  test.owner.page = 1;
  test.owner.render();
  expect(battle.state.session.ships.filter(ship => ship.factionId === 'red' && ship.systemId === 'sol')).toHaveLength(0);
  expect(test.nodes.some(node => !node.destroyed && node.text === '1 / 1')).toBe(true);
  test.owner.tab = 'battles';
  test.owner.page = 1;
  test.owner.render();
  expect(test.nodes.some(node => !node.destroyed && node.text === '1 / 1')).toBe(true);
  test.owner.tab = 'research';
  test.owner.page = 1;
  test.owner.render();
  expect(test.nodes.some(node => !node.destroyed && node.text === '1 / 1')).toBe(true);
  test.events.emit('shutdown');
});