import Phaser from 'phaser';
import { Ship } from '../entities/Ship';
import { ShipFactory } from '../entities/ShipFactory';
import { ComponentBuilderPanel } from '../ui/ComponentBuilderPanel';
import { ShipBuilderPanel } from '../ui/ShipBuilderPanel';

/**
 * Сцена верфи (конструктора кораблей)
 */
export class ShipyardScene extends Phaser.Scene {
  private componentPanel?: ComponentBuilderPanel;
  private shipPanel?: ShipBuilderPanel;
  private currentShip?: Ship;

  constructor() {
    super({ key: 'ShipyardScene' });
  }

  create() {
    const width = this.cameras.main.width;

    // Фон
    this.createBackground();

    // Заголовок
    const title = this.add.text(width / 2, 30, '🔧 ВЕРФЬ - КОНСТРУКТОР КОРАБЛЕЙ', {
      fontSize: '28px',
      color: '#00ccff',
      fontStyle: 'bold'
    }).setOrigin(0.5);
    title.setInteractive({ useHandCursor: true });

    // Кнопки управления вверху
    this.createControlButtons();

    // Создаем всплывающую подсказку
    const tooltip = this.add.container(width / 2, 80);
    tooltip.setVisible(false);

    const tooltipBg = this.add.graphics();
    tooltipBg.fillStyle(0x000000, 0.9);
    tooltipBg.fillRoundedRect(-300, -45, 600, 90, 8);
    tooltipBg.lineStyle(2, 0x00ccff, 1);
    tooltipBg.strokeRoundedRect(-300, -45, 600, 90, 8);
    tooltip.add(tooltipBg);

    const tooltipText = this.add.text(
      0,
      0,
      'Конструктор компонентов: создавайте оружие, двигатели, щиты и другое оборудование\n' +
      'Конструктор корабля: устанавливайте созданные компоненты в слоты корабля\n' +
      'ESC - вернуться в меню | Тест - проверить корабль в действии',
      {
        fontSize: '11px',
        color: '#ffffff',
        align: 'center',
        lineSpacing: 5
      }
    ).setOrigin(0.5);
    tooltip.add(tooltipText);

    // Показываем подсказку при наведении на заголовок
    title.on('pointerover', () => {
      tooltip.setVisible(true);
      title.setStyle({ color: '#00ffff' });
    });
    title.on('pointerout', () => {
      tooltip.setVisible(false);
      title.setStyle({ color: '#00ccff' });
    });

    // Создаем тестовый корабль
    this.currentShip = ShipFactory.createWarship();

    // Панель конструктора компонентов (слева)
    this.componentPanel = new ComponentBuilderPanel(this, 20, 100);
    this.componentPanel.setOnComponentCreated(() => {
      // Сразу передаем все компоненты в конструктор корабля
      const components = this.componentPanel?.getComponents() || [];
      this.shipPanel?.setAvailableComponents(components);
    });

    // Панель конструктора корабля (справа)
    this.shipPanel = new ShipBuilderPanel(this, width - 520, 100, this.currentShip);

    // Инициализируем компоненты корабля
    const components = this.componentPanel?.getComponents() || [];
    this.shipPanel?.setAvailableComponents(components);

    // Обе панели всегда видны
    this.componentPanel.setVisible(true);
    this.shipPanel.setVisible(true);

    // Обработчик ESC
    this.input.keyboard?.on('keydown-ESC', () => {
      this.scene.start('MenuScene');
    });
  }

  /**
   * Создать фон
   */
  private createBackground(): void {
    // Градиентный фон
    const graphics = this.add.graphics();
    graphics.fillGradientStyle(0x001122, 0x001122, 0x002244, 0x002244, 1, 1, 1, 1);
    graphics.fillRect(0, 0, this.cameras.main.width, this.cameras.main.height);

    // Звезды
    for (let i = 0; i < 150; i++) {
      const x = Phaser.Math.Between(0, this.cameras.main.width);
      const y = Phaser.Math.Between(0, this.cameras.main.height);
      const size = Phaser.Math.FloatBetween(0.5, 1.5);
      const alpha = Phaser.Math.FloatBetween(0.3, 0.9);
      
      this.add.circle(x, y, size, 0xffffff, alpha);
    }

    // Декоративные элементы
    const gridLines = this.add.graphics();
    gridLines.lineStyle(1, 0x00ffff, 0.1);
    for (let i = 0; i < this.cameras.main.width; i += 50) {
      gridLines.lineBetween(i, 0, i, this.cameras.main.height);
    }
    for (let i = 0; i < this.cameras.main.height; i += 50) {
      gridLines.lineBetween(0, i, this.cameras.main.width, i);
    }
  }



  /**
   * Создать кнопки управления
   */
  private createControlButtons(): void {
    const width = this.cameras.main.width;

    // Кнопка "В меню" (слева от заголовка)
    const menuBtn = this.add.text(
      30,
      30,
      '← Меню',
      {
        fontSize: '16px',
        color: '#ffffff',
        backgroundColor: '#444444',
        padding: { x: 15, y: 8 }
      }
    ).setOrigin(0, 0.5);
    
    menuBtn.setInteractive({ useHandCursor: true });
    menuBtn.on('pointerover', () => menuBtn.setStyle({ backgroundColor: '#666666' }));
    menuBtn.on('pointerout', () => menuBtn.setStyle({ backgroundColor: '#444444' }));
    menuBtn.on('pointerdown', () => this.scene.start('MenuScene'));

    // Кнопка "Тест корабля" (справа от заголовка)
    const testBtn = this.add.text(
      width - 30,
      30,
      '🚀 Тест',
      {
        fontSize: '16px',
        color: '#ffffff',
        backgroundColor: '#006600',
        padding: { x: 15, y: 8 }
      }
    ).setOrigin(1, 0.5);
    
    testBtn.setInteractive({ useHandCursor: true });
    testBtn.on('pointerover', () => testBtn.setStyle({ backgroundColor: '#008800' }));
    testBtn.on('pointerout', () => testBtn.setStyle({ backgroundColor: '#006600' }));
    testBtn.on('pointerdown', () => {
      if (this.currentShip) {
        this.scene.start('ShipTestScene');
      }
    });
  }

  /**
   * Очистка
   */
  shutdown(): void {
    this.componentPanel?.destroy();
    this.shipPanel?.destroy();
  }
}
