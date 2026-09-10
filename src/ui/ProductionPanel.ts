import type Phaser from 'phaser';
import type { CampaignSessionView } from '../domain/campaignSession';
import type { SystemId } from '../domain/campaign';
import { isShipAtColony, MAX_CAMPAIGN_SHIPS } from '../domain/campaignShips';
import { getProductionQuote, getProductionRefund } from '../domain/production';
import type { ProductionCatalog } from '../utils/ProductionCatalog';
import { TravelPanel, type TravelPanelState, type TravelPanelActions } from './TravelPanel';
import { FleetPanel, type FleetPanelState, type FleetPanelActions } from './FleetPanel';

export interface ProductionPanelState {
  catalog: ProductionCatalog;
  choiceIndex: number;
  completedPage: number;
  shipsPage: number;
  showShips: boolean;
  travel?: TravelPanelState;
  fleets?: FleetPanelState;
}
export interface ProductionPanelActions {
  choose: (index: number) => void;
  refresh: () => void;
  enqueue: () => void;
  cancelOrder: (id: number) => void;
  completedPage: (page: number) => void;
  shipsPage: (page: number) => void;
  toggleShips: () => void;
  deploy: (orderId: number) => void;
  toggleTravel: () => void;
  travel: TravelPanelActions;
  toggleFleets: () => void;
  fleets: FleetPanelActions;
}
const short = (text: string, length = 42): string => {
  const clean = text.replace(/\s+/g, ' ');
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
};

/** Own production projection only; parent destroys this panel on every UI transition. */
export class ProductionPanel {
  private readonly root: Phaser.GameObjects.Container;
  private disposed = false;
  private travel?: TravelPanel;
  private fleets?: FleetPanel;

  constructor(private readonly scene: Phaser.Scene, session: CampaignSessionView, systemId: SystemId,
    state: ProductionPanelState, actions: ProductionPanelActions, private readonly blocked: boolean,
    private readonly readOnly = false) {
    this.root = scene.add.container(0, 0).setName('production-panel');
    const system = session.galaxy.systems.find(item => item.id === systemId)!;
    this.label(46, 223, `ПРОИЗВОДСТВО · ${system.name}`, 'production-title', 18);
    if (system.visibility !== 'explored' || system.ownerId !== session.galaxy.factionId) {
      this.label(46, 270, 'Выберите свою колонию на карте. Чужие очереди недоступны.', 'production-unavailable');
      return;
    }
    this.button(350, 216, state.fleets ? '← Очередь' : 'Группы', 'production-fleets', actions.toggleFleets);
    this.button(490, 216, state.travel ? '← Производство' : 'Перелёты', 'production-travel', actions.toggleTravel);
    if (state.fleets) {
      this.fleets = new FleetPanel(scene, session, systemId, state.fleets, actions.fleets, blocked, readOnly);
      return;
    }
    if (state.travel) {
      this.travel = new TravelPanel(scene, session, systemId, state.travel, actions.travel, blocked, readOnly);
      return;
    }
    const choice = state.catalog.choices[state.choiceIndex];
    this.button(650, 216, 'Обновить', 'production-refresh', actions.refresh);
    this.label(46, 256, choice ? short(choice.design.name) : 'Нет проектов', 'production-design', 18);
    this.button(506, 250, '‹', 'production-prev', () => actions.choose(state.choiceIndex - 1), state.choiceIndex <= 0);
    this.button(555, 250, '›', 'production-next', () => actions.choose(state.choiceIndex + 1), state.choiceIndex >= state.catalog.choices.length - 1);
    this.label(46, 283, choice ? `${choice.source} · ${state.choiceIndex + 1}/${state.catalog.choices.length}` : '', 'production-source');
    this.label(46, 310, choice?.quote
      ? `Цена: ${choice.quote.cost.credits} кр. / ${choice.quote.cost.minerals} мин. · Срок: ${choice.quote.turns} своих ходов`
      : short(choice?.issue ?? 'Выберите проект', 85), 'production-quote', 14);
    this.button(650, 274, 'Заказать', 'production-enqueue', actions.enqueue, !choice?.quote);
    this.label(46, 336, state.catalog.notice, 'production-notice', 13);

    const orders = session.production.orders.filter(order => order.systemId === systemId);
    this.label(46, 365, `ОЧЕРЕДЬ ${orders.length}/3 · один заказ колонии за ход`, 'production-queue-title', 14);
    orders.forEach((order, index) => {
      const y = 391 + index * 50, total = getProductionQuote(order.design).turns;
      const refund = getProductionRefund(order);
      this.label(46, y, `#${order.id} ${short(order.design.name, 32)}`, `production-order-${order.id}`, 14);
      this.label(46, y + 20, `${index ? 'Ожидает' : 'Строится'} · готово ${total - order.remainingTurns}/${total} · осталось ${order.remainingTurns}`, `production-progress-${order.id}`, 13);
      this.button(490, y, `Отмена: +${refund.credits} кр. / +${refund.minerals} мин.`, `production-cancel-${order.id}`,
        () => actions.cancelOrder(order.id));
    });
    if (!orders.length) this.label(46, 403, 'Заказов нет. Ресурсы списываются при постановке.', 'production-empty');
    const completed = session.production.completed.filter(record => record.systemId === systemId);
    const ships = session.ships.filter(ship => isShipAtColony(ship, systemId));
    this.button(490, 544, state.showShips ? `Готово: ${completed.length}` : `Корабли: ${ships.length}`,
      'production-toggle-ships', actions.toggleShips);
    if (state.showShips) {
      const page = Math.max(0, Math.min(state.shipsPage, ships.length - 1)), ship = ships[page];
      this.label(46, 551, `КОРАБЛИ В КОЛОНИИ: ${ships.length}`, 'production-ships-title', 14);
      this.button(650, 544, '‹', 'production-ships-prev', () => actions.shipsPage(page - 1), page === 0);
      this.button(697, 544, '›', 'production-ships-next', () => actions.shipsPage(page + 1), page >= ships.length - 1);
      this.label(46, 594, ship ? `${page + 1}/${ships.length} · #${ship.id} ${short(ship.design.name, 56)}`
        : 'Размещённых кораблей пока нет.', 'production-ship', 16);
      this.label(46, 627, `Всего у стороны: ${session.ships.length}/${MAX_CAMPAIGN_SHIPS} · Отправка — кнопка «Перелёты» сверху.`, 'production-ships-hint', 13);
      return;
    }
    const page = Math.max(0, Math.min(state.completedPage, completed.length - 1));
    this.label(46, 551, `ГОТОВО К РАЗМЕЩЕНИЮ: ${completed.length}`, 'production-completed-title', 14);
    this.button(650, 544, '‹', 'production-completed-prev', () => actions.completedPage(page - 1), page === 0);
    this.button(697, 544, '›', 'production-completed-next', () => actions.completedPage(page + 1), page >= completed.length - 1);
    const record = completed[page];
    this.label(46, 594, record ? `${page + 1}/${completed.length} · #${record.id} ${short(record.design.name, 56)}`
      : 'Готовых записей пока нет.', 'production-completed', 16);
    this.button(650, 587, 'Разместить', 'production-deploy', () => { if (record) actions.deploy(record.id); }, !record);
    this.label(46, 627, `Корабли стороны: ${session.ships.length}/${MAX_CAMPAIGN_SHIPS} · В этой колонии, бесплатно, без смены хода`,
      'production-deploy-hint', 13);
  }

  private label(x: number, y: number, value: string, name: string, size = 15): void {
    const width = name === 'production-title' ? 290 : name === 'production-completed' ? 570
      : name === 'production-design' || name.startsWith('production-order-') || name.startsWith('production-progress-') ? 435 : 745;
    const text = this.scene.add.text(x, y, value, { fontFamily: 'Arial', fontSize: `${size}px`, color: '#c8d9ed' }).setName(name);
    // Word wrapping + maxLines can hide the entire name after an order ID.
    // Fit the actual glyphs instead, retaining a visible prefix and ellipsis.
    let end = value.length;
    while (text.width > width && end > 0) text.setText(`${value.slice(0, --end).trimEnd()}…`);
    this.root.add(text);
  }
  private button(x: number, y: number, value: string, name: string, action: () => void, disabled = false): void {
    disabled ||= this.readOnly && (name === 'production-enqueue' || name === 'production-deploy' || name.startsWith('production-cancel-'));
    const text = this.scene.add.text(x, y, value, { fontFamily: 'Arial', fontSize: '13px', color: disabled || this.blocked ? '#65768d' : '#e3f5ff' })
      .setName(name).setPadding(10, 8).setBackgroundColor('#233e58');
    this.root.add(text);
    if (!disabled && !this.blocked) text.setInteractive({ useHandCursor: true }).on('pointerdown', () => { if (!this.disposed) action(); });
  }
  destroy(): void { if (!this.disposed) { this.disposed = true; this.travel?.destroy(); this.fleets?.destroy(); this.root.destroy(); } }
}
