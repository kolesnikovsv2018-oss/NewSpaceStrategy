import { getActiveParticipant } from '../../src/domain/campaignSchedule';
import type { Conquest } from '../../src/domain/conquest';

/** Активный участник из расписания Н17.2 вместо parity. */
export const activeOf = (state: Conquest): ReturnType<typeof getActiveParticipant> =>
  getActiveParticipant(state.session.schedule);
