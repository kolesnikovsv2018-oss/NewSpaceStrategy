import { describe, expect, it } from 'vitest';
import { createConquest, conquestSchema, executeConquestCommand,
  getConquestOutcome, getConquestView, type Conquest } from '../src/domain/conquest';
import { executeConquestAiTurn } from '../src/domain/conquestAi';
import { getActiveParticipant } from '../src/domain/campaignSchedule';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { activeOf } from './fixtures/conquestSides';

function endTurn(state: Conquest, participant = activeOf(state)): Conquest {
  const result = executeConquestCommand(state, { kind: 'endTurn', factionId: participant, expectedTurn: state.session.schedule.turn });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}

describe('Н17.2 records по участникам', () => {
  it('creates treasuries, surveys, research, journals and catalogs for every map participant', () => {
    const state = createConquest();
    expect(state.session.schedule.order).toEqual(['player-01', 'player-02']);
    expect(state.participants).toEqual([
      { id: 'player-01', name: 'Синий союз', color: 0x55baff },
      { id: 'player-02', name: 'Красная лига', color: 0xf08070 }
    ]);
    expect(Object.keys(state.session.treasuries).sort()).toEqual(['player-01', 'player-02']);
    expect(Object.keys(state.surveys).sort()).toEqual(['player-01', 'player-02']);
    expect(Object.keys(state.research).sort()).toEqual(['player-01', 'player-02']);
    expect(Object.keys(state.researchJournal).sort()).toEqual(['player-01', 'player-02']);
    expect(Object.keys(state.projects).sort()).toEqual(['player-01', 'player-02']);
    expect(Object.keys(state.colonyOutput.reserves).sort()).toEqual(['player-01', 'player-02']);
    // Стартовые корабли для всех участников карты.
    expect(state.session.ships.map(ship => ship.factionId).sort()).toEqual(['player-01', 'player-02']);
  });

  it.each([
    ['treasuries', (state: Conquest) => { state.session.treasuries['player-03'] = { credits: 1, minerals: 1 }; }],
    ['surveys', (state: Conquest) => { state.surveys['player-03'] = {}; }],
    ['research', (state: Conquest) => { state.research['player-03'] = { completed: [], progress: {}, activeId: null }; }],
    ['researchJournal', (state: Conquest) => { state.researchJournal['player-03'] = {}; }],
    ['projects', (state: Conquest) => { state.projects['player-03'] = { lastProjectId: 0, items: [] }; }],
    ['reserves', (state: Conquest) => { state.colonyOutput.reserves['player-03'] = { research: 0, culture: 0 }; }],
    ['missing survey', (state: Conquest) => { delete (state.surveys as Record<string, unknown>)['player-02']; }],
  ])('rejects a foreign or missing participant key in %s without changing state', (_name, mutate) => {
    const state = createConquest();
    const broken = structuredClone(state);
    mutate(broken);
    expect(conquestSchema.safeParse(broken).success).toBe(false);
    // Исходное состояние не изменяется отклонённой записью.
    expect(conquestSchema.safeParse(state).success).toBe(true);
  });

  it('keeps the save round-trip identical for the participant platform', () => {
    const state = endTurn(createConquest());
    expect(decodeConquestSave(encodeConquestSave(state))).toEqual(state);
  });
});

describe('Н17.2 расписание и авторизация', () => {
  it('gives exactly one development per own endTurn and completes the round after the last participant', () => {
    let state = createConquest();
    const firstTreasury = structuredClone(state.session.treasuries['player-01']);
    state = endTurn(state, 'player-01');
    // Ровно одно начисление за собственный endTurn.
    expect(state.session.treasuries['player-01'].credits).toBeGreaterThan(firstTreasury.credits);
    expect(state.session.schedule).toMatchObject({ turn: 2, revision: 1, round: 1, activeIndex: 1 });
    state = endTurn(state, 'player-02');
    // Слот последнего участника круга завершает круг.
    expect(state.session.schedule).toMatchObject({ turn: 3, revision: 2, round: 2, activeIndex: 0 });
    // Дипломатический раунд Н16 — единая точка после endTurn последнего участника круга.
    expect(state.diplomacy.round).toBe(1);
  });

  it('skips an eliminated participant slot without breaking the full circle', () => {
    let state = createConquest();
    // player-02 без колоний и без кораблей — производное исключение, без сохраняемого флага.
    state.session.ships = state.session.ships.filter(ship => ship.factionId === 'player-01');
    state.operations = Object.fromEntries(Object.entries(state.operations)
      .filter(([id]) => state.session.ships.some(ship => String(ship.id) === id)));
    for (const system of state.session.galaxy.systems) if (system.ownerId === 'player-02') {
      system.ownerId = null;
      system.exploredBy = system.exploredBy.filter(side => side !== 'player-02');
      // Нейтральный мир не может иметь назначенных рабочих.
      state.colonyOutput.assignments[system.id] = { industry: 0, research: 0, culture: 0 };
    }
    state = conquestSchema.parse(state);
    expect(activeOf(state)).toBe('player-01');
    state = endTurn(state, 'player-01');
    // Слот player-01 выполнен, слот исключённого player-02 сгорел, круг завершён.
    expect(state.session.schedule).toMatchObject({ turn: 3, revision: 2, round: 2, activeIndex: 0 });
    expect(activeOf(state)).toBe('player-01');
  });

  it('rejects a command from a non-active participant before any action', () => {
    const state = createConquest();
    const before = structuredClone(state);
    const result = executeConquestCommand(state, { kind: 'endTurn', factionId: 'player-02', expectedTurn: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_ACTIVE_FACTION');
    expect(state).toEqual(before);
  });

  it('rejects a stale command after the schedule advanced', () => {
    const state = endTurn(createConquest());
    const result = executeConquestCommand(state, { kind: 'endTurn', factionId: 'player-02', expectedTurn: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('STALE_TURN');
  });

  it('refuses AI packets on the human side before actions and stale turns', () => {
    const state = createConquest({ mode: 'campaign', human: 'player-01', aiPolicy: 'conquest-v1' });
    const before = structuredClone(state);
    const packet = executeConquestAiTurn(state, 'player-01', 1);
    expect(packet.ok).toBe(false);
    if (!packet.ok) expect(packet.code).toBe('CONTROLLER_FORBIDDEN');
    const stale = executeConquestCommand(state, { kind: 'endTurn', factionId: 'player-01', expectedTurn: 5 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('STALE_TURN');
    expect(state).toEqual(before);
  });

  it('runs the bounded AI packet for the active AI side and stops after its endTurn', () => {
    const state = createConquest({ mode: 'campaign', human: 'player-01', aiPolicy: 'conquest-v1' });
    const afterHuman = endTurn(state, 'player-01');
    expect(activeOf(afterHuman)).toBe('player-02');
    const result = executeConquestAiTurn(afterHuman, 'player-02', afterHuman.session.schedule.turn);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Ровно один endTurn: ход вернулся к человеку.
    expect(getActiveParticipant(result.state.session.schedule)).toBe('player-01');
    expect(result.state.session.schedule.turn).toBe(afterHuman.session.schedule.turn + 1);
  });

  it('generalizes the all-planets victory to the participant list', () => {
    let state = createConquest();
    // Все пригодные миры — player-01; исследования среды должны покрывать каждую колонию.
    for (const system of state.session.galaxy.systems) {
      if (system.id === 'rift' || system.id === 'dust') continue;
      system.ownerId = 'player-01';
      system.exploredBy = ['player-01'];
      state.surveys['player-01'][system.id] = 'habitable';
    }
    state = conquestSchema.parse(state);
    expect(getConquestOutcome(state)).toEqual({ status: 'completed', winner: 'player-01', reason: 'all-planets' });
  });

  it('serves an own-view with the schedule turn and active participant', () => {
    const state = endTurn(createConquest());
    const view = getConquestView(state, 'player-01');
    expect(view.turn).toBe(2);
    expect(view.activeFactionId).toBe('player-02');
    expect(view.galaxy.factionId).toBe('player-01');
  });
});
