import type Phaser from 'phaser';
import { calculateComponent, calculateShipStats, COMPONENT_NAMES, componentSchema, createDesign, designSchema,
  HULLS, installComponent, newId, validateDesign, acceptsComponent, type ComponentDefinition, type ShipDesign, type HullId } from '../domain/shipDesign';
import { ShipDesignManager } from '../utils/ShipDesignManager';
import { drawBlueprint } from './ShipBlueprint';
import { button, text, panelBackground, chooseItem, confirmDiscard } from './ShipyardWidgets';
import { closeShipyardModal, isShipyardModalOpen, openShipyardModal } from './ShipyardModal';
import { hasUnsavedDesign } from '../domain/shipDraft';
import { COMBAT_PRESET_NAMES, createCombatDesign, type CombatPresetId } from '../domain/combatPresets';
import { CIVILIAN_PRESET_NAMES, createCivilianDesign, type CivilianPresetId } from '../domain/civilianPresets';
export interface CampaignShipBuilderContext {
  width: number;
  height: number;
  availableHulls: HullId[];
  isComponentAvailable: (component: ComponentDefinition) => boolean;
  isDesignAvailable: (design: ShipDesign) => boolean;
  onDraftChanged: () => void;
  readOnly: boolean;
}

export class ShipBuilderPanel {
  private readonly container: Phaser.GameObjects.Container;
  private design: ShipDesign;
  private savedDesign?: ShipDesign;
  private disposed = false;
  private importToken?: object;
  private catalogue: ComponentDefinition[] = [];
  private message = '';
  private error = false;

  constructor(private readonly scene: Phaser.Scene, x: number, y: number,
    private readonly repository: ShipDesignManager | undefined, initial = createDesign('corvette', true), saved?: ShipDesign,
    private readonly campaign?: CampaignShipBuilderContext) {
    this.container = scene.add.container(x, y);
    if (campaign) this.container.setDepth(101);
    this.design = designSchema.parse(initial);
    this.savedDesign = saved ? designSchema.parse(saved) : undefined;
    this.render();
  }

  private render(): void {
    if (this.campaign) {
      this.renderCampaign();
      return;
    }
    this.container.removeAll(true);
    panelBackground(this.scene, this.container, 700, 600);
    text(this.scene, this.container, 18, 18, 'ПРОЕКТ КОРАБЛЯ', 18, '#8de1f2');
    text(this.scene, this.container, 440, 22, this.hasUnsavedChanges() ? '● Не сохранён' : '✓ Сохранён', 14,
      this.hasUnsavedChanges() ? '#ffc880' : '#8af5bd').setName('design-save-status');
    button(this.scene, this.container, 18, 52, this.design.name.slice(0, 42), () => {
      const name = globalThis.prompt('Название проекта', this.design.name);
      if (name === null) return;
      this.perform(() => { this.design = designSchema.parse({ ...this.design, name }); }, 'Название изменено; сохраните проект');
    }, 'rename-design').setFixedSize(390, 30);
    button(this.scene, this.container, 440, 52, `Корпус: ${HULLS[this.design.hullId].name}`, () => {
      chooseItem(this.scene, 'Выберите корпус', Object.values(HULLS).map(hull => ({ label: `${hull.name} · ${hull.maxMass} т · ${hull.hitPoints} HP`, value: hull.id })),
        hullId => this.changeHull(hullId));
    }, 'change-hull');
    const graphics = this.scene.add.graphics({ x: 110, y: 175 });
    this.container.add(graphics);
    drawBlueprint(graphics, this.design);
    graphics.setScale(1.7);
    button(this.scene, this.container, 18, 257, 'Готовые проекты', () => {
      chooseItem(this.scene, 'Фабричные комплектации — новый проект', [
        ...(Object.keys(COMBAT_PRESET_NAMES) as CombatPresetId[]).map(id => ({ label: COMBAT_PRESET_NAMES[id], value: () => createCombatDesign(id) })),
        ...(Object.keys(CIVILIAN_PRESET_NAMES) as CivilianPresetId[]).map(id => ({ label: CIVILIAN_PRESET_NAMES[id], value: () => createCivilianDesign(id) }))
      ], create => this.replaceDesign(create, 'Фабричный проект загружен как новый черновик; сохраните изменения'));
    }, 'combat-presets');
    const stats = calculateShipStats(this.design);
    text(this.scene, this.container, 240, 110,
      `Масса: ${stats.mass.toFixed(1)} / ${HULLS[this.design.hullId].maxMass} т\n` +
      `Стоимость: ${stats.cost} ₡ · Корпус: ${stats.hitPoints} HP\n` +
      `Скорость: ${stats.speed.toFixed(1)} такт. ед/с · Щит: ${stats.shield}\n` +
      `Генерация: ${stats.powerGeneration.toFixed(1)} ЭЕ/с\n` +
      `Полная нагрузка: ${stats.peakPower.toFixed(1)} ЭЕ/с\n` +
      `Батарея: ${stats.energyCapacity} ЭЕ · DPS*: ${stats.dps.toFixed(1)}`, 14).setLineSpacing(5);
    text(this.scene, this.container, 240, 257, '* DPS до исчерпания боезапаса; без критов/защиты цели', 11);
    text(this.scene, this.container, 240, 278, `Трюм: ${stats.cargoMassLimit.toFixed(1)} т / ${stats.cargoVolume} м³ · не слоты`, 12);
    HULLS[this.design.hullId].slots.forEach((hardpoint, index) => {
      const slot = this.design.slots.find(item => item.id === hardpoint.id)!;
      const x = 18 + (index % 2) * 338;
      const y = 300 + Math.floor(index / 2) * 38;
      const kindName = hardpoint.kind === 'service' ? 'Служебный' : COMPONENT_NAMES[hardpoint.kind];
      const label = slot.component ? `${kindName}: ${slot.component.name}` : `${kindName} [${hardpoint.size}] — пусто`;
      button(this.scene, this.container, x, y, label, () => {
        const choices = this.catalogue.filter(component => acceptsComponent(hardpoint, component)).map(component => ({
          label: `${component.name} · ${calculateComponent(component).mass.toFixed(1)} т · ${calculateComponent(component).slotSize}`, value: component
        }));
        chooseItem(this.scene, `Установка: ${kindName}`, choices, component => this.installEquipment(hardpoint.id, component));
      }, `slot-${hardpoint.id}`).setFixedSize(280, 34);
      if (slot.component) button(this.scene, this.container, x + 286, y, '×', () => this.installEquipment(hardpoint.id, null), `remove-${hardpoint.id}`);
    });
    const draftIssues = validateDesign(this.design, 'draft');
    const flightIssues = validateDesign(this.design, 'flight');
    const battleIssues = validateDesign(this.design, 'battle');
    text(this.scene, this.container, 18, 454, draftIssues.length ? 'Черновик: ошибка' : 'Черновик: допустим', 11,
      draftIssues.length ? '#ffc880' : '#8af5bd').setFixedSize(210, 24).setName('design-mode-draft');
    text(this.scene, this.container, 238, 454, flightIssues.length ? `Полёт: недоступен (${flightIssues.length})` : 'Полёт: доступен', 11,
      flightIssues.length ? '#ffc880' : '#8af5bd').setFixedSize(210, 24).setName('design-mode-flight');
    text(this.scene, this.container, 458, 454, battleIssues.length ? `Бой: недоступен (${battleIssues.length})` : 'Бой: доступен', 11,
      battleIssues.length ? '#ffc880' : '#8af5bd').setFixedSize(224, 24).setName('design-mode-battle');
    text(this.scene, this.container, 18, 493, 'Добыча/ремонт/сканирование не исполняются; Трюм+ увеличивает объём.', 11, '#ffc880');
    text(this.scene, this.container, 18, 518, this.message, 12, this.error ? '#ff9292' : '#9bd8ff').setWordWrapWidth(660);
    button(this.scene, this.container, 18, 560, 'Сохранить', () => this.save(), 'save-design');
    button(this.scene, this.container, 125, 560, 'Загрузить', () => this.load(), 'load-design');
    button(this.scene, this.container, 230, 560, 'Копия', () => this.replaceDesign(() => {
      const now = new Date().toISOString();
      return { ...this.getConfiguration(), id: newId('design'), name: `${this.design.name.slice(0, 70)} (копия)`, createdAt: now, updatedAt: now };
    }, 'Создан независимый проект; сохраните его'), 'copy-design');
    button(this.scene, this.container, 310, 560, 'Новый', () => this.replaceDesign(() => createDesign(this.design.hullId), 'Новый пустой проект'), 'new-design');
    button(this.scene, this.container, 390, 560, 'Стартовый', () => this.replaceDesign(() => createDesign(this.design.hullId, true), 'Установлены двигатель и лазер'), 'starter-design');
    button(this.scene, this.container, 505, 560, 'Экспорт', () => this.export(), 'export-designs');
    button(this.scene, this.container, 600, 560, 'Импорт', () => this.import(), 'import-designs');
  }

  private renderCampaign(): void {
    this.container.removeAll(true);
    const { width, height, availableHulls, readOnly } = this.campaign!;
    panelBackground(this.scene, this.container, width, height);
    const mobile = width < 600;
    const pad = mobile ? 10 : 18;
    const buttonHeight = 44;
    const campaignButton = (x: number, y: number, label: string, action: () => void, name: string, buttonWidth: number, enabled = true) => {
      const item = button(this.scene, this.container, x, y, label, action, name).setFixedSize(buttonWidth, buttonHeight);
      item.setFontSize(14).setPadding(8, 12);
      if (!enabled) item.disableInteractive().setAlpha(0.45);
      return item;
    };
    text(this.scene, this.container, pad, 8, 'ЧЕРТЁЖ КОРАБЛЯ', 16, '#8de1f2');
    text(this.scene, this.container, width - 180, 10, readOnly ? 'Только просмотр' :
      this.hasUnsavedChanges() ? '● Не сохранён' : '✓ Сохранён', 14,
      readOnly ? '#c8d9ed' : this.hasUnsavedChanges() ? '#ffc880' : '#8af5bd').setName('design-save-status');
    const hullWidth = mobile ? width - pad * 2 : Math.min(300, width - pad * 2);
    const hullY = mobile ? 36 : 52;
    campaignButton(mobile ? pad : width - pad - hullWidth, hullY, `Корпус: ${HULLS[this.design.hullId].name}`, () => {
      this.chooseCampaignItem('Доступные корпуса', availableHulls.map(id => ({
        label: `${HULLS[id].name} · ${HULLS[id].maxMass} т · ${HULLS[id].hitPoints} HP`, value: id
      })), hullId => this.changeHull(hullId));
    }, 'change-hull', hullWidth, !readOnly && availableHulls.length > 1);
    const nameWidth = mobile ? width - pad * 2 : Math.min(360, width - hullWidth - pad * 3);
    const nameX = pad;
    campaignButton(nameX, mobile ? 84 : hullY, this.design.name, () => {
      const name = globalThis.prompt('Название чертежа', this.design.name);
      if (name === null) return;
      this.perform(() => { this.design = designSchema.parse({ ...this.design, name }); }, 'Имя чертежа изменено; сохраните проект');
    }, 'rename-design', nameWidth, !readOnly);

    const stats = calculateShipStats(this.design);
    const statsText = `Масса ${stats.mass.toFixed(1)} / ${HULLS[this.design.hullId].maxMass} т · ` +
      `${stats.cost} ₡ · ${stats.speed.toFixed(1)} такт. ед/с · мощность ${stats.peakPower.toFixed(1)}/${stats.powerGeneration.toFixed(1)}`;
    text(this.scene, this.container, pad, mobile ? 136 : 108, statsText, 14).setWordWrapWidth(width - pad * 2, true);
    const slotStart = mobile ? 178 : 156;
    const slotWidth = mobile ? width - pad * 2 : Math.floor((width - pad * 3) / 2);
    const slotRows = mobile ? 8 : 4;
    HULLS[this.design.hullId].slots.forEach((hardpoint, index) => {
      const slot = this.design.slots.find(item => item.id === hardpoint.id)!;
      const col = mobile ? 0 : index % 2;
      const row = mobile ? index : Math.floor(index / 2);
      const x = pad + col * (slotWidth + pad);
      const y = slotStart + row * buttonHeight;
      const kindName = hardpoint.kind === 'service' ? 'Служебный' : COMPONENT_NAMES[hardpoint.kind];
      const label = slot.component ? `${kindName}: ${slot.component.name}` : `${kindName} [${hardpoint.size}] — пусто`;
      campaignButton(x, y, label, () => {
        const choices: Array<{ label: string; value: ComponentDefinition | null }> = this.catalogue
          .filter(component => acceptsComponent(hardpoint, component))
          .flatMap(component => this.campaignComponentVariants(component, hardpoint.id));
        if (slot.component) choices.unshift({ label: 'Удалить модуль', value: null });
        this.chooseCampaignItem(`Установка: ${kindName}`, choices, component => {
          this.installEquipment(hardpoint.id, component);
        });
      }, `slot-${hardpoint.id}`, slotWidth, !readOnly);
    });
    const statusY = slotStart + slotRows * buttonHeight + 8;
    const draftIssues = validateDesign(this.design, 'draft');
    const flightIssues = validateDesign(this.design, 'flight');
    const battleIssues = validateDesign(this.design, 'battle');
    text(this.scene, this.container, pad, statusY,
      `Чертёж: ${draftIssues.length ? 'ошибка' : 'допустим'} · Полёт: ${flightIssues.length ? 'недоступен' : 'готов'} · Бой: ${battleIssues.length ? 'недоступен' : 'готов'}`,
      14, draftIssues.length ? '#ffc880' : '#8af5bd').setWordWrapWidth(width - pad * 2, true);
    text(this.scene, this.container, pad, statusY + 34, this.message, 14,
      this.error ? '#ff9292' : '#9bd8ff').setWordWrapWidth(width - pad * 2, true);
  }

  private isCampaignDesignAllowed(design: ShipDesign): boolean {
    return !this.campaign || this.campaign.isDesignAvailable(design);
  }

  private campaignComponentVariants(component: ComponentDefinition, slotId: string):
    Array<{ label: string; value: ComponentDefinition }> {
    const base: Array<{ label: string; value: ComponentDefinition }> = [];
    const design = (candidate: ComponentDefinition) => installComponent(this.design, slotId, candidate);
    if (this.campaign?.isComponentAvailable(component) && this.isCampaignDesignAllowed(design(component))) {
      base.push({ label: `${component.name} · ${calculateComponent(component).mass.toFixed(1)} т`, value: component });
    }
    for (const [field, value] of Object.entries(component)) {
      if (typeof value !== 'number' || field === 'mass' || field === 'cost') continue;
      for (const [label, factor] of [['−1%', 0.99], ['+1%', 1.01], ['−10%', 0.9], ['+10%', 1.1]] as const) {
        const adjusted = field === 'ammoCapacity' ? Math.max(1, Math.round(value * factor)) : Number((value * factor).toFixed(4));
        const parsed = componentSchema.safeParse({ ...component, [field]: adjusted,
          name: `${component.name} ${field}${label}`, id: `${component.id}_${field}_${label.replace('%', '').replace('−', 'm').replace('+', 'p')}` });
        if (!parsed.success || !this.campaign?.isComponentAvailable(parsed.data) ||
          !this.isCampaignDesignAllowed(design(parsed.data))) continue;
        base.push({ label: `${component.name} ${field} ${label}`, value: parsed.data });
      }
    }
    return base;
  }

  private chooseCampaignItem<T>(title: string, items: Array<{ label: string; value: T }>, select: (value: T) => void): void {
    const modal = openShipyardModal(this.scene);
    if (!modal) return;
    const width = Math.min(620, this.scene.cameras.main.width - 24);
    const height = Math.min(680, this.scene.cameras.main.height - 24);
    const x = (this.scene.cameras.main.width - width) / 2, y = (this.scene.cameras.main.height - height) / 2;
    const content = this.scene.add.container(x, y);
    modal.overlay.add(content);
    let page = 0;
    const pageSize = Math.max(1, Math.floor((height - 124) / 48));
    const render = () => {
      content.removeAll(true);
      panelBackground(this.scene, content, width, height);
      text(this.scene, content, 14, 12, title, 16);
      const rows = items.slice(page * pageSize, page * pageSize + pageSize);
      if (!rows.length) text(this.scene, content, 14, 64, 'Нет доступных вариантов', 14);
      rows.forEach((item, index) => {
        const row = button(this.scene, content, 12, 50 + index * 48, item.label, () => {
          if (modal.close()) select(item.value);
        }, `campaign-choice-${page * pageSize + index}`).setFixedSize(width - 24, 44);
        row.setFontSize(14).setPadding(8, 12);
      });
      const footerY = height - 58;
      const previous = button(this.scene, content, 12, footerY, '←', () => {
        page = Math.max(0, page - 1); render();
      }, 'campaign-choice-prev').setFixedSize(64, 44);
      previous.setFontSize(14).setPadding(8, 12);
      text(this.scene, content, 90, footerY + 12, `${page + 1} / ${Math.max(1, Math.ceil(items.length / pageSize))}`, 14);
      const next = button(this.scene, content, 150, footerY, '→', () => {
        page = Math.min(Math.max(0, Math.ceil(items.length / pageSize) - 1), page + 1); render();
      }, 'campaign-choice-next').setFixedSize(64, 44);
      next.setFontSize(14).setPadding(8, 12);
      const close = button(this.scene, content, width - 132, footerY, 'Отмена · ESC', modal.close, 'campaign-choice-cancel')
        .setFixedSize(120, 44);
      close.setFontSize(14).setPadding(8, 12);
    };
    render();
  }

  private perform(action: () => void, success: string): boolean {
    if (this.disposed) return false;
    try { action(); this.message = success; this.error = false; }
    catch (error) { this.message = `Ошибка: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240); this.error = true; }
    this.render();
    this.campaign?.onDraftChanged();
    return !this.error;
  }

  installEquipment(slotId: string, component: ComponentDefinition | null): boolean {
    return this.perform(() => {
      if (component && this.campaign && !this.campaign.isComponentAvailable(component)) {
        throw new Error('Параметры модуля выходят за диапазон исследований');
      }
      const next = installComponent(this.design, slotId, component);
      if (!this.isCampaignDesignAllowed(next)) throw new Error('Компонент недоступен при текущем уровне исследований');
      this.design = next;
    }, 'Компоновка изменена; сохраните проект');
  }

  changeHull(hullId: HullId): void {
    this.perform(() => {
      if (this.campaign && !this.campaign.availableHulls.includes(hullId)) throw new Error('Корпус ещё не открыт исследованиями');
      const next = { ...this.getConfiguration(), hullId };
      const issues = validateDesign(next, 'draft');
      if (issues.length) throw new Error(issues.map(issue => issue.message).join('\n'));
      if (!this.isCampaignDesignAllowed(next)) throw new Error('Чертёж недоступен при текущем уровне исследований');
      this.design = next;
    }, 'Корпус изменён; сохраните проект');
  }

  save(): boolean {
    return this.perform(() => {
      if (!this.repository) throw new Error('Репозиторий верфи недоступен');
      const saved = this.repository.saveDesign(this.design);
      this.design = saved;
      this.savedDesign = designSchema.parse(saved);
    }, 'Проект сохранён в библиотеке');
  }

  hasUnsavedChanges(): boolean { return hasUnsavedDesign(this.design, this.savedDesign); }

  /** Trials retain the draft; only destructive replacement/navigation uses this guard. */
  requestDiscard(action: () => void): void {
    if (this.disposed || isShipyardModalOpen(this.scene)) return;
    if (!this.hasUnsavedChanges()) { action(); return; }
    confirmDiscard(this.scene, () => { if (!this.disposed) action(); });
  }

  private replaceDesign(create: () => ShipDesign, message: string, saved = false): void {
    this.requestDiscard(() => this.perform(() => {
      const next = designSchema.parse(create());
      this.design = next;
      this.savedDesign = saved ? designSchema.parse(next) : undefined;
    }, message));
  }

  private load(): void {
    this.perform(() => {
      if (!this.repository) throw new Error('Репозиторий верфи недоступен');
      chooseItem(this.scene, 'Сохранённые проекты', this.repository.load().designs.map(design => ({ label: `${design.name} · ${HULLS[design.hullId].name}`, value: design })),
        design => this.replaceDesign(() => design, 'Проект загружен', true));
    }, 'Выберите сохранённый проект');
  }

  private export(): void {
    this.perform(() => {
      if (!this.repository) throw new Error('Репозиторий верфи недоступен');
      const url = URL.createObjectURL(new Blob([this.repository.exportJSON()], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'orion-shipyard.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'Экспортирована сохранённая библиотека (не текущий черновик)');
  }

  private import(): void {
    if (this.disposed || !this.repository) {
      if (!this.disposed) this.showMessage('Репозиторий верфи недоступен', true);
      return;
    }
    const repository = this.repository;
    const token = {};
    this.importToken = token;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = async () => {
      if (!this.isCurrentImport(token)) return;
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (file.size > 5_000_000) throw new Error('Файл превышает 5 МБ');
        const json = await file.text();
        if (!this.isCurrentImport(token)) return;
        this.perform(() => { repository.importJSON(json); this.scene.events.emit('shipyard-library-changed'); }, 'Импорт завершён; используйте «Загрузить»');
      } catch (error) {
        if (this.isCurrentImport(token)) this.showMessage(`Ошибка импорта: ${error instanceof Error ? error.message : String(error)}`, true);
      } finally {
        if (this.importToken === token) this.importToken = undefined;
      }
    };
    input.click();
  }

  private isCurrentImport(token: object): boolean {
    return !this.disposed && this.importToken === token && this.scene.sys.isActive();
  }

  showMessage(message: string, error = false): void {
    if (this.disposed) return;
    this.message = message.slice(0, 240); this.error = error; this.render();
  }
  setAvailableComponents(components: ComponentDefinition[]): void { this.catalogue = components.map(item => componentSchema.parse(item)); }
  getConfiguration(): ShipDesign { return designSchema.parse(this.design); }
  resizeCampaign(x: number, y: number, width: number, height: number): void {
    if (!this.campaign || this.disposed) return;
    this.container.setPosition(x, y);
    this.campaign.width = width;
    this.campaign.height = height;
    this.render();
  }
  setCampaignDesign(design: ShipDesign, saved?: ShipDesign): void {
    if (!this.campaign || this.disposed) return;
    this.design = designSchema.parse(design);
    this.savedDesign = saved ? designSchema.parse(saved) : undefined;
    this.message = '';
    this.error = false;
    this.render();
  }
  markCampaignDesignSaved(design: ShipDesign): void {
    if (!this.campaign || this.disposed) return;
    this.design = designSchema.parse(design);
    this.savedDesign = designSchema.parse(design);
    this.message = 'Чертёж сохранён в кампании';
    this.error = false;
    this.render();
  }
  destroy(): void { this.disposed = true; this.importToken = undefined; closeShipyardModal(this.scene); this.container.destroy(); }
}
