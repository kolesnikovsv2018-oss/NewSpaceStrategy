import type { FlightShip } from '../entities/interfaces/FlightShip';
import { ShipFactory } from '../entities/ShipFactory';
import { ShipSprite } from '../entities/visuals/ShipSprite';
import { ShipInfoPanel } from '../ui/ShipInfoPanel';
import { designSchema, type ShipDesign } from '../domain/shipDesign';

/**
 * Демонстрационная сцена для тестирования кораблей
 */
export class ShipTestScene extends Phaser.Scene {
  private ships: FlightShip[] = [];
  private shipSprites: ShipSprite[] = [];
  private infoPanel?: ShipInfoPanel;
  private selectedShip?: ShipSprite;
  private trialDesign?: ShipDesign;
  
  constructor() {
    super({ key: 'ShipTestScene' });
  }

  init(data: { design?: ShipDesign } = {}): void {
    this.trialDesign = data.design ? designSchema.parse(data.design) : undefined;
    // Phaser reuses settings.data when start() receives no payload. Consume it once.
    this.sys.settings.data = {};
  }

  create() {
    this.ships = [];
    this.shipSprites = [];
    this.selectedShip = undefined;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off('keydown-ESC', this.hideSelection, this);
      this.ships = [];
      this.shipSprites = [];
      this.selectedShip = undefined;
      this.infoPanel = undefined;
    });
    // Создаем звездный фон
    this.createStarfield();
    
    if (this.trialDesign) {
      const ship = ShipFactory.createFromDesign(this.trialDesign, 'blue');
      ship.position = { x: 480, y: 320 };
      this.ships.push(ship);
    } else {
    // Все четыре демонстрационных пресета создаются из проверенных проектов.
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
    
    // Крейсер уже выходит из фабрики с полной проверенной комплектацией.
    }
    
    // Создаем визуальные представления кораблей
    this.createShipSprites();
    
    // Создаем UI панель с информацией
    this.infoPanel = new ShipInfoPanel(this, 20, 20);
    
    // Добавляем инструкции
    this.add.text(this.cameras.main.width - 20, 20, 
      this.trialDesign ? 'Испытание проекта: ' + this.trialDesign.name + '\nESC — вернуться в верфь' :
        'Кликните на корабль для просмотра информации\nESC - закрыть панель', {
      fontSize: '14px',
      color: '#ffffff',
      backgroundColor: '#000000',
      padding: { x: 10, y: 5 }
    }).setOrigin(1, 0);
    
    // Тестируем движение
    this.ships[0]?.startMoving(750, 420);
    if (this.trialDesign) {
      this.infoPanel.showShipInfo(this.ships[0]);
      this.add.text(1080, 75, '← В верфь', { fontSize: '18px', color: '#8de1f2', backgroundColor: '#233e58', padding: { x: 12, y: 8 } })
        .setName('return-to-yard').setInteractive({ useHandCursor: true }).on('pointerdown', () => this.hideSelection());
      const ship = this.ships[0];
      const message = this.add.text(800, 205, 'Тест трюма: груз не сохраняется в проекте', { fontSize: '13px', color: '#b5d8ef', wordWrap: { width: 430 } });
      this.add.text(800, 125, '+ Руда: 10 ед. / 20 т / 10 м³', { fontSize: '16px', color: '#8de1f2', backgroundColor: '#233e58', padding: { x: 10, y: 5 } })
        .setName('load-test-cargo').setInteractive({ useHandCursor: true }).on('pointerdown', () => {
          const ok = ship.loadCargoLot({ resourceType: 'ore', amount: 10, mass: 20, volume: 10 });
          message.setText(ship.getCargoMessage()).setColor(ok ? '#8af5bd' : '#ff9292');
        });
      this.add.text(800, 165, '− Выгрузить 10 ед. руды', { fontSize: '16px', color: '#8de1f2', backgroundColor: '#233e58', padding: { x: 10, y: 5 } })
        .setName('unload-test-cargo').setInteractive({ useHandCursor: true }).on('pointerdown', () => {
          const ok = ship.unloadCargo('ore', 10);
          message.setText(ship.getCargoMessage()).setColor(ok ? '#8af5bd' : '#ff9292');
        });
    }
    
    // Обработчик клавиши ESC
    this.input.keyboard?.on('keydown-ESC', this.hideSelection, this);
  }

  private hideSelection(): void {
    if (this.trialDesign) { this.scene.start('ShipyardScene', { design: this.trialDesign }); return; }
    this.selectedShip?.setSelected(false);
    this.selectedShip = undefined;
    this.infoPanel?.hide();
  }

  update(_time: number, delta: number) {
    const deltaSeconds = delta / 1000;
    this.ships.forEach(ship => ship.update(deltaSeconds));
    if (this.trialDesign && this.ships[0]) {
      const ship = this.ships[0];
      if (ship.position.x > 1000 || ship.position.x < 400 || ship.position.y > 620 || ship.position.y < 150) {
        ship.startMoving(700, 360);
      }
    }
    
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
