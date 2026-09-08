import { z } from 'zod';

export const cargoItemSchema = z.object({
  resourceType: z.string().trim().min(1).max(80),
  amount: z.number().finite().positive().max(1e9),
  mass: z.number().finite().positive().max(1e9), // Total lot mass, tonnes.
  volume: z.number().finite().positive().max(1e9) // Total lot volume, cubic metres.
}).strict();
export type CargoItem = z.infer<typeof cargoItemSchema>;
export interface CargoLimits { mass: number; volume: number }
export type CargoResult = { ok: true; cargo: CargoItem[] } | { ok: false; message: string };

export function cargoTotals(cargo: readonly CargoItem[]): CargoLimits {
  return cargo.reduce((sum, item) => ({ mass: sum.mass + item.mass, volume: sum.volume + item.volume }), { mass: 0, volume: 0 });
}

/** Atomic operations on validated runtime lots; input arrays and items are never mutated. */
export function loadCargo(cargo: readonly CargoItem[], input: unknown, limits: CargoLimits): CargoResult {
  const parsed = cargoItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Недопустимый груз: нужны ресурс и положительные количество, масса и объём' };
  if (![limits.mass, limits.volume].every(value => Number.isFinite(value) && value >= 0)) {
    return { ok: false, message: 'Недопустимые ограничения трюма' };
  }
  if (cargo.length >= 1000) return { ok: false, message: 'Слишком много партий груза' };
  const used = cargoTotals(cargo);
  if (used.mass + parsed.data.mass > limits.mass) return { ok: false, message: 'Превышена грузоподъёмность' };
  if (used.volume + parsed.data.volume > limits.volume) return { ok: false, message: 'Недостаточно объёма трюма' };
  return { ok: true, cargo: [...cargo.map(item => ({ ...item })), parsed.data] };
}

/** FIFO across all lots of a resource, preserving each lot's mass and volume per unit. */
export function unloadCargo(cargo: readonly CargoItem[], resourceType: string, amount: number): CargoResult {
  if (typeof resourceType !== 'string' || !resourceType.trim() || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'Недопустимое количество для выгрузки' };
  }
  const resource = resourceType.trim();
  const available = cargo.filter(item => item.resourceType === resource).reduce((sum, item) => sum + item.amount, 0);
  if (available < amount) return { ok: false, message: 'Недостаточно указанного ресурса' };
  // Avoid a floating-point dust lot when unloading the exact summed quantity.
  if (amount === available) return { ok: true, cargo: cargo.filter(item => item.resourceType !== resource).map(item => ({ ...item })) };
  let remaining = amount;
  const next: CargoItem[] = [];
  for (const item of cargo) {
    if (item.resourceType !== resource || remaining <= 0) { next.push({ ...item }); continue; }
    const taken = Math.min(remaining, item.amount);
    remaining -= taken;
    if (taken < item.amount) {
      const fraction = (item.amount - taken) / item.amount;
      next.push({ ...item, amount: item.amount - taken, mass: item.mass * fraction, volume: item.volume * fraction });
    }
  }
  return { ok: true, cargo: next };
}
