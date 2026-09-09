import { describe, expect, it } from 'vitest';
import { createDesign, createComponent, designSchema, installComponent } from '../src/domain/shipDesign';
import { hasUnsavedDesign } from '../src/domain/shipDraft';

describe('persisted design comparison', () => {
  it('treats a brand-new project as unsaved and an independent saved copy as clean', () => {
    const design = createDesign('corvette', true);
    expect(hasUnsavedDesign(design)).toBe(true);
    expect(hasUnsavedDesign(design, designSchema.parse(design))).toBe(false);
  });

  it('ignores only updatedAt and slot ordering without mutating either input', () => {
    const saved = createDesign('corvette', true);
    const draft = { ...designSchema.parse(saved), updatedAt: '2026-09-08T00:00:00.000Z' };
    draft.slots.reverse();
    const before = JSON.stringify([draft, saved]);
    expect(hasUnsavedDesign(draft, saved)).toBe(false);
    expect(JSON.stringify([draft, saved])).toBe(before);
  });

  it.each(['name', 'hull', 'component', 'slot', 'identity', 'createdAt'] as const)('detects changed %s', field => {
    const saved = createDesign('corvette', true);
    const draft = designSchema.parse(saved);
    switch (field) {
      case 'name': draft.name = 'Renamed'; break;
      case 'hull': draft.hullId = 'frigate'; break;
      case 'component': draft.slots[0].component!.name = 'New module'; break;
      case 'slot': draft.slots[0].component = null; break;
      case 'identity': draft.id = 'copy'; break;
      case 'createdAt': draft.createdAt = '2026-09-01T00:00:00.000Z'; break;
    }
    expect(hasUnsavedDesign(draft, saved)).toBe(true);
  });

  it('becomes clean when content is reverted despite edit timestamps', () => {
    const saved = createDesign('corvette', true);
    const modified = installComponent(saved, 'beam_2', createComponent('beam'));
    expect(hasUnsavedDesign(modified, saved)).toBe(true);
    expect(hasUnsavedDesign(installComponent(modified, 'beam_2', null), saved)).toBe(false);
  });
});