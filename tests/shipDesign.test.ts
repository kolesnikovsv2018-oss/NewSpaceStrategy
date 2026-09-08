import { describe, expect, it } from 'vitest';
import { calculateComponent, calculateShipStats, componentSchema, createComponent, createDesign,
  designSchema, HULLS, installComponent, validateDesign } from '../src/domain/shipDesign';

describe('ShipDesign domain', () => {
  it.each(Object.keys(HULLS) as Array<keyof typeof HULLS>)('starter %s is valid and has hull-derived stats', hull => {
    const design = createDesign(hull, true);
    expect(validateDesign(design)).toEqual([]);
    expect(calculateShipStats(design).hitPoints).toBe(HULLS[hull].hitPoints);
  });

  it('computes weapon power as energy per shot times fire rate', () => {
    for (const kind of ['beam', 'projectile'] as const) {
      const weapon = createComponent(kind);
      if (weapon.kind !== 'beam' && weapon.kind !== 'projectile') throw new Error('Invalid fixture');
      const stats = calculateComponent(weapon);
      expect(stats.power).toBe(stats.energyPerShot * weapon.fireRate);
    }
  });

  it('counts engine generation once, not as negative consumption', () => {
    const design = createDesign('corvette', true);
    const stats = calculateShipStats(design);
    expect(stats.powerGeneration).toBe(600);
    expect(stats.movementPower).toBe(30);
    expect(stats.peakPower).toBe(230);
  });

  it('counts the entire ammunition mass', () => {
    const component = createComponent('projectile');
    if (component.kind !== 'projectile') throw new Error('Invalid fixture');
    expect(calculateComponent({ ...component, ammoCapacity: component.ammoCapacity + 10 }).mass)
      .toBeCloseTo(calculateComponent(component).mass + 10 * (component.damage * 0.1 + component.range * 0.002));
  });

  it('keeps catalogue, installed snapshots and sibling slots independent', () => {
    const original = createDesign('corvette', true);
    const component = createComponent('beam');
    const next = installComponent(original, 'beam_2', component);
    component.name = 'Changed catalogue';
    expect(original.slots.find(slot => slot.id === 'beam_2')?.component).toBeNull();
    expect(next.slots.find(slot => slot.id === 'beam_2')?.component?.name).toBe('Лазер');
    next.slots[0].component!.name = 'Changed design';
    expect(original.slots[0].component?.name).toBe('Лазер');
  });

  it('uses the same validator for public installation and deserialized data', () => {
    const design = createDesign();
    expect(() => installComponent(design, 'beam_1', createComponent('engine'))).toThrow('несовместимый');
    design.slots[0].component = createComponent('engine');
    expect(validateDesign(design).some(issue => issue.code === 'kind')).toBe(true);
  });

  it('rejects oversized components without changing the original design', () => {
    const design = createDesign('fighter');
    const weapon = componentSchema.parse({ ...createComponent('beam'), damage: 1000 });
    expect(() => installComponent(design, 'beam_1', weapon)).toThrow('слишком велик');
    expect(design.slots[0].component).toBeNull();
  });

  it('rejects total mass overflow even when individual components fit', () => {
    const design = createDesign('fighter', true);
    design.slots.find(slot => slot.id === 'projectile_1')!.component = createComponent('projectile');
    expect(validateDesign(design, 'draft').some(issue => issue.code === 'mass')).toBe(true);
  });

  it('allows incomplete drafts but blocks launch and energy deficit', () => {
    const design = createDesign();
    expect(validateDesign(design, 'draft')).toEqual([]);
    expect(validateDesign(design).map(issue => issue.code)).toEqual(['engine', 'power', 'weapon']);
    const ready = createDesign('corvette', true);
    ready.slots.find(slot => slot.id === 'engine_1')!.component = componentSchema.parse({ ...createComponent('engine'), powerGeneration: 10 });
    expect(validateDesign(ready).some(issue => issue.code === 'power')).toBe(true);
  });

  it('allows unarmed flight but not battle', () => {
    const design = installComponent(createDesign(), 'engine_1', createComponent('engine'));
    expect(validateDesign(design, 'flight')).toEqual([]);
    expect(validateDesign(design, 'battle').map(issue => issue.code)).toEqual(['weapon']);
  });

  it.each([NaN, Infinity, -1, 1.01])('rejects invalid ratio %s', accuracy => {
    expect(componentSchema.safeParse({ ...createComponent('beam'), accuracy }).success).toBe(false);
  });

  it('rejects unknown kinds, forged derived stats, duplicate and invented slots', () => {
    expect(componentSchema.safeParse({ ...createComponent('beam'), kind: 'cargo' }).success).toBe(false);
    expect(componentSchema.safeParse({ ...createComponent('beam'), mass: 0 }).success).toBe(false);
    const design = createDesign();
    expect(designSchema.safeParse({ ...design, slots: [...design.slots, design.slots[0]] }).success).toBe(false);
    design.slots[0].id = 'fake-slot';
    expect(validateDesign(design)[0].code).toBe('schema');
  });
});