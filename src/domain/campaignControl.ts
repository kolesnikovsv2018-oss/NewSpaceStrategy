import { z } from 'zod';
import { participantIdSchema, type CampaignFactionId, type ParticipantId } from './campaign';

// Мирная песочница: принятый формат контроллера, не мигрирует (Н16 и ранее).
export const campaignControlSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local') }).strict(),
  z.object({ mode: z.literal('human-vs-ai'), aiPolicy: z.literal('expansion-v1') }).strict()
]);
export type CampaignControl = z.infer<typeof campaignControlSchema>;
export type ControllerKind = 'human' | 'ai';

/** Derived query on validated control; assignments are never duplicated in persistent state. */
export function getControllerKind(control: CampaignControl, factionId: CampaignFactionId): ControllerKind {
  return control.mode === 'human-vs-ai' && factionId === 'red' ? 'ai' : 'human';
}

/**
 * Н17.2: контроллеры военной кампании (решение Н17.1) — `local` либо человек + остальные
 * участники под AI (`{ mode: 'campaign', human: 'player-NN', aiPolicy: 'conquest-v1' }`).
 * Прежний `human-vs-ai` после bump сохранения отклоняется явно, без миграций.
 */
export const conquestControlSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local') }).strict(),
  z.object({ mode: z.literal('campaign'), human: participantIdSchema, aiPolicy: z.literal('conquest-v1') }).strict()
]);
export type ConquestControl = z.infer<typeof conquestControlSchema>;

/** Контроллер участника без жёсткого red: слот человека берётся из самого control. */
export function getConquestControllerKind(control: ConquestControl, participant: ParticipantId): ControllerKind {
  participantIdSchema.parse(participant);
  return control.mode === 'campaign' && control.human !== participant ? 'ai' : 'human';
}
