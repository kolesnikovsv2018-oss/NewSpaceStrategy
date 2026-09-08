import type Phaser from 'phaser';
import { calculateComponent, componentSchema, COMPONENT_NAMES, createComponent,
  type ComponentDefinition, type ComponentKind } from '../domain/shipDesign';
import { button, text, panelBackground } from './ShipyardWidgets';

interface Parameter { key: string; label: string; step: number; min: number; max: number }
const parameters: Record<ComponentKind, Parameter[]> = {
  beam: [
    { key: 'damage', label: 'Урон', step: 5, min: 1, max: 100000 },
    { key: 'range', label: 'Дальность', step: 50, min: 1, max: 10000 },
    { key: 'fireRate', label: 'Выстрелов/с', step: 0.1, min: 0.1, max: 20 },
    { key: 'accuracy', label: 'Точность', step: 0.05, min: 0, max: 1 }
  ],
  projectile: [],
  engine: [
    { key: 'thrust', label: 'Тяга', step: 100, min: 0, max: 100000 },
    { key: 'maxSpeed', label: 'Скорость', step: 10, min: 0, max: 1000 },
    { key: 'maneuverability', label: 'Манёвренность', step: 0.05, min: 0, max: 1 },
    { key: 'powerGeneration', label: 'Генерация, ед/с', step: 50, min: 0, max: 100000 }
  ],
  shield: [
    { key: 'capacity', label: 'Ёмкость', step: 50, min: 0, max: 100000 },
    { key: 'rechargeRate', label: 'Восстановление/с', step: 2, min: 0, max: 100000 },
    { key: 'rechargeDelay', label: 'Задержка, с', step: 0.5, min: 0, max: 60 },
    { key: 'beamResistance', label: 'Защита от лучей', step: 0.05, min: 0, max: 1 }
  ],
  armor: [
    { key: 'armorPoints', label: 'Броня', step: 25, min: 0, max: 100000 },
    { key: 'beamResistance', label: 'Защита от лучей', step: 0.05, min: 0, max: 1 },
    { key: 'projectileResistance', label: 'Защита от снарядов', step: 0.05, min: 0, max: 1 }
  ]
};
parameters.projectile = [...parameters.beam, { key: 'ammoCapacity', label: 'Боекомплект', step: 10, min: 1, max: 10000 }];

/** Catalogue editor. Definitions are copied on installation, never consumed from this list. */
export class ComponentBuilderPanel {
  private readonly container: Phaser.GameObjects.Container;
  private components: ComponentDefinition[];
  private selectedId?: string;
  private kind: ComponentKind = 'beam';
  private page = 0;
  private onChange?: (components: ComponentDefinition[]) => void;

  constructor(private readonly scene: Phaser.Scene, x: number, y: number, components: ComponentDefinition[] = []) {
    this.container = scene.add.container(x, y);
    this.components = components.map(item => componentSchema.parse(item));
    this.render();
  }

  private render(): void {
    this.container.removeAll(true);
    panelBackground(this.scene, this.container, 440, 600);
    text(this.scene, this.container, 18, 18, 'КАТАЛОГ КОМПОНЕНТОВ', 18, '#8de1f2');
    text(this.scene, this.container, 18, 46, 'Установленные модули — независимые копии', 11);
    (Object.keys(COMPONENT_NAMES) as ComponentKind[]).forEach((kind, index) => {
      button(this.scene, this.container, 14 + index * 84, 70, COMPONENT_NAMES[kind], () => {
        this.kind = kind; this.page = 0; this.selectedId = undefined; this.render();
      }, `category-${kind}`).setBackgroundColor(this.kind === kind ? '#336a71' : '#233e58');
    });
    button(this.scene, this.container, 18, 110, '+ Создать', () => {
      const component = createComponent(this.kind);
      component.name += ` ${this.components.filter(item => item.kind === this.kind).length + 1}`;
      this.components.push(component);
      this.selectedId = component.id;
      this.page = Math.floor((this.components.filter(item => item.kind === this.kind).length - 1) / 4);
      this.changed();
    }, 'create-component');
    const filtered = this.components.filter(item => item.kind === this.kind);
    filtered.slice(this.page * 4, this.page * 4 + 4).forEach((component, index) => {
      button(this.scene, this.container, 18, 150 + index * 36, component.name, () => {
        this.selectedId = component.id; this.render();
      }, `component-${component.id}`).setFixedSize(400, 30)
        .setBackgroundColor(component.id === this.selectedId ? '#336a71' : '#233e58');
    });
    button(this.scene, this.container, 18, 300, '←', () => { this.page = Math.max(0, this.page - 1); this.render(); });
    text(this.scene, this.container, 66, 308, `${this.page + 1} / ${Math.max(1, Math.ceil(filtered.length / 4))}`);
    button(this.scene, this.container, 130, 300, '→', () => {
      this.page = Math.min(Math.max(0, Math.ceil(filtered.length / 4) - 1), this.page + 1); this.render();
    });
    const selected = this.components.find(item => item.id === this.selectedId);
    if (!selected) { text(this.scene, this.container, 18, 365, 'Выберите компонент для настройки'); return; }
    const stats = calculateComponent(selected);
    text(this.scene, this.container, 18, 346,
      `${stats.mass.toFixed(1)} т · ${stats.cost} ₡ · ${stats.slotSize}\n` +
      `Потребление: ${stats.power.toFixed(1)} ед/с · Выстрел: ${stats.energyPerShot.toFixed(1)}`, 12);
    const values = selected as unknown as Record<string, unknown>;
    parameters[selected.kind].forEach((field, index) => {
      const value = Number(values[field.key]);
      const y = 397 + index * 35;
      text(this.scene, this.container, 18, y + 7, `${field.label}: ${value.toFixed(2)}`, 12);
      for (const [label, sign, x] of [['−', -1, 320], ['+', 1, 365]] as const) {
        button(this.scene, this.container, x, y, label, () => {
          const next = componentSchema.parse({ ...selected,
            [field.key]: Math.min(field.max, Math.max(field.min, Number((value + sign * field.step).toFixed(4)))) });
          this.components = this.components.map(item => item.id === selected.id ? next : item);
          this.changed();
        }, `${field.key}-${sign === 1 ? 'plus' : 'minus'}`);
      }
    });
  }

  private changed(): void { this.render(); this.onChange?.(this.getComponents()); }
  setOnComponentsChanged(callback: (components: ComponentDefinition[]) => void): void { this.onChange = callback; }
  getComponents(): ComponentDefinition[] { return this.components.map(item => componentSchema.parse(item)); }
  setComponents(components: ComponentDefinition[]): void {
    this.components = components.map(item => componentSchema.parse(item));
    this.selectedId = undefined; this.page = 0; this.render();
  }
  destroy(): void { this.container.destroy(); }
}
