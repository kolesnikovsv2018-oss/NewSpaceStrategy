import { createConquest, conquestSchema, executeConquestCommand, convertConquestToLocal, getConquestView,
  getConquestOutcome, type Conquest, type ConquestCommand, type ConquestResult, type ConquestView } from '../domain/conquest';
import { buildConquestDesigns, executeConquestAiTurn } from '../domain/conquestAi';
import { getDefaultResearchTree, isCampaignDesignAvailable } from '../domain/campaignResearch';
import { getProductionQuote, getProductionRefund } from '../domain/production';
import { getRefuelQuote } from '../domain/campaignShips';
import { getRepairQuote, getAmmunitionQuote } from '../domain/campaignOperations';
import { HULLS, type ShipDesign } from '../domain/shipDesign';
import type { BattleFrame } from '../domain/conquestBattle';
import { getGalaxyDefinition, type CampaignFactionId, type SystemId } from '../domain/campaign';
import { MAX_GALAXY_WORLDS } from '../domain/galaxyMap';
import { generateBrowserGalaxy, createGalaxySeed } from '../utils/BrowserGalaxyGenerator';
import { LocalGalaxyMapRepository, type GalaxyMapRepository } from '../utils/GalaxyMapRepository';
import { ConquestSaveManager } from '../utils/ConquestSaveManager';
import { parseResearchTreeYaml, MAX_RESEARCH_TREE_BYTES } from '../utils/ResearchTreeYaml';
import { loadProductionCatalog, type ProductionCatalog } from '../utils/ProductionCatalog';
import { button, text, chooseItem } from '../ui/ShipyardWidgets';
import { openShipyardModal, closeShipyardModal, isShipyardModalOpen } from '../ui/ShipyardModal';

type Tab = 'research' | 'production' | 'fleet' | 'battles';
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
  private catalog?: ProductionCatalog;
  private message = '';
  private disposed = true;
  private ticket?: Phaser.Time.TimerEvent;
  private phase: 'idle' | 'scheduled' | 'running' | 'paused' | 'failed' = 'idle';
  private readonly repository = new ConquestSaveManager();
  private frames?: BattleFrame[];
  private fileInput?: HTMLInputElement;
  private dialogToken?: object;
  private replay?: { background: Phaser.GameObjects.Graphics; graphics: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text; seconds: number; paused: boolean; left: number; top: number; scale: number };

  constructor(private readonly mapRepository: GalaxyMapRepository = new LocalGalaxyMapRepository()) {
    super({ key: 'ConquestScene' });
  }

  create(): void {
    this.disposed = false;
    this.render();
    this.input.keyboard?.on('keydown-ESC', this.escape, this);
    this.events.once('shutdown', () => {
      this.disposed = true; this.pauseAi(); this.dialogToken = undefined;
      this.fileInput?.remove(); this.fileInput = undefined;
      this.input.keyboard?.off('keydown-ESC', this.escape, this);
      closeShipyardModal(this); this.root?.destroy(true); this.root = undefined; this.replay = undefined; this.frames = undefined;
      Reflect.deleteProperty(this, 'state');
    });
    this.newGame();
  }

  private escape(): void {
    if (isShipyardModalOpen(this)) return;
    if (this.ticket) { this.pauseAi(); this.render(); return; }
    this.confirm('Выйти в меню? Несохранённая партия будет потеряна.', () => this.scene.start('MenuScene'));
  }

  private replace(state: Conquest): void {
    this.pauseAi();
    this.state = conquestSchema.parse(state);
    this.observer = this.state.control.mode === 'human-vs-ai' ? 'blue' : this.state.session.turn % 2 ? 'blue' : 'red';
    this.selected = this.homeSelection();
    this.phase = this.isAiTurn() ? 'paused' : 'idle';
    this.tab = 'research'; this.page = 0; this.choice = 0; this.catalog = undefined;
    this.selectedShips = []; this.selectedGroup = undefined; this.frames = undefined; this.message = '';
    this.render();
  }

  private isAiTurn(): boolean {
    return !!this.state && this.state.control.mode === 'human-vs-ai' && this.state.session.turn % 2 === 0 && getConquestOutcome(this.state).status === 'ongoing';
  }

  private homeSelection(): SystemId {
    return this.state.session.galaxy.systems.find(system => system.ownerId === this.observer)?.id ??
      getGalaxyDefinition(this.state.session.galaxy).factions.find(faction => faction.id === this.observer)!.homeSystemId;
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
      this.message = '';
      if (getConquestOutcome(this.state).status === 'completed') { this.pauseAi(); this.phase = 'idle'; }
    } else this.message = result.message;
    this.render();
  }

  private command(payload: Omit<ConquestCommand, 'factionId' | 'expectedTurn'> | Record<string, unknown>): void {
    if (this.disposed || isShipyardModalOpen(this) || this.phase === 'running' || this.ticket) return;
    const result = executeConquestCommand(this.state, { ...payload, factionId: this.observer, expectedTurn: this.state.session.turn });
    this.accept(result);
    if (result.ok && payload.kind === 'endTurn') this.scheduleAi();
  }

  private confirm(title: string, action: () => void): void {
    this.pauseAi(); this.render();
    const source = this.state, modal = openShipyardModal(this);
    if (!modal) return;
    const content = this.add.container(290, 240); modal.overlay.add(content);
    text(this, content, 0, 0, title, 20).setWordWrapWidth(700);
    button(this, content, 0, 130, 'Отмена', () => modal.close(), 'conquest-cancel');
    button(this, content, 480, 130, 'Подтвердить', () => {
      if (modal.close() && !this.disposed && this.state === source) action();
    }, 'conquest-confirm');
  }

  private save(): void {
    const snapshot = structuredClone(this.state);
    this.confirm('Заменить общий слот сохранения этой партией?', () => {
      const result = this.repository.save(snapshot);
      this.message = result.ok ? 'Партия сохранена' : result.message; this.render();
    });
  }

  private requestLoad(): void {
    this.pauseAi();
    const source = this.state;
    const result = this.repository.load();
    if (this.disposed || this.state !== source) return;
    if (!result.ok) { this.message = result.message; this.render(); return; }
    this.confirm('Заменить текущую партию сохранённой?', () => this.replace(result.state));
  }

  private newGame(): void {
    this.pauseAi(); this.render();
    const modal = openShipyardModal(this);
    if (!modal) return;
    const token = {}; this.dialogToken = token;
    modal.overlay.once('destroy', () => {
      if (this.dialogToken !== token) return;
      this.dialogToken = undefined; this.fileInput?.remove(); this.fileInput = undefined;
    });
    const source = this.state;
    let tree = getDefaultResearchTree();
    const content = this.add.container(280, 195); modal.overlay.add(content);
    text(this, content, 0, 0, 'Новая военная кампания', 24);
    text(this, content, 0, 50, source ? 'Текущая несохранённая партия будет заменена.' : 'Карта будет создана и сохранена перед началом партии.', 16);
    const treeLabel = text(this, content, 0, 92, `Дерево: ${tree.id}`, 16);
    let worldCount = 40;
    let busy = false;
    const countLabel = text(this, content, 80, 135, `Миров: ${worldCount}`, 18).setName('conquest-world-count');
    const adjustCount = (delta: number) => {
      if (busy || this.dialogToken !== token) return;
      worldCount = Math.max(6, Math.min(MAX_GALAXY_WORLDS, worldCount + delta));
      countLabel.setText(`Миров: ${worldCount}`);
    };
    button(this, content, 0, 128, '−1', () => adjustCount(-1), 'conquest-worlds-minus');
    button(this, content, 225, 128, '+1', () => adjustCount(1), 'conquest-worlds-plus');
    button(this, content, 290, 128, '−10', () => adjustCount(-10), 'conquest-worlds-minus-ten');
    button(this, content, 365, 128, '+10', () => adjustCount(10), 'conquest-worlds-plus-ten');
    button(this, content, 475, 128, 'Участники: 2', () => {}, 'conquest-participants').disableInteractive().setAlpha(0.6);
    const notice = text(this, content, 0, 185, '', 14, '#ffbb88').setWordWrapWidth(720).setName('conquest-generation-error');
    button(this, content, 0, 245, 'Дерево YAML / JSON', () => {
      if (busy || this.dialogToken !== token) return;
      this.fileInput?.remove();
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.yaml,.yml,.json'; this.fileInput = input;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          if (file.size > MAX_RESEARCH_TREE_BYTES) throw new Error('Файл превышает 256 КБ');
          const parsed = parseResearchTreeYaml(await file.text());
          if (this.disposed || this.state !== source || this.dialogToken !== token || !isShipyardModalOpen(this)) return;
          tree = parsed; treeLabel.setText(`Дерево: ${this.shorten(tree.id, 55)}`); notice.setText('');
        } catch {
          if (!this.disposed && this.dialogToken === token && isShipyardModalOpen(this)) notice.setText('Дерево не принято: проверьте формат, зависимости и ограничения');
        } finally { input.remove(); }
      };
      input.click();
    }, 'conquest-import-tree');
    const begin = async (ai: boolean) => {
      if (busy || this.disposed || this.state !== source || this.dialogToken !== token || !isShipyardModalOpen(this)) return;
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
    button(this, content, 0, 300, 'Локальная партия', () => { void begin(false); }, 'conquest-new-local');
    button(this, content, 235, 300, 'Против компьютера', () => { void begin(true); }, 'conquest-new-ai');
    button(this, content, 540, 300, 'Отмена', () => { this.dialogToken = undefined; modal.close(); }, 'conquest-new-cancel');
  }

  private shorten(value: string, maximum = 45): string { return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value; }

  private normalizePage(total: number, size: number): void {
    this.page = Math.max(0, Math.min(this.page, Math.max(0, Math.ceil(total / size) - 1)));
  }

  private control(x: number, y: number, label: string, action: () => void, name: string, enabled = true, width = 145): void {
    const root = this.root!;
    const item = button(this, root, x, y, label, () => {
      if (!this.disposed && this.root === root && enabled && !isShipyardModalOpen(this)) action();
    }, name).setFixedSize(width, 32);
    while (item.context.measureText(item.text).width > width - 18 && item.text.length > 1) item.setText(`${item.text.slice(0, -2)}…`);
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
    this.root?.destroy(true);
    const root = this.add.container(0, 0).setName('conquest-root'); this.root = root;
    if (!this.state) {
      text(this, root, 24, 30, 'Новая военная кампания', 28);
      this.control(24, 100, 'Создать карту', () => this.newGame(), 'conquest-new', true, 180);
      this.control(230, 100, 'Загрузить партию', () => this.requestLoad(), 'conquest-load', true, 180);
      this.control(440, 100, 'Меню', () => this.escape(), 'conquest-menu');
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
    this.control(1080, 20, 'Выбрать мир', () => {
      this.pauseAi(); this.render();
      const source = this.state;
      chooseItem(this, 'Миры галактики', view.galaxy.systems.map(system => ({ label: `${system.id} · ${system.name}`, value: system.id })), id => {
        if (this.disposed || this.state !== source) return;
        this.selected = id; this.selectedShips = []; this.selectedGroup = undefined; this.page = 0; this.render();
      });
    }, 'conquest-select-world', true, 170);
    if (this.state.control.mode === 'human-vs-ai') {
      this.control(880, 20, 'Ручное управление', () => this.confirm('Передать красную сторону человеку?', () => this.replace(convertConquestToLocal(this.state))), 'conquest-takeover', true, 190);
    }
    const outcome = view.outcome;
    text(this, root, 24, 93, outcome.status === 'completed' ? `Победа: ${outcome.winner === 'blue' ? 'Синий союз' : 'Красная лига'}` :
      `Ход ${view.turn} · ${view.activeFactionId === 'blue' ? 'Синий союз' : 'Красная лига'}`, 18, outcome.status === 'completed' ? '#8edfc1' : '#e5efef').setName('conquest-status');
    this.control(730, 84, this.observer === 'blue' ? 'Синий союз' : 'Красная лига', () => {
      this.observer = this.observer === 'blue' ? 'red' : 'blue'; this.selected = this.homeSelection();
      this.selectedShips = []; this.selectedGroup = undefined; this.page = 0; this.render();
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
    text(this, root, 740, 229, `${selected.name}: ${selected.visibility === 'unknown' ? 'нет наблюдения' : !selected.habitable ? 'непригодна для колонии' :
      selected.ownerId === this.observer ? 'своя колония' : selected.ownerId ? 'колония противника' : 'свободная планета'}`, 17);
    text(this, root, 740, 261, `Свои корабли: ${view.ships.filter(ship => !ship.transit && ship.systemId === this.selected).length} · видимые чужие: ${view.enemies.filter(ship => ship.systemId === this.selected).length}`, 15);
    text(this, root, 740, 290, this.isAiTurn() ? `Компьютер: ${this.phase}` : `Свои планеты: ${view.galaxy.systems.filter(system => system.visibility === 'explored' && system.ownerId === this.observer).length} / ${view.totalHabitableWorlds}`, 14, '#8edfc1');
    this.control(1080, 281, 'Колонизировать', () => this.command({ kind: 'colonize', systemId: this.selected }), 'conquest-colonize',
      manual && selected.visibility === 'explored' && selected.habitable && !selected.ownerId &&
      view.ships.some(ship => !ship.transit && ship.systemId === this.selected), 170);
    const generated = !!this.state.session.galaxy.map;
    if (generated) text(this, root, 24, 118, `Миров: ${view.galaxy.systems.length} · seed: ${this.state.session.galaxy.map!.seed}`, 12);
    const positions = new Map(view.galaxy.systems.map(system => [system.id, generated
      ? { x: 40 + system.x * 0.65, y: 135 + system.y * 0.16 }
      : { x: 85 + system.x * 160, y: 150 + (1 - system.y) * 48 }]));
    for (const [from, to] of view.galaxy.lanes) {
      const start = positions.get(from)!, end = positions.get(to)!;
      background.lineStyle(2, 0x43525e).lineBetween(start.x, start.y, end.x, end.y);
    }
    for (const system of view.galaxy.systems) {
      const position = positions.get(system.id)!;
      const color = system.visibility === 'unknown' ? 0x54606a : system.ownerId === 'blue' ? 0x55baff : system.ownerId === 'red' ? 0xf08070 : 0x8edfc1;
      const node = this.add.circle(position.x, position.y, generated ? 3 : 14, color).setName(`conquest-system-${system.id}`).setInteractive({ useHandCursor: true });
      if (this.selected === system.id) node.setStrokeStyle(3, 0xffffff);
      node.on('pointerdown', () => {
        if (this.root !== root || this.disposed || isShipyardModalOpen(this)) return;
        this.selected = system.id; this.selectedShips = []; this.selectedGroup = undefined; this.page = 0; this.render();
      }); root.add(node);
      if (!generated || this.selected === system.id) text(this, root, position.x - 35, position.y + 8, system.name, 13).setFixedSize(90, 18);
    }
    const tabs: [Tab, string][] = [['research', 'Исследования'], ['production', 'Производство'], ['fleet', 'Корабли и группы'], ['battles', 'Бои']];
    tabs.forEach(([tab, label], index) => this.control(24 + index * 195, 340, label, () => {
      this.tab = tab; this.page = 0;
      if (tab === 'production' && !this.catalog) this.catalog = loadProductionCatalog();
      this.render();
    }, `conquest-tab-${tab}`, true, 180));
    if (this.tab === 'research') this.renderResearch(view, manual);
    if (this.tab === 'production') this.renderProduction(view, manual);
    if (this.tab === 'fleet') this.renderFleet(view, manual);
    if (this.tab === 'battles') this.renderBattles(view);
    text(this, root, 24, 679, this.shorten(this.message, 155), 14, '#ffc08a').setWordWrapWidth(1210).setName('conquest-message');
  }

  private renderResearch(view: ConquestView, manual: boolean): void {
    this.normalizePage(view.researchTree.nodes.length, 4);
    text(this, this.root!, 24, 385, `Технологии · ${view.researchTree.id}`, 17);
    view.researchTree.nodes.slice(this.page * 4, this.page * 4 + 4).forEach((node, index) => {
      const ypos = 420 + index * 48, completed = view.research.completed.includes(node.id), active = view.research.active?.id === node.id;
      text(this, this.root!, 24, ypos, this.shorten(node.name, 48), 16).setWordWrapWidth(420);
      text(this, this.root!, 475, ypos, completed ? 'Открыто' : active ? `${view.research.active!.progress} / ${node.turns}` : `${node.credits} кредитов · ${node.turns} своих ходов`, 15);
      this.control(980, ypos - 8, completed ? 'Открыто' : active ? 'Исследуется' : 'Исследовать', () => this.command({ kind: 'research', technologyId: node.id }),
        `conquest-research-${node.id}`, manual && !completed && !view.research.active && node.prerequisites.every(id => view.research.completed.includes(id)) && view.treasury.credits >= node.credits, 230);
    });
    this.pager(view.researchTree.nodes.length, 4);
  }

  private renderProduction(view: ConquestView, manual: boolean): void {
    const choices: { design: ShipDesign; source: string }[] = [
      ...buildConquestDesigns(view.research, view.researchTree).map(design => ({ design, source: 'Кампанийный конструктор' })),
      ...(this.catalog?.choices ?? []).map(item => ({ design: item.design, source: item.source }))
    ];
    this.choice = Math.min(this.choice, Math.max(0, choices.length - 1));
    const choice = choices[this.choice];
    const own = view.galaxy.systems.some(system => system.id === this.selected && system.visibility === 'explored' && system.ownerId === this.observer);
    text(this, this.root!, 24, 385, `Проекты · ${this.choice + 1} / ${choices.length}`, 17);
    if (choice) {
      const available = isCampaignDesignAvailable(choice.design, view.research, view.researchTree);
      text(this, this.root!, 24, 420, this.shorten(choice.design.name, 48), 14).setWordWrapWidth(550);
      text(this, this.root!, 24, 451, `${choice.source} · ${HULLS[choice.design.hullId].name}`, 14);
      let quote: ReturnType<typeof getProductionQuote> | undefined;
      try { quote = getProductionQuote(choice.design); } catch {}
      text(this, this.root!, 24, 478, !available ? 'Проект недоступен: технология, профиль параметров или полётная валидация' :
        quote ? `${quote.cost.credits} кредитов / ${quote.cost.minerals} минералов · ${quote.turns} ходов` : 'Недопустимый проект', 14, available ? '#c8d9ed' : '#ffc08a');
      this.control(24, 516, '←', () => { this.choice--; this.render(); }, 'conquest-design-prev', this.choice > 0, 45);
      this.control(80, 516, '→', () => { this.choice++; this.render(); }, 'conquest-design-next', this.choice + 1 < choices.length, 45);
      this.control(145, 516, 'Заказать', () => this.command({ kind: 'enqueueProduction', systemId: this.selected, design: structuredClone(choice.design) }),
        'conquest-enqueue', manual && own && available && !!quote && view.treasury.credits >= quote.cost.credits && view.treasury.minerals >= quote.cost.minerals);
    }
    this.control(320, 516, 'Обновить библиотеку', () => { this.catalog = loadProductionCatalog(); this.render(); }, 'conquest-catalog', true, 225);
    text(this, this.root!, 24, 568, this.shorten(this.catalog?.notice ?? '', 65), 13).setWordWrapWidth(550);
    const records = [...view.production.orders, ...view.production.completed].filter(record => record.systemId === this.selected);
    this.normalizePage(records.length, 4);
    text(this, this.root!, 655, 385, 'Очередь и готовые корабли', 17);
    records.slice(this.page * 4, this.page * 4 + 4).forEach((record, index) => {
      const ypos = 420 + index * 48, order = view.production.orders.find(item => item.id === record.id);
      text(this, this.root!, 655, ypos, `#${record.id} ${this.shorten(record.design.name, 29)}`, 14);
      text(this, this.root!, 655, ypos + 19, order ? `Осталось ${order.remainingTurns} · возврат ${getProductionRefund(order).credits} кредитов` : 'Готов к размещению', 12);
      this.control(1080, ypos - 4, order ? 'Отменить' : 'Разместить', () => this.command({
        kind: order ? 'cancelProduction' : 'deployProduction', systemId: this.selected, orderId: record.id
      }), `conquest-order-${record.id}`, manual && own, 145);
    });
    this.pager(records.length, 4, 655);
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
      text(this, this.root!, 370, ypos, `Корпус ${Math.ceil(operation.hull)} · топливо ${ship.fuel}/3`, 14);
      text(this, this.root!, 370, ypos + 19, ship.transit ? `→ ${ship.transit.destinationId}` : `Боезапас: ${operation.ammunition.map(item => item.amount).join(', ') || '—'}`, 12);
    });
    const ship = ships.find(item => item.id === this.selectedShips[0]);
    const groups = view.fleets.filter(fleet => fleet.systemId === this.selected);
    const group = groups.find(fleet => fleet.id === this.selectedGroup);
    text(this, this.root!, 655, 385, group ? `Группа #${group.id}: ${group.shipIds.join(', ')}` : ship ? `Корабль #${ship.id}` : 'Выбор корабля или группы', 17);
    const stationary = !!ship && !ship.transit;
    this.control(655, 427, ship ? `Топливо: ${getRefuelQuote(ship.fuel).cost.credits} кр.` : 'Заправить', () => ship && this.command({ kind: 'refuelShip', systemId: this.selected, shipId: ship.id }), 'conquest-refuel', manual && stationary && ship!.fuel < 3, 180);
    this.control(845, 427, 'Ремонт', () => ship && this.command({ kind: 'repairShip', systemId: this.selected, shipId: ship.id }), 'conquest-repair', manual && stationary, 165);
    this.control(1020, 427, 'Боезапас', () => ship && this.command({ kind: 'resupplyShip', systemId: this.selected, shipId: ship.id }), 'conquest-resupply', manual && stationary, 175);
    const destinations = view.galaxy.lanes.flatMap(([from, to]) => from === this.selected ? [to] : to === this.selected ? [from] : []);
    destinations.forEach((destinationId, index) => this.control(655 + (index % 2) * 285, 478 + Math.floor(index / 2) * 35, `→ ${view.galaxy.systems.find(system => system.id === destinationId)!.name}`, () => {
      if (group) this.command({ kind: 'sendFleet', fleetId: group.id, systemId: this.selected, destinationId });
      else if (ship) this.command({ kind: 'sendShip', shipId: ship.id, systemId: this.selected, destinationId });
    }, `conquest-send-${destinationId}`, manual && (!!group || stationary), 270));
    this.control(655, 555, 'Создать группу', () => this.command({ kind: 'createFleet', systemId: this.selected, shipIds: [...this.selectedShips] }), 'conquest-create-fleet', manual && this.selectedShips.length >= 2, 180);
    this.control(845, 555, 'Выбрать группу', () => {
      this.pauseAi(); this.render();
      const source = this.state;
      chooseItem(this, 'Группы', groups.map(item => ({ label: `#${item.id}: ${item.shipIds.join(', ')}`, value: item.id })), id => {
        if (this.disposed || this.state !== source) return;
        this.selectedGroup = id; this.selectedShips = []; this.render();
      });
    }, 'conquest-select-fleet', groups.length > 0, 180);
    this.control(1035, 555, 'Расформировать', () => group && this.command({ kind: 'disbandFleet', fleetId: group.id, systemId: this.selected }), 'conquest-disband', manual && !!group, 180);
    if (ship) {
      const atColony = view.galaxy.systems.some(system => system.id === ship.systemId && system.visibility === 'explored' && system.ownerId === this.observer);
      const rate = view.ships.filter(item => !item.transit && item.systemId === ship.systemId).flatMap(item => item.design.slots)
        .reduce((sum, slot) => sum + (slot.component?.kind === 'repair' ? slot.component.repairRate : 0), 0);
      const operation = view.operations[String(ship.id)];
      const repair = getRepairQuote(ship.design, operation, atColony, rate), ammunition = getAmmunitionQuote(ship.design, operation);
      const fuel = getRefuelQuote(ship.fuel);
      text(this, this.root!, 655, 602, `Цена, кредиты / минералы: топливо ${fuel.cost.credits}/${fuel.cost.minerals}\n` +
        `Ремонт ${repair.cost.credits}/${repair.cost.minerals} · боезапас ${ammunition.cost.credits}/${ammunition.cost.minerals}`, 13).setWordWrapWidth(570);
    }
    this.pager(ships.length, 4);
  }

  private renderBattles(view: ConquestView): void {
    this.normalizePage(view.battles.length, 4);
    text(this, this.root!, 24, 385, 'Последние бои своей стороны', 17);
    [...view.battles].reverse().slice(this.page * 4, this.page * 4 + 4).forEach((battle, index) => {
      text(this, this.root!, 24, 426 + index * 45, `#${battle.id} · ход ${battle.turn} · ${battle.systemId} · ${battle.timedOut ? 'Лимит времени, без захвата' : battle.winner === this.observer ? 'Победа в бою' : battle.winner ? 'Поражение в бою' : 'Без победителя'} · потери: ${battle.destroyed.length}`, 16);
    });
    this.control(930, 385, 'Воспроизвести последний', () => this.openReplay(), 'conquest-replay', !!this.frames, 295);
    this.pager(view.battles.length, 4);
  }

  private openReplay(): void {
    this.pauseAi(); this.render();
    if (!this.frames) return;
    const modal = openShipyardModal(this);
    if (!modal) return;
    const background = this.add.graphics(); modal.overlay.add(background);
    background.fillStyle(0x101820).fillRect(0, 0, 1280, 720);
    const graphics = this.add.graphics(); modal.overlay.add(graphics);
    const label = text(this, modal.overlay, 30, 20, 'Бой', 20);
    const positions = this.frames.flatMap(frame => frame.ships);
    const left = Math.min(...positions.map(ship => ship.x)), top = Math.min(...positions.map(ship => ship.y));
    const width = Math.max(1, Math.max(...positions.map(ship => ship.x)) - left);
    const height = Math.max(1, Math.max(...positions.map(ship => ship.y)) - top);
    this.replay = { background, graphics, label, seconds: 0, paused: false, left, top,
      scale: Math.min(1220 / width, 560 / height) };
    modal.overlay.once('destroy', () => { this.replay = undefined; });
    button(this, modal.overlay, 30, 665, 'Пауза / продолжить', () => { if (this.replay) this.replay.paused = !this.replay.paused; }, 'conquest-replay-pause');
    button(this, modal.overlay, 1120, 665, 'Закрыть', () => { this.replay = undefined; modal.close(); }, 'conquest-replay-close');
  }

  update(_time: number, delta: number): void {
    const replay = this.replay;
    if (!replay || !this.frames || !isShipyardModalOpen(this)) { this.replay = undefined; return; }
    if (!replay.paused) replay.seconds += delta / 1000 * 8;
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