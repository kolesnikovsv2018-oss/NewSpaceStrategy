import { afterEach, describe, expect, it, vi } from 'vitest';
import { campaignSessionSchema } from '../src/domain/campaignSession';
import { campaignRunSchema } from '../src/domain/campaignRun';
import { flightDesignSchema, productionStateSchema } from '../src/domain/production';
import { encodeCampaignSave } from '../src/domain/campaignSave';
import { decodeCampaignRunSave, encodeCampaignRunSave, type CampaignRunSaveErrorCode,
  type DecodeCampaignRunSaveResult, type EncodeCampaignRunSaveResult } from '../src/domain/campaignRunSave';
import { freeze, rich } from './fixtures/campaignAi';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const computer = { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } as const;
const privateError = (): never => { throw new Error('PRIVATE hidden state / refinement / dependency'); };
function reject(result: DecodeCampaignRunSaveResult | EncodeCampaignRunSaveResult, code: CampaignRunSaveErrorCode): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error('Expected failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/); expect(result.message.length).toBeLessThan(200);
  expect(result.message).not.toMatch(/PRIVATE|Error:|issues|exploredBy|treasuries/);
}

describe('FAULT ONLY: exception branches, not evidence of real schema/size validation', () => {
  describe.each(['encode', 'decode2', 'migrate1'] as const)('%s', operation => {
    it.each(['session', 'production', 'flight'] as const)('catches actual nested %s refinement exceptions, no partial result or log', layer => {
      const run = { session: rich(2, 3), control: computer }, before = structuredClone(run); freeze(run);
      const newSave = encodeCampaignRunSave(run), oldSave = encodeCampaignSave(run.session);
      if (!newSave.ok || !oldSave.ok) throw new Error('Expected valid fixtures');
      const effect = layer === 'session' ? campaignSessionSchema._def.effect : layer === 'production'
        ? productionStateSchema._def.effect : flightDesignSchema._def.effect;
      if (effect.type !== 'refinement') throw new Error('Expected nested refinement');
      const refine = vi.spyOn(effect, 'refinement').mockImplementation(privateError);
      const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
      reject(operation === 'encode' ? encodeCampaignRunSave(run) : decodeCampaignRunSave(operation === 'decode2' ? newSave.json : oldSave.json), 'INVALID_STATE');
      expect(refine).toHaveBeenCalledTimes(1); expect(run).toEqual(before);
      logs.forEach(log => expect(log).not.toHaveBeenCalled());
    });
  });
  it.each(['encode', 'decode'] as const)('%s contains outer full-run parse exception', operation => {
    const run = { session: rich(2, 3), control: computer }, before = structuredClone(run), saved = encodeCampaignRunSave(run);
    if (!saved.ok) throw new Error(saved.code);
    const parse = vi.spyOn(campaignRunSchema, 'safeParse').mockImplementation(privateError);
    reject(operation === 'encode' ? encodeCampaignRunSave(run) : decodeCampaignRunSave(saved.json), 'INVALID_STATE');
    expect(parse).toHaveBeenCalledTimes(1); expect(run).toEqual(before);
  });
  it.each([new Error('PRIVATE'), 'PRIVATE', null])('stringify exception %j is a fixed safe INVALID_STATE', error => {
    const run = { session: rich(2, 3), control: computer }, before = structuredClone(run); freeze(run);
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw error; });
    const size = vi.spyOn(TextEncoder.prototype, 'encode');
    reject(encodeCampaignRunSave(run), 'INVALID_STATE'); expect(stringify).toHaveBeenCalledTimes(1);
    expect(size).not.toHaveBeenCalled(); expect(run).toEqual(before);
  });
  it.each(['encode', 'decode'] as const)('%s contains unexpected byte encoder failure at its own boundary', operation => {
    const run = { session: rich(2, 3), control: computer }, saved = encodeCampaignRunSave(run);
    if (!saved.ok) throw new Error(saved.code);
    const measure = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(privateError), parse = vi.spyOn(JSON, 'parse');
    reject(operation === 'encode' ? encodeCampaignRunSave(run) : decodeCampaignRunSave(saved.json), operation === 'encode' ? 'INVALID_STATE' : 'INVALID_SAVE');
    expect(measure).toHaveBeenCalledTimes(1); expect(parse).not.toHaveBeenCalled();
  });
  it('contains parser exception without applying a default session/control', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(privateError), run = vi.spyOn(campaignRunSchema, 'safeParse');
    reject(decodeCampaignRunSave('{}'), 'INVALID_SAVE'); expect(parse).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
  });
  it.each([1, 2, 99])('schema%s control own undefined: explicit presence, not optional/default semantics', schemaVersion => {
    // JSON cannot encode undefined; inject parser output solely to exercise the presence guard.
    const input = { format: 'orion-campaign', schemaVersion, rulesVersion: 1, session: null, control: undefined };
    vi.spyOn(JSON, 'parse').mockReturnValue(input);
    reject(decodeCampaignRunSave('{}'), schemaVersion === 99 ? 'UNSUPPORTED_SAVE_VERSION' : 'INVALID_SAVE');
    expect(Object.prototype.hasOwnProperty.call(input, 'control')).toBe(true);
  });
  it.each([1, 2, 99])('schema%s own session undefined is present, but missing session is always malformed', schemaVersion => {
    const input = { format: 'orion-campaign', schemaVersion, rulesVersion: 1, session: undefined,
      ...(schemaVersion === 2 ? { control: computer } : {}) };
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue(input);
    reject(decodeCampaignRunSave('{}'), schemaVersion === 99 ? 'UNSUPPORTED_SAVE_VERSION' : 'INVALID_STATE');
    const { session: _session, ...missing } = input; parse.mockReturnValue(missing);
    reject(decodeCampaignRunSave('{}'), 'INVALID_SAVE');
  });
  it('contains control shape getter exception without promising arbitrary getter/proxy security', () => {
    vi.spyOn(JSON, 'parse').mockReturnValue({ format: 'orion-campaign', schemaVersion: 2, rulesVersion: 1,
      session: null, control: { get mode(): never { return privateError(); } } });
    reject(decodeCampaignRunSave('{}'), 'INVALID_SAVE');
  });
  it('contains base envelope validation exception', () => {
    vi.spyOn(JSON, 'parse').mockReturnValue({ get format(): never { return privateError(); } });
    reject(decodeCampaignRunSave('{}'), 'INVALID_SAVE');
  });
  it('encode input getter exception does not stringify a partial run', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    reject(encodeCampaignRunSave({ get session(): never { return privateError(); }, control: computer }), 'INVALID_STATE');
    expect(stringify).not.toHaveBeenCalled();
  });
});