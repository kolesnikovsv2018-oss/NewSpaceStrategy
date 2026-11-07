import { describe, expect, it } from 'vitest';
import { advanceSchedule, campaignScheduleSchema, createCampaignSchedule, getActiveParticipant,
  isScheduleCircleEnd, MAX_TURN } from '../src/domain/campaignSchedule';

describe('campaignSchedule Н17.2', () => {
  it('creates a schedule from the ordered participants with turn 1, revision 0 and round 1', () => {
    const schedule = createCampaignSchedule(['player-01', 'player-02', 'player-03']);
    expect(schedule).toEqual({ order: ['player-01', 'player-02', 'player-03'], activeIndex: 0, turn: 1, revision: 0, round: 1 });
    expect(getActiveParticipant(schedule)).toBe('player-01');
    expect(isScheduleCircleEnd(schedule)).toBe(false);
  });

  it('rejects duplicated, foreign or out-of-range participants and positions', () => {
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01', 'player-01'], activeIndex: 0, turn: 1, revision: 0, round: 1 }).success).toBe(false);
    expect(campaignScheduleSchema.safeParse({
      order: ['blue', 'red'], activeIndex: 0, turn: 1, revision: 0, round: 1 }).success).toBe(false);
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01', 'player-02'], activeIndex: 2, turn: 1, revision: 0, round: 1 }).success).toBe(false);
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01'], activeIndex: 0, turn: 1, revision: 0, round: 1 }).success).toBe(false);
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01', 'player-02', 'player-03', 'player-04', 'player-05', 'player-06', 'player-07', 'player-08', 'player-09'],
      activeIndex: 0, turn: 1, revision: 0, round: 1 }).success).toBe(false);
  });

  it('keeps revision equal to turn - 1 while no structural rotation change exists', () => {
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01', 'player-02'], activeIndex: 0, turn: 5, revision: 3, round: 3 }).success).toBe(false);
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01', 'player-02'], activeIndex: 0, turn: 5, revision: 4, round: 3 }).success).toBe(true);
  });

  it('advances exactly one slot per endTurn and increments the round after the last position', () => {
    let schedule = createCampaignSchedule(['player-01', 'player-02', 'player-03']);
    const nobody = () => false;
    schedule = advanceSchedule(schedule, nobody);
    expect(schedule).toEqual({ order: ['player-01', 'player-02', 'player-03'], activeIndex: 1, turn: 2, revision: 1, round: 1 });
    schedule = advanceSchedule(schedule, nobody);
    expect(getActiveParticipant(schedule)).toBe('player-03');
    expect(schedule.turn).toBe(3);
    expect(schedule.round).toBe(1);
    expect(isScheduleCircleEnd(schedule)).toBe(true);
    schedule = advanceSchedule(schedule, nobody);
    expect(schedule).toEqual({ order: ['player-01', 'player-02', 'player-03'], activeIndex: 0, turn: 4, revision: 3, round: 2 });
  });

  it('burns a slot for every skipped participant and still completes the full circle', () => {
    let schedule = createCampaignSchedule(['player-01', 'player-02', 'player-03']);
    const excluded = (participant: string) => participant === 'player-02';
    schedule = advanceSchedule(schedule, excluded);
    // Слот player-02 сгорает: turn растёт на два, активной становится player-03.
    expect(schedule).toEqual({ order: ['player-01', 'player-02', 'player-03'], activeIndex: 2, turn: 3, revision: 2, round: 1 });
    schedule = advanceSchedule(schedule, excluded);
    // Слот player-03 завершает круг (последняя позиция), затем пропуск player-01 невозможен — он жив.
    expect(schedule).toEqual({ order: ['player-01', 'player-02', 'player-03'], activeIndex: 0, turn: 4, revision: 3, round: 2 });
  });

  it('wraps a whole circle of skipped slots around the single live participant', () => {
    let schedule = createCampaignSchedule(['player-01', 'player-02', 'player-03']);
    const onlyFirst = (participant: string) => participant !== 'player-01';
    schedule = advanceSchedule(schedule, onlyFirst);
    // Выполненный слот player-01 + пропущенные player-02 и player-03 (последняя позиция — round+1).
    expect(schedule).toEqual({ order: ['player-01', 'player-02', 'player-03'], activeIndex: 0, turn: 4, revision: 3, round: 2 });
    expect(getActiveParticipant(schedule)).toBe('player-01');
  });

  it('refuses to advance when every participant is excluded and at the turn limit', () => {
    const schedule = createCampaignSchedule(['player-01', 'player-02']);
    expect(() => advanceSchedule(schedule, () => true)).toThrow();
    const terminal = campaignScheduleSchema.parse({ ...schedule, turn: MAX_TURN, revision: MAX_TURN - 1 });
    expect(() => advanceSchedule(terminal, () => false)).toThrow('Достигнут предел номера хода');
  });

  it('rejects a detached schedule with an out-of-range turn or round beyond the turn', () => {
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01', 'player-02'], activeIndex: 0, turn: 0, revision: 0, round: 1 }).success).toBe(false);
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01', 'player-02'], activeIndex: 0, turn: 1, revision: 0, round: 2 }).success).toBe(false);
    expect(campaignScheduleSchema.safeParse({
      order: ['player-01', 'player-02'], activeIndex: 0, turn: MAX_TURN + 1, revision: MAX_TURN, round: 1 }).success).toBe(false);
  });
});
