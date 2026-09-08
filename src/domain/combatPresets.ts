import { componentSchema, createDesign, installComponent, newId, validateDesign,
  type ComponentDefinition, type ComponentKind, type HullId, type ShipDesign } from './shipDesign';

export const COMBAT_PRESET_NAMES = {
  fighter: 'Истребитель', frigate: 'Фрегат', cruiser: 'Крейсер', dreadnought: 'Дредноут'
} as const;
export type CombatPresetId = keyof typeof COMBAT_PRESET_NAMES;
type ComponentTemplate = {
  [K in ComponentKind]: Omit<Extract<ComponentDefinition, { kind: K }>, 'id'>
}[ComponentKind];
interface CombatPreset {
  hullId: HullId;
  modules: Array<{ slotId: string; component: ComponentTemplate }>;
}

// These are editable design inputs, not a second set of runtime formulas.
// The old inert repair module is not advertised as a working ability.
const PRESETS: Record<CombatPresetId, CombatPreset> = {
  fighter: { hullId: 'fighter', modules: [
    { slotId: 'engine_1', component: { kind: 'engine', name: 'Маневровый двигатель', thrust: 1000, maxSpeed: 280, maneuverability: 0.9, powerGeneration: 500 } },
    { slotId: 'beam_1', component: { kind: 'beam', name: 'Лёгкий лазер', damage: 30, range: 400, fireRate: 1.5, accuracy: 0.85 } }
  ] },
  frigate: { hullId: 'frigate', modules: [
    { slotId: 'engine_1', component: { kind: 'engine', name: 'Эскортный двигатель', thrust: 1800, maxSpeed: 210, maneuverability: 0.7, powerGeneration: 1200 } },
    { slotId: 'beam_1', component: { kind: 'beam', name: 'Средний лазер', damage: 60, range: 500, fireRate: 1.5, accuracy: 0.85 } },
    { slotId: 'shield_1', component: { kind: 'shield', name: 'Эскортный щит', capacity: 250, rechargeRate: 10, rechargeDelay: 3, beamResistance: 0.15 } },
    { slotId: 'armor_1', component: { kind: 'armor', name: 'Лёгкая броня', armorPoints: 60, beamResistance: 0.1, projectileResistance: 0.15 } }
  ] },
  cruiser: { hullId: 'cruiser', modules: [
    { slotId: 'engine_1', component: { kind: 'engine', name: 'Крейсерский двигатель', thrust: 3000, maxSpeed: 180, maneuverability: 0.5, powerGeneration: 1600 } },
    { slotId: 'beam_1', component: { kind: 'beam', name: 'Тяжёлый лазер', damage: 85, range: 550, fireRate: 1.5, accuracy: 0.85 } },
    { slotId: 'beam_2', component: { kind: 'beam', name: 'Тяжёлый лазер', damage: 85, range: 550, fireRate: 1.5, accuracy: 0.85 } },
    { slotId: 'shield_1', component: { kind: 'shield', name: 'Крейсерский щит', capacity: 500, rechargeRate: 15, rechargeDelay: 3, beamResistance: 0.2 } },
    { slotId: 'armor_1', component: { kind: 'armor', name: 'Средняя броня', armorPoints: 150, beamResistance: 0.15, projectileResistance: 0.2 } }
  ] },
  dreadnought: { hullId: 'battleship', modules: [
    { slotId: 'engine_1', component: { kind: 'engine', name: 'Линейный двигатель', thrust: 4500, maxSpeed: 130, maneuverability: 0.3, powerGeneration: 3000 } },
    { slotId: 'beam_1', component: { kind: 'beam', name: 'Линейный лазер', damage: 120, range: 600, fireRate: 1.5, accuracy: 0.85 } },
    { slotId: 'beam_2', component: { kind: 'beam', name: 'Линейный лазер', damage: 120, range: 600, fireRate: 1.5, accuracy: 0.85 } },
    { slotId: 'projectile_1', component: { kind: 'projectile', name: 'Линейная пушка', damage: 100, range: 600, fireRate: 1, accuracy: 0.8, ammoCapacity: 20 } },
    { slotId: 'shield_1', component: { kind: 'shield', name: 'Линейный щит', capacity: 900, rechargeRate: 20, rechargeDelay: 4, beamResistance: 0.25 } },
    { slotId: 'armor_1', component: { kind: 'armor', name: 'Тяжёлая броня', armorPoints: 300, beamResistance: 0.2, projectileResistance: 0.3 } }
  ] }
};

/** A fresh, fully validated blueprint suitable for the yard, storage or runtime. */
export function createCombatDesign(presetId: CombatPresetId, index = 0): ShipDesign {
  if (!Number.isSafeInteger(index) || index < 0 || index > 9999) throw new Error('Недопустимый номер корабля');
  const preset = PRESETS[presetId];
  if (!preset) throw new Error('Неизвестная боевая комплектация');
  let design = createDesign(preset.hullId);
  design.name = `${COMBAT_PRESET_NAMES[presetId]}-${index + 1}`;
  for (const { slotId, component } of preset.modules) {
    design = installComponent(design, slotId, componentSchema.parse({ ...component, id: newId(component.kind) }));
  }
  const errors = validateDesign(design, 'battle');
  if (errors.length) throw new Error(`Недопустимая комплектация ${design.name}: ${errors.map(error => error.message).join('; ')}`);
  return design;
}
