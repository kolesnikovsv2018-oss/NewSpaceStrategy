import { createCivilianDesign, CIVILIAN_PRESET_NAMES, type CivilianPresetId } from '../domain/civilianPresets';
import { createCombatDesign, type CombatPresetId } from '../domain/combatPresets';
import { getProductionQuote } from '../domain/production';
import { designSchema, validateDesign, type ShipDesign } from '../domain/shipDesign';
import { ShipDesignManager } from './ShipDesignManager';

export interface ProductionChoice {
  design: ShipDesign;
  source: 'Пресет' | 'Библиотека';
  quote?: ReturnType<typeof getProductionQuote>;
  issue: string;
}
export interface ProductionCatalog { choices: ProductionChoice[]; notice: string }

/** Read-only snapshot; never repairs or writes the library. Incomplete drafts remain explainable. */
export function loadProductionCatalog(repository: Pick<ShipDesignManager, 'load'> = new ShipDesignManager()): ProductionCatalog {
  const choice = (input: ShipDesign, source: ProductionChoice['source']): ProductionChoice => {
    const design = designSchema.parse(input), issues = validateDesign(design, 'flight');
    return { design, source, issue: issues[0]?.message ?? '', quote: issues.length ? undefined : getProductionQuote(design) };
  };
  const choices: ProductionChoice[] = [
    ...(['fighter', 'frigate', 'cruiser', 'dreadnought'] as CombatPresetId[]).map(id => choice(createCombatDesign(id), 'Пресет')),
    ...(Object.keys(CIVILIAN_PRESET_NAMES) as CivilianPresetId[]).map(id => choice(createCivilianDesign(id), 'Пресет'))
  ];
  try {
    const saved = repository.load().designs.map(design => choice(design, 'Библиотека'));
    return { choices: [...choices, ...saved], notice: saved.length ? `Библиотека: ${saved.length} проектов · только чтение`
      : 'Библиотека пуста · доступны готовые пресеты' };
  } catch {
    return { choices, notice: 'Библиотека недоступна или повреждена · доступны пресеты' };
  }
}
