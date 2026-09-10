import { decodeCampaignRunSave, encodeCampaignRunSave, type CampaignRunSaveFailure,
  type DecodeCampaignRunSaveResult } from '../domain/campaignRunSave';
import { CampaignSaveManager, type CampaignStorageErrorCode, type CampaignStorageFailure } from './CampaignSaveManager';
import type { StoragePort } from './ShipDesignManager';

export type { CampaignStorageErrorCode, CampaignStorageFailure } from './CampaignSaveManager';
export type LoadCampaignRunResult = DecodeCampaignRunSaveResult | CampaignStorageFailure;
export type SaveCampaignRunResult = { ok: true } | CampaignRunSaveFailure | CampaignStorageFailure;

const messages: Record<CampaignStorageErrorCode, string> = {
  SAVE_NOT_FOUND: 'Сохранение кампании не найдено',
  STORAGE_READ_FAILED: 'Не удалось прочитать сохранение кампании',
  STORAGE_WRITE_FAILED: 'Не удалось записать кампанию: хранилище недоступно или заполнено'
};
function failure(code: CampaignStorageErrorCode): CampaignStorageFailure {
  return { ok: false, code, message: messages[code] };
}

/** Explicit full-run access to the shared legacy slot, not a second save slot.
 * The synchronous port must set atomically or throw without changing its previous bytes.
 * No repair, rollback, automatic migration writes or AI execution. Overwrite confirmation
 * belongs to the caller; multiple instances are last-successful-writer-wins, not a transaction.
 */
export class CampaignRunSaveManager {
  // The legacy class has no import-time IO; its stable key is independent of schema version.
  static readonly STORAGE_KEY = CampaignSaveManager.STORAGE_KEY;

  constructor(private readonly providedStorage?: StoragePort) {}

  // Access to the global getter itself may throw; resolve afresh inside each operation's try.
  private get storage(): StoragePort { return this.providedStorage ?? globalThis.localStorage; }

  load(): LoadCampaignRunResult {
    let raw: string | null;
    try { raw = this.storage.getItem(CampaignRunSaveManager.STORAGE_KEY); }
    catch { return failure('STORAGE_READ_FAILED'); }
    return raw === null ? failure('SAVE_NOT_FOUND') : decodeCampaignRunSave(raw);
  }

  save(inputRun: unknown): SaveCampaignRunResult {
    // Even storage resolution is forbidden until the complete snapshot has been encoded.
    const encoded = encodeCampaignRunSave(inputRun);
    if (!encoded.ok) return encoded;
    try { this.storage.setItem(CampaignRunSaveManager.STORAGE_KEY, encoded.json); }
    catch { return failure('STORAGE_WRITE_FAILED'); }
    return { ok: true };
  }
}