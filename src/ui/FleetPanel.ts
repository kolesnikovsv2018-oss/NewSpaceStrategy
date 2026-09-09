import type Phaser from 'phaser';
import type { SystemId } from '../domain/campaign';
import type { CampaignSessionView } from '../domain/campaignSession';
import { CAMPAIGN_FUEL_CAPACITY, isShipAtColony } from '../domain/campaignShips';
import { isFleetAtColony, isShipInFleet, MAX_CAMPAIGN_FLEETS, MAX_FLEET_SHIPS } from '../domain/campaignFleets';
import { FleetTravelPanel, type FleetTravelPanelState, type FleetTravelPanelActions } from './FleetTravelPanel';

export interface FleetPanelState {
  selectedShipIds: number[];
  candidatePage: number;
  fleetPage: number;
  memberPage: number;
  travel?: FleetTravelPanelState;
}
export interface FleetPanelActions {
  candidatePage: (page: number) => void;
  fleetPage: (page: number) => void;
  memberPage: (page: number) => void;
  toggleShip: (id: number) => void;
  clear: () => void;
  create: (shipIds: number[]) => void;
  disband: (fleetId: number) => void;
  toggleTravel: () => void;
  travel: FleetTravelPanelActions;
}

/** Own colony projection only. Selection is a UI draft, never membership in the model. */
export class FleetPanel {
  private readonly root: Phaser.GameObjects.Container;
  private disposed = false;
  private travel?: FleetTravelPanel;

  constructor(private readonly scene: Phaser.Scene, view: CampaignSessionView, source: SystemId,
    state: FleetPanelState, actions: FleetPanelActions, private readonly blocked: boolean) {
    this.root = scene.add.container(0, 0).setName('fleet-panel');
    this.button(650, 216, state.travel ? '← Группы' : 'Маршруты', 'fleet-travel', actions.toggleTravel);
    if (state.travel) {
      this.travel = new FleetTravelPanel(scene, view, source, state.travel, actions.travel, blocked);
      return;
    }
    const candidates = view.ships.filter(ship => isShipAtColony(ship, source) && !isShipInFleet(view.fleets, ship.id));
    const fleets = view.fleets.filter(fleet => isFleetAtColony(fleet, view.ships, source));
    const candidatePage = Math.max(0, Math.min(state.candidatePage, candidates.length - 1));
    const fleetPage = Math.max(0, Math.min(state.fleetPage, fleets.length - 1));
    const ship = candidates[candidatePage], fleet = fleets[fleetPage];
    const memberPage = Math.max(0, Math.min(state.memberPage, (fleet?.shipIds.length ?? 0) - 1));
    const member = view.ships.find(item => item.id === fleet?.shipIds[memberPage]);
    // Capture a detached list displayed on this render, not the mutable scene selection.
    const selected = [...state.selectedShipIds];
    const included = !!ship && selected.includes(ship.id);
    this.label(46, 265, `СВОБОДНЫЕ КОРАБЛИ: ${candidates.length}`, 'fleet-candidates-title');
    this.button(650, 256, '‹', 'fleet-candidate-prev', () => actions.candidatePage(candidatePage - 1), candidatePage === 0);
    this.button(697, 256, '›', 'fleet-candidate-next', () => actions.candidatePage(candidatePage + 1), candidatePage >= candidates.length - 1);
    this.label(46, 304, ship ? `${candidatePage + 1}/${candidates.length} · #${ship.id} ${ship.design.name}` : 'Нет свободных стоящих кораблей.', 'fleet-candidate');
    this.label(46, 337, ship ? `${included ? '✓ Выбран' : 'Не выбран'} · Топливо: ${ship.fuel}/${CAMPAIGN_FUEL_CAPACITY}` : 'Разместите корабли или расформируйте группу.', 'fleet-selection', 540);
    this.button(650, 328, included ? 'Убрать' : 'Выбрать', 'fleet-select', () => { if (ship) actions.toggleShip(ship.id); },
      !ship || (!included && selected.length >= MAX_FLEET_SHIPS));
    this.label(46, 375, `Выбрано: ${selected.length}/${MAX_FLEET_SHIPS} · Нужно минимум 2`, 'fleet-selection-count', 430);
    this.button(490, 366, 'Очистить', 'fleet-clear', actions.clear, !selected.length);
    this.button(650, 366, 'Создать', 'fleet-create', () => actions.create([...selected]), selected.length < 2);
    this.label(46, 414, 'Создание и расформирование бесплатны, без смены хода.', 'fleet-rule');
    this.label(46, 451, `ГРУППЫ КОЛОНИИ: ${fleets.length} · У стороны: ${view.fleets.length}/${MAX_CAMPAIGN_FLEETS}`, 'fleet-count', 590);
    this.button(650, 442, '‹', 'fleet-prev', () => actions.fleetPage(fleetPage - 1), fleetPage === 0);
    this.button(697, 442, '›', 'fleet-next', () => actions.fleetPage(fleetPage + 1), fleetPage >= fleets.length - 1);
    this.label(46, 490, fleet ? `${fleetPage + 1}/${fleets.length} · Группа #${fleet.id} · Кораблей: ${fleet.shipIds.length}` : 'Групп в этой колонии нет.', 'fleet-current', 540);
    this.button(610, 481, 'Расформировать', 'fleet-disband', () => { if (fleet) actions.disband(fleet.id); }, !fleet);
    this.label(46, 532, member ? `${memberPage + 1}/${fleet!.shipIds.length} · #${member.id} ${member.design.name}` : 'Нет участников для просмотра.', 'fleet-member', 590);
    this.button(650, 523, '‹', 'fleet-member-prev', () => actions.memberPage(memberPage - 1), memberPage === 0);
    this.button(697, 523, '›', 'fleet-member-next', () => actions.memberPage(memberPage + 1), !fleet || memberPage >= fleet.shipIds.length - 1);
    this.label(46, 565, member ? `Топливо: ${member.fuel}/${CAMPAIGN_FUEL_CAPACITY} · Заправка — во вкладке «Перелёты».` : '', 'fleet-member-fuel');
    this.label(46, 601, 'Для одиночной отправки сначала расформируйте группу.', 'fleet-send-hint');
    this.label(46, 628, 'Отправка группы — «Маршруты» сверху. Состав не редактируется.', 'fleet-limit');
  }

  private label(x: number, y: number, value: string, name: string, width = 745): void {
    const clean = value.replace(/\s+/g, ' ');
    const text = this.scene.add.text(x, y, clean, { fontFamily: 'Arial', fontSize: '15px', color: '#c8d9ed' }).setName(name);
    let end = clean.length;
    while (text.width > width && end > 0) text.setText(`${clean.slice(0, --end).trimEnd()}…`);
    this.root.add(text);
  }
  private button(x: number, y: number, value: string, name: string, action: () => void, disabled = false): void {
    const text = this.scene.add.text(x, y, value, { fontFamily: 'Arial', fontSize: '13px', color: disabled || this.blocked ? '#65768d' : '#e3f5ff' })
      .setName(name).setPadding(10, 8).setBackgroundColor('#233e58');
    this.root.add(text);
    if (!disabled && !this.blocked) text.setInteractive({ useHandCursor: true }).on('pointerdown', () => { if (!this.disposed) action(); });
  }
  destroy(): void { if (!this.disposed) { this.disposed = true; this.travel?.destroy(); this.root.destroy(); } }
}
