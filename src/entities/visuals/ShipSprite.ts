import { Ship } from '../Ship';

/**
 * Визуальное представление корабля в Phaser
 */
export class ShipSprite extends Phaser.GameObjects.Container {
  private ship: Ship;
  private shipBody: Phaser.GameObjects.Graphics;
  private engineGlow: Phaser.GameObjects.Graphics;
  private energyBar: Phaser.GameObjects.Graphics;
  private nameText: Phaser.GameObjects.Text;
  private selectionCircle: Phaser.GameObjects.Graphics;
  private isSelected: boolean = false;

  constructor(scene: Phaser.Scene, ship: Ship) {
    super(scene, ship.position.x, ship.position.y);
    this.ship = ship;

    // Создаем графические элементы
    this.shipBody = new Phaser.GameObjects.Graphics(scene);
    this.engineGlow = new Phaser.GameObjects.Graphics(scene);
    this.energyBar = new Phaser.GameObjects.Graphics(scene);
    this.selectionCircle = new Phaser.GameObjects.Graphics(scene);

    // Создаем текст с названием
    this.nameText = new Phaser.GameObjects.Text(scene, 0, -40, ship.name, {
      fontSize: '14px',
      color: '#ffffff',
      backgroundColor: '#000000',
      padding: { x: 5, y: 2 }
    }).setOrigin(0.5);

    // Добавляем элементы в контейнер
    this.add([this.selectionCircle, this.engineGlow, this.shipBody, this.energyBar, this.nameText]);

    // Рисуем корабль
    this.drawShip();
    this.drawEnergyBar();

    // Делаем корабль интерактивным
    this.setSize(60, 60);
    this.setInteractive(new Phaser.Geom.Circle(0, 0, 30), Phaser.Geom.Circle.Contains);

    scene.add.existing(this);
  }

  /**
   * Отрисовка корабля на основе его компонентов
   */
  private drawShip(): void {
    this.shipBody.clear();

    // Определяем цвет корабля на основе типа
    const color = this.getShipColor();

    // Основной корпус корабля
    this.shipBody.fillStyle(color, 1);
    this.shipBody.fillTriangle(0, -20, -15, 15, 15, 15);

    // Крылья/боковые части (зависят от типа двигателя)
    this.shipBody.fillStyle(color, 0.8);
    this.shipBody.fillTriangle(-15, 15, -20, 20, -10, 20);
    this.shipBody.fillTriangle(15, 15, 20, 20, 10, 20);

    // Кабина
    this.shipBody.fillStyle(0x00ffff, 1);
    this.shipBody.fillCircle(0, -5, 4);

    // Грузовой отсек (размер зависит от вместимости)
    const cargoSize = Math.min(this.ship.cargoHold.capacity / 50, 10);
    this.shipBody.fillStyle(0xffaa00, 0.7);
    this.shipBody.fillRect(-cargoSize / 2, 0, cargoSize, 10);

    // Оборудование (отображаем как точки)
    this.ship.equipment.forEach((_, index) => {
      const angle = (index / this.ship.equipment.length) * Math.PI * 2;
      const x = Math.cos(angle) * 18;
      const y = Math.sin(angle) * 18;
      this.shipBody.fillStyle(0xff00ff, 1);
      this.shipBody.fillCircle(x, y, 3);
    });

    // Обводка
    this.shipBody.lineStyle(1, 0xffffff, 0.5);
    this.shipBody.strokeTriangle(0, -20, -15, 15, 15, 15);
  }

  /**
   * Отрисовка свечения двигателей
   */
  private drawEngineGlow(): void {
    this.engineGlow.clear();

    if (this.ship.isMoving) {
      // Определяем интенсивность свечения на основе скорости
      const intensity = this.ship.getCurrentMaxSpeed() / 400;
      const alpha = 0.3 + intensity * 0.7;

      // Левый двигатель
      this.engineGlow.fillStyle(0x00ffff, alpha);
      this.engineGlow.fillCircle(-10, 20, 4);
      this.engineGlow.fillStyle(0xffffff, alpha * 0.5);
      this.engineGlow.fillCircle(-10, 22, 6);

      // Правый двигатель
      this.engineGlow.fillStyle(0x00ffff, alpha);
      this.engineGlow.fillCircle(10, 20, 4);
      this.engineGlow.fillStyle(0xffffff, alpha * 0.5);
      this.engineGlow.fillCircle(10, 22, 6);
    }
  }

  /**
   * Отрисовка полоски энергии
   */
  private drawEnergyBar(): void {
    this.energyBar.clear();

    const barWidth = 40;
    const barHeight = 4;
    const x = -barWidth / 2;
    const y = -30;

    // Фон
    this.energyBar.fillStyle(0x333333, 1);
    this.energyBar.fillRect(x, y, barWidth, barHeight);

    // Текущая энергия
    const energyPercent = this.ship.powerSource.currentEnergy / this.ship.powerSource.energyCapacity;
    const energyColor = energyPercent > 0.5 ? 0x00ff00 : energyPercent > 0.2 ? 0xffaa00 : 0xff0000;
    
    this.energyBar.fillStyle(energyColor, 1);
    this.energyBar.fillRect(x, y, barWidth * energyPercent, barHeight);

    // Обводка
    this.energyBar.lineStyle(1, 0xffffff, 0.5);
    this.energyBar.strokeRect(x, y, barWidth, barHeight);
  }

  /**
   * Отрисовка круга выделения
   */
  private drawSelectionCircle(): void {
    this.selectionCircle.clear();

    if (this.isSelected) {
      this.selectionCircle.lineStyle(2, 0xffff00, 1);
      this.selectionCircle.strokeCircle(0, 0, 35);
      
      // Пульсирующий эффект
      const pulse = Math.sin(Date.now() / 200) * 0.3 + 0.7;
      this.selectionCircle.setAlpha(pulse);
    }
  }

  /**
   * Определить цвет корабля на основе его типа
   */
  private getShipColor(): number {
    const name = this.ship.name.toLowerCase();
    
    if (name.includes('разведчик') || name.includes('scout')) {
      return 0x00ff00; // Зеленый
    } else if (name.includes('грузов') || name.includes('freight')) {
      return 0xffaa00; // Оранжевый
    } else if (name.includes('крейсер') || name.includes('war')) {
      return 0xff0000; // Красный
    } else if (name.includes('добытчик') || name.includes('miner')) {
      return 0xffff00; // Желтый
    }
    
    return 0x00aaff; // Синий по умолчанию
  }

  /**
   * Выбрать/снять выделение корабля
   */
  setSelected(selected: boolean): void {
    this.isSelected = selected;
    this.drawSelectionCircle();
  }

  /**
   * Обновление визуализации
   */
  update(deltaTime: number): void {
    // Обновляем модель корабля
    this.ship.update(deltaTime);

    // Обновляем позицию спрайта
    this.setPosition(this.ship.position.x, this.ship.position.y);

    // Поворачиваем корабль по направлению движения
    if (this.ship.isMoving) {
      const angle = Math.atan2(this.ship.velocity.y, this.ship.velocity.x);
      this.setRotation(angle + Math.PI / 2);
    }

    // Обновляем визуальные элементы
    this.drawEngineGlow();
    this.drawEnergyBar();
    this.drawSelectionCircle();
  }

  /**
   * Показать детальную информацию о корабле
   */
  showInfo(): string {
    return this.ship.getInfo();
  }

  /**
   * Получить модель корабля
   */
  getShip(): Ship {
    return this.ship;
  }
}
