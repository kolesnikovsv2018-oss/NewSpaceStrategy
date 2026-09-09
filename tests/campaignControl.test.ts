import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { campaignControlSchema, getControllerKind, type CampaignControl, type ControllerKind } from '../src/domain/campaignControl';
import { campaignRunSchema, convertRunToLocal, createCampaignRun, executeRunAiTurn, executeRunCommand,
  type CampaignRun, type CampaignRunResult, type RunAiTurnResult, type RunCommandResult } from '../src/domain/campaignRun';
import * as session from '../src/domain/campaignSession';
import * as executor from '../src/domain/campaignAiExecutor';
import { freeze, rich, sides } from './fixtures/campaignAi';

afterEach(() => vi.restoreAllMocks());
const controls: CampaignControl[] = [{ mode: 'local' }, { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' }];

describe('strict control and derived assignments', () => {
  it('exports exact unions, unknown boundaries and synchronous result types', () => {
    expectTypeOf<CampaignControl>().toEqualTypeOf<{ mode: 'local' } | { mode: 'human-vs-ai'; aiPolicy: 'expansion-v1' }>();
    expectTypeOf<CampaignRun>().toEqualTypeOf<{ session: session.CampaignSession; control: CampaignControl }>();
    expectTypeOf<ControllerKind>().toEqualTypeOf<'human' | 'ai'>();
    expectTypeOf<Parameters<typeof createCampaignRun>>().toEqualTypeOf<[unknown]>();
    expectTypeOf<Parameters<typeof convertRunToLocal>>().toEqualTypeOf<[unknown]>();
    expectTypeOf<Parameters<typeof executeRunCommand>>().toEqualTypeOf<[unknown, unknown]>();
    expectTypeOf<Parameters<typeof executeRunAiTurn>>().toEqualTypeOf<[unknown, unknown]>();
    expectTypeOf<ReturnType<typeof createCampaignRun>>().toEqualTypeOf<CampaignRunResult>();
    expectTypeOf<ReturnType<typeof convertRunToLocal>>().toEqualTypeOf<CampaignRunResult>();
    expectTypeOf<ReturnType<typeof executeRunCommand>>().toEqualTypeOf<RunCommandResult>();
    expectTypeOf<ReturnType<typeof executeRunAiTurn>>().toEqualTypeOf<RunAiTurnResult>();
  });

  it.each(controls)('$mode creates a fresh canonical detached run, never executes either side', control => {
    const before = structuredClone(control); freeze(control);
    const creator = vi.spyOn(session, 'createCampaignSession');
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    const first = createCampaignRun(control), second = createCampaignRun(control);
    if (!first.ok || !second.ok) throw new Error('Expected fresh runs');
    expect(creator).toHaveBeenCalledTimes(2);
    expect(first.run).toEqual({ session: session.createCampaignSession(), control });
    expect(first.run).toEqual(second.run); expect(campaignRunSchema.safeParse(first.run).success).toBe(true);
    expect(Object.keys(first).sort()).toEqual(['ok', 'run']);
    for (const faction of sides) expect(getControllerKind(first.run.control, faction))
      .toBe(control.mode === 'human-vs-ai' && faction === 'red' ? 'ai' : 'human');
    first.run.session.galaxy.systems[0].exploredBy.push('red'); first.run.session.treasuries.blue.credits = 0;
    first.run.control.mode = 'local';
    expect(second.run).toEqual({ session: session.createCampaignSession(), control: before });
    expect(control).toEqual(before); expect(dispatch).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, [], 'local', 1, true, { mode: 'ai' }, { mode: 'LOCAL' }, { mode: ' local' },
    { mode: 'local', aiPolicy: 'expansion-v1' }, { mode: 'local', aiPolicy: undefined },
    { mode: 'local', controllers: { red: 'ai' } }, { mode: 'human-vs-ai' },
    { mode: 'human-vs-ai', aiPolicy: undefined }, { mode: 'human-vs-ai', aiPolicy: 'expansion-v2' },
    { mode: 'human-vs-ai', aiPolicy: '' }, { mode: 'human-vs-ai', aiPolicy: 1 },
    { mode: 'human-vs-ai', aiPolicy: 'expansion-v1', humanFactionId: 'red' }
  ])('rejects noncanonical control %j before creation', control => {
    const creator = vi.spyOn(session, 'createCampaignSession');
    expect(campaignControlSchema.safeParse(control).success).toBe(false);
    expect(createCampaignRun(control)).toEqual({ ok: false, code: 'INVALID_STATE', message: 'Недопустимое состояние стратегической партии' });
    expect(creator).not.toHaveBeenCalled();
    const run = { session: session.createCampaignSession(), control };
    expect(executeRunCommand(run, null)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(executeRunAiTurn(run, null)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(convertRunToLocal(run)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });
});

describe('full run schema and explicit takeover', () => {
  it.each([undefined, null, {}, [], session.createCampaignSession(),
    { session: session.createCampaignSession() }, { control: { mode: 'local' } },
    { session: session.createCampaignSession(), control: undefined },
    { session: session.createCampaignSession(), control: { mode: 'local' }, summary: {} },
    { session: session.createCampaignSession(), control: { mode: 'local' }, scheduled: true }
  ])('does not migrate or repair incomplete runtime run %j', run => {
    expect(campaignRunSchema.safeParse(run).success).toBe(false);
    expect(convertRunToLocal(run)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(executeRunCommand(run, null)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(executeRunAiTurn(run, null)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it.each(controls.flatMap(control => [1, 2, session.MAX_TURN].map(turn => ({ control, turn }))))
  ('$control.mode at $turn: changes only control, including terminal/cap/deficit and idempotent local', ({ control, turn }) => {
    const state = rich(turn), run: CampaignRun = { session: state, control };
    state.treasuries.blue.credits = session.MAX_RESOURCE; state.treasuries.red.credits = 0;
    const before = structuredClone(run); freeze(run);
    const dispatch = vi.spyOn(session, 'executeSessionCommand'), ai = vi.spyOn(executor, 'executeAiTurn');
    const result = convertRunToLocal(run);
    if (!result.ok) throw new Error(result.code);
    expect(result).toEqual({ ok: true, run: { session: before.session, control: { mode: 'local' } } });
    expect(convertRunToLocal(result.run)).toEqual(result);
    expect(result.run.control).not.toBe(run.control); expect(result.run.session).not.toBe(run.session);
    result.run.session.ships[0].design.name = 'Changed snapshot';
    result.run.session.ships[0].transit!.destinationId = 'sol';
    result.run.session.fleets.items[0].shipIds.reverse();
    result.run.session.production.orders[0].design.slots[0].component = null;
    expect(run).toEqual(before); expect(dispatch).not.toHaveBeenCalled(); expect(ai).not.toHaveBeenCalled();
  });
});