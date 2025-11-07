import Phaser from 'phaser';
import { Ship } from '../entities/Ship';
import { 
  IEquipment, 
  IEquipmentSlot,
  IShipConfiguration,
  EquipmentSlotType,
  SlotSize,
  IEngine,
  IWeapon,
  IBeamWeapon,
  IProjectileWeapon,
  WeaponType,
  IHull,
  HullSize
} from '../entities/interfaces/Equipment';
import { ShipSprite } from '../entities/visuals/ShipSprite';

/**
 * Панель конструктора кораблей
 */
export class ShipBuilderPanel {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private background: Phaser.GameObjects.Graphics;
  private width: number = 500;
  private height: number = 600;
  
  private ship?: Ship;
  private shipSprite?: ShipSprite;
  private configuration: IShipConfiguration;
  private availableComponents: IEquipment[] = [];
  
  private slotsContainer?: Phaser.GameObjects.Container;
  private statsContainer?: Phaser.GameObjects.Container;
  private statsScrollContainer?: Phaser.GameObjects.Container;
  private statsScrollY: number = 0;
  private statsMaxScroll: number = 0;
  private inventoryContainer?: Phaser.GameObjects.Container;
  private selectionModal?: Phaser.GameObjects.Container;
  private currentSlotForSelection?: IEquipmentSlot;
  
  // Callbacks
  private onShipChanged?: (ship: Ship) => void;

  constructor(scene: Phaser.Scene, x: number, y: number, ship?: Ship) {
    this.scene = scene;
    this.ship = ship;
    this.container = scene.add.container(x, y);
    this.background = scene.add.graphics();
    this.container.add(this.background);
    
    // Инициализируем конфигурацию
    this.configuration = this.createDefaultConfiguration();
    
    this.createUI();
  }

  /**
   * Создать конфигурацию по умолчанию
   */
  private createDefaultConfiguration(): IShipConfiguration {
    const hullSize = HullSize.Corvette;
    const structuralIntegrity = 1000;
    
    return {
      id: `config_${Date.now()}`,
      name: 'Новая конфигурация',
      description: 'Базовая конфигурация корабля',
      hullType: 'corvette',
      hull: {
        size: hullSize,
        structuralIntegrity: structuralIntegrity,
        maxHitPoints: this.calculateMaxHitPoints(hullSize, structuralIntegrity)
      },
      slots: this.createDefaultSlots(),
      totalMass: 0,
      totalPowerConsumption: 0,
      created: new Date(),
      modified: new Date()
    };
  }

  /**
   * Рассчитать максимальные очки прочности корабля
   * Зависит от размера корпуса и прочности
   */
  private calculateMaxHitPoints(size: HullSize, structuralIntegrity: number): number {
    // Базовые множители для размеров
    const sizeMultipliers: Record<HullSize, number> = {
      [HullSize.Fighter]: 1,
      [HullSize.Corvette]: 2,
      [HullSize.Frigate]: 3,
      [HullSize.Destroyer]: 5,
      [HullSize.Cruiser]: 8,
      [HullSize.Battleship]: 12
    };
    
    const multiplier = sizeMultipliers[size] || 1;
    return Math.round(structuralIntegrity * multiplier);
  }

  /**
   * Создать слоты по умолчанию
   */
  private createDefaultSlots(): IEquipmentSlot[] {
    return [
      // Лучевое оружие
      {
        id: 'weapon_1',
        type: EquipmentSlotType.Weapon,
        size: SlotSize.Large,
        locked: false,
        position: { x: -30, y: -20 }
      },
      {
        id: 'weapon_2',
        type: EquipmentSlotType.Weapon,
        size: SlotSize.Large,
        locked: false,
        position: { x: 30, y: -20 }
      },
      // Снарядное оружие
      {
        id: 'projectile_weapon_1',
        type: EquipmentSlotType.ProjectileWeapon,
        size: SlotSize.Large,
        locked: false,
        position: { x: -40, y: -10 }
      },
      {
        id: 'projectile_weapon_2',
        type: EquipmentSlotType.ProjectileWeapon,
        size: SlotSize.Large,
        locked: false,
        position: { x: 40, y: -10 }
      },
      // Двигатель
      {
        id: 'engine_1',
        type: EquipmentSlotType.Engine,
        size: SlotSize.Large,
        locked: false,
        position: { x: 0, y: 40 }
      },
      // Щит
      {
        id: 'shield_1',
        type: EquipmentSlotType.Shield,
        size: SlotSize.Large,
        locked: false,
        position: { x: 0, y: 0 }
      },
      // Энергоядро
      {
        id: 'powercore_1',
        type: EquipmentSlotType.PowerCore,
        size: SlotSize.Large,
        locked: false,
        position: { x: 0, y: 10 }
      },
      // Броня
      {
        id: 'armor_1',
        type: EquipmentSlotType.Armor,
        size: SlotSize.Large,
        locked: false,
        position: { x: 0, y: 0 }
      },
      // Сенсоры
      {
        id: 'sensor_1',
        type: EquipmentSlotType.Sensor,
        size: SlotSize.Medium,
        locked: false,
        position: { x: 0, y: -30 }
      },
      // Компьютер
      {
        id: 'computer_1',
        type: EquipmentSlotType.Computer,
        size: SlotSize.Medium,
        locked: false,
        position: { x: 0, y: -10 }
      }
    ];
  }

  /**
   * Создать UI
   */
  private createUI(): void {
    // Фон панели
    this.background.fillStyle(0x2a2a3a, 0.95);
    this.background.fillRoundedRect(0, 0, this.width, this.height, 8);
    this.background.lineStyle(2, 0x0088ff, 1);
    this.background.strokeRoundedRect(0, 0, this.width, this.height, 8);

    // Заголовок
    const title = this.scene.add.text(this.width / 2, 20, 'КОНСТРУКТОР КОРАБЛЯ', {
      fontSize: '18px',
      color: '#0088ff',
      fontStyle: 'bold'
    }).setOrigin(0.5);
    this.container.add(title);

    // Визуализация корабля
    this.createShipVisualization();

    // Слоты оборудования
    this.createSlotsPanel();

    // Статистика корабля
    this.createStatsPanel();

    // Инвентарь компонентов
    this.createInventoryPanel();

    // Кнопки управления
    this.createControlButtons();
  }

  /**
   * Создать визуализацию корабля
   */
  private createShipVisualization(): void {
    const shipArea = this.scene.add.container(this.width / 2, 150);
    this.container.add(shipArea);

    // Фон для визуализации
    const vizBg = this.scene.add.graphics();
    vizBg.fillStyle(0x1a1a2a, 1);
    vizBg.fillCircle(0, 0, 80);
    vizBg.lineStyle(2, 0x0088ff, 0.5);
    vizBg.strokeCircle(0, 0, 80);
    shipArea.add(vizBg);

    // Если есть корабль, показываем его
    if (this.ship) {
      this.shipSprite = new ShipSprite(this.scene, this.ship);
      this.shipSprite.x = this.width / 2;
      this.shipSprite.y = 150;
      this.container.add(this.shipSprite);
    }

    // Название конфигурации
    const configName = this.scene.add.text(0, 100, this.configuration.name, {
      fontSize: '14px',
      color: '#00ddff'
    }).setOrigin(0.5);
    shipArea.add(configName);
  }

  /**
   * Создать панель слотов
   */
  private createSlotsPanel(): void {
    this.slotsContainer = this.scene.add.container(10, 300);
    this.container.add(this.slotsContainer);

    const panelBg = this.scene.add.graphics();
    panelBg.fillStyle(0x1a1a2a, 1);
    panelBg.fillRect(0, 0, this.width - 20, 180);
    panelBg.lineStyle(1, 0x0088ff, 0.5);
    panelBg.strokeRect(0, 0, this.width - 20, 180);
    this.slotsContainer.add(panelBg);

    const slotsTitle = this.scene.add.text(10, 10, '🔧 СЛОТЫ ОБОРУДОВАНИЯ (клик для установки)', {
      fontSize: '11px',
      color: '#00aaff',
      fontStyle: 'bold'
    });
    this.slotsContainer.add(slotsTitle);

    this.updateSlotsDisplay();
  }

  /**
   * Обновить отображение слотов
   */
  private updateSlotsDisplay(): void {
    if (!this.slotsContainer) return;

    // Очищаем старые элементы (кроме фона и заголовка)
    while (this.slotsContainer.length > 2) {
      const item = this.slotsContainer.list[2];
      if (item) {
        this.slotsContainer.remove(item, true);
      }
    }

    let y = 35;
    this.configuration.slots.forEach((slot, index) => {
      const slotY = y + Math.floor(index / 2) * 30;
      const slotX = 10 + (index % 2) * 240;

      // Фон слота
      const slotBg = this.scene.add.rectangle(
        slotX + 110,
        slotY,
        220,
        25,
        slot.equipment ? 0x003300 : 0x334455
      );
      slotBg.setInteractive({ useHandCursor: true });
      slotBg.on('pointerdown', () => {
        this.onSlotClick(slot);
      });

      // Информация о слоте
      const slotText = this.scene.add.text(
        slotX + 5,
        slotY - 8,
        slot.equipment 
          ? `${this.getSlotTypeName(slot.type)}: ${slot.equipment.name}`
          : `${this.getSlotTypeName(slot.type)} [${this.getSizeName(slot.size)}]`,
        {
          fontSize: '10px',
          color: slot.equipment ? '#00ff00' : '#aaddff'
        }
      );
      // Делаем текст также кликабельным
      slotText.setInteractive({ useHandCursor: true });
      slotText.on('pointerdown', () => {
        this.onSlotClick(slot);
      });

      this.slotsContainer?.add(slotBg);
      this.slotsContainer?.add(slotText);

      // Кнопка удаления оборудования
      if (slot.equipment) {
        const removeBtn = this.scene.add.text(
          slotX + 205,
          slotY - 8,
          'X',
          {
            fontSize: '12px',
            color: '#ffffff',
            backgroundColor: '#cc0000',
            padding: { x: 4, y: 2 }
          }
        );
        removeBtn.setInteractive({ useHandCursor: true });
        removeBtn.on('pointerdown', () => this.removeEquipment(slot));
        this.slotsContainer?.add(removeBtn);
      }
    });
  }

  /**
   * Создать панель статистики
   */
  private createStatsPanel(): void {
    this.statsContainer = this.scene.add.container(10, 490);
    this.container.add(this.statsContainer);

    const panelBg = this.scene.add.graphics();
    panelBg.fillStyle(0x1a1a2a, 1);
    panelBg.fillRect(0, 0, this.width - 20, 70);
    panelBg.lineStyle(1, 0x0088ff, 0.5);
    panelBg.strokeRect(0, 0, this.width - 20, 70);
    this.statsContainer.add(panelBg);

    const statsTitle = this.scene.add.text(10, 10, 'ХАРАКТЕРИСТИКИ', {
      fontSize: '13px',
      color: '#ffffff',
      fontStyle: 'bold'
    });
    this.statsContainer.add(statsTitle);

    // Создаем контейнер для прокручиваемого содержимого
    this.statsScrollContainer = this.scene.add.container(0, 30);
    this.statsContainer.add(this.statsScrollContainer);

    // Создаем маску для области прокрутки
    const maskShape = this.scene.make.graphics({});
    maskShape.fillStyle(0xffffff);
    // Маска относительно экрана (container.x + statsContainer.x + 10, container.y + statsContainer.y + 30)
    const maskX = this.container.x + 10;
    const maskY = this.container.y + 520;
    maskShape.fillRect(maskX, maskY, this.width - 20, 40);
    const mask = maskShape.createGeometryMask();
    this.statsScrollContainer.setMask(mask);

    // Добавляем обработчик колесика мыши для прокрутки
    this.scene.input.on('wheel', (pointer: Phaser.Input.Pointer, _gameObjects: any[], _deltaX: number, deltaY: number) => {
      if (this.statsContainer && this.statsScrollContainer) {
        // Проверяем, находится ли курсор над панелью статистики
        const localX = pointer.x - this.container.x - 10;
        const localY = pointer.y - this.container.y - 490;
        
        if (localX >= 0 && localX <= this.width - 20 && localY >= 0 && localY <= 70) {
          this.statsScrollY -= deltaY * 0.3;
          this.statsScrollY = Phaser.Math.Clamp(this.statsScrollY, -this.statsMaxScroll, 0);
          this.statsScrollContainer.y = 30 + this.statsScrollY;
        }
      }
    });

    this.updateStatsDisplay();
  }

  /**
   * Обновить отображение статистики
   */
  private updateStatsDisplay(): void {
    if (!this.statsScrollContainer) return;

    // Очищаем контейнер прокрутки
    this.statsScrollContainer.removeAll(true);

    // Подсчитываем статистику
    this.calculateStats();

    const powerGeneration = this.getTotalPowerGeneration();
    const powerConsumption = this.getTotalPowerConsumption();
    const powerBalance = powerGeneration - powerConsumption;
    const powerColor = powerBalance >= 0 ? '#00ff00' : '#ff0000';

    // Размер корпуса (русские названия)
    const hullSizeNames: Record<HullSize, string> = {
      [HullSize.Fighter]: 'Истребитель',
      [HullSize.Corvette]: 'Корвет',
      [HullSize.Frigate]: 'Фрегат',
      [HullSize.Destroyer]: 'Эсминец',
      [HullSize.Cruiser]: 'Крейсер',
      [HullSize.Battleship]: 'Линкор'
    };

    const stats = [
      `🚀 Корпус: ${hullSizeNames[this.configuration.hull.size] || this.configuration.hull.size}`,
      `💪 Прочность: ${this.configuration.hull.structuralIntegrity}`,
      `❤️ Макс.урон: ${this.configuration.hull.maxHitPoints}`,
      `⚖️ Масса: ${this.configuration.totalMass.toFixed(1)}т`,
      `⚡ Энергия: ${powerGeneration}`,
      `⚡ Потребление: ${powerConsumption}`,
      `⚡ Баланс: ${powerBalance > 0 ? '+' : ''}${powerBalance}`,
      `📦 Установлено: ${this.configuration.slots.filter(s => s.equipment).length}/${this.configuration.slots.length}`,
    ];

    let maxY = 0;
    stats.forEach((text, index) => {
      const y = 5 + index * 20;
      let color = '#cccccc';
      
      // Окрашиваем баланс энергии
      if (index === 6) {
        color = powerColor;
      }
      // Окрашиваем информацию о корпусе
      else if (index <= 2) {
        color = '#aaddff';
      }
      
      const statText = this.scene.add.text(10, y, text, {
        fontSize: '11px',
        color: color
      });
      this.statsScrollContainer?.add(statText);
      maxY = y + 20;
    });

    // Обновляем максимальный скролл
    this.statsMaxScroll = Math.max(0, maxY - 50);
  }

  /**
   * Создать панель инвентаря
   */
  private createInventoryPanel(): void {
    this.inventoryContainer = this.scene.add.container(10, 200);
    this.container.add(this.inventoryContainer);

    const panelBg = this.scene.add.graphics();
    panelBg.fillStyle(0x1a1a2a, 1);
    panelBg.fillRect(0, 0, this.width - 20, 90);
    panelBg.lineStyle(1, 0x0088ff, 0.5);
    panelBg.strokeRect(0, 0, this.width - 20, 90);
    this.inventoryContainer.add(panelBg);

    const inventoryTitle = this.scene.add.text(10, 10, '📦 ДОСТУПНЫЕ КОМПОНЕНТЫ', {
      fontSize: '11px',
      color: '#00aaff',
      fontStyle: 'bold'
    });
    this.inventoryContainer.add(inventoryTitle);

    this.updateInventoryDisplay();
  }

  /**
   * Обновить отображение инвентаря
   */
  private updateInventoryDisplay(): void {
    if (!this.inventoryContainer) return;

    // Очищаем старые элементы (кроме фона и заголовка)
    while (this.inventoryContainer.length > 2) {
      const item = this.inventoryContainer.list[2];
      if (item) {
        this.inventoryContainer.remove(item, true);
      }
    }

    // Группируем компоненты по типу
    const groupedComponents: Record<string, number> = {};
    this.availableComponents.forEach(comp => {
      const type = this.getEquipmentType(comp);
      const typeName = this.getSlotTypeName(type);
      groupedComponents[typeName] = (groupedComponents[typeName] || 0) + 1;
    });

    // Отображаем статистику
    let y = 35;
    const entries = Object.entries(groupedComponents);
    
    if (entries.length === 0) {
      const emptyText = this.scene.add.text(
        (this.width - 20) / 2,
        y + 15,
        'Нет доступных компонентов\nСоздайте компоненты в конструкторе',
        {
          fontSize: '10px',
          color: '#ffffff',
          align: 'center'
        }
      ).setOrigin(0.5, 0);
      this.inventoryContainer.add(emptyText);
    } else {
      entries.forEach(([typeName, count], index) => {
        if (index >= 4) return; // Максимум 4 типа

        const text = this.scene.add.text(
          10 + (index % 2) * 240,
          y + Math.floor(index / 2) * 20,
          `${typeName}: ${count} шт.`,
          {
            fontSize: '10px',
            color: '#00ff00'
          }
        );
        this.inventoryContainer?.add(text);
      });

      // Общее количество
      const totalText = this.scene.add.text(
        this.width - 30,
        10,
        `Всего: ${this.availableComponents.length}`,
        {
          fontSize: '10px',
          color: '#ffaa00'
        }
      ).setOrigin(1, 0);
      this.inventoryContainer.add(totalText);
    }
  }

  /**
   * Создать кнопки управления
   */
  private createControlButtons(): void {
    const buttonY = this.height - 15;

    // Кнопка сохранения
    const saveBtn = this.scene.add.text(
      this.width / 2 - 80,
      buttonY,
      'Сохранить',
      {
        fontSize: '12px',
        color: '#ffffff',
        backgroundColor: '#006600',
        padding: { x: 12, y: 6 }
      }
    ).setOrigin(0.5);
    saveBtn.setInteractive({ useHandCursor: true });
    saveBtn.on('pointerover', () => saveBtn.setStyle({ backgroundColor: '#008800' }));
    saveBtn.on('pointerout', () => saveBtn.setStyle({ backgroundColor: '#006600' }));
    saveBtn.on('pointerdown', () => this.saveConfiguration());

    // Кнопка сброса
    const resetBtn = this.scene.add.text(
      this.width / 2 + 80,
      buttonY,
      'Сбросить',
      {
        fontSize: '12px',
        color: '#ffffff',
        backgroundColor: '#cc0000',
        padding: { x: 12, y: 6 }
      }
    ).setOrigin(0.5);
    resetBtn.setInteractive({ useHandCursor: true });
    resetBtn.on('pointerover', () => resetBtn.setStyle({ backgroundColor: '#ff0000' }));
    resetBtn.on('pointerout', () => resetBtn.setStyle({ backgroundColor: '#cc0000' }));
    resetBtn.on('pointerdown', () => this.resetConfiguration());

    this.container.add(saveBtn);
    this.container.add(resetBtn);
  }

  /**
   * Обработчик клика по слоту
   */
  private onSlotClick(slot: IEquipmentSlot): void {
    if (slot.locked) {
      return;
    }

    // Если в слоте уже есть оборудование, показываем информацию
    if (slot.equipment) {
      this.showEquipmentInfo(slot.equipment);
      return;
    }

    // Открываем окно выбора компонента
    this.currentSlotForSelection = slot;
    this.showComponentSelection(slot);
  }

  /**
   * Показать информацию об установленном оборудовании
   */
  private showEquipmentInfo(equipment: IEquipment): void {
    console.log('Информация об оборудовании:', equipment);
    // Можно добавить всплывающее окно с деталями
  }

  /**
   * Показать окно выбора компонента
   */
  private showComponentSelection(slot: IEquipmentSlot): void {
    console.log('=== Поиск компонентов для слота ===');
    console.log('Тип слота:', slot.type);
    console.log('Размер слота:', slot.size);
    console.log('Всего доступных компонентов:', this.availableComponents.length);
    
    // Фильтруем компоненты по типу слота
    const compatibleComponents = this.availableComponents.filter(comp => {
      // Проверяем тип компонента
      const compType = this.getEquipmentType(comp);
      
      console.log('Компонент:', comp.name, 'Тип:', compType, 'Ожидаемый:', slot.type, 'Совпадает:', compType === slot.type);
      
      if (compType !== slot.type) {
        return false;
      }

      // Проверяем размер слота
      if ('slotSize' in comp) {
        const compSize = (comp as any).slotSize;
        const canFit = this.canFitInSlot(compSize, slot.size);
        console.log('  Размер компонента:', compSize, 'Помещается:', canFit);
        return canFit;
      }

      return true;
    });

    console.log('Найдено совместимых компонентов:', compatibleComponents.length);

    if (compatibleComponents.length === 0) {
      console.log('Нет доступных компонентов для этого слота');
      return;
    }

    // Создаем модальное окно
    this.createSelectionModal(slot, compatibleComponents);
  }

  /**
   * Создать модальное окно выбора компонента
   */
  private createSelectionModal(slot: IEquipmentSlot, components: IEquipment[]): void {
    // Удаляем предыдущее модальное окно, если есть
    if (this.selectionModal) {
      this.selectionModal.destroy();
    }

    const modalWidth = 350;
    const modalHeight = 400;
    const modalX = this.width / 2 - modalWidth / 2;
    const modalY = 50;

    this.selectionModal = this.scene.add.container(modalX, modalY);
    this.container.add(this.selectionModal);

    // Фон модального окна
    const modalBg = this.scene.add.graphics();
    modalBg.fillStyle(0x1a1a2a, 0.98);
    modalBg.fillRoundedRect(0, 0, modalWidth, modalHeight, 8);
    modalBg.lineStyle(2, 0x00aaff, 1);
    modalBg.strokeRoundedRect(0, 0, modalWidth, modalHeight, 8);
    this.selectionModal.add(modalBg);

    // Заголовок
    const title = this.scene.add.text(
      modalWidth / 2,
      15,
      `Выбор компонента для ${this.getSlotTypeName(slot.type)}`,
      {
        fontSize: '14px',
        color: '#ffffff',
        fontStyle: 'bold'
      }
    ).setOrigin(0.5);
    this.selectionModal.add(title);

    // Информация о слоте
    const slotInfo = this.scene.add.text(
      modalWidth / 2,
      40,
      `Размер слота: ${this.getSizeName(slot.size)}`,
      {
        fontSize: '11px',
        color: '#dddddd'
      }
    ).setOrigin(0.5);
    this.selectionModal.add(slotInfo);

    // Список компонентов
    let y = 65;
    components.forEach((comp, index) => {
      if (index >= 10) return; // Ограничиваем количество

      const itemBg = this.scene.add.rectangle(
        modalWidth / 2,
        y,
        modalWidth - 20,
        30,
        0x445566
      );
      itemBg.setInteractive({ useHandCursor: true });
      itemBg.on('pointerover', () => itemBg.setFillStyle(0x5566aa));
      itemBg.on('pointerout', () => itemBg.setFillStyle(0x445566));
      itemBg.on('pointerdown', () => {
        this.selectComponent(slot, comp);
      });
      this.selectionModal?.add(itemBg);

      const itemText = this.scene.add.text(
        15,
        y - 12,
        `${comp.name} | ${comp.mass}т | ${comp.cost}₡`,
        {
          fontSize: '10px',
          color: '#ffffff'
        }
      );
      this.selectionModal?.add(itemText);

      // Размер компонента
      if ('slotSize' in comp) {
        const size = this.getSizeName((comp as any).slotSize);
        const sizeText = this.scene.add.text(
          modalWidth - 15,
          y - 12,
          size,
          {
            fontSize: '9px',
            color: '#ffaa00'
          }
        ).setOrigin(1, 0);
        this.selectionModal?.add(sizeText);
      }

      y += 35;
    });

    // Кнопка закрытия
    const closeBtn = this.scene.add.text(
      modalWidth / 2,
      modalHeight - 30,
      'Отмена',
      {
        fontSize: '12px',
        color: '#ffffff',
        backgroundColor: '#cc0000',
        padding: { x: 20, y: 6 }
      }
    ).setOrigin(0.5);
    closeBtn.setInteractive({ useHandCursor: true });
    closeBtn.on('pointerover', () => closeBtn.setStyle({ backgroundColor: '#ff0000' }));
    closeBtn.on('pointerout', () => closeBtn.setStyle({ backgroundColor: '#cc0000' }));
    closeBtn.on('pointerdown', () => this.closeSelectionModal());
    this.selectionModal.add(closeBtn);
  }

  /**
   * Выбрать компонент для установки
   */
  private selectComponent(slot: IEquipmentSlot, component: IEquipment): void {
    // Проверяем совместимость размера
    if ('slotSize' in component) {
      const compSize = (component as any).slotSize;
      if (!this.canFitInSlot(compSize, slot.size)) {
        this.showError('Компонент не помещается в слот');
        return;
      }
    }

    // Проверяем массу и энергопотребление
    const validationResult = this.validateComponentInstallation(component);
    if (!validationResult.valid) {
      this.showError(validationResult.error || 'Невозможно установить компонент');
      return;
    }

    // Удаляем компонент из доступных
    const index = this.availableComponents.indexOf(component);
    if (index > -1) {
      this.availableComponents.splice(index, 1);
    }

    // Устанавливаем компонент
    slot.equipment = component;

    // Обновляем интерфейс
    this.updateSlotsDisplay();
    this.updateStatsDisplay();
    this.updateInventoryDisplay();
    this.notifyShipChanged();

    // Закрываем модальное окно
    this.closeSelectionModal();
  }

  /**
   * Закрыть модальное окно
   */
  private closeSelectionModal(): void {
    if (this.selectionModal) {
      this.selectionModal.destroy();
      this.selectionModal = undefined;
    }
    this.currentSlotForSelection = undefined;
  }

  /**
   * Проверить, может ли компонент поместиться в слот
   */
  private canFitInSlot(componentSize: SlotSize, slotSize: SlotSize): boolean {
    const sizes = [SlotSize.Small, SlotSize.Medium, SlotSize.Large, SlotSize.Capital];
    const compIndex = sizes.indexOf(componentSize);
    const slotIndex = sizes.indexOf(slotSize);
    return compIndex <= slotIndex;
  }

  /**
   * Получить тип оборудования
   */
  private getEquipmentType(equipment: IEquipment): EquipmentSlotType {
    // Проверяем тип оружия
    if ('weaponType' in equipment) {
      const weapon = equipment as IWeapon;
      if (weapon.weaponType === WeaponType.Beam) {
        return EquipmentSlotType.Weapon;
      } else if (weapon.weaponType === WeaponType.Projectile) {
        return EquipmentSlotType.ProjectileWeapon;
      }
    }
    
    if ('thrust' in equipment) return EquipmentSlotType.Engine;
    if ('capacity' in equipment) return EquipmentSlotType.Shield;
    if ('armorPoints' in equipment) return EquipmentSlotType.Armor;
    if ('range' in equipment && !('weaponType' in equipment)) return EquipmentSlotType.Sensor;
    if ('processingPower' in equipment) return EquipmentSlotType.Computer;
    if ('maxPower' in equipment) return EquipmentSlotType.PowerCore;
    
    return EquipmentSlotType.Special;
  }

  /**
   * Удалить оборудование из слота
   */
  private removeEquipment(slot: IEquipmentSlot): void {
    if (slot.equipment) {
      // Возвращаем компонент в доступные
      this.availableComponents.push(slot.equipment);
      slot.equipment = undefined;
      
      this.updateSlotsDisplay();
      this.updateStatsDisplay();
      this.updateInventoryDisplay();
      this.notifyShipChanged();
    }
  }

  /**
   * Установить оборудование в слот
   */
  public installEquipment(slotId: string, equipment: IEquipment): boolean {
    const slot = this.configuration.slots.find(s => s.id === slotId);
    if (!slot || slot.locked) {
      return false;
    }

    slot.equipment = equipment;
    this.updateSlotsDisplay();
    this.updateStatsDisplay();
    this.notifyShipChanged();
    return true;
  }

  /**
   * Подсчитать статистику
   */
  private calculateStats(): void {
    let totalMass = 0;
    let totalPower = 0;

    this.configuration.slots.forEach(slot => {
      if (slot.equipment) {
        totalMass += slot.equipment.mass;
        totalPower += slot.equipment.powerConsumption;
      }
    });

    this.configuration.totalMass = totalMass;
    this.configuration.totalPowerConsumption = totalPower;
  }

  /**
   * Получить суммарную выработку энергии от всех двигателей
   */
  private getTotalPowerGeneration(): number {
    let totalGeneration = 0;
    
    this.configuration.slots.forEach(slot => {
      if (slot.equipment && 'thrust' in slot.equipment) {
        const engine = slot.equipment as IEngine;
        totalGeneration += engine.powerGeneration || 0;
      }
    });
    
    return totalGeneration;
  }

  /**
   * Получить суммарное потребление энергии от всех компонентов
   */
  private getTotalPowerConsumption(): number {
    let totalConsumption = 0;
    
    this.configuration.slots.forEach(slot => {
      if (slot.equipment) {
        totalConsumption += slot.equipment.powerConsumption;
      }
    });
    
    return totalConsumption;
  }

  /**
   * Проверить возможность установки компонента
   */
  private validateComponentInstallation(component: IEquipment): { valid: boolean; error?: string } {
    // Рассчитываем потребление с новым компонентом
    const totalPowerWithComponent = this.getTotalPowerConsumption() + component.powerConsumption;
    
    // Получаем выработку энергии (с учетом, если устанавливаем двигатель)
    let totalPowerGeneration = this.getTotalPowerGeneration();
    if ('thrust' in component) {
      const engine = component as IEngine;
      totalPowerGeneration += engine.powerGeneration || 0;
    }

    // Проверяем энергобаланс
    if (totalPowerWithComponent > totalPowerGeneration) {
      return {
        valid: false,
        error: `Недостаточно энергии! Требуется: ${totalPowerWithComponent}, доступно: ${totalPowerGeneration}`
      };
    }

    // TODO: Можно добавить проверку массы против грузоподъемности корпуса

    return { valid: true };
  }

  /**
   * Показать сообщение об ошибке
   */
  private showError(message: string): void {
    console.log('ОШИБКА:', message);
    
    // Создаем временное сообщение
    const errorText = this.scene.add.text(
      this.width / 2,
      this.height / 2,
      message,
      {
        fontSize: '14px',
        color: '#ff0000',
        backgroundColor: '#000000',
        padding: { x: 15, y: 10 }
      }
    ).setOrigin(0.5);
    
    this.container.add(errorText);
    
    // Удаляем через 3 секунды
    this.scene.time.delayedCall(3000, () => {
      errorText.destroy();
    });
  }

  /**
   * Сохранить конфигурацию
   */
  private saveConfiguration(): void {
    this.configuration.modified = new Date();
    console.log('Конфигурация сохранена:', this.configuration);
    // Здесь можно добавить сохранение в localStorage или на сервер
  }

  /**
   * Сбросить конфигурацию
   */
  private resetConfiguration(): void {
    this.configuration.slots.forEach(slot => {
      if (slot.equipment) {
        this.availableComponents.push(slot.equipment);
        slot.equipment = undefined;
      }
    });
    this.updateSlotsDisplay();
    this.updateStatsDisplay();
    this.updateInventoryDisplay();
    this.notifyShipChanged();
  }

  /**
   * Уведомить об изменении корабля
   */
  private notifyShipChanged(): void {
    if (this.onShipChanged && this.ship) {
      this.onShipChanged(this.ship);
    }
  }

  /**
   * Получить название типа слота
   */
  private getSlotTypeName(type: EquipmentSlotType): string {
    const names: Record<EquipmentSlotType, string> = {
      [EquipmentSlotType.Weapon]: 'Оружие',
      [EquipmentSlotType.ProjectileWeapon]: 'Снаряды',
      [EquipmentSlotType.Engine]: 'Двигатель',
      [EquipmentSlotType.Shield]: 'Щит',
      [EquipmentSlotType.Armor]: 'Броня',
      [EquipmentSlotType.Sensor]: 'Сенсор',
      [EquipmentSlotType.Computer]: 'Компьютер',
      [EquipmentSlotType.PowerCore]: 'Энергоядро',
      [EquipmentSlotType.Cargo]: 'Грузовой отсек',
      [EquipmentSlotType.Special]: 'Спец.слот'
    };
    return names[type] || type;
  }

  /**
   * Получить название размера
   */
  private getSizeName(size: SlotSize): string {
    const names: Record<SlotSize, string> = {
      [SlotSize.Small]: 'М',
      [SlotSize.Medium]: 'С',
      [SlotSize.Large]: 'Б',
      [SlotSize.Capital]: 'К'
    };
    return names[size] || size;
  }

  // Геттеры и сеттеры
  setOnShipChanged(callback: (ship: Ship) => void): void {
    this.onShipChanged = callback;
  }

  setAvailableComponents(components: IEquipment[]): void {
    this.availableComponents = components;
    this.updateInventoryDisplay();
  }

  getConfiguration(): IShipConfiguration {
    return this.configuration;
  }

  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
  }

  destroy(): void {
    this.container.destroy();
  }
}
