import { describe, expect, it, vi } from 'vitest';
import { loadProductionCatalog } from '../src/utils/ProductionCatalog';
import { ShipDesignManager } from '../src/utils/ShipDesignManager';
import { createDesign } from '../src/domain/shipDesign';

describe('read-only production catalogue', () => {
  it('offers seven existing flight-valid presets when the library is empty, without writes', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const result = loadProductionCatalog(new ShipDesignManager(storage));
    expect(result.choices).toHaveLength(7); expect(result.choices.every(c => c.quote && !c.issue)).toBe(true);
    expect(result.notice).toContain('пуста'); expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('reads incomplete drafts with an explanation but without allowing a production quote', () => {
    const ship = createDesign();
    const storage = { getItem: vi.fn(() => JSON.stringify({ schemaVersion: 2, designs: [ship], components: [] })), setItem: vi.fn() };
    const result = loadProductionCatalog(new ShipDesignManager(storage));
    expect(result.choices).toHaveLength(8); const saved = result.choices[7];
    expect(saved.source).toBe('Библиотека'); expect(saved.quote).toBeUndefined(); expect(saved.issue).toContain('двигатель');
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('keeps canonical snapshot independent of later library edits and subsequent catalogue loads', () => {
    const ship = createDesign('corvette', true);
    const repository = { load: () => ({ schemaVersion: 2 as const, designs: [ship], components: [] }) };
    const first = loadProductionCatalog(repository); ship.name = 'Later';
    expect(first.choices[7].design.name).not.toBe('Later');
    const second = loadProductionCatalog(repository); expect(second.choices[7].design.name).toBe('Later');
    first.choices[7].design.slots[0].component = null;
    expect(second.choices[7].design.slots[0].component).not.toBeNull();
  });
  it.each(['corrupt', 'denied'])('reports %s storage while keeping presets, without repair or writes', failure => {
    const storage = { getItem: vi.fn(() => { if (failure === 'denied') throw Error('Denied'); return '{invalid'; }), setItem: vi.fn() };
    const result = loadProductionCatalog(new ShipDesignManager(storage));
    expect(result.choices).toHaveLength(7); expect(result.notice).toContain('недоступна или повреждена');
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
