import { z } from 'zod';
import { campaignControlSchema, getControllerKind } from './campaignControl';
import { campaignRunSchema, runAiTurnRequestSchema, createCampaignRun, executeRunCommand,
  executeRunAiTurn, convertRunToLocal, type RunAiTurnRequest, type RunErrorCode } from './campaignRun';
import { sessionCommandSchema, type EndTurnEconomy, type SessionCommand } from './campaignSession';
import type { AiTurnSummary } from './campaignAiExecutor';

export const campaignScenarioSchema = z.enum(['sandbox', 'joint-survey-v1']);
export type CampaignScenario = z.infer<typeof campaignScenarioSchema>;
export const campaignMatchSchema = z.object({ run: campaignRunSchema, scenario: campaignScenarioSchema }).strict();
export type CampaignMatch = z.infer<typeof campaignMatchSchema>;
export type CampaignOutcome = { status: 'ongoing' } | { status: 'completed'; reason: 'joint-survey-complete' };
export type MatchErrorCode = RunErrorCode | 'CAMPAIGN_COMPLETED';
export type MatchFailure = { ok: false; code: MatchErrorCode; message: string };
export type CampaignMatchResult = { ok: true; match: CampaignMatch; outcome: CampaignOutcome } | MatchFailure;
export type CampaignOutcomeResult = { ok: true; outcome: CampaignOutcome } | MatchFailure;
export type MatchCommandResult =
  { ok: true; match: CampaignMatch; outcome: CampaignOutcome; endTurnEconomy?: EndTurnEconomy } | MatchFailure;
export type MatchAiTurnResult =
  { ok: true; match: CampaignMatch; outcome: CampaignOutcome; summary: AiTurnSummary } | MatchFailure;

const messages = {
  INVALID_STATE: 'Недопустимое состояние стратегической партии',
  INVALID_COMMAND: 'Недопустимая команда или запрос хода',
  STALE_TURN: 'Номер хода изменился; обновите состояние',
  NOT_ACTIVE_FACTION: 'Сейчас ход другой стороны',
  FACTION_CONTROLLED_BY_AI: 'Этой стороной управляет компьютер',
  AI_NOT_ASSIGNED: 'Этой стороне не назначен компьютер',
  AI_EXECUTION_FAILED: 'Не удалось выполнить AI-ход',
  CAMPAIGN_COMPLETED: 'Совместная разведка завершена; игровые команды недоступны'
} satisfies Partial<Record<MatchErrorCode, string>>;

function failure(code: keyof typeof messages): MatchFailure {
  return { ok: false, code, message: messages[code] };
}

function readMatch(input: unknown): CampaignMatch | undefined {
  try {
    const parsed = campaignMatchSchema.safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function outcomeFor(match: CampaignMatch): CampaignOutcome {
  return match.scenario === 'joint-survey-v1' && match.run.session.galaxy.systems.every(system =>
    system.exploredBy.includes('blue') && system.exploredBy.includes('red'))
    ? { status: 'completed', reason: 'joint-survey-complete' } : { status: 'ongoing' };
}

function accept(run: unknown, scenario: CampaignScenario): CampaignMatchResult {
  const match = readMatch({ run, scenario });
  return match ? { ok: true, match, outcome: outcomeFor(match) } : failure('INVALID_STATE');
}

export function getCampaignOutcome(inputMatch: unknown): CampaignOutcomeResult {
  const match = readMatch(inputMatch);
  return match ? { ok: true, outcome: outcomeFor(match) } : failure('INVALID_STATE');
}

export function createCampaignMatch(inputControl: unknown, inputScenario: unknown): CampaignMatchResult {
  try {
    const control = campaignControlSchema.safeParse(inputControl);
    const scenario = campaignScenarioSchema.safeParse(inputScenario);
    if (!control.success || !scenario.success) return failure('INVALID_STATE');
    const result = createCampaignRun(control.data);
    return result.ok ? accept(result.run, scenario.data) : { ok: false, code: result.code, message: result.message };
  } catch { return failure('INVALID_STATE'); }
}

function checkRequest(match: CampaignMatch, request: RunAiTurnRequest, ai: boolean): MatchFailure | undefined {
  if (request.expectedTurn !== match.run.session.turn) return failure('STALE_TURN');
  if (request.factionId !== (match.run.session.turn % 2 ? 'blue' : 'red')) return failure('NOT_ACTIVE_FACTION');
  const controller = getControllerKind(match.run.control, request.factionId);
  if (!ai && controller !== 'human') return failure('FACTION_CONTROLLED_BY_AI');
  if (ai && match.run.control.mode !== 'local' && controller !== 'ai') return failure('AI_NOT_ASSIGNED');
  if (outcomeFor(match).status === 'completed') return failure('CAMPAIGN_COMPLETED');
  return undefined;
}

export function executeMatchCommand(inputMatch: unknown, inputCommand: unknown): MatchCommandResult {
  const source = readMatch(inputMatch);
  if (!source) return failure('INVALID_STATE');
  let command: SessionCommand;
  try {
    const parsed = sessionCommandSchema.safeParse(inputCommand);
    if (!parsed.success) return failure('INVALID_COMMAND');
    command = parsed.data;
  } catch { return failure('INVALID_COMMAND'); }
  const error = checkRequest(source, command, false);
  if (error) return error;
  try {
    const result = executeRunCommand(source.run, command);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const accepted = accept(result.run, source.scenario);
    if (!accepted.ok || result.endTurnEconomy === undefined) return accepted;
    return { ...accepted, endTurnEconomy: structuredClone(result.endTurnEconomy) };
  } catch { return failure('INVALID_STATE'); }
}

export function executeMatchAiTurn(inputMatch: unknown, inputRequest: unknown): MatchAiTurnResult {
  const source = readMatch(inputMatch);
  if (!source) return failure('INVALID_STATE');
  let request: RunAiTurnRequest;
  try {
    const parsed = runAiTurnRequestSchema.safeParse(inputRequest);
    if (!parsed.success) return failure('INVALID_COMMAND');
    request = parsed.data;
  } catch { return failure('INVALID_COMMAND'); }
  const error = checkRequest(source, request, true);
  if (error) return error;
  try {
    const result = executeRunAiTurn(source.run, request);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const accepted = accept(result.run, source.scenario);
    if (!accepted.ok) return failure('AI_EXECUTION_FAILED');
    return { ...accepted, summary: structuredClone(result.summary) };
  } catch { return failure('AI_EXECUTION_FAILED'); }
}

export function convertMatchToLocal(inputMatch: unknown): CampaignMatchResult {
  const source = readMatch(inputMatch);
  if (!source) return failure('INVALID_STATE');
  try {
    const result = convertRunToLocal(source.run);
    return result.ok ? accept(result.run, source.scenario) : { ok: false, code: result.code, message: result.message };
  } catch { return failure('INVALID_STATE'); }
}