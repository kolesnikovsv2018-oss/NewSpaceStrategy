import { z } from 'zod';
import { campaignRunSchema, type CampaignRun } from './campaignRun';
import { CAMPAIGN_RULES_VERSION, CAMPAIGN_SAVE_FORMAT, CAMPAIGN_SAVE_SCHEMA_VERSION,
  MAX_CAMPAIGN_SAVE_BYTES, decodeCampaignSave, type CampaignSaveErrorCode } from './campaignSave';

// Separate from the legacy state-only schema version (1); rules and byte budget are unchanged.
export const CAMPAIGN_RUN_SAVE_SCHEMA_VERSION = 2;
export type CampaignRunSaveErrorCode = CampaignSaveErrorCode | 'UNSUPPORTED_AI_POLICY';
export interface CampaignRunSaveFailure { ok: false; code: CampaignRunSaveErrorCode; message: string }
export type EncodeCampaignRunSaveResult = { ok: true; json: string } | CampaignRunSaveFailure;
export type DecodeCampaignRunSaveResult = { ok: true; run: CampaignRun } | CampaignRunSaveFailure;

const messages: Record<CampaignRunSaveErrorCode, string> = {
  INVALID_SAVE: 'Недопустимый документ сохранения кампании',
  SAVE_TOO_LARGE: 'Сохранение кампании превышает предел 5 000 000 байт UTF-8',
  UNSUPPORTED_SAVE_VERSION: 'Версия формата сохранения кампании не поддерживается',
  UNSUPPORTED_RULES_VERSION: 'Версия правил сохранённой кампании не поддерживается',
  UNSUPPORTED_AI_POLICY: 'Политика компьютерной стороны не поддерживается',
  INVALID_STATE: 'Недопустимое состояние сохранённой кампании'
};
function failure(code: CampaignRunSaveErrorCode): CampaignRunSaveFailure {
  return { ok: false, code, message: messages[code] };
}
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

// Only inspect envelope shape here: future versions need not have today's control/session shape.
// z.unknown accepts missing keys, so session and version-specific control presence are explicit.
const baseEnvelopeSchema = z.object({
  format: z.literal(CAMPAIGN_SAVE_FORMAT),
  schemaVersion: z.number().finite().int().positive(),
  rulesVersion: z.number().finite().int().positive(),
  session: z.unknown(),
  control: z.unknown().optional()
}).strict().refine(value => owns(value, 'session'));
const savedControlSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local') }).strict(),
  z.object({ mode: z.literal('human-vs-ai'), aiPolicy: z.string().min(1).max(64)
    .refine(id => !/[^A-Za-z0-9-]/.test(id)) }).strict()
]);
function tooLarge(text: string): boolean {
  return text.length > MAX_CAMPAIGN_SAVE_BYTES || new TextEncoder().encode(text).byteLength > MAX_CAMPAIGN_SAVE_BYTES;
}
function readRun(input: unknown): DecodeCampaignRunSaveResult {
  try {
    const parsed = campaignRunSchema.safeParse(input);
    return parsed.success ? { ok: true, run: parsed.data } : failure('INVALID_STATE');
  } catch {
    // Includes nested flight/FIFO/cross-state refinements, not just the outer object schema.
    return failure('INVALID_STATE');
  }
}

/** Canonical full-run snapshot only; no caller-selected versions, IO, clock or AI execution. */
export function encodeCampaignRunSave(inputRun: unknown): EncodeCampaignRunSaveResult {
  const parsed = readRun(inputRun);
  if (!parsed.ok) return parsed;
  try {
    const json = JSON.stringify({ format: CAMPAIGN_SAVE_FORMAT, schemaVersion: CAMPAIGN_RUN_SAVE_SCHEMA_VERSION,
      rulesVersion: CAMPAIGN_RULES_VERSION, session: parsed.run.session, control: parsed.run.control });
    return tooLarge(json) ? failure('SAVE_TOO_LARGE') : { ok: true, json };
  } catch { return failure('INVALID_STATE'); }
}

/** JSON-compatible boundary; returns a detached candidate, never applies it or upgrades storage. */
export function decodeCampaignRunSave(inputJson: unknown): DecodeCampaignRunSaveResult {
  if (typeof inputJson !== 'string') return failure('INVALID_SAVE');
  let envelope: z.infer<typeof baseEnvelopeSchema>;
  try {
    if (tooLarge(inputJson)) return failure('SAVE_TOO_LARGE');
    const parsed = baseEnvelopeSchema.safeParse(JSON.parse(inputJson));
    if (!parsed.success) return failure('INVALID_SAVE');
    envelope = parsed.data;
  } catch { return failure('INVALID_SAVE'); }
  if (envelope.schemaVersion !== CAMPAIGN_SAVE_SCHEMA_VERSION && envelope.schemaVersion !== CAMPAIGN_RUN_SAVE_SCHEMA_VERSION) {
    return failure('UNSUPPORTED_SAVE_VERSION');
  }
  if (envelope.rulesVersion !== CAMPAIGN_RULES_VERSION) return failure('UNSUPPORTED_RULES_VERSION');
  if (envelope.schemaVersion === CAMPAIGN_SAVE_SCHEMA_VERSION) {
    if (owns(envelope, 'control')) return failure('INVALID_SAVE');
    // Reuse the unchanged strict 1/1 reader only AFTER the new reader's priority guards.
    const legacy = decodeCampaignSave(inputJson);
    return legacy.ok ? { ok: true, run: { session: legacy.state, control: { mode: 'local' } } } : legacy;
  }
  if (!owns(envelope, 'control')) return failure('INVALID_SAVE');
  try {
    const control = savedControlSchema.safeParse(envelope.control);
    if (!control.success) return failure('INVALID_SAVE');
    if (control.data.mode === 'human-vs-ai' && control.data.aiPolicy !== 'expansion-v1') return failure('UNSUPPORTED_AI_POLICY');
  } catch { return failure('INVALID_SAVE'); }
  return readRun({ session: envelope.session, control: envelope.control });
}