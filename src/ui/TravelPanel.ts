import type Phaser from 'phaser';
import type { SystemId } from '../domain/campaign';
import type { CampaignSessionView } from '../domain/campaignSession';
import { CAMPAIGN_FUEL_CAPACITY, getRefuelQuote, isShipAtColony, MAX_CAMPAIGN_SHIPS, TRAVEL_FUEL_COST } from '../domain/campaignShips';

export interface TravelPanelState {
  destinationIndex: number;
  transitPage: number;
  shipsPage: number;
}
export interface TravelPanelActions {
  destination: (index: number) => void;
  transitPage: (page: number) => void;
  shipsPage: (page: number) => void;
  send: (shipId: number, destinationId: SystemId) => void;
  refuel: (shipId: number) => void;
}

/** Own projected ships and public projected lanes only; no full state or map definition. */
export class TravelPanel {
  private readonly root: Phaser.GameObjects.Container;
  private disposed = false;

  constructor(private readonly scene: Phaser.Scene, view: CampaignSessionView, source: SystemId,
    state: TravelPanelState, actions: TravelPanelActions, private readonly blocked: boolean) {
    this.root = scene.add.container(0, 0).setName('travel-panel');
    const ships = view.ships.filter(ship => isShipAtColony(ship, source));
    const destinations = view.galaxy.systems.filter(system => system.visibility === 'explored' &&
      system.ownerId === view.galaxy.factionId && view.galaxy.lanes.some(([a, b]) =>
        (a === source && b === system.id) || (b === source && a === system.id)));
    const trips = view.ships.filter(ship => ship.transit);
    const shipPage = Math.max(0, Math.min(state.shipsPage, ships.length - 1));
    const destPage = Math.max(0, Math.min(state.destinationIndex, destinations.length - 1));
    const tripPage = Math.max(0, Math.min(state.transitPage, trips.length - 1));
    const ship = ships[shipPage], destination = destinations[destPage], trip = trips[tripPage];
    this.label(46, 265, `В ЭТОЙ КОЛОНИИ: ${ships.length}`, 'travel-ships-title');
    this.button(650, 256, '‹', 'travel-ships-prev', () => actions.shipsPage(shipPage - 1), shipPage === 0);
    this.button(697, 256, '›', 'travel-ships-next', () => actions.shipsPage(shipPage + 1), shipPage >= ships.length - 1);
    this.label(46, 306, ship ? `${shipPage + 1}/${ships.length} · #${ship.id} ${ship.design.name}` : 'Нет кораблей для отправки.', 'travel-ship');
    const quote = ship ? getRefuelQuote(ship.fuel) : undefined;
    this.label(46, 336, ship ? `Топливо: ${ship.fuel}/${CAMPAIGN_FUEL_CAPACITY} · ${ship.fuel === 0 ? 'Бак пуст' : quote?.amount === 0 ? 'Бак полон' : 'Стратегический запас'}`
      : 'Топливо: нет выбранного корабля', 'travel-fuel');
    this.label(46, 364, quote ? `До полного: +${quote.amount} · Цена: ${quote.cost.credits} кр. / ${quote.cost.minerals} мин.`
      : 'Заправка недоступна без корабля в колонии.', 'travel-refuel-quote', 570);
    this.button(650, 356, 'Заправить', 'travel-refuel', () => { if (ship) actions.refuel(ship.id); }, !quote?.amount);
    this.label(46, 410, destination ? `Цель ${destPage + 1}/${destinations.length}: ${destination.name}`
      : 'Нет соседних собственных колоний.', 'travel-destination', 400);
    this.button(490, 401, '‹', 'travel-destination-prev', () => actions.destination(destPage - 1), destPage === 0);
    this.button(535, 401, '›', 'travel-destination-next', () => actions.destination(destPage + 1), destPage >= destinations.length - 1);
    this.button(650, 401, 'Отправить', 'travel-send', () => {
      if (ship && destination) actions.send(ship.id, destination.id);
    }, !ship || !destination);
    this.label(46, 449, `Расход: ${TRAVEL_FUEL_COST} топливо · Прибытие в конце своего хода`, 'travel-rule');
    this.label(46, 490, `В ПУТИ У СТОРОНЫ: ${trips.length}`, 'travel-transit-title');
    this.button(650, 481, '‹', 'travel-transit-prev', () => actions.transitPage(tripPage - 1), tripPage === 0);
    this.button(697, 481, '›', 'travel-transit-next', () => actions.transitPage(tripPage + 1), tripPage >= trips.length - 1);
    this.label(46, 530, trip ? `${tripPage + 1}/${trips.length} · #${trip.id} ${trip.design.name}` : 'Кораблей в пути нет.', 'travel-transit');
    const name = (id: SystemId) => view.galaxy.systems.find(system => system.id === id)!.name;
    this.label(46, 563, trip?.transit ? `${name(trip.systemId)} → ${name(trip.transit.destinationId)} · Осталось: 1 свой ход` : '', 'travel-route');
    this.label(46, 598, `Всего кораблей: ${view.ships.length}/${MAX_CAMPAIGN_SHIPS} · В пути тоже занимают место.`, 'travel-count');
    const fleet = ship ? view.fleets.find(item => item.shipIds.includes(ship.id)) : undefined;
    this.label(46, 628, fleet ? `Группа #${fleet.id}: для одиночного вылета расформируйте в «Группы».`
      : 'Заправка: только в своей колонии, без смены хода. Боя нет.', 'travel-limit');
  }

  private label(x: number, y: number, value: string, name: string, width = 745): void {
    const clean = value.replace(/\s+/g, ' ');
    const text = this.scene.add.text(x, y, clean, { fontFamily: 'Arial', fontSize: '15px', color: '#c8d9ed' }).setName(name);
    let end = clean.length;
    while (text.width > width && end > 0) text.setText(`${clean.slice(0, --end).trimEnd()}…`);
    this.root.add(text);
  }
  private button(x: number, y: number, value: string, name: string, action: () => void, disabled: boolean): void {
    const text = this.scene.add.text(x, y, value, { fontFamily: 'Arial', fontSize: '13px', color: disabled || this.blocked ? '#65768d' : '#e3f5ff' })
      .setName(name).setPadding(10, 8).setBackgroundColor('#233e58');
    this.root.add(text);
    if (!disabled && !this.blocked) text.setInteractive({ useHandCursor: true }).on('pointerdown', () => { if (!this.disposed) action(); });
  }
  destroy(): void { if (!this.disposed) { this.disposed = true; this.root.destroy(); } }
}
