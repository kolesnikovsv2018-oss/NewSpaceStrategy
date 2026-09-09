import { decodeCampaignSave, encodeCampaignSave, type CampaignSaveFailure,
  type DecodeCampaignSaveResult } from '../domain/campaignSave';
import type { StoragePort } from './ShipDesignManager';

export type CampaignStorageErrorCode = 'SAVE_NOT_FOUND' | 'STORAGE_READ_FAILED' | 'STORAGE_WRITE_FAILED';
export interface CampaignStorageFailure { ok: false; code: CampaignStorageErrorCode; message: string }
export type LoadCampaignResult = DecodeCampaignSaveResult | CampaignStorageFailure;
export type SaveCampaignResult = { ok: true } | CampaignSaveFailure | CampaignStorageFailure;

const messages: Record<CampaignStorageErrorCode, string> = {
  SAVE_NOT_FOUND: 'Сохранение кампании не найдено',
  STORAGE_READ_FAILED: 'Не удалось прочитать сохранение кампании',
  STORAGE_WRITE_FAILED: 'Не удалось записать кампанию: хранилище недоступно или заполнено'
};
function failure(code: CampaignStorageErrorCode): CampaignStorageFailure {
  return { ok: false, code, message: messages[code] };
}

/** One explicit slot. The port must replace a value atomically or throw without changing it.
 * No read/repair on construction, no fallback keys, no scene state or library operations.
 * Overwrite confirmation is the caller's responsibility; this is not a multi-tab transaction.
 */
export class CampaignSaveManager {
  static readonly STORAGE_KEY = 'orion_campaign_v1';

  constructor(private readonly providedStorage?: StoragePort) {}

  // Resolve lazily inside each operation's try: accessing localStorage itself can throw.
  private get storage(): StoragePort { return this.providedStorage ?? globalThis.localStorage; }

  load(): LoadCampaignResult {
    let raw: string | null;
    try { raw = this.storage.getItem(CampaignSaveManager.STORAGE_KEY); }
    catch { return failure('STORAGE_READ_FAILED'); }
    return raw === null ? failure('SAVE_NOT_FOUND') : decodeCampaignSave(raw);
  }

  save(inputState: unknown): SaveCampaignResult {
    // Validate and serialize before even resolving storage; invalid input must not touch the slot.
    const encoded = encodeCampaignSave(inputState);
    if (!encoded.ok) return encoded;
    try { this.storage.setItem(CampaignSaveManager.STORAGE_KEY, encoded.json); }
    catch { return failure('STORAGE_WRITE_FAILED'); }
    return { ok: true };
  }
}