import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createConquest, type Conquest } from '../src/domain/conquest';
import { decodeConquestSave } from '../src/utils/ConquestSaveManager';
import { CampaignSaveManager } from '../src/utils/CampaignSaveManager';
import * as ai from '../src/domain/conquestAi';

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
  fillCircle() { return this; }
  lineStyle() { return this; }
  lineBetween() { return this; }
}

function fixture(storage = new Map<string, string>()) {
  const nodes: Node[] = [], events = new EventEmitter(), keyboard = new EventEmitter();
  const make = (value = '') => { const node = new Node(value); nodes.push(node); return node; };
  const read = vi.fn((key: string) => storage.get(key) ?? null), write = vi.fn((key: string, value: string) => { storage.set(key, value); });
  vi.stubGlobal('localStorage', { getItem: read, setItem: write });
  const tasks: { callback: () => void; remove: ReturnType<typeof vi.fn> }[] = [];
  const scene = new ConquestScene();
  const owner = scene as unknown as { state: Conquest; phase: string; replace(state: Conquest): void; render(): void };
  Object.assign(scene, { cameras: { main: { width: 1280, height: 720 } }, input: { keyboard }, events,
    scene: { start: () => events.emit('shutdown') }, time: { delayedCall: (_delay: number, callback: () => void) => {
      const task = { callback, remove: vi.fn() }; tasks.push(task); return task;
    } }, add: { container: () => make(), graphics: () => make(), circle: () => make(), rectangle: () => make(),
      text: (_x: number, _y: number, value: string) => make(value) } });
  scene.create();
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
  test.click('conquest-save');
  expect(test.tasks[0].remove).toHaveBeenCalledTimes(1);
  expect(test.write).not.toHaveBeenCalled();
  test.click('conquest-cancel'); test.tasks[0].callback();
  expect(test.owner.state).toEqual(before);
  expect(test.owner.phase).toBe('paused');
  expect(test.tasks).toHaveLength(1);
});

it('saves a full version4 snapshot and loads AI-red paused in a fresh scene', () => {
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