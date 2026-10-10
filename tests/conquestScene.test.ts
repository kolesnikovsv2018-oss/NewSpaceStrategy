import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { conquestSchema, createConquest, executeConquestCommand, type Conquest } from '../src/domain/conquest';
import { createDesign } from '../src/domain/shipDesign';
import { createCombatDesign, isCombatPresetDesign } from '../src/domain/combatPresets';
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
  name = ''; text = ''; destroyed = false; active = true; list: Node[] = []; input = { enabled: false };
  x = 0; y = 0; width = 0; height = 20; fontSize = 14;
  context = { measureText: (value: string) => ({ width: value.length * 8 }) };
  constructor(value = '') { super(); this.text = value; }
  add(node: Node) { this.list.push(node); return this; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.active = false; this.emit('destroy'); this.list.forEach(node => node.destroy()); this.removeAllListeners(); }
  removeAll() { this.list.forEach(node => node.destroy()); this.list = []; return this; }
  setName(value: string) { this.name = value; return this; }
  setText(value: string) { this.text = value; return this; }
  setInteractive() { this.input.enabled = true; return this; }
  disableInteractive() { this.input.enabled = false; return this; }
  setAlpha() { return this; }
  setFontSize(value: number | string) { this.fontSize = Number.parseInt(String(value), 10); return this; }
  setPadding() { return this; }
  setBackgroundColor() { return this; }
  setFixedSize(width: number, height: number) { this.width = width; this.height = height; return this; }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  setSize(width: number, height: number) { this.width = width; this.height = height; return this; }
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

class Keyboard extends EventEmitter {
  active = true;
  isActive() { return this.active; }
  private bound = new Map<(...args: unknown[]) => void, (...args: unknown[]) => void>();
  override on(event: string | symbol, listener: (...args: unknown[]) => void, context?: object) {
    const bound = context ? listener.bind(context) : listener;
    this.bound.set(listener, bound);
    return super.on(event, bound);
  }
  override off(event: string | symbol, listener: (...args: unknown[]) => void) {
    const result = super.off(event, this.bound.get(listener) ?? listener);
    this.bound.delete(listener);
    return result;
  }
}

function fixture(storage = new Map<string, string>(), initialize = true, width = 1280, height = 720) {
  const nodes: Node[] = [], events = new EventEmitter(), keyboard = new Keyboard();
  const make = (value = '') => { const node = new Node(value); nodes.push(node); return node; };
  const read = vi.fn((key: string) => storage.get(key) ?? null), write = vi.fn((key: string, value: string) => { storage.set(key, value); });
  vi.stubGlobal('localStorage', { getItem: read, setItem: write });
  const tasks: { callback: () => void; remove: ReturnType<typeof vi.fn> }[] = [];
  const scene = new ConquestScene();
  const owner = scene as unknown as { state: Conquest; phase: string; page: number; tab: string;
    observer: 'blue' | 'red'; selected: string; replace(state: Conquest): void; render(): void;
    forwardEscape(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>): void };
  Object.assign(scene, { cameras: { main: { width, height } }, input: { keyboard }, events,
    scene: { start: () => events.emit('shutdown') }, time: { delayedCall: (_delay: number, callback: () => void) => {
      const task = { callback, remove: vi.fn() }; tasks.push(task); return task;
    } }, add: { container: (x = 0, y = 0) => Object.assign(make(), { x, y }), graphics: () => make(), circle: () => make(), rectangle: () => make(),
      text: (x: number, y: number, value: string, style: { fontSize: string }) =>
        Object.assign(make(value), { x, y, fontSize: Number.parseInt(style.fontSize, 10) }) } });
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

it('saves an owned campaign blueprint without paying production or creating a ship', () => {
  const test = fixture();
  const before = structuredClone(test.owner.state.session);
  const beforeProjects = structuredClone(test.owner.state.projects);
  test.click('conquest-projects');
  expect(test.find('campaign-project-panel')).toBeDefined();
  expect(test.find('campaign-project-save').input.enabled).toBe(true);
  test.click('campaign-project-save');
  const projects = test.owner.state.projects.blue.items;
  expect(projects).toHaveLength(1);
  expect(projects[0].factionId).toBe('blue');
  expect(projects[0].design).not.toBe(beforeProjects.blue.items[0]?.design);
  expect(test.owner.state.session).not.toHaveProperty('projects');
  expect(test.owner.state.session.ships).toEqual(before.ships);
  expect(test.owner.state.session.production).toEqual(before.production);
  expect(test.owner.state.session.treasuries).toEqual(before.treasuries);
  expect(test.write).not.toHaveBeenCalled();
  test.click('campaign-project-copy');
  expect(test.owner.state.projects.blue.items).toHaveLength(2);
  expect(test.owner.state.projects.blue.items[0].design.slots).toEqual(test.owner.state.projects.blue.items[1].design.slots);
  expect(test.owner.state.projects.blue.items[0].design).not.toBe(test.owner.state.projects.blue.items[1].design);
  vi.stubGlobal('prompt', () => 'Renamed');
  test.click('campaign-project-rename');
  expect(test.owner.state.projects.blue.items[1].name).toBe('Renamed');
  test.click('campaign-project-delete');
  test.click('campaign-delete-confirm');
  expect(test.owner.state.projects.blue.items).toHaveLength(1);
  test.click('campaign-projects-close');
  test.click('campaign-dirty-confirm');
  expect(test.owner.state.session.turn).toBe(before.turn);
  test.events.emit('shutdown');
});

it.each([[1280, 720], [390, 844]])('reenables save after editing a loaded project at %ix%i', (width, height) => {
  const test = fixture(new Map(), true, width, height);
  if (width === 390) test.click('conquest-tab-actions');
  test.click('conquest-projects');
  test.click('campaign-project-save');
  test.click('campaign-projects-close');
  test.click('conquest-save');
  test.click('conquest-confirm');
  const loaded = decodeConquestSave(test.storage.get(CampaignSaveManager.STORAGE_KEY)!);
  test.owner.replace(loaded);
  if (width === 390) test.click('conquest-tab-actions');
  test.click('conquest-projects');
  if (width === 390) {
    test.click('campaign-project-list');
    test.click('campaign-project-choice-1');
  } else test.click('campaign-project-1');
  test.click('campaign-dirty-confirm');
  expect(test.find('campaign-project-save').input.enabled).toBe(false);
  const before = structuredClone(test.owner.state);
  test.click('slot-beam_1');
  test.click('campaign-choice-3');
  expect(test.find('design-save-status').text).toContain('Не сохранён');
  expect(test.find('campaign-project-save').input.enabled).toBe(true);
  test.click('campaign-projects-close');
  test.click('campaign-dirty-cancel');
  test.click('campaign-project-save');
  const beam = test.owner.state.projects.blue.items[0].design.slots.find(slot => slot.id === 'beam_1')?.component;
  const oldBeam = before.projects.blue.items[0].design.slots.find(slot => slot.id === 'beam_1')?.component;
  if (beam?.kind !== 'beam' || oldBeam?.kind !== 'beam') throw new Error('Missing beam');
  expect(beam.damage).toBeCloseTo(oldBeam.damage * 1.01);
  expect(test.owner.state.session).toEqual(before.session);
  expect(test.find('design-save-status').text).toContain('Сохранён');
  expect(test.find('campaign-project-save').input.enabled).toBe(false);
  test.events.emit('shutdown');
});

it('relayouts an open dirty project immediately on resize without losing its baseline or source', () => {
  const host = { innerWidth: 1280, innerHeight: 720, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', host);
  const test = fixture();
  const camera = test.scene.cameras.main;
  Object.assign(test.scene, { scale: {
    getParentBounds: vi.fn(),
    setGameSize: (width: number, height: number) => { camera.width = width; camera.height = height; }
  } });
  const resize = host.addEventListener.mock.calls.find(call => call[0] === 'resize')![1] as () => void;
  test.click('conquest-projects');
  test.click('campaign-project-save');
  test.click('slot-beam_1');
  test.click('campaign-choice-3');
  const owner = test.owner as unknown as { projectPanel: {
    editor: { getConfiguration(): ReturnType<typeof createDesign> };
    hasUnsavedChanges(): boolean;
  } };
  const panel = owner.projectPanel;
  const draft = panel.editor.getConfiguration();
  const before = structuredClone(test.owner.state);
  const oldRoot = test.find('conquest-root');
  host.innerWidth = 390; host.innerHeight = 844;
  resize();
  expect(oldRoot.destroyed).toBe(true);
  expect(test.find('conquest-tab-map')).toBeDefined();
  expect(test.find('campaign-projects-close').x).toBe(278);
  expect(test.find('slot-beam_1').width).toBe(354);
  expect(owner.projectPanel).toBe(panel);
  expect(panel.editor.getConfiguration()).toEqual(draft);
  expect(panel.hasUnsavedChanges()).toBe(true);
  expect(test.find('campaign-project-save').input.enabled).toBe(true);
  expect(test.owner.state).toEqual(before);

  test.click('campaign-projects-close');
  host.innerWidth = 1280; host.innerHeight = 720;
  resize();
  expect(() => test.find('campaign-dirty-confirm')).toThrow();
  expect(test.find('campaign-projects-close').x).toBe(1168);
  expect(test.find('slot-beam_1').width).toBe(459);
  expect(panel.editor.getConfiguration()).toEqual(draft);
  expect(panel.hasUnsavedChanges()).toBe(true);
  test.click('campaign-project-save');
  expect(test.owner.state.projects.blue.items[0].design).toEqual(draft);
  expect(panel.hasUnsavedChanges()).toBe(false);
  test.click('campaign-projects-close');
  expect(() => test.find('campaign-dirty-confirm')).toThrow();
  test.events.emit('shutdown');
});

it('limits component variants individually while allowing and saving an exact available preset', () => {
  const test = fixture();
  test.click('conquest-projects');
  test.click('slot-beam_1');
  const beamChoices = test.nodes.filter(node => /^campaign-choice-\d+$/.test(node.name)).map(node => node.text);
  test.click('campaign-choice-next');
  beamChoices.push(...test.nodes.filter(node => /^campaign-choice-\d+$/.test(node.name)).map(node => node.text));
  expect(beamChoices.some(label => label.includes('accuracy +1%'))).toBe(true);
  expect(beamChoices.some(label => label.includes('accuracy +10%'))).toBe(false);
  expect(beamChoices.some(label => label.includes('accuracy −10%'))).toBe(false);
  test.click('campaign-choice-cancel');

  test.click('campaign-project-preset');
  test.click('campaign-preset-0');
  test.click('campaign-dirty-confirm');
  const preset = createCombatDesign('fighter');
  test.click('campaign-project-save');
  const savedPreset = test.owner.state.projects.blue.items[0].design;
  expect(savedPreset).toMatchObject({ hullId: preset.hullId, name: preset.name });
  expect(isCombatPresetDesign(savedPreset)).toBe(true);

  const owner = test.owner as unknown as { projectPanel: {
    editor: {
      getConfiguration(): ReturnType<typeof createCombatDesign>;
      installEquipment(slotId: string, component: NonNullable<ReturnType<typeof createCombatDesign>['slots'][number]['component']>): boolean;
      setCampaignDesign(design: ReturnType<typeof createCombatDesign>): void;
    };
    save(): void;
  } };
  const panel = owner.projectPanel;
  const savedDesign = panel.editor.getConfiguration();
  const illegal = structuredClone(savedDesign);
  const beam = illegal.slots.find(slot => slot.id === 'beam_1')?.component;
  if (!beam || beam.kind !== 'beam') throw new Error('Fighter preset is missing its beam');
  const outOfBand = { ...beam, accuracy: 0.1 };
  expect(panel.editor.installEquipment('beam_1', outOfBand)).toBe(false);
  expect(panel.editor.getConfiguration()).toEqual(savedDesign);

  panel.editor.setCampaignDesign(illegal);
  panel.save();
  expect(test.owner.state.projects.blue.items[0].design).toEqual(savedPreset);
  test.events.emit('shutdown');
});

it('does not expose exempt preset modules as individual variants', () => {
  const test = fixture();
  const advanced = structuredClone(test.owner.state);
  advanced.research.blue.completed = ['support', 'ordnance', 'capital'];
  test.owner.replace(conquestSchema.parse(advanced));
  test.click('conquest-projects');
  test.click('campaign-project-preset');
  test.click('campaign-preset-3');
  test.click('campaign-dirty-confirm');
  test.click('campaign-project-save');

  const saved = test.owner.state.projects.blue.items[0];
  expect(isCombatPresetDesign(saved.design)).toBe(true);
  const editorOwner = test.owner as unknown as { projectPanel: {
    editor: {
      getConfiguration(): ReturnType<typeof createCombatDesign>;
      installEquipment(slotId: string, component: NonNullable<ReturnType<typeof createCombatDesign>['slots'][number]['component']>): boolean;
    };
  } };
  const editor = editorOwner.projectPanel.editor;
  const engine = saved.design.slots.find(slot => slot.id === 'engine_1')?.component;
  if (!engine || engine.kind !== 'engine') throw new Error('Dreadnought preset is missing its engine');
  const exactPreset = editor.getConfiguration();
  expect(editor.installEquipment('engine_1', engine)).toBe(false);
  expect(editor.getConfiguration()).toEqual(exactPreset);

  test.click('campaign-project-1');
  test.click('slot-engine_1');
  const engineChoices: string[] = [];
  for (let page = 0; page < 4; page++) {
    engineChoices.push(...test.nodes.filter(node => !node.destroyed && /^campaign-choice-\d+$/.test(node.name))
      .map(node => node.text));
    const indicator = test.nodes.find(node => !node.destroyed && /^\d+ \/ \d+$/.test(node.text));
    if (!indicator || Number(indicator.text.split(' / ')[0]) >= Number(indicator.text.split(' / ')[1])) break;
    test.click('campaign-choice-next');
  }
  expect(engineChoices.some(label => label.includes('Линейный двигатель'))).toBe(false);
  test.events.emit('shutdown');
});

it('protects a dirty campaign draft on close and keeps mobile editor controls touch-sized', () => {
  const test = fixture(new Map(), true, 390, 844);
  const before = structuredClone(test.owner.state);
  test.click('conquest-tab-actions');
  test.click('conquest-projects');
  for (const name of ['campaign-project-save', 'campaign-project-new', 'campaign-project-preset',
    'change-hull', 'slot-engine_1', 'slot-beam_1']) {
    const control = test.find(name);
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.fontSize).toBeGreaterThanOrEqual(14);
  }
  const navBottom = Math.max(test.find('campaign-project-prev').y + test.find('campaign-project-prev').height,
    test.find('campaign-project-list').y + test.find('campaign-project-list').height,
    test.find('campaign-project-next').y + test.find('campaign-project-next').height);
  const toolbarTop = Math.min(test.find('campaign-project-save').y, test.find('campaign-project-new').y,
    test.find('campaign-project-copy').y);
  expect(toolbarTop).toBeGreaterThanOrEqual(navBottom);
  test.click('campaign-projects-close');
  expect(test.find('campaign-dirty-confirm')).toBeDefined();
  test.click('campaign-dirty-cancel');
  expect(test.find('campaign-project-panel')).toBeDefined();
  expect(test.owner.state).toEqual(before);
  test.events.emit('shutdown');
});

it('pauses a pending AI ticket when the campaign editor opens and does not resume it implicitly', () => {
  const test = fixture();
  test.click('conquest-new');
  test.click('conquest-new-ai');
  test.click('conquest-end');
  expect(test.tasks).toHaveLength(1);
  test.click('conquest-projects');
  expect(test.tasks[0].remove).toHaveBeenCalledOnce();
  test.click('campaign-projects-close');
  test.click('campaign-dirty-confirm');
  expect(test.owner.state.session.turn).toBe(2);
  expect(test.tasks).toHaveLength(1);
  test.events.emit('shutdown');
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

it.each([[1280, 720], [390, 844]])('keeps primary controls >=44 and text >=14 at %sx%s', (width, height) => {
  const test = fixture(new Map(), true, width, height);
  const sections = width === 390 ? ['map', 'research', 'production', 'fleet', 'battles', 'actions'] :
    ['research', 'production', 'fleet', 'battles'];
  for (const section of sections) {
    test.click(`conquest-tab-${section}`);
    const controls = test.nodes.filter(node => !node.destroyed && node.name.startsWith('conquest-') && node.width > 0);
    for (const node of controls) {
      expect(node.width).toBeGreaterThanOrEqual(44); expect(node.height).toBeGreaterThanOrEqual(44);
      expect(node.x).toBeGreaterThanOrEqual(0); expect(node.x + node.width).toBeLessThanOrEqual(width);
      expect(node.y + node.height).toBeLessThanOrEqual(height);
    }
    for (let i = 0; i < controls.length; i++) for (const other of controls.slice(i + 1)) {
      const node = controls[i];
      expect(node.x >= other.x + other.width || other.x >= node.x + node.width ||
        node.y >= other.y + other.height || other.y >= node.y + node.height).toBe(true);
    }
    expect(test.nodes.filter(node => !node.destroyed && node.text).every(node => node.fontSize >= 14)).toBe(true);
  }
  test.events.emit('shutdown');
});

it.each([[1280, 720], [390, 844]])('help and ESC never command, write or exit twice at %sx%s', (width, height) => {
  const test = fixture(new Map(), true, width, height);
  const before = structuredClone(test.owner.state), end = test.find('conquest-end').listeners('pointerdown')[0];
  test.click('conquest-help'); end();
  test.click('conquest-help-next');
  const obsolete = test.find('conquest-help-next').listeners('pointerdown')[0];
  test.keyboard.emit('keydown-ESC'); obsolete();
  expect(test.owner.state).toEqual(before);
  expect(test.write).not.toHaveBeenCalled(); expect(test.read).not.toHaveBeenCalled();
  expect(test.keyboard.listenerCount('keydown-ESC')).toBe(1);
  expect(test.find('conquest-root').destroyed).toBe(false);
  test.click('conquest-help'); test.click('conquest-help-close');
  if (width === 390) test.click('conquest-tab-actions');
  test.click('conquest-save');
  expect(() => test.click('conquest-help')).not.toThrow();
  expect(() => test.find('conquest-help-body')).toThrow();
  test.click('conquest-cancel');
  expect(test.write).not.toHaveBeenCalled();
  test.events.emit('shutdown'); test.scene.create(); closeShipyardModal(test.scene);
  expect(test.keyboard.listenerCount('keydown-ESC')).toBe(1);
  expect(test.nodes.filter(node => !node.destroyed && node.name === 'conquest-root')).toHaveLength(1);
  test.events.emit('shutdown');
});

it.each(['Очень длинное название проекта '.repeat(2).trim(), 'W'.repeat(80), '🚀'.repeat(40)])('mobile displays the full refusal and preserves long name %s', name => {
  const test = fixture(new Map(), true, 390, 844);
  const design = createDesign('fighter', true); design.name = name;
  const state = test.owner.state;
  state.session.treasuries.blue.credits = 0;
  state.session.production.lastOrderId = 1;
  state.session.production.completed.push({ id: 1, factionId: 'blue', systemId: 'sol', design });
  test.owner.replace(conquestSchema.parse(state));
  test.click('conquest-tab-research');
  const before = structuredClone(test.owner.state);
  const result = executeConquestCommand(before, { kind: 'research', factionId: 'blue', expectedTurn: 1, technologyId: 'support' });
  expect(result.ok).toBe(false);
  test.click('conquest-research-support');
  expect(test.find('conquest-message').text).toBe(!result.ok ? result.message : '');
  expect(test.owner.state).toEqual(before);
  test.click('conquest-tab-production'); test.click('conquest-order-1');
  test.click('conquest-tab-fleet');
  expect(test.find('conquest-ship-1').text).toContain('…');
  expect(Array.from(test.find('conquest-ship-1').text).every(character =>
    character.length === 2 || !/[\uD800-\uDFFF]/.test(character))).toBe(true);
  expect(test.owner.state.session.ships[0].design.name).toBe(design.name);
  test.click('conquest-ship-1');
  expect(test.nodes.some(node => !node.destroyed && node.text.includes('топливо 3/3'))).toBe(true);
  test.events.emit('shutdown');
});

it.each([6, 40, 256])('mobile can choose the last of %s worlds without generation or storage IO', count => {
  const test = fixture(new Map(), false, 390, 844);
  const desired = count - 40;
  for (let i = 0; i < Math.ceil(Math.abs(desired) / 10); i++) test.click(desired < 0 ? 'conquest-worlds-minus-ten' : 'conquest-worlds-plus-ten');
  for (let i = 0; i < 4 && test.find('conquest-world-count').text !== `Миров: ${count}`; i++) test.click('conquest-worlds-minus');
  test.click('conquest-new-local');
  expect(test.owner.state.session.galaxy.systems).toHaveLength(count);
  const generate = vi.spyOn(browserGenerator, 'generateBrowserGalaxy');
  test.read.mockClear(); test.write.mockClear();
  test.click('conquest-select-world');
  for (let i = 0; i < Math.floor((count - 1) / 8); i++) test.click('choice-next');
  test.click(`choice-${count - 1}`);
  expect(test.owner.selected).toBe(test.owner.state.session.galaxy.systems[count - 1].id);
  expect(generate).not.toHaveBeenCalled(); expect(test.read).not.toHaveBeenCalled(); expect(test.write).not.toHaveBeenCalled();
  test.events.emit('shutdown');
});

it('mobile help pauses AI and completed controls stay readonly with inspection and save available', () => {
  const test = fixture(new Map(), false, 390, 844);
  test.click('conquest-new-ai'); test.click('conquest-end');
  const before = structuredClone(test.owner.state);
  test.click('conquest-help'); test.keyboard.emit('keydown-ESC'); test.tasks[0].callback();
  expect(test.owner.state).toEqual(before); expect(test.owner.phase).toBe('paused');
  expect(test.find('conquest-status').text).toContain('paused');
  const completed = createConquest();
  for (const system of completed.session.galaxy.systems.filter(system => ['sol', 'eden', 'nexus', 'vega'].includes(system.id))) {
    system.ownerId = 'blue'; if (!system.exploredBy.includes('blue')) system.exploredBy.push('blue');
  }
  test.owner.replace(completed);
  expect(test.find('conquest-status').text).toContain('только просмотр');
  expect(test.find('conquest-end').input.enabled).toBe(false);
  expect(test.find('conquest-colonize').input.enabled).toBe(false);
  test.click('conquest-tab-actions'); test.click('conquest-save'); test.click('conquest-confirm');
  expect(test.owner.state).toEqual(completed);
  test.events.emit('shutdown');
});

it('forwards host-consumed Escape once and removes viewport/native listeners on shutdown and reentry', () => {
  const host = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', host);
  const test = fixture(new Map(), true, 390, 844);
  expect(host.addEventListener.mock.calls.map(call => call[0])).toEqual(['resize', 'keydown']);
  const before = structuredClone(test.owner.state);
  test.click('conquest-help');
  const event = { key: 'Escape', defaultPrevented: true };
  test.keyboard.active = false;
  test.owner.forwardEscape(event);
  expect(test.find('conquest-help-body')).toBeDefined();
  test.keyboard.active = true;
  test.owner.forwardEscape(event);
  test.keyboard.emit('keydown-ESC', event);
  test.owner.forwardEscape(event);
  expect(() => test.find('conquest-help-body')).toThrow();
  expect(() => test.find('conquest-confirm')).toThrow();
  expect(test.owner.state).toEqual(before);
  test.click('conquest-help');
  const normal = { key: 'Escape', defaultPrevented: false };
  test.owner.forwardEscape(normal);
  expect(test.find('conquest-help-body')).toBeDefined();
  test.keyboard.emit('keydown-ESC', normal);
  expect(() => test.find('conquest-help-body')).toThrow();
  expect(test.write).not.toHaveBeenCalled();
  test.events.emit('shutdown');
  expect(host.removeEventListener.mock.calls).toEqual(host.addEventListener.mock.calls);
  test.owner.forwardEscape({ key: 'Escape', defaultPrevented: true });
  test.scene.create(); closeShipyardModal(test.scene); test.events.emit('shutdown');
  expect(host.removeEventListener.mock.calls).toEqual(host.addEventListener.mock.calls);
  expect(test.keyboard.listenerCount('keydown-ESC')).toBe(0);
});