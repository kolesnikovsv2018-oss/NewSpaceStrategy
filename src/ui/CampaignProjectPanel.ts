import type Phaser from 'phaser';
import type { ConquestResult } from '../domain/conquest';
import { MAX_CAMPAIGN_PROJECTS, type CampaignProject, type ProjectCommand } from '../domain/campaignProjects';
import { designSchema, createDesign, createComponentWithId, acceptsComponent, HULLS,
  type ComponentKind, type ShipDesign } from '../domain/shipDesign';
import { getResearchAccess, isCampaignComponentVariantAvailable, isCampaignDraftAvailable } from '../domain/campaignResearch';
import { hasUnsavedDesign } from '../domain/shipDraft';
import { ShipBuilderPanel } from './ShipBuilderPanel';
import { button, panelBackground, text } from './ShipyardWidgets';
import { openShipyardModal } from './ShipyardModal';
import { COMBAT_PRESET_NAMES, createCombatDesign, type CombatPresetId } from '../domain/combatPresets';
import { CIVILIAN_PRESET_NAMES, createCivilianDesign, type CivilianPresetId } from '../domain/civilianPresets';

type CampaignProjectCommandPayload = ProjectCommand extends infer Command
  ? Command extends ProjectCommand ? Omit<Command, 'factionId' | 'expectedTurn'> : never
  : never;

export interface CampaignProjectPanelOptions {
  width: number;
  height: number;
  projects: CampaignProject[];
  factionId: 'blue' | 'red';
  readOnly: boolean;
  hulls: CampaignProjectPanelHull[];
  components: ComponentKind[];
  research: Parameters<typeof getResearchAccess>[0];
  tree: Parameters<typeof getResearchAccess>[1];
  run: (command: CampaignProjectCommandPayload) => ConquestResult;
  close: () => void;
}

export interface CampaignProjectPanelHull { id: CampaignProject['design']['hullId']; name: string }

export class CampaignProjectPanel {
  private readonly container: Phaser.GameObjects.Container;
  private readonly blocker: Phaser.GameObjects.Rectangle;
  private readonly editor: ShipBuilderPanel;
  private projects: CampaignProject[];
  private selectedId?: number;
  private draft: ShipDesign;
  private components: ReturnType<typeof createComponentWithId>[] = [];
  private disposed = false;
  private page = 0;
  private message = '';

  constructor(private readonly scene: Phaser.Scene, private readonly options: CampaignProjectPanelOptions) {
    this.projects = structuredClone(options.projects);
    this.draft = createDesign(options.hulls[0]?.id ?? 'fighter', true);
    this.container = scene.add.container(0, 0).setDepth(102).setName('campaign-project-panel');
    this.blocker = scene.add.rectangle(options.width / 2, options.height / 2, options.width, options.height, 0x071321, 0.98)
      .setDepth(100).setName('campaign-project-blocker').setInteractive();
    const mobile = options.width < 700;
    const editorX = mobile ? 8 : 300;
    const editorY = mobile ? 236 : 82;
    const editorWidth = options.width - editorX - 8;
    const editorHeight = options.height - editorY - 8;
    this.editor = new ShipBuilderPanel(scene, editorX, editorY, undefined, this.draft, undefined, {
      width: editorWidth,
      height: editorHeight,
      availableHulls: options.hulls.map(hull => hull.id),
      isComponentAvailable: component =>
        isCampaignComponentVariantAvailable(component, options.research, options.tree),
      isDesignAvailable: design => isCampaignDraftAvailable(design, options.research, options.tree),
      onDraftChanged: () => {
        this.message = '';
        this.render();
      },
      readOnly: options.readOnly
    });
    this.components = options.hulls.flatMap(hull => HULLS[hull.id].slots.flatMap(slot =>
      options.components.filter(kind => acceptsComponent(slot, createComponentWithId(kind,
        `campaign-${hull.id}-${slot.id}-${kind}`))).map(kind =>
        createComponentWithId(kind, `campaign-${hull.id}-${slot.id}-${kind}`))));
    this.editor.setAvailableComponents(this.components);
    this.render();
  }

  private render(): void {
    if (this.disposed) return;
    const { width, height, readOnly } = this.options;
    const mobile = width < 700;
    this.container.removeAll(true);
    text(this.scene, this.container, 12, 8,
      `Проекты кораблей · ${this.projects.length}/${MAX_CAMPAIGN_PROJECTS}${readOnly ? ' · только просмотр' : ''}`, 16, '#8de1f2');
    const closeX = width - 112;
    this.action(closeX, 8, 'Закрыть', () => this.requestClose(), 'campaign-projects-close', 100);
    if (mobile) {
      const index = this.projects.findIndex(project => project.id === this.selectedId);
      const shown = index >= 0 ? this.projects[index] : undefined;
      text(this.scene, this.container, 12, 42, shown ? `#${shown.id} ${shown.name}` : 'Новый чертёж', 14)
        .setWordWrapWidth(width - 24, true);
      this.action(12, 72, '←', () => this.selectByIndex(index - 1), 'campaign-project-prev', 54, index > 0);
      this.action(72, 72, 'Список', () => this.chooseProject(), 'campaign-project-list', 92, this.projects.length > 0);
      this.action(172, 72, '→', () => this.selectByIndex(index + 1), 'campaign-project-next', 54, index >= 0 && index + 1 < this.projects.length);
    } else {
      const pageSize = 8;
      this.projects.slice(this.page * pageSize, this.page * pageSize + pageSize).forEach((project, index) => this.action(12, 46 + index * 42,
        `${project.id === this.selectedId ? '› ' : ''}#${project.id} ${project.name}`,
        () => this.select(project), `campaign-project-${project.id}`, 270));
      const pageCount = Math.max(1, Math.ceil(this.projects.length / pageSize));
      this.action(12, 390, '← Стр.', () => { this.page = Math.max(0, this.page - 1); this.render(); },
        'campaign-project-prev', 92, this.page > 0);
      text(this.scene, this.container, 112, 404, `${this.page + 1}/${pageCount}`, 14);
      this.action(168, 390, 'Стр. →', () => { this.page = Math.min(pageCount - 1, this.page + 1); this.render(); },
        'campaign-project-next', 92, this.page + 1 < pageCount);
    }

    const toolbarY = mobile ? 124 : 438;
    const toolbarWidth = mobile ? Math.floor((width - 30) / 3) : 84;
    this.action(12, toolbarY, 'Сохранить', () => this.save(), 'campaign-project-save', mobile ? toolbarWidth : 98,
      !readOnly && this.editor.hasUnsavedChanges());
    this.action(mobile ? 20 + toolbarWidth : 116, toolbarY, 'Новый', () => this.newProject(), 'campaign-project-new',
      mobile ? toolbarWidth : 78, !readOnly);
    this.action(mobile ? 28 + toolbarWidth * 2 : 206, toolbarY, 'Копия', () => this.copy(), 'campaign-project-copy',
      mobile ? toolbarWidth : 78, !readOnly && this.projects.length > 0);
    if (!mobile) {
      this.action(12, toolbarY + 52, 'Переименовать', () => this.rename(), 'campaign-project-rename', 130,
        !readOnly && this.selectedId !== undefined);
      this.action(150, toolbarY + 52, 'Удалить', () => this.delete(), 'campaign-project-delete', 92,
        !readOnly && this.selectedId !== undefined);
      this.action(12, toolbarY + 104, 'Пресет', () => this.choosePreset(),
        'campaign-project-preset', 98, !readOnly);
    } else {
      this.action(12, toolbarY + 48, 'Имя', () => this.rename(), 'campaign-project-rename', toolbarWidth,
        !readOnly && this.selectedId !== undefined);
      this.action(20 + toolbarWidth, toolbarY + 48, 'Удалить', () => this.delete(), 'campaign-project-delete', toolbarWidth,
        !readOnly && this.selectedId !== undefined);
      this.action(28 + toolbarWidth * 2, toolbarY + 48, 'Пресет', () => this.choosePreset(),
        'campaign-project-preset', toolbarWidth, !readOnly);
    }
    if (this.message && !mobile) text(this.scene, this.container, 12, height - 32, this.message, 14, '#c8d9ed')
      .setWordWrapWidth(mobile ? width - 130 : 276, true);
  }

  private action(x: number, y: number, label: string, callback: () => void, name: string, width = 130, enabled = true): void {
    const item = button(this.scene, this.container, x, y, label, () => {
      if (!this.disposed && enabled) callback();
    }, name).setFixedSize(width, 44).setFontSize(14).setPadding(8, 12);
    if (!enabled) item.disableInteractive().setAlpha(0.45);
  }

  private updateProjects(projects: CampaignProject[]): void {
    this.projects = structuredClone(projects);
    this.page = Math.min(this.page, Math.max(0, Math.ceil(this.projects.length / 8) - 1));
    this.render();
  }

  private select(project: CampaignProject): void {
    if (!this.options.readOnly && this.editor.hasUnsavedChanges()) {
      this.confirmDiscard(() => this.selectConfirmed(project));
      return;
    }
    this.selectConfirmed(project);
  }

  private selectByIndex(index: number): void {
    if (index < 0 || index >= this.projects.length) return;
    this.select(this.projects[index]);
  }

  private chooseProject(): void {
    const modal = openShipyardModal(this.scene);
    if (!modal) return;
    const content = this.scene.add.container(20, 24);
    modal.overlay.add(content);
    const width = this.scene.cameras.main.width - 40;
    const height = this.scene.cameras.main.height - 48;
    let page = 0;
    const pageSize = Math.max(1, Math.floor((height - 136) / 48));
    const render = () => {
      content.removeAll(true);
      panelBackground(this.scene, content, width, height);
      text(this.scene, content, 12, 12, 'Проекты кампании', 18);
      this.projects.slice(page * pageSize, page * pageSize + pageSize).forEach((project, index) => {
        const item = button(this.scene, content, 12, 48 + index * 48, `#${project.id} ${project.name}`,
          () => { if (modal.close()) this.select(project); }, `campaign-project-choice-${project.id}`)
          .setFixedSize(width - 24, 44).setFontSize(14);
        item.setPadding(8, 12);
      });
      this.actionIn(content, 12, height - 54, '←', () => { page = Math.max(0, page - 1); render(); },
        'campaign-project-choice-prev', 64);
      text(this.scene, content, 88, height - 42, `${page + 1}/${Math.max(1, Math.ceil(this.projects.length / pageSize))}`, 14);
      this.actionIn(content, 140, height - 54, '→', () => {
        page = Math.min(Math.ceil(this.projects.length / pageSize) - 1, page + 1); render();
      }, 'campaign-project-choice-next', 64);
      this.actionIn(content, width - 152, height - 54, 'Отмена · ESC', modal.close,
        'campaign-project-choice-cancel', 140);
    };
    render();
  }

  private choosePreset(): void {
    const designs = [
      ...(Object.keys(COMBAT_PRESET_NAMES) as CombatPresetId[]).map(id => createCombatDesign(id)),
      ...(Object.keys(CIVILIAN_PRESET_NAMES) as CivilianPresetId[]).map(id => createCivilianDesign(id))
    ].filter(design => this.isDesignAvailable(design));
    const modal = openShipyardModal(this.scene);
    if (!modal) return;
    const content = this.scene.add.container(20, 24);
    modal.overlay.add(content);
    const width = this.scene.cameras.main.width - 40;
    const height = this.scene.cameras.main.height - 48;
    let page = 0;
    const pageSize = Math.max(1, Math.floor((height - 136) / 48));
    const render = () => {
      content.removeAll(true);
      panelBackground(this.scene, content, width, height);
      text(this.scene, content, 12, 12, 'Доступные стартовые проекты', 18);
      designs.slice(page * pageSize, page * pageSize + pageSize).forEach((design, index) => {
        const item = button(this.scene, content, 12, 48 + index * 48, `${design.name} · ${design.hullId}`, () => {
          if (!modal.close()) return;
          if (this.editor.hasUnsavedChanges()) this.confirmDiscard(() => this.setPreset(design));
          else this.setPreset(design);
        }, `campaign-preset-${page * pageSize + index}`).setFixedSize(width - 24, 44).setFontSize(14);
        item.setPadding(8, 12);
      });
      this.actionIn(content, 12, height - 54, '←', () => { page = Math.max(0, page - 1); render(); },
        'campaign-preset-prev', 64);
      text(this.scene, content, 88, height - 42, `${page + 1}/${Math.max(1, Math.ceil(designs.length / pageSize))}`, 14);
      this.actionIn(content, 140, height - 54, '→', () => {
        page = Math.min(Math.ceil(designs.length / pageSize) - 1, page + 1); render();
      }, 'campaign-preset-next', 64);
      this.actionIn(content, width - 152, height - 54, 'Отмена · ESC', modal.close,
        'campaign-preset-cancel', 140);
    };
    render();
  }

  private setPreset(design: ShipDesign): void {
    const independent = designSchema.parse(structuredClone(design));
    this.selectedId = undefined;
    this.draft = independent;
    this.editor.setCampaignDesign(independent);
    this.message = 'Пресет загружен как новый черновик; сохраните для добавления в каталог.';
    this.render();
  }

  private selectConfirmed(project: CampaignProject): void {
    this.page = Math.floor(this.projects.findIndex(item => item.id === project.id) / 8);
    this.selectedId = project.id;
    this.draft = designSchema.parse(project.design);
    this.editor.setAvailableComponents([
      ...this.components,
      ...project.design.slots.flatMap(slot => slot.component ? [slot.component] : [])
    ]);
    this.editor.setCampaignDesign(this.draft, project.design);
    this.message = '';
    this.render();
  }

  private newProject(): void {
    if (this.editor.hasUnsavedChanges()) { this.confirmDiscard(() => this.createDraft()); return; }
    this.createDraft();
  }

  private createDraft(): void {
    this.selectedId = undefined;
    this.draft = createDesign(this.draft.hullId);
    this.editor.setCampaignDesign(this.draft);
    this.message = 'Новый проект: сохраните его, чтобы добавить в кампанию.';
    this.render();
  }

  private copy(): void {
    const project = this.projects.find(item => item.id === this.selectedId);
    if (!project) return;
    if (this.editor.hasUnsavedChanges()) { this.confirmDiscard(() => this.copyConfirmed(project)); return; }
    this.copyConfirmed(project);
  }

  private copyConfirmed(project: CampaignProject): void {
    const result = this.options.run({ kind: 'copyProject', projectId: project.id });
    if (!result.ok) { this.message = result.message; this.render(); return; }
    this.projects = structuredClone(result.state.projects[this.faction()].items);
    const copied = this.projects[this.projects.length - 1];
    if (copied) this.selectConfirmed(copied);
    this.message = result.ok ? 'Создана независимая копия проекта.' : '';
  }

  private save(): void {
    const design = this.editor.getConfiguration();
    if (!this.isDesignAvailable(design)) {
      this.message = 'Чертёж содержит закрытый корпус, модуль или параметры.';
      this.render();
      return;
    }
    const result = this.options.run(this.selectedId === undefined
      ? { kind: 'createProject', name: design.name, design }
      : { kind: 'replaceProject', projectId: this.selectedId, design });
    if (!result.ok) { this.message = result.message; this.render(); return; }
    const projects = result.state.projects[this.faction()].items;
    this.updateProjects(projects);
    const saved = this.projects.find(project => project.id === this.selectedId) ?? this.projects[this.projects.length - 1];
    if (!saved) return;
    this.selectedId = saved.id;
    this.editor.markCampaignDesignSaved(saved.design);
    this.message = 'Чертёж принят в каталог кампании; корабль не создан и производство не оплачено.';
    this.render();
  }

  private rename(): void {
    const project = this.projects.find(item => item.id === this.selectedId);
    if (!project) return;
    if (this.editor.hasUnsavedChanges()) { this.confirmDiscard(() => this.renameConfirmed(project)); return; }
    this.renameConfirmed(project);
  }

  private renameConfirmed(project: CampaignProject): void {
    const name = globalThis.prompt('Название проекта', project.name);
    if (name === null) return;
    const result = this.options.run({ kind: 'renameProject', projectId: project.id, name });
    if (!result.ok) { this.message = result.message; this.render(); return; }
    const projects = result.state.projects[this.faction()].items;
    this.updateProjects(projects);
    const renamed = this.projects.find(item => item.id === project.id);
    if (renamed) this.selectConfirmed(renamed);
  }

  private delete(): void {
    const project = this.projects.find(item => item.id === this.selectedId);
    if (!project) return;
    if (this.editor.hasUnsavedChanges()) { this.confirmDiscard(() => this.deleteConfirmed(project)); return; }
    this.deleteConfirmed(project);
  }

  private deleteConfirmed(project: CampaignProject): void {
    const modal = openShipyardModal(this.scene);
    if (!modal) return;
    const content = this.scene.add.container(this.scene.cameras.main.width / 2 - 210, this.scene.cameras.main.height / 2 - 100);
    modal.overlay.add(content);
    panelBackground(this.scene, content, 420, 200);
    text(this.scene, content, 16, 18, `Удалить «${project.name}»?`, 16);
    this.actionIn(content, 16, 128, 'Отмена · ESC', () => modal.close(), 'campaign-delete-cancel', 160);
    this.actionIn(content, 190, 128, 'Удалить проект', () => {
      if (!modal.close()) return;
      const result = this.options.run({ kind: 'deleteProject', projectId: project.id });
      if (!result.ok) this.message = result.message;
      else {
        this.projects = structuredClone(result.state.projects[this.faction()].items);
        this.selectedId = undefined;
        this.createDraft();
      }
      this.render();
    }, 'campaign-delete-confirm', 190);
  }

  private actionIn(parent: Phaser.GameObjects.Container, x: number, y: number, label: string, callback: () => void, name: string, width: number) {
    const item = button(this.scene, parent, x, y, label, callback, name).setFixedSize(width, 44).setFontSize(14);
    return item;
  }

  private confirmDiscard(action: () => void): void {
    const modal = openShipyardModal(this.scene);
    if (!modal) return;
    const content = this.scene.add.container(this.scene.cameras.main.width / 2 - 220, this.scene.cameras.main.height / 2 - 110);
    modal.overlay.add(content);
    panelBackground(this.scene, content, 440, 220);
    text(this.scene, content, 16, 18, 'Черновик не сохранён', 18, '#ffc880');
    text(this.scene, content, 16, 62, 'Отбросить изменения? Сохранённый проект останется в кампании.', 14)
      .setWordWrapWidth(408, true);
    this.actionIn(content, 16, 150, 'Продолжить редактирование', () => modal.close(), 'campaign-dirty-cancel', 220);
    this.actionIn(content, 246, 150, 'Отбросить черновик', () => {
      if (modal.close()) action();
    }, 'campaign-dirty-confirm', 178);
  }

  private isDesignAvailable(design: ShipDesign): boolean {
    return isCampaignDraftAvailable(design, this.options.research, this.options.tree);
  }

  private faction(): 'blue' | 'red' {
    return this.options.factionId;
  }

  hasUnsavedChanges(): boolean {
    const baseline = this.projects.find(project => project.id === this.selectedId)?.design;
    return hasUnsavedDesign(this.editor.getConfiguration(), baseline);
  }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.options.width = width;
    this.options.height = height;
    this.blocker.setPosition(width / 2, height / 2).setSize(width, height);
    const mobile = width < 700;
    const editorX = mobile ? 8 : 300;
    const editorY = mobile ? 236 : 82;
    this.editor.resizeCampaign(editorX, editorY, width - editorX - 8, height - editorY - 8);
    this.render();
  }

  requestClose(): void {
    if (this.disposed) return;
    if (this.editor.hasUnsavedChanges()) {
      this.confirmDiscard(() => this.closeNow());
      return;
    }
    this.closeNow();
  }

  private closeNow(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.editor.destroy();
    this.container.destroy(true);
    this.blocker.destroy();
    this.options.close();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.editor.destroy();
    this.container.destroy(true);
    this.blocker.destroy();
  }
}
