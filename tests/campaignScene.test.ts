import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import * as domain from '../src/domain/campaignSession';
import * as catalog from '../src/utils/ProductionCatalog';
import { createDesign, createComponent, installComponent } from '../src/domain/shipDesign';
import { getProductionQuote } from '../src/domain/production';
import { createCombatDesign } from '../src/domain/combatPresets';
import { ShipDesignManager } from '../src/utils/ShipDesignManager';

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
  it.each(['preset', 'library'] as const)('accepts both factions through the full paid colony-to-colony cycle using %s', source => {
    // Real catalogue/repository/domain; only renderer/input and the storage port are substitutes.
    const saved = createCombatDesign('fighter'); saved.name = 'Приёмочный проект';
    const raw = JSON.stringify({ schemaVersion: 2, designs: [saved], components: [] });
    const storage = { getItem: vi.fn((key: string) => source === 'library' && key === ShipDesignManager.STORAGE_KEY ? raw : null), setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    try {
      const spy = vi.spyOn(domain, 'executeSessionCommand'), f = fixture();
      const current = (): domain.CampaignSession => {
        for (let i = spy.mock.results.length - 1; i >= 0; i--) {
          const result = spy.mock.results[i].value as domain.SessionResult;
          if (result.ok) return result.state;
        }
        throw Error('No successful session command');
      };
      const click = (name: string, failure?: domain.SessionErrorCode) => {
        const calls = spy.mock.calls.length;
        const before = calls ? structuredClone(current()) : undefined;
        f.click(name);
        if (spy.mock.calls.length === calls) { expect(failure).toBeUndefined(); return; }
        expect(spy.mock.calls.length).toBe(calls + 1);
        const result = spy.mock.results[calls].value as domain.SessionResult;
        if (before) expect(spy.mock.calls[calls][0]).toEqual(before);
        if (failure) {
          expect(result).toMatchObject({ ok: false, code: failure }); expect(current()).toEqual(before);
        } else {
          expect(result.ok).toBe(true); expect(domain.campaignSessionSchema.safeParse(current()).success).toBe(true);
        }
      };
      const end = () => { click('campaign-end-turn'); click('campaign-side-switch'); };
      const choose = () => { if (source === 'library') for (let i = 0; i < 7; i++) click('production-next'); };
      // Both colonies are founded by real commands, no preloaded money, ships, ownership or progress.
      for (const [home, target] of [['sol', 'eden'], ['vega', 'nexus']] as const) {
        click(`system-${target}`); click('campaign-explore'); click('campaign-colonize');
        expect(f.find('campaign-income').text).toContain('+20 кредитов · +10 минералов');
        click(`system-${home}`); click('campaign-production'); choose();
        expect(f.find('production-quote').text).toContain('185 кр. / 11 мин.');
        click('production-enqueue', 'INSUFFICIENT_RESOURCES');
        click('campaign-production'); end();
      }
      for (let i = 0; i < 8; i++) end();
      expect(current().turn).toBe(11);
      expect(current().treasuries).toEqual({ blue: { credits: 200, minerals: 100 }, red: { credits: 200, minerals: 100 } });
      const snapshots = [];
      for (const [faction, home, id] of [['blue', 'sol', 1], ['red', 'vega', 2]] as const) {
        click(`system-${home}`); click('campaign-production'); choose(); click('production-enqueue');
        expect(current().treasuries[faction]).toEqual({ credits: 15, minerals: 89 });
        const order = current().production.orders.find(item => item.id === id)!;
        expect(order).toMatchObject({ factionId: faction, systemId: home, remainingTurns: 4 });
        snapshots.push(structuredClone(order.design));
        if (source === 'library') expect(order.design).toEqual(saved);
        const paid = structuredClone(order.design);
        click('production-refresh'); expect(current().production.orders.find(item => item.id === id)!.design).toEqual(paid);
        click('campaign-production'); end();
      }
      // At each boundary only the ending faction's head advances; IDs and paid snapshots persist.
      for (let i = 0; i < 6; i++) {
        const faction = current().turn % 2 ? 'blue' : 'red';
        const enemy = faction === 'blue' ? 'red' : 'blue';
        const enemyBefore = domain.getCampaignSessionView(current(), enemy).production;
        end(); expect(domain.getCampaignSessionView(current(), enemy).production).toEqual(enemyBefore);
      }
      expect(current().turn).toBe(19); expect(current().production.orders).toEqual([]);
      expect(current().production.completed.map(item => item.id)).toEqual([1, 2]);
      for (const [faction, home, target, id] of [['blue', 'sol', 'eden', 1], ['red', 'vega', 'nexus', 2]] as const) {
        click(`system-${home}`); click('campaign-production');
        expect(f.find('production-completed').text).toContain(`#${id}`);
        const turn = current().turn, treasury = structuredClone(current().treasuries);
        click('production-deploy'); click('production-travel');
        expect(f.find('travel-ship').text).toContain(`#${id}`);
        const oldSend = f.find('travel-send').listeners('pointerdown')[0] as () => void;
        click('travel-send'); const count = spy.mock.calls.length; oldSend(); expect(spy).toHaveBeenCalledTimes(count);
        expect(current().turn).toBe(turn); expect(current().treasuries).toEqual(treasury);
        expect(current().ships.find(ship => ship.id === id)).toEqual({ id, factionId: faction, systemId: home,
          fuel: 2, design: snapshots[id - 1], transit: { destinationId: target, remainingTurns: 1 } });
        expect(f.find('travel-send').interactive).toBe(false);
        click('campaign-production'); click(`system-${target}`); click('campaign-production'); click('production-travel');
        expect(f.find('travel-ship').text).toBe('Нет кораблей для отправки.');
        click('campaign-end-turn');
        expect(f.find('travel-ship').text).toContain(`#${id}`); expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
        expect(current().ships.find(ship => ship.id === id)).toEqual({ id, factionId: faction, systemId: target, fuel: 2, design: snapshots[id - 1] });
        click('travel-send', 'NOT_ACTIVE_FACTION');
        click('campaign-production'); click('campaign-side-switch');
      }
      expect(current().turn).toBe(21); expect(current().production).toEqual({ lastOrderId: 2, orders: [], completed: [] });
      expect(current().treasuries).toEqual({ blue: { credits: 115, minerals: 139 }, red: { credits: 115, minerals: 139 } });
      for (const faction of ['blue', 'red'] as const) {
        const view = domain.getCampaignSessionView(current(), faction);
        expect(view.ships).toHaveLength(1); expect(view.ships[0].factionId).toBe(faction);
        expect(view.ships[0]).not.toHaveProperty('transit');
      }
      expect(storage.getItem).toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem(ShipDesignManager.STORAGE_KEY)).toBe(source === 'library' ? raw : null);
      click('campaign-new'); click('campaign-confirm'); click('campaign-production'); click('production-travel');
      expect(f.find('travel-count').text).toContain('0/100'); expect(f.find('campaign-turn').text).toContain('Ход 1');
      click('campaign-menu'); click('campaign-confirm');
      expect(f.nodes.every(node => node.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

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
    f.state.ships = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(f.state.production.completed[0]), fuel: 3, id: i + 2 }));
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
    f.state.ships = f.state.production.completed.splice(0).map(record => ({ ...record, fuel: 3 }));
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
    f.state.ships = [{ ...f.state.production.completed[0], fuel: 2, transit: { destinationId: 'eden', remainingTurns: 1 } }];
    f.state.production.completed = [];
    f.click('production-refresh'); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('Размещённых кораблей пока нет.');
    expect(f.find('production-ships-hint').text).toContain('1/100');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('Размещённых кораблей пока нет.');
    f.click('campaign-end-turn'); expect(f.find('production-ship').text).toContain('#1 Готовый 1');
  });

  function travelFixture(count = 3) {
    const f = deploymentFixture(count);
    f.state.ships = f.state.production.completed.splice(0).map(record => ({ ...record, fuel: 3 }));
    const eden = f.state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = 'blue'; eden.exploredBy = ['blue'];
    f.click('production-travel'); return f;
  }

  it('opens travel without reading the catalog again or changing the state', () => {
    const f = travelFixture(), before = structuredClone(f.state), reads = f.load.mock.calls.length;
    expect(f.find('travel-destination').text).toBe('Цель 1/1: Эдем');
    expect(f.find('travel-ships-title').text).toContain(': 3');
    expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    expect(f.find('travel-count').text).toContain('3/100');
    f.click('production-travel'); f.click('production-travel');
    expect(f.load).toHaveBeenCalledTimes(reads); expect(f.spy).not.toHaveBeenCalled(); expect(f.state).toEqual(before);
  });

  it('shows empty-tank refusal without changing ships, and labels the colony refuel boundary', () => {
    const f = travelFixture(1); f.state.ships[0].fuel = 0;
    const before = structuredClone(f.state);
    expect(f.find('travel-rule').text).toContain('Расход: 1 топливо');
    expect(f.find('travel-limit').text).toContain('только в своей колонии');
    f.click('travel-send');
    expect(f.message()).toContain('Недостаточно стратегического топлива');
    expect(f.state).toEqual(before); expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    expect(f.find('travel-ship').text).toContain('#1');
  });

  function refuelFixture(count = 3) {
    const f = travelFixture(count);
    f.state.ships.forEach((ship, i) => { ship.fuel = i % 3; });
    f.click('production-travel'); f.click('production-travel');
    return f;
  }

  function fleetFixture(count = 4) {
    const f = travelFixture(count);
    f.click('production-fleets');
    const selectTwo = () => { f.click('fleet-select'); f.click('fleet-candidate-next'); f.click('fleet-select'); };
    return { ...f, selectTwo };
  }

  function fleetTravelFixture(count = 4) {
    const f = fleetFixture(count);
    for (let i = 0; i < Math.min(20, Math.floor(count / 2)); i++) {
      f.click('fleet-candidate-prev'); f.selectTwo(); f.click('fleet-create');
    }
    f.click('fleet-travel');
    const current = () => (f.scene as unknown as { campaign: domain.CampaignSession }).campaign;
    return { ...f, current };
  }

  it('opens exclusive fleet routes, preserves selected group and captures one send without rereading catalog', () => {
    const f = fleetTravelFixture(), before = structuredClone(f.current()), reads = f.load.mock.calls.length;
    expect(f.find('fleet-travel-current').text).toContain('2/2 · Группа #2');
    expect(f.find('fleet-travel-destination').text).toBe('Цель 1/1: Эдем');
    expect(f.find('fleet-travel-fuel').text).toContain('3/3');
    expect(f.nodes.some(n => !n.destroyed && ['fleet-create', 'fleet-disband', 'travel-panel', 'production-enqueue'].includes(n.name))).toBe(false);
    const old = f.find('fleet-travel-send').listeners('pointerdown')[0] as () => void;
    const calls = f.spy.mock.calls.length; old(); old();
    expect(f.spy).toHaveBeenCalledTimes(calls + 1);
    expect(f.spy.mock.calls[calls][1]).toEqual({ kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 2, destinationId: 'eden' });
    expect(f.current().treasuries).toEqual(before.treasuries); expect(f.current().turn).toBe(before.turn);
    expect(f.current().ships.map(s => s.design)).toEqual(before.ships.map(s => s.design));
    expect(f.current().ships.map(s => s.fuel)).toEqual([3, 3, 2, 2]);
    expect(f.find('fleet-travel-current').text).toContain('1/1 · Группа #1');
    expect(f.find('fleet-travel-transit').text).toContain('1/1 · Группа #2');
    expect(f.find('fleet-travel-route').text).toContain('Сол → Эдем');
    expect(f.find('fleet-travel-count').text).toContain('2/20');
    expect(f.load).toHaveBeenCalledTimes(reads);
  });

  it('pages all own trips and clamps them on arrival, even when viewing the destination', () => {
    const f = fleetTravelFixture(6);
    f.click('fleet-travel-prev'); f.click('fleet-travel-send');
    f.click('fleet-travel-send'); f.click('fleet-travel-send');
    expect(f.find('fleet-travel-transit').text).toContain('1/3 · Группа #1');
    f.click('fleet-travel-transit-next'); expect(f.find('fleet-travel-transit').text).toContain('Группа #2');
    f.click('fleet-travel-transit-next'); expect(f.find('fleet-travel-transit').text).toContain('3/3 · Группа #3');
    expect(f.find('fleet-travel-send').interactive).toBe(false);
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    expect(f.find('fleet-travel-title').text).toContain(': 0'); expect(f.find('fleet-travel-transit-title').text).toContain(': 3');
    f.click('campaign-end-turn');
    expect(f.find('fleet-travel-transit').text).toBe('Групп в пути нет.');
    expect(f.find('fleet-travel-current').text).toContain('1/3 · Группа #1');
    expect(f.find('fleet-travel-fuel').text).toContain('2/3');
    expect(f.find('fleet-travel-destination').text).toBe('Цель 1/1: Сол');
    const before = structuredClone(f.current()); f.click('fleet-travel-send');
    expect(f.message()).toBe('Сейчас ход другой стороны'); expect(f.current()).toEqual(before);
    f.click('fleet-travel'); expect(f.find('fleet-member-fuel').text).toContain('2/3');
  });

  it.each([0, 1])('keeps send clickable for an empty member %i and refuels through existing individual UI', emptyIndex => {
    const f = fleetTravelFixture(2); f.current().ships[emptyIndex].fuel = 0;
    f.click('fleet-travel'); f.click('fleet-travel');
    expect(f.find('fleet-travel-fuel').text).toContain('0/3 · Без топлива: 1/2');
    const before = structuredClone(f.current()); f.click('fleet-travel-send');
    expect(f.message()).toContain('Недостаточно топлива'); expect(f.current()).toEqual(before);
    f.click('production-travel'); if (emptyIndex) f.click('travel-ships-next'); f.click('travel-refuel');
    f.click('production-fleets'); f.click('fleet-travel'); f.click('fleet-travel-send');
    expect(f.current().ships.map(s => s.fuel)).toEqual([2, 2]);
    expect(f.current().treasuries.blue).toEqual({ credits: before.treasuries.blue.credits - 15, minerals: before.treasuries.blue.minerals - 6 });
  });

  it.each(['empty', 'no-target'] as const)('disables fleet send for %s without issuing a command', reason => {
    const f = fleetTravelFixture(reason === 'empty' ? 0 : 2);
    if (reason === 'no-target') { f.current().galaxy.systems.find(s => s.id === 'eden')!.ownerId = null; f.click('fleet-travel'); f.click('fleet-travel'); }
    const before = structuredClone(f.current()), calls = f.spy.mock.calls.length;
    expect(f.find('fleet-travel-send').interactive).toBe(false); f.click('fleet-travel-send');
    expect(f.spy).toHaveBeenCalledTimes(calls); expect(f.current()).toEqual(before);
    expect(f.find(reason === 'empty' ? 'fleet-travel-current' : 'fleet-travel-destination').text).toContain(reason === 'empty' ? 'Нет групп' : 'Нет соседних');
  });

  it('offers only own adjacent targets and sends the captured second destination from Eden', () => {
    const f = fleetTravelFixture();
    f.current().ships.forEach(s => { s.systemId = 'eden'; });
    f.current().fleets.items.forEach(g => { g.systemId = 'eden'; });
    const nexus = f.current().galaxy.systems.find(s => s.id === 'nexus')!;
    nexus.ownerId = 'blue'; nexus.exploredBy = ['blue'];
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    expect(f.find('fleet-travel-destination').text).toBe('Цель 1/2: Сол');
    f.click('fleet-travel-destination-next'); expect(f.find('fleet-travel-destination').text).toContain('2/2:');
    f.click('fleet-travel-next'); expect(f.find('fleet-travel-destination').text).toBe('Цель 1/2: Сол');
    f.click('fleet-travel-destination-next'); f.click('fleet-travel-send');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'eden', fleetId: 2, destinationId: 'nexus' });
    expect(f.find('fleet-travel-destination').text).toBe('Цель 1/2: Сол');
  });

  it.each(['stale', 'missing', 'moving', 'target-lost', 'source-moved'] as const)('rejects captured fleet send after %s without UI-side state mutation', reason => {
    const f = fleetTravelFixture(2), state = f.current();
    const expected = { stale: 'STALE_TURN', missing: 'FLEET_NOT_FOUND', moving: 'FLEET_IN_TRANSIT', 'target-lost': 'NOT_OWN_COLONY', 'source-moved': 'FLEET_NOT_FOUND' };
    if (reason === 'stale') state.turn = 3;
    if (reason === 'missing') state.fleets.items = [];
    if (reason === 'moving') state.ships.forEach(s => { s.transit = { destinationId: 'eden', remainingTurns: 1 }; });
    if (reason === 'target-lost') state.galaxy.systems.find(s => s.id === 'eden')!.ownerId = null;
    if (reason === 'source-moved') { state.fleets.items[0].systemId = 'eden'; state.ships.forEach(s => { s.systemId = 'eden'; }); }
    const before = structuredClone(state); f.click('fleet-travel-send');
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value).toMatchObject({ ok: false, code: expected[reason] });
    expect(f.current()).toEqual(before);
  });

  it('keeps routes on failed endTurn and hides enemy groups and routes for the other observer', () => {
    const f = fleetTravelFixture(2); f.click('fleet-travel-send');
    f.current().treasuries.blue.credits = domain.MAX_RESOURCE;
    const before = structuredClone(f.current()); f.click('campaign-end-turn'); expect(f.current()).toEqual(before);
    expect(f.find('fleet-travel-transit-title').text).toContain(': 1');
    f.click('campaign-side-switch');
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    expect(f.find('fleet-travel-count').text).toContain('0/20'); expect(f.find('fleet-travel-transit-title').text).toContain(': 0');
    expect(f.nodes.filter(n => !n.destroyed).map(n => n.text).join(' ')).not.toContain('Группа #1');
  });

  it('sends a red group through the same controls and never advances it on blue endTurn', () => {
    const f = fleetTravelFixture(2), state = f.current();
    state.ships.forEach(s => { s.factionId = 'red'; s.systemId = 'vega'; });
    Object.assign(state.fleets.items[0], { factionId: 'red', systemId: 'vega' });
    Object.assign(state.galaxy.systems.find(s => s.id === 'nexus')!, { ownerId: 'red', exploredBy: ['red'] });
    state.turn = 2;
    f.click('campaign-side-switch'); f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    f.click('fleet-travel-send'); expect(f.current().ships.every(s => s.transit?.destinationId === 'nexus' && s.fuel === 2)).toBe(true);
    // A valid pending red trip may coexist with an active blue turn.
    f.current().turn = 3; f.click('campaign-side-switch'); f.click('campaign-end-turn');
    expect(f.current().ships.every(s => s.transit)).toBe(true);
    f.click('campaign-side-switch'); f.click('production-fleets'); f.click('fleet-travel'); f.click('campaign-end-turn');
    expect(f.current().ships.every(s => s.systemId === 'nexus' && !s.transit)).toBe(true);
  });

  it('blocks route controls during pending, invalidates old handlers and unwinds ESC one view at a time', () => {
    const f = fleetTravelFixture(4), old = f.find('fleet-travel-send').listeners('pointerdown')[0] as () => void;
    f.click('campaign-new'); const calls = f.spy.mock.calls.length;
    for (const name of ['fleet-travel', 'fleet-travel-send', 'fleet-travel-prev', 'fleet-travel-destination-next', 'fleet-travel-transit-next']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    old(); expect(f.spy).toHaveBeenCalledTimes(calls);
    f.keyboard.emit('keydown-ESC'); expect(f.find('fleet-travel-current').text).toContain('Группа #2');
    f.keyboard.emit('keydown-ESC'); expect(f.find('fleet-current').text).toContain('Группа #2');
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-enqueue')).toBeDefined();
    f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
    f.keyboard.emit('keydown-ESC'); expect(f.find('campaign-confirm')).toBeDefined();
  });

  it('clears group draft on routes, destroys nested panels on reset and reenters with no route state', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-travel'); f.click('fleet-travel');
    expect(f.find('fleet-selection-count').text).toContain('Выбрано: 0/10');
    f.selectTwo(); f.click('fleet-create'); f.click('fleet-travel'); f.click('fleet-travel-send');
    const old = f.find('fleet-travel-transit-prev');
    f.click('campaign-new'); f.click('campaign-confirm'); expect(old.destroyed).toBe(true);
    f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    expect(f.find('fleet-travel-count').text).toContain('0/20');
    f.click('campaign-menu'); f.click('campaign-confirm'); expect(f.nodes.every(n => n.destroyed)).toBe(true);
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0); f.scene.create();
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.scene).toMatchObject({ fleetTravelOpen: false, fleetDestinationIndex: 0, fleetTransitPage: 0 });
  });

  it('browses twenty own groups at the ship cap and safely displays the maximum fleet ID', () => {
    const f = fleetTravelFixture(100), state = f.current();
    // Keep the domain cap and exercise the largest valid fleet ID.
    state.fleets.items[state.fleets.items.length - 1].id = 1_000_000_000; state.fleets.lastFleetId = 1_000_000_000;
    f.click('fleet-travel'); f.click('fleet-travel');
    expect(f.find('fleet-travel-count').text).toContain('20/20');
    expect(f.find('fleet-travel-count').text).toContain('100/100');
    expect(f.find('fleet-travel-current').text).toContain('#1000000000');
    expect(f.find('fleet-travel-current').width).toBeLessThanOrEqual(745);
    f.click('fleet-travel-send'); expect(f.find('fleet-travel-transit').text).toContain('#1000000000');
    expect(f.current().fleets.items).toHaveLength(20);
  });

  it('hides an API-sent group at both endpoints, preserves total cap and shows it after arrival', () => {
    const f = fleetFixture(2); f.selectTwo(); f.click('fleet-create');
    const old = f.find('fleet-disband').listeners('pointerdown')[0] as () => void;
    // Preserve coverage of the direct scene boundary independently of the send UI.
    (f.scene as unknown as { execute: (command: domain.SessionCommand) => void }).execute({
      kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden'
    });
    const calls = f.spy.mock.calls.length; old(); expect(f.spy).toHaveBeenCalledTimes(calls);
    expect(f.message()).toContain('Группа отправлена');
    expect(f.find('fleet-count').text).toContain('КОЛОНИИ: 0 · У стороны: 1/20');
    expect(f.find('fleet-disband').interactive).toBe(false); expect(f.find('fleet-candidates-title').text).toContain(': 0');
    expect(f.find('fleet-limit').text).toContain('Маршруты');
    f.click('production-travel'); expect(f.find('travel-transit-title').text).toContain(': 2');
    expect(f.find('travel-count').text).toContain('2/100');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-disband').interactive).toBe(false);
    f.click('campaign-end-turn'); expect(f.find('fleet-current').text).toContain('Группа #1');
    expect(f.find('fleet-member-fuel').text).toContain('2/3');
    f.click('fleet-disband'); expect(f.message()).toBe('Сейчас ход другой стороны');
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch'); f.click('production-fleets');
    f.click('fleet-disband'); expect(f.find('fleet-candidates-title').text).toContain(': 2');
  });

  it('rejects captured disband when the same group started travelling without a UI redraw', () => {
    const f = fleetFixture(2); f.selectTwo(); f.click('fleet-create');
    const grouped = f.spy.mock.results[0].value.state as domain.CampaignSession;
    const moving = domain.executeSessionCommand(grouped, { kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden' });
    if (!moving.ok) throw Error(moving.code);
    Object.assign(f.scene, { campaign: moving.state });
    f.click('fleet-disband');
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value).toMatchObject({ ok: false, code: 'FLEET_IN_TRANSIT' });
    expect(f.find('fleet-current').text).toBe('Групп в этой колонии нет.');
    expect(moving.state.fleets.items).toHaveLength(1);
  });

  it('clamps the displayed group when another group departs and clears all trips/groups on reset', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create');
    f.click('fleet-candidate-prev'); f.selectTwo(); f.click('fleet-create');
    expect(f.find('fleet-current').text).toContain('2/2 · Группа #2');
    (f.scene as unknown as { execute: (command: domain.SessionCommand) => void }).execute({
      kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden'
    });
    expect(f.find('fleet-current').text).toContain('1/1 · Группа #2');
    expect(f.find('fleet-member').text).toContain('#3');
    f.click('campaign-new'); f.click('campaign-confirm'); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-count').text).toContain('0/20');
    f.click('production-travel'); expect(f.find('travel-transit-title').text).toContain(': 0');
  });

  it('opens exclusive group view without commands or catalog reads; empty controls are disabled', () => {
    const f = fleetFixture(0), before = structuredClone(f.state), reads = f.load.mock.calls.length;
    expect(f.find('fleet-candidate').text).toBe('Нет свободных стоящих кораблей.');
    expect(f.find('fleet-current').text).toBe('Групп в этой колонии нет.');
    for (const name of ['fleet-select', 'fleet-create', 'fleet-clear', 'fleet-disband', 'fleet-next', 'fleet-member-next']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    expect(f.nodes.some(n => !n.destroyed && ['travel-panel', 'production-enqueue'].includes(n.name))).toBe(false);
    f.click('production-fleets'); expect(f.find('production-enqueue')).toBeDefined();
    f.click('production-fleets'); expect(f.find('fleet-panel')).toBeDefined();
    expect(f.state).toEqual(before); expect(f.spy).not.toHaveBeenCalled(); expect(f.load).toHaveBeenCalledTimes(reads);
  });

  it('captures the displayed ordered membership once, without payment or copying ship designs', () => {
    const f = fleetFixture(), before = structuredClone(f.state), reads = f.load.mock.calls.length;
    f.click('fleet-candidate-next'); f.click('fleet-select');
    expect(f.find('fleet-create').interactive).toBe(false);
    f.click('fleet-candidate-prev'); f.click('fleet-select');
    const old = f.find('fleet-create').listeners('pointerdown')[0] as () => void;
    old(); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toEqual({ kind: 'createFleet', factionId: 'blue', systemId: 'sol', expectedTurn: 1, shipIds: [2, 1] });
    const next = f.spy.mock.results[0].value.state;
    expect(next).toEqual({ ...before, fleets: { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [2, 1] }] } });
    expect(f.find('fleet-selection-count').text).toContain('Выбрано: 0/10');
    expect(f.find('fleet-candidate').text).toContain('#3');
    expect(f.find('fleet-member').text).toContain('#2'); f.click('fleet-member-next'); expect(f.find('fleet-member').text).toContain('#1');
    expect(f.find('fleet-member-next').interactive).toBe(false);
    expect(f.load).toHaveBeenCalledTimes(reads); expect(f.state).toEqual(before);
  });

  it('limits selection to ten, allows deselection and clear without changing membership', () => {
    const f = fleetFixture(12);
    for (let i = 0; i < 10; i++) { f.click('fleet-select'); f.click('fleet-candidate-next'); }
    expect(f.find('fleet-selection-count').text).toContain('10/10'); expect(f.find('fleet-select').interactive).toBe(false);
    f.click('fleet-select'); f.click('fleet-candidate-prev'); expect(f.find('fleet-select').interactive).toBe(true);
    f.click('fleet-select'); expect(f.find('fleet-selection-count').text).toContain('9/10');
    f.click('fleet-select'); f.click('fleet-clear');
    expect(f.find('fleet-selection-count').text).toContain('0/10'); expect(f.spy).not.toHaveBeenCalled();
  });

  it('browses multiple groups, disbands the captured last group once and clamps member/group pages', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create');
    f.click('fleet-candidate-prev'); f.selectTwo(); f.click('fleet-create');
    expect(f.find('fleet-current').text).toContain('2/2 · Группа #2');
    f.click('fleet-member-next'); expect(f.find('fleet-member').text).toContain('2/2');
    f.click('fleet-prev'); expect(f.find('fleet-member').text).toContain('1/2'); f.click('fleet-next');
    const old = f.find('fleet-disband').listeners('pointerdown')[0] as () => void;
    old(); old(); expect(f.spy).toHaveBeenCalledTimes(3);
    expect(f.spy.mock.calls[2][1]).toEqual({ kind: 'disbandFleet', factionId: 'blue', systemId: 'sol', expectedTurn: 1, fleetId: 2 });
    expect(f.find('fleet-current').text).toContain('1/1 · Группа #1'); expect(f.find('fleet-member').text).toContain('1/2');
    expect(f.find('fleet-count').text).toContain('У стороны: 1/20');
    f.click('fleet-disband'); expect(f.find('fleet-disband').interactive).toBe(false);
    expect(f.find('fleet-candidates-title').text).toContain(': 4');
    const next = f.spy.mock.results[3].value.state;
    expect(next.fleets).toEqual({ lastFleetId: 2, items: [] }); expect(next.ships).toEqual(f.state.ships);
  });

  it('shows group membership in travel, refuels a member and allows send only after UI disband', () => {
    const f = fleetFixture(2); f.state.ships[0].fuel = 1;
    f.selectTwo(); f.click('fleet-create'); f.click('production-travel');
    expect(f.find('travel-limit').text).toContain('Группа #1');
    f.click('travel-send'); expect(f.message()).toContain('сначала расформируйте');
    f.click('travel-refuel'); expect(f.find('travel-fuel').text).toContain('3/3');
    f.click('production-fleets'); expect(f.find('fleet-member-fuel').text).toContain('3/3');
    f.click('fleet-disband'); f.click('production-travel'); f.click('travel-send');
    expect(f.find('travel-transit').text).toContain('#1');
    f.click('production-fleets'); expect(f.find('fleet-candidates-title').text).toContain(': 1');
  });

  it('creates and disbands red groups without exposing blue groups or global counter', () => {
    const f = fleetFixture();
    f.state.ships.slice(2).forEach(ship => { ship.factionId = 'red'; ship.systemId = 'vega'; ship.design.name = 'Красный'; });
    f.selectTwo(); f.click('fleet-create'); f.click('campaign-end-turn'); f.click('campaign-side-switch');
    expect(f.nodes.some(n => !n.destroyed && n.name === 'fleet-panel')).toBe(false);
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-count').text).toContain('У стороны: 0/20');
    f.selectTwo(); f.click('fleet-create'); expect(f.find('fleet-current').text).toContain('Группа #2');
    expect(f.find('fleet-member').text).toContain('Красный');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'createFleet', factionId: 'red', expectedTurn: 2, systemId: 'vega', shipIds: [3, 4] });
    f.click('fleet-disband'); expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'disbandFleet', factionId: 'red', expectedTurn: 2, systemId: 'vega', fleetId: 2 });
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value.state.fleets.items).toHaveLength(1);
  });

  it('filters members, transit and other colonies out of candidates and shows colony-specific groups', () => {
    const f = fleetFixture(8);
    f.state.ships[2].transit = { destinationId: 'eden', remainingTurns: 1 };
    f.state.ships.slice(3, 6).forEach(ship => { ship.systemId = 'eden'; });
    f.state.fleets = { lastFleetId: 2, items: [
      { id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] },
      { id: 2, factionId: 'blue', systemId: 'eden', shipIds: [4, 5] }
    ] };
    f.click('production-fleets'); f.click('production-fleets');
    expect(f.find('fleet-candidates-title').text).toContain(': 2'); expect(f.find('fleet-candidate').text).toContain('#7');
    expect(f.find('fleet-count').text).toContain('КОЛОНИИ: 1 · У стороны: 2/20');
    f.click('fleet-select'); f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-candidate').text).toContain('#6'); expect(f.find('fleet-current').text).toContain('Группа #2');
    expect(f.find('fleet-selection-count').text).toContain('0/10');
  });

  it.each(['eden', 'rift', 'vega'])('does not expose group controls in unavailable colony %s', id => {
    const f = fixture(); f.click(`system-${id}`); f.click('campaign-production');
    expect(f.find('production-unavailable')).toBeDefined();
    expect(f.nodes.some(n => !n.destroyed && ['production-fleets', 'fleet-panel'].includes(n.name))).toBe(false);
  });

  it.each(['stale', 'vanished', 'moved', 'transit', 'grouped'] as const)('rejects changed captured membership: %s', change => {
    const f = fleetFixture(); f.selectTwo();
    if (change === 'stale') f.state.turn = 3;
    if (change === 'vanished') f.state.ships.shift();
    if (change === 'moved') f.state.ships[0].systemId = 'eden';
    if (change === 'transit') f.state.ships[0].transit = { destinationId: 'eden', remainingTurns: 1 };
    if (change === 'grouped') f.state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 3] }] };
    const before = structuredClone(f.state); f.click('fleet-create');
    expect(f.spy.mock.calls[0][1]).toMatchObject({ shipIds: [1, 2], expectedTurn: 1 });
    expect(f.spy.mock.results[0].value).toMatchObject({ ok: false, code: change === 'stale' ? 'STALE_TURN' : change === 'grouped' ? 'SHIP_IN_FLEET' : change === 'transit' ? 'SHIP_IN_TRANSIT' : 'SHIP_NOT_FOUND' });
    expect(f.state).toEqual(before);
    expect(f.find('fleet-selection-count').text).toContain(change === 'stale' ? '2/10' : '1/10');
  });

  it('shows missing captured group refusal, then refreshes empty group/member pages', () => {
    const f = fleetFixture();
    f.state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] }] };
    f.click('production-fleets'); f.click('production-fleets'); f.state.fleets.items = [];
    f.click('fleet-disband'); expect(f.message()).toContain('Своя группа не найдена');
    expect(f.spy.mock.calls[0][1]).toMatchObject({ fleetId: 1 }); expect(f.find('fleet-disband').interactive).toBe(false);
    expect(f.find('fleet-member').text).toBe('Нет участников для просмотра.');
  });

  it('keeps inactive create/disband clickable for domain refusal and clears selection on successful endTurn', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create');
    f.click('fleet-candidate-prev'); f.selectTwo(); f.click('campaign-end-turn');
    expect(f.find('fleet-selection-count').text).toContain('0/10');
    f.click('fleet-candidate-prev'); f.selectTwo(); f.click('fleet-create'); expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(f.find('fleet-selection-count').text).toContain('2/10'); f.click('fleet-disband'); expect(f.message()).toBe('Сейчас ход другой стороны');
  });

  it.each(['fleet-limit', 'id-limit'] as const)('shows domain %s without clearing the valid draft', limit => {
    const f = fleetFixture(42);
    if (limit === 'fleet-limit') f.state.fleets = { lastFleetId: 20, items: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, factionId: 'blue', systemId: 'sol', shipIds: [i * 2 + 1, i * 2 + 2] })) };
    else f.state.fleets.lastFleetId = 1_000_000_000;
    f.click('production-fleets'); f.click('production-fleets'); f.selectTwo();
    expect(f.find('fleet-create').interactive).toBe(true); f.click('fleet-create');
    expect(f.spy.mock.results[0].value).toMatchObject({ ok: false, code: limit === 'fleet-limit' ? 'FLEET_LIMIT' : 'FLEET_ID_LIMIT' });
    expect(f.find('fleet-selection-count').text).toContain('2/10');
  });

  it.each(['fleet-clear', 'fleet-candidate-prev', 'production-fleets', 'production-travel', 'campaign-production', 'campaign-side-switch', 'campaign-new'])('makes old create inert after %s', action => {
    const f = fleetFixture(); f.selectTwo(); const old = f.find('fleet-create').listeners('pointerdown')[0] as () => void;
    f.click(action); old(); expect(f.spy).not.toHaveBeenCalled();
  });

  it('blocks all group controls while pending, restores draft on cancel, then ESC closes one layer', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create'); f.click('fleet-candidate-prev'); f.selectTwo();
    f.click('campaign-new');
    for (const name of ['fleet-select', 'fleet-create', 'fleet-clear', 'fleet-disband', 'fleet-candidate-prev', 'fleet-next', 'fleet-member-next', 'production-fleets', 'production-travel']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    expect(f.spy).toHaveBeenCalledTimes(1);
    f.keyboard.emit('keydown-ESC'); expect(f.find('fleet-selection-count').text).toContain('2/10');
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-enqueue')).toBeDefined();
    f.click('production-fleets'); expect(f.find('fleet-selection-count').text).toContain('0/10');
    f.keyboard.emit('keydown-ESC'); f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
  });

  it('destroys group callbacks on reset/exit and reenters with one handler, empty groups and draft', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create');
    const old = f.find('fleet-disband').listeners('pointerdown')[0] as () => void;
    f.click('campaign-new'); f.click('campaign-confirm'); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    f.click('campaign-production'); f.click('production-fleets'); expect(f.find('fleet-count').text).toContain('0/20');
    f.click('campaign-menu'); f.click('campaign-confirm'); old();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    f.scene.create(); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-selection-count').text).toContain('0/10'); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'fleet-panel')).toHaveLength(1);
  });

  it('fits long member/candidate names and large IDs without changing snapshots', () => {
    const f = fleetFixture(2); const name = `Ш\n${'Ш'.repeat(78)}`;
    f.state.production.lastOrderId = 1_000_000_000;
    f.state.ships.forEach((ship, i) => { ship.id = 999999999 + i; ship.design.name = name; });
    f.state.fleets.lastFleetId = 999999999;
    f.click('production-fleets'); f.click('production-fleets');
    expect(f.find('fleet-candidate').text).toMatch(/#999999999 Ш Ш.*…$/); expect(f.find('fleet-candidate').width).toBeLessThanOrEqual(745);
    f.selectTwo(); f.click('fleet-create');
    expect(f.find('fleet-current').text).toContain('#1000000000'); expect(f.find('fleet-current').width).toBeLessThanOrEqual(540);
    expect(f.find('fleet-member').text).toMatch(/#999999999 Ш Ш.*…$/); expect(f.find('fleet-member').width).toBeLessThanOrEqual(590);
    expect(f.spy.mock.results[0].value.state.ships.every((ship: { design: { name: string } }) => ship.design.name === name)).toBe(true);
  });

  it('keeps grouped ships visible and individually refuelable, but shows the grouped-send refusal', () => {
    const f = refuelFixture(2);
    f.state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] }] };
    const before = structuredClone(f.state);
    f.click('travel-send'); expect(f.message()).toContain('сначала расформируйте');
    expect(f.state).toEqual(before); expect(f.find('travel-ship').text).toContain('#1');
    expect(f.find('travel-count').text).toContain('2/100');
    f.click('travel-refuel'); expect(f.find('travel-fuel').text).toContain('3/3');
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value.state.fleets).toEqual(before.fleets);
    f.click('travel-send'); expect(f.message()).toContain('сначала расформируйте');
    expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    f.click('campaign-new'); f.click('campaign-confirm');
    f.click('campaign-end-turn');
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value.state.fleets).toEqual({ lastFleetId: 0, items: [] });
  });

  it('shows each stationed tank and full price, including a disabled full tank', () => {
    const f = refuelFixture();
    for (const [fuel, price] of [[0, '15 кр. / 6 мин.'], [1, '10 кр. / 4 мин.'], [2, '5 кр. / 2 мин.']] as const) {
      expect(f.find('travel-fuel').text).toContain(`Топливо: ${fuel}/3`);
      expect(f.find('travel-refuel-quote').text).toContain(price);
      expect(f.find('travel-refuel').interactive).toBe(true);
      if (fuel < 2) f.click('travel-ships-next');
    }
    f.click('travel-refuel');
    expect(f.find('travel-fuel').text).toContain('3/3 · Бак полон');
    expect(f.find('travel-refuel-quote').text).toContain('+0 · Цена: 0 кр. / 0 мин.');
    expect(f.find('travel-refuel').interactive).toBe(false);
    f.click('travel-refuel'); expect(f.spy).toHaveBeenCalledTimes(1);
  });

  it('refuels the captured displayed ID once, preserving page, snapshot, turn and catalog', () => {
    const f = refuelFixture(), reads = f.load.mock.calls.length;
    f.click('travel-ships-next');
    const old = f.find('travel-refuel').listeners('pointerdown')[0] as () => void;
    const before = structuredClone(f.state);
    old(); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toEqual({ kind: 'refuelShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 2 });
    const next = f.spy.mock.results[0].value.state as domain.CampaignSession;
    expect(next).toEqual({ ...before, ships: before.ships.map(ship => ship.id === 2 ? { ...ship, fuel: 3 } : ship),
      treasuries: { ...before.treasuries, blue: { credits: before.treasuries.blue.credits - 10, minerals: before.treasuries.blue.minerals - 4 } } });
    expect(f.find('travel-ship').text).toContain('2/3 · #2');
    expect(f.find('campaign-treasury').text).toContain(`Кредиты: ${next.treasuries.blue.credits}`);
    expect(f.message()).toBe('Корабль заправлен. Ресурсы списаны.'); expect(f.load).toHaveBeenCalledTimes(reads);
    expect(f.state).toEqual(before);
  });

  it.each(['credits', 'minerals'] as const)('keeps an affordable-looking refuel atomic when %s is insufficient', resource => {
    const f = refuelFixture(1); f.state.treasuries.blue[resource] = 0;
    const before = structuredClone(f.state); f.click('travel-refuel');
    expect(f.message()).toBe('Недостаточно ресурсов для полной заправки');
    expect(f.state).toEqual(before); expect(f.find('travel-fuel').text).toContain('0/3');
    expect(f.find('travel-refuel-quote').text).toContain('15 кр. / 6 мин.');
  });

  it('refuels even without an adjacent destination, but not without a stationed ship', () => {
    const f = refuelFixture(1); f.state.galaxy.systems.find(s => s.id === 'eden')!.ownerId = null;
    f.click('production-travel'); f.click('production-travel');
    expect(f.find('travel-send').interactive).toBe(false); expect(f.find('travel-refuel').interactive).toBe(true);
    f.click('travel-refuel'); expect(f.find('travel-fuel').text).toContain('3/3');
  });

  it('never offers refuel for a travelling ship and refreshes fuel on arrival at the target', () => {
    const f = refuelFixture(1); f.click('travel-refuel'); f.click('travel-send');
    expect(f.find('travel-refuel').interactive).toBe(false);
    expect(f.find('travel-fuel').text).toBe('Топливо: нет выбранного корабля');
    expect(f.find('travel-refuel-quote').text).toContain('недоступна');
    f.click('travel-refuel'); expect(f.spy).toHaveBeenCalledTimes(2);
    f.click('campaign-end-turn'); f.click('campaign-production'); f.click('system-eden');
    f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-fuel').text).toContain('2/3');
    expect(f.find('travel-refuel-quote').text).toContain('5 кр. / 2 мин.');
    f.click('travel-refuel'); expect(f.message()).toBe('Сейчас ход другой стороны');
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch'); f.click('production-travel');
    f.click('travel-refuel');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'refuelShip', factionId: 'blue', expectedTurn: 3, systemId: 'eden', shipId: 1 });
    expect(f.find('travel-fuel').text).toContain('3/3');
  });

  it.each(['stale', 'vanished', 'moved', 'transit', 'full'] as const)('rejects a changed captured ship: %s, never refuels a replacement', change => {
    const f = refuelFixture();
    if (change === 'stale') f.state.turn = 3;
    if (change === 'vanished') f.state.ships.shift();
    if (change === 'moved') f.state.ships[0].systemId = 'eden';
    if (change === 'transit') f.state.ships[0].transit = { destinationId: 'eden', remainingTurns: 1 };
    if (change === 'full') f.state.ships[0].fuel = 3;
    const before = structuredClone(f.state); f.click('travel-refuel');
    expect(f.spy.mock.calls[0][1]).toMatchObject({ expectedTurn: 1, shipId: 1, systemId: 'sol' });
    expect(f.spy.mock.results[0].value).toMatchObject({ ok: false, code: change === 'stale' ? 'STALE_TURN'
      : change === 'full' ? 'FUEL_FULL' : change === 'transit' ? 'SHIP_IN_TRANSIT' : 'SHIP_NOT_FOUND' });
    expect(f.state).toEqual(before);
  });

  it('switches to red fuel/price and refuels red without exposing blue ships', () => {
    const f = refuelFixture(1); f.state.production.lastOrderId = 2;
    f.state.ships.push({ ...structuredClone(f.state.ships[0]), id: 2, factionId: 'red', systemId: 'vega', fuel: 2,
      design: { ...f.choices[0].design, name: 'Красный бак' } });
    f.click('campaign-end-turn'); f.click('campaign-side-switch');
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'travel-refuel')).toHaveLength(0);
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-fuel').text).toContain('2/3'); expect(f.find('travel-refuel-quote').text).toContain('5 кр. / 2 мин.');
    f.click('travel-refuel'); expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'refuelShip', factionId: 'red', expectedTurn: 2, systemId: 'vega', shipId: 2 });
    const next = f.spy.mock.results[f.spy.mock.results.length - 1].value.state as domain.CampaignSession;
    expect(next.ships[0].fuel).toBe(0); expect(next.ships[1].fuel).toBe(3);
    expect(next.treasuries.red).toEqual({ credits: f.state.treasuries.red.credits - 5, minerals: f.state.treasuries.red.minerals - 2 });
    f.click('campaign-side-switch'); f.click('campaign-production'); f.click('system-sol'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-fuel').text).toContain('0/3');
    expect(f.nodes.some(n => !n.destroyed && n.text.includes('Красный бак'))).toBe(false);
  });

  it.each(['travel-ships-next', 'production-travel', 'campaign-production', 'campaign-side-switch', 'campaign-new'])('old refuel is inert after %s', action => {
    const f = refuelFixture(), old = f.find('travel-refuel').listeners('pointerdown')[0] as () => void;
    f.click(action); old(); expect(f.spy).not.toHaveBeenCalled();
  });

  it('blocks refuel during confirmations and destroys it on ESC, reset, exit and reentry', () => {
    const f = refuelFixture(), old = f.find('travel-refuel').listeners('pointerdown')[0] as () => void;
    f.click('campaign-new'); expect(f.find('travel-refuel').interactive).toBe(false);
    f.click('travel-refuel'); old(); expect(f.spy).not.toHaveBeenCalled();
    f.keyboard.emit('keydown-ESC'); expect(f.find('travel-refuel').interactive).toBe(true);
    const closing = f.find('travel-refuel').listeners('pointerdown')[0] as () => void;
    f.keyboard.emit('keydown-ESC'); closing(); expect(f.spy).not.toHaveBeenCalled();
    f.click('production-travel'); f.click('campaign-new'); f.click('campaign-confirm');
    f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-refuel').interactive).toBe(false); expect(f.find('travel-fuel').text).toContain('нет выбранного');
    f.click('campaign-menu'); f.click('campaign-confirm'); old(); closing();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    f.scene.create(); f.click('campaign-production'); f.click('production-travel'); old();
    expect(f.find('travel-refuel').interactive).toBe(false); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'travel-panel')).toHaveLength(1);
  });

  it('keeps fuel/price independent of a long name and clamps after the selected ship disappears', () => {
    const f = refuelFixture(), name = 'Ш'.repeat(80);
    f.state.ships[2].design.name = name; f.click('travel-ships-next'); f.click('travel-ships-next');
    expect(f.find('travel-ship').width).toBeLessThanOrEqual(745);
    expect(f.find('travel-fuel').text).toContain('2/3'); expect(f.find('travel-refuel-quote').width).toBeLessThanOrEqual(570);
    f.click('travel-refuel'); expect(f.spy.mock.results[0].value.state.ships[2].design.name).toBe(name);
    f.click('travel-send'); expect(f.find('travel-ship').text).toContain('2/2 · #2');
    expect(f.find('travel-fuel').text).toContain('1/3'); expect(f.find('travel-refuel-quote').text).toContain('10 кр. / 4 мин.');
  });

  it('sends exactly the displayed ship and destination with captured turn without charging', () => {
    const f = travelFixture(); f.click('travel-ships-next');
    const old = f.find('travel-send').listeners('pointerdown')[0] as () => void;
    const treasury = f.find('campaign-treasury').text;
    old(); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toEqual({ kind: 'sendShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 2, destinationId: 'eden' });
    expect(f.find('travel-ship').text).toContain('2/2 · #3');
    expect(f.find('travel-transit').text).toContain('#2 Готовый 2');
    expect(f.find('travel-route').text).toContain('Сол → Эдем');
    expect(f.find('campaign-treasury').text).toBe(treasury); expect(f.find('campaign-turn').text).toContain('Ход 1');
    expect(f.message()).toContain('Корабль отправлен');
  });

  it('clamps ship/trip pages, selects the new trip and disables sends after all depart', () => {
    const f = travelFixture(); f.click('travel-ships-next'); f.click('travel-ships-next'); f.click('travel-send');
    expect(f.find('travel-ship').text).toContain('2/2 · #2'); expect(f.find('travel-transit').text).toContain('#3');
    f.click('travel-send'); expect(f.find('travel-transit').text).toContain('#2');
    f.click('travel-send'); expect(f.find('travel-send').interactive).toBe(false);
    const calls = f.spy.mock.calls.length; f.click('travel-send'); expect(f.spy).toHaveBeenCalledTimes(calls);
    expect(f.find('travel-ships-prev').interactive).toBe(false); expect(f.find('travel-ships-next').interactive).toBe(false);
    expect(f.find('travel-transit').text).toContain('1/3 · #1');
    f.click('travel-transit-next'); f.click('travel-transit-next'); expect(f.find('travel-transit').text).toContain('3/3 · #3');
    expect(f.find('travel-transit-next').interactive).toBe(false);
    f.click('travel-transit-prev'); expect(f.find('travel-transit').text).toContain('2/3 · #2');
    f.click('campaign-end-turn'); expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    expect(f.find('travel-transit-prev').interactive).toBe(false);
  });

  it('shows arrival in target and sends back along the reverse lane on the next own turn', () => {
    const f = travelFixture(1); f.click('travel-send'); f.click('campaign-end-turn');
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-ship').text).toContain('#1'); expect(f.find('travel-destination').text).toBe('Цель 1/1: Сол');
    f.click('travel-send'); expect(f.find('travel-route').text).toContain('Эдем → Сол');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toMatchObject({ expectedTurn: 3, systemId: 'eden', destinationId: 'sol' });
  });

  it('offers only neighbouring own colonies, supports destination paging and resets selection', () => {
    const f = travelFixture(1); const nexus = f.state.galaxy.systems.find(s => s.id === 'nexus')!;
    nexus.ownerId = 'blue'; nexus.exploredBy = ['blue']; f.state.ships[0].systemId = 'eden';
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-destination').text).toBe('Цель 1/2: Сол');
    f.click('travel-destination-next'); expect(f.find('travel-destination').text).toBe('Цель 2/2: Узел');
    expect(f.find('travel-destination-next').interactive).toBe(false);
    f.click('travel-destination-prev'); expect(f.find('travel-destination').text).toContain('Сол');
    f.click('travel-destination-next'); f.click('production-travel'); f.click('production-travel');
    expect(f.find('travel-destination').text).toContain('Сол');
    f.click('travel-destination-next'); f.click('travel-send'); expect(f.find('travel-route').text).toContain('Эдем → Узел');
  });

  it.each(['neutral', 'enemy', 'unknown'] as const)('disables travel without a valid neighbouring own destination: %s', kind => {
    const f = travelFixture(1), eden = f.state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = kind === 'enemy' ? 'red' : null;
    eden.exploredBy = kind === 'unknown' ? [] : kind === 'enemy' ? ['red', 'blue'] : ['blue'];
    f.click('production-travel'); f.click('production-travel');
    expect(f.find('travel-destination').text).toBe('Нет соседних собственных колоний.');
    expect(f.find('travel-send').interactive).toBe(false); f.click('travel-send'); expect(f.spy).not.toHaveBeenCalled();
  });

  it('does not permit sending ready records without deployed ships', () => {
    const f = deploymentFixture(1); f.click('production-travel');
    expect(f.find('travel-ship').text).toBe('Нет кораблей для отправки.');
    expect(f.find('travel-send').interactive).toBe(false);
  });

  it('shows inactive rejection without removing the ship or creating a trip', () => {
    const f = travelFixture(1); f.click('campaign-end-turn'); f.click('travel-send');
    expect(f.message()).toBe('Сейчас ход другой стороны'); expect(f.find('travel-ship').text).toContain('#1');
    expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
  });

  it('shows stale or vanished ship errors rather than selecting a replacement', () => {
    const f = travelFixture(); f.state.turn = 3; f.click('travel-send');
    expect(f.message()).toContain('Номер хода изменился'); expect(f.spy.mock.calls[0][1]).toMatchObject({ expectedTurn: 1 });
    f.state.ships.shift(); f.click('travel-send'); expect(f.message()).toContain('Свой корабль не найден');
    expect(f.find('travel-ship').text).toContain('#2');
  });

  it('domain rejects a captured destination which is no longer owned', () => {
    const f = travelFixture(1); f.state.galaxy.systems.find(s => s.id === 'eden')!.ownerId = null;
    f.click('travel-send'); expect(f.message()).toBe('Перелёт доступен только в свою колонию');
    expect(f.find('travel-send').interactive).toBe(false); expect(f.find('travel-ship').text).toContain('#1');
  });

  it('keeps the trip visible when endTurn overflows and when an opponent ends their turn', () => {
    const f = travelFixture(1); f.click('travel-send');
    const current = f.spy.mock.results[0].value.state as domain.CampaignSession;
    current.treasuries.blue.credits = domain.MAX_RESOURCE;
    f.click('campaign-end-turn'); expect(f.message()).toContain('Доход превысит предел');
    expect(f.find('travel-route').text).toContain('Сол → Эдем');
    current.treasuries.blue.credits = 0; current.turn = 2;
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch'); f.click('production-travel');
    expect(f.find('travel-transit').text).toContain('#1');
  });

  it('renders only red ships/routes after switching and sends red to its own neighbour', () => {
    const f = travelFixture(1), nexus = f.state.galaxy.systems.find(s => s.id === 'nexus')!;
    nexus.ownerId = 'red'; nexus.exploredBy = ['red', 'blue'];
    f.state.production.lastOrderId = 2;
    f.state.ships.push({ ...structuredClone(f.state.ships[0]), id: 2, factionId: 'red', systemId: 'vega', design: { ...f.choices[0].design, name: 'Красный' } });
    f.click('campaign-end-turn'); f.click('campaign-side-switch');
    expect(f.nodes.filter(n => !n.destroyed).some(n => n.name.startsWith('travel-'))).toBe(false);
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-ship').text).toContain('#2 Красный'); expect(f.find('travel-count').text).toContain('1/100');
    f.click('travel-send'); expect(f.find('travel-route').text).toContain('Вега → Узел');
    f.click('campaign-side-switch'); f.click('campaign-production'); f.click('system-sol'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    expect(f.nodes.filter(n => !n.destroyed).some(n => n.text.includes('Красный'))).toBe(false);
  });

  it.each(['travel-ships-next', 'production-travel', 'campaign-production', 'campaign-side-switch', 'campaign-new'])('old send callback is inert after %s', action => {
    const f = travelFixture(), old = f.find('travel-send').listeners('pointerdown')[0] as () => void;
    f.click(action); old(); expect(f.spy).not.toHaveBeenCalled();
  });

  it('blocks all travel controls while pending and ESC closes one level at a time', () => {
    const f = travelFixture(); f.click('travel-send'); f.click('travel-send'); f.click('campaign-new');
    for (const name of ['travel-send', 'travel-ships-next', 'travel-destination-next', 'travel-transit-prev', 'travel-transit-next', 'production-travel']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    expect(f.spy).toHaveBeenCalledTimes(2);
    f.keyboard.emit('keydown-ESC'); expect(f.find('travel-transit')).toBeDefined();
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-enqueue')).toBeDefined();
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'travel-panel')).toHaveLength(0);
    f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined(); expect(f.start).not.toHaveBeenCalled();
  });

  it('clears travel state and callbacks on reset and shutdown/reentry', () => {
    const f = travelFixture(), old = f.find('travel-send').listeners('pointerdown')[0] as () => void;
    f.click('travel-ships-next'); f.click('travel-send'); f.click('campaign-new'); f.click('campaign-confirm'); old();
    expect(f.spy).toHaveBeenCalledTimes(1);
    f.click('campaign-production'); f.click('production-travel'); expect(f.find('travel-count').text).toContain('0/100');
    f.click('campaign-menu'); f.click('campaign-confirm'); old();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    f.scene.create(); f.click('campaign-production'); f.click('production-travel'); old();
    expect(f.find('travel-ship').text).toBe('Нет кораблей для отправки.');
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'travel-panel')).toHaveLength(1);
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
  });

  it('fits large IDs and long names without modifying the snapshot in either list', () => {
    const f = travelFixture(1), name = `Ш\n${'Ш'.repeat(78)}`;
    f.state.production.lastOrderId = 999999999; f.state.ships[0].id = 999999999; f.state.ships[0].design.name = name;
    f.click('production-travel'); f.click('production-travel');
    expect(f.find('travel-ship').width).toBeLessThanOrEqual(745); expect(f.find('travel-ship').text).toMatch(/#999999999 Ш Ш.*…$/);
    f.click('travel-send'); expect(f.find('travel-transit').width).toBeLessThanOrEqual(745);
    expect(f.spy.mock.results[0].value.state.ships[0].design.name).toBe(name);
  });
});
