import { 
  IPowerSource, 
  IEngine, 
  ICargo, 
  IEquipment, 
  ICargoItem 
} from './interfaces/ShipComponents';
import type { ShipDesign } from '../domain/shipDesign';
import { createShipState, snapshotShipState, type ShipPosition, type ShipState } from '../domain/shipState';
import { cargoTotals, loadCargo, unloadCargo, type CargoLimits, type CargoResult } from '../domain/cargo';

/**
 * Основной класс космического корабля
 */
export class Ship {
  protected readonly state = createShipState();
  getState(): ShipState { return snapshotShipState(this.state); }
  getDesign(): ShipDesign | undefined { return undefined; }
  getInstalledModuleNames(): string[] { return this.equipment.map(item => item.name); }
  id: string;
  name: string;
  
  // Компоненты корабля
  private powerSourceView!: IPowerSource;
  get powerSource(): IPowerSource { return this.powerSourceView; }
  set powerSource(source: IPowerSource) {
    const ship = this;
    this.state.energy = source.currentEnergy;
    this.powerSourceView = { ...source,
      get currentEnergy() { return ship.state.energy; },
      set currentEnergy(value: number) { ship.state.energy = value; }
    };
  }
  engine: IEngine;
  cargoHold: ICargo;
  
  // Установленное оборудование
  equipment: IEquipment[] = [];
  
  // Груз
  get cargo(): ICargoItem[] {
    return this.state.cargo.map(({ mass, ...item }) => ({ ...item, weight: mass }));
  }
  private cargoMessage = '';
  getCargoMessage(): string { return this.cargoMessage; }
  getCargoLimits(): CargoLimits {
    return { mass: Math.max(0, this.cargoHold.maxWeight - this.equipment.reduce((sum, item) => sum + item.weight, 0)),
      volume: this.cargoHold.capacity };
  }
  
  // Позиция и состояние
  get position(): ShipPosition { return this.state.position; }
  set position(value: ShipPosition) { this.state.position = { ...value }; }
  get velocity(): ShipPosition { return this.state.velocity; }
  set velocity(value: ShipPosition) { this.state.velocity = { ...value }; }
  get isMoving(): boolean { return this.state.isMoving; }
  set isMoving(value: boolean) { this.state.isMoving = value; }
  
  constructor(
    id: string,
    name: string,
    powerSource: IPowerSource,
    engine: IEngine,
    cargoHold: ICargo
  ) {
    this.id = id;
    this.name = name;
    this.powerSource = powerSource;
    this.engine = engine;
    const ship = this;
    this.cargoHold = { ...cargoHold,
      get usedSpace() { return cargoTotals(ship.state.cargo).volume; },
      get currentWeight() { return cargoTotals(ship.state.cargo).mass + ship.equipment.reduce((sum, item) => sum + item.weight, 0); }
    };
    this.position = { x: 0, y: 0 };
    this.velocity = { x: 0, y: 0 };
  }
  
  /**
   * Получить общую стоимость корабля
   */
  getTotalCost(): number {
    let total = this.powerSource.cost + this.engine.cost + this.cargoHold.cost;
    
    // Добавляем стоимость оборудования
    this.equipment.forEach(eq => {
      total += eq.cost;
    });
    
    return total;
  }
  
  /**
   * Получить общий вес корабля
   */
  getTotalWeight(): number {
    let total = this.powerSource.weight + this.engine.weight + this.cargoHold.weight;
    
    // Добавляем вес оборудования
    this.equipment.forEach(eq => {
      total += eq.weight;
    });
    
    // Добавляем вес груза
    this.cargo.forEach(item => {
      total += item.weight;
    });
    
    return total;
  }
  
  /**
   * Получить максимальную дальность полета
   */
  getMaxRange(): number {
    const energyForFlight = this.powerSource.currentEnergy;
    const consumption = this.engine.energyConsumption;
    return (energyForFlight / consumption) * this.engine.maxSpeed;
  }
  
  /**
   * Получить текущую максимальную скорость с учетом веса
   */
  getCurrentMaxSpeed(): number {
    const baseSpeed = this.engine.maxSpeed;
    const totalWeight = this.getTotalWeight();
    const thrust = this.engine.thrust;
    
    // Скорость уменьшается с увеличением веса
    return baseSpeed * (thrust / (thrust + totalWeight * 0.1));
  }
  
  /**
   * Установить оборудование
   */
  installEquipment(equipment: IEquipment): boolean {
    // Проверяем, есть ли место в отсеке
    const usedSlots = this.equipment.reduce((sum, eq) => sum + eq.slotsRequired, 0);
    const availableSlots = this.getAvailableCargoSlots();
    
    if (usedSlots + equipment.slotsRequired > availableSlots) {
      console.log('Недостаточно слотов для установки оборудования');
      return false;
    }
    
    // Проверяем вес
    if (this.cargoHold.currentWeight + equipment.weight > this.cargoHold.maxWeight) {
      console.log('Превышен максимальный вес груза');
      return false;
    }
    
    this.equipment.push(equipment);
    this.refreshVelocityForMass();
    return true;
  }
  
  /**
   * Удалить оборудование
   */
  uninstallEquipment(equipmentId: string): boolean {
    const index = this.equipment.findIndex(eq => eq.id === equipmentId);
    
    if (index === -1) {
      return false;
    }
    
    this.equipment.splice(index, 1);
    this.refreshVelocityForMass();
    return true;
  }
  
  /**
   * Загрузить груз
   */
  loadCargo(item: ICargoItem): boolean {
    if (!item || typeof item !== 'object') return this.applyCargoResult({ ok: false, message: 'Недопустимый груз' });
    return this.applyCargoResult(loadCargo(this.state.cargo, { resourceType: item.resourceType,
      amount: item.amount, mass: item.weight, volume: item.volume }, this.getCargoLimits()));
  }
  
  /**
   * Выгрузить груз
   */
  unloadCargo(resourceType: string, amount: number): boolean {
    return this.applyCargoResult(unloadCargo(this.state.cargo, resourceType, amount));
  }

  private applyCargoResult(result: CargoResult): boolean {
    if (!result.ok) { this.cargoMessage = result.message; return false; }
    this.state.cargo = result.cargo;
    this.cargoMessage = 'Грузовая операция выполнена';
    this.refreshVelocityForMass();
    return true;
  }

  protected refreshVelocityForMass(): void {
    if (!this.isMoving) return;
    const length = Math.hypot(this.velocity.x, this.velocity.y);
    if (length === 0) return;
    const speed = this.getCurrentMaxSpeed();
    this.velocity = { x: this.velocity.x / length * speed, y: this.velocity.y / length * speed };
  }
  
  /**
   * Получить количество доступных слотов для оборудования
   */
  getAvailableCargoSlots(): number {
    // Базовое количество слотов зависит от вместимости отсека
    return Math.floor(this.cargoHold.capacity / 10);
  }
  
  /**
   * Потребить энергию
   */
  consumeEnergy(amount: number): boolean {
    if (this.powerSource.currentEnergy < amount) {
      return false;
    }
    
    this.powerSource.currentEnergy -= amount;
    return true;
  }
  
  /**
   * Восстановить энергию
   */
  rechargeEnergy(deltaTime: number): void {
    const rechargeAmount = this.powerSource.energyOutput * deltaTime;
    this.powerSource.currentEnergy = Math.min(
      this.powerSource.currentEnergy + rechargeAmount,
      this.powerSource.energyCapacity
    );
  }
  
  /**
   * Обновление состояния корабля
   */
  update(deltaTime: number): void {
    // Восстанавливаем энергию
    this.rechargeEnergy(deltaTime);
    
    // Обновляем позицию при движении
    if (this.isMoving) {
      this.position.x += this.velocity.x * deltaTime;
      this.position.y += this.velocity.y * deltaTime;
      
      // Потребляем энергию при движении
      const energyConsumption = this.engine.energyConsumption * deltaTime;
      if (!this.consumeEnergy(energyConsumption)) {
        this.stopMoving();
      }
    }
  }
  
  /**
   * Начать движение в направлении
   */
  startMoving(targetX: number, targetY: number): boolean {
    const dx = targetX - this.position.x;
    const dy = targetY - this.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    if (distance === 0) {
      return false;
    }
    
    const maxSpeed = this.getCurrentMaxSpeed();
    this.velocity.x = (dx / distance) * maxSpeed;
    this.velocity.y = (dy / distance) * maxSpeed;
    this.isMoving = true;
    
    return true;
  }
  
  /**
   * Остановить движение
   */
  stopMoving(): void {
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.isMoving = false;
  }
  
  /**
   * Получить информацию о корабле
   */
  getInfo(): string {
    return `
Корабль: ${this.name}
Стоимость: ${this.getTotalCost()} кредитов
Вес: ${this.getTotalWeight().toFixed(2)} т
Макс. скорость: ${this.getCurrentMaxSpeed().toFixed(2)} ед/с
Дальность: ${this.getMaxRange().toFixed(2)} св. лет
Энергия: ${this.powerSource.currentEnergy}/${this.powerSource.energyCapacity}
Груз: ${this.cargoHold.usedSpace}/${this.cargoHold.capacity} м³
Оборудование: ${this.equipment.length} шт.
    `.trim();
  }
}
