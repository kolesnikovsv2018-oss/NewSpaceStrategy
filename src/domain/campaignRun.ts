import { z } from 'zod';
import { factionIdSchema } from './campaign';
import { campaignControlSchema, getControllerKind } from './campaignControl';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, MAX_TURN, sessionCommandSchema,
  type EndTurnEconomy } from './campaignSession';
import { executeAiTurn, type AiTurnErrorCode, type AiTurnSummary } from './campaignAiExecutor';

export const campaignRunSchema = z.object({ session: campaignSessionSchema, control: campaignControlSchema }).strict();
export type CampaignRun = z.infer<typeof campaignRunSchema>;
// Match the existing AI request without coupling this boundary to command-union ordering.
export const runAiTurnRequestSchema = z.object({
  factionId: factionIdSchema,
  expectedTurn: z.number().int().min(1).max(MAX_TURN)
}).strict();
export type RunAiTurnRequest = z.infer<typeof runAiTurnRequestSchema>;
export type RunErrorCode = AiTurnErrorCode | 'FACTION_CONTROLLED_BY_AI' | 'AI_NOT_ASSIGNED';
export type RunFailure = { ok: false; code: RunErrorCode; message: string };
export type CampaignRunResult = { ok: true; run: CampaignRun } | RunFailure;
export type RunCommandResult = { ok: true; run: CampaignRun; endTurnEconomy?: EndTurnEconomy } | RunFailure;
export type RunAiTurnResult = { ok: true; run: CampaignRun; summary: AiTurnSummary } | RunFailure;
export type RunResult = CampaignRunResult | RunCommandResult | RunAiTurnResult;

const messages: Record<RunErrorCode, string> = {
  INVALID_STATE: 'Недопустимое состояние стратегической партии',
  INVALID_COMMAND: 'Недопустимая команда или запрос хода',
  STALE_TURN: 'Номер хода изменился; обновите состояние',
  NOT_ACTIVE_FACTION: 'Сейчас ход другой стороны',
  FACTION_CONTROLLED_BY_AI: 'Этой стороной управляет компьютер',
  AI_NOT_ASSIGNED: 'Этой стороне не назначен компьютер',
  TURN_LIMIT: 'Достигнут предел номера хода', RESOURCE_LIMIT: 'Операция превысит предел ресурсов',
  AI_PLAN_INVALID: 'Недопустимый план AI-хода', AI_EXECUTION_FAILED: 'Не удалось выполнить AI-ход',
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
function failure(code: RunErrorCode, fallback: RunErrorCode = 'INVALID_STATE'): RunFailure {
  // Dependency messages/extra fields are not an authorized transcript of a failed transaction.
  if (!Object.prototype.hasOwnProperty.call(messages, code)) code = fallback;
  return { ok: false, code, message: messages[code] };
}
function readRun(input: unknown): CampaignRun | undefined {
  try {
    const parsed = campaignRunSchema.safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; } // Includes exceptions from nested session/design refinements.
}

/** Creates a fresh session only after validating the explicit, canonical control choice. */
export function createCampaignRun(inputControl: unknown): CampaignRunResult {
  try {
    const control = campaignControlSchema.safeParse(inputControl);
    if (!control.success) return failure('INVALID_STATE');
    const run = readRun({ session: createCampaignSession(), control: control.data });
    return run ? { ok: true, run } : failure('INVALID_STATE');
  } catch { return failure('INVALID_STATE'); }
}

function checkTurn(run: CampaignRun, request: RunAiTurnRequest): RunFailure | undefined {
  if (request.expectedTurn !== run.session.turn) return failure('STALE_TURN');
  if (request.factionId !== (run.session.turn % 2 ? 'blue' : 'red')) return failure('NOT_ACTIVE_FACTION');
  return undefined;
}

/** Manual commands authorize before any action/limit checks; no automatic follow-up turn. */
export function executeRunCommand(inputRun: unknown, inputCommand: unknown): RunCommandResult {
  const source = readRun(inputRun);
  if (!source) return failure('INVALID_STATE');
  let command: z.infer<typeof sessionCommandSchema>;
  try {
    const parsed = sessionCommandSchema.safeParse(inputCommand);
    if (!parsed.success) return failure('INVALID_COMMAND');
    command = parsed.data;
  } catch { return failure('INVALID_COMMAND'); }
  const turnError = checkTurn(source, command);
  if (turnError) return turnError;
  if (getControllerKind(source.control, command.factionId) !== 'human') return failure('FACTION_CONTROLLED_BY_AI');
  try {
    const result = executeSessionCommand(source.session, command);
    if (!result.ok) return failure(result.code);
    const run = readRun({ session: result.state, control: source.control });
    if (!run) return failure('INVALID_STATE');
    return result.endTurnEconomy === undefined ? { ok: true, run } :
      { ok: true, run, endTurnEconomy: structuredClone(result.endTurnEconomy) };
  } catch { return failure('INVALID_STATE'); }
}

/** One explicit existing AI transaction. Local permits either helper; AI mode permits only red. */
export function executeRunAiTurn(inputRun: unknown, inputRequest: unknown): RunAiTurnResult {
  const source = readRun(inputRun);
  if (!source) return failure('INVALID_STATE');
  let request: RunAiTurnRequest;
  try {
    const parsed = runAiTurnRequestSchema.safeParse(inputRequest);
    if (!parsed.success) return failure('INVALID_COMMAND');
    request = parsed.data;
  } catch { return failure('INVALID_COMMAND'); }
  const turnError = checkTurn(source, request);
  if (turnError) return turnError;
  if (source.control.mode !== 'local' && getControllerKind(source.control, request.factionId) !== 'ai') {
    return failure('AI_NOT_ASSIGNED');
  }
  try {
    const result = executeAiTurn(source.session, request);
    if (!result.ok) return failure(result.code, 'AI_EXECUTION_FAILED');
    const run = readRun({ session: result.state, control: source.control });
    if (!run) return failure('AI_EXECUTION_FAILED');
    return { ok: true, run, summary: structuredClone(result.summary) };
  } catch { return failure('AI_EXECUTION_FAILED'); }
}

/** Explicit one-way takeover, including idempotent local input. Never executes a command. */
export function convertRunToLocal(inputRun: unknown): CampaignRunResult {
  const run = readRun(inputRun);
  if (!run) return failure('INVALID_STATE');
  return { ok: true, run: { session: run.session, control: { mode: 'local' } } };
}