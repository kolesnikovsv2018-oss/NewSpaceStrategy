import Phaser from 'phaser';
import { ComponentBuilderPanel } from '../ui/ComponentBuilderPanel';
import { ShipBuilderPanel } from '../ui/ShipBuilderPanel';
import { ShipDesignManager } from '../utils/ShipDesignManager';
import { componentSchema, COMPONENT_NAMES, createComponent, designSchema, validateDesign,
  type ComponentKind, type ShipDesign } from '../domain/shipDesign';
import { button, text } from '../ui/ShipyardWidgets';

export class ShipyardScene extends Phaser.Scene {
  private componentPanel?: ComponentBuilderPanel;
  private shipPanel?: ShipBuilderPanel;
  private repository = new ShipDesignManager();
  private initial?: ShipDesign;

  constructor() { super({ key: 'ShipyardScene' }); }

  init(data: { design?: ShipDesign } = {}): void {
    this.initial = data.design ? designSchema.parse(data.design) : undefined;
    this.sys.settings.data = {};
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#071321');
    const width = this.cameras.main.width;
    const header = this.add.container(0, 0);
    text(this, header, width / 2, 24, 'ORION / ВЕРФЬ', 22, '#a3ebfa').setOrigin(0.5, 0);
    button(this, header, 20, 20, '← Меню', this.returnToMenu, 'yard-menu');
    button(this, header, width - 225, 20, 'Полёт', () => this.startTrial('flight'), 'trial-flight');
    button(this, header, width - 120, 20, 'Бой', () => this.startTrial('battle'), 'trial-battle');
    text(this, header, 20, 75, 'Настройте модули → установите копии в проект → сохраните → испытайте. Каталог сохраняется отдельно.', 13);

    let library;
    let loadError = '';
    try { library = this.repository.load(); }
    catch (error) { loadError = `Не удалось прочитать библиотеку: ${error instanceof Error ? error.message : String(error)}`; }
    const components = library?.components.length ? library.components :
      (Object.keys(COMPONENT_NAMES) as ComponentKind[]).map(createComponent);
    const latest = library?.designs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    this.componentPanel = new ComponentBuilderPanel(this, 20, 100, components);
    this.shipPanel = new ShipBuilderPanel(this, width - 720, 100, this.repository, this.initial ?? latest);
    this.shipPanel.setAvailableComponents(components);
    if (loadError) this.shipPanel.showMessage(loadError, true);
    this.componentPanel.setOnComponentsChanged(items => {
      this.shipPanel?.setAvailableComponents(items);
      try { this.repository.saveComponents(items); this.shipPanel?.showMessage('Каталог сохранён. Для изменения установленного модуля установите его заново.'); }
      catch (error) { this.shipPanel?.showMessage(`Каталог не сохранён: ${error instanceof Error ? error.message : String(error)}`, true); }
    });
    this.events.on('shipyard-library-changed', this.refreshCatalogue, this);
    this.input.keyboard?.on('keydown-ESC', this.returnToMenu, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off('keydown-ESC', this.returnToMenu, this);
      this.events.off('shipyard-library-changed', this.refreshCatalogue, this);
      this.componentPanel?.destroy(); this.shipPanel?.destroy();
      this.componentPanel = undefined; this.shipPanel = undefined; this.initial = undefined;
    });
  }

  private refreshCatalogue(): void {
    const items = this.repository.load().components.map(item => componentSchema.parse(item));
    this.componentPanel?.setComponents(items);
    this.shipPanel?.setAvailableComponents(items);
  }

  private startTrial(mode: 'flight' | 'battle'): void {
    const design = this.shipPanel?.getConfiguration();
    if (!design) return;
    const issues = validateDesign(design, mode);
    if (issues.length) { this.shipPanel?.showMessage(issues.map(issue => issue.message).join('\n'), true); return; }
    // Pass a snapshot, not the editor's mutable model. Return from the trial restores this draft.
    this.scene.start(mode === 'flight' ? 'ShipTestScene' : 'BattleScene', { design });
  }

  private returnToMenu = (): void => { this.scene.start('MenuScene'); };
}
