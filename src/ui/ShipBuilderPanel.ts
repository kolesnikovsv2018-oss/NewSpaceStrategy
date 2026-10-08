import type Phaser from 'phaser';
import { calculateComponent, calculateShipStats, COMPONENT_NAMES, componentSchema, createDesign, designSchema,
  HULLS, installComponent, newId, validateDesign, acceptsComponent, type ComponentDefinition, type ShipDesign, type HullId } from '../domain/shipDesign';
import { ShipDesignManager } from '../utils/ShipDesignManager';
import { drawBlueprint } from './ShipBlueprint';
import { button, text, panelBackground, chooseItem, confirmDiscard } from './ShipyardWidgets';
import { closeShipyardModal, isShipyardModalOpen } from './ShipyardModal';
import { hasUnsavedDesign } from '../domain/shipDraft';
import { COMBAT_PRESET_NAMES, createCombatDesign, type CombatPresetId } from '../domain/combatPresets';
import { CIVILIAN_PRESET_NAMES, createCivilianDesign, type CivilianPresetId } from '../domain/civilianPresets';

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
    private readonly repository: ShipDesignManager, initial = createDesign('corvette', true), saved?: ShipDesign) {
    this.container = scene.add.container(x, y);
    this.design = designSchema.parse(initial);
    this.savedDesign = saved ? designSchema.parse(saved) : undefined;
    this.render();
  }

  private render(): void {
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

  private perform(action: () => void, success: string): boolean {
    if (this.disposed) return false;
    try { action(); this.message = success; this.error = false; }
    catch (error) { this.message = `Ошибка: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240); this.error = true; }
    this.render();
    return !this.error;
  }

  installEquipment(slotId: string, component: ComponentDefinition | null): boolean {
    return this.perform(() => { this.design = installComponent(this.design, slotId, component); }, 'Компоновка изменена; сохраните проект');
  }

  changeHull(hullId: HullId): void {
    this.perform(() => {
      const next = { ...this.getConfiguration(), hullId };
      const issues = validateDesign(next, 'draft');
      if (issues.length) throw new Error(issues.map(issue => issue.message).join('\n'));
      this.design = next;
    }, 'Корпус изменён; сохраните проект');
  }

  save(): boolean {
    return this.perform(() => {
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
      chooseItem(this.scene, 'Сохранённые проекты', this.repository.load().designs.map(design => ({ label: `${design.name} · ${HULLS[design.hullId].name}`, value: design })),
        design => this.replaceDesign(() => design, 'Проект загружен', true));
    }, 'Выберите сохранённый проект');
  }

  private export(): void {
    this.perform(() => {
      const url = URL.createObjectURL(new Blob([this.repository.exportJSON()], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'orion-shipyard.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'Экспортирована сохранённая библиотека (не текущий черновик)');
  }

  private import(): void {
    if (this.disposed) return;
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
        this.perform(() => { this.repository.importJSON(json); this.scene.events.emit('shipyard-library-changed'); }, 'Импорт завершён; используйте «Загрузить»');
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
  destroy(): void { this.disposed = true; this.importToken = undefined; closeShipyardModal(this.scene); this.container.destroy(); }
}
