import Phaser from 'phaser';
import { 
  IEquipment, 
  IWeapon,
  IBeamWeapon,
  IProjectileWeapon,
  IEngine, 
  IShield, 
  IArmor,
  ISensor,
  IComputer,
  IPowerCore,
  ICargoHold,
  EquipmentSlotType,
  EquipmentRarity,
  WeaponType,
  EngineType,
  SlotSize
} from '../entities/interfaces/Equipment';

/**
 * Панель конструктора компонентов
 */
export class ComponentBuilderPanel {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private background: Phaser.GameObjects.Graphics;
  private x: number;
  private y: number;
  private width: number = 400;
  private height: number = 600;
  
  private currentType: EquipmentSlotType = EquipmentSlotType.Weapon;
  private components: IEquipment[] = [];
  private selectedComponent?: IEquipment;
  
  private componentList?: Phaser.GameObjects.Container;
  private detailsPanel?: Phaser.GameObjects.Container;
  private detailsScrollContainer?: Phaser.GameObjects.Container;
  private detailsScrollY: number = 0;
  private detailsMaxScroll: number = 0;
  
  // Callbacks
  private onComponentCreated?: (component: IEquipment) => void;
  private onComponentSelected?: (component: IEquipment) => void;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.container = scene.add.container(x, y);
    this.background = scene.add.graphics();
    this.container.add(this.background);
    
    this.createUI();
  }

  /**
   * Создать UI
   */
  private createUI(): void {
    // Фон панели
    this.background.fillStyle(0x2a3a2a, 0.95);
    this.background.fillRoundedRect(0, 0, this.width, this.height, 8);
    this.background.lineStyle(2, 0x00ff00, 1);
    this.background.strokeRoundedRect(0, 0, this.width, this.height, 8);

    // Заголовок
    const title = this.scene.add.text(this.width / 2, 20, 'КОНСТРУКТОР КОМПОНЕНТОВ', {
      fontSize: '18px',
      color: '#00ff00',
      fontStyle: 'bold'
    }).setOrigin(0.5);
    this.container.add(title);

    // Вкладки типов оборудования
    this.createTypeTabs();

    // Кнопка создания нового компонента
    this.createNewComponentButton();

    // Список компонентов
    this.createComponentList();

    // Панель деталей
    this.createDetailsPanel();
  }

  /**
   * Создать вкладки типов оборудования
   */
  private createTypeTabs(): void {
    const types = [
      { type: EquipmentSlotType.Weapon, label: 'Лучевое' },
      { type: EquipmentSlotType.ProjectileWeapon, label: 'Снаряды' },
      { type: EquipmentSlotType.Engine, label: 'Двигатели' },
      { type: EquipmentSlotType.Shield, label: 'Щиты' },
      { type: EquipmentSlotType.Armor, label: 'Броня' }
    ];

    const tabWidth = this.width / types.length;
    const tabs: Phaser.GameObjects.Text[] = [];
    
    types.forEach((item, index) => {
      const isActive = this.currentType === item.type;
      const tab = this.scene.add.text(
        tabWidth * index + tabWidth / 2,
        50,
        item.label,
        {
          fontSize: '11px',
          color: '#ffffff',
          backgroundColor: isActive ? '#006600' : '#556655',
          padding: { x: 8, y: 5 }
        }
      ).setOrigin(0.5);

      tab.setInteractive({ useHandCursor: true });
      tab.on('pointerdown', () => {
        this.currentType = item.type;
        // Обновляем все вкладки
        tabs.forEach((t, i) => {
          const active = types[i].type === this.currentType;
          t.setStyle({
            color: '#ffffff',
            backgroundColor: active ? '#006600' : '#556655'
          });
        });
        this.refreshUI();
      });

      tabs.push(tab);
      this.container.add(tab);
    });
  }

  /**
   * Создать кнопку нового компонента
   */
  private createNewComponentButton(): void {
    const button = this.scene.add.text(
      this.width / 2,
      90,
      '+ Создать новый',
      {
        fontSize: '14px',
        color: '#ffffff',
        backgroundColor: '#00aa00',
        padding: { x: 15, y: 8 }
      }
    ).setOrigin(0.5);

    button.setInteractive({ useHandCursor: true });
    button.on('pointerover', () => button.setStyle({ backgroundColor: '#00dd00' }));
    button.on('pointerout', () => button.setStyle({ backgroundColor: '#00aa00' }));
    button.on('pointerdown', () => this.createNewComponent());

    this.container.add(button);
  }

  /**
   * Создать список компонентов
   */
  private createComponentList(): void {
    this.componentList = this.scene.add.container(10, 120);
    this.container.add(this.componentList);
    
    // Фон списка
    const listBg = this.scene.add.graphics();
    listBg.fillStyle(0x1a2a1a, 1);
    listBg.fillRect(0, 0, this.width - 20, 200);
    this.componentList.add(listBg);
  }

  /**
   * Создать панель деталей
   */
  private createDetailsPanel(): void {
    this.detailsPanel = this.scene.add.container(10, 330);
    this.container.add(this.detailsPanel);

    const panelBg = this.scene.add.graphics();
    panelBg.fillStyle(0x1a2a1a, 1);
    panelBg.fillRect(0, 0, this.width - 20, 250);
    panelBg.lineStyle(1, 0x00ff00, 0.3);
    panelBg.strokeRect(0, 0, this.width - 20, 250);
    this.detailsPanel.add(panelBg);

    const detailsTitle = this.scene.add.text(
      (this.width - 20) / 2,
      10,
      'Параметры компонента (- / +)',
      {
        fontSize: '12px',
        color: '#ffffff',
        fontStyle: 'bold'
      }
    ).setOrigin(0.5);
    this.detailsPanel.add(detailsTitle);

    // Создаем контейнер для прокручиваемого содержимого
    this.detailsScrollContainer = this.scene.add.container(0, 35);
    this.detailsPanel.add(this.detailsScrollContainer);

    // Создаем маску для области прокрутки
    const maskShape = this.scene.make.graphics({});
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(this.x + 10, this.y + 365, this.width - 20, 215);
    const mask = maskShape.createGeometryMask();
    this.detailsScrollContainer.setMask(mask);

    // Добавляем обработчик колесика мыши для прокрутки
    this.scene.input.on('wheel', (pointer: Phaser.Input.Pointer, _gameObjects: any[], _deltaX: number, deltaY: number) => {
      if (this.detailsPanel && this.detailsScrollContainer) {
        // Проверяем, находится ли курсор над панелью деталей
        const localX = pointer.x - this.x - 10;
        const localY = pointer.y - this.y - 330;
        
        if (localX >= 0 && localX <= this.width - 20 && localY >= 0 && localY <= 250) {
          this.detailsScrollY -= deltaY * 0.3;
          this.detailsScrollY = Phaser.Math.Clamp(this.detailsScrollY, -this.detailsMaxScroll, 0);
          this.detailsScrollContainer.y = 35 + this.detailsScrollY;
        }
      }
    });
  }

  /**
   * Создать новый компонент
   */
  private createNewComponent(): void {
    let newComponent: IEquipment;
    const id = `${this.currentType}_${Date.now()}`;

    switch (this.currentType) {
      case EquipmentSlotType.Weapon:
        newComponent = this.createDefaultWeapon(id);
        break;
      case EquipmentSlotType.ProjectileWeapon:
        newComponent = this.createProjectileWeapon(id);
        break;
      case EquipmentSlotType.Engine:
        newComponent = this.createDefaultEngine(id);
        break;
      case EquipmentSlotType.Shield:
        newComponent = this.createDefaultShield(id);
        break;
      case EquipmentSlotType.Armor:
        newComponent = this.createDefaultArmor(id);
        break;
      default:
        return;
    }

    this.components.push(newComponent);
    this.selectedComponent = newComponent;
    this.refreshUI();
    
    if (this.onComponentCreated) {
      this.onComponentCreated(newComponent);
    }
  }

  /**
   * Создать оружие по умолчанию
   */
  private createDefaultWeapon(id: string): IWeapon {
    // По умолчанию создаем лучевое оружие
    return {
      id,
      name: 'Новое лучевое оружие',
      description: 'Базовое лазерное орудие',
      mass: 10,
      powerConsumption: 0, // Будет вычислено
      cost: 1000,
      rarity: EquipmentRarity.Common,
      weaponType: WeaponType.Beam,
      damage: 25,
      range: 500,
      fireRate: 2,
      accuracy: 0.8,
      energyConsumption: 50, // Будет пересчитано
      slotSize: SlotSize.Small
    };
  }

  /**
   * Создать оружие со снарядами
   */
  private createProjectileWeapon(id: string): IProjectileWeapon {
    const projectileDamage = 50;
    const projectileRange = 600;
    const stats = this.calculateProjectileStats(projectileDamage, projectileRange);
    
    return {
      id,
      name: 'Новое пушечное оружие',
      description: 'Оружие, стреляющее снарядами',
      mass: 15,
      powerConsumption: 0, // Будет вычислено
      cost: 1500,
      rarity: EquipmentRarity.Common,
      weaponType: WeaponType.Projectile,
      projectile: {
        damage: projectileDamage,
        range: projectileRange,
        mass: stats.mass,
        size: stats.size
      },
      ammoCapacity: 100,
      fireRate: 1.5,
      accuracy: 0.9,
      energyPerShot: this.calculateProjectileEnergyPerShot(stats.mass, projectileRange),
      slotSize: SlotSize.Medium
    };
  }

  /**
   * Создать двигатель по умолчанию
   */
  private createDefaultEngine(id: string): IEngine {
    const thrust = 1000;
    const maxSpeed = 200;
    const maneuverability = 0.7;
    const powerGeneration = 50;
    
    return {
      id,
      name: 'Новый двигатель',
      description: 'Базовый ионный двигатель',
      mass: 20,
      powerConsumption: 30,
      cost: 1500,
      rarity: EquipmentRarity.Common,
      thrust,
      maxSpeed,
      maneuverability,
      fuelConsumption: this.calculateFuelConsumption(thrust, maxSpeed, maneuverability, powerGeneration),
      powerGeneration,
      slotSize: SlotSize.Medium,
      engineType: EngineType.Ion
    };
  }

  /**
   * Создать щит по умолчанию
   */
  private createDefaultShield(id: string): IShield {
    return {
      id,
      name: 'Новый щит',
      description: 'Базовый энергощит (защита от лучевого оружия)',
      mass: 15,
      powerConsumption: 40,
      cost: 2000,
      rarity: EquipmentRarity.Common,
      capacity: 500,
      rechargeRate: 20,
      rechargeDelay: 3,
      beamResistance: 0.7, // Снижает урон от лучевого оружия на 70%
      slotSize: SlotSize.Medium
    };
  }

  /**
   * Создать броню по умолчанию
   */
  private createDefaultArmor(id: string): IArmor {
    return {
      id,
      name: 'Новая броня',
      description: 'Базовая композитная броня (защита от всех типов урона)',
      mass: 50,
      powerConsumption: 0,
      cost: 1200,
      rarity: EquipmentRarity.Common,
      armorPoints: 300,
      beamResistance: 0.5, // Снижает урон от лучевого оружия на 50%
      projectileResistance: 0.6, // Снижает урон от снарядов на 60%
      durability: 1000,
      repairRate: 2
    };
  }

  /**
   * Обновить UI
   */
  private refreshUI(): void {
    this.updateComponentList();
    this.updateDetailsPanel();
  }

  /**
   * Обновить список компонентов
   */
  private updateComponentList(): void {
    if (!this.componentList) return;

    // Очищаем список (кроме фона)
    while (this.componentList.length > 1) {
      const item = this.componentList.list[1];
      if (item) {
        this.componentList.remove(item, true);
      }
    }

    // Фильтруем компоненты по типу
    let filtered: IEquipment[] = [];
    if (this.currentType === EquipmentSlotType.ProjectileWeapon) {
      // Показываем только оружие со снарядами
      filtered = this.components.filter(c => 
        'weaponType' in c && (c as IWeapon).weaponType === WeaponType.Projectile
      );
    } else if (this.currentType === EquipmentSlotType.Weapon) {
      // Показываем только лучевое оружие
      filtered = this.components.filter(c => 
        'weaponType' in c && (c as IWeapon).weaponType === WeaponType.Beam
      );
    } else {
      filtered = this.components.filter(c => this.getComponentType(c) === this.currentType);
    }

    filtered.forEach((component, index) => {
      const y = 10 + index * 35;
      const isSelected = component === this.selectedComponent;

      const itemBg = this.scene.add.rectangle(
        (this.width - 20) / 2,
        y + 15,
        this.width - 40,
        30,
        isSelected ? 0x006600 : 0x445544
      );
      itemBg.setInteractive({ useHandCursor: true });
      itemBg.on('pointerdown', () => {
        this.selectedComponent = component;
        this.refreshUI();
        if (this.onComponentSelected) {
          this.onComponentSelected(component);
        }
      });

      const itemText = this.scene.add.text(
        10,
        y,
        `${component.name} (${this.getRarityColor(component.rarity)})`,
        {
          fontSize: '12px',
          color: isSelected ? '#ffffff' : '#ddffdd'
        }
      );

      this.componentList?.add(itemBg);
      this.componentList?.add(itemText);
    });
  }

  /**
   * Обновить панель деталей
   */
  private updateDetailsPanel(): void {
    if (!this.detailsScrollContainer || !this.selectedComponent) return;

    // Очищаем контейнер прокрутки
    this.detailsScrollContainer.removeAll(true);

    const comp = this.selectedComponent;
    let y = 5;

    // Пересчитываем вычисляемые параметры
    this.recalculateCost();

    // Вычисляемые параметры (только отображение)
    this.addReadOnlyParameter('💰 Стоимость', comp.cost.toFixed(0), y, '#ffaa00');
    y += 22;

    this.addReadOnlyParameter('⚖️ Масса', `${comp.mass.toFixed(1)}т`, y, '#aaaaff');
    y += 22;

    // Для двигателя показываем расход топлива вместо энергопотребления
    if ('thrust' in comp) {
      const engine = comp as IEngine;
      this.addReadOnlyParameter('⛽ Расход топлива', engine.fuelConsumption.toFixed(1), y, '#ffaa00');
    } else {
      this.addReadOnlyParameter('⚡ Энергия', comp.powerConsumption.toString(), y, '#ffff00');
    }
    y += 22;

    // Размер слота (если есть)
    if ('slotSize' in comp) {
      const slotSize = (comp as any).slotSize as SlotSize;
      const sizeNames: Record<SlotSize, string> = {
        [SlotSize.Small]: 'Малый',
        [SlotSize.Medium]: 'Средний',
        [SlotSize.Large]: 'Большой',
        [SlotSize.Capital]: 'Капитальный'
      };
      this.addReadOnlyParameter('📦 Размер слота', sizeNames[slotSize] || slotSize, y, '#ff8800');
      y += 22;
    }

    y += 8;

    // Разделитель
    const separator = this.scene.add.text(10, y, '─────── Основные параметры ───────', {
      fontSize: '10px',
      color: '#00ff00'
    });
    this.detailsScrollContainer?.add(separator);
    y += 25;

    // Добавляем специфичные параметры в зависимости от типа
    if ('weaponType' in comp) {
      this.addWeaponParameters(comp as IWeapon, y);
    } else if ('thrust' in comp) {
      this.addEngineParameters(comp as IEngine, y);
    } else if ('capacity' in comp) {
      this.addShieldParameters(comp as IShield, y);
    } else if ('armorPoints' in comp) {
      this.addArmorParameters(comp as IArmor, y);
    }
  }

  /**
   * Добавить параметр только для чтения
   */
  private addReadOnlyParameter(label: string, value: string, y: number, color: string = '#cccccc'): void {
    if (!this.detailsScrollContainer) return;

    const text = this.scene.add.text(10, y, `${label}: ${value}`, {
      fontSize: '11px',
      color: color,
      fontStyle: 'bold'
    });
    this.detailsScrollContainer.add(text);
  }

  /**
   * Добавить редактируемый параметр
   */
  private addEditableParameter(
    label: string, 
    value: number, 
    y: number, 
    onChange: (value: number) => void,
    step: number = 1,
    min: number = 0
  ): void {
    if (!this.detailsScrollContainer) return;

    // Текст параметра
    const text = this.scene.add.text(10, y, `${label}: ${value.toFixed(1)}`, {
      fontSize: '11px',
      color: '#cccccc'
    });
    this.detailsScrollContainer.add(text);

    // Кнопка "-"
    const minusBtn = this.scene.add.text(200, y, '-', {
      fontSize: '14px',
      color: '#ffffff',
      backgroundColor: '#cc0000',
      padding: { x: 6, y: 2 }
    });
    minusBtn.setInteractive({ useHandCursor: true });
    minusBtn.on('pointerover', () => minusBtn.setStyle({ backgroundColor: '#ff0000' }));
    minusBtn.on('pointerout', () => minusBtn.setStyle({ backgroundColor: '#cc0000' }));
    minusBtn.on('pointerdown', () => {
      const newValue = Math.max(min, value - step);
      onChange(newValue);
    });
    this.detailsScrollContainer.add(minusBtn);

    // Кнопка "+"
    const plusBtn = this.scene.add.text(220, y, '+', {
      fontSize: '14px',
      color: '#ffffff',
      backgroundColor: '#006600',
      padding: { x: 6, y: 2 }
    });
    plusBtn.setInteractive({ useHandCursor: true });
    plusBtn.on('pointerover', () => plusBtn.setStyle({ backgroundColor: '#008800' }));
    plusBtn.on('pointerout', () => plusBtn.setStyle({ backgroundColor: '#006600' }));
    plusBtn.on('pointerdown', () => {
      const newValue = value + step;
      onChange(newValue);
    });
    this.detailsScrollContainer.add(plusBtn);

    // Обновляем максимальный скролл
    this.detailsMaxScroll = Math.max(0, y + 25 - 215);
  }

  /**
   * Добавить параметры оружия
   */
  private addWeaponParameters(weapon: IWeapon, startY: number): void {
    let y = startY;
    
    if (weapon.weaponType === WeaponType.Beam) {
      // Лучевое оружие
      const beamWeapon = weapon as IBeamWeapon;
      
      this.addEditableParameter('Урон', beamWeapon.damage, y, (value) => {
        beamWeapon.damage = value;
        this.updateDetailsPanel();
      }, 5);
      y += 25;

      this.addEditableParameter('Дальность', beamWeapon.range, y, (value) => {
        beamWeapon.range = value;
        this.updateDetailsPanel();
      }, 50);
      y += 25;

      this.addEditableParameter('Скорострельн.', beamWeapon.fireRate, y, (value) => {
        beamWeapon.fireRate = value;
        this.updateDetailsPanel();
      }, 0.1, 0.1);
      y += 25;

      this.addEditableParameter('Точность', beamWeapon.accuracy * 100, y, (value) => {
        beamWeapon.accuracy = value / 100;
        this.updateDetailsPanel();
      }, 5, 0);
      y += 25;

      // Потребление энергии (только для чтения)
      this.addReadOnlyParameter('⚡ Потребление энергии', beamWeapon.energyConsumption.toFixed(1), y, '#ffff00');
      
    } else {
      // Оружие со снарядами
      const projectileWeapon = weapon as IProjectileWeapon;
      
      // Характеристики снаряда
      this.addEditableParameter('Урон снаряда', projectileWeapon.projectile.damage, y, (value) => {
        projectileWeapon.projectile.damage = value;
        this.updateDetailsPanel();
      }, 5);
      y += 25;

      this.addEditableParameter('Дальность снаряда', projectileWeapon.projectile.range, y, (value) => {
        projectileWeapon.projectile.range = value;
        this.updateDetailsPanel();
      }, 50);
      y += 25;

      // Характеристики оружия
      this.addEditableParameter('Запас зарядов', projectileWeapon.ammoCapacity, y, (value) => {
        projectileWeapon.ammoCapacity = value;
        this.updateDetailsPanel();
      }, 10, 1);
      y += 25;

      this.addEditableParameter('Скорострельн.', projectileWeapon.fireRate, y, (value) => {
        projectileWeapon.fireRate = value;
        this.updateDetailsPanel();
      }, 0.1, 0.1);
      y += 25;

      this.addEditableParameter('Точность', projectileWeapon.accuracy * 100, y, (value) => {
        projectileWeapon.accuracy = value / 100;
        this.updateDetailsPanel();
      }, 5, 0);
      y += 25;

      // Вычисляемые характеристики (только для чтения)
      this.addReadOnlyParameter('⚖️ Масса снаряда', projectileWeapon.projectile.mass.toFixed(2) + 'т', y, '#aaaaff');
      y += 22;

      this.addReadOnlyParameter('📏 Размер снаряда', projectileWeapon.projectile.size.toFixed(2) + 'м³', y, '#aaaaff');
      y += 22;

      this.addReadOnlyParameter('⚡ Энергия/выстрел', projectileWeapon.energyPerShot.toFixed(1), y, '#ffff00');
    }
  }

  /**
   * Добавить параметры двигателя
   */
  private addEngineParameters(engine: IEngine, startY: number): void {
    let y = startY;
    
    // Основные характеристики (редактируемые)
    this.addEditableParameter('Тяга', engine.thrust, y, (value) => {
      engine.thrust = value;
      this.updateDetailsPanel();
    }, 100);
    y += 25;

    this.addEditableParameter('Макс.скорость', engine.maxSpeed, y, (value) => {
      engine.maxSpeed = value;
      this.updateDetailsPanel();
    }, 10);
    y += 25;

    this.addEditableParameter('Маневренность', engine.maneuverability * 100, y, (value) => {
      engine.maneuverability = value / 100;
      this.updateDetailsPanel();
    }, 5, 0);
    y += 25;

    this.addEditableParameter('Вырабатываемая энергия', engine.powerGeneration, y, (value) => {
      engine.powerGeneration = value;
      this.updateDetailsPanel();
    }, 10, 0);
  }

  /**
   * Добавить параметры щита
   */
  private addShieldParameters(shield: IShield, startY: number): void {
    let y = startY;
    
    // Основные характеристики (редактируемые)
    this.addEditableParameter('Емкость', shield.capacity, y, (value) => {
      shield.capacity = value;
      this.updateDetailsPanel();
    }, 50);
    y += 25;

    this.addEditableParameter('Перезарядка', shield.rechargeRate, y, (value) => {
      shield.rechargeRate = value;
      this.updateDetailsPanel();
    }, 2);
    y += 25;

    this.addEditableParameter('Задержка', shield.rechargeDelay, y, (value) => {
      shield.rechargeDelay = value;
      this.updateDetailsPanel();
    }, 0.5, 0.5);
    y += 25;

    this.addEditableParameter('Защита от лучевого', shield.beamResistance * 100, y, (value) => {
      shield.beamResistance = value / 100;
      this.updateDetailsPanel();
    }, 5, 0);
  }

  /**
   * Добавить параметры брони
   */
  private addArmorParameters(armor: IArmor, startY: number): void {
    let y = startY;
    
    // Основные характеристики (редактируемые)
    this.addEditableParameter('Очки брони', armor.armorPoints, y, (value) => {
      armor.armorPoints = value;
      this.updateDetailsPanel();
    }, 25);
    y += 25;

    this.addEditableParameter('Прочность', armor.durability, y, (value) => {
      armor.durability = value;
      this.updateDetailsPanel();
    }, 50);
    y += 25;

    this.addEditableParameter('Скор.ремонта', armor.repairRate, y, (value) => {
      armor.repairRate = value;
      this.updateDetailsPanel();
    }, 0.5, 0);
    y += 25;

    this.addEditableParameter('Защита от лучевого', armor.beamResistance * 100, y, (value) => {
      armor.beamResistance = value / 100;
      this.updateDetailsPanel();
    }, 5, 0);
    y += 25;

    this.addEditableParameter('Защита от снарядов', armor.projectileResistance * 100, y, (value) => {
      armor.projectileResistance = value / 100;
      this.updateDetailsPanel();
    }, 5, 0);
  }

  /**
   * Рассчитать расход топлива для двигателя
   * Расход зависит от тяги, скорости, маневренности и вырабатываемой энергии
   */
  private calculateFuelConsumption(thrust: number, maxSpeed: number, maneuverability: number, powerGeneration: number): number {
    // Базовый расход = (тяга / 100) + (скорость / 20) + (маневренность * 10)
    const baseConsumption = (thrust / 100) + (maxSpeed / 20) + (maneuverability * 10);
    
    // Вырабатываемая энергия увеличивает расход (генератору нужно топливо)
    const powerFactor = powerGeneration / 10;
    
    return Math.max(0.1, baseConsumption + powerFactor);
  }

  /**
   * Рассчитать потребление энергии для лучевого оружия
   * Зависит от урона, дальности и скорострельности
   */
  private calculateBeamEnergyConsumption(damage: number, range: number, fireRate: number): number {
    // Формула: (урон * 2) + (дальность / 10) + (скорострельность * 10)
    return Math.max(1, (damage * 2) + (range / 10) + (fireRate * 10));
  }

  /**
   * Рассчитать характеристики снаряда
   */
  private calculateProjectileStats(damage: number, range: number): { mass: number; size: number } {
    // Масса зависит от урона и дальности
    const mass = Math.max(0.1, (damage * 0.1) + (range * 0.002));
    
    // Размер зависит от массы
    const size = Math.max(0.1, mass * 2);
    
    return { mass, size };
  }

  /**
   * Рассчитать энергию на выстрел для оружия со снарядами
   * Зависит от массы снаряда и дальности
   */
  private calculateProjectileEnergyPerShot(projectileMass: number, range: number): number {
    // Формула: (масса * 50) + (дальность / 5)
    return Math.max(1, (projectileMass * 50) + (range / 5));
  }

  /**
   * Пересчитать стоимость и массу компонента
   */
  private recalculateCost(): void {
    if (!this.selectedComponent) return;

    const comp = this.selectedComponent;
    let baseCost = 500;
    let baseMass = 5;
    let basePower = 10;

    // Расчет в зависимости от типа
    if ('weaponType' in comp) {
      const weapon = comp as IWeapon;
      
      if (weapon.weaponType === WeaponType.Beam) {
        // Лучевое оружие
        const beamWeapon = weapon as IBeamWeapon;
        
        // Пересчитываем потребление энергии
        beamWeapon.energyConsumption = this.calculateBeamEnergyConsumption(
          beamWeapon.damage,
          beamWeapon.range,
          beamWeapon.fireRate
        );
        
        // Стоимость
        baseCost = beamWeapon.damage * 40 + 
                   beamWeapon.fireRate * 300 + 
                   beamWeapon.range * 2 + 
                   beamWeapon.accuracy * 1000 +
                   beamWeapon.energyConsumption * 10;
        
        // Масса
        baseMass = beamWeapon.damage * 0.4 + 
                   beamWeapon.range * 0.01;
        
        // Энергопотребление (записывается в powerConsumption для совместимости)
        basePower = beamWeapon.energyConsumption;
        
      } else {
        // Оружие со снарядами
        const projectileWeapon = weapon as IProjectileWeapon;
        
        // Пересчитываем характеристики снаряда
        const stats = this.calculateProjectileStats(
          projectileWeapon.projectile.damage,
          projectileWeapon.projectile.range
        );
        projectileWeapon.projectile.mass = stats.mass;
        projectileWeapon.projectile.size = stats.size;
        
        // Пересчитываем энергию на выстрел
        projectileWeapon.energyPerShot = this.calculateProjectileEnergyPerShot(
          projectileWeapon.projectile.mass,
          projectileWeapon.projectile.range
        );
        
        // Стоимость
        baseCost = projectileWeapon.projectile.damage * 50 + 
                   projectileWeapon.fireRate * 300 + 
                   projectileWeapon.projectile.range * 2 + 
                   projectileWeapon.accuracy * 1000 +
                   projectileWeapon.ammoCapacity * 10;
        
        // Масса (масса установки + часть массы снарядов)
        // Не учитываем всю массу боекомплекта, только конструкцию оружия и часть снарядов
        baseMass = projectileWeapon.fireRate * 3 + 
                   projectileWeapon.projectile.damage * 0.3 +
                   projectileWeapon.projectile.range * 0.02;
        
        // Энергопотребление
        basePower = projectileWeapon.energyPerShot;
      }
      
    } else if ('thrust' in comp) {
      const engine = comp as IEngine;
      
      // Пересчитываем расход топлива на основе параметров
      engine.fuelConsumption = this.calculateFuelConsumption(
        engine.thrust, 
        engine.maxSpeed, 
        engine.maneuverability, 
        engine.powerGeneration
      );
      
      // Стоимость: учитываем тягу, скорость, маневренность, расход топлива и выработку энергии
      baseCost = engine.thrust * 1.5 + 
                 engine.maxSpeed * 7 + 
                 engine.maneuverability * 2000 - 
                 engine.fuelConsumption * 50 +
                 engine.powerGeneration * 20;
      
      // Масса: зависит от тяги и максимальной скорости
      baseMass = engine.thrust * 0.02 + 
                 engine.maxSpeed * 0.1;
      
      // Энергопотребление: зависит от тяги, минус выработка энергии
      basePower = Math.max(0, engine.thrust * 0.03 + engine.fuelConsumption * 2 - engine.powerGeneration);
      
    } else if ('capacity' in comp) {
      const shield = comp as IShield;
      // Стоимость: учитываем емкость, скорость перезарядки, задержку и защиту от лучевого
      baseCost = shield.capacity * 4 + 
                 shield.rechargeRate * 100 - 
                 shield.rechargeDelay * 50 +
                 shield.beamResistance * 1000;
      
      // Масса: зависит от емкости и скорости перезарядки
      baseMass = shield.capacity * 0.03 + 
                 shield.rechargeRate * 0.5;
      
      // Энергопотребление: зависит от емкости и скорости перезарядки
      basePower = shield.capacity * 0.1 + shield.rechargeRate * 3;
      
    } else if ('armorPoints' in comp) {
      const armor = comp as IArmor;
      // Стоимость: учитываем очки брони, прочность, скорость ремонта и оба типа защиты
      baseCost = armor.armorPoints * 4 + 
                 armor.durability * 1.2 + 
                 armor.repairRate * 200 +
                 armor.beamResistance * 800 +
                 armor.projectileResistance * 800;
      
      // Масса: зависит от очков брони и прочности
      baseMass = armor.armorPoints * 0.15 + 
                 armor.durability * 0.05;
      
      // Энергопотребление: только для активного ремонта
      basePower = armor.repairRate * 5;
    }

    // Применяем рассчитанные значения
    comp.cost = Math.max(100, Math.round(baseCost));
    comp.mass = Math.max(1, Math.round(baseMass * 10) / 10);
    comp.powerConsumption = Math.max(0, Math.round(basePower));

    // Автоматически определяем размер слота на основе массы
    if ('slotSize' in comp) {
      if (comp.mass < 15) {
        (comp as any).slotSize = SlotSize.Small;
      } else if (comp.mass < 40) {
        (comp as any).slotSize = SlotSize.Medium;
      } else if (comp.mass < 80) {
        (comp as any).slotSize = SlotSize.Large;
      } else {
        (comp as any).slotSize = SlotSize.Capital;
      }
    }
  }

  /**
   * Получить тип компонента
   */
  private getComponentType(component: IEquipment): EquipmentSlotType {
    // Проверяем тип оружия
    if ('weaponType' in component) {
      const weapon = component as IWeapon;
      if (weapon.weaponType === WeaponType.Beam) {
        return EquipmentSlotType.Weapon;
      } else if (weapon.weaponType === WeaponType.Projectile) {
        return EquipmentSlotType.ProjectileWeapon;
      }
    }
    
    if ('thrust' in component) return EquipmentSlotType.Engine;
    if ('capacity' in component) return EquipmentSlotType.Shield;
    if ('armorPoints' in component) return EquipmentSlotType.Armor;
    return EquipmentSlotType.Special;
  }

  /**
   * Получить цвет редкости
   */
  private getRarityColor(rarity: EquipmentRarity): string {
    switch (rarity) {
      case EquipmentRarity.Common: return 'серый';
      case EquipmentRarity.Uncommon: return 'зеленый';
      case EquipmentRarity.Rare: return 'синий';
      case EquipmentRarity.Epic: return 'фиолетовый';
      case EquipmentRarity.Legendary: return 'оранжевый';
      default: return 'белый';
    }
  }

  // Геттеры и сеттеры для callbacks
  setOnComponentCreated(callback: (component: IEquipment) => void): void {
    this.onComponentCreated = callback;
  }

  setOnComponentSelected(callback: (component: IEquipment) => void): void {
    this.onComponentSelected = callback;
  }

  getComponents(): IEquipment[] {
    return this.components;
  }

  getSelectedComponent(): IEquipment | undefined {
    return this.selectedComponent;
  }

  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
  }

  destroy(): void {
    this.container.destroy();
  }
}
