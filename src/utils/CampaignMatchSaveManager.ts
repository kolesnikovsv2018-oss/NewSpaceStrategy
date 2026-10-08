import { decodeCampaignMatchSave, encodeCampaignMatchSave, type CampaignMatchSaveFailure,
  type DecodeCampaignMatchSaveResult } from '../domain/campaignMatchSave';
import { CampaignSaveManager, type CampaignStorageErrorCode, type CampaignStorageFailure } from './CampaignSaveManager';
import type { StoragePort } from './ShipDesignManager';

export type { CampaignStorageErrorCode, CampaignStorageFailure } from './CampaignSaveManager';
export type LoadCampaignMatchResult = DecodeCampaignMatchSaveResult | CampaignStorageFailure;
export type SaveCampaignMatchResult = { ok: true } | CampaignMatchSaveFailure | CampaignStorageFailure;

const messages: Record<CampaignStorageErrorCode, string> = {
  SAVE_NOT_FOUND: 'Сохранение кампании не найдено',
  STORAGE_READ_FAILED: 'Не удалось прочитать сохранение кампании',
  STORAGE_WRITE_FAILED: 'Не удалось записать кампанию: хранилище недоступно или заполнено'
};
function failure(code: CampaignStorageErrorCode): CampaignStorageFailure {
  return { ok: false, code, message: messages[code] };
}

export class CampaignMatchSaveManager {
  static readonly STORAGE_KEY = CampaignSaveManager.STORAGE_KEY;

  constructor(private readonly providedStorage?: StoragePort) {}

  private get storage(): StoragePort { return this.providedStorage ?? globalThis.localStorage; }

  load(): LoadCampaignMatchResult {
    let raw: string | null;
    try { raw = this.storage.getItem(CampaignMatchSaveManager.STORAGE_KEY); }
    catch { return failure('STORAGE_READ_FAILED'); }
    return raw === null ? failure('SAVE_NOT_FOUND') : decodeCampaignMatchSave(raw);
  }

  save(inputMatch: unknown): SaveCampaignMatchResult {
    const encoded = encodeCampaignMatchSave(inputMatch);
    if (!encoded.ok) return encoded;
    try { this.storage.setItem(CampaignMatchSaveManager.STORAGE_KEY, encoded.json); }
    catch { return failure('STORAGE_WRITE_FAILED'); }
    return { ok: true };
  }
}
