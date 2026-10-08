import { expect, it, vi } from 'vitest';
import { createConquest, getConquestOutcome, getConquestView, executeConquestCommand } from '../src/domain/conquest';
import { buildConquestDesigns, executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { validateDesign } from '../src/domain/shipDesign';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';

it('constructs legal deterministic candidates without clocks or random factories', () => {
  const state = createConquest();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
  try {
    const designs = buildConquestDesigns(state.research.blue, state.researchTree);
    expect(designs.length).toBeGreaterThan(1);
    expect(designs.every(design => validateDesign(design, 'battle').length === 0)).toBe(true);
    expect(buildConquestDesigns(state.research.blue, state.researchTree)).toEqual(designs);
  } finally { clock.mockRestore(); }
});
it('does not change its plan when only hidden enemy resources and research differ', () => {
  const first = createConquest(), second = structuredClone(first);
  second.session.treasuries.red = { credits: 999, minerals: 888 };
  second.research.red.completed = ['support', 'ordnance', 'capital'];
  const firstView = getConquestView(first, 'blue'), secondView = getConquestView(second, 'blue');
  expect(firstView).toEqual(secondView);
  expect(planConquestAction(firstView)).toEqual(planConquestAction(secondView));
});
it('plans from own observation and preserves paid production through save/load', () => {
  let state = createConquest();
  const source = structuredClone(state);
  expect(planConquestAction(getConquestView(state, 'blue'))).toMatchObject({ kind: 'research', technologyId: 'support' });
  let produced = false, deployed = false, travelled = false, battles = false;
  for (let turn = 0; turn < 120 && getConquestOutcome(state).status === 'ongoing'; turn++) {
    const faction = state.session.turn % 2 ? 'blue' : 'red';
    const result = executeConquestAiTurn(state, faction, state.session.turn);
    if (!result.ok) throw new Error(`${state.session.turn}: ${result.message}`);
    expect(result.state.session.turn).toBe(state.session.turn + 1);
    expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), faction, state.session.turn)).toEqual(result);
    state = result.state;
    produced ||= state.session.production.lastOrderId > 0;
    deployed ||= state.session.ships.length > 0;
    travelled ||= state.session.ships.some(ship => ship.systemId !== (ship.factionId === 'blue' ? 'sol' : 'vega'));
    battles ||= state.battles.length > 0;
  }
  expect({ produced, deployed, travelled, battles }).toEqual({ produced: true, deployed: true, travelled: true, battles: true });
  expect(getConquestOutcome(state)).toMatchObject({ status: 'completed' });
  expect(source.session.production.lastOrderId).toBe(0);
});

it.each(['blue', 'red'] as const)('the real policy can win as %s against a passive opponent from a new start', winner => {
  let state = createConquest(winner === 'red' ? { mode: 'human-vs-ai', aiPolicy: 'conquest-v1' } : { mode: 'local' });
  for (let action = 0; action < 120 && getConquestOutcome(state).status === 'ongoing'; action++) {
    const faction = state.session.turn % 2 ? 'blue' : 'red';
    const result = faction === winner ? executeConquestAiTurn(state, faction, state.session.turn) :
      executeConquestCommand(state, { kind: 'endTurn', factionId: faction, expectedTurn: state.session.turn });
    if (!result.ok) throw new Error(result.message);
    state = result.state;
  }
  expect(state.session.production.lastOrderId).toBeGreaterThan(0);
  expect(getConquestOutcome(state)).toEqual({ status: 'completed', winner, reason: 'all-planets' });
});