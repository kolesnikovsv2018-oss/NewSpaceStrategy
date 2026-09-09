import { componentSchema, createComponent, createDesign, installComponent, validateDesign, type ShipDesign } from './shipDesign';

export const CIVILIAN_PRESET_NAMES = { scout: 'Разведчик', freighter: 'Грузовоз', miner: 'Добытчик' } as const;
export type CivilianPresetId = keyof typeof CIVILIAN_PRESET_NAMES;

export function createCivilianDesign(id: CivilianPresetId): ShipDesign {
  if (!Object.prototype.hasOwnProperty.call(CIVILIAN_PRESET_NAMES, id)) throw new Error('Неизвестная гражданская комплектация');
  let design = createDesign(id === 'scout' ? 'corvette' : id === 'miner' ? 'frigate' : 'cruiser');
  design.name = CIVILIAN_PRESET_NAMES[id];
  const engine = componentSchema.parse({ ...createComponent('engine'),
    maxSpeed: id === 'scout' ? 280 : 100, thrust: id === 'scout' ? 1000 : 1600 });
  design = installComponent(design, 'engine_1', engine);
  if (id === 'miner') {
    design = installComponent(design, 'service_1', { ...createComponent('mining'), name: 'Добывающий модуль Mk1' });
  }
  const errors = validateDesign(design, 'flight');
  if (errors.length) throw new Error(errors.map(error => error.message).join('; '));
  return design;
}
