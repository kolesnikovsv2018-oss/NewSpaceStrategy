import { 
  IPowerSource, 
  IEngine, 
  ICargo, 
  IEquipment, 
  ICargoItem 
} from './interfaces/ShipComponents';
import type { ShipDesign } from '../domain/shipDesign';
import { cargoTotals, type CargoLimits } from '../domain/cargo';
import { ShipRuntime } from './ShipRuntime';
import { legacyCargoLot, legacyCargoView } from '../legacy/cargoCompatibility';
import { positiveFinite, writeEnergy } from '../domain/runtimeNumbers';
import { formatFlightEstimate } from '../domain/flightEstimate';

/**
 * Основной класс космического корабля
 */
export class Ship extends ShipRuntime {
  getDesign(): ShipDesign | undefined { return undefined; }
  getInstalledModuleNames(): string[] { return this.equipment.map(item => item.name); }
  
  // Компоненты корабля
  private powerSourceView!: IPowerSource;
  get powerSource(): IPowerSource { return this.powerSourceView; }
  set powerSource(source: IPowerSource) {
    const ship = this;
    writeEnergy(this.state, source.currentEnergy, source.energyCapacity);
    this.powerSourceView = { ...source,
      get currentEnergy() { return ship.state.energy; },
      set currentEnergy(value: number) { writeEnergy(ship.state, value, ship.powerSource.energyCapacity); }
    };
  }
  engine: IEngine;
  cargoHold: ICargo;
  
  // Установленное оборудование
  equipment: IEquipment[] = [];
  
  // Груз
  get cargo(): ICargoItem[] {
    return legacyCargoView(this.state.cargo);
  }
  getCargoLimits(): CargoLimits {
    return { mass: Math.max(0, this.cargoHold.maxWeight - this.equipment.reduce((sum, item) => sum + item.weight, 0)),
      volume: this.cargoHold.capacity };
  }
  
  
  constructor(
    id: string,
    name: string,
    powerSource: IPowerSource,
    engine: IEngine,
    cargoHold: ICargo
  ) {
    super(id, name);
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
    * @deprecated Historical battery-only estimate using unloaded engine speed; use getFlightEstimate.
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
    return this.loadCargoLot(legacyCargoLot(item));
  }
  
  
  /**
   * Получить количество доступных слотов для оборудования
   */
  getAvailableCargoSlots(): number {
    // Базовое количество слотов зависит от вместимости отсека
    return Math.floor(this.cargoHold.capacity / 10);
  }
  
  getEnergyCapacity(): number { return this.powerSource.energyCapacity; }
  getEnergyGeneration(): number { return this.powerSource.energyOutput; }
  getMovementPower(): number { return this.engine.energyConsumption; }
  
  /**
   * Обновление состояния корабля
   */
  update(deltaTime: number): void {
    if (!positiveFinite(deltaTime)) return;
    // Восстанавливаем энергию
    this.rechargeEnergy(deltaTime);
    
    this.advanceMovement(deltaTime, false);
  }
  
  
  /**
   * Получить информацию о корабле
   */
  getInfo(): string {
    return `
Корабль: ${this.name}
Стоимость: ${this.getTotalCost()} кредитов
Вес: ${this.getTotalWeight().toFixed(2)} т
Макс. скорость: ${this.getCurrentMaxSpeed().toFixed(2)} такт. ед/с
Полёт (только движение): ${formatFlightEstimate(this.getFlightEstimate())}
Энергия: ${this.powerSource.currentEnergy}/${this.powerSource.energyCapacity} ЭЕ
Генерация / движение: ${this.getEnergyGeneration()}/${this.getMovementPower()} ЭЕ/с
Груз: ${this.cargoHold.usedSpace}/${this.cargoHold.capacity} м³
Оборудование: ${this.equipment.length} шт.
    `.trim();
  }
}
