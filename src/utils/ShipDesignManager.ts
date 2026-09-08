import { z } from 'zod';
import { componentSchema, designSchema, createDesign, validateDesign,
  type ComponentDefinition, type ShipDesign } from '../domain/shipDesign';

const workspaceSchema = z.object({
  schemaVersion: z.literal(1),
  designs: z.array(designSchema).max(100),
  components: z.array(componentSchema).max(200)
}).strict().superRefine((state, ctx) => {
  for (const entries of [state.designs, state.components]) {
    if (new Set(entries.map(item => item.id)).size !== entries.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Повторяющиеся идентификаторы в библиотеке' });
    }
  }
});
export type ShipyardLibrary = z.infer<typeof workspaceSchema>;
export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function assertDraft(design: ShipDesign): void {
  const errors = validateDesign(design, 'draft');
  if (errors.length) throw new Error(errors.map(error => error.message).join('\n'));
}

/** Only the old unversioned editor format is inferred. Unsupported data is never silently lost. */
export function migrateLegacyComponent(input: unknown): ComponentDefinition {
  const old = z.record(z.unknown()).parse(input);
  const identity = { id: old.id, name: old.name };
  const weapon = { damage: old.damage, range: old.range, fireRate: old.fireRate, accuracy: old.accuracy };
  if (old.weaponType === 'beam') return componentSchema.parse({ ...identity, kind: 'beam', ...weapon });
  if (old.weaponType === 'projectile') {
    const projectile = z.record(z.unknown()).parse(old.projectile);
    return componentSchema.parse({ ...identity, kind: 'projectile', ...weapon,
      damage: projectile.damage, range: projectile.range, ammoCapacity: old.ammoCapacity });
  }
  if ('thrust' in old) return componentSchema.parse({ ...identity, kind: 'engine', thrust: old.thrust,
    maxSpeed: old.maxSpeed, maneuverability: old.maneuverability, powerGeneration: old.powerGeneration });
  if ('rechargeRate' in old) return componentSchema.parse({ ...identity, kind: 'shield', capacity: old.capacity,
    rechargeRate: old.rechargeRate, rechargeDelay: old.rechargeDelay, beamResistance: old.beamResistance });
  if ('armorPoints' in old) {
    if (Number(old.repairRate ?? 0) > 0 || Number(old.durability ?? 0) > 0) {
      throw new Error('Старая броня с прочностью/саморемонтом требует ручного переноса; исходные данные сохранены');
    }
    return componentSchema.parse({ ...identity, kind: 'armor', armorPoints: old.armorPoints,
      beamResistance: old.beamResistance, projectileResistance: old.projectileResistance });
  }
  throw new Error('Не поддерживается тип старого компонента; исходные данные не изменены');
}

export function migrateLegacyDesign(input: unknown): ShipDesign {
  const old = z.object({ id: z.string(), name: z.string(), hull: z.object({ size: z.enum(['fighter', 'corvette', 'frigate', 'destroyer', 'cruiser', 'battleship']) }),
    created: z.string().datetime(), modified: z.string().datetime(),
    slots: z.array(z.object({ id: z.string(), equipment: z.unknown().optional() })) }).parse(input);
  const design = createDesign(old.hull.size);
  Object.assign(design, { id: old.id, name: old.name, createdAt: old.created, updatedAt: old.modified });
  const ids: Record<string, string> = { weapon_1: 'beam_1', weapon_2: 'beam_2', projectile_weapon_1: 'projectile_1',
    engine_1: 'engine_1', shield_1: 'shield_1', armor_1: 'armor_1' };
  const installed = new Set<string>();
  for (const oldSlot of old.slots) {
    if (oldSlot.equipment == null) continue;
    const slot = design.slots.find(item => item.id === ids[oldSlot.id]);
    if (!slot || installed.has(slot.id)) throw new Error(`Не удаётся перенести слот ${oldSlot.id}; исходные данные сохранены`);
    installed.add(slot.id);
    slot.component = migrateLegacyComponent(oldSlot.equipment);
  }
  assertDraft(design);
  return designSchema.parse(design);
}

/** One versioned document makes each save atomic. Corrupt data is never overwritten with defaults. */
export class ShipDesignManager {
  static readonly STORAGE_KEY = 'orion_shipyard_v1';
  constructor(private readonly providedStorage?: StoragePort) {}
  private get storage(): StoragePort { return this.providedStorage ?? globalThis.localStorage; }

  load(): ShipyardLibrary {
    const raw = this.storage.getItem(ShipDesignManager.STORAGE_KEY);
    if (raw !== null) return this.decode(raw);
    const oldDesigns = this.storage.getItem('orion_ship_configs');
    const oldComponents = this.storage.getItem('orion_components');
    // Retain old keys unchanged even after the first successful new save.
    return this.check({ schemaVersion: 1,
      designs: oldDesigns === null ? [] : z.array(z.unknown()).max(100).parse(JSON.parse(oldDesigns)).map(migrateLegacyDesign),
      components: oldComponents === null ? [] : z.array(z.unknown()).max(200).parse(JSON.parse(oldComponents)).map(migrateLegacyComponent)
    });
  }

  private check(input: unknown): ShipyardLibrary {
    const library = workspaceSchema.parse(input);
    library.designs.forEach(assertDraft);
    return library;
  }

  decode(json: string): ShipyardLibrary {
    if (json.length > 5_000_000) throw new Error('Файл библиотеки превышает 5 МБ');
    return this.check(JSON.parse(json));
  }

  saveDesign(input: ShipDesign): ShipDesign {
    const design = designSchema.parse(input);
    assertDraft(design);
    design.updatedAt = new Date().toISOString();
    const library = this.load();
    const index = library.designs.findIndex(item => item.id === design.id);
    if (index === -1) library.designs.push(design);
    else library.designs[index] = design;
    this.write(library);
    return designSchema.parse(design);
  }

  saveComponents(components: ComponentDefinition[]): void {
    const library = this.load();
    library.components = components;
    this.write(library);
  }

  exportJSON(): string { return JSON.stringify(this.load(), null, 2); }

  importJSON(json: string): void {
    const incoming = this.decode(json);
    const current = this.load();
    for (const design of incoming.designs) {
      const old = current.designs.find(item => item.id === design.id);
      if (old && JSON.stringify(old) !== JSON.stringify(design)) throw new Error(`Проект ${design.name} уже существует с другими данными`);
      if (!old) current.designs.push(design);
    }
    for (const component of incoming.components) {
      const old = current.components.find(item => item.id === component.id);
      if (old && JSON.stringify(old) !== JSON.stringify(component)) throw new Error(`Компонент ${component.name} уже существует с другими данными`);
      if (!old) current.components.push(component);
    }
    this.write(current);
  }

  private write(library: ShipyardLibrary): void {
    this.storage.setItem(ShipDesignManager.STORAGE_KEY, JSON.stringify(this.check(library)));
  }
}
