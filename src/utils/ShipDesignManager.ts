import { z } from 'zod';
import { componentSchema, designSchema, validateDesign,
  type ComponentDefinition, type ShipDesign } from '../domain/shipDesign';

const workspaceSchema = z.object({
  schemaVersion: z.literal(5),
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

function assertSize(json: string): void {
  if (json.length > 5_000_000 || new TextEncoder().encode(json).byteLength > 5_000_000) {
    throw new Error('Файл библиотеки превышает 5 МБ UTF-8');
  }
}

/** One versioned document makes each save atomic. Corrupt data is never overwritten with defaults. */
export class ShipDesignManager {
  static readonly STORAGE_KEY = 'orion_shipyard_v5';
  constructor(private readonly providedStorage?: StoragePort) {}
  private get storage(): StoragePort { return this.providedStorage ?? globalThis.localStorage; }

  load(): ShipyardLibrary {
    const raw = this.storage.getItem(ShipDesignManager.STORAGE_KEY);
    return raw === null ? this.check({ schemaVersion: 5, designs: [], components: [] }) : this.decode(raw);
  }

  private check(input: unknown): ShipyardLibrary {
    const library = workspaceSchema.parse(input);
    library.designs.forEach(assertDraft);
    return library;
  }

  decode(json: string): ShipyardLibrary {
    assertSize(json);
    const input: unknown = JSON.parse(json);
    const version = z.object({ schemaVersion: z.number() }).parse(input).schemaVersion;
    if (version !== 5) throw new Error('Версия формата библиотеки не поддерживается');
    return this.check(input);
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
    const json = JSON.stringify(this.check(library));
    assertSize(json);
    this.storage.setItem(ShipDesignManager.STORAGE_KEY, json);
  }
}
