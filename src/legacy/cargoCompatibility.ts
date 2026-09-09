import type { CargoItem } from '../domain/cargo';
import type { ICargoItem } from '../entities/interfaces/ShipComponents';

/** Explicit boundary for the old total-lot weight field; never guess between mass and weight. */
export function legacyCargoLot(item: ICargoItem): unknown {
  if (!item || typeof item !== 'object') return undefined;
  return { resourceType: item.resourceType, amount: item.amount, mass: item.weight, volume: item.volume };
}

export function legacyCargoView(cargo: readonly CargoItem[]): ICargoItem[] {
  return cargo.map(({ mass, ...item }) => ({ ...item, weight: mass }));
}