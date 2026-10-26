import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { expect, it, vi } from 'vitest';
import { GalaxyMapWidget, type GalaxyMapState, type GalaxyMapWorld } from '../src/ui/GalaxyMapWidget';

class Node extends EventEmitter {
  name = ''; text = ''; active = true; visible = true; interactive = false;
  x = 0; y = 0; width = 0; height = 20; children: Node[] = [];
  context = { measureText: (value: string) => ({ width: value.length * 8 }) };
  add(node: Node) { this.children.push(node); return this; }
  setName(name: string) { this.name = name; return this; }
  setText(value: string) { this.text = value; this.width = value.length * 8; return this; }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  setVisible(value: boolean) { this.visible = value; return this; }
  setInteractive() { this.interactive = true; return this; }
  disableInteractive() { this.interactive = false; return this; }
  setPadding() { return this; }
  setAlpha() { return this; }
  setBackgroundColor() { return this; }
  setFixedSize(width: number, height: number) { this.width = width; this.height = height; return this; }
  setMask() { return this; }
  clearMask() { return this; }
  createGeometryMask() { return { destroy: vi.fn() }; }
  clear() { return this; }
  fillStyle() { return this; }
  fillRect() { return this; }
  lineStyle() { return this; }
  lineBetween() { return this; }
  strokeCircle() { return this; }
  destroy() {
    if (!this.active) return;
    this.active = false; this.emit('destroy'); this.children.forEach(child => child.destroy()); this.removeAllListeners();
  }
}

function fixture(worlds: GalaxyMapWorld[] = [
  { id: 'a', name: 'Alpha', x: 0, y: 0, color: 0xffffff, marker: '○' },
  { id: 'b', name: 'Beta', x: 1000, y: 1000, color: 0xffffff, marker: '○' },
  { id: 'c', name: 'Gamma', x: 500, y: 500, color: 0xffffff, marker: '○' }
]) {
  const nodes: Node[] = [], input = new EventEmitter();
  const make = () => { const node = new Node(); nodes.push(node); return node; };
  const scene = { input, add: {
    container: make, graphics: make, rectangle: make, circle: make,
    text: (x: number, y: number, value: string) => make().setPosition(x, y).setText(value)
  } };
  let state: GalaxyMapState = {}, enabled = true;
  const select = vi.fn(), change = vi.fn((next: GalaxyMapState) => { state = next; });
  const parent = make();
  const create = () => new GalaxyMapWidget(scene as unknown as Phaser.Scene, parent as unknown as Phaser.GameObjects.Container, {
    area: { x: 20, y: 80, width: 500, height: 300 }, toolbarY: 20,
    worlds, state, selectedId: 'c', prefix: 'test', worldPrefix: 'world-', enabled: () => enabled, select, change
  });
  const widget = create();
  const find = (name: string) => { const node = nodes.find(item => item.active && item.name === name); if (!node) throw Error(name); return node; };
  const pointer = (x = 270, y = 230, id = 1) => ({ x, y, id, isDown: true, wasTouch: false, leftButtonDown: () => true });
  const down = (p = pointer()) => { find('test-map-surface').emit('pointerdown', p); return p; };
  const click = (name: string) => find(name).emit('pointerdown');
  return { widget, input, nodes, parent, create, find, select, change, pointer, down, click,
    state: () => structuredClone(state), block: () => { enabled = false; } };
}

it('zooms only map coordinates, reaches exact limits and restores the whole map', () => {
  const f = fixture(), width = f.find('test-map-plus').width, labelHeight = f.find('test-map-label-c').height;
  expect(f.find('test-map-minus').interactive).toBe(false);
  for (let i = 0; i < 20; i++) f.click('test-map-plus');
  expect(f.state().viewport?.zoom).toBe(16); expect(f.find('test-map-scale').text).toBe('1600%');
  expect(f.find('test-map-plus').interactive).toBe(false);
  expect(f.find('test-map-plus').width).toBe(width);
  expect(f.find('test-map-label-c').height).toBe(labelHeight);
  f.click('test-map-fit'); expect(f.find('test-map-scale').text).toBe('100%');
  f.widget.destroy();
});

it('ignores zero/nonfinite wheel and input outside the viewport', () => {
  const f = fixture(), before = f.state(), surface = f.find('test-map-surface');
  for (const dy of [0, NaN, Infinity]) surface.emit('wheel', f.pointer(), 0, dy);
  surface.emit('wheel', f.pointer(270, 30), 0, -100);
  expect(f.state()).toEqual(before);
  surface.emit('wheel', f.pointer(), 0, -100);
  expect(f.state().viewport?.zoom).toBe(1.25);
  f.widget.destroy();
});

it.each([false, true])('separates click from mouse/touch drag (touch=%s)', touch => {
  const f = fixture(); f.click('test-map-plus');
  const p = { ...f.pointer(), wasTouch: touch }; f.down(p);
  f.input.emit('pointermove', { ...p, x: p.x + 4 }); f.input.emit('pointerup', p);
  expect(f.select).toHaveBeenLastCalledWith('c'); f.select.mockClear();
  f.down(p); f.input.emit('pointermove', { ...p, y: p.y + 40 }); f.input.emit('pointerup', { ...p, y: p.y + 40 });
  expect(f.select).not.toHaveBeenCalled();
  expect(f.state().viewport?.y).not.toBe(500);
  f.widget.destroy();
});

it('resolves coincident world markers by nearest distance then stable ID', () => {
  const worlds = [
    { id: 'z', name: 'Z', x: 500, y: 500, color: 0xffffff, marker: '○' },
    { id: 'c', name: 'C', x: 500, y: 500, color: 0xffffff, marker: '○' }
  ];
  const f = fixture(worlds); f.click('test-map-plus');
  const marker = f.find('world-c'), p = f.pointer(marker.x, marker.y);
  f.down(p); f.input.emit('pointerup', p);
  expect(f.select).toHaveBeenCalledExactlyOnceWith('c');
  f.widget.destroy();
});

it('hit tests the newly projected position after both zoom and pan', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.click('test-map-plus');
  const original = { x: f.find('world-c').x, y: f.find('world-c').y }, p = f.down();
  f.input.emit('pointermove', { ...p, x: p.x + 20, y: p.y + 30 });
  f.input.emit('pointerup', { ...p, x: p.x + 20, y: p.y + 30 });
  const marker = f.find('world-c');
  expect({ x: marker.x, y: marker.y }).not.toEqual(original);
  const click = f.pointer(marker.x, marker.y);
  f.down(click); f.input.emit('pointerup', click);
  expect(f.select).toHaveBeenCalledExactlyOnceWith('c');
  f.widget.destroy();
});

it.each(['pointerupoutside', 'gameout'])('cancels a gesture on %s', event => {
  const f = fixture(), p = f.down();
  f.input.emit(event, p); f.input.emit('pointerup', p);
  expect(f.select).not.toHaveBeenCalled(); f.widget.destroy();
});

it('ignores another pointer, right-click, blocked state and retained callbacks after destroy', () => {
  const f = fixture(), p = f.down();
  f.input.emit('pointerup', { ...p, id: 2 }); expect(f.select).not.toHaveBeenCalled();
  f.input.emit('pointerup', p); expect(f.select).toHaveBeenCalledOnce(); f.select.mockClear();
  f.down({ ...p, leftButtonDown: () => false }); f.input.emit('pointerup', p); expect(f.select).not.toHaveBeenCalled();
  const callback = f.find('test-map-plus').listeners('pointerdown')[0];
  f.block(); callback(); f.down(p); f.input.emit('pointerup', p);
  expect(f.state().viewport?.zoom).toBe(1); expect(f.select).not.toHaveBeenCalled();
  f.widget.destroy(); callback();
  for (const event of ['pointermove', 'pointerup', 'pointerupoutside', 'gameout']) expect(f.input.listenerCount(event)).toBe(0);
  expect(f.nodes.every(node => node === f.parent || !node.active)).toBe(true);
});

it('preserves navigation across recreation and parent destruction cleans up handlers', () => {
  const f = fixture(); f.click('test-map-plus'); const state = f.state();
  f.widget.destroy(); f.create(); expect(f.state()).toEqual(state);
  expect(f.input.listenerCount('pointermove')).toBe(1);
  f.parent.destroy(); expect(f.input.listenerCount('pointermove')).toBe(0);
});
