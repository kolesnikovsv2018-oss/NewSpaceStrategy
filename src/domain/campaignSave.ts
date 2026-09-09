import { z } from 'zod';
import { campaignSessionSchema, type CampaignSession } from './campaignSession';

export const CAMPAIGN_SAVE_FORMAT = 'orion-campaign';
export const CAMPAIGN_SAVE_SCHEMA_VERSION = 1;
// Bump when map, validation, formulas, limits or command semantics change, not just the JSON shape.
export const CAMPAIGN_RULES_VERSION = 1;
export const MAX_CAMPAIGN_SAVE_BYTES = 5_000_000;

export type CampaignSaveErrorCode = 'INVALID_SAVE' | 'SAVE_TOO_LARGE' | 'UNSUPPORTED_SAVE_VERSION' |
  'UNSUPPORTED_RULES_VERSION' | 'INVALID_STATE';
export interface CampaignSaveFailure { ok: false; code: CampaignSaveErrorCode; message: string }
export type EncodeCampaignSaveResult = { ok: true; json: string } | CampaignSaveFailure;
export type DecodeCampaignSaveResult = { ok: true; state: CampaignSession } | CampaignSaveFailure;

const messages: Record<CampaignSaveErrorCode, string> = {
  INVALID_SAVE: 'Недопустимый документ сохранения кампании',
  SAVE_TOO_LARGE: 'Сохранение кампании превышает предел 5 000 000 байт UTF-8',
  UNSUPPORTED_SAVE_VERSION: 'Версия формата сохранения кампании не поддерживается',
  UNSUPPORTED_RULES_VERSION: 'Версия правил сохранённой кампании не поддерживается',
  INVALID_STATE: 'Недопустимое состояние сохранённой кампании'
};
function failure(code: CampaignSaveErrorCode): CampaignSaveFailure {
  return { ok: false, code, message: messages[code] };
}

// Inspect versions before applying today's rules to the session. z.unknown alone allows a missing key.
const envelopeSchema = z.object({
  format: z.literal(CAMPAIGN_SAVE_FORMAT),
  schemaVersion: z.number().finite().int().positive(),
  rulesVersion: z.number().finite().int().positive(),
  session: z.unknown()
}).strict().refine(value => Object.prototype.hasOwnProperty.call(value, 'session'));

function tooLarge(text: string): boolean {
  // UTF-8 is never shorter than the UTF-16 code-unit count; avoid an allocation for obviously huge text.
  return text.length > MAX_CAMPAIGN_SAVE_BYTES || new TextEncoder().encode(text).byteLength > MAX_CAMPAIGN_SAVE_BYTES;
}

function readSession(input: unknown): DecodeCampaignSaveResult {
  try {
    const parsed = campaignSessionSchema.safeParse(input);
    return parsed.success ? { ok: true, state: parsed.data } : failure('INVALID_STATE');
  } catch {
    // Refinements may throw; never expose a partial state or raw exception to the caller.
    return failure('INVALID_STATE');
  }
}

/** Pure full-session snapshot: no storage, clock, catalogue, receipt or game command. */
export function encodeCampaignSave(inputState: unknown): EncodeCampaignSaveResult {
  const parsed = readSession(inputState);
  if (!parsed.ok) return parsed;
  try {
    const json = JSON.stringify({ format: CAMPAIGN_SAVE_FORMAT, schemaVersion: CAMPAIGN_SAVE_SCHEMA_VERSION,
      rulesVersion: CAMPAIGN_RULES_VERSION, session: parsed.state });
    return tooLarge(json) ? failure('SAVE_TOO_LARGE') : { ok: true, json };
  } catch {
    return failure('INVALID_STATE');
  }
}

/** Untrusted JSON boundary. A successful decode is a detached candidate, not a scene replacement. */
export function decodeCampaignSave(inputJson: unknown): DecodeCampaignSaveResult {
  if (typeof inputJson !== 'string') return failure('INVALID_SAVE');
  if (tooLarge(inputJson)) return failure('SAVE_TOO_LARGE');
  let input: unknown;
  try { input = JSON.parse(inputJson); } catch { return failure('INVALID_SAVE'); }
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) return failure('INVALID_SAVE');
  if (parsed.data.schemaVersion !== CAMPAIGN_SAVE_SCHEMA_VERSION) return failure('UNSUPPORTED_SAVE_VERSION');
  if (parsed.data.rulesVersion !== CAMPAIGN_RULES_VERSION) return failure('UNSUPPORTED_RULES_VERSION');
  return readSession(parsed.data.session);
}