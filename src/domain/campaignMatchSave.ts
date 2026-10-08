import { z } from 'zod';
import { campaignMatchSchema, campaignScenarioSchema, type CampaignMatch } from './campaignMatch';
import { CAMPAIGN_RULES_VERSION, CAMPAIGN_SAVE_FORMAT, CAMPAIGN_SAVE_SCHEMA_VERSION,
  MAX_CAMPAIGN_SAVE_BYTES } from './campaignSave';
import { CAMPAIGN_RUN_SAVE_SCHEMA_VERSION, decodeCampaignRunSave, type CampaignRunSaveErrorCode } from './campaignRunSave';

export const CAMPAIGN_MATCH_SAVE_SCHEMA_VERSION = 3;
export type CampaignMatchSaveErrorCode = CampaignRunSaveErrorCode | 'UNSUPPORTED_SCENARIO';
export interface CampaignMatchSaveFailure { ok: false; code: CampaignMatchSaveErrorCode; message: string }
export type EncodeCampaignMatchSaveResult = { ok: true; json: string } | CampaignMatchSaveFailure;
export type DecodeCampaignMatchSaveResult = { ok: true; match: CampaignMatch } | CampaignMatchSaveFailure;

const messages: Record<CampaignMatchSaveErrorCode, string> = {
  INVALID_SAVE: 'Недопустимый документ сохранения кампании',
  SAVE_TOO_LARGE: 'Сохранение кампании превышает предел 5 000 000 байт UTF-8',
  UNSUPPORTED_SAVE_VERSION: 'Версия формата сохранения кампании не поддерживается',
  UNSUPPORTED_RULES_VERSION: 'Версия правил сохранённой кампании не поддерживается',
  UNSUPPORTED_AI_POLICY: 'Политика компьютерной стороны не поддерживается',
  UNSUPPORTED_SCENARIO: 'Сценарий сохранённой кампании не поддерживается',
  INVALID_STATE: 'Недопустимое состояние сохранённой кампании'
};
function failure(code: CampaignMatchSaveErrorCode): CampaignMatchSaveFailure {
  return { ok: false, code, message: messages[code] };
}
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const baseEnvelopeSchema = z.object({
  format: z.literal(CAMPAIGN_SAVE_FORMAT),
  schemaVersion: z.number().finite().int().positive(),
  rulesVersion: z.number().finite().int().positive(),
  session: z.unknown(),
  control: z.unknown().optional(),
  scenario: z.unknown().optional()
}).strict().refine(value => owns(value, 'session'));
const savedIdentifierSchema = z.string().min(1).max(64).refine(id => !/[^A-Za-z0-9-]/.test(id));
const savedControlSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local') }).strict(),
  z.object({ mode: z.literal('human-vs-ai'), aiPolicy: savedIdentifierSchema }).strict()
]);
function tooLarge(text: string): boolean {
  return text.length > MAX_CAMPAIGN_SAVE_BYTES || new TextEncoder().encode(text).byteLength > MAX_CAMPAIGN_SAVE_BYTES;
}
function readMatch(input: unknown): DecodeCampaignMatchSaveResult {
  try {
    const parsed = campaignMatchSchema.safeParse(input);
    return parsed.success ? { ok: true, match: parsed.data } : failure('INVALID_STATE');
  } catch { return failure('INVALID_STATE'); }
}

export function encodeCampaignMatchSave(inputMatch: unknown): EncodeCampaignMatchSaveResult {
  const parsed = readMatch(inputMatch);
  if (!parsed.ok) return parsed;
  try {
    const json = JSON.stringify({ format: CAMPAIGN_SAVE_FORMAT, schemaVersion: CAMPAIGN_MATCH_SAVE_SCHEMA_VERSION,
      rulesVersion: CAMPAIGN_RULES_VERSION, session: parsed.match.run.session,
      control: parsed.match.run.control, scenario: parsed.match.scenario });
    return tooLarge(json) ? failure('SAVE_TOO_LARGE') : { ok: true, json };
  } catch { return failure('INVALID_STATE'); }
}

export function decodeCampaignMatchSave(inputJson: unknown): DecodeCampaignMatchSaveResult {
  if (typeof inputJson !== 'string') return failure('INVALID_SAVE');
  let envelope: z.infer<typeof baseEnvelopeSchema>;
  try {
    if (tooLarge(inputJson)) return failure('SAVE_TOO_LARGE');
    const parsed = baseEnvelopeSchema.safeParse(JSON.parse(inputJson));
    if (!parsed.success) return failure('INVALID_SAVE');
    envelope = parsed.data;
  } catch { return failure('INVALID_SAVE'); }
  if (envelope.schemaVersion !== CAMPAIGN_SAVE_SCHEMA_VERSION && envelope.schemaVersion !== CAMPAIGN_RUN_SAVE_SCHEMA_VERSION
    && envelope.schemaVersion !== CAMPAIGN_MATCH_SAVE_SCHEMA_VERSION) return failure('UNSUPPORTED_SAVE_VERSION');
  if (envelope.rulesVersion !== CAMPAIGN_RULES_VERSION) return failure('UNSUPPORTED_RULES_VERSION');
  if (envelope.schemaVersion !== CAMPAIGN_MATCH_SAVE_SCHEMA_VERSION) {
    if (owns(envelope, 'scenario')) return failure('INVALID_SAVE');
    try {
      const legacy = decodeCampaignRunSave(inputJson);
      return legacy.ok ? readMatch({ run: legacy.run, scenario: 'sandbox' }) : failure(legacy.code);
    } catch { return failure('INVALID_SAVE'); }
  }
  if (!owns(envelope, 'control') || !owns(envelope, 'scenario')) return failure('INVALID_SAVE');
  try {
    const control = savedControlSchema.safeParse(envelope.control);
    if (!control.success) return failure('INVALID_SAVE');
    if (control.data.mode === 'human-vs-ai' && control.data.aiPolicy !== 'expansion-v1') return failure('UNSUPPORTED_AI_POLICY');
    const scenario = savedIdentifierSchema.safeParse(envelope.scenario);
    if (!scenario.success) return failure('INVALID_SAVE');
    if (!campaignScenarioSchema.safeParse(scenario.data).success) return failure('UNSUPPORTED_SCENARIO');
  } catch { return failure('INVALID_SAVE'); }
  return readMatch({ run: { session: envelope.session, control: envelope.control }, scenario: envelope.scenario });
}
