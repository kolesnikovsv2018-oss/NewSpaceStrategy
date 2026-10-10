import { describe, expect, it } from 'vitest';
import defaultFixture from '../src/domain/fixtures/rules-default.json';
import {
  applyNumericEffects,
  buildRulesFixture,
  decodeRulesSnapshot,
  encodeRulesSnapshot,
  parseRulesSnapshot,
  rulesSnapshotSchema,
  validateRulesSnapshot
} from '../src/domain/campaignRules';
import {
  activateRulesEffects, applyRulesSnapshotToStats, applyCapabilityEffects,
  CURRENT_GAME_RULES_CONSUMERS, RULES_FIXTURE_CATALOG, applyNumericEffectsWithReceipt,
  rulesEffectSchema, type NumericModifierEffect
} from '../src/domain/campaignRules';

function modifier(overrides: Partial<NumericModifierEffect> = {}): NumericModifierEffect {
  return {
    kind: 'modifier', id: 'speed-plus-10', target: 'ship-speed', scope: 'ship', unit: 'percent',
    operation: 'add', value: 0.1, cap: null, stackingGroup: 'engineering',
    activationPhase: 'always', handler: 'ship-stats', ...overrides
  };
}

describe('campaign rules snapshot', () => {
  it('round-trips a valid rules snapshot without mutating the source object', () => {
    const snapshot = buildRulesFixture();
    const encoded = encodeRulesSnapshot(snapshot);

    expect(parseRulesSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeRulesSnapshot(encoded)).toEqual(snapshot);
    expect(validateRulesSnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(JSON.parse(encoded)).toEqual(snapshot);
  });

  it('rejects duplicate effect ids, unknown handlers and unsupported target/unit combinations', () => {
    const base = buildRulesFixture();
    const duplicate = structuredClone(base);
    duplicate.effects.push(structuredClone(duplicate.effects[0]));
    expect(rulesSnapshotSchema.safeParse(duplicate).success).toBe(false);

    const unknownHandler = structuredClone(base);
    unknownHandler.handlers = ['ship-stats'];
    expect(() => validateRulesSnapshot(unknownHandler)).toThrow();

    const invalidPair = structuredClone(base);
    invalidPair.effects[0] = {
      ...invalidPair.effects[0],
      target: 'ship-growth',
      unit: 'flat',
      kind: 'modifier',
      value: 0.1,
      cap: null,
      stackingGroup: 'economy',
      activationPhase: 'always',
      handler: 'facility-output'
    };
    expect(rulesSnapshotSchema.safeParse(invalidPair).success).toBe(false);
  });

  it('applies additive percent effects using canonical stacking order and cap semantics', () => {
    const effects = [
      {
        kind: 'modifier',
        id: 'growth-plus-10',
        target: 'ship-growth',
        scope: 'planet',
        unit: 'percent',
        operation: 'add',
        value: 0.1,
        cap: 0.3,
        stackingGroup: 'economy',
        activationPhase: 'always',
        handler: 'facility-output'
      },
      {
        kind: 'modifier',
        id: 'growth-plus-20',
        target: 'ship-growth',
        scope: 'planet',
        unit: 'percent',
        operation: 'add',
        value: 0.2,
        cap: 0.3,
        stackingGroup: 'economy',
        activationPhase: 'always',
        handler: 'facility-output'
      }
    ] satisfies NumericModifierEffect[];

    expect(applyNumericEffects(100, effects)).toBe(130);
    expect(applyNumericEffects(100, [{ ...effects[0], cap: 0.25 }, effects[1]])).toBe(125);
  });

  it('keeps default fixture and codec boundary separate from runtime data', () => {
    const defaultFixture = buildRulesFixture();
    const next = structuredClone(defaultFixture);
    next.id = 'custom-rules';

    expect(buildRulesFixture()).toEqual(defaultFixture);
    expect(defaultFixture.id).toBe('campaign-rules-v1');
    expect(decodeRulesSnapshot(encodeRulesSnapshot(next))).toEqual(next);
    expect(() => decodeRulesSnapshot('not-json')).toThrow();
  });

  it.each(['format', 'schemaVersion', 'rulesVersion', 'id', 'treeId', 'treeVersion',
    'tablesId', 'tablesVersion', 'policyId', 'policyVersion', 'handlers', 'policies', 'effects'])(
    'rejects missing snapshot field %s', key => {
      const snapshot: Record<string, unknown> = buildRulesFixture();
      delete snapshot[key];
      expect(() => encodeRulesSnapshot(snapshot)).toThrow();
      expect(() => decodeRulesSnapshot(JSON.stringify(snapshot))).toThrow();
    }
  );

  it.each(['schemaVersion', 'rulesVersion', 'treeVersion', 'tablesVersion', 'policyVersion'])(
    'rejects other version %s without changing the source', key => {
      const snapshot = { ...buildRulesFixture(), [key]: 'unsupported' };
      const before = structuredClone(snapshot);
      expect(() => encodeRulesSnapshot(snapshot)).toThrow();
      expect(() => decodeRulesSnapshot(JSON.stringify(snapshot))).toThrow();
      expect(snapshot).toEqual(before);
    }
  );

  it.each([
    { target: 'unknown' }, { unit: 'unknown' }, { operation: 'script' }, { policy: 'unknown' },
    { handler: 'unknown' }, { scope: 'planet' }, { unit: 'points' }, { handler: 'component-stats' },
    { formula: 'base * 2' }, { value: NaN }, { value: Infinity }, { value: -Infinity },
    { cap: -1 }, { operation: 'set', value: -1 }, { operation: 'multiply', value: -1 },
    { operation: 'multiply', unit: 'flat' }
  ])('rejects invalid effect %#', override => {
    expect(rulesEffectSchema.safeParse({ ...modifier(), ...override }).success).toBe(false);
  });

  it('retains strict fields and registered policies/handlers', () => {
    const snapshot = buildRulesFixture();
    expect(rulesSnapshotSchema.safeParse({ ...snapshot, extra: 1 }).success).toBe(false);
    expect(rulesSnapshotSchema.safeParse({ ...snapshot, handlers: ['ship-stats', 'ship-stats'] }).success).toBe(false);
    expect(rulesSnapshotSchema.safeParse({ ...snapshot, policies: ['component-bands-v1'] }).success).toBe(false);
    expect(() => decodeRulesSnapshot('{"effects":[{"value":1e400}]}')).toThrow();
    expect(() => decodeRulesSnapshot(snapshot)).toThrow();
  });

  it('separates future descriptions from actual library/current-game consumers', () => {
    const snapshot = buildRulesFixture();
    expect(validateRulesSnapshot(snapshot)).toEqual(snapshot);
    expect(() => activateRulesEffects(snapshot, ['ship-growth-bonus'], ['library-numeric-v1'])).toThrow();
    expect(() => activateRulesEffects(snapshot, ['policy-reference-v1'], ['library-numeric-v1'])).toThrow();
    expect(() => activateRulesEffects(snapshot, ['ship-speed-bonus'], CURRENT_GAME_RULES_CONSUMERS)).toThrow();
    expect(activateRulesEffects(snapshot, ['ship-speed-bonus'], ['library-numeric-v1'])).toEqual([snapshot.effects[0]]);
    expect(() => activateRulesEffects(snapshot, ['missing'], ['library-numeric-v1'])).toThrow();
    expect(() => activateRulesEffects(snapshot, ['ship-speed-bonus', 'ship-speed-bonus'], ['library-numeric-v1'])).toThrow();
  });

  it('uses independent additive/multiplicative oracles and deterministic permutations', () => {
    const a = modifier();
    const b = modifier({ id: 'speed-plus-20', value: 0.2 });
    expect(applyNumericEffects(100, [a, b])).toBe(130);
    expect(applyNumericEffects(100, [b, a])).toBe(130);
    expect(applyNumericEffects(100, [
      { ...a, operation: 'multiply' }, { ...b, operation: 'multiply' }
    ])).toBe(132);
    expect(applyNumericEffects(100, [modifier({ operation: 'multiply', unit: 'ratio', value: 2 })])).toBe(200);
    const flat = modifier({ id: 'flat', unit: 'flat', value: 10, stackingGroup: 'base' });
    const times = modifier({ id: 'times', unit: 'ratio', operation: 'multiply', value: 2 });
    expect(applyNumericEffects(100, [flat, times])).toBe(220);
    expect(applyNumericEffects(100, [{ ...flat, stackingGroup: 'special' }, times])).toBe(210);
  });

  it('applies exact cap/+1 and rounds once, including stats API', () => {
    expect(applyNumericEffects(100, [modifier({ value: 0.3, cap: 0.3 })])).toBe(130);
    expect(applyNumericEffects(100, [modifier({ value: 0.31, cap: 0.3 })])).toBe(130);
    expect(applyNumericEffects(100, [modifier({ unit: 'flat', value: 30, cap: 130 })])).toBe(130);
    expect(applyNumericEffects(100, [modifier({ unit: 'flat', value: 31, cap: 130 })])).toBe(130);
    const snapshot = buildRulesFixture();
    snapshot.effects = [modifier({ value: 0.004 }), modifier({ id: 'second', value: 0.004 })];
    expect(applyRulesSnapshotToStats({ speed: 100 }, snapshot)).toEqual({ speed: 101 });
    snapshot.effects = [modifier(), modifier({ id: 'second', value: 0.2 })];
    expect(applyRulesSnapshotToStats({ speed: 100 }, snapshot)).toEqual({ speed: 130 });
    expect(() => applyRulesSnapshotToStats({}, snapshot)).toThrow();
  });

  it('applies set/min/max/cap operations in the documented order', () => {
    expect(applyNumericEffects(100, [modifier({ unit: 'flat', operation: 'set', value: 50 })])).toBe(50);
    expect(applyNumericEffects(100, [modifier({ unit: 'flat', operation: 'min', value: 90 })])).toBe(90);
    expect(applyNumericEffects(100, [modifier({ unit: 'flat', operation: 'max', value: 110 })])).toBe(110);
    expect(applyNumericEffects(100, [modifier({ unit: 'flat', operation: 'cap', value: 95 })])).toBe(95);
    expect(() => applyNumericEffects(100, [modifier({ operation: 'set' }),
      modifier({ id: 'second', operation: 'set' })])).toThrow();
  });

  it('rejects double application across component/stats passes and mixed targets', () => {
    expect(() => applyNumericEffects(100, [modifier(), modifier()])).toThrow();
    expect(() => applyNumericEffects(100, [modifier()], { appliedEffectIds: ['speed-plus-10'] })).toThrow();
    expect(() => applyNumericEffects(100, [modifier(), modifier({
      id: 'shield', target: 'ship-shield'
    })])).toThrow();
    expect(() => applyNumericEffects(NaN, [])).toThrow();
    expect(() => applyNumericEffects(100, [modifier({ value: -2 })])).toThrow();
    expect(() => applyNumericEffects(Number.MAX_VALUE, [modifier({ unit: 'ratio', operation: 'multiply', value: 2 })])).toThrow();
    const effect = modifier({ id: 'damage', target: 'weapon-damage', scope: 'component', handler: 'component-stats' });
    const receipt = applyNumericEffectsWithReceipt(100, [effect]);
    const snapshot = buildRulesFixture();
    snapshot.effects = [effect];
    expect(receipt).toEqual({ value: 110, appliedEffectIds: ['damage'] });
    expect(() => applyRulesSnapshotToStats({ damage: receipt.value }, snapshot, receipt)).toThrow();
  });

  it('gates activation phases without silently running capability/policy as numbers', () => {
    const effect = modifier({ activationPhase: 'before-combat' });
    expect(applyNumericEffects(100, [effect])).toBe(100);
    expect(applyNumericEffects(100, [effect], { phase: 'before-combat' })).toBe(110);
    const snapshot = buildRulesFixture();
    expect(() => applyNumericEffects(100, [snapshot.effects[2]], { phase: 'on-build' })).toThrow();
    expect(() => applyNumericEffects(100, [snapshot.effects[3]], { phase: 'on-research' })).toThrow();
  });

  it('supports capability unlock and rejects malformed/noninteger capability values', () => {
    const effect = rulesEffectSchema.parse({
      kind: 'capability', id: 'unlock', target: 'component-unlock', scope: 'component', unit: 'count',
      operation: 'set', value: 1, cap: 1, stackingGroup: 'base', activationPhase: 'always',
      handler: 'component-stats'
    });
    expect(applyCapabilityEffects(0, [effect])).toBe(1);
    expect(rulesEffectSchema.safeParse({ ...effect, value: 2 }).success).toBe(false);
    expect(rulesEffectSchema.safeParse({ ...effect, value: -1 }).success).toBe(false);
    expect(rulesEffectSchema.safeParse({ ...effect, value: 0.5 }).success).toBe(false);
    expect(() => applyCapabilityEffects(0, [effect, effect])).toThrow();
  });

  it('detaches parsed, decoded, activated and calculated objects from caller/catalog', () => {
    const source = buildRulesFixture();
    const parsed = validateRulesSnapshot(source);
    const decoded = decodeRulesSnapshot(encodeRulesSnapshot(source));
    const activated = activateRulesEffects(source, ['ship-speed-bonus'], ['library-numeric-v1']);
    source.effects[0].value = 99;
    source.handlers.pop();
    expect(parsed.effects[0].value).toBe(0.1);
    expect(decoded.effects[0].value).toBe(0.1);
    expect(activated[0].value).toBe(0.1);
    expect(buildRulesFixture().effects[0].value).toBe(0.1);
    expect(validateRulesSnapshot(RULES_FIXTURE_CATALOG.default)).toEqual(buildRulesFixture());
    const externalCatalog = structuredClone(defaultFixture);
    const captured = validateRulesSnapshot(externalCatalog);
    externalCatalog.effects[0].value = 0.9;
    expect(captured.effects[0].value).toBe(0.1);
  });

  it('never lets final rounding cross a fractional final cap', () => {
    expect(applyNumericEffects(100, [modifier({ unit: 'flat', value: 40, cap: 130.6 })])).toBe(130);
    expect(applyNumericEffects(100, [modifier({ value: 0.4, cap: 0.306 })])).toBe(130);
  });

  it.each([' bad-id', 'bad-id ', 'bad-id\n'])('rejects noncanonical identifier %j without repair', id => {
    expect(rulesEffectSchema.safeParse(modifier({ id })).success).toBe(false);
  });

  it('rejects count fractions and negative policy values', () => {
    const count = { ...modifier(), target: 'fleet-capacity', scope: 'fleet', handler: 'fleet-capacity', unit: 'count' };
    expect(rulesEffectSchema.safeParse({ ...count, value: 0.5 }).success).toBe(false);
    expect(rulesEffectSchema.safeParse({ ...count, value: 1, cap: 0.5 }).success).toBe(false);
    expect(rulesEffectSchema.safeParse({ ...buildRulesFixture().effects[3], value: -1 }).success).toBe(false);
  });
});
