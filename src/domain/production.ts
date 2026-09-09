import { z } from 'zod';
import { factionIdSchema, systemIdSchema, type CampaignFactionId } from './campaign';
import { treasurySchema, type Treasury } from './campaignEconomy';
import { calculateShipStats, designSchema, validateDesign, type ShipDesign } from './shipDesign';

export const MAX_COLONY_QUEUE = 3;
export const MAX_PRODUCTION_RECORDS = 100; // Per faction: queued + completed, reserves completion capacity.
export const MAX_ORDER_ID = 1_000_000_000;
export const orderIdSchema = z.number().int().min(1).max(MAX_ORDER_ID);
export const flightDesignSchema = designSchema.refine(design => validateDesign(design, 'flight').length === 0,
  'Производству нужен допустимый полётный проект');

function quoteFor(design: ShipDesign): { cost: Treasury; turns: number } {
  const stats = calculateShipStats(design);
  const cost = treasurySchema.parse({ credits: Math.ceil(stats.cost / 100), minerals: Math.ceil(stats.mass / 10) });
  return { cost, turns: Math.max(1, Math.ceil(cost.credits / 50)) };
}

/** Query validates the same flight contract as civilian runtime; no clock, IDs or Phaser allocation. */
export function getProductionQuote(input: unknown): { cost: Treasury; turns: number } {
  return quoteFor(flightDesignSchema.parse(input));
}

const recordFields = { id: orderIdSchema, factionId: factionIdSchema, systemId: systemIdSchema, design: flightDesignSchema };
const orderSchema = z.object({ ...recordFields, remainingTurns: z.number().int().min(1).max(MAX_ORDER_ID) }).strict()
  .superRefine((order, ctx) => {
    if (order.remainingTurns > quoteFor(order.design).turns) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Прогресс выходит за срок проекта' });
    }
  });
const completedSchema = z.object(recordFields).strict();
export const productionStateSchema = z.object({
  lastOrderId: z.number().int().min(0).max(MAX_ORDER_ID),
  orders: z.array(orderSchema).max(MAX_PRODUCTION_RECORDS * 2),
  completed: z.array(completedSchema).max(MAX_PRODUCTION_RECORDS * 2)
}).strict().superRefine((state, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const records = [...state.orders, ...state.completed];
  if (new Set(records.map(record => record.id)).size !== records.length || records.some(record => record.id > state.lastOrderId)) {
    fail('Идентификаторы заказов должны быть уникальны и выданы счётчиком');
  }
  for (const faction of factionIdSchema.options) {
    if (records.filter(record => record.factionId === faction).length > MAX_PRODUCTION_RECORDS) fail('Превышен предел записей стороны');
  }
  // Array order is FIFO; require issuance order rather than trusting arbitrary reordered input.
  if (state.orders.some((order, index) => index > 0 && order.id <= state.orders[index - 1].id)) fail('Нарушен порядок очереди');
  const counts = new Map<string, number>();
  for (const order of state.orders) {
    const key = `${order.factionId}:${order.systemId}`, count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > MAX_COLONY_QUEUE) fail('Очередь колонии заполнена');
    if (count > 1 && order.remainingTurns !== quoteFor(order.design).turns) fail('Ожидающий заказ не может иметь прогресс');
  }
});
export type ProductionState = z.infer<typeof productionStateSchema>;
export type ProductionOrder = z.infer<typeof orderSchema>;
export type ProductionView = Pick<ProductionState, 'orders' | 'completed'>;

export function createProductionState(): ProductionState { return { lastOrderId: 0, orders: [], completed: [] }; }

/** Prorated unused turns, rounded down separately. Never refund spent production time. */
export function getProductionRefund(input: ProductionOrder): Treasury {
  const order = orderSchema.parse(input), quote = quoteFor(order.design);
  return { credits: Math.floor(quote.cost.credits * order.remainingTurns / quote.turns),
    minerals: Math.floor(quote.cost.minerals * order.remainingTurns / quote.turns) };
}

/** Detached FIFO step: one head per colony, no spillover to its next order this turn. */
export function advanceProduction(input: ProductionState, factionId: CampaignFactionId): ProductionState {
  const state = productionStateSchema.parse(input), faction = factionIdSchema.parse(factionId);
  const visited = new Set<string>();
  state.orders = state.orders.filter(order => {
    if (order.factionId !== faction || visited.has(order.systemId)) return true;
    visited.add(order.systemId);
    order.remainingTurns -= 1;
    if (order.remainingTurns > 0) return true;
    const { remainingTurns: _remaining, ...completed } = order;
    state.completed.push(completed);
    return false;
  });
  return state;
}
