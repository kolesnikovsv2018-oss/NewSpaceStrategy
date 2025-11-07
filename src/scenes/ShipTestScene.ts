import { Ship } from '../entities/Ship';
import { ShipFactory } from '../entities/ShipFactory';
import { ShipComponentFactory } from '../entities/ShipComponentFactory';
import { EquipmentType } from '../entities/interfaces/ShipComponents';
import { ShipSprite } from '../entities/visuals/ShipSprite';
import { ShipInfoPanel } from '../ui/ShipInfoPanel';

/**
 * Демонстрационная сцена для тестирования кораблей
 */
export class ShipTestScene extends Phaser.Scene {
  private ships: Ship[] = [];
  private shipSprites: ShipSprite[] = [];
  private infoPanel?: ShipInfoPanel;
  private selectedShip?: ShipSprite;
  
  constructor() {
    super({ key: 'ShipTestScene' });
  }

  create() {
    // Создаем звездный фон
    this.createStarfield();
    
    // Создаем несколько кораблей
    const scout = ShipFactory.createScout();
    const freighter = ShipFactory.createFreighter();
    const warship = ShipFactory.createWarship();
    const miner = ShipFactory.createMiner();
    
    this.ships.push(scout, freighter, warship, miner);
    
    // Позиционируем корабли
    scout.position = { x: 200, y: 200 };
    freighter.position = { x: 400, y: 200 };
    warship.position = { x: 600, y: 200 };
    miner.position = { x: 800, y: 200 };
    
    // Добавляем оборудование на крейсер
    const weapon = ShipComponentFactory.createEquipment(EquipmentType.WEAPON, 2);
    const shield = ShipComponentFactory.createEquipment(EquipmentType.SHIELD, 1);
    warship.installEquipment(weapon);
    warship.installEquipment(shield);
    
    // Создаем визуальные представления кораблей
    this.createShipSprites();
    
    // Создаем UI панель с информацией
    this.infoPanel = new ShipInfoPanel(this, 20, 20);
    
    // Добавляем инструкции
    this.add.text(this.cameras.main.width - 20, 20, 
      'Кликните на корабль для просмотра информации\nESC - закрыть панель', {
      fontSize: '14px',
      color: '#ffffff',
      backgroundColor: '#000000',
      padding: { x: 10, y: 5 }
    }).setOrigin(1, 0);
    
    // Тестируем движение
    scout.startMoving(400, 400);
    
    // Обработчик клавиши ESC
    this.input.keyboard?.on('keydown-ESC', () => {
      if (this.selectedShip) {
        this.selectedShip.setSelected(false);
        this.selectedShip = undefined;
      }
      this.infoPanel?.hide();
    });
  }

  update(_time: number, delta: number) {
    const deltaSeconds = delta / 1000;
    
    // Обновляем все спрайты кораблей
    this.shipSprites.forEach(sprite => {
      sprite.update(deltaSeconds);
    });
    
    // Обновляем информационную панель
    this.infoPanel?.update();
  }

  private createStarfield(): void {
    // Создаем звездный фон
    for (let i = 0; i < 200; i++) {
      const x = Phaser.Math.Between(0, this.cameras.main.width);
      const y = Phaser.Math.Between(0, this.cameras.main.height);
      const scale = Phaser.Math.FloatBetween(0.1, 1);
      const alpha = Phaser.Math.FloatBetween(0.3, 1);
      
      this.add.circle(x, y, 1, 0xffffff, 1)
        .setScale(scale)
        .setAlpha(alpha);
    }
  }

  private createShipSprites(): void {
    this.ships.forEach(ship => {
      // Создаем визуальное представление корабля
      const sprite = new ShipSprite(this, ship);
      this.shipSprites.push(sprite);
      
      // Добавляем обработчик клика
      sprite.on('pointerdown', () => {
        this.selectShip(sprite);
      });
      
      // Эффект наведения
      sprite.on('pointerover', () => {
        this.input.setDefaultCursor('pointer');
      });
      
      sprite.on('pointerout', () => {
        this.input.setDefaultCursor('default');
      });
    });
  }

  private selectShip(sprite: ShipSprite): void {
    // Снимаем выделение с предыдущего корабля
    if (this.selectedShip) {
      this.selectedShip.setSelected(false);
    }
    
    // Выделяем новый корабль
    this.selectedShip = sprite;
    sprite.setSelected(true);
    
    // Показываем информацию
    this.infoPanel?.showShipInfo(sprite.getShip());
  }
}
