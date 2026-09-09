import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import { createComponent, createDesign, designSchema, type ShipDesign } from '../src/domain/shipDesign';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { ShipBuilderPanel } from '../src/ui/ShipBuilderPanel';
import { isShipyardModalOpen } from '../src/ui/ShipyardModal';

vi.mock('../src/ui/ShipBlueprint', () => ({ drawBlueprint: vi.fn() }));
vi.mock('phaser', () => ({ default: { Scene: class {}, Scenes: { Events: { SHUTDOWN: 'shutdown' } } } }));
const { ShipyardScene } = await import('../src/scenes/ShipyardScene');

/** Contract harness only; actual pointer hit testing and rendering are checked in Phaser separately. */
class Node extends EventEmitter {
  name = '';
  text = '';
  list: Node[] = [];
  destroyed = false;
  constructor(value = '') { super(); this.text = value; }
  add(nodes: Node | Node[]) { this.list.push(...(Array.isArray(nodes) ? nodes : [nodes])); return this; }
  removeAll(destroy = false) { if (destroy) this.list.forEach(node => node.destroy()); this.list = []; return this; }
  destroy() { this.destroyed = true; this.removeAll(true); this.removeAllListeners(); }
  setName(value: string) { this.name = value; return this; }
  setPadding() { return this; }
  setBackgroundColor() { return this; }
  setInteractive() { return this; }
  setFixedSize() { return this; }
  setScale() { return this; }
  setDepth() { return this; }
  setWordWrapWidth() { return this; }
  setLineSpacing() { return this; }
  setOrigin() { return this; }
  fillStyle() { return this; }
  fillRoundedRect() { return this; }
  lineStyle() { return this; }
  strokeRoundedRect() { return this; }
}

function harness() {
  const nodes: Node[] = [];
  const make = (value = '') => { const node = new Node(value); nodes.push(node); return node; };
  const events = new EventEmitter(), keyboard = new EventEmitter();
  const fake = {
    cameras: { main: { width: 1280, height: 720, setBackgroundColor: vi.fn() } },
    add: { container: () => make(), text: (_x: number, _y: number, value: string) => make(value),
      graphics: () => make(), rectangle: () => make() },
    input: { keyboard }, events, sys: { settings: { data: {} }, isActive: () => true },
    scene: { start: vi.fn() }
  };
  const find = (name: string) => {
    const node = nodes.find(item => item.name === name && !item.destroyed);
    if (!node) throw new Error(`Missing live widget: ${name}`);
    return node;
  };
  return { fake, scene: fake as unknown as Phaser.Scene, find,
    click: (name: string) => find(name).emit('pointerdown'), keyboard, events, nodes };
}

function repository() {
  const data = new Map<string, string>();
  const store: StoragePort = { getItem: key => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
  return { repo: new ShipDesignManager(store), store, data };
}

function panelFixture(saved = false) {
  const h = harness(), r = repository();
  const initial = saved ? r.repo.saveDesign(createDesign('corvette', true)) : createDesign('corvette', true);
  const panel = new ShipBuilderPanel(h.scene, 0, 0, r.repo, initial, saved ? initial : undefined);
  return { ...h, ...r, panel, initial };
}

describe('shipyard draft replacement', () => {
  it.each(['new-design', 'starter-design', 'copy-design', 'preset', 'load'] as const)('cancels %s without changing draft or storage', action => {
    const f = panelFixture();
    f.repo.saveDesign(createDesign('frigate'));
    const before = f.panel.getConfiguration(), stored = f.repo.exportJSON();
    if (action === 'preset') { f.click('combat-presets'); f.click('choice-0'); }
    else if (action === 'load') { f.click('load-design'); f.click('choice-0'); }
    else f.click(action);
    expect(isShipyardModalOpen(f.scene)).toBe(true);
    expect(f.panel.getConfiguration()).toEqual(before);
    f.click('discard-cancel');
    expect(f.panel.getConfiguration()).toEqual(before);
    expect(f.repo.exportJSON()).toBe(stored);
    expect(f.panel.hasUnsavedChanges()).toBe(true);
    expect(f.find('design-save-status').text).toContain('Не сохранён');
  });

  it.each(['new-design', 'starter-design', 'copy-design', 'preset'] as const)('confirms %s exactly once as a new unsaved design', action => {
    const f = panelFixture();
    const old = f.panel.getConfiguration();
    if (action === 'preset') { f.click('combat-presets'); f.click('choice-6'); } else f.click(action);
    const confirm = f.find('discard-confirm').listeners('pointerdown')[0] as () => void;
    confirm();
    const next = f.panel.getConfiguration();
    confirm();
    expect(f.panel.getConfiguration()).toEqual(next);
    expect(next.id).not.toBe(old.id);
    expect(f.panel.hasUnsavedChanges()).toBe(true);
    expect(f.data.size).toBe(0);
    if (action === 'new-design') expect(next.slots.every(slot => !slot.component)).toBe(true);
    if (action === 'preset') expect(next.slots.find(slot => slot.id === 'service_1')?.component?.kind).toBe('mining');
    if (action === 'copy-design') expect(next.slots).toEqual(old.slots);
  });

  it('loads an explicitly selected saved design only after confirmation and marks it clean', () => {
    const f = panelFixture();
    const saved = f.repo.saveDesign(createDesign('frigate'));
    const writes = vi.mocked(f.store.setItem).mock.calls.length;
    f.click('load-design'); f.click('choice-0'); f.click('discard-confirm');
    expect(f.panel.getConfiguration()).toEqual(saved);
    expect(f.panel.hasUnsavedChanges()).toBe(false);
    expect(f.find('design-save-status').text).toBe('✓ Сохранён');
    expect(f.store.setItem).toHaveBeenCalledTimes(writes);
    f.click('new-design');
    expect(isShipyardModalOpen(f.scene)).toBe(false);
    expect(f.panel.hasUnsavedChanges()).toBe(true);
  });

  it('does not prompt when cancelling a picker before choosing anything', () => {
    const f = panelFixture();
    const before = f.panel.getConfiguration();
    f.click('combat-presets'); f.click('close-choice');
    f.click('load-design'); f.keyboard.emit('keydown-ESC');
    expect(f.panel.getConfiguration()).toEqual(before);
    expect(isShipyardModalOpen(f.scene)).toBe(false);
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
  });

  it('tracks edits, reversions, invalid installs and separate catalogue changes', () => {
    const f = panelFixture(true);
    expect(f.panel.hasUnsavedChanges()).toBe(false);
    f.panel.setAvailableComponents([createComponent('beam')]);
    expect(f.panel.hasUnsavedChanges()).toBe(false);
    expect(f.panel.installEquipment('engine_1', createComponent('beam'))).toBe(false);
    expect(f.panel.hasUnsavedChanges()).toBe(false);
    f.panel.installEquipment('beam_2', createComponent('beam'));
    expect(f.panel.hasUnsavedChanges()).toBe(true);
    f.panel.installEquipment('beam_2', null);
    expect(f.panel.hasUnsavedChanges()).toBe(false);
    f.panel.changeHull('frigate');
    expect(f.panel.hasUnsavedChanges()).toBe(true);
    f.panel.changeHull('corvette');
    expect(f.panel.hasUnsavedChanges()).toBe(false);
    vi.stubGlobal('prompt', () => 'Renamed');
    f.click('rename-design');
    expect(f.panel.hasUnsavedChanges()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('only clears dirty state after successful save, not after quota failure', () => {
    const f = panelFixture();
    const before = f.panel.getConfiguration();
    vi.mocked(f.store.setItem).mockImplementationOnce(() => { throw new Error('Quota exceeded'); });
    expect(f.panel.save()).toBe(false);
    expect(f.panel.getConfiguration()).toEqual(before);
    expect(f.panel.hasUnsavedChanges()).toBe(true);
    f.click('new-design'); f.click('discard-cancel');
    expect(f.panel.save()).toBe(true);
    expect(f.panel.hasUnsavedChanges()).toBe(false);
    f.panel.getConfiguration().name = 'Detached';
    expect(f.panel.hasUnsavedChanges()).toBe(false);
    f.click('new-design');
    expect(isShipyardModalOpen(f.scene)).toBe(false);
  });

  it('keeps a single pending action and makes cancelled/destroyed callbacks inert', () => {
    const f = panelFixture(), first = vi.fn(), second = vi.fn();
    f.panel.requestDiscard(first);
    const stale = f.find('discard-confirm').listeners('pointerdown')[0] as () => void;
    f.panel.requestDiscard(second);
    expect(f.nodes.filter(node => node.name === 'shipyard-modal' && !node.destroyed)).toHaveLength(1);
    f.keyboard.emit('keydown-ESC'); stale();
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
    f.panel.requestDiscard(first);
    const afterShutdown = f.find('discard-confirm').listeners('pointerdown')[0] as () => void;
    f.events.emit('shutdown'); afterShutdown(); f.panel.destroy();
    expect(first).not.toHaveBeenCalled();
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    expect(f.events.listenerCount('shutdown')).toBe(0);
    expect(isShipyardModalOpen(f.scene)).toBe(false);
  });

  it('does not replace the draft if reading the library fails', () => {
    const f = panelFixture();
    const before = f.panel.getConfiguration();
    vi.spyOn(f.store, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    f.click('load-design');
    expect(f.panel.getConfiguration()).toEqual(before);
    expect(f.panel.hasUnsavedChanges()).toBe(true);
    expect(isShipyardModalOpen(f.scene)).toBe(false);
  });
});

function yardFixture(r: ReturnType<typeof repository>, design?: ShipDesign) {
  const h = harness();
  const yard = new ShipyardScene();
  Object.assign(yard, h.fake, { repository: r.repo });
  yard.init({ design }); yard.create();
  const panel = (yard as unknown as { shipPanel: ShipBuilderPanel }).shipPanel;
  return { ...h, yard, panel };
}

describe('shipyard navigation and trial return', () => {
  it('one Escape cancels a modal, a second requests leaving, neither discards automatically', () => {
    const f = yardFixture(repository());
    f.click('new-design'); f.keyboard.emit('keydown-ESC');
    expect(f.fake.scene.start).not.toHaveBeenCalled();
    expect(isShipyardModalOpen(f.yard)).toBe(false);
    f.keyboard.emit('keydown-ESC');
    expect(isShipyardModalOpen(f.yard)).toBe(true);
    f.click('discard-cancel');
    expect(f.fake.scene.start).not.toHaveBeenCalled();
    f.click('yard-menu'); f.click('discard-confirm');
    expect(f.fake.scene.start).toHaveBeenCalledExactlyOnceWith('MenuScene');
  });

  it.each(['flight', 'battle'] as const)('retains unsaved content and dirty status through %s, without writing storage', mode => {
    const r = repository();
    const saved = r.repo.saveDesign(createDesign('corvette', true));
    const f = yardFixture(r);
    f.panel.installEquipment('beam_2', createComponent('beam'));
    const draft = f.panel.getConfiguration(), stored = r.repo.exportJSON();
    f.click(`trial-${mode}`);
    expect(f.fake.scene.start).toHaveBeenCalledExactlyOnceWith(mode === 'flight' ? 'ShipTestScene' : 'BattleScene', { design: draft });
    expect(isShipyardModalOpen(f.yard)).toBe(false);
    const returned = yardFixture(r, designSchema.parse(draft));
    expect(returned.panel.getConfiguration()).toEqual(draft);
    expect(returned.panel.hasUnsavedChanges()).toBe(true);
    returned.click('new-design'); returned.click('discard-cancel');
    expect(r.repo.exportJSON()).toBe(stored);
    const cleanReturn = yardFixture(r, saved);
    expect(cleanReturn.panel.hasUnsavedChanges()).toBe(false);
  });

  it('blocks trial launches while a modal is open and cleans handlers on shutdown/re-entry', () => {
    const f = yardFixture(repository());
    f.click('combat-presets');
    f.click('trial-flight'); f.click('trial-battle'); f.click('yard-menu');
    expect(f.fake.scene.start).not.toHaveBeenCalled();
    f.events.emit('shutdown');
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    expect(isShipyardModalOpen(f.yard)).toBe(false);
    f.yard.init(); f.yard.create();
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    f.events.emit('shutdown');
  });
});