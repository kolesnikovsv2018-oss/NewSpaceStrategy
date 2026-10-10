import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

vi.stubGlobal('Phaser', { Scene: class {} });
const { MenuScene } = await import('../src/scenes/MenuScene');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

class Node extends EventEmitter {
  name = '';
  destroyed = false;
  list: Node[] = [];
  constructor(readonly text = '') { super(); }
  add(node: Node) { this.list.push(node); return this; }
  setName(value: string) { this.name = value; return this; }
  setOrigin() { return this; }
  setInteractive() { return this; }
  setStyle() { return this; }
  destroy() {
    this.destroyed = true;
    this.list.forEach(node => node.destroy());
    this.removeAllListeners();
  }
}

function fixture() {
  const nodes: Node[] = [], events = new EventEmitter(), keyboard = new EventEmitter();
  const make = (text = '') => { const node = new Node(text); nodes.push(node); return node; };
  const start = vi.fn(() => events.emit('shutdown'));
  const scene = new MenuScene();
  Object.assign(scene, {
    cameras: { main: { width: 1280, height: 720 } }, events, input: { keyboard }, scene: { start },
    add: { container: () => make(), text: (_x: number, _y: number, text: string) => make(text) }
  });
  scene.create();
  const find = (name: string) => {
    const node = nodes.find(item => item.name === name && !item.destroyed);
    if (!node) throw new Error(`Missing menu item: ${name}`);
    return node;
  };
  const click = (name: string) => find(name).emit('pointerdown');
  return { scene, nodes, events, keyboard, start, find, click };
}

it('has one campaign entry and keeps the sandbox and trials out of the main menu', () => {
  const test = fixture();
  expect(test.nodes.filter(node => node.name && !node.destroyed).map(node => [node.name, node.text])).toEqual([
    ['start-conquest', 'Новая кампания'], ['open-demonstrations', 'Демонстрации']
  ]);
  expect(test.start).not.toHaveBeenCalled();
  test.events.emit('shutdown');
});

it.each([
  ['start-conquest', 'ConquestScene']
])('routes main item %s to %s', (button, target) => {
  const test = fixture();
  test.click(button);
  expect(test.start).toHaveBeenCalledExactlyOnceWith(target);
  expect(test.keyboard.listenerCount('keydown-ESC')).toBe(0);
  expect(test.nodes.every(node => node.destroyed)).toBe(true);
});

it.each([
  ['start-campaign', 'MainScene'], ['start-ship-test', 'ShipTestScene'], ['start-battle-test', 'BattleScene'],
  ['open-shipyard', 'ShipyardScene']
])('preserves demonstration route %s to %s', (button, target) => {
  const test = fixture();
  test.click('open-demonstrations');
  expect(test.start).not.toHaveBeenCalled();
  expect(test.find('demonstrations-title').text).toBe('Демонстрации');
  expect(test.find('start-campaign').text).toBe('Мирная песочница');
  expect(test.find('open-shipyard').text).toBe('Свободная верфь');
  test.click(button);
  expect(test.start).toHaveBeenCalledExactlyOnceWith(target);
});

it.each(['button', 'escape'])('returns from demonstrations via %s without starting a scene', method => {
  const test = fixture();
  test.click('open-demonstrations');
  if (method === 'button') test.click('demonstrations-back');
  else test.keyboard.emit('keydown-ESC');
  expect(test.find('start-conquest').text).toBe('Новая кампания');
  expect(test.start).not.toHaveBeenCalled();
  test.keyboard.emit('keydown-ESC');
  expect(test.start).not.toHaveBeenCalled();
  test.events.emit('shutdown');
});

it('invalidates captured callbacks after navigation, shutdown and reentry', () => {
  const test = fixture();
  const staleCampaign = test.find('start-conquest').listeners('pointerdown')[0];
  test.click('open-demonstrations');
  staleCampaign();
  expect(test.start).not.toHaveBeenCalled();
  const staleSandbox = test.find('start-campaign').listeners('pointerdown')[0];
  test.events.emit('shutdown');
  staleSandbox();
  expect(test.start).not.toHaveBeenCalled();
  expect(test.keyboard.listenerCount('keydown-ESC')).toBe(0);
  test.scene.create();
  expect(test.keyboard.listenerCount('keydown-ESC')).toBe(1);
  expect(test.find('start-conquest').text).toBe('Новая кампания');
  staleSandbox();
  expect(test.start).not.toHaveBeenCalled();
  test.events.emit('shutdown');
  expect(test.nodes.every(node => node.destroyed)).toBe(true);
});
