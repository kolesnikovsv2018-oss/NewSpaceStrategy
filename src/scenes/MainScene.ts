import Phaser from 'phaser';
import type { CampaignFactionId, SystemId } from '../domain/campaign';
import { createCampaignSession, executeSessionCommand, getCampaignSessionView,
  type CampaignSession, type SessionCommand } from '../domain/campaignSession';
import { CampaignPanel } from '../ui/CampaignPanel';
import { designSchema } from '../domain/shipDesign';
import { isShipAtColony } from '../domain/campaignShips';
import { getFleetTransit, isFleetAtColony, isShipInFleet, MAX_FLEET_SHIPS } from '../domain/campaignFleets';
import { loadProductionCatalog, type ProductionCatalog } from '../utils/ProductionCatalog';

/** Owns the turn-based session; observation never changes the active faction. */
export class MainScene extends Phaser.Scene {
  private campaign?: CampaignSession;
  private factionId: CampaignFactionId = 'blue';
  private selectedId: SystemId = 'sol';
  private panel?: CampaignPanel;
  private message = '';
  private error = false;
  private pending?: 'new' | 'menu';
  private productionOpen = false;
  private catalog?: ProductionCatalog;
  private choiceIndex = 0;
  private completedPage = 0;
  private shipsPage = 0;
  private showShips = false;
  private travelOpen = false;
  private destinationIndex = 0;
  private transitPage = 0;
  private fleetsOpen = false;
  private fleetShipIds: number[] = [];
  private fleetCandidatePage = 0;
  private fleetPage = 0;
  private fleetMemberPage = 0;
  private fleetTravelOpen = false;
  private fleetDestinationIndex = 0;
  private fleetTransitPage = 0;

  constructor() { super({ key: 'MainScene' }); }

  create(): void {
    this.cameras.main.setBackgroundColor('#070f1e');
    this.resetCampaign();
    this.input.keyboard?.on('keydown-ESC', this.onEscape);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off('keydown-ESC', this.onEscape);
      this.panel?.destroy(); this.panel = undefined;
      this.campaign = undefined; this.pending = undefined;
      this.message = ''; this.error = false;
      this.catalog = undefined; this.productionOpen = false; this.choiceIndex = 0; this.completedPage = 0;
      this.shipsPage = 0; this.showShips = false;
      this.resetTravel();
    });
  }

  private resetCampaign(): void {
    this.resetTravel();
    this.campaign = createCampaignSession();
    this.factionId = 'blue'; this.selectedId = 'sol'; this.pending = undefined;
    this.productionOpen = false; this.catalog = undefined; this.choiceIndex = 0; this.completedPage = 0;
    this.shipsPage = 0; this.showShips = false;
    this.message = 'Выберите соседнюю систему и отправьте разведку.'; this.error = false;
    this.render();
  }

  private render(): void {
    if (!this.campaign) return;
    this.panel?.destroy();
    // Capture what this panel displayed, not mutable scene fields at invocation time.
    const expectedTurn = this.campaign.turn, factionId = this.factionId, systemId = this.selectedId;
    const choice = this.catalog?.choices[this.choiceIndex];
    const design = choice?.quote ? designSchema.parse(choice.design) : undefined;
    const view = getCampaignSessionView(this.campaign, factionId);
    const candidates = view.ships.filter(ship => isShipAtColony(ship, systemId) && !isShipInFleet(view.fleets, ship.id));
    this.fleetShipIds = this.fleetShipIds.filter(id => candidates.some(ship => ship.id === id));
    this.fleetCandidatePage = Math.max(0, Math.min(this.fleetCandidatePage, candidates.length - 1));
    const fleets = view.fleets.filter(fleet => isFleetAtColony(fleet, view.ships, systemId));
    this.fleetPage = Math.max(0, Math.min(this.fleetPage, fleets.length - 1));
    this.fleetMemberPage = Math.max(0, Math.min(this.fleetMemberPage, (fleets[this.fleetPage]?.shipIds.length ?? 0) - 1));
    this.fleetTransitPage = Math.max(0, Math.min(this.fleetTransitPage, view.fleets.filter(fleet => getFleetTransit(fleet, view.ships)).length - 1));
    this.transitPage = Math.max(0, Math.min(this.transitPage, view.ships.filter(ship => ship.transit).length - 1));
    this.completedPage = Math.max(0, Math.min(this.completedPage, view.production.completed.filter(record => record.systemId === systemId).length - 1));
    this.shipsPage = Math.max(0, Math.min(this.shipsPage, view.ships.filter(ship => isShipAtColony(ship, systemId)).length - 1));
    this.panel = new CampaignPanel(this, view, {
      selectedId: this.selectedId, message: this.message, error: this.error, pending: this.pending,
      production: this.productionOpen && this.catalog ? { catalog: this.catalog, choiceIndex: this.choiceIndex,
        completedPage: this.completedPage, shipsPage: this.shipsPage, showShips: this.showShips,
        travel: this.travelOpen ? { shipsPage: this.shipsPage, destinationIndex: this.destinationIndex, transitPage: this.transitPage } : undefined,
        fleets: this.fleetsOpen ? { selectedShipIds: [...this.fleetShipIds], candidatePage: this.fleetCandidatePage,
          fleetPage: this.fleetPage, memberPage: this.fleetMemberPage,
          travel: this.fleetTravelOpen ? { fleetPage: this.fleetPage, destinationIndex: this.fleetDestinationIndex, transitPage: this.fleetTransitPage } : undefined } : undefined } : undefined
    }, {
      select: id => {
        if (this.pending) return;
        this.selectedId = id; this.completedPage = 0; this.shipsPage = 0; this.showShips = false;
        this.resetTravel();
        this.message = ''; this.error = false; this.render();
      },
      switchSide: () => {
        if (this.pending) return;
        this.factionId = this.factionId === 'blue' ? 'red' : 'blue';
        this.choiceIndex = 0; this.completedPage = 0;
        this.shipsPage = 0; this.showShips = false;
        this.resetTravel();
        this.message = ''; this.error = false; this.render();
      },
      command: kind => this.execute(kind === 'endTurn'
        ? { kind, factionId, expectedTurn } : { kind, factionId, systemId, expectedTurn }),
      toggleProduction: () => {
        if (this.pending) return;
        this.productionOpen = !this.productionOpen;
        this.resetTravel();
        if (this.productionOpen && !this.catalog) this.catalog = loadProductionCatalog();
        this.message = ''; this.error = false; this.render();
      },
      production: {
        choose: index => {
          if (this.pending || !this.catalog || index < 0 || index >= this.catalog.choices.length) return;
          this.choiceIndex = index; this.message = ''; this.error = false; this.render();
        },
        refresh: () => {
          if (this.pending) return;
          this.catalog = loadProductionCatalog(); this.choiceIndex = 0;
          this.message = ''; this.error = false; this.render();
        },
        enqueue: () => { if (design) this.execute({ kind: 'enqueueProduction', factionId, systemId, expectedTurn, design }); },
        cancelOrder: orderId => this.execute({ kind: 'cancelProduction', factionId, systemId, expectedTurn, orderId }),
        completedPage: page => { if (this.pending) return; this.completedPage = page; this.render(); },
        shipsPage: page => { if (this.pending) return; this.shipsPage = page; this.render(); },
        toggleShips: () => { if (this.pending) return; this.showShips = !this.showShips; this.render(); },
        deploy: orderId => this.execute({ kind: 'deployProduction', factionId, systemId, expectedTurn, orderId }),
        toggleTravel: () => {
          if (this.pending) return;
          this.resetFleets();
          this.travelOpen = !this.travelOpen; this.destinationIndex = 0; this.transitPage = 0;
          this.message = ''; this.error = false; this.render();
        },
        toggleFleets: () => {
          if (this.pending) return;
          const open = !this.fleetsOpen;
          this.resetTravel(); this.fleetsOpen = open;
          this.message = ''; this.error = false; this.render();
        },
        fleets: {
          candidatePage: page => { if (this.pending) return; this.fleetCandidatePage = page; this.render(); },
          fleetPage: page => { if (this.pending) return; this.fleetPage = page; this.fleetMemberPage = 0; this.fleetDestinationIndex = 0; this.render(); },
          memberPage: page => { if (this.pending) return; this.fleetMemberPage = page; this.render(); },
          toggleShip: id => {
            if (this.pending) return;
            if (this.fleetShipIds.includes(id)) this.fleetShipIds = this.fleetShipIds.filter(item => item !== id);
            else if (candidates.some(ship => ship.id === id) && this.fleetShipIds.length < MAX_FLEET_SHIPS) this.fleetShipIds.push(id);
            this.render();
          },
          clear: () => { if (this.pending) return; this.fleetShipIds = []; this.render(); },
          create: shipIds => this.execute({ kind: 'createFleet', factionId, expectedTurn, systemId, shipIds }),
          disband: fleetId => this.execute({ kind: 'disbandFleet', factionId, expectedTurn, systemId, fleetId }),
          toggleTravel: () => {
            if (this.pending) return;
            const open = !this.fleetTravelOpen;
            this.resetFleetTravel(); this.fleetTravelOpen = open; this.fleetShipIds = [];
            this.message = ''; this.error = false; this.render();
          },
          travel: {
            fleetPage: page => { if (this.pending) return; this.fleetPage = page; this.fleetMemberPage = 0; this.fleetDestinationIndex = 0; this.render(); },
            destination: index => { if (this.pending) return; this.fleetDestinationIndex = index; this.render(); },
            transitPage: page => { if (this.pending) return; this.fleetTransitPage = page; this.render(); },
            send: (fleetId, destinationId) => this.execute({ kind: 'sendFleet', factionId, expectedTurn, systemId, fleetId, destinationId })
          }
        },
        travel: {
          shipsPage: page => { if (this.pending) return; this.shipsPage = page; this.destinationIndex = 0; this.render(); },
          destination: index => { if (this.pending) return; this.destinationIndex = index; this.render(); },
          transitPage: page => { if (this.pending) return; this.transitPage = page; this.render(); },
          send: (shipId, destinationId) => this.execute({ kind: 'sendShip', factionId, expectedTurn, systemId, shipId, destinationId }),
          refuel: shipId => this.execute({ kind: 'refuelShip', factionId, expectedTurn, systemId, shipId })
        }
      },
      request: action => { if (this.pending) return; this.pending = action; this.render(); },
      cancel: () => { this.pending = undefined; this.render(); },
      confirm: () => {
        const action = this.pending; this.pending = undefined;
        if (action === 'new') this.resetCampaign();
        else if (action === 'menu') this.scene.start('MenuScene');
      }
    });
  }

  private execute(command: SessionCommand): void {
    if (!this.campaign || this.pending) return;
    const result = executeSessionCommand(this.campaign, command);
    this.error = !result.ok;
    if (result.ok) {
      this.campaign = result.state;
      if (command.kind === 'endTurn') this.fleetShipIds = [];
      if (command.kind === 'createFleet') {
        this.fleetShipIds = []; this.fleetMemberPage = 0;
        this.fleetPage = result.state.fleets.items.filter(fleet => fleet.factionId === command.factionId && isFleetAtColony(fleet, result.state.ships, command.systemId)).length - 1;
      }
      if (command.kind === 'disbandFleet') this.fleetMemberPage = 0;
      if (command.kind === 'sendFleet') {
        this.fleetDestinationIndex = 0; this.fleetMemberPage = 0;
        this.fleetTransitPage = result.state.fleets.items.filter(fleet => fleet.factionId === command.factionId && getFleetTransit(fleet, result.state.ships))
          .findIndex(fleet => fleet.id === command.fleetId);
      }
      if (command.kind === 'sendShip') {
        this.destinationIndex = 0;
        this.transitPage = result.state.ships.filter(ship => ship.factionId === command.factionId && ship.transit)
          .findIndex(ship => ship.id === command.shipId);
      }
      if (command.kind === 'deployProduction') {
        this.shipsPage = result.state.ships.filter(ship => ship.factionId === command.factionId && isShipAtColony(ship, command.systemId)).length - 1;
      }
      const receipt = result.endTurnEconomy;
      this.message = receipt ? `Ход передан. Доход: +${receipt.income.credits} кр. / +${receipt.income.minerals} мин. ` +
        `Содержание: ${receipt.upkeep.paidCredits}/${receipt.upkeep.dueCredits} кр. ` +
        `Дефицит: ${receipt.upkeep.shortfallCredits} кр. (без долга).`
        : command.kind === 'explore' ? 'Система разведана.' : command.kind === 'colonize' ? 'Колония основана.'
        : command.kind === 'enqueueProduction' ? 'Заказ оплачен и добавлен в очередь.'
        : command.kind === 'cancelProduction' ? 'Заказ отменён. Возврат за оставшиеся ходы начислен.'
        : command.kind === 'refuelShip' ? 'Корабль заправлен. Ресурсы списаны.'
        : command.kind === 'createFleet' ? 'Группа кораблей создана.'
        : command.kind === 'sendFleet' ? 'Группа отправлена; все участники прибудут в конце своего хода.'
        : command.kind === 'disbandFleet' ? 'Группа расформирована. Корабли остаются в колонии.'
        : command.kind === 'deployProduction' ? 'Корабль размещён в колонии.' : 'Корабль отправлен; прибытие при завершении своего хода.';
    } else this.message = result.message;
    this.render();
  }

  private onEscape = (): void => {
    if (!this.campaign) return;
    if (!this.pending && this.fleetTravelOpen) { this.resetFleetTravel(); this.render(); return; }
    if (!this.pending && this.fleetsOpen) { this.resetFleets(); this.render(); return; }
    if (!this.pending && this.travelOpen) { this.resetTravel(); this.render(); return; }
    if (!this.pending && this.productionOpen) { this.productionOpen = false; this.render(); return; }
    this.pending = this.pending ? undefined : 'menu';
    this.render();
  };

  private resetTravel(): void {
    this.resetFleets();
    this.travelOpen = false; this.destinationIndex = 0; this.transitPage = 0;
  }

  private resetFleets(): void {
    this.resetFleetTravel();
    this.fleetsOpen = false; this.fleetShipIds = []; this.fleetCandidatePage = 0; this.fleetPage = 0; this.fleetMemberPage = 0;
  }

  private resetFleetTravel(): void {
    this.fleetTravelOpen = false; this.fleetDestinationIndex = 0; this.fleetTransitPage = 0;
  }
}