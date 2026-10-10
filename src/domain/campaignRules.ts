import { z } from 'zod';
import defaultFixture from './fixtures/rules-default.json';

export const RULES_SNAPSHOT_FORMAT = 'orion-rules-snapshot';
export const RULES_SNAPSHOT_SCHEMA_VERSION = 1;
export const RULES_SNAPSHOT_RULES_VERSION = 1;

export const RULES_TARGETS = [
  'ship-speed',
  'ship-growth',
  'ship-shield',
  'weapon-damage',
  'weapon-range',
  'facility-output',
  'fleet-capacity',
  'planet-habitability',
  'component-unlock'
] as const;

export const RULES_UNITS = ['percent', 'ratio', 'flat', 'count', 'seconds', 'points'] as const;
export const RULES_STACKING_GROUPS = [
  'base',
  'economy',
  'engineering',
  'combat',
  'science',
  'special'
] as const;
export const RULES_PHASES = [
  'always',
  'on-turn-start',
  'on-build',
  'on-research',
  'before-combat',
  'after-combat'
] as const;
export const RULES_OPERATIONS = ['add', 'multiply', 'set', 'cap', 'min', 'max'] as const;
export const RULES_HANDLERS = [
  'ship-stats',
  'component-stats',
  'facility-output',
  'fleet-capacity',
  'campaign-policy'
] as const;
export const RULES_POLICIES = ['component-bands-v1', 'campaign-policy-v1'] as const;

export type RuleTarget = (typeof RULES_TARGETS)[number];
export type RuleUnit = (typeof RULES_UNITS)[number];
export type RuleOperation = (typeof RULES_OPERATIONS)[number];
export type RuleActivationPhase = (typeof RULES_PHASES)[number];
export type RuleStackingGroup = (typeof RULES_STACKING_GROUPS)[number];
export type RuleHandler = (typeof RULES_HANDLERS)[number];
export type RulePolicy = (typeof RULES_POLICIES)[number];

const ruleIdentifierSchema = z.string().min(1).max(64).refine(value => !/[^a-z0-9-]/.test(value));
const ruleTargetUnitMap: Record<RuleTarget, readonly RuleUnit[]> = {
  'ship-speed': ['percent', 'ratio', 'flat'],
  'ship-growth': ['percent', 'ratio'],
  'ship-shield': ['percent', 'flat', 'count'],
  'weapon-damage': ['percent', 'flat'],
  'weapon-range': ['percent', 'flat'],
  'facility-output': ['percent', 'flat'],
  'fleet-capacity': ['percent', 'count'],
  'planet-habitability': ['percent', 'points'],
  'component-unlock': ['count']
};
export const RULES_SCOPES = ['component', 'ship', 'fleet', 'planet', 'player', 'global'] as const;
export type RuleScope = (typeof RULES_SCOPES)[number];
const targetScopes: Record<RuleTarget, readonly RuleScope[]> = {
  'ship-speed': ['ship'],
  'ship-growth': ['planet'],
  'ship-shield': ['ship'],
  'weapon-damage': ['component'],
  'weapon-range': ['component'],
  'facility-output': ['planet'],
  'fleet-capacity': ['fleet'],
  'planet-habitability': ['player', 'global'],
  'component-unlock': ['component']
};
const targetHandlers: Record<RuleTarget, RuleHandler> = {
  'ship-speed': 'ship-stats',
  'ship-growth': 'facility-output',
  'ship-shield': 'ship-stats',
  'weapon-damage': 'component-stats',
  'weapon-range': 'component-stats',
  'facility-output': 'facility-output',
  'fleet-capacity': 'fleet-capacity',
  'planet-habitability': 'campaign-policy',
  'component-unlock': 'component-stats'
};

const capabilityEffectSchema = z.object({
  kind: z.literal('capability'),
  id: ruleIdentifierSchema,
  target: z.enum(RULES_TARGETS),
  scope: z.enum(['component', 'ship', 'fleet', 'planet', 'player', 'global']),
  unit: z.literal('count'),
  operation: z.enum(['add', 'set']),
  value: z.number().finite().int().min(0).max(100000),
  cap: z.number().finite().int().min(0).max(100000).nullable(),
  stackingGroup: z.enum(RULES_STACKING_GROUPS),
  activationPhase: z.enum(RULES_PHASES),
  handler: z.enum(RULES_HANDLERS),
  policy: z.enum(RULES_POLICIES).optional(),
  description: z.string().trim().min(1).max(200).optional()
}).strict();

const numericModifierEffectSchema = z.object({
  kind: z.literal('modifier'),
  id: ruleIdentifierSchema,
  target: z.enum(RULES_TARGETS),
  scope: z.enum(['component', 'ship', 'fleet', 'planet', 'player', 'global']),
  unit: z.enum(RULES_UNITS),
  operation: z.enum(RULES_OPERATIONS),
  value: z.number().finite().min(-1000000).max(1000000),
  cap: z.number().finite().min(-1000000).max(1000000).nullable(),
  stackingGroup: z.enum(RULES_STACKING_GROUPS),
  activationPhase: z.enum(RULES_PHASES),
  handler: z.enum(RULES_HANDLERS),
  policy: z.enum(RULES_POLICIES).optional(),
  description: z.string().trim().min(1).max(200).optional()
}).strict();

const versionedPolicyEffectSchema = z.object({
  kind: z.literal('policy-reference'),
  id: ruleIdentifierSchema,
  target: z.literal('planet-habitability'),
  scope: z.enum(['player', 'global']),
  unit: z.literal('points'),
  operation: z.literal('set'),
  value: z.number().finite().min(0).max(1000000),
  cap: z.number().finite().min(0).max(1000000).nullable(),
  stackingGroup: z.enum(RULES_STACKING_GROUPS),
  activationPhase: z.enum(RULES_PHASES),
  handler: z.literal('campaign-policy'),
  policy: z.enum(RULES_POLICIES),
  description: z.string().trim().min(1).max(200).optional()
}).strict();

const rulesEffectUnionSchema = z.discriminatedUnion('kind', [
  capabilityEffectSchema,
  numericModifierEffectSchema,
  versionedPolicyEffectSchema
]);

export const rulesEffectSchema = rulesEffectUnionSchema.superRefine((effect, ctx) => {
  if (effect.kind === 'capability' || effect.kind === 'modifier') {
    if (!ruleTargetUnitMap[effect.target].includes(effect.unit)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Несовместимая пара target/unit для эффекта' });
    }
  }
  if (effect.kind === 'modifier' && effect.operation === 'set' && effect.unit === 'percent' && effect.value < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Процентный set-модификатор не может быть отрицательным' });
  }
  if (!targetScopes[effect.target].includes(effect.scope)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scope'], message: 'Несовместимые target/scope' });
  }
  if (targetHandlers[effect.target] !== effect.handler) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['handler'], message: 'Несовместимые target/handler' });
  }
  if (effect.cap !== null && effect.cap < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cap'], message: 'Cap должен быть неотрицательным' });
  }
  if (effect.kind === 'modifier') {
    if (effect.unit === 'count' && (!Number.isInteger(effect.value) || (effect.cap !== null && !Number.isInteger(effect.cap)))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Count требует целых value/cap' });
    }
    if (effect.target === 'component-unlock') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unlock требует capability' });
    }
    if (effect.operation !== 'add' && effect.value < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Отрицательное значение допустимо только для add' });
    }
    if (effect.operation === 'multiply' && effect.unit !== 'percent' && effect.unit !== 'ratio') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Multiply требует percent или ratio' });
    }
  }
  if (effect.kind === 'capability' && effect.target !== 'component-unlock' && effect.target !== 'fleet-capacity') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Несовместимый capability target' });
  }
  if (effect.target === 'component-unlock' && (effect.value > 1 || effect.cap !== 1 || effect.operation !== 'set')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unlock требует set 0/1 и cap 1' });
  }
});

export type RulesEffect = z.infer<typeof rulesEffectSchema>;
export type CapabilityEffect = Extract<RulesEffect, { kind: 'capability' }>;
export type NumericModifierEffect = Extract<RulesEffect, { kind: 'modifier' }>;
export type PolicyReferenceEffect = Extract<RulesEffect, { kind: 'policy-reference' }>;

export const rulesSnapshotSchema = z.object({
  format: z.literal(RULES_SNAPSHOT_FORMAT),
  schemaVersion: z.literal(RULES_SNAPSHOT_SCHEMA_VERSION),
  rulesVersion: z.literal(RULES_SNAPSHOT_RULES_VERSION),
  id: ruleIdentifierSchema,
  treeId: ruleIdentifierSchema,
  tablesId: ruleIdentifierSchema,
  policyId: ruleIdentifierSchema,
  treeVersion: z.literal('research-tree-v2'),
  tablesVersion: z.literal('campaign-tables-v1'),
  policyVersion: z.literal('component-bands-v1'),
  handlers: z.array(z.enum(RULES_HANDLERS)).min(1).max(32).refine(array => new Set(array).size === array.length, {
    message: 'Список обработчиков содержит дубликаты'
  }),
  policies: z.array(z.enum(RULES_POLICIES)).min(1).max(32).refine(array => new Set(array).size === array.length, {
    message: 'Список политик содержит дубликаты'
  }),
  effects: z.array(rulesEffectSchema).max(256)
}).strict().superRefine((snapshot, ctx) => {
  const duplicateIds = new Set<string>();
  for (const effect of snapshot.effects) {
    if (duplicateIds.has(effect.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Дубликат effect id: ${effect.id}` });
      continue;
    }
    duplicateIds.add(effect.id);
    if (!snapshot.handlers.includes(effect.handler)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Неизвестный handler для эффекта ${effect.id}` });
    }
    if (effect.policy && !snapshot.policies.includes(effect.policy)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Неизвестная policy для эффекта ${effect.id}` });
    }
  }
});

export type RulesSnapshot = z.infer<typeof rulesSnapshotSchema>;

export const RULES_FIXTURE_CATALOG: Readonly<Record<'default', unknown>> = Object.freeze({ default: defaultFixture });

export function createDefaultRulesSnapshot(): RulesSnapshot {
  return validateRulesSnapshot(RULES_FIXTURE_CATALOG.default);
}

export function validateRulesSnapshot(input: unknown): RulesSnapshot {
  const result = rulesSnapshotSchema.safeParse(input);
  if (!result.success) throw new RulesError('INVALID_RULES', 'Некорректный rules snapshot или неподдерживаемая версия');
  return result.data;
}
export const parseRulesSnapshot = validateRulesSnapshot;

export type RulesErrorCode = 'INVALID_RULES' | 'INVALID_JSON' | 'UNSUPPORTED_EFFECT' | 'DUPLICATE_APPLICATION';
export class RulesError extends Error {
  constructor(public readonly code: RulesErrorCode, message: string) {
    super(message);
    this.name = 'RulesError';
  }
}

export function encodeRulesSnapshot(input: unknown): string {
  return JSON.stringify(validateRulesSnapshot(input), null, 2);
}

export function decodeRulesSnapshot(input: unknown): RulesSnapshot {
  if (typeof input !== 'string') throw new RulesError('INVALID_JSON', 'Ожидается JSON-строка rules snapshot');
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new RulesError('INVALID_JSON', 'Не удалось разобрать rules snapshot JSON');
  }
  return validateRulesSnapshot(parsed);
}

export type RulesConsumer = 'library-numeric-v1' | 'library-capability-v1';
export const CURRENT_GAME_RULES_CONSUMERS: readonly RulesConsumer[] = Object.freeze([]);
const numericTargets: readonly RuleTarget[] = [
  'ship-speed', 'ship-shield', 'weapon-damage', 'weapon-range', 'facility-output', 'fleet-capacity'
];

export function activateRulesEffects(
  input: unknown, ids: readonly string[], consumers: readonly RulesConsumer[]
): RulesEffect[] {
  const snapshot = validateRulesSnapshot(input);
  z.array(z.enum(['library-numeric-v1', 'library-capability-v1'])).parse(consumers);
  const selectedIds = z.array(ruleIdentifierSchema).refine(items => new Set(items).size === items.length).parse(ids);
  return selectedIds.map(id => {
    const effect = snapshot.effects.find(item => item.id === id);
    if (!effect) throw new RulesError('INVALID_RULES', `Неизвестный effect ID: ${id}`);
    const supported = effect.kind === 'modifier'
      ? consumers.includes('library-numeric-v1') && numericTargets.includes(effect.target)
      : effect.kind === 'capability' && consumers.includes('library-capability-v1');
    if (!supported) throw new RulesError('UNSUPPORTED_EFFECT', `Нет исполнителя эффекта ${id}`);
    return effect;
  });
}

export interface RulesApplicationOptions {
  phase?: RuleActivationPhase;
  appliedEffectIds?: readonly string[];
}

function prepareEffects(input: readonly RulesEffect[], options: RulesApplicationOptions): RulesEffect[] {
  const effects = z.array(rulesEffectSchema).parse(input);
  const phase = z.enum(RULES_PHASES).parse(options.phase ?? 'always');
  const seen = new Set(z.array(ruleIdentifierSchema).parse(options.appliedEffectIds ?? []));
  for (const effect of effects) {
    if (seen.has(effect.id)) throw new RulesError('DUPLICATE_APPLICATION', `Повторный effect ID: ${effect.id}`);
    seen.add(effect.id);
  }
  return effects.filter(effect => effect.activationPhase === 'always' || effect.activationPhase === phase)
    .sort((a, b) => RULES_STACKING_GROUPS.indexOf(a.stackingGroup) - RULES_STACKING_GROUPS.indexOf(b.stackingGroup)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function magnitude(value: number, unit: RuleUnit, base: number): number {
  return unit === 'percent' || unit === 'ratio' ? base * value : value;
}

export function applyNumericEffects(
  base: number, input: readonly RulesEffect[], options: RulesApplicationOptions = {}
): number {
  z.number().finite().nonnegative().parse(base);
  const relevant = prepareEffects(input, options);
  if (relevant.some(effect => effect.kind !== 'modifier')) {
    throw new RulesError('UNSUPPORTED_EFFECT', 'Числовой API принимает только modifiers');
  }
  const effects = relevant.filter((effect): effect is NumericModifierEffect => effect.kind === 'modifier');
  const first = effects[0];
  if (first && effects.some(effect => effect.target !== first.target || effect.scope !== first.scope)) {
    throw new RulesError('INVALID_RULES', 'Числовой расчёт требует один target/scope');
  }
  let current = base;
  let finalLimit = Infinity;
  for (const group of RULES_STACKING_GROUPS) {
    const members = effects.filter(effect => effect.stackingGroup === group);
    const groupBase = current;
    const sets = members.filter(effect => effect.operation === 'set');
    if (sets.length > 1) throw new RulesError('INVALID_RULES', 'Несколько set в одной группе');
    if (sets[0]) current = magnitude(sets[0].value, sets[0].unit, groupBase);
    let additive = 0;
    let multiplier = 1;
    for (const effect of members) {
      if (effect.operation === 'add') additive += magnitude(effect.value, effect.unit, groupBase);
      if (effect.operation === 'multiply') multiplier *= effect.unit === 'percent' ? 1 + effect.value : effect.value;
    }
    current = (current + additive) * multiplier;
    for (const effect of members) {
      const value = magnitude(effect.value, effect.unit, groupBase);
      if (effect.operation === 'min' || effect.operation === 'cap') current = Math.min(current, value);
      if (effect.operation === 'max') current = Math.max(current, value);
    }
  }
  for (const effect of effects) {
    if (effect.cap !== null) {
      const limit = effect.unit === 'percent' || effect.unit === 'ratio' ? base * (1 + effect.cap) : effect.cap;
      finalLimit = Math.min(finalLimit, limit);
      current = Math.min(current, limit);
    }
  }
  z.number().finite().nonnegative().parse(current);
  return Math.min(Math.round(current), Math.floor(finalLimit));
}

export interface NumericEffectsApplication {
  value: number;
  appliedEffectIds: string[];
}

export function applyNumericEffectsWithReceipt(
  base: number, input: readonly RulesEffect[], options: RulesApplicationOptions = {}
): NumericEffectsApplication {
  const value = applyNumericEffects(base, input, options);
  const effects = prepareEffects(input, options);
  return { value, appliedEffectIds: [...(options.appliedEffectIds ?? []), ...effects.map(effect => effect.id)] };
}

export function applyCapabilityEffects(
  base: number, input: readonly RulesEffect[], options: RulesApplicationOptions = {}
): number {
  z.number().finite().int().nonnegative().parse(base);
  const effects = prepareEffects(input, options);
  const first = effects[0];
  if (effects.some(effect => effect.kind !== 'capability' || effect.target !== first?.target || effect.scope !== first?.scope)) {
    throw new RulesError('UNSUPPORTED_EFFECT', 'Capability API требует один capability target/scope');
  }
  let current = base;
  for (const group of RULES_STACKING_GROUPS) {
    const members = effects.filter(effect => effect.stackingGroup === group);
    const sets = members.filter(effect => effect.operation === 'set');
    if (sets.length > 1) throw new RulesError('INVALID_RULES', 'Несколько capability set в одной группе');
    if (sets[0]) current = sets[0].value;
    current += members.filter(effect => effect.operation === 'add').reduce((sum, effect) => sum + effect.value, 0);
  }
  for (const effect of effects) if (effect.cap !== null) current = Math.min(current, effect.cap);
  return current;
}

const statKeys: Partial<Record<RuleTarget, string>> = {
  'ship-speed': 'speed', 'ship-shield': 'shield', 'weapon-damage': 'damage', 'weapon-range': 'range',
  'facility-output': 'output', 'fleet-capacity': 'capacity'
};

export function applyRulesSnapshotToStats(
  base: Readonly<Record<string, number>>, input: unknown, options: RulesApplicationOptions = {}
): Record<string, number> {
  const snapshot = validateRulesSnapshot(input);
  const effects = prepareEffects(snapshot.effects, options);
  const activated = activateRulesEffects(snapshot, effects.map(effect => effect.id), ['library-numeric-v1']);
  const result = z.record(z.number().finite().nonnegative()).parse(base);
  for (const target of RULES_TARGETS) {
    const members = activated.filter(effect => effect.target === target);
    if (!members.length) continue;
    const key = statKeys[target];
    if (!key || !Object.prototype.hasOwnProperty.call(result, key)) {
      throw new RulesError('INVALID_RULES', `Отсутствует базовая характеристика ${target}`);
    }
    result[key] = applyNumericEffects(result[key], members, options);
  }
  return result;
}

export function buildRulesFixture(): RulesSnapshot {
  return createDefaultRulesSnapshot();
}
