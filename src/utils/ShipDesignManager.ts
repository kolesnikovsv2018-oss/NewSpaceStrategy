import { IEquipment, IShipConfiguration } from '../entities/interfaces/Equipment';

/**
 * Менеджер дизайнов кораблей и компонентов
 * Управляет сохранением и загрузкой конфигураций
 */
export class ShipDesignManager {
  private static readonly STORAGE_KEY_COMPONENTS = 'orion_components';
  private static readonly STORAGE_KEY_CONFIGS = 'orion_ship_configs';

  /**
   * Сохранить компоненты в localStorage
   */
  static saveComponents(components: IEquipment[]): void {
    try {
      const data = JSON.stringify(components);
      localStorage.setItem(this.STORAGE_KEY_COMPONENTS, data);
      console.log(`Сохранено ${components.length} компонентов`);
    } catch (error) {
      console.error('Ошибка сохранения компонентов:', error);
    }
  }

  /**
   * Загрузить компоненты из localStorage
   */
  static loadComponents(): IEquipment[] {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY_COMPONENTS);
      if (data) {
        const components = JSON.parse(data) as IEquipment[];
        console.log(`Загружено ${components.length} компонентов`);
        return components;
      }
    } catch (error) {
      console.error('Ошибка загрузки компонентов:', error);
    }
    return [];
  }

  /**
   * Сохранить конфигурации кораблей
   */
  static saveConfigurations(configs: IShipConfiguration[]): void {
    try {
      const data = JSON.stringify(configs);
      localStorage.setItem(this.STORAGE_KEY_CONFIGS, data);
      console.log(`Сохранено ${configs.length} конфигураций`);
    } catch (error) {
      console.error('Ошибка сохранения конфигураций:', error);
    }
  }

  /**
   * Загрузить конфигурации кораблей
   */
  static loadConfigurations(): IShipConfiguration[] {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY_CONFIGS);
      if (data) {
        const configs = JSON.parse(data) as IShipConfiguration[];
        console.log(`Загружено ${configs.length} конфигураций`);
        return configs;
      }
    } catch (error) {
      console.error('Ошибка загрузки конфигураций:', error);
    }
    return [];
  }

  /**
   * Сохранить отдельную конфигурацию
   */
  static saveConfiguration(config: IShipConfiguration): void {
    const configs = this.loadConfigurations();
    const index = configs.findIndex(c => c.id === config.id);
    
    if (index >= 0) {
      // Обновляем существующую
      configs[index] = config;
    } else {
      // Добавляем новую
      configs.push(config);
    }
    
    this.saveConfigurations(configs);
  }

  /**
   * Удалить конфигурацию
   */
  static deleteConfiguration(configId: string): void {
    const configs = this.loadConfigurations();
    const filtered = configs.filter(c => c.id !== configId);
    this.saveConfigurations(filtered);
  }

  /**
   * Получить конфигурацию по ID
   */
  static getConfiguration(configId: string): IShipConfiguration | undefined {
    const configs = this.loadConfigurations();
    return configs.find(c => c.id === configId);
  }

  /**
   * Экспортировать данные в JSON файл
   */
  static exportToFile(data: IEquipment[] | IShipConfiguration[], filename: string): void {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    
    URL.revokeObjectURL(url);
  }

  /**
   * Импортировать данные из JSON файла
   */
  static async importFromFile(file: File): Promise<IEquipment[] | IShipConfiguration[]> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target?.result as string);
          resolve(data);
        } catch (error) {
          reject(error);
        }
      };
      
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  /**
   * Очистить все данные
   */
  static clearAll(): void {
    localStorage.removeItem(this.STORAGE_KEY_COMPONENTS);
    localStorage.removeItem(this.STORAGE_KEY_CONFIGS);
    console.log('Все данные удалены');
  }

  /**
   * Получить статистику хранилища
   */
  static getStorageStats(): {
    componentsCount: number;
    configurationsCount: number;
    totalSize: number;
  } {
    const components = this.loadComponents();
    const configs = this.loadConfigurations();
    
    const componentsSize = new Blob([JSON.stringify(components)]).size;
    const configsSize = new Blob([JSON.stringify(configs)]).size;
    
    return {
      componentsCount: components.length,
      configurationsCount: configs.length,
      totalSize: componentsSize + configsSize
    };
  }
}
