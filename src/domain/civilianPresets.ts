import { componentSchema, createComponent, createComponentWithId, createDesign, installComponent, validateDesign,
  type ComponentDefinition, type ShipDesign } from './shipDesign';

export const CIVILIAN_PRESET_NAMES = { scout: 'Разведчик', freighter: 'Грузовоз', miner: 'Добытчик' } as const;
export type CivilianPresetId = keyof typeof CIVILIAN_PRESET_NAMES;

function isSameComponent(actual: ComponentDefinition | null, expected: ComponentDefinition | null): boolean {
  if (!actual || !expected || actual.kind !== expected.kind) return actual === expected;
  const actualValues = actual as unknown as Record<string, unknown>;
  const expectedValues = expected as unknown as Record<string, unknown>;
  return Object.keys(expectedValues).filter(key => key !== 'id' && key !== 'name')
    .every(key => actualValues[key] === expectedValues[key]);
}

export function isCivilianPresetDesign(design: ShipDesign): boolean {
  return (Object.keys(CIVILIAN_PRESET_NAMES) as CivilianPresetId[]).some(id => {
    const hullId = id === 'scout' ? 'corvette' : id === 'miner' ? 'frigate' : 'cruiser';
    if (design.hullId !== hullId) return false;
    const expectedEngine = componentSchema.parse({ ...createComponentWithId('engine', 'campaign-preset-engine'),
      thrust: id === 'scout' ? 1000 : 1600, maxSpeed: id === 'scout' ? 280 : 100 });
    const expectedMining = id === 'miner' ? componentSchema.parse({ ...createComponentWithId('mining', 'campaign-preset-mining'),
      name: 'Добывающий модуль Mk1' }) : null;
    return design.slots.every(slot => {
      if (slot.id === 'engine_1') return isSameComponent(slot.component, expectedEngine);
      if (slot.id === 'service_1') return isSameComponent(slot.component, expectedMining);
      return slot.component === null;
    });
  });
}

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
