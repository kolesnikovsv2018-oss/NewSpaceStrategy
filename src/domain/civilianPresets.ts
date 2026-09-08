import { componentSchema, createComponent, createDesign, installComponent, validateDesign, type ShipDesign } from './shipDesign';

export const CIVILIAN_PRESET_NAMES = { scout: 'Разведчик', freighter: 'Грузовоз' } as const;
export type CivilianPresetId = keyof typeof CIVILIAN_PRESET_NAMES;

export function createCivilianDesign(id: CivilianPresetId): ShipDesign {
  let design = createDesign(id === 'scout' ? 'corvette' : 'cruiser');
  design.name = CIVILIAN_PRESET_NAMES[id];
  const engine = componentSchema.parse({ ...createComponent('engine'),
    maxSpeed: id === 'scout' ? 280 : 100, thrust: id === 'scout' ? 1000 : 1600 });
  design = installComponent(design, 'engine_1', engine);
  const errors = validateDesign(design, 'flight');
  if (errors.length) throw new Error(errors.map(error => error.message).join('; '));
  return design;
}
