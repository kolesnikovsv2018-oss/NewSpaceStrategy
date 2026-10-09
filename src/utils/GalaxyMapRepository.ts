import { decodeGalaxyMap, encodeGalaxyMap, type GalaxyMap } from '../domain/galaxyMap';
import type { StoragePort } from './ShipDesignManager';

export type GalaxyMapStorageFailure = { ok: false; message: string };
export type SaveGalaxyMapResult = { ok: true } | GalaxyMapStorageFailure;
export type LoadGalaxyMapResult = { ok: true; map: GalaxyMap } | GalaxyMapStorageFailure;

export interface GalaxyMapRepository {
  save(map: GalaxyMap): SaveGalaxyMapResult | Promise<SaveGalaxyMapResult>;
  load(): LoadGalaxyMapResult | Promise<LoadGalaxyMapResult>;
}

export class LocalGalaxyMapRepository implements GalaxyMapRepository {
  static readonly STORAGE_KEY = 'orion_galaxy_map_v1';
  constructor(private readonly providedStorage?: StoragePort) {}

  save(map: GalaxyMap): SaveGalaxyMapResult {
    const encoded = encodeGalaxyMap(map);
    if (!encoded.ok) return { ok: false, message: encoded.message };
    try {
      (this.providedStorage ?? globalThis.localStorage).setItem(LocalGalaxyMapRepository.STORAGE_KEY, encoded.json);
      return { ok: true };
    } catch {
      return { ok: false, message: 'Не удалось сохранить карту. Новая кампания не запущена; проверьте доступ к хранилищу и свободное место.' };
    }
  }

  load(): LoadGalaxyMapResult {
    let json: string | null;
    try {
      json = (this.providedStorage ?? globalThis.localStorage).getItem(LocalGalaxyMapRepository.STORAGE_KEY);
    } catch {
      return { ok: false, message: 'Не удалось прочитать последнюю карту галактики' };
    }
    if (json === null) return { ok: false, message: 'Сохранённая карта отсутствует' };
    const decoded = decodeGalaxyMap(json);
    return decoded.ok ? { ok: true, map: decoded.map } : { ok: false, message: decoded.message };
  }
}
