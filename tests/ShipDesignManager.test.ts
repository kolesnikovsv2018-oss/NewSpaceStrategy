import { describe, expect, it, vi } from 'vitest';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
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
    expect(() => repository.importJSON(JSON.stringify({ schemaVersion: 5, designs: [{ ...saved, name: 'Conflict' }], components: [] }))).toThrow('уже существует');
    expect(() => repository.importJSON(JSON.stringify({ schemaVersion: 5, designs: [{ ...saved, hullId: 'fake' }], components: [] }))).toThrow();
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

  it('reads only v3 and retains every older key verbatim on a fresh save', () => {
    const store = storage();
    const oldKeys = ['orion_shipyard_v2', 'orion_shipyard_v1', 'orion_ship_configs', 'orion_components'];
    oldKeys.forEach(key => store.setItem(key, `unreadable original ${key}`));
    const before = Array.from(store.data), get = vi.spyOn(store, 'getItem');
    const repository = new ShipDesignManager(store);
    expect(ShipDesignManager.STORAGE_KEY).toBe('orion_shipyard_v5');
    expect(repository.load()).toEqual({ schemaVersion: 5, designs: [], components: [] });
    repository.saveDesign(createDesign('corvette', true));
    expect(get.mock.calls).toEqual([[ShipDesignManager.STORAGE_KEY], [ShipDesignManager.STORAGE_KEY]]);
    expect(Array.from(store.data).filter(([key]) => key !== ShipDesignManager.STORAGE_KEY)).toEqual(before);
  });

  it.each([1, 2, 3, 999])('explicitly refuses library version %s before any IO', schemaVersion => {
    const store = storage(), get = vi.spyOn(store, 'getItem'), set = vi.spyOn(store, 'setItem');
    const repository = new ShipDesignManager(store);
    const json = JSON.stringify({ schemaVersion, designs: [], components: [] });
    expect(() => repository.decode(json)).toThrow('Версия формата библиотеки не поддерживается');
    expect(() => repository.importJSON(json)).toThrow('Версия формата библиотеки не поддерживается');
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });

  it.each(['design version', 'missing variant', 'unknown variant'])('does not repair %s inside the current library', damage => {
    const store = storage(), repository = new ShipDesignManager(store), design = createDesign('corvette', true);
    const component = design.slots.find(slot => slot.component)?.component;
    if (!component) throw Error('Expected component');
    const input = { schemaVersion: 5, designs: [design], components: [] };
    if (damage === 'design version') Reflect.set(design, 'schemaVersion', 2);
    if (damage === 'missing variant') Reflect.deleteProperty(component, 'technologyVariant');
    if (damage === 'unknown variant') Reflect.set(component, 'technologyVariant', 'future');
    expect(() => repository.importJSON(JSON.stringify(input))).toThrow();
    expect(store.data.size).toBe(0);
  });

  it('preserves explicit compact variants rather than granting or discarding them', () => {
    const repository = new ShipDesignManager(storage()), design = createDesign('corvette', true);
    const component = createComponent('beam'); component.technologyVariant = 'compact';
    design.slots[0].component = component;
    repository.saveDesign(design); repository.saveComponents([component]);
    const restored = new ShipDesignManager(storage()); restored.importJSON(repository.exportJSON());
    expect(restored.load()).toEqual(repository.load());
    expect(restored.load().components[0].technologyVariant).toBe('compact');
    expect(restored.load().designs[0].slots[0].component?.technologyVariant).toBe('compact');
  });

  it('keeps strict unique IDs and the 100-design/200-component limits on current imports', () => {
    const store = storage(), repository = new ShipDesignManager(store);
    const design = createDesign(), component = createComponent('beam');
    const current = { schemaVersion: 5,
      designs: Array.from({ length: 100 }, (_, index) => ({ ...design, id: `design-${index}` })),
      components: Array.from({ length: 200 }, (_, index) => ({ ...component, id: `component-${index}` })) };
    repository.importJSON(JSON.stringify(current)); expect(repository.load()).toEqual(current);
    const before = Array.from(store.data), set = vi.spyOn(store, 'setItem');
    for (const input of [
      { ...current, designs: [...current.designs, { ...design, id: 'extra-design' }] },
      { ...current, components: [...current.components, { ...component, id: 'extra-component' }] },
      { ...current, designs: [design, design] },
      { ...current, components: [component, component] },
      { ...current, extra: true }
    ]) expect(() => repository.importJSON(JSON.stringify(input))).toThrow();
    expect(set).not.toHaveBeenCalled(); expect(Array.from(store.data)).toEqual(before);
  });

  it('does not commit earlier appended records when a later component conflicts', () => {
    const store = storage(), repository = new ShipDesignManager(store), component = createComponent('beam');
    repository.saveComponents([component]); const before = Array.from(store.data), set = vi.spyOn(store, 'setItem');
    expect(() => repository.importJSON(JSON.stringify({ schemaVersion: 5, designs: [createDesign()],
      components: [{ ...component, name: 'Conflict' }] }))).toThrow('уже существует');
    expect(set).not.toHaveBeenCalled(); expect(Array.from(store.data)).toEqual(before);
  });

  it('measures the 5MB limit in UTF-8 before parsing and before writing', () => {
    const store = storage(), repository = new ShipDesignManager(store);
    const json = '{"schemaVersion":5,"designs":[],"components":[]}';
    const exact = json + ' '.repeat(5_000_000 - new TextEncoder().encode(json).byteLength);
    expect(repository.decode(exact)).toEqual({ schemaVersion: 5, designs: [], components: [] });
    const parse = vi.spyOn(JSON, 'parse');
    for (const text of [exact + ' ', 'я'.repeat(2_500_000) + '!']) expect(() => repository.decode(text)).toThrow('5 МБ');
    expect(parse).not.toHaveBeenCalled(); parse.mockRestore();
    const design = createDesign();
    design.createdAt = '2026-10-25T00:00:00.' + '0'.repeat(5_000_000) + 'Z';
    expect(() => repository.saveDesign(design)).toThrow('5 МБ');
    expect(store.data.size).toBe(0);
  });
});