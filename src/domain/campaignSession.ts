import { z } from 'zod';
import { campaignCommandSchema, campaignStateSchema, createCampaignState, executeCampaignCommand,
  areSystemsAdjacent, factionIdSchema, systemIdSchema, getCampaignView, type CampaignErrorCode, type CampaignFactionId,
  type CampaignState, type CampaignView } from './campaign';
import { treasurySchema, type Treasury } from './campaignEconomy';
import { designSchema, validateDesign } from './shipDesign';
import { advanceShipTravel, campaignShipsSchema, CAMPAIGN_FUEL_CAPACITY, getRefuelQuote,
  MAX_CAMPAIGN_SHIPS, TRAVEL_FUEL_COST, type CampaignShip } from './campaignShips';
import { advanceProduction, createProductionState, getProductionQuote, getProductionRefund,
  MAX_COLONY_QUEUE, MAX_ORDER_ID, MAX_PRODUCTION_RECORDS, orderIdSchema, productionStateSchema,
  type ProductionView } from './production';
export { MAX_RESOURCE, treasurySchema, type Treasury } from './campaignEconomy';

// Provisional economy, deliberately separate from tactical energy, cargo and service modules.
export const MAX_TURN = 1_000_000_000;
const turnSchema = z.number().int().min(1).max(MAX_TURN);
const initialTreasury: Readonly<Treasury> = { credits: 100, minerals: 50 };
const colonyIncome: Readonly<Treasury> = { credits: 10, minerals: 5 };

/** Turn is a single side's action window: odd=blue, even=red. No duplicated active-side field. */
export const campaignSessionSchema = z.object({
  galaxy: campaignStateSchema,
  turn: turnSchema,
  treasuries: z.object({ blue: treasurySchema, red: treasurySchema }).strict(),
  production: productionStateSchema,
  ships: campaignShipsSchema
}).strict().superRefine((state, ctx) => {
  for (const record of [...state.production.orders, ...state.production.completed]) {
    if (state.galaxy.systems.find(system => system.id === record.systemId)?.ownerId !== record.factionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Производственная запись требует собственную колонию' });
    }
  }
  const productionIds = new Set([...state.production.orders, ...state.production.completed].map(record => record.id));
  for (const ship of state.ships) {
    if (productionIds.has(ship.id) || ship.id > state.production.lastOrderId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Корабль требует отдельный ранее выданный идентификатор производства' });
    }
    // Travel is restricted to own colonies at both ends; capture is not implemented.
    if (state.galaxy.systems.find(system => system.id === ship.systemId)?.ownerId !== ship.factionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Размещённый корабль требует собственную колонию' });
    }
    if (ship.transit && state.galaxy.systems.find(system => system.id === ship.transit!.destinationId)?.ownerId !== ship.factionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Цель перелёта требует собственную колонию' });
    }
  }
});
export type CampaignSession = z.infer<typeof campaignSessionSchema>;

export function createCampaignSession(): CampaignSession {
  return { galaxy: createCampaignState(), turn: 1,
    treasuries: { blue: { ...initialTreasury }, red: { ...initialTreasury } }, production: createProductionState(), ships: [] };
}

export const sessionCommandSchema = z.discriminatedUnion('kind', [
  campaignCommandSchema.options[0].extend({ expectedTurn: turnSchema }),
  campaignCommandSchema.options[1].extend({ expectedTurn: turnSchema }),
  z.object({ kind: z.literal('endTurn'), factionId: factionIdSchema, expectedTurn: turnSchema }).strict(),
  z.object({ kind: z.literal('enqueueProduction'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, design: designSchema }).strict(),
  z.object({ kind: z.literal('cancelProduction'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, orderId: orderIdSchema }).strict(),
  z.object({ kind: z.literal('deployProduction'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, orderId: orderIdSchema }).strict(),
  z.object({ kind: z.literal('sendShip'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, shipId: orderIdSchema, destinationId: systemIdSchema }).strict(),
  z.object({ kind: z.literal('refuelShip'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, shipId: orderIdSchema }).strict()
]);
export type SessionCommand = z.infer<typeof sessionCommandSchema>;
export type SessionErrorCode = CampaignErrorCode | 'STALE_TURN' | 'NOT_ACTIVE_FACTION' | 'RESOURCE_LIMIT' | 'TURN_LIMIT' |
  'NOT_OWN_COLONY' | 'INVALID_DESIGN' | 'INSUFFICIENT_RESOURCES' | 'QUEUE_FULL' | 'PRODUCTION_LIMIT' | 'ORDER_NOT_FOUND' | 'ORDER_ID_LIMIT' |
  'COMPLETED_NOT_FOUND' | 'SHIP_LIMIT' | 'SHIP_NOT_FOUND' | 'SHIP_IN_TRANSIT' | 'INVALID_ROUTE' | 'INSUFFICIENT_FUEL' | 'FUEL_FULL';
export type SessionResult = { ok: true; state: CampaignSession } |
  { ok: false; code: SessionErrorCode; message: string };

function activeFaction(turn: number): CampaignFactionId { return turn % 2 === 1 ? 'blue' : 'red'; }

/** Only called on validated state. Income is derived, never cached in persistent state. */
function incomeFor(galaxy: CampaignState, factionId: CampaignFactionId): Treasury {
  const colonies = galaxy.systems.filter(system => system.ownerId === factionId).length;
  return { credits: colonies * colonyIncome.credits, minerals: colonies * colonyIncome.minerals };
}

/** Pure session boundary. Callers must keep the returned state; this is not network deduplication. */
export function executeSessionCommand(inputState: unknown, inputCommand: unknown): SessionResult {
  const parsedState = campaignSessionSchema.safeParse(inputState);
  if (!parsedState.success) return { ok: false, code: 'INVALID_STATE', message: 'Недопустимое состояние стратегической партии' };
  const parsedCommand = sessionCommandSchema.safeParse(inputCommand);
  if (!parsedCommand.success) return { ok: false, code: 'INVALID_COMMAND', message: 'Недопустимая стратегическая команда' };
  const state = parsedState.data;
  const command = parsedCommand.data;
  if (command.expectedTurn !== state.turn) {
    return { ok: false, code: 'STALE_TURN', message: 'Номер хода изменился; обновите состояние перед командой' };
  }
  if (command.factionId !== activeFaction(state.turn)) {
    return { ok: false, code: 'NOT_ACTIVE_FACTION', message: 'Сейчас ход другой стороны' };
  }
  if (command.kind === 'sendShip' || command.kind === 'refuelShip') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Операция корабля доступна только в своей колонии' };
    }
    const ship = state.ships.find(item => item.id === command.shipId && item.factionId === command.factionId && item.systemId === command.systemId);
    if (!ship) return { ok: false, code: 'SHIP_NOT_FOUND', message: 'Свой корабль не найден в указанной системе' };
    if (ship.transit) return { ok: false, code: 'SHIP_IN_TRANSIT', message: 'Корабль уже в пути' };
    if (command.kind === 'refuelShip') {
      const quote = getRefuelQuote(ship.fuel), treasury = state.treasuries[command.factionId];
      if (quote.amount === 0) return { ok: false, code: 'FUEL_FULL', message: 'Топливный бак уже полон' };
      if (treasury.credits < quote.cost.credits || treasury.minerals < quote.cost.minerals) {
        return { ok: false, code: 'INSUFFICIENT_RESOURCES', message: 'Недостаточно ресурсов для полной заправки' };
      }
      treasury.credits -= quote.cost.credits; treasury.minerals -= quote.cost.minerals;
      ship.fuel = CAMPAIGN_FUEL_CAPACITY;
      return { ok: true, state };
    }
    if (state.galaxy.systems.find(system => system.id === command.destinationId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Перелёт доступен только в свою колонию' };
    }
    if (!areSystemsAdjacent(command.systemId, command.destinationId)) {
      return { ok: false, code: 'INVALID_ROUTE', message: 'Нужен прямой переход в другую собственную колонию' };
    }
    if (ship.fuel < TRAVEL_FUEL_COST) {
      return { ok: false, code: 'INSUFFICIENT_FUEL', message: 'Недостаточно стратегического топлива; нужна заправка' };
    }
    ship.fuel -= TRAVEL_FUEL_COST;
    ship.transit = { destinationId: command.destinationId, remainingTurns: 1 };
    return { ok: true, state };
  }
  if (command.kind === 'deployProduction') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Размещение доступно только в своей колонии' };
    }
    const index = state.production.completed.findIndex(record => record.id === command.orderId &&
      record.factionId === command.factionId && record.systemId === command.systemId);
    if (index < 0) return { ok: false, code: 'COMPLETED_NOT_FOUND', message: 'Готовый проект не найден в колонии' };
    if (state.ships.filter(ship => ship.factionId === command.factionId).length >= MAX_CAMPAIGN_SHIPS) {
      return { ok: false, code: 'SHIP_LIMIT', message: 'Достигнут предел стратегических кораблей стороны' };
    }
    // parsedState is detached; transfer exactly once, retaining the original ID/design/location.
    const [completed] = state.production.completed.splice(index, 1);
    state.ships.push({ ...completed, fuel: CAMPAIGN_FUEL_CAPACITY });
    return { ok: true, state };
  }
  if (command.kind === 'enqueueProduction' || command.kind === 'cancelProduction') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Производство доступно только в своей колонии' };
    }
    const production = state.production, treasury = state.treasuries[command.factionId];
    if (command.kind === 'enqueueProduction') {
      if (validateDesign(command.design, 'flight').length) return { ok: false, code: 'INVALID_DESIGN', message: 'Нужен допустимый полётный проект' };
      if (production.orders.filter(order => order.systemId === command.systemId).length >= MAX_COLONY_QUEUE) {
        return { ok: false, code: 'QUEUE_FULL', message: 'Очередь колонии заполнена' };
      }
      if ([...production.orders, ...production.completed].filter(record => record.factionId === command.factionId).length >= MAX_PRODUCTION_RECORDS) {
        return { ok: false, code: 'PRODUCTION_LIMIT', message: 'Достигнут предел производственных записей стороны' };
      }
      if (production.lastOrderId === MAX_ORDER_ID) return { ok: false, code: 'ORDER_ID_LIMIT', message: 'Достигнут предел идентификаторов заказов' };
      const quote = getProductionQuote(command.design);
      if (treasury.credits < quote.cost.credits || treasury.minerals < quote.cost.minerals) {
        return { ok: false, code: 'INSUFFICIENT_RESOURCES', message: 'Недостаточно ресурсов для заказа' };
      }
      treasury.credits -= quote.cost.credits; treasury.minerals -= quote.cost.minerals;
      production.orders.push({ id: ++production.lastOrderId, factionId: command.factionId, systemId: command.systemId,
        design: command.design, remainingTurns: quote.turns });
    } else {
      const index = production.orders.findIndex(order => order.id === command.orderId && order.systemId === command.systemId && order.factionId === command.factionId);
      if (index < 0) return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Заказ не найден в очереди колонии' };
      const refund = getProductionRefund(production.orders[index]);
      const next = { credits: treasury.credits + refund.credits, minerals: treasury.minerals + refund.minerals };
      if (!treasurySchema.safeParse(next).success) return { ok: false, code: 'RESOURCE_LIMIT', message: 'Возврат превысит предел ресурсов; заказ не отменён' };
      state.treasuries[command.factionId] = next;
      production.orders.splice(index, 1);
    }
    return { ok: true, state };
  }
  if (command.kind === 'explore' || command.kind === 'colonize') {
    // Reuse all map rules without passing the session-only field to the strict map schema.
    const result = executeCampaignCommand(state.galaxy, {
      kind: command.kind, factionId: command.factionId, systemId: command.systemId
    });
    if (!result.ok) return result;
    state.galaxy = result.state;
    return { ok: true, state };
  }
  if (state.turn === MAX_TURN) return { ok: false, code: 'TURN_LIMIT', message: 'Достигнут предел номера хода' };
  const income = incomeFor(state.galaxy, command.factionId);
  const treasury = state.treasuries[command.factionId];
  const next = { credits: treasury.credits + income.credits, minerals: treasury.minerals + income.minerals };
  if (!treasurySchema.safeParse(next).success) {
    return { ok: false, code: 'RESOURCE_LIMIT', message: 'Доход превысит предел ресурсов; ход не завершён' };
  }
  state.treasuries[command.factionId] = next;
  state.production = advanceProduction(state.production, command.factionId);
  state.ships = advanceShipTravel(state.ships, command.factionId);
  state.turn += 1;
  return { ok: true, state };
}

export interface CampaignSessionView {
  galaxy: CampaignView;
  turn: number;
  activeFactionId: CampaignFactionId;
  treasury: Treasury;
  income: Treasury;
  production: ProductionView;
  ships: CampaignShip[];
}

/** Detached faction view: no opponent treasury/income, even if its colonies are explored.
 * Invalid queries throw ZodError; commands instead return typed failure results.
 */
export function getCampaignSessionView(inputState: CampaignSession, factionId: CampaignFactionId): CampaignSessionView {
  const state = campaignSessionSchema.parse(inputState);
  const faction = factionIdSchema.parse(factionId);
  return { galaxy: getCampaignView(state.galaxy, faction), turn: state.turn,
    activeFactionId: activeFaction(state.turn), treasury: { ...state.treasuries[faction] },
    income: incomeFor(state.galaxy, faction), production: {
      orders: state.production.orders.filter(order => order.factionId === faction),
      completed: state.production.completed.filter(record => record.factionId === faction)
    }, ships: state.ships.filter(ship => ship.factionId === faction) };
}
