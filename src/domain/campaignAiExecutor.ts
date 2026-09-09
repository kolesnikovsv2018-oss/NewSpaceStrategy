import { z } from 'zod';
import { factionIdSchema } from './campaign';
import { treasurySchema } from './campaignEconomy';
import { MAX_CAMPAIGN_SHIPS } from './campaignShips';
import { calculateEndTurnEconomy, getUpkeepQuote } from './campaignUpkeep';
import { campaignSessionSchema, executeSessionCommand, getCampaignSessionView, MAX_TURN, sessionCommandSchema,
  type CampaignSession, type CampaignSessionView, type EndTurnEconomy, type SessionErrorCode } from './campaignSession';
import { planAiTurn, type AiCommand, type AiObservation, type AiTurnRequest, type DeepReadonly } from './campaignAiPlanner';

export type AiTurnErrorCode = SessionErrorCode | 'AI_PLAN_INVALID' | 'AI_EXECUTION_FAILED';
export interface AiTurnSummary {
  factionId: AiTurnRequest['factionId'];
  turn: number;
  commands: AiCommand[];
  endTurnEconomy: EndTurnEconomy;
}
export type AiTurnResult = { ok: true; state: CampaignSession; summary: AiTurnSummary } |
  { ok: false; code: AiTurnErrorCode; message: string };

const turnSchema = z.number().int().min(1).max(MAX_TURN);
const requestSchema = z.object({ factionId: factionIdSchema, expectedTurn: turnSchema }).strict();
const planSchema = z.object({ commands: z.array(sessionCommandSchema).min(1).max(3) }).strict();
const countSchema = z.number().int().min(0).max(MAX_CAMPAIGN_SHIPS);
// EndTurnEconomy has no ok, treasuryBefore, completed orders or arrival fields.
const receiptSchema = z.object({ factionId: factionIdSchema, turn: turnSchema, income: treasurySchema,
  upkeep: z.object({ shipCount: countSchema, dueCredits: countSchema, paidCredits: countSchema,
    shortfallCredits: countSchema }).strict(), treasuryAfter: treasurySchema }).strict();

const messages: Record<AiTurnErrorCode, string> = {
  INVALID_STATE: 'Недопустимое состояние стратегической партии',
  INVALID_COMMAND: 'Недопустимый запрос AI-хода',
  STALE_TURN: 'Номер хода изменился; обновите состояние',
  NOT_ACTIVE_FACTION: 'Сейчас ход другой стороны',
  TURN_LIMIT: 'Достигнут предел номера хода',
  RESOURCE_LIMIT: 'Доход превысит предел ресурсов; AI-ход не выполнен',
  AI_PLAN_INVALID: 'Недопустимый план AI-хода',
  AI_EXECUTION_FAILED: 'Не удалось выполнить AI-ход',
  ALREADY_EXPLORED: 'Система уже разведана', OUT_OF_REACH: 'Нет доступного перехода',
  NOT_EXPLORED: 'Система не разведана', OCCUPIED: 'Система уже занята', UNINHABITABLE: 'Система непригодна',
  NOT_OWN_COLONY: 'Нужна собственная колония', INVALID_DESIGN: 'Недопустимый проект',
  INSUFFICIENT_RESOURCES: 'Недостаточно ресурсов', QUEUE_FULL: 'Очередь заполнена',
  PRODUCTION_LIMIT: 'Достигнут предел производства', ORDER_NOT_FOUND: 'Заказ не найден',
  ORDER_ID_LIMIT: 'Достигнут предел идентификаторов заказов', COMPLETED_NOT_FOUND: 'Готовый проект не найден',
  SHIP_LIMIT: 'Достигнут предел кораблей', SHIP_NOT_FOUND: 'Корабль не найден',
  SHIP_IN_TRANSIT: 'Корабль уже в пути', INVALID_ROUTE: 'Недопустимый маршрут',
  INSUFFICIENT_FUEL: 'Недостаточно топлива', FUEL_FULL: 'Топливный бак полон',
  SHIP_IN_FLEET: 'Корабль входит в группу', FLEET_LIMIT: 'Достигнут предел групп',
  FLEET_ID_LIMIT: 'Достигнут предел идентификаторов групп', FLEET_NOT_FOUND: 'Группа не найдена',
  FLEET_IN_TRANSIT: 'Группа уже в пути'
};
function failure(code: AiTurnErrorCode): Extract<AiTurnResult, { ok: false }> {
  // Never forward dependency exception text or an unexpected code as a covert transcript.
  if (!Object.prototype.hasOwnProperty.call(messages, code)) code = 'AI_EXECUTION_FAILED';
  return { ok: false, code, message: messages[code] };
}
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Explicit allowlist at every level; a typed assignment of the full view would leak runtime fields. */
function observation(view: CampaignSessionView): AiObservation {
  const forecast = view.economyForecast;
  return freeze({ turn: view.turn, activeFactionId: view.activeFactionId,
    galaxy: { factionId: view.galaxy.factionId,
      lanes: view.galaxy.lanes.map(([a, b]): [typeof a, typeof b] => [a, b]),
      systems: view.galaxy.systems.map(system => {
        const publicFields = { id: system.id, name: system.name, x: system.x, y: system.y };
        return system.visibility === 'unknown' ? { ...publicFields, visibility: 'unknown' as const } :
          { ...publicFields, visibility: 'explored' as const, ownerId: system.ownerId, habitable: system.habitable };
      }) },
    economyForecast: forecast.ok ? { ok: true as const,
      income: { credits: forecast.income.credits, minerals: forecast.income.minerals },
      upkeep: { shipCount: forecast.upkeep.shipCount, dueCredits: forecast.upkeep.dueCredits,
        paidCredits: forecast.upkeep.paidCredits, shortfallCredits: forecast.upkeep.shortfallCredits },
      treasuryAfter: { credits: forecast.treasuryAfter.credits, minerals: forecast.treasuryAfter.minerals }
    } : { ok: false as const, code: forecast.code }
  });
}

/** Parse and detach ALL commands before dispatch. Rank enforces uniqueness and exact ordering. */
function readPlan(input: unknown, request: AiTurnRequest): AiCommand[] | undefined {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const commands: AiCommand[] = [];
  let previous = 0;
  for (const command of parsed.data.commands) {
    if (command.factionId !== request.factionId || command.expectedTurn !== request.expectedTurn) return undefined;
    if (command.kind !== 'colonize' && command.kind !== 'explore' && command.kind !== 'endTurn') return undefined;
    const rank = command.kind === 'colonize' ? 1 : command.kind === 'explore' ? 2 : 3;
    if (rank <= previous) return undefined;
    previous = rank;
    commands.push(command);
  }
  return previous === 3 ? commands : undefined;
}

/** One synchronous transaction; no caller-supplied policy, partial state, IO or retry. */
export function executeAiTurn(inputState: unknown, inputRequest: unknown): AiTurnResult {
  let candidate: CampaignSession;
  try {
    const parsed = campaignSessionSchema.safeParse(inputState);
    if (!parsed.success) return failure('INVALID_STATE');
    candidate = parsed.data;
  } catch { return failure('INVALID_STATE'); }
  let request: AiTurnRequest;
  try {
    const parsed = requestSchema.safeParse(inputRequest);
    if (!parsed.success) return failure('INVALID_COMMAND');
    request = parsed.data;
  } catch { return failure('INVALID_COMMAND'); }
  if (request.expectedTurn !== candidate.turn) return failure('STALE_TURN');
  if (request.factionId !== (candidate.turn % 2 ? 'blue' : 'red')) return failure('NOT_ACTIVE_FACTION');
  try {
    const context = freeze({ factionId: request.factionId, expectedTurn: request.expectedTurn });
    const view = observation(getCampaignSessionView(candidate, request.factionId));
    const planned = planAiTurn(view, context);
    if (!planned.ok) return failure(planned.code);
    const commands = readPlan(planned.plan, request);
    if (!commands) return failure('AI_PLAN_INVALID');
    freeze(commands);
    let attempts = 0, ends = 0;
    let receipt: unknown;
    let treasuryBeforeEnd = candidate.treasuries[request.factionId];
    for (const command of commands) {
      if (++attempts > 3 || (command.kind === 'endTurn' && ++ends > 1)) return failure('AI_PLAN_INVALID');
      if (command.kind === 'endTurn') treasuryBeforeEnd = { ...candidate.treasuries[request.factionId] };
      const result = executeSessionCommand(candidate, command);
      if (!result.ok) return failure(result.code);
      candidate = result.state;
      if (command.kind === 'endTurn') receipt = result.endTurnEconomy;
    }
    // Validate the commit-ready state and actual receipt, not next turn's forecast.
    const final = campaignSessionSchema.safeParse(candidate), parsedReceipt = receiptSchema.safeParse(receipt);
    if (!final.success || !parsedReceipt.success || ends !== 1 || final.data.turn !== request.expectedTurn + 1) {
      return failure('AI_EXECUTION_FAILED');
    }
    candidate = final.data;
    const payment = parsedReceipt.data;
    // Only AFTER the complete batch, never fed back into the planner. Reuse current income/tariff rules.
    const own = getCampaignSessionView(candidate, request.factionId);
    const expected = calculateEndTurnEconomy(treasuryBeforeEnd, own.income, getUpkeepQuote(own.ships, request.factionId));
    if (!expected.ok || payment.factionId !== request.factionId || payment.turn !== request.expectedTurn ||
      payment.income.credits !== expected.income.credits || payment.income.minerals !== expected.income.minerals ||
      payment.upkeep.shipCount !== expected.upkeep.shipCount || payment.upkeep.dueCredits !== expected.upkeep.dueCredits ||
      payment.upkeep.paidCredits !== expected.upkeep.paidCredits || payment.upkeep.shortfallCredits !== expected.upkeep.shortfallCredits ||
      payment.treasuryAfter.credits !== expected.treasuryAfter.credits || payment.treasuryAfter.minerals !== expected.treasuryAfter.minerals ||
      payment.treasuryAfter.credits !== candidate.treasuries[request.factionId].credits ||
      payment.treasuryAfter.minerals !== candidate.treasuries[request.factionId].minerals) return failure('AI_EXECUTION_FAILED');
    return { ok: true, state: candidate, summary: { factionId: request.factionId, turn: request.expectedTurn,
      commands: commands.map(command => ({ ...command })), endTurnEconomy: payment } };
  } catch { return failure('AI_EXECUTION_FAILED'); }
}