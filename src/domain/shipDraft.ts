import { designSchema, type ShipDesign } from './shipDesign';

/** Compare persisted content, ignoring only the save/edit timestamp and slot ordering. */
function contentKey(input: ShipDesign): string {
  const { updatedAt: _updatedAt, ...design } = designSchema.parse(input);
  design.slots.sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(design);
}

/** New designs are unsaved even before the first edit. Baseline must come from a successful read/write. */
export function hasUnsavedDesign(design: ShipDesign, saved?: ShipDesign): boolean {
  return !saved || contentKey(design) !== contentKey(saved);
}