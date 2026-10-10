import { resizeCampaignViewport } from '../ui/CampaignViewport';

export class MenuScene extends Phaser.Scene {
  private root?: Phaser.GameObjects.Container;
  private demonstrations = false;
  private generation = 0;
  private readonly onEscape = () => {
    if (this.demonstrations) this.render(false);
  };
  private readonly onResize = () => { resizeCampaignViewport(this); this.render(this.demonstrations); };

  constructor() {
    super({ key: 'MenuScene' });
  }

  create() {
    resizeCampaignViewport(this);
    this.render(false);
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onResize);
    this.input.keyboard?.on('keydown-ESC', this.onEscape);
    this.events.once('shutdown', () => {
      this.generation++;
      this.input.keyboard?.off('keydown-ESC', this.onEscape);
      if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
      this.root?.destroy(true);
      this.root = undefined;
      this.scale?.setGameSize(1280, 720);
    });
  }

  private render(demonstrations: boolean) {
    this.generation++;
    this.demonstrations = demonstrations;
    this.root?.destroy(true);
    this.root = this.add.container();
    const width = this.cameras.main.width;
    const height = this.cameras.main.height;

    this.root.add(this.add.text(width / 2, height / 4, 'ORION', {
      fontSize: '64px',
      color: '#ffffff',
      fontStyle: 'bold'
    }).setOrigin(0.5));

    this.root.add(this.add.text(width / 2, height / 3, 'Space Strategy', {
      fontSize: '32px',
      color: '#ffffff'
    }).setOrigin(0.5));

    if (!demonstrations) {
      this.button('start-conquest', 'Новая кампания', height / 2, () => this.scene.start('ConquestScene'), '#265c50', 32);
      this.button('open-demonstrations', 'Демонстрации', height / 2 + 150, () => this.render(true));
      return;
    }

    this.root.add(this.add.text(width / 2, height / 2 - 50, 'Демонстрации', {
      fontSize: '28px', color: '#ffffff'
    }).setName('demonstrations-title').setOrigin(0.5));
    this.button('start-campaign', 'Мирная песочница', height / 2 + 10, () => this.scene.start('MainScene'));
    this.button('start-ship-test', 'Испытание кораблей', height / 2 + 75, () => this.scene.start('ShipTestScene'));
    this.button('start-battle-test', 'Испытание боя', height / 2 + 140, () => this.scene.start('BattleScene'), '#662222');
    this.button('open-shipyard', 'Свободная верфь', height / 2 + 205, () => this.scene.start('ShipyardScene'), '#226622');
    this.button('demonstrations-back', 'Назад', height / 2 + 270, () => this.render(false));
  }

  private button(name: string, label: string, y: number, action: () => void, backgroundColor = '#444444', fontSize = 24) {
    const generation = this.generation;
    const button = this.add.text(this.cameras.main.width / 2, y, label, {
      fontSize: `${fontSize}px`, color: '#ffffff', backgroundColor, padding: { x: 20, y: 10 }
    }).setName(name).setOrigin(0.5).setInteractive({ useHandCursor: true });
    button.on('pointerover', () => button.setStyle({ backgroundColor: '#666666' }));
    button.on('pointerout', () => button.setStyle({ backgroundColor }));
    button.on('pointerdown', () => {
      if (generation === this.generation) action();
    });
    this.root?.add(button);
  }
}