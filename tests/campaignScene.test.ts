import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import * as domain from '../src/domain/campaignSession';
import * as catalog from '../src/utils/ProductionCatalog';
import { createDesign, createComponent, installComponent } from '../src/domain/shipDesign';
import { getProductionQuote } from '../src/domain/production';

vi.mock('phaser', () => ({ default: { Scene: class {}, Scenes: { Events: { SHUTDOWN: 'shutdown' } } } }));
const { MainScene } = await import('../src/scenes/MainScene');

/** Rendering/input contract harness; no actual Phaser hit testing. */
class Node extends EventEmitter {
  name = ''; text = ''; destroyed = false; interactive = false; list: Node[] = [];
  constructor(text = '') { super(); this.text = text; }
  // Synthetic fixed glyph width exercises truncation; browser checks real fonts.
  get width() { return this.text.length * 12; }
  setText(value: string) { this.text = value; return this; }
  add(node: Node) { this.list.push(node); return this; }
  destroy() { this.destroyed = true; this.list.forEach(node => node.destroy()); this.removeAllListeners(); }
  setName(value: string) { this.name = value; return this; }
  setPadding() { return this; }
  setBackgroundColor() { return this; }
  setInteractive() { this.interactive = true; return this; }
  setLineSpacing() { return this; }
  setWordWrapWidth() { return this; }
  fillStyle() { return this; }
  fillRoundedRect() { return this; }
  lineStyle() { return this; }
  strokeRoundedRect() { return this; }
  lineBetween() { return this; }
  strokeCircle() { return this; }
  fillCircle() { return this; }
}

function fixture() {
  const nodes: Node[] = [];
  const make = (text = '') => { const node = new Node(text); nodes.push(node); return node; };
  const keyboard = new EventEmitter(), events = new EventEmitter();
  const scene = new MainScene();
  const start = vi.fn(() => events.emit('shutdown'));
  Object.assign(scene, {
    cameras: { main: { setBackgroundColor: vi.fn() } }, input: { keyboard }, events,
    scene: { start }, add: { container: () => make(), graphics: () => make(),
      text: (_x: number, _y: number, value: string) => make(value) }
  });
  scene.create();
  const find = (name: string) => {
    const node = nodes.find(item => item.name === name && !item.destroyed);
    if (!node) throw new Error(`Missing ${name}`);
    return node;
  };
  return { scene, nodes, keyboard, events, start, find,
    click: (name: string) => find(name).emit('pointerdown'),
    details: () => find('campaign-system-details').text,
    message: () => find('campaign-message').text };
}

describe('campaign scene and projection renderer', () => {
  it('starts with one panel, six systems and a blue home', () => {
    const f = fixture();
    expect(f.nodes.filter(node => node.name.startsWith('system-'))).toHaveLength(6);
    expect(f.details()).toContain('Синий союз');
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.find('campaign-income').text).toContain('+10 кредитов · +5 минералов');
  });

  it('keeps hidden enemy and barren properties out of rendered details/markers', () => {
    const f = fixture();
    for (const id of ['vega', 'rift']) {
      f.click(`system-${id}`);
      expect(f.details()).toBe('Не разведана\nВладелец: неизвестен\nПригодность: неизвестна');
      expect(f.find(`system-${id}`).text.startsWith('○')).toBe(true);
    }
  });

  it('shows domain rejection and never accepts its state', () => {
    const spy = vi.spyOn(domain, 'executeSessionCommand');
    const f = fixture(); f.click('system-eden'); f.click('campaign-colonize');
    expect(f.message()).toBe('Сначала разведайте систему');
    const before = spy.mock.calls[0][0];
    f.click('campaign-explore');
    expect(spy.mock.calls[1][0]).toBe(before);
    expect(spy.mock.calls[1][1]).toEqual({ kind: 'explore', factionId: 'blue', systemId: 'eden', expectedTurn: 1 });
    expect(f.details()).toContain('Нет колонии');
    f.click('campaign-colonize');
    expect(spy.mock.calls[2][0]).not.toBe(before);
    expect(f.details()).toContain('Синий союз');
  });

  it('clears feedback and hides selected-system knowledge on side switch, without resetting the party', () => {
    const f = fixture(); f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize');
    f.click('campaign-side-switch');
    expect(f.find('campaign-side').text).toBe('Красная лига');
    expect(f.message()).toBe(''); expect(f.details()).toContain('Владелец: неизвестен');
    expect(f.find('system-eden').text.startsWith('○')).toBe(true);
    f.click('campaign-side-switch'); expect(f.details()).toContain('Синий союз');
  });

  it('executes commands as the selected red side and supports return to blue perspective', () => {
    const f = fixture(); f.click('campaign-end-turn'); f.click('campaign-side-switch'); f.click('system-nexus');
    f.click('campaign-explore'); f.click('campaign-colonize');
    expect(f.details()).toContain('Красная лига');
    f.click('campaign-side-switch'); expect(f.details()).toContain('неизвестен');
  });

  it.each(['new', 'menu'] as const)('cancels %s, disables background commands, preserves the party', action => {
    const f = fixture(); f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize');
    f.click(`campaign-${action}`);
    for (const name of ['campaign-explore', 'campaign-colonize', 'campaign-end-turn', 'campaign-side-switch', 'system-vega', 'campaign-new', 'campaign-menu']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    f.click('campaign-cancel'); expect(f.details()).toContain('Синий союз');
    expect(f.start).not.toHaveBeenCalled();
  });

  it('resets the party, side, selection and message after confirmation only', () => {
    const f = fixture(); f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize');
    f.click('campaign-end-turn');
    f.click('campaign-side-switch'); f.click('campaign-new'); f.click('campaign-confirm');
    expect(f.find('campaign-side').text).toBe('Синий союз');
    expect(f.find('campaign-system-name').text).toBe('Сол');
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.find('campaign-income').text).toContain('+10 кредитов · +5 минералов');
    f.click('system-eden'); expect(f.details()).toContain('неизвестен');
    expect(f.nodes.filter(node => node.name === 'campaign-panel' && !node.destroyed)).toHaveLength(1);
  });

  it('ESC cancels pending confirmation; otherwise requests exit, never immediately loses the party', () => {
    const f = fixture(); f.keyboard.emit('keydown-ESC');
    expect(f.message()).toContain('Выйти в меню'); expect(f.start).not.toHaveBeenCalled();
    f.keyboard.emit('keydown-ESC'); expect(f.start).not.toHaveBeenCalled();
    f.click('campaign-new'); f.keyboard.emit('keydown-ESC');
    expect(f.find('campaign-new').interactive).toBe(true);
  });

  it('cleans up on exit and re-entry, with stale callbacks inert', () => {
    const f = fixture(); const stale = f.find('campaign-new').listeners('pointerdown')[0] as () => void;
    f.click('campaign-menu'); const confirm = f.find('campaign-confirm').listeners('pointerdown')[0] as () => void;
    confirm(); stale(); confirm();
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledWith('MenuScene');
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    expect(f.nodes.every(node => node.destroyed)).toBe(true);
    f.scene.create(); stale(); confirm();
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.find('campaign-system-name').text).toBe('Сол');
    f.events.emit('shutdown'); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
  });

  it('replaces old widgets instead of retaining interactive callbacks after every render', () => {
    const f = fixture(); const old = f.find('system-eden');
    const stale = old.listeners('pointerdown')[0] as () => void;
    f.click('system-vega'); stale();
    expect(f.find('campaign-system-name').text).toBe('Вега');
    expect(old.destroyed).toBe(true);
    expect(f.nodes.filter(node => node.name.startsWith('system-') && !node.destroyed)).toHaveLength(6);
  });

  it('shows projected income immediately, pays once and retains the observed side on end turn', () => {
    const spy = vi.spyOn(domain, 'executeSessionCommand');
    const f = fixture(); f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize');
    expect(f.find('campaign-income').text).toContain('+20 кредитов · +10 минералов');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    const oldEnd = f.find('campaign-end-turn').listeners('pointerdown')[0] as () => void;
    oldEnd(); oldEnd();
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[2][1]).toEqual({ kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    expect(f.find('campaign-turn').text).toBe('Ход 2 · Красная лига');
    expect(f.find('campaign-side').text).toBe('Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 120\nМинералы: 60');
    expect(f.find('campaign-turn-hint').text).toContain('Ход другой стороны');
    f.click('campaign-end-turn');
    expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 120\nМинералы: 60');
    f.click('campaign-side-switch');
    expect(f.message()).toBe('');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.find('campaign-income').text).toContain('+10 кредитов · +5 минералов');
    f.click('campaign-end-turn'); oldEnd();
    expect(f.find('campaign-turn').text).toBe('Ход 3 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 110\nМинералы: 55');
    f.click('campaign-side-switch');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 120\nМинералы: 60');
  });

  it.each(['campaign-explore', 'campaign-colonize', 'campaign-end-turn'])('switching observation does not authorize %s for an inactive side', button => {
    const spy = vi.spyOn(domain, 'executeSessionCommand');
    const f = fixture(); f.click('campaign-side-switch'); f.click('system-nexus');
    f.click(button);
    expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(spy.mock.results[0].value).toMatchObject({ ok: false, code: 'NOT_ACTIVE_FACTION' });
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.details()).toContain('неизвестен');
  });

  it('uses the displayed expected turn, rejects a stale command and refreshes without income', () => {
    // Simulate a state advance outside this rendered panel; not the normal synchronous UI path.
    const state = domain.createCampaignSession();
    vi.spyOn(domain, 'createCampaignSession').mockReturnValueOnce(state);
    const spy = vi.spyOn(domain, 'executeSessionCommand');
    const f = fixture(); state.turn = 3;
    f.click('campaign-end-turn');
    expect(spy.mock.calls[0][1]).toEqual({ kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    expect(f.message()).toContain('Номер хода изменился');
    expect(f.find('campaign-turn').text).toBe('Ход 3 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    f.click('campaign-end-turn');
    expect(spy.mock.calls[1][1]).toEqual({ kind: 'endTurn', factionId: 'blue', expectedTurn: 3 });
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 110\nМинералы: 55');
  });

  it.each(['credits', 'minerals'] as const)('shows %s overflow without replacing state or paying partial income', resource => {
    const state = domain.createCampaignSession(); state.treasuries.blue[resource] = domain.MAX_RESOURCE;
    const before = structuredClone(state);
    vi.spyOn(domain, 'createCampaignSession').mockReturnValueOnce(state);
    const spy = vi.spyOn(domain, 'executeSessionCommand');
    const f = fixture(), treasury = f.find('campaign-treasury').text;
    f.click('campaign-end-turn'); f.click('campaign-end-turn');
    expect(f.message()).toContain('Доход превысит предел');
    expect(f.find('campaign-treasury').text).toBe(treasury);
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(spy.mock.calls[1][0]).toBe(state); expect(state).toEqual(before);
  });

  it('shows the terminal turn error without income or side advance', () => {
    const state = domain.createCampaignSession(); state.turn = domain.MAX_TURN;
    vi.spyOn(domain, 'createCampaignSession').mockReturnValueOnce(state);
    const f = fixture(); f.click('campaign-side-switch'); f.click('campaign-end-turn');
    expect(f.message()).toContain('Достигнут предел номера хода');
    expect(f.find('campaign-turn').text).toBe(`Ход ${domain.MAX_TURN} · Красная лига`);
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
  });

  it('does not reveal opponent resources even after exploring its colony', () => {
    const state = domain.createCampaignSession();
    state.galaxy.systems.find(system => system.id === 'vega')!.exploredBy.push('blue');
    state.treasuries.red = { credits: 987654321, minerals: 876543210 };
    vi.spyOn(domain, 'createCampaignSession').mockReturnValueOnce(state);
    const f = fixture(); f.click('system-vega');
    expect(f.details()).toContain('Красная лига');
    const visibleText = () => f.nodes.filter(node => !node.destroyed).map(node => node.text).join('\n');
    expect(visibleText()).not.toContain('987654321'); expect(visibleText()).not.toContain('876543210');
    f.click('campaign-side-switch'); expect(visibleText()).toContain('987654321');
    f.click('campaign-side-switch'); expect(visibleText()).not.toContain('987654321');
  });

  it('makes old end-turn callbacks inert after reset and scene restart, even when turn is again 1', () => {
    const f = fixture(); const oldEnd = f.find('campaign-end-turn').listeners('pointerdown')[0] as () => void;
    f.click('campaign-new'); f.click('campaign-confirm'); oldEnd();
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    f.click('campaign-menu'); f.click('campaign-confirm'); f.scene.create(); oldEnd();
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
  });

  function productionFixture(funded = true) {
    let ship = createDesign('fighter');
    ship = installComponent(ship, 'engine_1', createComponent('engine'));
    const invalid = createDesign('fighter'); invalid.name = 'Неполный проект';
    const choices: catalog.ProductionChoice[] = [
      { design: ship, source: 'Библиотека', quote: getProductionQuote(ship), issue: '' },
      { design: invalid, source: 'Библиотека', issue: 'Нужен двигатель' }
    ];
    const load = vi.spyOn(catalog, 'loadProductionCatalog').mockImplementation(() => ({ choices: structuredClone(choices), notice: 'Снимок библиотеки' }));
    const state = domain.createCampaignSession();
    if (funded) state.treasuries = { blue: { credits: 10000, minerals: 10000 }, red: { credits: 10000, minerals: 10000 } };
    vi.spyOn(domain, 'createCampaignSession').mockReturnValueOnce(state);
    const spy = vi.spyOn(domain, 'executeSessionCommand');
    const f = fixture(); expect(load).not.toHaveBeenCalled(); f.click('campaign-production');
    return { ...f, choices, load, spy, state };
  }

  it('opens production lazily, shows quote and never turns selection into an order', () => {
    const f = productionFixture();
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.find('production-quote').text).toContain('159 кр. / 9 мин.');
    expect(f.find('production-quote').text).toContain('4 своих ходов');
    expect(f.find('production-source').text).toBe('Библиотека · 1/2');
    f.click('production-next'); expect(f.find('production-quote').text).toBe('Нужен двигатель');
    expect(f.find('production-enqueue').interactive).toBe(false); f.click('production-enqueue');
    expect(f.spy).not.toHaveBeenCalled();
    f.click('production-prev'); f.click('production-refresh'); expect(f.load).toHaveBeenCalledTimes(2);
    f.click('campaign-production'); f.click('campaign-production'); expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('captures the quoted design and makes the old enqueue callback inert after payment', () => {
    const f = productionFixture();
    const callback = f.find('production-enqueue').listeners('pointerdown')[0] as () => void;
    const shown = f.find('production-design').text;
    f.choices[0].design.name = 'Changed externally';
    callback(); callback();
    expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toMatchObject({ kind: 'enqueueProduction', expectedTurn: 1, factionId: 'blue', systemId: 'sol' });
    expect(f.find('production-order-1').text).toContain(shown);
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 9841\nМинералы: 9991');
    expect(f.message()).toContain('Заказ оплачен');
  });

  it('shows insufficient resources without adding an order', () => {
    const f = productionFixture(false); f.click('production-enqueue');
    expect(f.message()).toContain('Недостаточно ресурсов');
    expect(f.find('production-queue-title').text).toContain('0/3');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
  });

  it('shows queue-full rejection without partial payment and cancellation frees a slot', () => {
    const f = productionFixture();
    for (let i = 0; i < 3; i++) f.click('production-enqueue');
    const treasury = f.find('campaign-treasury').text;
    f.click('production-enqueue'); expect(f.message()).toContain('Очередь колонии заполнена');
    expect(f.find('campaign-treasury').text).toBe(treasury);
    f.click('production-cancel-2'); expect(f.find('production-queue-title').text).toContain('2/3');
    expect(f.message()).toContain('Возврат');
  });

  it('shows partial progress and prorated refund, cancelling once without advancing time', () => {
    const f = productionFixture(); f.click('production-enqueue'); f.click('campaign-end-turn');
    expect(f.find('production-progress-1').text).toContain('готово 1/4 · осталось 3');
    expect(f.find('production-cancel-1').text).toContain('+119 кр. / +6 мин.');
    f.click('production-cancel-1'); expect(f.message()).toBe('Сейчас ход другой стороны');
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch');
    const cancel = f.find('production-cancel-1').listeners('pointerdown')[0] as () => void;
    cancel(); const calls = f.spy.mock.calls.length; cancel(); expect(f.spy).toHaveBeenCalledTimes(calls);
    expect(f.find('campaign-turn').text).toContain('Ход 3');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 9970\nМинералы: 10002');
    expect(f.find('production-queue-title').text).toContain('0/3');
  });

  it('shows completed records without turning them into deployed ships', () => {
    const f = productionFixture(); f.click('production-enqueue');
    for (let i = 0; i < 7; i++) { f.click('campaign-end-turn'); if (i < 6) f.click('campaign-side-switch'); }
    expect(f.find('production-completed-title').text).toContain('ГОТОВО К РАЗМЕЩЕНИЮ: 1');
    expect(f.find('production-completed').text).toContain('#1');
    expect(f.find('production-queue-title').text).toContain('0/3');
  });

  it('does not show own-colony controls or leak queued designs under another perspective', () => {
    const f = productionFixture(); f.click('production-enqueue');
    f.click('campaign-side-switch');
    expect(f.find('production-unavailable').text).toContain('Чужие очереди недоступны');
    const liveNames = f.nodes.filter(n => !n.destroyed).map(n => n.name);
    expect(liveNames).not.toContain('production-enqueue'); expect(liveNames).not.toContain('production-order-1');
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production');
    f.click('production-enqueue'); expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(f.find('production-queue-title').text).toContain('0/3');
  });

  it('blocks every production control during confirmation, ESC cancels then closes production', () => {
    const f = productionFixture(); f.click('production-enqueue'); f.click('campaign-new');
    for (const name of ['campaign-production', 'production-enqueue', 'production-refresh', 'production-next', 'production-cancel-1']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-queue-title').text).toContain('1/3');
    f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('does not execute callbacks from a closed/refreshed/reset production panel', () => {
    const f = productionFixture();
    const old = f.find('production-enqueue').listeners('pointerdown')[0] as () => void;
    f.click('production-refresh'); old(); expect(f.spy).not.toHaveBeenCalled();
    const next = f.find('production-enqueue').listeners('pointerdown')[0] as () => void;
    f.click('campaign-production'); next(); expect(f.spy).not.toHaveBeenCalled();
    f.click('campaign-new'); f.click('campaign-confirm'); old(); next();
    expect(f.spy).not.toHaveBeenCalled(); expect(f.find('campaign-turn').text).toContain('Ход 1');
    f.click('campaign-production'); expect(f.load).toHaveBeenCalledTimes(3);
    f.click('campaign-menu'); f.click('campaign-confirm'); old();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
  });

  it('sends captured expectedTurn for enqueue and displays stale rejection', () => {
    const f = productionFixture(); f.state.turn = 3;
    f.click('production-enqueue'); expect(f.message()).toContain('Номер хода изменился');
    expect(f.spy.mock.calls[0][1]).toMatchObject({ expectedTurn: 1 });
    expect(f.find('production-queue-title').text).toContain('0/3');
  });

  it('paginates all completed records and clamps the page after changing perspective', () => {
    const f = productionFixture();
    f.state.production.lastOrderId = 3;
    f.state.production.completed = [1, 2, 3].map(id => ({ id, factionId: 'blue', systemId: 'sol', design: f.choices[0].design }));
    f.click('production-refresh'); expect(f.find('production-completed').text).toContain('1/3');
    f.click('production-completed-next'); f.click('production-completed-next');
    expect(f.find('production-completed').text).toContain('3/3'); expect(f.find('production-completed-next').interactive).toBe(false);
    f.click('campaign-side-switch'); f.click('campaign-side-switch');
    expect(f.find('production-completed').text).toContain('1/3');
  });

  it('shows refund overflow without removing the order and rejects a stale cancellation', () => {
    const f = productionFixture(); f.click('production-enqueue');
    const result = f.spy.mock.results[0].value;
    if (!result.ok) throw Error('fixture');
    result.state.treasuries.blue.credits = domain.MAX_RESOURCE;
    f.click('production-refresh'); f.click('production-cancel-1');
    expect(f.message()).toContain('Возврат превысит предел');
    expect(f.find('production-queue-title').text).toContain('1/3');
    result.state.turn = 3; f.click('production-cancel-1');
    expect(f.message()).toContain('Номер хода изменился');
    expect(f.find('production-queue-title').text).toContain('1/3');
  });

  it('fits long names with an ellipsis after the order ID without changing the paid design', () => {
    const f = productionFixture();
    const name = `Ш\n${'Ш'.repeat(78)}`;
    f.choices[0].design.name = name; f.state.production.lastOrderId = 999999998;
    f.click('production-refresh');
    expect(f.find('production-design').text).not.toContain('\n');
    expect(f.find('production-design').text).toMatch(/^Ш Ш.*…$/);
    expect(f.find('production-design').width).toBeLessThanOrEqual(435);
    f.click('production-enqueue');
    const label = f.find('production-order-999999999');
    expect(label.text).toMatch(/^#999999999 Ш Ш.*…$/); expect(label.width).toBeLessThanOrEqual(435);
    expect(f.spy.mock.calls[0][1]).toMatchObject({ design: { name } });
  });

  function deploymentFixture(count = 3) {
    const f = productionFixture();
    f.state.production.lastOrderId = count;
    f.state.production.completed = Array.from({ length: count }, (_, i) => ({ id: i + 1, factionId: 'blue', systemId: 'sol',
      design: { ...structuredClone(f.choices[0].design), name: `Готовый ${i + 1}` } }));
    f.click('production-refresh'); return f;
  }

  it('disables deployment without completed records and shows an empty ship list', () => {
    const f = productionFixture();
    expect(f.find('production-deploy').interactive).toBe(false); f.click('production-deploy');
    expect(f.spy).not.toHaveBeenCalled(); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('Размещённых кораблей пока нет.');
    expect(f.find('production-ships-prev').interactive).toBe(false);
    expect(f.find('production-ships-next').interactive).toBe(false);
    expect(f.nodes.some(n => !n.destroyed && n.name === 'production-deploy')).toBe(false);
  });

  it('deploys the displayed ID exactly once with captured payload and no payment or turn change', () => {
    const f = deploymentFixture(); f.click('production-completed-next');
    const callback = f.find('production-deploy').listeners('pointerdown')[0] as () => void;
    const treasury = f.find('campaign-treasury').text, turn = f.find('campaign-turn').text;
    callback(); callback();
    expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toEqual({ kind: 'deployProduction', factionId: 'blue', systemId: 'sol', expectedTurn: 1, orderId: 2 });
    expect(f.find('campaign-treasury').text).toBe(treasury); expect(f.find('campaign-turn').text).toBe(turn);
    expect(f.message()).toBe('Корабль размещён в колонии.');
    expect(f.find('production-completed').text).toContain('#3 Готовый 3');
    f.click('production-toggle-ships'); expect(f.find('production-ship').text).toBe('1/1 · #2 Готовый 2');
    expect(f.find('production-ships-hint').text).toContain('1/100');
  });

  it('clamps completed pages after removing the last record, and opens the latest deployed ship', () => {
    const f = deploymentFixture(); f.click('production-completed-next'); f.click('production-completed-next');
    f.click('production-deploy'); expect(f.find('production-completed').text).toContain('2/2 · #2');
    f.click('production-deploy'); expect(f.find('production-completed').text).toContain('1/1 · #1');
    f.click('production-deploy'); expect(f.find('production-deploy').interactive).toBe(false);
    f.click('production-toggle-ships'); expect(f.find('production-ship').text).toContain('3/3 · #1');
    f.click('production-ships-prev'); expect(f.find('production-ship').text).toContain('2/3 · #2');
    f.click('production-ships-prev'); expect(f.find('production-ship').text).toContain('1/3 · #3');
    expect(f.find('production-ships-prev').interactive).toBe(false);
    f.click('production-ships-next'); expect(f.find('production-ship').text).toContain('2/3');
    f.click('production-toggle-ships'); expect(f.find('production-completed').text).toBe('Готовых записей пока нет.');
  });

  it('rejects deployment by an inactive observer without consuming ready records', () => {
    const f = deploymentFixture(1); f.click('campaign-end-turn'); f.click('production-deploy');
    expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(f.find('production-completed').text).toContain('#1');
    f.click('production-toggle-ships'); expect(f.find('production-ships-title').text).toContain(': 0');
  });

  it('shows SHIP_LIMIT without removing completed and paginates 100 existing ships', () => {
    const f = deploymentFixture(1); f.state.production.lastOrderId = 101;
    f.state.ships = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(f.state.production.completed[0]), id: i + 2 }));
    f.click('production-refresh'); expect(f.find('production-deploy-hint').text).toContain('100/100');
    f.click('production-deploy'); expect(f.message()).toBe('Достигнут предел стратегических кораблей стороны');
    expect(f.find('production-completed').text).toContain('#1');
    f.click('production-toggle-ships');
    for (let i = 1; i < 100; i++) f.click('production-ships-next');
    expect(f.find('production-ship').text).toContain('100/100 · #101');
    expect(f.find('production-ships-next').interactive).toBe(false);
  });

  it('shows stale turn or vanished completed rejection instead of deploying a different record', () => {
    const f = deploymentFixture(); f.state.turn = 3; f.click('production-deploy');
    expect(f.message()).toContain('Номер хода изменился');
    f.state.production.completed.shift(); f.click('production-deploy');
    expect(f.message()).toBe('Готовый проект не найден в колонии');
    expect(f.find('production-completed').text).toContain('#2');
    expect(f.find('production-toggle-ships').text).toBe('Корабли: 0');
  });

  it('hides enemy records and resets ship pages on perspective or colony change', () => {
    const f = deploymentFixture(3);
    f.state.ships = f.state.production.completed.splice(0);
    const eden = f.state.galaxy.systems.find(s => s.id === 'eden')!; eden.ownerId = 'blue'; eden.exploredBy = ['blue'];
    f.state.production.lastOrderId = 4;
    f.state.ships.push({ ...structuredClone(f.state.ships[0]), id: 4, systemId: 'eden', design: { ...f.choices[0].design, name: 'Эдемский' } });
    f.click('production-refresh'); f.click('production-toggle-ships'); f.click('production-ships-next');
    expect(f.find('production-ship').text).toContain('2/3');
    f.click('campaign-side-switch');
    expect(f.nodes.filter(n => !n.destroyed).some(n => ['production-ship', 'production-deploy', 'production-toggle-ships'].includes(n.name))).toBe(false);
    expect(f.nodes.filter(n => !n.destroyed).some(n => n.text.includes('Готовый'))).toBe(false);
    f.click('campaign-side-switch'); f.click('production-toggle-ships'); expect(f.find('production-ship').text).toContain('1/3');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('1/1 · #4 Эдемский');
    expect(f.find('production-ships-hint').text).toContain('4/100');
  });

  it('deploys a red project through the UI of its own colony', () => {
    const f = deploymentFixture(1); f.state.production.completed[0].factionId = 'red'; f.state.production.completed[0].systemId = 'vega';
    f.click('campaign-end-turn'); f.click('campaign-side-switch');
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-deploy');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'deployProduction', factionId: 'red', expectedTurn: 2, systemId: 'vega', orderId: 1 });
    f.click('production-toggle-ships'); expect(f.find('production-ship').text).toContain('#1');
  });

  it('blocks deployment/navigation while pending and ESC cancels without losing ready or ships', () => {
    const f = deploymentFixture(); f.click('production-deploy'); f.click('campaign-new');
    for (const name of ['production-deploy', 'production-toggle-ships', 'production-completed-next']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-completed').text).toContain('1/2');
    f.click('production-toggle-ships'); f.click('campaign-menu');
    expect(f.find('production-toggle-ships').interactive).toBe(false);
    expect(f.find('production-ships-prev').interactive).toBe(false);
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-ship').text).toContain('#1');
    f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
  });

  it.each(['production-completed-next', 'production-refresh', 'production-toggle-ships', 'campaign-side-switch', 'campaign-production'])('makes old deploy inert after %s', action => {
    const f = deploymentFixture(); const old = f.find('production-deploy').listeners('pointerdown')[0] as () => void;
    f.click(action); old(); expect(f.spy).not.toHaveBeenCalled();
  });

  it('clears ships/pages on reset and destroys deployment callbacks and child roots on exit/reentry', () => {
    const f = deploymentFixture(); const old = f.find('production-deploy').listeners('pointerdown')[0] as () => void;
    f.click('production-deploy'); f.click('production-toggle-ships');
    f.click('campaign-new'); f.click('campaign-confirm'); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    f.click('campaign-production'); expect(f.find('production-deploy').interactive).toBe(false);
    f.click('production-toggle-ships'); expect(f.find('production-ships-title').text).toContain(': 0');
    f.click('campaign-menu'); f.click('campaign-confirm'); old();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    f.scene.create(); f.click('campaign-production');
    expect(f.find('production-completed').text).toBe('Готовых записей пока нет.');
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'production-panel')).toHaveLength(1);
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
  });

  it('fits long ready and deployed names without changing the deployed design', () => {
    const f = deploymentFixture(1); f.state.production.completed[0].design.name = 'Ш'.repeat(80);
    f.state.production.lastOrderId = 999999999; f.state.production.completed[0].id = 999999999;
    f.click('production-refresh'); expect(f.find('production-completed').width).toBeLessThanOrEqual(570);
    expect(f.find('production-completed').text).toMatch(/#999999999 Ш.*…$/);
    f.click('production-deploy'); f.click('production-toggle-ships');
    expect(f.find('production-ship').width).toBeLessThanOrEqual(745);
    expect(f.find('production-ship').text).toMatch(/#999999999 Ш.*…$/);
    expect(f.spy.mock.results[0].value.state.ships[0].design.name).toBe('Ш'.repeat(80));
  });

  it('excludes an in-transit ship from both colony lists but counts it in the faction cap', () => {
    const f = deploymentFixture(1), eden = f.state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = 'blue'; eden.exploredBy = ['blue'];
    f.state.ships = [{ ...f.state.production.completed[0], transit: { destinationId: 'eden', remainingTurns: 1 } }];
    f.state.production.completed = [];
    f.click('production-refresh'); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('Размещённых кораблей пока нет.');
    expect(f.find('production-ships-hint').text).toContain('1/100');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('Размещённых кораблей пока нет.');
    f.click('campaign-end-turn'); expect(f.find('production-ship').text).toContain('#1 Готовый 1');
  });
});
