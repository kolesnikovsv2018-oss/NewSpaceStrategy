import { describe, expect, it, vi } from 'vitest';
import { calculateComponent, calculateShipStats, componentSchema, createComponent, createDesign,
  designSchema, HULLS, installComponent, validateDesign, type ComponentKind } from '../src/domain/shipDesign';
import { createCivilianDesign, type CivilianPresetId } from '../src/domain/civilianPresets';
import { DesignedShip } from '../src/entities/DesignedShip';
import { ShipFactory } from '../src/entities/ShipFactory';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { createV1Design } from './fixtures/v1Design';

const kinds = ['mining', 'repair', 'scanner', 'cargoExpansion'] as const;
function storage() {
  const data = new Map<string, string>();
  const store: StoragePort = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
  return { data, store, repository: new ShipDesignManager(store) };
}
const v1JSON = () => JSON.stringify({ schemaVersion: 1, designs: [createV1Design()], components: [] });

describe('typed service modules', () => {
  it.each(kinds)('installs %s into either service point without mutating input/catalogue', kind => {
    const design = createDesign('cruiser', true);
    const component = createComponent(kind);
    let installed = installComponent(design, 'service_1', component);
    installed = installComponent(installed, 'service_2', component);
    expect(design.slots.filter(slot => slot.id.startsWith('service')).every(slot => slot.component === null)).toBe(true);
    expect(installed.schemaVersion).toBe(5);
    expect(validateDesign(installed, 'flight')).toEqual([]);
    installed.slots[6].component!.name = 'Changed';
    expect(installed.slots[7].component!.name).toBe(component.name);
    expect(componentSchema.parse(component)).toEqual(component);
    expect(installComponent(installed, 'service_1', null).slots[6].component).toBeNull();
  });

  it.each(kinds)('rejects %s in combat/engine slots', kind => {
    const design = createDesign('corvette', true);
    for (const slot of design.slots.slice(0, 6)) {
      expect(() => installComponent(design, slot.id, createComponent(kind))).toThrow('несовместимый тип');
    }
  });

  it.each(['beam', 'projectile', 'engine', 'shield', 'armor'] as const)('rejects %s in service slots', kind => {
    expect(() => installComponent(createDesign(), 'service_1', createComponent(kind))).toThrow('несовместимый тип');
  });

  it.each([
    ['mining', 'miningSpeed'], ['repair', 'repairRate'], ['scanner', 'range'], ['cargoExpansion', 'bonusCapacity']
  ] as const)('validates finite bounded %s.%s', (kind, field) => {
    for (const value of [-1, Infinity, NaN, 100001, '5']) {
      expect(componentSchema.safeParse({ ...createComponent(kind), [field]: value }).success).toBe(false);
    }
    expect(componentSchema.safeParse({ ...createComponent(kind), [field]: 0 }).success).toBe(true);
    expect(componentSchema.safeParse({ ...createComponent(kind), forgedMass: 0 }).success).toBe(false);
  });

  it('uses ratios, not legacy percentages, and never accepts old effect objects as new definitions', () => {
    expect(componentSchema.safeParse({ ...createComponent('mining'), efficiency: 80 }).success).toBe(false);
    expect(componentSchema.safeParse({ ...createComponent('scanner'), accuracy: 85 }).success).toBe(false);
    expect(componentSchema.safeParse({ id: 'old', name: 'Mining', type: 'mining', effect: { miningSpeed: 10 } }).success).toBe(false);
  });

  it.each([
    ['mining', 60, 4000, 50], ['repair', 25, 2500, 50], ['scanner', 10, 1500, 10], ['cargoExpansion', 20, 1000, 0]
  ] as const)('derives %s nominal mass/cost/power once', (kind, mass, cost, power) => {
    const component = createComponent(kind);
    expect(calculateComponent(component)).toMatchObject({ mass, cost, power, energyPerShot: 0 });
    const design = createDesign('corvette', true);
    const before = calculateShipStats(design);
    const after = calculateShipStats(installComponent(design, 'service_1', component));
    expect(after.mass).toBe(before.mass + mass);
    expect(after.cost).toBe(before.cost + cost);
    expect(after.peakPower).toBe(before.peakPower + power);
    expect(after.movementPower).toBe(before.movementPower);
    expect(after.weapons).toEqual(before.weapons);
  });

  it('rejects service size, total mass, duplicate/extra/missing slots and insufficient nominal power', () => {
    expect(() => installComponent(createDesign('fighter'), 'service_1', {
      ...createComponent('mining'), kind: 'mining', miningSpeed: 30, efficiency: 0.8
    , tacticalVariant: 'standard' as const})).toThrow('слишком велик');
    let heavy = installComponent(createDesign('corvette', true), 'service_1', {
      ...createComponent('mining'), kind: 'mining', miningSpeed: 20, efficiency: 0.8
    , tacticalVariant: 'standard' as const});
    expect(() => installComponent(heavy, 'service_2', {
      ...createComponent('mining'), kind: 'mining', miningSpeed: 25, efficiency: 0.8
    , tacticalVariant: 'standard' as const})).toThrow('Перегрузка');
    heavy = installComponent(createDesign('corvette', true), 'service_1', {
      ...createComponent('repair'), kind: 'repair', repairRate: 40
    , tacticalVariant: 'standard' as const});
    expect(validateDesign(heavy, 'flight').some(issue => issue.code === 'power')).toBe(true);
    expect(() => new DesignedShip(heavy, 'blue', 'flight')).toThrow('мощности');
    for (const slots of [heavy.slots.slice(0, 6), [...heavy.slots, heavy.slots[6]],
      heavy.slots.map(slot => slot.id === 'service_2' ? { ...slot, id: 'service_1' } : slot)]) {
      expect(designSchema.safeParse({ ...heavy, slots }).success).toBe(false);
    }
  });

  it('expands volume only, stacks modules, and respects hull mass and immutable refitting', () => {
    const base = createDesign('corvette', true);
    const expansion = createComponent('cargoExpansion');
    const design = installComponent(installComponent(base, 'service_1', expansion), 'service_2', expansion);
    const before = calculateShipStats(base), after = calculateShipStats(design);
    expect(after.cargoVolume).toBe(before.cargoVolume + 100);
    expect(after.cargoMassLimit).toBe(before.cargoMassLimit);
    const ship = new DesignedShip(design, 'blue');
    expect(ship.loadCargo({ resourceType: 'foam', amount: 1, weight: 50, volume: 200 })).toBe(true);
    expect(ship.loadCargo({ resourceType: 'foam', amount: 1, weight: 1, volume: 1 })).toBe(false);
    expect(ship.getTotalWeight()).toBeLessThanOrEqual(HULLS.corvette.maxMass);
    const smaller = new DesignedShip(installComponent(design, 'service_1', null), 'blue');
    expect(smaller.getCargoLimits().volume).toBe(150);
    expect(smaller.getState().cargo).toEqual([]);
    expect(ship.getCargoLimits().volume).toBe(200);
  });

  it('accounts for service mass in remaining hull payload reserve even when expanding volume', () => {
    let design = installComponent(createDesign('corvette', true), 'armor_1', {
      ...createComponent('armor'), kind: 'armor', armorPoints: 1100, beamResistance: 0, projectileResistance: 0
    , tacticalVariant: 'standard' as const});
    design = installComponent(design, 'service_1', createComponent('cargoExpansion'));
    const stats = calculateShipStats(design);
    expect(stats.mass).toBe(332);
    expect(stats.cargoMassLimit).toBe(18);
    expect(stats.cargoVolume).toBe(150);
  });

  it.each(['mining', 'repair', 'scanner'] as const)('does not execute %s or grant phantom weapons or regeneration', kind => {
    const design = installComponent(createCivilianDesign('scout'), 'service_1', createComponent(kind));
    const ship = new DesignedShip(design, 'neutral', 'flight');
    ship.combatStats.currentHull = 100;
    ship.powerSource.currentEnergy = 0;
    ship.update(1);
    expect(ship.getState().hull).toBe(100);
    expect(ship.getState().cargo).toEqual([]);
    expect(ship.getState().weapons).toEqual([]);
    expect(ship.getState().shield).toBe(0);
    expect(ship.getState().energy).toBe(calculateShipStats(design).powerGeneration);
    expect(ship.getInfo()).toContain('ещё не исполняются');
  });

  it('gives every demonstration preset a canonical project and independent service definitions', () => {
    const ships = [ShipFactory.createScout(), ShipFactory.createFreighter(), ShipFactory.createWarship(), ShipFactory.createMiner()];
    expect(ships.every(ship => ship instanceof DesignedShip)).toBe(true);
    expect(ships.every(ship => validateDesign(ship.getDesign(), 'flight').length === 0)).toBe(true);
    const miner = ships[3];
    expect(miner.getInstalledModuleNames()).toContain('Добывающий модуль Mk1');
    const copy = miner.getDesign(); copy.slots[6].component!.name = 'Changed';
    expect(miner.getInstalledModuleNames()).not.toContain('Changed');
    expect(() => createCivilianDesign('invalid' as CivilianPresetId)).toThrow('Неизвестная');
  });
});

describe('current v3 library without compatibility readers', () => {
  it('rejects the exact v1 shape without synthesizing service slots or component variants', () => {
    const old = createV1Design(), before = structuredClone(old);
    expect(designSchema.safeParse(old).success).toBe(false);
    const { repository, data } = storage();
    expect(() => repository.importJSON(v1JSON())).toThrow('Версия формата библиотеки не поддерживается');
    expect(old).toEqual(before); expect(data.size).toBe(0);
  });

  it('ignores v1 storage; current save preserves identity, dates, modules, stats and old bytes', () => {
    const { store, data, repository } = storage();
    const raw = v1JSON(); store.setItem('orion_shipyard_v1', raw);
    const loaded = repository.load();
    expect(loaded).toEqual({ schemaVersion: 5, designs: [], components: [] });
    expect(data.size).toBe(1);
    const edited = installComponent(createDesign('corvette', true), 'service_1', createComponent('mining'));
    const saved = repository.saveDesign(edited), restored = repository.load().designs[0];
    expect(restored).toEqual(saved); expect(calculateShipStats(restored)).toEqual(calculateShipStats(edited));
    expect(store.getItem('orion_shipyard_v1')).toBe(raw);
    expect(JSON.parse(store.getItem(ShipDesignManager.STORAGE_KEY)!).schemaVersion).toBe(5);
    expect(restored.slots[6].component?.kind).toBe('mining');
  });

  it.each(kinds)('round-trips %s in catalogue and design through v3 export/import', kind => {
    const first = storage(), second = storage();
    const component = createComponent(kind);
    first.repository.saveComponents([component]);
    first.repository.saveDesign(installComponent(createDesign('corvette', true), 'service_1', component));
    second.repository.importJSON(first.repository.exportJSON());
    expect(second.repository.load()).toEqual(first.repository.load());
    expect(new DesignedShip(second.repository.load().designs[0], 'blue').getDesign().slots[6].component).toEqual(component);
  });

  it('rejects repeated v1 imports and preserves current conflict checks after a service edit', () => {
    const { repository } = storage();
    expect(() => repository.importJSON(v1JSON())).toThrow('Версия формата библиотеки не поддерживается');
    expect(() => repository.importJSON(v1JSON())).toThrow('Версия формата библиотеки не поддерживается');
    repository.saveDesign(createDesign('corvette', true));
    const original = repository.exportJSON();
    expect(repository.load().designs).toHaveLength(1);
    repository.saveDesign(installComponent(repository.load().designs[0], 'service_1', createComponent('repair')));
    const before = repository.exportJSON();
    expect(() => repository.importJSON(original)).toThrow('уже существует');
    expect(repository.exportJSON()).toBe(before);
  });

  it.each(['{broken', '{"schemaVersion":999,"designs":[],"components":[]}'])('does not fall back to v1 when v3 is invalid: %s', bad => {
    const { store, repository } = storage();
    store.setItem('orion_shipyard_v1', v1JSON());
    store.setItem(ShipDesignManager.STORAGE_KEY, bad);
    expect(() => repository.load()).toThrow();
    expect(() => repository.saveDesign(createDesign())).toThrow();
    expect(store.getItem(ShipDesignManager.STORAGE_KEY)).toBe(bad);
  });

  it('rejects malformed v1, occupied extra slots and disguised new kinds instead of losing data', () => {
    const { repository } = storage();
    const old = createV1Design();
    const variants = [
      { ...old, slots: [...old.slots, { id: 'service_1', component: createComponent('mining') }] },
      { ...old, slots: old.slots.map((slot, i) => i === 0 ? { ...slot, component: createComponent('scanner') } : slot) },
      { ...old, slots: old.slots.slice(0, 5) }, { ...old, cargo: [] }
    ];
    for (const design of variants) {
      expect(() => repository.importJSON(JSON.stringify({ schemaVersion: 1, designs: [design], components: [] }))).toThrow();
    }
    expect(() => repository.decode(JSON.stringify({ schemaVersion: 1, designs: [old, old], components: [] }))).toThrow('Версия формата библиотеки не поддерживается');
    const current = createDesign();
    expect(() => repository.decode(JSON.stringify({ schemaVersion: 5, designs: [current, current], components: [] }))).toThrow('Повторяющиеся');
    expect(() => repository.decode(JSON.stringify({ schemaVersion: 1, designs: [], components: [createComponent('mining')] }))).toThrow();
  });

  it('keeps original keys unchanged on quota failure during first v3 save', () => {
    const { store, repository } = storage();
    const raw = v1JSON(); store.setItem('orion_shipyard_v1', raw);
    const design = createDesign('corvette', true);
    vi.spyOn(store, 'setItem').mockImplementation(() => { throw new Error('Quota'); });
    expect(() => repository.saveDesign(design)).toThrow('Quota');
    expect(store.getItem('orion_shipyard_v1')).toBe(raw);
    expect(store.getItem(ShipDesignManager.STORAGE_KEY)).toBeNull();
  });

  it('strictly rejects retired/future versions and invalid v3 service placement before writing', () => {
    const { repository, data } = storage();
    const design = createDesign('corvette', true);
    design.slots[6].component = createComponent('beam' as ComponentKind);
    expect(() => repository.importJSON(JSON.stringify({ schemaVersion: 5, designs: [design], components: [] }))).toThrow('несовместимый');
    for (const schemaVersion of [1, 2, 3]) {
      expect(() => repository.importJSON(JSON.stringify({ schemaVersion, designs: [], components: [] }))).toThrow('Версия формата библиотеки не поддерживается');
    }
    expect(data.size).toBe(0);
  });
});