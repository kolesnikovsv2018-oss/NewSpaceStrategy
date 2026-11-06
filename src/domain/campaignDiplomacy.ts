/**
 * campaignDiplomacy.ts — Н16: культурное влияние и дипломатия двух сторон.
 *
 * Канонический контракт (план reports/2026-11-06/plan-n16.md):
 *  - общий раунд = пара ходов (blue + red); счётчик раундов растёт ровно после
 *    endTurn, завершающего red-ход; это единственная точка истечения сроков;
 *  - первый контакт — односторонний факт визуального обнаружения; право предложения
 *    у видящей стороны; получатель легально узнаёт о контакте через предложение;
 *  - стартовое состояние: мир, доверие 0, репутация {blue:100, red:100}, влияние {blue:0, red:0};
 *  - война начинается явным объявлением или захватом чужой колонии в мире (casus belli);
 *    мир из войны — только согласованное перемирие (4 раунда);
 *  - бои в мире не объявляют войну (журнал), захват в мире объявляет войну сам;
 *  - активное перемирие закрывает бои и захват (treaty gate); сотрудничество действует в мире и прекращается при любой войне;
 *  - declareWar: репутация −25, доверие −50, активные договоры прекращаются,
 *    в журнале breach, veto-окно 4 раунда против предложений нарушителя;
 *  - обмен — односторонний перевод казна→казна: propose проверяет казну автора без
 *    списания, accept повторно проверяет обе казны и атомарно проводит перевод;
 *  - сотрудничество (только мир): +25 очков науки за собственный ход, 4 хода,
 *    суммарный потолок 100 за договор, действует с принятого следующего own хода;
 *  - культура: за собственный ход переводится до 5 очков резерва культуры во влияние.
 */
import { z } from 'zod';

export const DIPLOMACY_MAX_ROUND = 100;
export const DIPLOMACY_PROPOSAL_ID_LIMIT = 10000;
export const DIPLOMACY_TREATY_ID_LIMIT = 10000;
export const DIPLOMACY_JOURNAL_LIMIT = 64;
export const DIPLOMACY_PROPOSAL_HISTORY_LIMIT = 24;
export const DIPLOMACY_TREATY_HISTORY_LIMIT = 12;
export const DIPLOMACY_AMOUNT_LIMIT = 10000;

export type DiplomacyFactionId = 'blue' | 'red';
export type DiplomacyProposalKind = 'armistice' | 'exchange' | 'coop';
export type DiplomacyJournalKind = 'contact' | 'proposal' | 'accepted' | 'declined' | 'withdrawn' | 'expired'
  | 'battle-peace' | 'capture' | 'war-declared' | 'breach' | 'armistice-expired' | 'coop-ended';

const factionSchema = z.enum(['blue', 'red']);
const sideValueSchema = z.number().int().min(0).max(100);
const roundValueSchema = z.number().int().min(0).max(DIPLOMACY_MAX_ROUND);
const futureRoundSchema = z.number().int().min(0).max(DIPLOMACY_MAX_ROUND + 20);
const nullRoundSchema = roundValueSchema.nullable();
const coopTurnsSchema = z.number().int().min(0).max(20);

export const diplomacyPayloadSchema = z.object({
  credits: z.number().int().min(0).max(DIPLOMACY_AMOUNT_LIMIT),
  minerals: z.number().int().min(0).max(DIPLOMACY_AMOUNT_LIMIT),
}).strict();

export const diplomacyProposalKindSchema = z.enum(['armistice', 'exchange', 'coop']);

export const diplomacyProposalSchema = z.object({
  id: z.number().int().min(1).max(DIPLOMACY_PROPOSAL_ID_LIMIT),
  author: factionSchema,
  recipient: factionSchema,
  kind: diplomacyProposalKindSchema,
  payload: diplomacyPayloadSchema.nullable(),
  status: z.enum(['pending', 'accepted', 'declined', 'withdrawn', 'expired']),
  createdRound: roundValueSchema,
  deadlineRound: futureRoundSchema,
}).strict().superRefine((proposal, context) => {
  if (proposal.author === proposal.recipient) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recipient'], message: 'Предложение адресовано самому себе' });
  }
  if (proposal.deadlineRound < proposal.createdRound) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['deadlineRound'], message: 'Срок предложения раньше раунда создания' });
  }
  if (proposal.kind === 'exchange') {
    if (proposal.payload === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload'], message: 'Обмену нужны переносимые ресурсы' });
    } else if (proposal.payload.credits + proposal.payload.minerals <= 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload'], message: 'Обмен с нулевой суммой' });
    }
  } else if (proposal.payload !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload'], message: 'Только обмен переносит ресурсы' });
  }
});

export const diplomacyTreatySchema = z.object({
  id: z.number().int().min(1).max(DIPLOMACY_TREATY_ID_LIMIT),
  kind: z.enum(['armistice', 'coop']),
  acceptedRound: roundValueSchema,
  expiryRound: futureRoundSchema.nullable(),
  coopTurnsLeft: z.object({ blue: coopTurnsSchema, red: coopTurnsSchema }).strict().nullable(),
  coopBonusUsed: z.object({ blue: z.number().int().min(0), red: z.number().int().min(0) }).strict().nullable(),
  active: z.boolean(),
}).strict().superRefine((treaty, context) => {
  if (treaty.kind === 'armistice') {
    if (treaty.expiryRound === null || treaty.coopTurnsLeft !== null || treaty.coopBonusUsed !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'Недопустимые поля перемирия' });
    } else if (treaty.expiryRound < treaty.acceptedRound) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiryRound'], message: 'Срок перемирия раньше раунда заключения' });
    }
  } else if (treaty.expiryRound !== null || treaty.coopTurnsLeft === null || treaty.coopBonusUsed === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'Недопустимые поля сотрудничества' });
  }
});

export const diplomacyJournalSchema = z.object({
  id: z.number().int().min(1),
  round: roundValueSchema,
  kind: z.enum(['contact', 'proposal', 'accepted', 'declined', 'withdrawn', 'expired', 'battle-peace', 'capture',
    'war-declared', 'breach', 'armistice-expired', 'coop-ended']),
  side: factionSchema.nullable(),
  text: z.string().min(1).max(200),
}).strict();

export const diplomacyStateSchema = z.object({
  round: roundValueSchema,
  war: z.boolean(),
  trust: z.number().int().min(-100).max(100),
  reputation: z.object({ blue: sideValueSchema, red: sideValueSchema }).strict(),
  influence: z.object({ blue: sideValueSchema, red: sideValueSchema }).strict(),
  contact: z.object({ blue: nullRoundSchema, red: nullRoundSchema }).strict(),
  veto: z.object({
    capture: z.object({ blue: nullRoundSchema, red: nullRoundSchema }).strict(),
    breach: z.object({ blue: nullRoundSchema, red: nullRoundSchema }).strict(),
  }).strict(),
  nextProposalId: z.number().int().min(1).max(DIPLOMACY_PROPOSAL_ID_LIMIT + 1),
  nextTreatyId: z.number().int().min(1).max(DIPLOMACY_TREATY_ID_LIMIT + 1),
  nextJournalId: z.number().int().min(1),
  proposals: z.array(diplomacyProposalSchema).max(DIPLOMACY_PROPOSAL_HISTORY_LIMIT),
  treaties: z.array(diplomacyTreatySchema).max(DIPLOMACY_TREATY_HISTORY_LIMIT),
  journal: z.array(diplomacyJournalSchema).max(DIPLOMACY_JOURNAL_LIMIT),
}).strict().superRefine((state, context) => {
  const pendingByAuthor = new Map<string, number>();
  for (const proposal of state.proposals) {
    if (proposal.status !== 'pending') continue;
    pendingByAuthor.set(proposal.author, (pendingByAuthor.get(proposal.author) ?? 0) + 1);
  }
  for (const [author, count] of pendingByAuthor) {
    if (count > 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['proposals'], message: `У стороны ${author} больше одного активного предложения` });
    }
  }
  const proposalIds = state.proposals.map(proposal => proposal.id);
  if (new Set(proposalIds).size !== proposalIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['proposals'], message: 'Идентификаторы предложений повторяются' });
  }
  for (const proposal of state.proposals) {
    if (proposal.id >= state.nextProposalId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['proposals'], message: 'Идентификатор предложения вне счётчика' });
    }
  }
  const treatyIds = state.treaties.map(treaty => treaty.id);
  if (new Set(treatyIds).size !== treatyIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['treaties'], message: 'Идентификаторы договоров повторяются' });
  }
  for (const treaty of state.treaties) {
    if (treaty.id >= state.nextTreatyId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['treaties'], message: 'Идентификатор договора вне счётчика' });
    }
  }
  if (state.war && state.treaties.some(treaty => treaty.active)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['war'], message: 'Активные договоры противоречат состоянию войны' });
  }
  for (const proposal of state.proposals) {
    if (proposal.status !== 'pending') continue;
    if (proposal.kind === 'coop' && state.war) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['proposals'], message: 'Сотрудничество не предлагается в состоянии войны' });
    }
    if (proposal.kind === 'armistice' && !state.war) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['proposals'], message: 'Перемирие не предлагается в состоянии мира' });
    }
  }
  const futureMark = (mark: number | null) => mark !== null && mark > state.round;
  if (futureMark(state.contact.blue) || futureMark(state.contact.red) ||
    futureMark(state.veto.capture.blue) || futureMark(state.veto.capture.red) ||
    futureMark(state.veto.breach.blue) || futureMark(state.veto.breach.red)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['veto'], message: 'Отметка из будущего раунда' });
  }
  for (const entry of state.journal) {
    if (entry.round > state.round) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['journal'], message: 'Запись журнала из будущего раунда' });
    }
  }
});

export const diplomacyRulesSchema = z.object({
  proposalDeadlineRounds: z.number().int().min(1).max(20),
  armisticeRounds: z.number().int().min(1).max(20),
  maxPendingPerSide: z.number().int().min(1).max(5),
  exchangeMaxAmount: z.number().int().min(1).max(DIPLOMACY_AMOUNT_LIMIT),
  vetoWindowRounds: z.number().int().min(0).max(20),
  coop: z.object({
    bonusPerOwnTurn: z.number().int().min(1).max(1000),
    ownTurnsLimit: z.number().int().min(1).max(20),
    totalCap: z.number().int().min(1).max(10000),
  }).strict(),
  breach: z.object({
    reputationPenalty: z.number().int().min(0).max(100),
    trustPenalty: z.number().int().min(0).max(100),
  }).strict(),
  trustChanges: z.object({
    exchangeAccepted: z.number().int().min(-100).max(100),
    coopAccepted: z.number().int().min(-100).max(100),
  }).strict(),
  culture: z.object({
    transferPerOwnTurn: z.number().int().min(0).max(1000),
    influenceCap: z.number().int().min(0).max(100),
  }).strict(),
  score: z.object({
    reputationOffset: z.number().int().min(0).max(100),
    reputationDivisor: z.number().int().min(1).max(10),
    reputationCap: z.number().int().min(1).max(50),
    trustDivisor: z.number().int().min(1).max(10),
    trustCap: z.number().int().min(1).max(50),
    cultureDivisor: z.number().int().min(1).max(100),
    cultureCap: z.number().int().min(0).max(50),
    exchangeCreditsDivisor: z.number().int().min(1).max(100),
    exchangeMineralsDivisor: z.number().int().min(1).max(100),
    exchangeBenefitCap: z.number().int().min(1).max(1000),
    coopBase: z.number().int().min(-100).max(100),
    armisticeBase: z.number().int().min(-100).max(100),
    threatCap: z.number().int().min(0).max(100),
    acceptThreshold: z.number().int().min(-100).max(100),
    armisticeThreshold: z.number().int().min(-100).max(100),
  }).strict(),
}).strict();

export type DiplomacyProposal = z.infer<typeof diplomacyProposalSchema>;
export type DiplomacyTreaty = z.infer<typeof diplomacyTreatySchema>;
export type DiplomacyJournalEntry = z.infer<typeof diplomacyJournalSchema>;
export type DiplomacyState = z.infer<typeof diplomacyStateSchema>;
export type DiplomacyRules = z.infer<typeof diplomacyRulesSchema>;

export type DiplomacyOperationResult = { ok: true } | { ok: false; code: string; reason: string };
export interface DiplomacyTreasuryView { credits: number; minerals: number }

export const defaultDiplomacyRules: DiplomacyRules = {
  proposalDeadlineRounds: 4,
  armisticeRounds: 4,
  maxPendingPerSide: 1,
  exchangeMaxAmount: DIPLOMACY_AMOUNT_LIMIT,
  vetoWindowRounds: 4,
  coop: { bonusPerOwnTurn: 25, ownTurnsLimit: 4, totalCap: 100 },
  breach: { reputationPenalty: 25, trustPenalty: 50 },
  trustChanges: { exchangeAccepted: 10, coopAccepted: 10 },
  culture: { transferPerOwnTurn: 5, influenceCap: 100 },
  score: {
    reputationOffset: 50,
    reputationDivisor: 2,
    reputationCap: 25,
    trustDivisor: 4,
    trustCap: 25,
    cultureDivisor: 10,
    cultureCap: 10,
    exchangeCreditsDivisor: 10,
    exchangeMineralsDivisor: 5,
    exchangeBenefitCap: 50,
    coopBase: 10,
    armisticeBase: 0,
    threatCap: 10,
    acceptThreshold: 0,
    armisticeThreshold: 1,
  },
};

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const factionLabels: Record<DiplomacyFactionId, string> = { blue: 'Синие', red: 'Красные' };

export function diplomacyFactionLabel(side: DiplomacyFactionId): string {
  return factionLabels[side];
}

export function diplomacyProposalLabel(kind: DiplomacyProposalKind): string {
  return kind === 'armistice' ? 'перемирие' : kind === 'coop' ? 'сотрудничество' : 'обмен ресурсами';
}

function pushJournal(state: DiplomacyState, kind: DiplomacyJournalKind, side: DiplomacyFactionId | null, text: string): void {
  const entry: DiplomacyJournalEntry = { id: state.nextJournalId, round: state.round, kind, side, text };
  state.nextJournalId += 1;
  state.journal.push(entry);
  if (state.journal.length > DIPLOMACY_JOURNAL_LIMIT) {
    state.journal.splice(0, state.journal.length - DIPLOMACY_JOURNAL_LIMIT);
  }
}

function trimResolvedProposals(state: DiplomacyState): void {
  if (state.proposals.length <= DIPLOMACY_PROPOSAL_HISTORY_LIMIT) return;
  const overflow = state.proposals.length - DIPLOMACY_PROPOSAL_HISTORY_LIMIT;
  const dropIds = new Set(state.proposals.filter(proposal => proposal.status !== 'pending').slice(0, overflow).map(proposal => proposal.id));
  state.proposals = state.proposals.filter(proposal => !dropIds.has(proposal.id));
}

function trimTreaties(state: DiplomacyState): void {
  if (state.treaties.length <= DIPLOMACY_TREATY_HISTORY_LIMIT) return;
  const overflow = state.treaties.length - DIPLOMACY_TREATY_HISTORY_LIMIT;
  const dropIds = new Set(state.treaties.filter(treaty => !treaty.active).slice(0, overflow).map(treaty => treaty.id));
  state.treaties = state.treaties.filter(treaty => !dropIds.has(treaty.id));
}

export function createInitialDiplomacyState(): DiplomacyState {
  return {
    round: 0,
    war: false,
    trust: 0,
    reputation: { blue: 100, red: 100 },
    influence: { blue: 0, red: 0 },
    contact: { blue: null, red: null },
    veto: { capture: { blue: null, red: null }, breach: { blue: null, red: null } },
    nextProposalId: 1,
    nextTreatyId: 1,
    nextJournalId: 1,
    proposals: [],
    treaties: [],
    journal: [],
  };
}

export function recordDiplomacyContact(state: DiplomacyState, side: DiplomacyFactionId): void {
  if (state.contact[side] !== null) return;
  state.contact[side] = state.round;
  pushJournal(state, 'contact', side, `${factionLabels[side]} визуально обнаружили противника`);
}

export function hasDiplomacyContact(state: DiplomacyState, side: DiplomacyFactionId): boolean {
  return state.contact[side] !== null;
}

export function findActiveDiplomacyTreaty(state: DiplomacyState, kind: 'armistice' | 'coop'): DiplomacyTreaty | null {
  return state.treaties.find(treaty => treaty.active && treaty.kind === kind) ?? null;
}

export function hasActiveArmistice(state: DiplomacyState): boolean {
  return findActiveDiplomacyTreaty(state, 'armistice') !== null;
}

export function hasActiveCoop(state: DiplomacyState): boolean {
  return findActiveDiplomacyTreaty(state, 'coop') !== null;
}

export function canProposeDiplomacy(state: DiplomacyState, side: DiplomacyFactionId, kind: DiplomacyProposalKind, rules: DiplomacyRules): { allowed: boolean; code: string; reason: string } {
  if (!hasDiplomacyContact(state, side)) return { allowed: false, code: 'no-contact', reason: 'Нет контакта с другой стороной' };
  if (kind === 'armistice' && !state.war) return { allowed: false, code: 'not-at-war', reason: 'Перемирие возможно только в состоянии войны' };
  if (kind === 'coop' && state.war) return { allowed: false, code: 'war-blocks-coop', reason: 'Сотрудничество невозможно в состоянии войны' };
  const pendingCount = state.proposals.filter(proposal => proposal.status === 'pending' && proposal.author === side).length;
  if (pendingCount >= rules.maxPendingPerSide) return { allowed: false, code: 'pending-limit', reason: 'У вас уже есть активное предложение' };
  return { allowed: true, code: '', reason: '' };
}

export interface DiplomacyProposeInput {
  state: DiplomacyState;
  author: DiplomacyFactionId;
  kind: DiplomacyProposalKind;
  payload: { credits: number; minerals: number } | null;
  authorTreasury: DiplomacyTreasuryView;
  rules: DiplomacyRules;
}

export type DiplomacyProposeResult =
  | { ok: true; proposal: DiplomacyProposal }
  | { ok: false; code: string; reason: string };

export function proposeDiplomacy(input: DiplomacyProposeInput): DiplomacyProposeResult {
  const { state, author, kind, payload, authorTreasury, rules } = input;
  const gate = canProposeDiplomacy(state, author, kind, rules);
  if (!gate.allowed) return { ok: false, code: gate.code, reason: gate.reason };
  const recipient: DiplomacyFactionId = author === 'blue' ? 'red' : 'blue';
  let normalizedPayload: { credits: number; minerals: number } | null = null;
  if (kind === 'exchange') {
    if (payload === null || (payload.credits <= 0 && payload.minerals <= 0)) {
      return { ok: false, code: 'exchange-empty', reason: 'Обмен требует ненулевой перевод ресурсов' };
    }
    if (payload.credits > rules.exchangeMaxAmount || payload.minerals > rules.exchangeMaxAmount) {
      return { ok: false, code: 'exchange-limit', reason: 'Сумма обмена превышает допустимую' };
    }
    if (payload.credits > authorTreasury.credits || payload.minerals > authorTreasury.minerals) {
      return { ok: false, code: 'insufficient-treasury', reason: 'Недостаточно ресурсов в казне для предложения обмена' };
    }
    normalizedPayload = { credits: payload.credits, minerals: payload.minerals };
  }
  const proposal: DiplomacyProposal = {
    id: state.nextProposalId,
    author,
    recipient,
    kind,
    payload: normalizedPayload,
    status: 'pending',
    createdRound: state.round,
    deadlineRound: state.round + rules.proposalDeadlineRounds,
  };
  state.nextProposalId += 1;
  state.proposals.push(proposal);
  if (state.contact[recipient] === null) {
    state.contact[recipient] = state.round;
    pushJournal(state, 'contact', recipient, `${factionLabels[recipient]} узнали о противнике через предложение`);
  }
  pushJournal(state, 'proposal', author, `${factionLabels[author]} предложили ${diplomacyProposalLabel(kind)}`);
  trimResolvedProposals(state);
  return { ok: true, proposal };
}

export interface DiplomacyAcceptInput {
  state: DiplomacyState;
  actor: DiplomacyFactionId;
  proposalId: number;
  authorTreasury: DiplomacyTreasuryView;
  rules: DiplomacyRules;
}

export type DiplomacyAcceptResult =
  | { ok: true; treaty: DiplomacyTreaty | null; transfer: { credits: number; minerals: number } | null }
  | { ok: false; code: string; reason: string };

function expireStaleProposal(state: DiplomacyState, proposal: DiplomacyProposal): void {
  proposal.status = 'expired';
  pushJournal(state, 'expired', proposal.author, `Предложение №${proposal.id} истекло по сроку`);
}

function expireConflictingPendingProposals(state: DiplomacyState): void {
  for (const proposal of state.proposals) {
    if (proposal.status !== 'pending') continue;
    if ((proposal.kind === 'coop' && state.war) || (proposal.kind === 'armistice' && !state.war)) {
      expireStaleProposal(state, proposal);
    }
  }
}

export function acceptDiplomacyProposal(input: DiplomacyAcceptInput): DiplomacyAcceptResult {
  const { state, actor, proposalId, authorTreasury, rules } = input;
  const proposal = state.proposals.find(item => item.id === proposalId);
  if (!proposal) return { ok: false, code: 'not-found', reason: 'Предложение не найдено' };
  if (proposal.recipient !== actor) return { ok: false, code: 'not-recipient', reason: 'Принять может только адресат предложения' };
  if (proposal.status !== 'pending') return { ok: false, code: 'not-pending', reason: 'Предложение уже обработано' };
  if (state.round >= proposal.deadlineRound) {
    expireStaleProposal(state, proposal);
    return { ok: false, code: 'expired', reason: 'Срок предложения истёк' };
  }
  if (proposal.kind === 'coop' && state.war) return { ok: false, code: 'war-blocks-coop', reason: 'Сотрудничество невозможно в состоянии войны' };
  if (proposal.kind === 'armistice' && !state.war) return { ok: false, code: 'not-at-war', reason: 'Перемирие возможно только в состоянии войны' };
  if (proposal.payload !== null) {
    if (proposal.payload.credits > authorTreasury.credits || proposal.payload.minerals > authorTreasury.minerals) {
      return { ok: false, code: 'insufficient-treasury', reason: 'Недостаточно ресурсов в казне автора — обмен отклонён целиком' };
    }
  }
  proposal.status = 'accepted';
  let treaty: DiplomacyTreaty | null = null;
  let transfer: { credits: number; minerals: number } | null = null;
  if (proposal.kind === 'armistice') {
    treaty = {
      id: state.nextTreatyId,
      kind: 'armistice',
      acceptedRound: state.round,
      expiryRound: state.round + rules.armisticeRounds,
      coopTurnsLeft: null,
      coopBonusUsed: null,
      active: true,
    };
    state.nextTreatyId += 1;
    state.treaties.push(treaty);
    state.war = false;
    expireConflictingPendingProposals(state);
  } else if (proposal.kind === 'coop') {
    treaty = {
      id: state.nextTreatyId,
      kind: 'coop',
      acceptedRound: state.round,
      expiryRound: null,
      coopTurnsLeft: { blue: rules.coop.ownTurnsLimit, red: rules.coop.ownTurnsLimit },
      coopBonusUsed: { blue: 0, red: 0 },
      active: true,
    };
    state.nextTreatyId += 1;
    state.treaties.push(treaty);
  } else {
    const payload = proposal.payload;
    if (payload === null) return { ok: false, code: 'exchange-invalid', reason: 'Обмен без ресурсов невозможен' };
    transfer = { credits: payload.credits, minerals: payload.minerals };
  }
  const trustChange = proposal.kind === 'exchange' ? rules.trustChanges.exchangeAccepted
    : proposal.kind === 'coop' ? rules.trustChanges.coopAccepted : 0;
  if (trustChange !== 0) state.trust = clampInt(state.trust + trustChange, -100, 100);
  pushJournal(state, 'accepted', actor, `${factionLabels[actor]} приняли предложение №${proposal.id} (${diplomacyProposalLabel(proposal.kind)})`);
  trimTreaties(state);
  return { ok: true, treaty, transfer };
}

export function declineDiplomacyProposal(state: DiplomacyState, actor: DiplomacyFactionId, proposalId: number): DiplomacyOperationResult {
  const proposal = state.proposals.find(item => item.id === proposalId);
  if (!proposal) return { ok: false, code: 'not-found', reason: 'Предложение не найдено' };
  if (proposal.recipient !== actor) return { ok: false, code: 'not-recipient', reason: 'Отклонить может только адресат предложения' };
  if (proposal.status !== 'pending') return { ok: false, code: 'not-pending', reason: 'Предложение уже обработано' };
  if (state.round >= proposal.deadlineRound) {
    expireStaleProposal(state, proposal);
    return { ok: false, code: 'expired', reason: 'Срок предложения истёк' };
  }
  proposal.status = 'declined';
  pushJournal(state, 'declined', actor, `${factionLabels[actor]} отклонили предложение №${proposal.id}`);
  trimResolvedProposals(state);
  return { ok: true };
}

export function withdrawDiplomacyProposal(state: DiplomacyState, actor: DiplomacyFactionId, proposalId: number): DiplomacyOperationResult {
  const proposal = state.proposals.find(item => item.id === proposalId);
  if (!proposal) return { ok: false, code: 'not-found', reason: 'Предложение не найдено' };
  if (proposal.author !== actor) return { ok: false, code: 'not-author', reason: 'Отозвать можно только своё предложение' };
  if (proposal.status !== 'pending') return { ok: false, code: 'not-pending', reason: 'Предложение уже обработано' };
  proposal.status = 'withdrawn';
  pushJournal(state, 'withdrawn', actor, `${factionLabels[actor]} отозвали предложение №${proposal.id}`);
  trimResolvedProposals(state);
  return { ok: true };
}

function applyBreachCosts(state: DiplomacyState, side: DiplomacyFactionId, rules: DiplomacyRules): void {
  state.reputation[side] = clampInt(state.reputation[side] - rules.breach.reputationPenalty, 0, 100);
  state.trust = clampInt(state.trust - rules.breach.trustPenalty, -100, 100);
}

function deactivateTreatiesOnWar(state: DiplomacyState, side: DiplomacyFactionId | null, reason: string): void {
  for (const treaty of state.treaties) {
    if (!treaty.active) continue;
    treaty.active = false;
    if (treaty.kind === 'coop') {
      pushJournal(state, 'coop-ended', side, `Сотрудничество №${treaty.id} прекращено: ${reason}`);
    }
  }
}

export function declareDiplomacyWar(state: DiplomacyState, side: DiplomacyFactionId, rules: DiplomacyRules): DiplomacyOperationResult {
  if (state.war) return { ok: false, code: 'already-at-war', reason: 'Война уже идёт' };
  state.war = true;
  applyBreachCosts(state, side, rules);
  state.veto.breach[side] = state.round;
  const hadArmistice = state.treaties.some(treaty => treaty.active && treaty.kind === 'armistice');
  deactivateTreatiesOnWar(state, side, 'объявление войны');
  expireConflictingPendingProposals(state);
  pushJournal(state, 'breach', side, `${factionLabels[side]} объявляют войну${hadArmistice ? ', нарушив перемирие' : ''}`);
  return { ok: true };
}

export function declareWarByCapture(state: DiplomacyState, side: DiplomacyFactionId, rules: DiplomacyRules): { declared: boolean } {
  if (state.war) return { declared: false };
  state.war = true;
  applyBreachCosts(state, side, rules);
  state.veto.capture[side] = state.round;
  deactivateTreatiesOnWar(state, side, 'захват колонии в состоянии мира');
  expireConflictingPendingProposals(state);
  pushJournal(state, 'capture', side, `${factionLabels[side]} захватили колонию в состоянии мира — война объявлена`);
  return { declared: true };
}

export function recordPeaceBattle(state: DiplomacyState, attacker: DiplomacyFactionId): void {
  pushJournal(state, 'battle-peace', attacker, `${factionLabels[attacker]} вступили в бой в состоянии мира (война не объявлена)`);
}

export function advanceDiplomacyRound(state: DiplomacyState): void {
  if (state.round >= DIPLOMACY_MAX_ROUND) return;
  state.round += 1;
  for (const proposal of state.proposals) {
    if (proposal.status === 'pending' && proposal.deadlineRound <= state.round) {
      expireStaleProposal(state, proposal);
    }
  }
  let warResumed = false;
  for (const treaty of state.treaties) {
    if (treaty.active && treaty.kind === 'armistice' && treaty.expiryRound !== null && treaty.expiryRound <= state.round) {
      treaty.active = false;
      warResumed = true;
      pushJournal(state, 'armistice-expired', null, `Перемирие №${treaty.id} истекло — война возобновилась`);
    }
  }
  if (warResumed) {
    state.war = true;
    deactivateTreatiesOnWar(state, null, 'возобновление войны');
    expireConflictingPendingProposals(state);
  }
  trimResolvedProposals(state);
  trimTreaties(state);
}

export function grantCoopBonus(state: DiplomacyState, side: DiplomacyFactionId, rules: DiplomacyRules): { bonus: number } {
  if (state.war) return { bonus: 0 };
  const treaty = state.treaties.find(item => item.active && item.kind === 'coop');
  if (!treaty || treaty.coopTurnsLeft === null || treaty.coopBonusUsed === null) return { bonus: 0 };
  if (state.round <= treaty.acceptedRound) return { bonus: 0 };
  const turnsLeft = treaty.coopTurnsLeft[side];
  if (turnsLeft <= 0) return { bonus: 0 };
  const used = treaty.coopBonusUsed[side];
  const bonus = Math.min(rules.coop.bonusPerOwnTurn, rules.coop.totalCap - used);
  if (bonus <= 0) {
    treaty.coopTurnsLeft[side] = 0;
    return { bonus: 0 };
  }
  treaty.coopTurnsLeft[side] = turnsLeft - 1;
  treaty.coopBonusUsed[side] = used + bonus;
  if (treaty.coopTurnsLeft.blue === 0 && treaty.coopTurnsLeft.red === 0) {
    treaty.active = false;
    pushJournal(state, 'coop-ended', null, `Сотрудничество №${treaty.id} завершено`);
  }
  return { bonus };
}

export function computeCultureTransfer(currentInfluence: number, culturePoints: number, rules: DiplomacyRules): { influenceDelta: number; cultureSpend: number } {
  const headroom = Math.max(0, rules.culture.influenceCap - currentInfluence);
  const transfer = Math.min(rules.culture.transferPerOwnTurn, culturePoints, headroom);
  return { influenceDelta: transfer, cultureSpend: transfer };
}

export interface DiplomacyScoreInput {
  reputation: number;
  trust: number;
  influence: number;
  vetoActive: boolean;
  kind: DiplomacyProposalKind;
  payload: { credits: number; minerals: number } | null;
  threat: number;
  rules: DiplomacyRules;
}

export function vetoActive(state: DiplomacyState, side: DiplomacyFactionId, rules: DiplomacyRules): boolean {
  const marks = [state.veto.capture[side], state.veto.breach[side]];
  return marks.some(mark => mark !== null && state.round - mark < rules.vetoWindowRounds);
}

export function evaluateAgreementScore(input: DiplomacyScoreInput): number {
  const { reputation, trust, influence, kind, payload, threat, rules } = input;
  const s = rules.score;
  const reputationTerm = clampInt(Math.floor((reputation - s.reputationOffset) / s.reputationDivisor), -s.reputationCap, s.reputationCap);
  const trustTerm = clampInt(Math.floor(trust / s.trustDivisor), -s.trustCap, s.trustCap);
  const cultureBonus = Math.min(s.cultureCap, Math.floor(influence / s.cultureDivisor));
  let benefit = 0;
  if (kind === 'exchange' && payload !== null) {
    benefit = Math.min(s.exchangeBenefitCap, Math.floor(payload.credits / s.exchangeCreditsDivisor) + Math.floor(payload.minerals / s.exchangeMineralsDivisor));
  } else if (kind === 'coop') benefit = s.coopBase;
  const base = kind === 'armistice' ? s.armisticeBase : kind === 'coop' ? s.coopBase : 0;
  const threatTerm = kind === 'armistice' ? Math.min(s.threatCap, Math.max(0, threat)) : 0;
  return base + reputationTerm + trustTerm + cultureBonus + benefit - threatTerm;
}

export interface DiplomacyAcceptDecision {
  acceptable: boolean;
  score: number;
  reasons: string[];
}

export function shouldAcceptDiplomacyProposal(input: DiplomacyScoreInput): DiplomacyAcceptDecision {
  const { vetoActive: authorVeto, kind, rules } = input;
  const score = evaluateAgreementScore(input);
  if (authorVeto) {
    return { acceptable: false, score, reasons: ['Автор предложения недавно нарушил мир или захватил колонию'] };
  }
  const threshold = kind === 'armistice' ? rules.score.armisticeThreshold : rules.score.acceptThreshold;
  return { acceptable: score >= threshold, score, reasons: score >= threshold ? [] : [`Оценка ${score} ниже порога ${threshold}`] };
}

export interface DiplomacyOwnView {
  round: number;
  war: boolean;
  trust: number;
  ownReputation: number;
  ownInfluence: number;
  otherReputation: number;
  otherInfluence: number;
  otherVetoActive: boolean;
  rules: DiplomacyRules;
  contacted: boolean;
  incomingPending: DiplomacyProposal | null;
  ownPending: DiplomacyProposal | null;
  recentIncoming: DiplomacyProposal[];
  recentOwn: DiplomacyProposal[];
  treaties: DiplomacyTreaty[];
  journal: DiplomacyJournalEntry[];
  armisticeExpiryRound: number | null;
}

export function getDiplomacyOwnView(state: DiplomacyState, side: DiplomacyFactionId, rules: DiplomacyRules): DiplomacyOwnView {
  const other: DiplomacyFactionId = side === 'blue' ? 'red' : 'blue';
  const involvingSide = state.proposals.filter(proposal => proposal.author === side || proposal.recipient === side);
  const armistice = findActiveDiplomacyTreaty(state, 'armistice');
  return {
    round: state.round,
    war: state.war,
    trust: state.trust,
    ownReputation: state.reputation[side],
    ownInfluence: state.influence[side],
    otherReputation: state.reputation[other],
    otherInfluence: state.influence[other],
    otherVetoActive: vetoActive(state, other, rules),
    rules,
    contacted: hasDiplomacyContact(state, side),
    incomingPending: involvingSide.find(proposal => proposal.recipient === side && proposal.status === 'pending') ?? null,
    ownPending: involvingSide.find(proposal => proposal.author === side && proposal.status === 'pending') ?? null,
    recentIncoming: involvingSide.filter(proposal => proposal.recipient === side).slice(-6),
    recentOwn: involvingSide.filter(proposal => proposal.author === side).slice(-6),
    treaties: state.treaties.slice(-6),
    journal: state.journal.slice(-12),
    armisticeExpiryRound: armistice && armistice.expiryRound !== null ? armistice.expiryRound : null,
  };
}
