import { z } from 'zod';
import { calculateShipStats, type ShipDesign } from './shipDesign';
import { getProductionQuote } from './production';

export const operationalStateSchema = z.object({
  hull: z.number().finite().positive(),
  ammunition: z.array(z.object({ slotId: z.string().min(1).max(128), amount: z.number().int().min(0).max(10000) }).strict()).max(8)
}).strict();
export type OperationalState = z.infer<typeof operationalStateSchema>;

export function createOperationalState(design: ShipDesign): OperationalState {
  const stats = calculateShipStats(design);
  return { hull: stats.hitPoints, ammunition: stats.weapons.flatMap(weapon =>
    weapon.definition.kind === 'projectile' ? [{ slotId: weapon.slotId, amount: weapon.definition.ammoCapacity }] : []) };
}

export function readOperationalState(input: unknown, design: ShipDesign): OperationalState {
  const state = operationalStateSchema.parse(input), maximum = createOperationalState(design);
  if (state.hull > maximum.hull || state.ammunition.length !== maximum.ammunition.length ||
    new Set(state.ammunition.map(item => item.slotId)).size !== state.ammunition.length || state.ammunition.some(item => {
      const limit = maximum.ammunition.find(weapon => weapon.slotId === item.slotId);
      return !limit || item.amount > limit.amount;
    })) throw new Error('Недопустимое оперативное состояние корабля');
  return state;
}

export function getRepairQuote(design: ShipDesign, operation: OperationalState, atColony: boolean, repairRate: number) {
  const maximum = createOperationalState(design);
  const amount = Math.min(maximum.hull - operation.hull, atColony ? maximum.hull : repairRate);
  return { amount, cost: { credits: Math.ceil(amount / 10), minerals: Math.ceil(amount / 25) } };
}

export function getAmmunitionQuote(design: ShipDesign, operation: OperationalState) {
  const maximum = createOperationalState(design);
  const amount = maximum.ammunition.reduce((sum, item) => sum + item.amount - operation.ammunition.find(weapon => weapon.slotId === item.slotId)!.amount, 0);
  return { amount, cost: { credits: amount, minerals: amount } };
}

export function getRefitQuote(oldDesign: ShipDesign, design: ShipDesign, creditsPerPoint: number) {
  if (oldDesign.hullId !== design.hullId) throw new Error('Переоснащение не меняет корпус');
  const old = getProductionQuote(oldDesign).cost, next = getProductionQuote(design).cost;
  const price = (value: number, previous: number) => Math.ceil(value / 4) + Math.max(0, value - previous);
  const cost = { credits: price(next.credits, old.credits), minerals: price(next.minerals, old.minerals) };
  return { cost, productionCost: Math.max(1, Math.ceil(cost.credits / creditsPerPoint)) };
}

export function getRefitOperationalState(oldDesign: ShipDesign, design: ShipDesign, input: OperationalState): OperationalState {
  const current = readOperationalState(input, oldDesign), maximum = createOperationalState(design);
  if (current.hull > maximum.hull) throw new Error('Новый предел HP ниже текущего корпуса');
  const ratings = ['damage', 'range', 'fireRate', 'accuracy', 'ammoCapacity'] as const;
  const previous = calculateShipStats(oldDesign), target = calculateShipStats(design);
  return { hull: current.hull, ammunition: maximum.ammunition.map(item => {
    const old = previous.weapons.find(weapon => weapon.slotId === item.slotId)?.definition;
    const next = target.weapons.find(weapon => weapon.slotId === item.slotId)?.definition;
    const same = old?.kind === 'projectile' && next?.kind === 'projectile' &&
      ratings.every(key => old[key] === next[key]);
    return { slotId: item.slotId, amount: same ? current.ammunition.find(weapon => weapon.slotId === item.slotId)!.amount : 0 };
  }) };
}