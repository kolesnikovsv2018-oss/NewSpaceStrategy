import { afterEach, describe, expect, it, vi } from 'vitest';
import * as session from '../src/domain/campaignSession';
import * as executor from '../src/domain/campaignAiExecutor';
import * as planner from '../src/domain/campaignAiPlanner';
import { campaignControlSchema } from '../src/domain/campaignControl';
import { campaignRunSchema, convertRunToLocal, createCampaignRun, executeRunAiTurn, executeRunCommand,
  runAiTurnRequestSchema, type CampaignRun, type RunErrorCode, type RunResult } from '../src/domain/campaignRun';
import { freeze, requestFor, rich } from './fixtures/campaignAi';

afterEach(() => vi.restoreAllMocks());
const local = { mode: 'local' } as const;
const computer = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } as const;
const privateError = (): never => { throw new Error('PRIVATE dependency / hidden state / refinement'); };
function reject(result: RunResult, code: RunErrorCode): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error('Expected failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/); expect(result.message.length).toBeLessThan(200);
  expect(result.message).not.toMatch(/PRIVATE|Error:|issues|exploredBy|treasuries/);
}

describe('FAULT ONLY: exception containment; real-rule coverage is in campaignRun.test', () => {
  it.each(['create', 'manual', 'AI', 'takeover'] as const)('%s catches exceptions from the FULL nested session refinement', operation => {
    const run: CampaignRun = { session: rich(2, 3), control: computer }, before = structuredClone(run); freeze(run);
    const effect = session.campaignSessionSchema._def.effect;
    if (effect.type !== 'refinement') throw new Error('Expected session cross-state refinement');
    const refine = vi.spyOn(effect, 'refinement').mockImplementation(privateError);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    const result = operation === 'create' ? createCampaignRun(computer) : operation === 'manual'
      ? executeRunCommand(run, null) : operation === 'AI' ? executeRunAiTurn(run, null) : convertRunToLocal(run);
    reject(result, 'INVALID_STATE'); expect(refine).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled(); expect(run).toEqual(before);
  });

  it('creator exception is safe, without commands or fallback creation', () => {
    const create = vi.spyOn(session, 'createCampaignSession').mockImplementation(privateError);
    reject(createCampaignRun(computer), 'INVALID_STATE'); expect(create).toHaveBeenCalledTimes(1);
  });

  it('creator returned invalid session is fully rejected', () => {
    vi.spyOn(session, 'createCampaignSession').mockReturnValue({ ...session.createCampaignSession(), turn: NaN });
    reject(createCampaignRun(local), 'INVALID_STATE');
  });

  it('creator output is detached, even if a dependency retains the created session', () => {
    const state = rich(1, 3);
    vi.spyOn(session, 'createCampaignSession').mockReturnValue(state);
    const result = createCampaignRun(computer); if (!result.ok) throw new Error(result.code);
    const original = structuredClone(result); state.ships[0].design.name = 'PRIVATE mutated factory result';
    expect(result).toEqual(original);
  });

  it('control parser exception prevents session creation', () => {
    vi.spyOn(campaignControlSchema, 'safeParse').mockImplementationOnce(privateError);
    const create = vi.spyOn(session, 'createCampaignSession');
    reject(createCampaignRun(computer), 'INVALID_STATE'); expect(create).not.toHaveBeenCalled();
  });

  it.each(['manual', 'AI'] as const)('%s request-parser exception is INVALID_COMMAND, not state/authorization', mode => {
    const run = { session: session.createCampaignSession(), control: computer };
    if (mode === 'manual') vi.spyOn(session.sessionCommandSchema, 'safeParse').mockImplementationOnce(privateError);
    else vi.spyOn(runAiTurnRequestSchema, 'safeParse').mockImplementationOnce(privateError);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    reject(mode === 'manual' ? executeRunCommand(run, { kind: 'endTurn', ...requestFor(run.session) })
      : executeRunAiTurn(run, requestFor(run.session)), 'INVALID_COMMAND');
    expect(dispatch).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
  });

  it.each(['manual', 'AI'] as const)('%s getter throws while parsing unknown payload, safe before dispatch', mode => {
    const run = { session: session.createCampaignSession(), control: local };
    const payload = { kind: 'endTurn', expectedTurn: 1, get factionId(): never { return privateError(); } };
    reject(mode === 'manual' ? executeRunCommand(run, payload) : executeRunAiTurn(run, payload), 'INVALID_COMMAND');
  });

  it.each(['manual', 'AI'] as const)('%s final run validation exception is contained; no partial output', mode => {
    const run = { session: rich(2, 3), control: mode === 'AI' ? computer : local }, before = structuredClone(run);
    const parse = campaignRunSchema.safeParse.bind(campaignRunSchema);
    vi.spyOn(campaignRunSchema, 'safeParse').mockImplementationOnce(parse).mockImplementationOnce(privateError);
    reject(mode === 'manual' ? executeRunCommand(run, { kind: 'endTurn', ...requestFor(run.session) })
      : executeRunAiTurn(run, requestFor(run.session)), mode === 'AI' ? 'AI_EXECUTION_FAILED' : 'INVALID_STATE');
    expect(run).toEqual(before);
  });

  it.each(['manual', 'AI'].flatMap(mode => ['throw', 'failure', 'unknown-code', 'invalid-state'].map(fault => ({ mode, fault }))))
  ('$mode $fault: private dependency mutation never reaches input/output, one attempt, safe fixed messages', ({ mode, fault }) => {
    const run: CampaignRun = { session: rich(2, 3), control: mode === 'AI' ? computer : local };
    const before = structuredClone(run), request = requestFor(run.session); freeze(run); freeze(request);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const corrupt = (candidate: unknown, payload: unknown) => {
      expect(candidate).not.toBe(run.session); expect(payload).not.toBe(request);
      const state = candidate as session.CampaignSession;
      state.treasuries.blue.credits = 12345; state.ships[0].design.name = 'PRIVATE mutated candidate';
      if (fault === 'throw') privateError();
      if (fault === 'invalid-state') return { ok: true, state: { ...state, turn: NaN } };
      return { ok: false, code: fault === 'unknown-code' ? 'PRIVATE' : 'OUT_OF_REACH',
        message: 'PRIVATE hidden detail', state, summary: { secret: true } };
    };
    const dispatch = mode === 'AI'
      ? vi.spyOn(executor, 'executeAiTurn').mockImplementation((candidate, payload) => corrupt(candidate, payload) as executor.AiTurnResult)
      : vi.spyOn(session, 'executeSessionCommand').mockImplementation((candidate, payload) => corrupt(candidate, payload) as session.SessionResult);
    const result = mode === 'AI' ? executeRunAiTurn(run, request) : executeRunCommand(run, { kind: 'endTurn', ...request });
    reject(result, fault === 'failure' ? 'OUT_OF_REACH' : mode === 'AI' ? 'AI_EXECUTION_FAILED' : 'INVALID_STATE');
    expect(dispatch).toHaveBeenCalledTimes(1); expect(run).toEqual(before);
    logs.forEach(log => expect(log).not.toHaveBeenCalled());
  });

  it.each(['AI_PLAN_INVALID', 'AI_EXECUTION_FAILED', 'TURN_LIMIT', 'RESOURCE_LIMIT', 'INSUFFICIENT_FUEL', 'ORDER_ID_LIMIT'] as const)
  ('preserves prior AI failure code %s but not message or attached partial state', code => {
    const run = { session: rich(2, 3), control: computer };
    const execute = vi.spyOn(executor, 'executeAiTurn').mockReturnValue({ ok: false, code, message: 'PRIVATE',
      state: run.session, summary: {} } as executor.AiTurnResult);
    reject(executeRunAiTurn(run, requestFor(run.session)), code); expect(execute).toHaveBeenCalledTimes(1);
  });

  it('real AI executor planner exception is preserved without fallback manual end or retry', () => {
    const run = { session: rich(2, 3), control: computer }, before = structuredClone(run); freeze(run);
    const policy = vi.spyOn(planner, 'planAiTurn').mockImplementationOnce(privateError);
    const execute = vi.spyOn(executor, 'executeAiTurn'), dispatch = vi.spyOn(session, 'executeSessionCommand');
    reject(executeRunAiTurn(run, requestFor(run.session)), 'AI_EXECUTION_FAILED');
    expect(policy).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled();
    expect(run).toEqual(before);
  });
});