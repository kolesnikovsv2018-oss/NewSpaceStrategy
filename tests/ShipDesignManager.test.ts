import { describe, expect, it, vi } from 'vitest';
import { ShipDesignManager, migrateLegacyComponent, type StoragePort } from '../src/utils/ShipDesignManager';
import { calculateShipStats, createComponent, createDesign } from '../src/domain/shipDesign';

function storage(): StoragePort & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

describe('versioned design repository', () => {
  it('round-trips named designs, timestamps and statistics across a new repository', () => {
    const store = storage();
    const repository = new ShipDesignManager(store);
    const design = createDesign('corvette', true);
    design.name = 'Испытатель';
    const saved = repository.saveDesign(design);
    const loaded = new ShipDesignManager(store).load().designs[0];
    expect(loaded).toEqual(saved);
    expect(new Date(loaded.createdAt).toISOString()).toBe(design.createdAt);
    expect(calculateShipStats(loaded)).toEqual(calculateShipStats(design));
    loaded.slots[0].component!.name = 'Changed externally';
    expect(repository.load().designs[0].slots[0].component?.name).toBe('Лазер');
  });

  it('saves multiple designs, updates only matching id, and keeps catalogue separate', () => {
    const repository = new ShipDesignManager(storage());
    const first = createDesign('fighter', true);
    const second = createDesign('corvette', true);
    repository.saveDesign(first); repository.saveDesign(second);
    repository.saveDesign({ ...first, name: 'Renamed' });
    repository.saveComponents([createComponent('beam')]);
    expect(repository.load().designs.map(item => item.name)).toEqual(['Renamed', second.name]);
    expect(repository.load().components).toHaveLength(1);
  });

  it('saves and loads incomplete drafts', () => {
    const repository = new ShipDesignManager(storage());
    repository.saveDesign(createDesign());
    expect(repository.load().designs[0].slots.every(slot => slot.component === null)).toBe(true);
  });

  it.each(['{broken', '{"schemaVersion":999,"designs":[],"components":[]}'])('does not erase unreadable storage: %s', raw => {
    const store = storage();
    store.setItem(ShipDesignManager.STORAGE_KEY, raw);
    const repository = new ShipDesignManager(store);
    expect(() => repository.load()).toThrow();
    expect(() => repository.saveDesign(createDesign())).toThrow();
    expect(store.getItem(ShipDesignManager.STORAGE_KEY)).toBe(raw);
  });

  it('propagates quota/access errors rather than claiming success', () => {
    const store = storage();
    vi.spyOn(store, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    expect(() => new ShipDesignManager(store).saveDesign(createDesign())).toThrow('Quota exceeded');
    expect(store.data.size).toBe(0);
  });

  it('validates imports before writing and does not overwrite conflicting designs', () => {
    const store = storage();
    const repository = new ShipDesignManager(store);
    const saved = repository.saveDesign(createDesign('corvette', true));
    const before = store.getItem(ShipDesignManager.STORAGE_KEY);
    expect(() => repository.importJSON(JSON.stringify({ schemaVersion: 2, designs: [{ ...saved, name: 'Conflict' }], components: [] }))).toThrow('уже существует');
    expect(() => repository.importJSON(JSON.stringify({ schemaVersion: 2, designs: [{ ...saved, hullId: 'fake' }], components: [] }))).toThrow();
    expect(store.getItem(ShipDesignManager.STORAGE_KEY)).toBe(before);
  });

  it('exports/imports a library losslessly and idempotently', () => {
    const first = new ShipDesignManager(storage());
    first.saveDesign(createDesign('corvette', true));
    first.saveComponents([createComponent('shield')]);
    const second = new ShipDesignManager(storage());
    second.importJSON(first.exportJSON());
    second.importJSON(first.exportJSON());
    expect(second.load()).toEqual(first.load());
  });

  it('migrates old unversioned saves while retaining their original keys', () => {
    const store = storage();
    const now = new Date().toISOString();
    const oldWeapon = { id: 'old-beam', name: 'Старый лазер', weaponType: 'beam', damage: 25, range: 500, fireRate: 2, accuracy: 0.8, mass: 999999 };
    const legacy = JSON.stringify([{ id: 'old-design', name: 'Архив', hull: { size: 'corvette' }, created: now, modified: now,
      slots: [{ id: 'weapon_1', equipment: oldWeapon }, { id: 'sensor_1' }] }]);
    store.setItem('orion_ship_configs', legacy);
    const repository = new ShipDesignManager(store);
    const design = repository.load().designs[0];
    expect(design.slots[0].component?.kind).toBe('beam');
    expect(calculateShipStats(design).mass).toBe(95);
    repository.saveDesign(design);
    expect(store.getItem('orion_ship_configs')).toBe(legacy);
  });

  it('refuses legacy modules with unsupported mechanics instead of silently dropping them', () => {
    expect(() => migrateLegacyComponent({ id: 'x', name: 'Броня', armorPoints: 100, repairRate: 2,
      beamResistance: 0, projectileResistance: 0 })).toThrow('ручного переноса');
  });
});