import { z } from 'zod';
import type { CampaignFactionId } from './campaign';

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