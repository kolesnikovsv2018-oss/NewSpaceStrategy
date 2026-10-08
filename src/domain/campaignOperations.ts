import { z } from 'zod';
import { calculateShipStats, type ShipDesign } from './shipDesign';

export const operationalStateSchema = z.object({
  hull: z.number().finite().positive(),
  ammunition: z.array(z.object({ slotId: z.string().min(1).max(128), amount: z.number().int().min(0).max(10000) }).strict()).max(8)
}).strict();
export type OperationalState = z.infer<typeof operationalStateSchema>;

export function createOperationalState(design: ShipDesign): OperationalState {
  return { hull: calculateShipStats(design).hitPoints, ammunition: design.slots.flatMap(slot =>
    slot.component?.kind === 'projectile' ? [{ slotId: slot.id, amount: slot.component.ammoCapacity }] : []) };
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