import { createConquest, conquestSchema, executeConquestCommand, convertConquestToLocal, getConquestView,
  getConquestOutcome, type Conquest, type ConquestCommand, type ConquestResult, type ConquestView } from '../domain/conquest';
import { buildConquestDesigns, executeConquestAiTurn } from '../domain/conquestAi';
import { getDefaultResearchTree, getResearchAccess, isCampaignDesignAvailable, describeResearchEffect, getResearchProgress } from '../domain/campaignResearch';
import { getColonyProductionQuote, getColonyProductionRefund, getColonyProjectRefund, type Workforce } from '../domain/campaignOutput';
import { getTravelCapabilities, getFleetTravelQuotes, getStrategicRefuelQuote, formatStrategicFuel, getWorldDistance } from '../domain/campaignTravel';
import { getFleetTransit } from '../domain/campaignFleets';
import { getRepairQuote, getAmmunitionQuote, getRefitQuote } from '../domain/campaignOperations';
import { HULLS, type ShipDesign } from '../domain/shipDesign';
import { createColonizerDesign } from '../domain/civilianPresets';
import type { BattleFrame } from '../domain/conquestBattle';
import { getGalaxyDefinition, type CampaignFactionId, type SystemId } from '../domain/campaign';
import { MAX_GALAXY_WORLDS } from '../domain/galaxyMap';
import { generateBrowserGalaxy, createGalaxySeed } from '../utils/BrowserGalaxyGenerator';
import { LocalGalaxyMapRepository, type GalaxyMapRepository } from '../utils/GalaxyMapRepository';
import { ConquestSaveManager } from '../utils/ConquestSaveManager';
import { parseResearchTreeYaml, MAX_RESEARCH_TREE_BYTES } from '../utils/ResearchTreeYaml';
import { button, text, fitText, chooseItem, conquestDialogLayout, CONQUEST_HELP } from '../ui/ConquestWidgets';
import { resizeCampaignViewport } from '../ui/CampaignViewport';
import { openShipyardModal, closeShipyardModal, isShipyardModalOpen } from '../ui/ShipyardModal';
import { CampaignProjectPanel } from '../ui/CampaignProjectPanel';
import { GalaxyMapWidget, type GalaxyMapState } from '../ui/GalaxyMapWidget';

type Tab = 'research' | 'production' | 'fleet' | 'battles';
function productionTiming(view: ConquestView, systemId: SystemId): string {
  const forecast = view.colonyOutput.forecast.production.find(row => row.systemId === systemId);
  if (!forecast?.orderId) return 'нет заказа';
  return forecast.remainingOwnTurns === null ? 'приостановлено: нет промышленности' :
    `головной заказ: ${forecast.remainingOwnTurns} своих ходов`;
}
function researchTiming(view: ConquestView): string {
  const timing = view.researchForecast.timing;
  if ('remainingOwnTurns' in timing) return `срок: ${timing.remainingOwnTurns} своих ходов`;
  if (timing.status === 'unavailable') return timing.reason === 'turn-limit' ? 'недоступно: предел хода' : 'партия завершена';
  return timing.reason === 'no-project' ? 'проект не выбран' : timing.reason === 'no-colonies'
    ? 'пауза: нет колоний' : 'пауза: недостаточно науки, дальнейший срок неизвестен';
}

export class ConquestScene extends Phaser.Scene {
  private state!: Conquest;
  private observer: CampaignFactionId = 'blue';
  private selected: SystemId = 'sol';
  private tab: Tab = 'research';
  private root?: Phaser.GameObjects.Container;
  private page = 0;
  private choice = 0;
  private selectedShips: number[] = [];
  private selectedGroup?: number;
  private message = '';
  private disposed = true;
  private readonly escapeEvents = new WeakSet<KeyboardEvent>();
  private readonly forwardEscape = (event: KeyboardEvent): void => {
    // Host shells can consume Escape before Phaser; deduplicate the original DOM event.
    if (!this.disposed && this.input.keyboard?.isActive() && event.key === 'Escape' && event.defaultPrevented && !this.escapeEvents.has(event)) {
      this.input.keyboard?.emit('keydown-ESC', event);
    }
  };
  private ticket?: Phaser.Time.TimerEvent;
  private phase: 'idle' | 'scheduled' | 'running' | 'paused' | 'failed' = 'idle';
  private readonly repository = new ConquestSaveManager();
  private frames?: BattleFrame[];
  private fileInput?: HTMLInputElement;
  private importRequest?: object;
  private dialogToken?: object;
  private replay?: { background: Phaser.GameObjects.Graphics; graphics: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text; seconds: number; paused: boolean; left: number; top: number; scale: number };
  private projectPanel?: CampaignProjectPanel;
  private projectGeneration = 0;
  private narrowWorkersOpen = false;
  private mapState: GalaxyMapState = {};
  private mapWidget?: GalaxyMapWidget;

  constructor(private readonly mapRepository: GalaxyMapRepository = new LocalGalaxyMapRepository()) {
    super({ key: 'ConquestScene' });
  }

  create(): void {
    this.disposed = false;
    this.resizeViewport();
    if (typeof window !== 'undefined') window.addEventListener('resize', this.resizeViewport);
    this.render();
    this.input.keyboard?.on('keydown-ESC', this.escape, this);
    if (typeof window !== 'undefined') window.addEventListener('keydown', this.forwardEscape);
    this.events.once('shutdown', () => {
      this.disposed = true; this.pauseAi(); this.dialogToken = undefined;
      this.fileInput?.remove(); this.fileInput = undefined; this.importRequest = undefined;
      this.input.keyboard?.off('keydown-ESC', this.escape, this);
      if (typeof window !== 'undefined') window.removeEventListener('resize', this.resizeViewport);
      if (typeof window !== 'undefined') window.removeEventListener('keydown', this.forwardEscape);
      closeShipyardModal(this); this.root?.destroy(true); this.root = undefined; this.replay = undefined; this.frames = undefined;
      this.projectGeneration++;
      this.projectPanel?.destroy(); this.projectPanel = undefined;
      this.mapWidget?.destroy(); this.mapWidget = undefined; this.mapState = {};
      Reflect.deleteProperty(this, 'state');
      this.scale?.setGameSize(1280, 720);
    });
    this.newGame();
  }

  private resizeViewport = (): void => {
    if (typeof window === 'undefined' || !this.scale) return;
    resizeCampaignViewport(this);
    if (isShipyardModalOpen(this)) {
      closeShipyardModal(this);
      this.message = 'Размер экрана изменён. Диалог отменён; откройте его снова.';
    }
    this.projectPanel?.resize(this.cameras.main.width, this.cameras.main.height);
    this.render();
  };

  private get narrow(): boolean { return this.cameras.main.width < 1280; }

  private escape(event?: KeyboardEvent): void {
    if (event) {
      if (this.escapeEvents.has(event)) return;
      this.escapeEvents.add(event);
    }
    if (isShipyardModalOpen(this)) return;
    if (this.projectPanel) { this.projectPanel.requestClose(); return; }
    if (this.ticket) { this.pauseAi(); this.render(); return; }
    this.confirm('Выйти в меню? Несохранённая партия будет потеряна.', () => this.scene.start('MenuScene'));
  }

  private replace(state: Conquest): void {
    this.projectGeneration++;
    this.projectPanel?.destroy(); this.projectPanel = undefined;
    this.pauseAi();
    this.state = conquestSchema.parse(state);
    this.mapState = {};
    this.observer = this.state.control.mode === 'human-vs-ai' ? 'blue' : this.state.session.turn % 2 ? 'blue' : 'red';
    this.selected = this.homeSelection();
    this.phase = this.isAiTurn() ? 'paused' : 'idle';
    this.tab = 'research'; this.page = 0; this.choice = 0;
    this.selectedShips = []; this.selectedGroup = undefined; this.frames = undefined; this.message = '';
    this.narrowSection = 'map';
    this.narrowWorkersOpen = false;
    this.render();
  }

  private isAiTurn(): boolean {
    return !!this.state && this.state.control.mode === 'human-vs-ai' && this.state.session.turn % 2 === 0 && getConquestOutcome(this.state).status === 'ongoing';
  }

  private homeSelection(): SystemId {
    return this.state.session.galaxy.systems.find(system => system.ownerId === this.observer)?.id ??
      getGalaxyDefinition(this.state.session.galaxy).factions.find(faction => faction.id === this.observer)!.homeSystemId;
  }

  private selectSystem(id: SystemId): void {
    this.selected = id;
    this.selectedShips = []; this.selectedGroup = undefined; this.page = 0;
    this.message = '';
    this.render();
  }

  private pauseAi(): void {
    this.ticket?.remove(false); this.ticket = undefined;
    if (this.phase === 'scheduled' || this.phase === 'running') this.phase = 'paused';
  }

  private scheduleAi(): void {
    if (!this.isAiTurn() || this.disposed || this.ticket || isShipyardModalOpen(this)) return;
    const source = this.state;
    this.phase = 'scheduled';
    const ticket = this.time.delayedCall(0, () => {
      if (this.ticket !== ticket) return;
      this.ticket = undefined;
      if (this.disposed || this.state !== source || !this.isAiTurn() || isShipyardModalOpen(this)) return;
      this.phase = 'running';
      const result = executeConquestAiTurn(source, 'red', source.session.turn);
      if (this.disposed || this.state !== source) return;
      this.phase = result.ok ? 'idle' : 'failed';
      this.accept(result);
    });
    this.ticket = ticket;
    this.render();
  }

  private accept(result: ConquestResult): void {
    if (result.ok) {
      this.state = result.state;
      if (result.frames) this.frames = result.frames;
      const messages = (result.notices ?? []).filter(notice => notice.factionId === this.observer)
        .map(notice => `${notice.systemId}: основание отложено — ${notice.code === 'NO_SETTLERS'
          ? 'нет колонистов' : 'недостаточно ресурсов'}`).concat(
          (result.workforceAdjustments ?? []).filter(adjustment => this.state.session.galaxy.systems.some(system =>
            system.id === adjustment.systemId && system.ownerId === this.observer))
            .map(adjustment => `${adjustment.systemId}: назначения сокращены пропорционально населению`));
      if (result.turnReceipt) {
        const receipt = result.turnReceipt;
        if (receipt.factionId === this.observer) messages.push(
          `Выпуск +${receipt.populationIncome.credits} кр./+${receipt.populationIncome.minerals} мин. · содержание ${receipt.populationUpkeepCredits} кр. · наука ${receipt.reserves.research.after}/${receipt.reserves.research.cap}`);
      }
      this.message = messages.join('; ');
      if (getConquestOutcome(this.state).status === 'completed') { this.pauseAi(); this.phase = 'idle'; }
    } else this.message = result.message;
    this.render();
  }

  private command(payload: Omit<ConquestCommand, 'factionId' | 'expectedTurn'> | Record<string, unknown>): void {
    if (this.disposed || this.projectPanel || isShipyardModalOpen(this) || this.phase === 'running' || this.ticket) return;
    const result = executeConquestCommand(this.state, { ...payload, factionId: this.observer, expectedTurn: this.state.session.turn });
    this.accept(result);
    if (result.ok && payload.kind === 'endTurn') this.scheduleAi();
  }

  private adjustWorkers(view: ConquestView, systemId: SystemId, role: keyof Workforce, delta: -1 | 1): void {
    const source = this.state, factionId = this.observer, expectedTurn = view.turn;
    const current = view.colonyOutput.assignments[systemId];
    const population = current?.population;
    if (!current || population === undefined) return;
    const workers = { industry: current.industry, research: current.research, culture: current.culture };
    const next = workers[role] + delta;
    const assigned = workers.industry + workers.research + workers.culture;
    if (next < 0 || (delta > 0 && assigned >= population)) return;
    workers[role] = next;
    this.accept(executeConquestCommand(source, { kind: 'assignWorkers', factionId, expectedTurn, systemId, workers }));
  }

  private confirm(title: string, action: () => void): void {
    this.pauseAi(); this.render();
    const source = this.state, modal = openShipyardModal(this);
    if (!modal) return;
    const layout = conquestDialogLayout(this.cameras.main.width, this.cameras.main.height);
    const content = this.add.container(layout.x, layout.y); modal.overlay.add(content);
    const label = text(this, content, 0, 0, title, 20).setWordWrapWidth(layout.width);
    const y = Math.max(130, label.height + 24);
    button(this, content, 0, y, 'Отмена', () => modal.close(), 'conquest-cancel', 140);
    button(this, content, layout.width - 160, y, 'Подтвердить', () => {
      if (modal.close() && !this.disposed && this.state === source) action();
    }, 'conquest-confirm', 160);
  }

  private help(): void {
    this.pauseAi(); this.render();
    const modal = openShipyardModal(this);
    if (!modal) return;
    const layout = conquestDialogLayout(this.cameras.main.width, this.cameras.main.height);
    const content = this.add.container(layout.x, layout.y); modal.overlay.add(content);
    let page = 0;
    const render = () => {
      content.removeAll(true);
      const [title, body] = CONQUEST_HELP[page];
      text(this, content, 0, 0, `${page + 1} / ${CONQUEST_HELP.length} · ${title}`, 20).setWordWrapWidth(layout.width);
      const label = text(this, content, 0, 72, body, 16).setWordWrapWidth(layout.width).setName('conquest-help-body');
      const y = Math.max(440, label.height + 96);
      button(this, content, 0, y, '←', () => { page = Math.max(0, page - 1); render(); }, 'conquest-help-prev', 44);
      button(this, content, 56, y, '→', () => { page = Math.min(CONQUEST_HELP.length - 1, page + 1); render(); }, 'conquest-help-next', 44);
      button(this, content, layout.width - 140, y, 'Закрыть · ESC', () => modal.close(), 'conquest-help-close', 140);
    };
    render();
  }

  private save(): void {
    if (this.projectPanel) return;
    const snapshot = structuredClone(this.state);
    this.confirm('Заменить общий слот сохранения этой партией?', () => {
      const result = this.repository.save(snapshot);
      this.message = result.ok ? 'Партия сохранена' : result.message; this.render();
    });
  }

  private requestLoad(): void {
    if (this.projectPanel) return;
    this.pauseAi();
    const source = this.state;
    const result = this.repository.load();
    if (this.disposed || this.state !== source) return;
    if (!result.ok) { this.message = result.message; this.render(); return; }
    this.confirm('Заменить текущую партию сохранённой?', () => this.replace(result.state));
  }

  private openProjectEditor(): void {
    if (this.disposed || this.projectPanel || !this.state || isShipyardModalOpen(this)) return;
    this.pauseAi();
    const source = this.state;
    const factionId = this.observer;
    const expectedTurn = source.session.turn;
    const generation = ++this.projectGeneration;
    const view = getConquestView(source, factionId);
    const access = getResearchAccess(view.research, view.researchTree);
    let currentSource = source;
    let panel: CampaignProjectPanel;
    panel = new CampaignProjectPanel(this, {
      width: this.cameras.main.width,
      height: this.cameras.main.height,
      projects: view.projects,
      factionId,
      readOnly: view.outcome.status === 'completed' || view.activeFactionId !== factionId ||
        (source.control.mode === 'human-vs-ai' && factionId === 'red'),
      hulls: access.hulls.map(id => ({ id, name: HULLS[id].name })),
      components: access.components,
      research: view.research,
      tree: view.researchTree,
      run: payload => {
        if (this.disposed || this.projectPanel !== panel || this.projectGeneration !== generation ||
          this.observer !== factionId || this.state !== currentSource || this.state.session.turn !== expectedTurn) {
          return { ok: false, code: 'STALE_TURN', message: 'Контекст проекта изменился; откройте редактор снова' };
        }
        const result = executeConquestCommand(currentSource, {
          ...payload, factionId, expectedTurn
        });
        if (result.ok) {
          this.state = result.state;
          currentSource = result.state;
        }
        return result;
      },
      close: () => {
        if (this.projectPanel !== panel || this.projectGeneration !== generation) return;
        this.projectGeneration++;
        this.projectPanel = undefined;
        this.render();
      }
    });
    this.projectPanel = panel;
  }

  private newGame(): void {
    if (this.projectPanel) return;
    this.pauseAi(); this.render();
    const modal = openShipyardModal(this);
    if (!modal) return;
    const token = {}; this.dialogToken = token;
    modal.overlay.once('destroy', () => {
      if (this.dialogToken !== token) return;
      this.dialogToken = undefined; this.fileInput?.remove(); this.fileInput = undefined; this.importRequest = undefined;
    });
    const source = this.state;
    let tree = getDefaultResearchTree();
    const layout = conquestDialogLayout(this.cameras.main.width, this.cameras.main.height);
    const content = this.add.container(layout.x, layout.y); modal.overlay.add(content);
    text(this, content, 0, 0, 'Новая военная кампания', 24);
    text(this, content, 0, 50, source ? 'Текущая несохранённая партия будет заменена.' : 'Карта будет создана и сохранена перед началом партии.', 16).setWordWrapWidth(layout.width);
    const treeLabel = text(this, content, 0, 92, `Дерево: ${this.shorten(tree.id, 28)}`, 16).setName('conquest-tree-choice');
    let worldCount = 40;
    let busy = false;
    const countLabel = text(this, content, 80, 135, `Миров: ${worldCount}`, 18).setName('conquest-world-count');
    const adjustCount = (delta: number) => {
      if (busy || this.dialogToken !== token) return;
      worldCount = Math.max(6, Math.min(MAX_GALAXY_WORLDS, worldCount + delta));
      countLabel.setText(`Миров: ${worldCount}`);
    };
    button(this, content, 0, 128, '−1', () => adjustCount(-1), 'conquest-worlds-minus', 60);
    button(this, content, 225, 128, '+1', () => adjustCount(1), 'conquest-worlds-plus', 60);
    button(this, content, 0, 184, '−10', () => adjustCount(-10), 'conquest-worlds-minus-ten', 60);
    button(this, content, 80, 184, '+10', () => adjustCount(10), 'conquest-worlds-plus-ten', 60);
    button(this, content, 180, 184, 'Участники: 2', () => {}, 'conquest-participants', 170).disableInteractive().setAlpha(0.6);
    const notice = text(this, content, 0, 300, '', 14, '#ffbb88').setWordWrapWidth(layout.width).setName('conquest-generation-error');
    button(this, content, 0, 240, 'Дерево YAML / JSON', () => {
      if (busy || this.dialogToken !== token) return;
      this.importRequest = undefined;
      this.fileInput?.remove();
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.yaml,.yml,.json'; this.fileInput = input;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const request = {}; this.importRequest = request;
        try {
          if (file.size > MAX_RESEARCH_TREE_BYTES) throw new Error('Файл превышает 256 КБ');
          const parsed = parseResearchTreeYaml(await file.text());
          if (this.disposed || this.state !== source || this.dialogToken !== token ||
            this.importRequest !== request || !isShipyardModalOpen(this)) return;
          tree = parsed; treeLabel.setText(`Дерево: ${this.shorten(tree.id, 28)}`); notice.setText('');
        } catch {
          if (!this.disposed && this.state === source && this.dialogToken === token &&
            this.importRequest === request && isShipyardModalOpen(this)) notice.setText('Дерево не принято: проверьте формат, зависимости и ограничения');
        } finally { input.remove(); if (this.importRequest === request) this.importRequest = undefined; }
      };
      input.click();
    }, 'conquest-import-tree');
    const begin = async (ai: boolean) => {
      if (busy || this.disposed || this.state !== source || this.dialogToken !== token || !isShipyardModalOpen(this)) return;
      if (this.importRequest) { notice.setText('Дождитесь завершения импорта дерева.'); return; }
      busy = true;
      try {
        const seed = createGalaxySeed();
        const generated = generateBrowserGalaxy(worldCount, seed);
        if (!generated.ok) { notice.setText(generated.message); return; }
        const candidate = createConquest(ai ? { mode: 'human-vs-ai', aiPolicy: 'conquest-v1' } : { mode: 'local' },
          tree, seed, generated.map);
        const saving = this.mapRepository.save(generated.map);
        const saved = saving instanceof Promise ? await saving : saving;
        if (this.disposed || this.state !== source || this.dialogToken !== token || !isShipyardModalOpen(this)) return;
        if (!saved.ok) { notice.setText(saved.message); return; }
        if (modal.close()) { this.dialogToken = undefined; this.replace(candidate); }
      } catch {
        if (!this.disposed && this.state === source && this.dialogToken === token && isShipyardModalOpen(this)) {
          notice.setText('Не удалось создать или сохранить карту. Новая кампания не запущена.');
        }
      } finally { busy = false; }
    };
    button(this, content, 0, 440, 'Локальная партия', () => { void begin(false); }, 'conquest-new-local', layout.width);
    button(this, content, 0, 492, 'Против компьютера', () => { void begin(true); }, 'conquest-new-ai', layout.width);
    button(this, content, 0, 544, 'Отмена · ESC', () => modal.close(), 'conquest-new-cancel', layout.width);
    text(this, content, 0, 610, 'Карта записывается до старта. Отмена не создаёт партию.', 14).setWordWrapWidth(layout.width);
  }

  private shorten(value: string, maximum = 45): string { return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value; }

  private normalizePage(total: number, size: number): void {
    this.page = Math.max(0, Math.min(this.page, Math.max(0, Math.ceil(total / size) - 1)));
  }

  private control(x: number, y: number, label: string, action: () => void, name: string, enabled = true, width = 145): void {
    const root = this.root!;
    const item = button(this, root, x, y, label, () => {
      if (!this.disposed && !this.projectPanel && this.root === root && enabled && !isShipyardModalOpen(this)) action();
    }, name, width);
    if (!enabled) item.disableInteractive().setAlpha(0.4);
  }

  private pager(total: number, size: number, x = 24): void {
    const pages = Math.max(1, Math.ceil(total / size));
    this.control(x, 626, '←', () => { this.page--; this.render(); }, 'conquest-page-prev', this.page > 0, 45);
    text(this, this.root!, x + 60, 633, `${this.page + 1} / ${pages}`, 14);
    this.control(x + 135, 626, '→', () => { this.page++; this.render(); }, 'conquest-page-next', this.page + 1 < pages, 45);
  }

  private render(): void {
    if (this.disposed) return;
    this.mapWidget?.destroy(); this.mapWidget = undefined;
    this.root?.destroy(true);
    const root = this.add.container(0, 0).setName('conquest-root'); this.root = root;
    if (this.narrow) { this.renderNarrow(); return; }
    if (!this.state) {
      text(this, root, 24, 30, 'Новая военная кампания', 28);
      this.control(24, 100, 'Создать карту', () => this.newGame(), 'conquest-new', true, 180);
      this.control(230, 100, 'Загрузить партию', () => this.requestLoad(), 'conquest-load', true, 180);
      this.control(440, 100, 'Меню', () => this.escape(), 'conquest-menu');
      this.control(600, 100, 'Справка', () => this.help(), 'conquest-help');
      text(this, root, 24, 160, this.message, 16, '#ffc08a');
      return;
    }
    const view = getConquestView(this.state, this.observer);
    const manual = view.outcome.status === 'ongoing' && view.activeFactionId === this.observer && !this.ticket && this.phase !== 'running' &&
      !(this.state.control.mode === 'human-vs-ai' && this.observer === 'red');
    const background = this.add.graphics(); root.add(background);
    background.fillStyle(0x101820).fillRect(0, 0, 1280, 720);
    for (let index = 0; index < 90; index++) background.fillStyle(0x6b818c, 0.35).fillCircle((index * 137) % 1280, (index * 79) % 320, 1);
    background.lineStyle(1, 0x3c4c53).lineBetween(20, 322, 1260, 322).lineBetween(20, 665, 1260, 665);
    text(this, root, 24, 16, 'ORION', 28, '#eef7f4');
    text(this, root, 24, 55, 'Завоевание', 17, '#8edfc1');
    this.control(240, 20, 'Новая партия', () => this.newGame(), 'conquest-new');
    this.control(400, 20, 'Сохранить', () => this.save(), 'conquest-save');
    this.control(560, 20, 'Загрузить', () => this.requestLoad(), 'conquest-load');
    this.control(720, 20, 'Меню', () => this.escape(), 'conquest-menu');
    this.control(800, 340, 'Справка', () => this.help(), 'conquest-help', true, 140);
    this.control(1080, 20, 'Выбрать мир', () => this.selectWorld(view), 'conquest-select-world', true, 170);
    if (this.state.control.mode === 'human-vs-ai') {
      this.control(880, 20, 'Ручное управление', () => this.confirm('Передать красную сторону человеку?', () => this.replace(convertConquestToLocal(this.state))), 'conquest-takeover', true, 190);
    }
    const outcome = view.outcome;
    text(this, root, 24, 93, outcome.status === 'completed' ? `Победа: ${outcome.winner === 'blue' ? 'Синий союз' : 'Красная лига'}` :
      `Ход ${view.turn} · ${view.activeFactionId === 'blue' ? 'Синий союз' : 'Красная лига'}`, 18, outcome.status === 'completed' ? '#8edfc1' : '#e5efef').setName('conquest-status');
    this.control(730, 84, this.observer === 'blue' ? 'Синий союз' : 'Красная лига', () => {
      this.observer = this.observer === 'blue' ? 'red' : 'blue'; this.selectSystem(this.homeSelection());
    }, 'conquest-side', this.state.control.mode === 'local');
    if (this.isAiTurn()) {
      this.control(890, 84, this.ticket ? 'Пауза AI' : 'Продолжить AI', () => {
        if (this.ticket) { this.pauseAi(); this.render(); } else this.confirm('Выполнить ход компьютера?', () => this.scheduleAi());
      }, 'conquest-resume', true, 165);
    } else if (this.state.control.mode === 'local') this.control(890, 84, 'AI: один ход', () => this.confirm('Поручить один ход компьютеру?', () => {
      this.accept(executeConquestAiTurn(this.state, this.observer, this.state.session.turn));
    }), 'conquest-ai', manual, 165);
    this.control(1080, 84, 'Завершить ход', () => this.command({ kind: 'endTurn' }), 'conquest-end', manual, 170);
    text(this, root, 740, 137, `Кредиты: ${view.treasury.credits}    Минералы: ${view.treasury.minerals}`, 17);
    text(this, root, 740, 166, `Доход: ${view.income.credits} / ${view.income.minerals}    Корабли: ${view.ships.length}`, 16);
    const budget = view.economyForecast;
    text(this, root, 740, 193, budget.ok ? `Содержание: ${budget.upkeep.dueCredits} · к оплате ${budget.upkeep.paidCredits} · дефицит ${budget.upkeep.shortfallCredits}` : `Бюджет: ${budget.code}`, 14);
    const selected = view.galaxy.systems.find(system => system.id === this.selected)!;
    fitText(text(this, root, 740, 229, `${this.shorten(selected.name, 15)} · ${selected.visibility === 'unknown' ? 'нет наблюдения' :
      selected.ownerId === this.observer ? 'своя колония' : selected.ownerId ? 'чужая колония' : 'свободный мир'} · ${this.environmentLabel(view)}`, 14), 510);
    text(this, root, 740, 261, this.populationLabel(view) ??
      `Свои корабли: ${view.ships.filter(ship => !ship.transit && ship.systemId === this.selected).length} · видимые чужие: ${view.enemies.filter(ship => ship.systemId === this.selected).length}`, 14).setName('conquest-population');
    text(this, root, 740, 290, this.isAiTurn() ? `Компьютер: ${this.phase}` : `Свои планеты: ${view.galaxy.systems.filter(system => system.visibility === 'explored' && system.ownerId === this.observer).length} / ${view.totalHabitableWorlds}`, 14, '#8edfc1');
    this.control(1080, 281, 'Колонизировать', () => this.requestColonization(view), 'conquest-colonize',
      manual && !!view.colonization.find(item => item.systemId === this.selected)?.quote.ok, 170);
    this.control(890, 281, `Изучить ${view.surveyCost.credits}/${view.surveyCost.minerals}`,
      () => this.command({ kind: 'survey', systemId: this.selected }), 'conquest-survey',
      manual && selected.visibility === 'explored' && !Object.prototype.hasOwnProperty.call(view.environmentKnowledge, this.selected), 180);
    const generated = !!this.state.session.galaxy.map;
    if (generated) text(this, root, 24, 118, `Миров: ${view.galaxy.systems.length} · seed: ${this.state.session.galaxy.map!.seed}`, 12);
    this.mapWidget = this.createMap(view, root, { x: 24, y: 188, width: 680, height: 130 }, 136,
      () => this.root === root && !this.projectPanel && !isShipyardModalOpen(this));
    this.control(370, 136, 'Развернуть карту', () => this.openMap(), 'conquest-open-map', true, 190);
    const tabs: [Tab, string][] = [['research', 'Исследования'], ['production', 'Производство'], ['fleet', 'Корабли и группы'], ['battles', 'Бои']];
    tabs.forEach(([tab, label], index) => this.control(24 + index * 195, 340, label, () => {
      this.tab = tab; this.narrowSection = tab; this.page = 0;
      this.render();
    }, `conquest-tab-${tab}`, true, 180));
    this.control(1020, 340, 'Проекты кораблей', () => this.openProjectEditor(), 'conquest-projects', true, 220);
    if (this.tab === 'research') this.renderResearch(view, manual);
    if (this.tab === 'production') this.renderProduction(view, manual);
    if (this.tab === 'fleet') this.renderFleet(view, manual);
    if (this.tab === 'battles') this.renderBattles(view);
    text(this, root, 24, 675, this.message, 14, '#ffc08a').setWordWrapWidth(1210).setName('conquest-message');
  }

  private createMap(view: ConquestView, parent: Phaser.GameObjects.Container,
    area: { x: number; y: number; width: number; height: number }, toolbarY: number,
    enabled: () => boolean, select?: (id: string) => void): GalaxyMapWidget {
    const generated = !!this.state.session.galaxy.map;
    return new GalaxyMapWidget(this, parent, {
      area, toolbarY, state: this.mapState, selectedId: this.selected, prefix: 'conquest', worldPrefix: 'conquest-system-',
      worlds: view.galaxy.systems.map(system => ({
        id: system.id, name: system.name, x: system.x, y: generated ? system.y : -system.y,
        color: system.visibility === 'unknown' ? 0x54606a : system.ownerId === 'blue' ? 0x55baff : system.ownerId === 'red' ? 0xf08070 : 0x8edfc1,
        marker: system.visibility === 'unknown' ? '○' : system.ownerId ? '●' : '◇'
      })),
      enabled: () => !this.disposed && enabled(),
      change: state => { this.mapState = state; },
      select: select ?? (id => this.selectSystem(id))
    });
  }

  private openMap(): void {
    this.pauseAi(); this.render();
    const modal = openShipyardModal(this);
    if (!modal) return;
    const source = this.state, root = this.root;
    const width = this.cameras.main.width, height = this.cameras.main.height;
    text(this, modal.overlay, 12, 20, 'Карта галактики · перенос указателем', 16);
    const widget = this.createMap(getConquestView(source, this.observer), modal.overlay,
      { x: 12, y: 124, width: width - 24, height: height - 200 }, 64,
      () => this.state === source && this.root === root && isShipyardModalOpen(this),
      id => {
        if (!modal.close()) return;
        this.selectSystem(id);
      });
    modal.overlay.once('destroy', () => {
      widget.destroy();
      if (!this.disposed && this.state === source && this.root === root) this.render();
    });
    button(this, modal.overlay, 12, height - 64, 'Закрыть · ESC', () => modal.close(), 'conquest-map-close', width - 24);
  }

  private renderResearch(view: ConquestView, manual: boolean): void {
    this.normalizePage(view.researchTree.nodes.length, 2);
    text(this, this.root!, 24, 385, `Технологии · ${view.researchTree.id}`, 17);
    const science = view.researchForecast.receipt;
    text(this, this.root!, 24, 409, `Наука +${science.produced} · резерв ${science.reserveBefore}/${science.cap} · расход ${science.spent} · ${researchTiming(view)}`, 14)
      .setName('conquest-research-forecast');
    this.control(980, 390, 'Приостановить', () => this.command({ kind: 'pauseResearch' }),
      'conquest-research-pause', manual && view.research.activeId !== null, 230);
    this.control(740, 626, 'Журнал открытий', () => this.showResearchJournal(view), 'conquest-research-journal', true, 230);
    view.researchTree.nodes.slice(this.page * 2, this.page * 2 + 2).forEach((node, index) => {
      const ypos = 448 + index * 90, completed = view.research.completed.includes(node.id), active = view.research.activeId === node.id;
      fitText(text(this, this.root!, 24, ypos, node.name, 16), 420);
      text(this, this.root!, 475, ypos, completed ? 'Открыто' : `${getResearchProgress(view.research, node.id)}/${node.researchCost} научных очков`, 15);
      text(this, this.root!, 24, ypos + 24, node.effects.map(effect => describeResearchEffect(effect, view.researchTree, view.colonyTechnologyEffects)).join('; '), 14)
        .setWordWrapWidth(920).setName(`conquest-research-effects-${node.id}`);
      text(this, this.root!, 980, ypos + 44, `Нужно: ${node.prerequisites.join(', ') || 'нет'}`, 14).setWordWrapWidth(240);
      this.control(980, ypos - 8, completed ? 'Открыто' : active ? 'Исследуется' : 'Выбрать', () => this.command({ kind: 'research', technologyId: node.id }),
        `conquest-research-${node.id}`, manual && !completed && !active, 230);
    });
    this.pager(view.researchTree.nodes.length, 2);
  }

  private renderProduction(view: ConquestView, manual: boolean): void {
    const choices: { design: ShipDesign; source: string }[] = [
      { design: createColonizerDesign(), source: 'Стартовый колонизатор' },
      ...view.projects.map(project => ({ design: project.design, source: `Проект #${project.id}` })),
      ...buildConquestDesigns(view.research, view.researchTree).map(design => ({ design, source: 'Кампанийный конструктор' })),
    ];
    this.choice = Math.min(this.choice, Math.max(0, choices.length - 1));
    const choice = choices[this.choice];
    const own = view.galaxy.systems.some(system => system.id === this.selected && system.visibility === 'explored' && system.ownerId === this.observer);
    text(this, this.root!, 24, 385, `Проекты · ${this.choice + 1} / ${choices.length}`, 17);
    if (choice) {
      const available = isCampaignDesignAvailable(choice.design, view.research, view.researchTree);
      fitText(text(this, this.root!, 24, 420, choice.design.name, 14), 550);
      text(this, this.root!, 24, 451, `${choice.source} · ${HULLS[choice.design.hullId].name}`, 14);
      let quote: ReturnType<typeof getColonyProductionQuote> | undefined;
      try { quote = getColonyProductionQuote(choice.design, view.colonyOutput.rules); } catch {
        text(this, this.root!, 24, 568, 'Расчёт цены отклонён: проект не прошёл полётную валидацию.', 14, '#ffc08a');
      }
      text(this, this.root!, 24, 478, !available ? 'Проект недоступен: технология, профиль параметров или полётная валидация' :
        quote ? `${quote.cost.credits} кредитов / ${quote.cost.minerals} минералов · ${quote.productionCost} очков` : 'Недопустимый проект', 14, available ? '#c8d9ed' : '#ffc08a');
      this.control(24, 516, '←', () => { this.choice--; this.render(); }, 'conquest-design-prev', this.choice > 0, 45);
      this.control(80, 516, '→', () => { this.choice++; this.render(); }, 'conquest-design-next', this.choice + 1 < choices.length, 45);
      this.control(145, 516, 'Заказать', () => this.command({ kind: 'enqueueProduction', systemId: this.selected, design: structuredClone(choice.design) }),
        'conquest-enqueue', manual && own && available && !!quote);
    }
    this.control(320, 516, 'Проекты кораблей', () => this.openProjectEditor(), 'conquest-projects', true, 225);
    const workforce = view.colonyOutput.assignments[this.selected];
    if (workforce) {
      text(this, this.root!, 24, 578, 'РАБОЧИЕ · производство / наука / культура', 14).setName('conquest-workforce-title');
      const rows: Array<[keyof Workforce, string, number]> = [
        ['industry', 'Пром.', 24], ['research', 'Наука', 220], ['culture', 'Культура', 416]
      ];
      for (const [role, label, x] of rows) {
        const count = workforce[role];
        this.control(x, 602, '−', () => this.adjustWorkers(view, this.selected, role, -1),
          `conquest-workers-${role}-minus`, manual && count > 0, 44);
        fitText(text(this, this.root!, x + 49, 610, `${label} ${count}`, 14), 80);
        this.control(x + 136, 602, '+', () => this.adjustWorkers(view, this.selected, role, 1),
          `conquest-workers-${role}-plus`, manual && workforce.unassigned > 0, 44);
      }
      text(this, this.root!, 24, 637, `Население ${workforce.population} · свободны ${workforce.unassigned} · наука ${view.colonyOutput.reserves.research}/${view.colonyOutput.reserveCaps.research} · культура ${view.colonyOutput.reserves.culture}/${view.colonyOutput.reserveCaps.culture}`, 12)
        .setWordWrapWidth(590);
      const forecast = view.colonyOutput.forecast.production.find(item => item.systemId === this.selected);
      if (forecast) text(this, this.root!, 24, 660,
        `За ход: производство ${forecast.productionPoints} · наука ${forecast.sciencePoints} · культура ${forecast.culturePoints} · ${productionTiming(view, this.selected)}`, 14)
        .setWordWrapWidth(590).setName('conquest-production-forecast');
    }
    const records = [...view.production.orders, ...view.production.completed].filter(record => record.systemId === this.selected);
    this.normalizePage(records.length, 4);
    text(this, this.root!, 655, 385, 'Очередь и готовые корабли', 17);
    records.slice(this.page * 4, this.page * 4 + 4).forEach((record, index) => {
      const ypos = 420 + index * 48, order = view.production.orders.find(item => item.id === record.id);
      fitText(text(this, this.root!, 655, ypos, `#${record.id} ${record.design.name}`, 14), 410);
      text(this, this.root!, 655, ypos + 19, order
        ? `${order.productionProgress}/${order.productionCost} очков · возврат ${getColonyProductionRefund(order).credits} кр. / ${getColonyProductionRefund(order).minerals} мин.`
        : 'Готов к размещению', 12);
      this.control(1080, ypos - 4, order ? 'Отменить' : 'Разместить', () => this.command({
        kind: order ? 'cancelProduction' : 'deployProduction', systemId: this.selected, orderId: record.id
      }), `conquest-order-${record.id}`, manual && own, 145);
    });
    this.pager(records.length, 4, 655);
    this.control(845, 626, 'Работы мира', () => this.showColonyProjects(view, manual), 'conquest-world-projects', own, 125);
    this.control(980, 626, 'Разбивка колонии', () => this.showColonyEffects(view), 'conquest-effects', own, 230);
  }

  private renderFleet(view: ConquestView, manual: boolean): void {
    const ships = view.ships.filter(ship => ship.systemId === this.selected);
    this.normalizePage(ships.length, 4);
    this.selectedShips = this.selectedShips.filter(id => ships.some(ship => ship.id === id));
    text(this, this.root!, 24, 385, 'Собственные корабли', 17);
    ships.slice(this.page * 4, this.page * 4 + 4).forEach((ship, index) => {
      const ypos = 420 + index * 48, operation = view.operations[String(ship.id)];
      this.control(24, ypos - 5, `${this.selectedShips.includes(ship.id) ? '☑' : '☐'} #${ship.id} ${this.shorten(ship.design.name, 24)}`, () => {
        this.selectedGroup = undefined;
        this.selectedShips = this.selectedShips.includes(ship.id) ? this.selectedShips.filter(id => id !== ship.id) : [...this.selectedShips.slice(-9), ship.id];
        this.render();
      }, `conquest-ship-${ship.id}`, true, 325);
      text(this, this.root!, 370, ypos, `HP ${Math.ceil(operation.hull)} · бак ${formatStrategicFuel(ship.fuel)}/${formatStrategicFuel(getTravelCapabilities(ship.design.strategicEquipment).fuelCapacity)}`, 14);
      text(this, this.root!, 370, ypos + 19, ship.transit ? `→ ${ship.transit.destinationId} · ${ship.transit.remainingTurns} своих ходов` : `Боезапас: ${operation.ammunition.map(item => item.amount).join(', ') || '—'}`, 12);
    });
    const ship = ships.find(item => item.id === this.selectedShips[0]);
    const groups = view.fleets.filter(fleet => fleet.systemId === this.selected);
    const group = groups.find(fleet => fleet.id === this.selectedGroup);
    const groupTransit = group && getFleetTransit(group, view.ships);
    text(this, this.root!, 655, 385, group ? `Группа #${group.id} · кораблей ${group.shipIds.length}` : ship ? `Корабль #${ship.id}` : 'Выбор корабля или группы', 17);
    const stationary = !!ship && !ship.transit;
    const costs = ship ? this.serviceCosts(view, ship.id) : undefined;
    this.control(655, 427, costs ? `Топливо ${costs.fuel}` : 'Заправить', () => ship && this.command({ kind: 'refuelShip', systemId: this.selected, shipId: ship.id }), 'conquest-refuel', manual && stationary && ship!.fuel < getTravelCapabilities(ship!.design.strategicEquipment).fuelCapacity, 180);
    this.control(845, 427, costs ? `Ремонт ${costs.repair}` : 'Ремонт', () => ship && this.command({ kind: 'repairShip', systemId: this.selected, shipId: ship.id }), 'conquest-repair', manual && stationary, 165);
    this.control(1020, 427, costs ? `Снаряды ${costs.ammunition}` : 'Боезапас', () => ship && this.command({ kind: 'resupplyShip', systemId: this.selected, shipId: ship.id }), 'conquest-resupply', manual && stationary, 175);
    this.control(655, 478, 'Выбрать цель перелёта', () => this.selectDestination(view, ship?.id, group?.id),
      'conquest-select-destination', manual && (!!group && !groupTransit || stationary) &&
        !view.workProjects.some(project => project.kind === 'refit' && project.shipId === ship?.id), 350);
    this.control(1015, 478, 'Переоснастить', () => ship && this.requestRefit(view, ship.id),
      'conquest-refit', manual && stationary, 180);
    text(this, this.root!, 655, 536, groupTransit ? `В пути → ${groupTransit.destinationId} · ${groupTransit.remainingTurns} своих ходов` :
      ship ? this.travelLabel(ship) : 'Прямой перелёт: возможности каждого проекта', 14);
    this.control(655, 578, 'Создать группу', () => this.command({ kind: 'createFleet', systemId: this.selected, shipIds: [...this.selectedShips] }), 'conquest-create-fleet', manual && this.selectedShips.length >= 2, 180);
    this.control(845, 578, 'Выбрать группу', () => {
      this.pauseAi(); this.render();
      const source = this.state;
      chooseItem(this, 'Группы', groups.map(item => ({ label: `#${item.id}: ${item.shipIds.join(', ')}`, value: item.id })), id => {
        if (this.disposed || this.state !== source) return;
        this.selectedGroup = id; this.selectedShips = []; this.render();
      });
    }, 'conquest-select-fleet', groups.length > 0, 180);
    this.control(1035, 578, 'Расформировать', () => group && this.command({ kind: 'disbandFleet', fleetId: group.id, systemId: this.selected }), 'conquest-disband', manual && !!group && !groupTransit, 180);
    text(this, this.root!, 655, 638, 'Цены: кр./мин. · расход 0.005 топлива/гал. ед.', 14);
    this.pager(ships.length, 4);
  }

  private renderBattles(view: ConquestView): void {
    this.normalizePage(view.battles.length, 4);
    text(this, this.root!, 24, 385, 'Последние бои своей стороны', 17);
    [...view.battles].reverse().slice(this.page * 4, this.page * 4 + 4).forEach((battle, index) => {
      text(this, this.root!, 24, 440 + index * 45, `#${battle.id} · ход ${battle.turn} · ${battle.systemId} · ${battle.timedOut ? 'Лимит времени, без захвата' : battle.winner === this.observer ? 'Победа в бою' : battle.winner ? 'Поражение в бою' : 'Без победителя'} · потери: ${battle.destroyed.length}`, 16);
    });
    this.control(930, 385, 'Воспроизвести последний', () => this.openReplay(), 'conquest-replay', !!this.frames, 295);
    this.pager(view.battles.length, 4);
  }

  private showColonyEffects(view: ConquestView): void {
    const colony = view.population.find(item => item.systemId === this.selected);
    const output = view.colonyOutput.forecast.production.find(item => item.systemId === this.selected);
    if (!colony || !output) throw new Error('Разбивка доступна только собственной колонии');
    this.pauseAi(); this.render();
    const values = [
      { label: 'Рост (в базисных пунктах: 100 = 1%)', value: colony.technology.growthRate },
      { label: 'Вместимость (тыс. жителей)', value: colony.technology.capacity },
      { label: 'Промышленность', value: output.breakdown.production },
      { label: 'Наука', value: output.breakdown.science },
      { label: 'Культура', value: output.breakdown.culture }
    ];
    chooseItem(this, 'Разбивка своей колонии', values, value => {
      chooseItem(this, 'База / труд / технологии / предел', [
        `База: ${value.base}`, `Работников: ${value.workers}`, `Труд: ${value.labor}`,
        `Технологии: ${value.technology >= 0 ? '+' : ''}${value.technology}`,
        `Предел: ${value.limit}`, `Итог: ${value.total}`
      ].map(label => ({ label, value: label })), () => {});
    });
  }

  private showColonyProjects(view: ConquestView, manual: boolean): void {
    const systemId = this.selected;
    const source = this.state;
    this.pauseAi(); this.render();
    const quote = view.terraforming.find(item => item.systemId === systemId)?.quote;
    const projects = view.workProjects.filter(project => project.systemId === systemId);
    const forecast = view.colonyOutput.forecast.production.find(item => item.systemId === systemId);
    const items: Array<{ label: string; value: number }> = projects.map(project => {
      const refund = getColonyProjectRefund(project);
      const timing = forecast?.orderId !== project.id ? 'ожидает FIFO' : !forecast.productionPoints
        ? 'пауза: нет промышленности' : `${Math.ceil((project.productionCost - project.productionProgress) / forecast.productionPoints)} своих ходов`;
      return { label: `#${project.id} ${project.kind === 'terraform' ? 'toxic→habitable' : `refit ship#${project.shipId}`}: ${project.productionProgress}/${project.productionCost}, ${timing}. Отмена: ${refund.credits}/${refund.minerals}`,
        value: project.id };
    });
    items.push({ label: quote?.ok
      ? `Начать toxic→habitable: ${quote.cost.credits} кр./${quote.cost.minerals} мин., ${quote.productionCost} очков общего FIFO`
      : quote?.reason ?? 'Нужна собственная колония', value: 0 });
    chooseItem(this, 'Общий FIFO: корабли и работы мира', items, id => {
      if (this.disposed || this.state !== source) return;
      if (!manual) { this.message = 'Работы доступны только активной управляемой стороне'; this.render(); return; }
      if (id) {
        const project = projects.find(project => project.id === id)!;
        const refund = getColonyProjectRefund(project);
        const timing = forecast?.orderId !== id ? 'Ожидает общего FIFO' : productionTiming(view, systemId);
        this.confirm(`${project.productionProgress}/${project.productionCost} очков. ${timing}.\nОтменить работу? Возврат ${refund.credits} кр./${refund.minerals} мин., только за неиспользованные очки.`, () =>
          this.command({ kind: 'cancelColonyProject', systemId, projectId: id }));
      } else if (quote?.ok) this.confirm(`toxic → habitable: ${quote.cost.credits} кр./${quote.cost.minerals} мин., ${quote.productionCost} очков.\nОплатить проект? Промышленность общая с кораблями; захват отменяет работу без возврата.`, () =>
        this.command({ kind: 'startTerraform', systemId }));
      else { this.message = quote?.reason ?? 'Работа недоступна'; this.render(); }
    });
  }

  private requestRefit(view: ConquestView, shipId: number): void {
    const source = this.state;
    const ship = view.ships.find(ship => ship.id === shipId);
    if (!ship) { this.message = 'Корабль недоступен в текущем наблюдении'; this.render(); return; }
    const active = view.workProjects.find(project => project.kind === 'refit' && project.shipId === shipId);
    if (active) {
      const refund = getColonyProjectRefund(active);
      const forecast = view.colonyOutput.forecast.production.find(row => row.systemId === ship.systemId);
      const timing = forecast?.orderId !== active.id ? 'Ожидает общего FIFO' : productionTiming(view, ship.systemId);
      this.confirm(`Переоснащение #${active.id}: ${active.productionProgress}/${active.productionCost} очков. ${timing}.\nОтменить за ${refund.credits} кр./${refund.minerals} мин.?`, () =>
        this.command({ kind: 'cancelColonyProject', systemId: ship.systemId, projectId: active.id }));
      return;
    }
    const candidates = view.projects.filter(project => project.design.hullId === ship.design.hullId &&
      isCampaignDesignAvailable(project.design, view.research, view.researchTree));
    if (!candidates.length) { this.message = 'Сохраните свой доступный полётный проект того же корпуса'; this.render(); return; }
    this.pauseAi(); this.render();
    chooseItem(this, 'Переоснащение: собственный проект', candidates.map(project => {
      const quote = getRefitQuote(ship.design, project.design, view.colonyOutput.rules.productionCreditsPerPoint);
      return { label: `${project.name}: ${quote.cost.credits} кр./${quote.cost.minerals} мин., ${quote.productionCost} очков FIFO`,
        value: project.design };
    }), design => {
      if (this.disposed || this.state !== source) return;
      const quote = getRefitQuote(ship.design, design, view.colonyOutput.rules.productionCreditsPerPoint);
      this.confirm(`${quote.cost.credits} кр./${quote.cost.minerals} мин., ${quote.productionCost} очков общего FIFO.\nОплатить refit? До завершения полёт/группировка заблокированы; HP/топливо не добавляются, новое оружие пустое.`, () =>
        this.command({ kind: 'startRefit', shipId, systemId: ship.systemId, design: structuredClone(design) }));
    });
  }

  private showResearchJournal(view: ConquestView): void {
    this.pauseAi(); this.render();
    const items = view.researchJournal.flatMap(entry => {
      const node = view.researchTree.nodes.find(item => item.id === entry.technologyId)!;
      return [
        { label: `${node.name} · открытие: ход ${entry.turn}`, value: entry.technologyId },
        { label: entry.activationTurn === null ? 'Развитие: следующий ход недоступен' :
          `Развитие: со своего конца хода ${entry.activationTurn}`, value: entry.technologyId }
      ];
    });
    chooseItem(this, 'Собственные открытия', items.length ? items : [{ label: 'Открытий пока нет', value: '' }], () => {});
  }

  private serviceCosts(view: ConquestView, shipId: number): { fuel: string; repair: string; ammunition: string } {
    const ship = view.ships.find(item => item.id === shipId)!;
    const atColony = view.galaxy.systems.some(system => system.id === ship.systemId && system.visibility === 'explored' && system.ownerId === this.observer);
    const rate = view.ships.filter(item => !item.transit && item.systemId === ship.systemId).flatMap(item => item.design.slots)
      .reduce((sum, slot) => sum + (slot.component?.kind === 'repair' ? slot.component.repairRate : 0), 0);
    const operation = view.operations[String(ship.id)];
    const repair = getRepairQuote(ship.design, operation, atColony, rate), ammunition = getAmmunitionQuote(ship.design, operation);
    const fuel = getStrategicRefuelQuote(ship.fuel, getTravelCapabilities(ship.design.strategicEquipment).fuelCapacity);
    return { fuel: `${fuel.cost.credits}/${fuel.cost.minerals}`, repair: `${repair.cost.credits}/${repair.cost.minerals}`,
      ammunition: `${ammunition.cost.credits}/${ammunition.cost.minerals}` };
  }

  private selectWorld(view: ConquestView): void {
    this.pauseAi(); this.render();
    const source = this.state;
    chooseItem(this, 'Миры галактики', view.galaxy.systems.map(system => ({ label: `${system.id} · ${system.name}`, value: system.id })), id => {
      if (this.disposed || this.state !== source) return;
      this.selectSystem(id);
    });
  }

  private populationLabel(view: ConquestView): string | undefined {
    const record = view.population.find(item => item.systemId === this.selected);
    if (!record) {
      const founding = view.colonization.find(item => item.systemId === this.selected);
      if (!founding) return undefined;
      if (!founding.quote.ok) return founding.quote.message;
      const colonizer = view.ships.some(ship => !ship.transit && ship.systemId === this.selected && ship.design.hullId === 'colonizer');
      return `Основание: ${colonizer ? 'колонизатор будет израсходован' : 'нужен колонизатор'} · 1 млн · ${view.foundingCost.credits}/${view.foundingCost.minerals} кр/мин · ${
        `из ${founding.quote.sourceId}`}`;
    }
    const millions = (amount: number) => (amount / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
    const reason = record.reason === 'empty' ? 'нет жителей' : record.reason === 'at-capacity' ? 'достигнут предел' :
      record.reason === 'over-capacity' ? 'выше вместимости' : `+${millions(record.delta)} млн/свой ход`;
    return `Население ${millions(record.population)}/${millions(record.capacity)} млн · ${reason}`;
  }

  private environmentLabel(view: ConquestView): string {
    const type = view.environmentKnowledge[this.selected];
    return type === 'habitable' ? 'пригодная среда' : type === 'toxic' ? 'токсичная среда'
      : type === 'barren' ? 'бесплодная среда' : 'среда не изучена';
  }

  private requestColonization(view: ConquestView): void {
    const systemId = this.selected;
    const ships = view.ships.filter(ship => ship.systemId === systemId && !ship.transit && ship.design.hullId === 'colonizer');
    if (ships.length === 1) {
      this.command({ kind: 'colonize', systemId, shipId: ships[0].id });
      return;
    }
    this.pauseAi(); this.render();
    const source = this.state;
    chooseItem(this, 'Выберите расходуемый колонизатор', ships.map(ship =>
      ({ label: `#${ship.id} · ${ship.design.name}`, value: ship.id })), shipId => {
      if (this.disposed || this.state !== source) return;
      this.command({ kind: 'colonize', systemId, shipId });
    });
  }

  private selectDestination(view: ConquestView, shipId?: number, fleetId?: number): void {
    this.pauseAi(); this.render();
    const source = this.state, systemId = this.selected;
    const fleet = view.fleets.find(item => item.id === fleetId);
    const ships = view.ships.filter(item => fleet ? fleet.shipIds.includes(item.id) : item.id === shipId);
    if (!ships.length) return;
    const routes = view.galaxy.systems.filter(system => system.id !== systemId).map(system => {
      const distance = getWorldDistance(view.galaxy.systems, systemId, system.id);
      const quotes = getFleetTravelQuotes(distance, ships.map(ship => ({
        capabilities: getTravelCapabilities(ship.design.strategicEquipment), fuel: ship.fuel })));
      const rejected = quotes.find(item => !item.quote.ok)?.quote;
      const quote = quotes[0].quote;
      const summary = rejected && !rejected.ok ? rejected.message : quote.ok ?
        `${quote.totalTurns} своих ходов · ${formatStrategicFuel(quote.fuelCost)} топлива/корабль` : quote.message;
      return { system, distance, quotes, summary, allowed: !rejected };
    });
    chooseItem(this, 'Прямой перелёт · срок и расход ›',
      routes.map(route => ({ label: `${route.allowed ? '' : 'Нельзя · '}${this.shorten(route.system.name, 18)} · ${route.summary}`, value: route })), route => {
        if (this.disposed || this.state !== source) return;
        const capabilities = route.quotes[0].capabilities;
        this.confirm(`${route.system.name}\n${route.distance.toFixed(3)} гал. ед. · ${route.summary}\n` +
          `Скорость ${capabilities.strategicSpeed}, переход ≤${capabilities.maxJumpDistance}.\n` +
          ships.map(ship => `#${ship.id}: бак ${formatStrategicFuel(ship.fuel)}/${formatStrategicFuel(getTravelCapabilities(ship.design.strategicEquipment).fuelCapacity)}`).join('; ') +
          '\nОтправить? Списание сразу, прибытие только после своих ходов.', () => {
          if (this.disposed || this.state !== source) return;
          const destinationId = route.system.id;
          if (fleetId !== undefined) this.command({ kind: 'sendFleet', fleetId, systemId, destinationId });
          else if (shipId !== undefined) this.command({ kind: 'sendShip', shipId, systemId, destinationId });
        });
      });
  }

  private travelLabel(ship: ConquestView['ships'][number]): string {
    const capabilities = getTravelCapabilities(ship.design.strategicEquipment);
    return `Скорость ${capabilities.strategicSpeed} ед./свой ход · переход ≤${capabilities.maxJumpDistance}`;
  }

  private renderNarrow(): void {
    const root = this.root!, width = this.cameras.main.width - 24;
    const label = (y: number, value: string, name?: string, color = '#c8d9ed') =>
      text(this, root, 12, y, value, 14, color).setWordWrapWidth(width, true).setName(name ?? '');
    const control = (y: number, value: string, action: () => void, name: string, enabled = true) =>
      this.control(12, y, value, action, name, enabled, width);
    if (!this.state) {
      label(24, 'Новая военная кампания');
      control(80, 'Создать карту', () => this.newGame(), 'conquest-new');
      control(132, 'Загрузить партию', () => this.requestLoad(), 'conquest-load');
      control(184, 'Справка', () => this.help(), 'conquest-help');
      control(236, 'Меню', () => this.escape(), 'conquest-menu');
      label(300, this.message, 'conquest-message', '#ffc08a');
      return;
    }
    const view = getConquestView(this.state, this.observer);
    const manual = view.outcome.status === 'ongoing' && view.activeFactionId === this.observer && !this.ticket &&
      this.phase !== 'running' && !(this.state.control.mode === 'human-vs-ai' && this.observer === 'red');
    label(12, view.outcome.status === 'completed' ? `Победа: ${view.outcome.winner === 'blue' ? 'Синие' : 'Красные'} · только просмотр` :
      `Ход ${view.turn} · ${view.activeFactionId === 'blue' ? 'Синие' : 'Красные'}${this.isAiTurn() ? ` · AI: ${this.phase}` : ''}`, 'conquest-status');
    label(44, `Кредиты ${view.treasury.credits} · Минералы ${view.treasury.minerals}`);
    const half = (width - 8) / 2;
    this.control(12, 72, 'Завершить ход', () => this.command({ kind: 'endTurn' }), 'conquest-end', manual, half);
    this.control(20 + half, 72, 'Справка', () => this.help(), 'conquest-help', true, half);
    const tabs = [['map', 'Мир'], ['research', 'Наука'], ['production', 'Заказы'], ['fleet', 'Корабли'], ['battles', 'Бои'], ['actions', 'Партия']] as const;
    const third = (width - 16) / 3;
    tabs.forEach(([tab, title], index) => this.control(12 + (index % 3) * (third + 8), 124 + Math.floor(index / 3) * 52, title, () => {
      if (tab !== 'map' && tab !== 'actions') {
        this.tab = tab;
      }
      this.page = 0;
      this.narrowSection = tab; this.render();
    }, `conquest-tab-${tab}`, true, third));
    const selected = view.galaxy.systems.find(system => system.id === this.selected)!;
    if (this.narrowSection === 'map') {
      label(240, `${this.shorten(selected.name, 24)} · ${selected.visibility === 'unknown' ? 'нет наблюдения' :
        selected.ownerId === this.observer ? 'своя колония' : selected.ownerId ? 'чужая колония' : 'свободный мир'} · ${this.environmentLabel(view)}`);
      control(294, `Выбрать мир · ${view.galaxy.systems.length} миров`, () => this.selectWorld(view), 'conquest-select-world');
      const index = view.galaxy.systems.findIndex(system => system.id === this.selected);
      this.control(12, 346, '← Мир', () => this.moveWorld(view, index - 1), 'conquest-world-prev', index > 0, half);
      this.control(20 + half, 346, 'Мир →', () => this.moveWorld(view, index + 1), 'conquest-world-next', index + 1 < view.galaxy.systems.length, half);
      control(680, 'Карта галактики', () => this.openMap(), 'conquest-open-map');
      label(402, this.populationLabel(view) ??
        `Свои корабли: ${view.ships.filter(ship => !ship.transit && ship.systemId === this.selected).length} · чужие: ${view.enemies.filter(ship => ship.systemId === this.selected).length}`, 'conquest-population');
      label(450, `Основание: 1 млн переселенцев · ${view.foundingCost.credits}/${view.foundingCost.minerals} кр/мин`);
      this.control(12, 486, `Изучить ${view.surveyCost.credits}/${view.surveyCost.minerals}`,
        () => this.command({ kind: 'survey', systemId: selected.id }), 'conquest-survey',
        manual && selected.visibility === 'explored' && !Object.prototype.hasOwnProperty.call(view.environmentKnowledge, selected.id), half);
      this.control(20 + half, 486, 'Колонизировать', () => this.requestColonization(view), 'conquest-colonize',
        manual && !!view.colonization.find(item => item.systemId === selected.id)?.quote.ok, half);
      label(544, 'Колонизатор расходуется; 1 млн жителей из своей колонии. Захват сохраняет население.');
      control(620, 'Разбивка колонии', () => this.showColonyEffects(view), 'conquest-effects',
        view.population.some(colony => colony.systemId === this.selected));
    } else if (this.narrowSection === 'actions') {
      control(240, 'Новая партия', () => this.newGame(), 'conquest-new');
      this.control(12, 292, 'Сохранить', () => this.save(), 'conquest-save', true, half);
      this.control(20 + half, 292, 'Загрузить', () => this.requestLoad(), 'conquest-load', true, half);
      control(344, 'Проекты кораблей', () => this.openProjectEditor(), 'conquest-projects');
      control(396, this.observer === 'blue' ? 'Наблюдение: синие' : 'Наблюдение: красные', () => {
        this.observer = this.observer === 'blue' ? 'red' : 'blue'; this.selectSystem(this.homeSelection());
      }, 'conquest-side', this.state.control.mode === 'local');
      if (this.isAiTurn()) control(448, this.ticket ? 'Пауза AI' : 'Продолжить AI', () => {
        if (this.ticket) { this.pauseAi(); this.render(); } else this.confirm('Выполнить ход компьютера?', () => this.scheduleAi());
      }, 'conquest-resume');
      else if (this.state.control.mode === 'local') control(448, 'AI: один ход', () => this.confirm('Поручить один ход компьютеру?', () => {
        this.accept(executeConquestAiTurn(this.state, this.observer, this.state.session.turn));
      }), 'conquest-ai', manual);
      if (this.state.control.mode === 'human-vs-ai') control(500, 'Ручное управление', () => this.confirm('Передать красную сторону человеку?',
        () => this.replace(convertConquestToLocal(this.state))), 'conquest-takeover');
      control(552, 'Меню', () => this.escape(), 'conquest-menu');
      const budget = view.economyForecast;
      label(566, `Доход: ${view.income.credits}/${view.income.minerals}\n` + (budget.ok ?
        `Содержание ${budget.upkeep.dueCredits} · оплата ${budget.upkeep.paidCredits} · дефицит ${budget.upkeep.shortfallCredits}` : `Бюджет: ${budget.code}`));
    } else if (this.narrowSection === 'research') {
      this.normalizePage(view.researchTree.nodes.length, 1);
      const node = view.researchTree.nodes[this.page];
      if (node) {
        const completed = view.research.completed.includes(node.id), active = view.research.activeId === node.id;
        fitText(label(240, node.name), width);
        label(278, completed ? 'Открыто' : `${getResearchProgress(view.research, node.id)}/${node.researchCost} научных очков`);
        label(310, node.effects.map(effect => describeResearchEffect(effect, view.researchTree, view.colonyTechnologyEffects)).join('; '),
          `conquest-research-effects-${node.id}`);
        label(414, `Нужно: ${node.prerequisites.join(', ') || 'нет'}`);
        control(456, completed ? 'Открыто' : active ? 'Исследуется' : 'Выбрать', () => this.command({ kind: 'research', technologyId: node.id }),
          `conquest-research-${node.id}`, manual && !completed && !active);
      }
      this.narrowPager(view.researchTree.nodes.length, 508);
      control(564, 'Приостановить', () => this.command({ kind: 'pauseResearch' }),
        'conquest-research-pause', manual && view.research.activeId !== null);
      const science = view.researchForecast.receipt;
      label(618, `Наука +${science.produced} · резерв ${science.reserveBefore}/${science.cap} · расход ${science.spent}\n${researchTiming(view)}`,
        'conquest-research-forecast');
      control(682, 'Журнал открытий', () => this.showResearchJournal(view), 'conquest-research-journal');
    } else if (this.narrowSection === 'production') {
      const choices = [{ design: createColonizerDesign(), source: 'Стартовый колонизатор' },
        ...view.projects.map(project => ({ design: project.design, source: `Проект #${project.id}` })),
        ...buildConquestDesigns(view.research, view.researchTree).map(design => ({ design, source: 'Кампанийный конструктор' }))];
      this.choice = Math.max(0, Math.min(this.choice, choices.length - 1));
      const choice = choices[this.choice];
      const own = selected.visibility === 'explored' && selected.ownerId === this.observer;
      label(236, `Производство: ${this.shorten(selected.name, 28)}`);
      if (choice) {
        const available = isCampaignDesignAvailable(choice.design, view.research, view.researchTree);
        fitText(label(268, choice.design.name), width);
        let quote: ReturnType<typeof getColonyProductionQuote> | undefined;
        try { quote = getColonyProductionQuote(choice.design, view.colonyOutput.rules); } catch {
          label(300, 'Цена отклонена: проект не прошёл полётную валидацию.');
        }
        if (quote) label(300, available ? `${quote.cost.credits} кр. / ${quote.cost.minerals} мин. · ${quote.productionCost} очков` : 'Недоступен: технология, параметры или полёт.');
        this.control(12, 336, '←', () => { this.choice--; this.render(); }, 'conquest-design-prev', this.choice > 0, 44);
        this.control(64, 336, '→', () => { this.choice++; this.render(); }, 'conquest-design-next', this.choice + 1 < choices.length, 44);
        this.control(116, 336, 'Заказать', () => this.command({ kind: 'enqueueProduction', systemId: selected.id, design: structuredClone(choice.design) }),
          'conquest-enqueue', manual && own && available && !!quote, width - 104);
      }
      const workers = view.colonyOutput.assignments[selected.id];
      if (workers) {
        control(388, this.narrowWorkersOpen ? '← К производству' : 'Рабочие и резервы',
          () => { this.narrowWorkersOpen = !this.narrowWorkersOpen; this.render(); }, 'conquest-workers-toggle');
      }
      if (workers && this.narrowWorkersOpen) {
        label(440, `Рабочие: ${workers.population} · свободны ${workers.unassigned}`);
        for (const [index, [role, caption]] of ([
          ['industry', 'Промышленность'], ['research', 'Наука'], ['culture', 'Культура']
        ] as const).entries()) {
          const y = 472 + index * 48;
          this.control(12, y, '−', () => this.adjustWorkers(view, selected.id, role, -1),
            `conquest-workers-${role}-minus`, manual && workers[role] > 0, 46);
          fitText(text(this, root, 68, y + 11,
            `${caption}: ${workers[role]} · ${view.colonyOutput.forecast.production.find(row => row.systemId === selected.id)!.breakdown[
              role === 'industry' ? 'production' : role === 'research' ? 'science' : 'culture'].total} очк./ход`, 14), width - 126);
          this.control(width - 58, y, '+', () => this.adjustWorkers(view, selected.id, role, 1),
            `conquest-workers-${role}-plus`, manual && workers.unassigned > 0, 46);
        }
        label(620, `Резерв: наука ${view.colonyOutput.reserves.research}/${view.colonyOutput.reserveCaps.research} · культура ${view.colonyOutput.reserves.culture}/${view.colonyOutput.reserveCaps.culture}`);
        const forecast = view.colonyOutput.forecast.production.find(item => item.systemId === selected.id);
        if (forecast) label(658, `${forecast.productionPoints} произв. очк. · ${forecast.sciencePoints} науки · ${forecast.culturePoints} культуры за свой ход`);
      } else {
        this.control(12, workers ? 440 : 388, 'Чертежи', () => this.openProjectEditor(), 'conquest-projects', true, (width - 8) / 2);
        this.control(20 + (width - 8) / 2, workers ? 440 : 388, 'Работы мира',
          () => this.showColonyProjects(view, manual), 'conquest-world-projects', own, (width - 8) / 2);
        label(492, `Полная оплата сразу. FIFO: ${productionTiming(view, selected.id)}.`)
          .setName('conquest-production-forecast');
        const records = [...view.production.orders, ...view.production.completed].filter(record => record.systemId === selected.id);
        this.normalizePage(records.length, 1);
        const record = records[this.page], order = record && view.production.orders.find(item => item.id === record.id);
        if (record) {
          fitText(label(544, `#${record.id} ${record.design.name}`), width);
          label(572, order ? `${order.productionProgress}/${order.productionCost} очков · возврат ${getColonyProductionRefund(order).credits} кр. / ${getColonyProductionRefund(order).minerals} мин.` : 'Готов к размещению');
        } else label(544, 'Очередь и готовые корабли: пусто');
        if (record) control(604, order ? 'Отменить заказ' : 'Разместить', () => this.command({
          kind: order ? 'cancelProduction' : 'deployProduction', systemId: selected.id, orderId: record.id
        }), `conquest-order-${record.id}`, manual && own);
        this.narrowPager(records.length, 652);
      }
    } else if (this.narrowSection === 'fleet') this.renderNarrowFleet(view, manual);
    else {
      this.normalizePage(view.battles.length, 1);
      const battle = [...view.battles].reverse()[this.page];
      label(240, battle ? `Бой #${battle.id} · ход ${battle.turn} · ${battle.systemId}\n${battle.timedOut ? 'Лимит времени, без захвата' :
        battle.winner === this.observer ? 'Победа в бою' : battle.winner ? 'Поражение' : 'Без победителя'}\nПотери: ${battle.destroyed.length}` : 'Бои своей стороны: пока нет отчётов');
      control(348, 'Воспроизвести последний', () => this.openReplay(), 'conquest-replay', !!this.frames);
      this.narrowPager(view.battles.length, 410);
      label(482, 'Отчёт и воспроизведение не являются новой командой. После загрузки есть отчёты, но нет кадров replay.');
    }
    label(this.cameras.main.height - 104, this.message, 'conquest-message', '#ffc08a');
  }

  private narrowSection: Tab | 'map' | 'actions' = 'map';

  private moveWorld(view: ConquestView, index: number): void {
    this.selectSystem(view.galaxy.systems[index].id);
  }

  private narrowPager(total: number, y: number): void {
    this.control(12, y, '←', () => { this.page--; this.render(); }, 'conquest-page-prev', this.page > 0, 44);
    text(this, this.root!, 72, y + 12, `${this.page + 1} / ${Math.max(1, total)}`, 14);
    this.control(150, y, '→', () => { this.page++; this.render(); }, 'conquest-page-next', this.page + 1 < total, 44);
  }

  private renderNarrowFleet(view: ConquestView, manual: boolean): void {
    const width = this.cameras.main.width - 24, third = (width - 16) / 3;
    const label = (y: number, value: string) => text(this, this.root!, 12, y, value, 14).setWordWrapWidth(width, true);
    const ships = view.ships.filter(ship => ship.systemId === this.selected);
    this.normalizePage(ships.length, 1);
    this.selectedShips = this.selectedShips.filter(id => ships.some(ship => ship.id === id));
    const current = ships[this.page];
    if (current) {
      this.control(12, 236, `${this.selectedShips.includes(current.id) ? '☑' : '☐'} #${current.id} ${current.design.name}`, () => {
        this.selectedGroup = undefined;
        this.selectedShips = this.selectedShips.includes(current.id) ? this.selectedShips.filter(id => id !== current.id) : [...this.selectedShips.slice(-9), current.id];
        this.render();
      }, `conquest-ship-${current.id}`, true, width);
      const operation = view.operations[String(current.id)];
      label(288, `HP ${Math.ceil(operation.hull)} · бак ${formatStrategicFuel(current.fuel)}/${formatStrategicFuel(getTravelCapabilities(current.design.strategicEquipment).fuelCapacity)}\n${current.transit ? `→ ${current.transit.destinationId} · ${current.transit.remainingTurns} своих ходов` : `Снаряды: ${operation.ammunition.map(item => item.amount).join(', ') || '—'}`}`);
    } else label(240, `Свои корабли: ${this.shorten(view.galaxy.systems.find(system => system.id === this.selected)!.name, 24)} — нет`);
    const ship = ships.find(item => item.id === this.selectedShips[0]);
    const groups = view.fleets.filter(item => item.systemId === this.selected), group = groups.find(item => item.id === this.selectedGroup);
    const groupTransit = group && getFleetTransit(group, view.ships);
    const stationary = !!ship && !ship.transit, costs = ship ? this.serviceCosts(view, ship.id) : undefined;
    this.control(12, 344, costs ? `Бак ${costs.fuel}` : 'Заправить', () => ship && this.command({ kind: 'refuelShip', systemId: ship.systemId, shipId: ship.id }),
      'conquest-refuel', manual && stationary && ship!.fuel < getTravelCapabilities(ship!.design.strategicEquipment).fuelCapacity, third);
    this.control(20 + third, 344, costs ? `HP ${costs.repair}` : 'Ремонт', () => ship && this.command({ kind: 'repairShip', systemId: ship.systemId, shipId: ship.id }),
      'conquest-repair', manual && stationary, third);
    this.control(28 + third * 2, 344, costs ? `Снар. ${costs.ammunition}` : 'Боезапас', () => ship && this.command({ kind: 'resupplyShip', systemId: ship.systemId, shipId: ship.id }),
      'conquest-resupply', manual && stationary, third);
    this.control(12, 400, 'Выбрать цель перелёта', () => this.selectDestination(view, ship?.id, group?.id),
      'conquest-select-destination', manual && (!!group && !groupTransit || stationary) &&
        !view.workProjects.some(project => project.kind === 'refit' && project.shipId === ship?.id), (width - 8) / 2);
    this.control(20 + (width - 8) / 2, 400, 'Переоснастить', () => ship && this.requestRefit(view, ship.id),
      'conquest-refit', manual && stationary, (width - 8) / 2);
    label(452, groupTransit ? `В пути → ${groupTransit.destinationId} · ${groupTransit.remainingTurns} своих ходов` :
      ship ? this.travelLabel(ship) : 'Прямой перелёт по возможностям проекта');
    this.control(12, 510, 'Группа +', () => this.command({ kind: 'createFleet', systemId: this.selected, shipIds: [...this.selectedShips] }),
      'conquest-create-fleet', manual && this.selectedShips.length >= 2, third);
    this.control(20 + third, 510, 'Выбрать', () => {
      this.pauseAi(); this.render(); const source = this.state;
      chooseItem(this, 'Группы', groups.map(item => ({ label: `#${item.id}: ${item.shipIds.join(', ')}`, value: item.id })), id => {
        if (this.disposed || this.state !== source) return;
        this.selectedGroup = id; this.selectedShips = []; this.render();
      });
    }, 'conquest-select-fleet', groups.length > 0, third);
    this.control(28 + third * 2, 510, 'Разделить', () => group && this.command({ kind: 'disbandFleet', systemId: group.systemId, fleetId: group.id }),
      'conquest-disband', manual && !!group && !groupTransit, third);
    label(564, group ? `Группа #${group.id} · кораблей ${group.shipIds.length}` : `Выбрано кораблей: ${this.selectedShips.length}${ship ? ` · первый #${ship.id}` : ''}`);
    this.narrowPager(ships.length, 612);
    label(668, costs ? `Цены кр./мин.: бак ${costs.fuel}, HP ${costs.repair}, снаряды ${costs.ammunition}. Расход0.005/ед.` :
      'Цены: кр./мин. Расход0.005 топлива/гал. ед.');
  }

  private openReplay(): void {
    this.pauseAi(); this.render();
    if (!this.frames) return;
    const modal = openShipyardModal(this);
    if (!modal) return;
    const background = this.add.graphics(); modal.overlay.add(background);
    const viewport = this.cameras.main;
    background.fillStyle(0x101820).fillRect(0, 0, viewport.width, viewport.height);
    const graphics = this.add.graphics(); modal.overlay.add(graphics);
    const label = text(this, modal.overlay, 30, 20, 'Бой', 20);
    const positions = this.frames.flatMap(frame => frame.ships);
    const left = Math.min(...positions.map(ship => ship.x)), top = Math.min(...positions.map(ship => ship.y));
    const width = Math.max(1, Math.max(...positions.map(ship => ship.x)) - left);
    const height = Math.max(1, Math.max(...positions.map(ship => ship.y)) - top);
    this.replay = { background, graphics, label, seconds: 0, paused: false, left, top,
      scale: Math.min((viewport.width - 60) / width, (viewport.height - 160) / height) };
    modal.overlay.once('destroy', () => { this.replay = undefined; });
    button(this, modal.overlay, 12, viewport.height - 55, 'Пауза / продолжить', () => { if (this.replay) this.replay.paused = !this.replay.paused; }, 'conquest-replay-pause', 190);
    button(this, modal.overlay, viewport.width - 152, viewport.height - 55, 'Закрыть', () => { this.replay = undefined; modal.close(); }, 'conquest-replay-close', 140);
  }

  update(_time: number, delta: number): void {
    const replay = this.replay;
    if (!replay || !this.frames?.length || !isShipyardModalOpen(this)) { this.replay = undefined; return; }
    const elapsed = Number.isFinite(delta) && delta > 0 ? delta / 1000 * 8 : 0;
    if (!replay.paused) replay.seconds = Math.min(this.frames[this.frames.length - 1].seconds, replay.seconds + elapsed);
    const frame = this.frames.find(item => item.seconds >= replay.seconds) ?? this.frames[this.frames.length - 1];
    replay.graphics.clear();
    for (const ship of frame.ships) {
      const xpos = 30 + (ship.x - replay.left) * replay.scale, ypos = 80 + (ship.y - replay.top) * replay.scale;
      replay.graphics.fillStyle(ship.hull > 0 ? ship.factionId === 'blue' ? 0x55baff : 0xf08070 : 0x444444);
      replay.graphics.fillTriangle(xpos, ypos - 7, xpos - 6, ypos + 6, xpos + 6, ypos + 6);
    }
    for (const event of frame.events) if (event.type === 'WeaponFired') replay.graphics.lineStyle(1, event.hit ? 0xffd77a : 0x667788)
      .lineBetween(30 + (event.from.x - replay.left) * replay.scale, 80 + (event.from.y - replay.top) * replay.scale,
        30 + (event.to.x - replay.left) * replay.scale, 80 + (event.to.y - replay.top) * replay.scale);
    replay.label.setText(`Бой · ${frame.seconds.toFixed(1)} с`);
  }
}