import { describe, expect, expectTypeOf, it } from 'vitest';
import { planAiTurn, type AiCommand, type AiObservation, type AiPlan, type AiPlanResult,
  type AiTurnRequest, type DeepReadonly } from '../src/domain/campaignAiPlanner';
import { createCampaignSession, type CampaignSessionView, type SessionCommand } from '../src/domain/campaignSession';
import { type CampaignSystemView } from '../src/domain/campaign';
import { freeze, known, observe, requestFor, threeCommands } from './fixtures/campaignAi';

function commands(view: AiObservation, context: AiTurnRequest = { factionId: view.galaxy.factionId, expectedTurn: view.turn }) {
  const before = structuredClone(view); freeze(view); freeze(context);
  const result = planAiTurn(view, context); expect(view).toEqual(before);
  if (!result.ok) throw new Error(result.code);
  return result.plan.commands;
}

describe('AI typed pure original-observation policy', () => {
  it('exports the agreed narrow types, with no external untrusted view API', () => {
    expectTypeOf<AiTurnRequest>().toEqualTypeOf<Pick<SessionCommand, 'factionId' | 'expectedTurn'>>();
    expectTypeOf<AiObservation>().toEqualTypeOf<DeepReadonly<Pick<CampaignSessionView, 'galaxy' | 'turn' | 'activeFactionId' | 'economyForecast'>>>();
    expectTypeOf<AiCommand>().toEqualTypeOf<Extract<SessionCommand, { kind: 'explore' | 'colonize' | 'endTurn' }>>();
    expectTypeOf<AiPlan>().toEqualTypeOf<{ commands: readonly AiCommand[] }>();
    expectTypeOf<ReturnType<typeof planAiTurn>>().toEqualTypeOf<AiPlanResult>();
  });

  it.each(['blue', 'red'] as const)('never colonizes newly explored information for %s', faction => {
    const state = createCampaignSession(); state.turn = faction === 'blue' ? 1 : 2;
    expect(commands(observe(state))).toEqual([
      { kind: 'explore', ...requestFor(state), systemId: faction === 'blue' ? 'eden' : 'nexus' },
      { kind: 'endTurn', ...requestFor(state) }
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5])('selects ASCII-minimal candidates under permutation %s and reversed lanes', rotation => {
    // Typed synthetic topology deliberately differs from the fixed map: detects a definition lookup.
    const view = structuredClone(observe(createCampaignSession()));
    const systems: CampaignSystemView[] = [
      { id: 'sol', name: 'zzz', x: -100, y: 10, visibility: 'explored', ownerId: 'blue', habitable: true },
      { id: 'vega', name: 'aaa', x: 0, y: 0, visibility: 'explored', ownerId: null, habitable: true },
      { id: 'nexus', name: 'zzz', x: 9, y: 0, visibility: 'explored', ownerId: null, habitable: true },
      { id: 'eden', name: 'zzz', x: 900, y: -999, visibility: 'explored', ownerId: null, habitable: true },
      { id: 'rift', name: 'aaa', x: 0, y: 0, visibility: 'unknown' },
      { id: 'dust', name: 'zzz', x: 0, y: 0, visibility: 'unknown' }
    ];
    const permuted: AiObservation = { ...view, galaxy: { ...view.galaxy,
      systems: [...systems.slice(rotation), ...systems.slice(0, rotation)],
      lanes: [['vega', 'sol'], ['nexus', 'sol'], ['sol', 'eden'], ['sol', 'rift'], ['dust', 'eden']].reverse()
        .map(([a, b]) => [a, b] as [CampaignSystemView['id'], CampaignSystemView['id']]) } };
    expect(commands(permuted)).toEqual([
      { kind: 'colonize', factionId: 'blue', expectedTurn: 1, systemId: 'eden' },
      { kind: 'explore', factionId: 'blue', expectedTurn: 1, systemId: 'dust' },
      { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }
    ]);
  });

  it.each(['neutral', 'enemy', 'uninhabitable'] as const)('explores from %s explored neighbour without own colonies', kind => {
    const state = createCampaignSession();
    for (const system of state.galaxy.systems) { system.ownerId = null; system.exploredBy = []; }
    if (kind === 'uninhabitable') known(state, 'rift', 'blue');
    else { known(state, 'eden', 'blue', kind === 'enemy' ? 'red' : null); if (kind === 'enemy') known(state, 'eden', 'red'); }
    const result = commands(observe(state));
    expect(result.map(item => item.kind)).toEqual(['explore', 'endTurn']);
    expect(result[0]).toMatchObject({ systemId: kind === 'uninhabitable' ? 'dust' : 'nexus' });
  });

  it.each(['all-owned', 'no-explored', 'no-frontier', 'isolated-colony'] as const)('%s does not invent home ownership or recovery', kind => {
    const state = createCampaignSession();
    for (const system of state.galaxy.systems) {
      system.ownerId = null; system.exploredBy = kind === 'no-explored' ? [] : ['blue'];
    }
    if (kind === 'all-owned') for (const id of ['sol', 'eden', 'nexus', 'vega'] as const) known(state, id, 'blue', 'blue');
    const view = observe(state);
    expect(commands(kind === 'isolated-colony' ? { ...view, galaxy: { ...view.galaxy, lanes: [] } } : view))
      .toEqual([{ kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }]);
  });

  it('does not chain a second colonization or evaluate new frontier; output is detached', () => {
    const state = threeCommands(); known(state, 'nexus', 'blue');
    const view = observe(state), first = commands(view), original = structuredClone(first);
    expect(first).toEqual([
      { kind: 'colonize', factionId: 'blue', expectedTurn: 1, systemId: 'eden' },
      { kind: 'explore', factionId: 'blue', expectedTurn: 1, systemId: 'dust' },
      { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }
    ]);
    first[0].factionId = 'red';
    commands(observe(createCampaignSession()));
    expect(commands(view)).toEqual(original);
  });

  it.each([
    ['stale first', 2, 'red', 'red', 'TURN_LIMIT', 'STALE_TURN'],
    ['observer mismatch', 1, 'red', 'red', 'TURN_LIMIT', 'NOT_ACTIVE_FACTION'],
    ['inactive', 1, 'blue', 'red', 'RESOURCE_LIMIT', 'NOT_ACTIVE_FACTION'],
    ['turn cap', 1, 'blue', 'blue', 'TURN_LIMIT', 'TURN_LIMIT'],
    ['resource cap', 1, 'blue', 'blue', 'RESOURCE_LIMIT', 'RESOURCE_LIMIT']
  ] as const)('guard priority: %s', (_name, expectedTurn, factionId, activeFactionId, code, expected) => {
    const view: AiObservation = { ...observe(createCampaignSession()), activeFactionId, economyForecast: { ok: false, code } };
    expect(planAiTurn(view, { factionId, expectedTurn })).toEqual({ ok: false, code: expected });
  });
});