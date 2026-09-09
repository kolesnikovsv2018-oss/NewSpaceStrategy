import type { ShipView } from '../entities/interfaces/ShipView';
import { formatFlightEstimate } from '../domain/flightEstimate';

/**
 * Панель информации о корабле
 */
export class ShipInfoPanel extends Phaser.GameObjects.Container {
  private background: Phaser.GameObjects.Graphics;
  private titleText: Phaser.GameObjects.Text;
  private infoText: Phaser.GameObjects.Text;
  private componentIcons: Phaser.GameObjects.Graphics[] = [];
  private ship?: ShipView;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);

    // Создаем фон панели
    this.background = new Phaser.GameObjects.Graphics(scene);
    this.background.fillStyle(0x000000, 0.85);
    this.background.fillRoundedRect(0, 0, 300, 400, 10);
    this.background.lineStyle(2, 0x00ffff, 1);
    this.background.strokeRoundedRect(0, 0, 300, 400, 10);

    // Заголовок
    this.titleText = new Phaser.GameObjects.Text(scene, 150, 20, 'Информация о корабле', {
      fontSize: '18px',
      color: '#00ffff',
      fontStyle: 'bold'
    }).setOrigin(0.5, 0);

    // Основной текст с информацией
    this.infoText = new Phaser.GameObjects.Text(scene, 15, 60, '', {
      fontSize: '13px',
      color: '#ffffff',
      lineSpacing: 5,
      wordWrap: { width: 270 }
    });

    // Добавляем элементы
    this.add([this.background, this.titleText, this.infoText]);

    // Скрываем панель по умолчанию
    this.setVisible(false);

    scene.add.existing(this);
  }

  /**
   * Показать информацию о корабле
   */
  showShipInfo(ship: ShipView): void {
    this.ship = ship;
    this.updateInfo();
    this.drawComponentVisuals();
    this.setVisible(true);
  }

  /**
   * Скрыть панель
   */
  hide(): void {
    this.setVisible(false);
    this.ship = undefined;
  }

  /**
   * Обновить информацию
   */
  private updateInfo(): void {
    if (!this.ship) return;
    if (this.ship.getDesign()) {
      this.infoText.setText(this.ship.getInfo());
      this.fitInfo(false);
      return;
    }

    const energyPercent = ((this.ship.powerSource.currentEnergy / this.ship.powerSource.energyCapacity) * 100).toFixed(0);
    const cargoPercent = ((this.ship.cargoHold.usedSpace / this.ship.cargoHold.capacity) * 100).toFixed(0);
    
    const info = `
Название: ${this.ship.name}

━━━ ХАРАКТЕРИСТИКИ ━━━
Стоимость: ${this.ship.getTotalCost()} кр.
Вес: ${this.ship.getTotalWeight().toFixed(1)} т
Скорость: ${this.ship.getCurrentMaxSpeed().toFixed(1)} такт. ед/с
Полёт (только движение): ${formatFlightEstimate(this.ship.getFlightEstimate())}

━━━ ЭНЕРГИЯ ━━━
${this.ship.powerSource.name}
Запас: ${this.ship.powerSource.currentEnergy}/${this.ship.powerSource.energyCapacity} ЭЕ (${energyPercent}%)
Генерация: ${this.ship.powerSource.energyOutput} ЭЕ/с

━━━ ДВИГАТЕЛЬ ━━━
${this.ship.engine.name}
Тяга: ${this.ship.engine.thrust}
Потребление: ${this.ship.engine.energyConsumption} ЭЕ/с

━━━ ГРУЗОВОЙ ОТСЕК ━━━
${this.ship.cargoHold.name}
Занято: ${this.ship.cargoHold.usedSpace}/${this.ship.cargoHold.capacity} м³ (${cargoPercent}%)
Вес: ${this.ship.cargoHold.currentWeight}/${this.ship.cargoHold.maxWeight} т

━━━ ОБОРУДОВАНИЕ ━━━
Установлено: ${this.ship.getInstalledModuleNames().length} ед.
${this.ship.getInstalledModuleNames().map(name => `• ${name}`).join('\n')}
    `.trim();

    this.infoText.setText(info);
    this.fitInfo(true);
  }

  /** Fit both model branches, reserving room below the text for legacy icons. */
  private fitInfo(includeIcons: boolean): void {
    const availableHeight = Math.max(100, this.scene.cameras.main.height - this.y - 40);
    const padding = includeIcons ? 134 : 84;
    this.infoText.setScale(Math.min(1, 270 / Math.max(1, this.infoText.width),
      Math.max(1, availableHeight - padding) / Math.max(1, this.infoText.height)));
    const height = Math.min(availableHeight, Math.max(260, padding + this.infoText.displayHeight));
    this.background.clear();
    this.background.fillStyle(0x000000, 0.85);
    this.background.fillRoundedRect(0, 0, 300, height, 10);
    this.background.lineStyle(2, 0x00ffff, 1);
    this.background.strokeRoundedRect(0, 0, 300, height, 10);
    if (includeIcons) this.componentIcons.forEach(icon => icon.setY(84 + this.infoText.displayHeight));
  }

  /**
   * Нарисовать визуальное представление компонентов
   */
  private drawComponentVisuals(): void {
    if (!this.ship) return;

    // Очищаем старые иконки
    this.componentIcons.forEach(icon => icon.destroy());
    this.componentIcons = [];
    // Canonical blueprints already show installed modules; legacy decorative icons overlap long descriptions.
    if (this.ship.getDesign()) return;

    const startX = 20;
    const startY = 0;
    const iconSize = 30;
    const spacing = 10;

    // Иконка источника энергии
    const powerIcon = new Phaser.GameObjects.Graphics(this.scene);
    powerIcon.setY(84 + this.infoText.displayHeight);
    powerIcon.fillStyle(0xffff00, 1);
    powerIcon.fillCircle(startX + iconSize / 2, startY + iconSize / 2, iconSize / 2);
    powerIcon.lineStyle(2, 0xffffff, 1);
    powerIcon.strokeCircle(startX + iconSize / 2, startY + iconSize / 2, iconSize / 2);
    this.add(powerIcon);
    this.componentIcons.push(powerIcon);

    // Иконка двигателя
    const engineIcon = new Phaser.GameObjects.Graphics(this.scene);
    engineIcon.setY(84 + this.infoText.displayHeight);
    engineIcon.fillStyle(0x00ffff, 1);
    engineIcon.fillTriangle(
      startX + iconSize + spacing + iconSize / 2, startY,
      startX + iconSize + spacing, startY + iconSize,
      startX + iconSize + spacing + iconSize, startY + iconSize
    );
    engineIcon.lineStyle(2, 0xffffff, 1);
    engineIcon.strokeTriangle(
      startX + iconSize + spacing + iconSize / 2, startY,
      startX + iconSize + spacing, startY + iconSize,
      startX + iconSize + spacing + iconSize, startY + iconSize
    );
    this.add(engineIcon);
    this.componentIcons.push(engineIcon);

    // Иконка грузового отсека
    const cargoIcon = new Phaser.GameObjects.Graphics(this.scene);
    cargoIcon.setY(84 + this.infoText.displayHeight);
    cargoIcon.fillStyle(0xffaa00, 1);
    cargoIcon.fillRect(
      startX + (iconSize + spacing) * 2,
      startY,
      iconSize,
      iconSize
    );
    cargoIcon.lineStyle(2, 0xffffff, 1);
    cargoIcon.strokeRect(
      startX + (iconSize + spacing) * 2,
      startY,
      iconSize,
      iconSize
    );
    this.add(cargoIcon);
    this.componentIcons.push(cargoIcon);
  }

  /**
   * Обновление панели
   */
  update(): void {
    if (this.ship && this.visible) {
      this.updateInfo();
    }
  }
}
