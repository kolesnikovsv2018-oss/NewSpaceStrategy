import type Phaser from 'phaser';
import type { SystemId } from '../domain/campaign';
import type { CampaignSessionView } from '../domain/campaignSession';
import { getFleetTransit, isFleetAtColony, MAX_CAMPAIGN_FLEETS } from '../domain/campaignFleets';
import { CAMPAIGN_FUEL_CAPACITY, MAX_CAMPAIGN_SHIPS, TRAVEL_FUEL_COST } from '../domain/campaignShips';

export interface FleetTravelPanelState {
  fleetPage: number;
  destinationIndex: number;
  transitPage: number;
}
export interface FleetTravelPanelActions {
  fleetPage: (page: number) => void;
  destination: (index: number) => void;
  transitPage: (page: number) => void;
  send: (fleetId: number, destinationId: SystemId) => void;
}

/** Read-only own projection. Route and fuel are derived, never cached in UI state. */
export class FleetTravelPanel {
  private readonly root: Phaser.GameObjects.Container;
  private disposed = false;

  constructor(private readonly scene: Phaser.Scene, view: CampaignSessionView, source: SystemId,
    state: FleetTravelPanelState, actions: FleetTravelPanelActions, private readonly blocked: boolean,
    private readonly readOnly = false) {
    this.root = scene.add.container(0, 0).setName('fleet-travel-panel');
    const fleets = view.fleets.filter(fleet => isFleetAtColony(fleet, view.ships, source));
    const trips = view.fleets.filter(fleet => getFleetTransit(fleet, view.ships));
    const destinations = view.galaxy.systems.filter(system => system.visibility === 'explored' &&
      system.ownerId === view.galaxy.factionId && view.galaxy.lanes.some(([a, b]) =>
        (a === source && b === system.id) || (b === source && a === system.id)));
    const fleetPage = Math.max(0, Math.min(state.fleetPage, fleets.length - 1));
    const destPage = Math.max(0, Math.min(state.destinationIndex, destinations.length - 1));
    const tripPage = Math.max(0, Math.min(state.transitPage, trips.length - 1));
    const fleet = fleets[fleetPage], destination = destinations[destPage], trip = trips[tripPage];
    const members = fleet ? view.ships.filter(ship => fleet.shipIds.includes(ship.id)) : [];
    const empty = members.filter(ship => ship.fuel < TRAVEL_FUEL_COST).length;
    this.label(46, 265, `ГРУППЫ В КОЛОНИИ: ${fleets.length}`, 'fleet-travel-title', 590);
    this.button(650, 256, '‹', 'fleet-travel-prev', () => actions.fleetPage(fleetPage - 1), fleetPage === 0);
    this.button(697, 256, '›', 'fleet-travel-next', () => actions.fleetPage(fleetPage + 1), fleetPage >= fleets.length - 1);
    this.label(46, 306, fleet ? `${fleetPage + 1}/${fleets.length} · Группа #${fleet.id} · Кораблей: ${members.length}`
      : 'Нет групп для отправки из этой колонии.', 'fleet-travel-current');
    this.label(46, 338, fleet ? `Минимальный бак: ${Math.min(...members.map(ship => ship.fuel))}/${CAMPAIGN_FUEL_CAPACITY} · Без топлива: ${empty}/${members.length}`
      : 'Создайте группу во вкладке «Группы».', 'fleet-travel-fuel');
    this.label(46, 370, destination ? `Цель ${destPage + 1}/${destinations.length}: ${destination.name}`
      : 'Нет соседних собственных колоний.', 'fleet-travel-destination', 400);
    this.button(490, 361, '‹', 'fleet-travel-destination-prev', () => actions.destination(destPage - 1), destPage === 0);
    this.button(535, 361, '›', 'fleet-travel-destination-next', () => actions.destination(destPage + 1), destPage >= destinations.length - 1);
    this.button(650, 361, 'Отправить', 'fleet-travel-send', () => {
      if (fleet && destination) actions.send(fleet.id, destination.id);
    }, !fleet || !destination);
    this.label(46, 411, `Расход: ${TRAVEL_FUEL_COST} у каждого · Прибытие вместе в конце своего хода`, 'fleet-travel-rule');
    this.label(46, 440, 'Нужна заправка? «Перелёты» → каждый участник отдельно.', 'fleet-travel-refuel-hint');
    this.label(46, 481, `ГРУППЫ В ПУТИ У СТОРОНЫ: ${trips.length}`, 'fleet-travel-transit-title', 590);
    this.button(650, 472, '‹', 'fleet-travel-transit-prev', () => actions.transitPage(tripPage - 1), tripPage === 0);
    this.button(697, 472, '›', 'fleet-travel-transit-next', () => actions.transitPage(tripPage + 1), tripPage >= trips.length - 1);
    this.label(46, 523, trip ? `${tripPage + 1}/${trips.length} · Группа #${trip.id} · Кораблей: ${trip.shipIds.length}`
      : 'Групп в пути нет.', 'fleet-travel-transit');
    const route = trip ? getFleetTransit(trip, view.ships) : undefined;
    const name = (id: SystemId) => view.galaxy.systems.find(system => system.id === id)!.name;
    this.label(46, 555, trip && route ? `${name(trip.systemId)} → ${name(route.destinationId)} · Осталось: ${route.remainingTurns} свой ход`
      : '', 'fleet-travel-route');
    this.label(46, 594, `Всего групп: ${view.fleets.length}/${MAX_CAMPAIGN_FLEETS} · Кораблей: ${view.ships.length}/${MAX_CAMPAIGN_SHIPS} · В пути тоже учитываются.`, 'fleet-travel-count');
    this.label(46, 628, 'В пути нельзя перенаправить, расформировать или заправить.', 'fleet-travel-limit');
  }

  private label(x: number, y: number, value: string, name: string, width = 745): void {
    const clean = value.replace(/\s+/g, ' ');
    const text = this.scene.add.text(x, y, clean, { fontFamily: 'Arial', fontSize: '15px', color: '#c8d9ed' }).setName(name);
    let end = clean.length;
    while (text.width > width && end > 0) text.setText(`${clean.slice(0, --end).trimEnd()}…`);
    this.root.add(text);
  }
  private button(x: number, y: number, value: string, name: string, action: () => void, disabled: boolean): void {
    disabled ||= this.readOnly && name === 'fleet-travel-send';
    const text = this.scene.add.text(x, y, value, { fontFamily: 'Arial', fontSize: '13px', color: disabled || this.blocked ? '#65768d' : '#e3f5ff' })
      .setName(name).setPadding(10, 8).setBackgroundColor('#233e58');
    this.root.add(text);
    if (!disabled && !this.blocked) text.setInteractive({ useHandCursor: true }).on('pointerdown', () => { if (!this.disposed) action(); });
  }
  destroy(): void { if (!this.disposed) { this.disposed = true; this.root.destroy(); } }
}
