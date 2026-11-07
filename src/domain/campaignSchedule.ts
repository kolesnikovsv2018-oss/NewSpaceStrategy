/**
 * campaignSchedule.ts — Н17.2: расписание ходов многосторонней военной кампании.
 *
 * Контракт (docs/CAMPAIGN_MULTI_FACTION.md, решение Н17.1, подтверждено пользователем):
 *  - ordered participants `player-01..player-0P` из снимка карты; порядок = порядок массива
 *    participants снимка (без карты — фиксированный военный сценарий);
 *  - активная сторона определяется расписанием, не чётностью turn;
 *  - `turn` растёт монотонно на каждый выполненный ИЛИ пропущенный ход — слот расписания
 *    сгорает и при пропуске; turn остаётся номером хода для expectedTurn, журналов и боёв;
 *  - `revision` — отдельный монотонный счётчик изменений расписания: +1 на каждый
 *    потреблённый слот; в Н17.2 всегда turn - 1, задел под структурные изменения
 *    вращения участников Н17.6 (решение подтверждено пользователем 2026-11-06);
 *  - `round` — полный круг: +1 после потребления слота последней позиции списка;
 *  - исключённые стороны (нет колоний и нет кораблей) пропускаются расписанием:
 *    каждый пропущенный слот сжигает свой turn/revision и не ломает полный круг.
 */
import { z } from 'zod';
import { participantIdSchema, type ParticipantId } from './campaign';

export const MAX_TURN = 1_000_000_000;
const turnValueSchema = z.number().int().min(1).max(MAX_TURN);

export const campaignScheduleSchema = z.object({
  order: z.array(participantIdSchema).min(2).max(8),
  activeIndex: z.number().int().min(0).max(7),
  turn: turnValueSchema,
  revision: z.number().int().min(0).max(MAX_TURN),
  round: turnValueSchema
}).strict().superRefine((schedule, ctx) => {
  if (new Set(schedule.order).size !== schedule.order.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Расписание требует уникальных участников' });
  }
  if (schedule.activeIndex >= schedule.order.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Активная позиция вне расписания' });
  }
  // Н17.2: структурных изменений вращения ещё нет, поэтому ревизия следует за номером хода.
  if (schedule.revision !== schedule.turn - 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ревизия расписания должна соответствовать номеру хода' });
  }
  if (schedule.round > schedule.turn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Круг не может опережать номер хода' });
  }
});
export type CampaignSchedule = z.infer<typeof campaignScheduleSchema>;

export function createCampaignSchedule(order: readonly ParticipantId[]): CampaignSchedule {
  return campaignScheduleSchema.parse({ order: [...order], activeIndex: 0, turn: 1, revision: 0, round: 1 });
}

/** Участник, чей слот активен сейчас; единственный источник active без parity. */
export function getActiveParticipant(schedule: CampaignSchedule): ParticipantId {
  return campaignScheduleSchema.parse(schedule).order[schedule.activeIndex];
}

/** Слот последней позиции круга: его потребление завершает круг и инкрементирует round. */
export function isScheduleCircleEnd(schedule: CampaignSchedule): boolean {
  const parsed = campaignScheduleSchema.parse(schedule);
  return parsed.activeIndex === parsed.order.length - 1;
}

export type ScheduleExclusion = (participant: ParticipantId) => boolean;

/**
 * Потребить текущий слот (выполненный или пропущенный) и встать на следующего
 * не исключённого участника. Каждый пропущенный слот сжигает собственные
 * turn/revision; round инкрементируется при потреблении слота последней позиции.
 */
export function advanceSchedule(schedule: CampaignSchedule, isExcluded: ScheduleExclusion): CampaignSchedule {
  const parsed = campaignScheduleSchema.parse(schedule);
  if (parsed.order.every(isExcluded)) {
    throw new Error('Расписание требует хотя бы одного действующего участника');
  }
  let index = parsed.activeIndex, turn = parsed.turn, revision = parsed.revision, round = parsed.round;
  const consume = (position: number): void => {
    if (turn === MAX_TURN) throw new Error('Достигнут предел номера хода');
    turn += 1;
    revision += 1;
    if (position === parsed.order.length - 1) round += 1;
  };
  consume(index);
  do {
    index = (index + 1) % parsed.order.length;
    if (isExcluded(parsed.order[index])) consume(index);
  } while (isExcluded(parsed.order[index]));
  return campaignScheduleSchema.parse({ order: parsed.order, activeIndex: index, turn, revision, round });
}
