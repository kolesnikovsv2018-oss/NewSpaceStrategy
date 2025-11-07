import { 
  IPowerSource, 
  IEngine, 
  ICargo, 
  IEquipment, 
  ICargoItem 
} from './interfaces/ShipComponents';

/**
 * Основной класс космического корабля
 */
export class Ship {
  id: string;
  name: string;
  
  // Компоненты корабля
  powerSource: IPowerSource;
  engine: IEngine;
  cargoHold: ICargo;
  
  // Установленное оборудование
  equipment: IEquipment[] = [];
  
  // Груз
  cargo: ICargoItem[] = [];
  
  // Позиция и состояние
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  isMoving: boolean = false;
  
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
    this.cargoHold = cargoHold;
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
    this.cargoHold.currentWeight += equipment.weight;
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
    
    const equipment = this.equipment[index];
    this.cargoHold.currentWeight -= equipment.weight;
    this.equipment.splice(index, 1);
    return true;
  }
  
  /**
   * Загрузить груз
   */
  loadCargo(item: ICargoItem): boolean {
    // Проверяем вес
    if (this.cargoHold.currentWeight + item.weight > this.cargoHold.maxWeight) {
      console.log('Превышен максимальный вес груза');
      return false;
    }
    
    // Проверяем объем
    if (this.cargoHold.usedSpace + item.volume > this.cargoHold.capacity) {
      console.log('Недостаточно места в грузовом отсеке');
      return false;
    }
    
    this.cargo.push(item);
    this.cargoHold.currentWeight += item.weight;
    this.cargoHold.usedSpace += item.volume;
    return true;
  }
  
  /**
   * Выгрузить груз
   */
  unloadCargo(resourceType: string, amount: number): boolean {
    const cargoIndex = this.cargo.findIndex(c => c.resourceType === resourceType);
    
    if (cargoIndex === -1) {
      return false;
    }
    
    const cargoItem = this.cargo[cargoIndex];
    
    if (cargoItem.amount < amount) {
      return false;
    }
    
    const weightPerUnit = cargoItem.weight / cargoItem.amount;
    const volumePerUnit = cargoItem.volume / cargoItem.amount;
    
    cargoItem.amount -= amount;
    cargoItem.weight -= weightPerUnit * amount;
    cargoItem.volume -= volumePerUnit * amount;
    
    this.cargoHold.currentWeight -= weightPerUnit * amount;
    this.cargoHold.usedSpace -= volumePerUnit * amount;
    
    if (cargoItem.amount <= 0) {
      this.cargo.splice(cargoIndex, 1);
    }
    
    return true;
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
