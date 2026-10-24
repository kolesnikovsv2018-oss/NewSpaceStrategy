import { conquestSchema, type Conquest } from '../domain/conquest';
import { CampaignSaveManager } from './CampaignSaveManager';
import type { StoragePort } from './ShipDesignManager';
import { z } from 'zod';

const currentConquestSchema = conquestSchema;
export const CONQUEST_SAVE_VERSION = 10;
export const CONQUEST_RULES_VERSION = 7;
const saveSchema = z.object({ format: z.literal('orion-campaign'), schemaVersion: z.literal(10),
  rulesVersion: z.literal(7), conquest: currentConquestSchema }).strict();
const byteLimit = 5_000_000;
export function encodeConquestSave(input: unknown): string {
  const conquest = currentConquestSchema.parse(input);
  const json = JSON.stringify({ format: 'orion-campaign', schemaVersion: CONQUEST_SAVE_VERSION, rulesVersion: CONQUEST_RULES_VERSION, conquest });
  if (new TextEncoder().encode(json).length > byteLimit) throw new Error('Сохранение превышает 5 МБ');
  return json;
}
export function decodeConquestSave(input: unknown): Conquest {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > byteLimit) throw new Error('Недопустимый размер сохранения');
  return saveSchema.parse(JSON.parse(input)).conquest;
}
export class ConquestSaveManager {
  constructor(private readonly providedStorage?: StoragePort) {}
  load(): { ok: true; state: Conquest } | { ok: false; message: string } {
    try {
      const json = (this.providedStorage ?? globalThis.localStorage).getItem(CampaignSaveManager.STORAGE_KEY);
      if (json === null) return { ok: false, message: 'Сохранение отсутствует' };
      return { ok: true, state: decodeConquestSave(json) };
    } catch { return { ok: false, message: 'Не удалось загрузить кампанию: требуется актуальный формат 10/7. Мирные сохранения открываются на мирной карте.' }; }
  }
  save(input: unknown): { ok: true } | { ok: false; message: string } {
    try {
      const json = encodeConquestSave(input);
      (this.providedStorage ?? globalThis.localStorage).setItem(CampaignSaveManager.STORAGE_KEY, json);
      return { ok: true };
    } catch { return { ok: false, message: 'Не удалось сохранить кампанию; прежний слот не заменён' }; }
  }
}