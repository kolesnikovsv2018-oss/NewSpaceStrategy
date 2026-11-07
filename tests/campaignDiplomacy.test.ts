import { describe, expect, it } from 'vitest';
import {
  advanceDiplomacyRound, acceptDiplomacyProposal, canProposeDiplomacy, computeCultureTransfer,
  createInitialDiplomacyState, declareDiplomacyWar, declareWarByCapture, declineDiplomacyProposal,
  diplomacyStateSchema, evaluateAgreementScore, getDiplomacyOwnView, grantCoopBonus, hasActiveArmistice,
  proposeDiplomacy, recordDiplomacyContact, shouldAcceptDiplomacyProposal, vetoActive, withdrawDiplomacyProposal,
  DIPLOMACY_PROPOSAL_HISTORY_LIMIT, defaultDiplomacyRules,
  type DiplomacyState,
} from '../src/domain/campaignDiplomacy';
import { createConquest, executeConquestCommand, type Conquest, type ConquestCommand } from '../src/domain/conquest';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { activeOf } from './fixtures/conquestSides';

const rules = defaultDiplomacyRules;
const richTreasury = { credits: 1000, minerals: 500 };
const poorTreasury = { credits: 10, minerals: 0 };

function ok<T extends { ok: boolean; reason?: string }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(result.reason ?? 'unexpected failure');
  return result as Extract<T, { ok: true }>;
}

function contactedState(war = false): DiplomacyState {
  const state = createInitialDiplomacyState();
  recordDiplomacyContact(state, 'blue');
  recordDiplomacyContact(state, 'red');
  if (war) ok(declareDiplomacyWar(state, 'blue', rules));
  return state;
}

describe('campaignDiplomacy state invariants', () => {
  it('starts at peace with neutral counters and empty history', () => {
    const state = createInitialDiplomacyState();
    expect(state).toMatchObject({
      round: 0, war: false, trust: 0,
      reputation: { blue: 100, red: 100 }, influence: { blue: 0, red: 0 },
      contact: { blue: null, red: null },
      veto: { capture: { blue: null, red: null }, breach: { blue: null, red: null } },
      nextProposalId: 1, nextTreatyId: 1, nextJournalId: 1,
      proposals: [], treaties: [], journal: [],
    });
    expect(diplomacyStateSchema.parse(state)).toEqual(state);
  });

  it('first contact is one-sided, idempotent and journalled', () => {
    const state = createInitialDiplomacyState();
    expect(state.journal).toHaveLength(0);
    recordDiplomacyContact(state, 'blue');
    expect(state.contact.blue).toBe(0);
    expect(state.contact.red).toBeNull();
    const journalAfterFirst = state.journal.length;
    recordDiplomacyContact(state, 'blue');
    expect(state.journal).toHaveLength(journalAfterFirst);
    advanceDiplomacyRound(state);
    recordDiplomacyContact(state, 'red');
    expect(state.contact.red).toBe(1);
    expect(state.journal.filter(entry => entry.kind === 'contact')).toHaveLength(2);
  });

  it('proposal contact propagates to the recipient who did not see the enemy', () => {
    const state = createInitialDiplomacyState();
    recordDiplomacyContact(state, 'blue');
    ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    expect(state.contact.red).toBe(0);
    expect(state.journal.some(entry => entry.kind === 'contact' && entry.side === 'red')).toBe(true);
  });

  it('state schema rejects double pending proposals per author and war with active treaties', () => {
    const state = contactedState();
    state.proposals.push({ id: 1, author: 'blue', recipient: 'red', kind: 'coop', payload: null, status: 'pending', createdRound: 0, deadlineRound: 4 });
    state.proposals.push({ id: 2, author: 'blue', recipient: 'red', kind: 'exchange', payload: { credits: 10, minerals: 10 }, status: 'pending', createdRound: 0, deadlineRound: 4 });
    expect(diplomacyStateSchema.safeParse(state).success).toBe(false);
    const warm = contactedState(true);
    warm.treaties.push({ id: 1, kind: 'armistice', acceptedRound: 0, expiryRound: 4, coopTurnsLeft: null, coopBonusUsed: null, active: true });
    expect(diplomacyStateSchema.safeParse(warm).success).toBe(false);
  });
});

describe('campaignDiplomacy proposals', () => {
  it('propose gates enforce contact, war state and pending limits', () => {
    const state = createInitialDiplomacyState();
    expect(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }))
      .toMatchObject({ ok: false, code: 'no-contact' });
    expect(canProposeDiplomacy(state, 'blue', 'coop', rules)).toMatchObject({ allowed: false, code: 'no-contact' });
    recordDiplomacyContact(state, 'blue');
    expect(proposeDiplomacy({ state, author: 'blue', kind: 'armistice', payload: null, authorTreasury: richTreasury, rules }))
      .toMatchObject({ ok: false, code: 'not-at-war' });
    const pending = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    expect(pending.proposal).toMatchObject({ id: 1, author: 'blue', recipient: 'red', kind: 'coop', payload: null, status: 'pending', createdRound: 0, deadlineRound: 4 });
    expect(proposeDiplomacy({ state, author: 'blue', kind: 'exchange', payload: { credits: 10, minerals: 10 }, authorTreasury: richTreasury, rules }))
      .toMatchObject({ ok: false, code: 'pending-limit' });
    recordDiplomacyContact(state, 'red');
    expect(proposeDiplomacy({ state, author: 'red', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }).ok).toBe(true);
  });

  it('exchange propose validates payload and treasury without deducting', () => {
    const state = contactedState();
    expect(proposeDiplomacy({ state, author: 'blue', kind: 'exchange', payload: null, authorTreasury: richTreasury, rules }))
      .toMatchObject({ ok: false, code: 'exchange-empty' });
    expect(proposeDiplomacy({ state, author: 'blue', kind: 'exchange', payload: { credits: 10001, minerals: 0 }, authorTreasury: richTreasury, rules }))
      .toMatchObject({ ok: false, code: 'exchange-limit' });
    expect(proposeDiplomacy({ state, author: 'blue', kind: 'exchange', payload: { credits: 50, minerals: 0 }, authorTreasury: poorTreasury, rules }))
      .toMatchObject({ ok: false, code: 'insufficient-treasury' });
    expect(state.proposals).toHaveLength(0);
    expect(richTreasury).toEqual({ credits: 1000, minerals: 500 });
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'exchange', payload: { credits: 100, minerals: 50 }, authorTreasury: richTreasury, rules }));
    expect(proposed.proposal.payload).toEqual({ credits: 100, minerals: 50 });
    expect(richTreasury).toEqual({ credits: 1000, minerals: 500 });
  });

  it('accept/decline/withdraw enforce roles, pending state and expiry', () => {
    const state = contactedState();
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    const id = proposed.proposal.id;
    expect(acceptDiplomacyProposal({ state, actor: 'blue', proposalId: id, authorTreasury: richTreasury, rules }))
      .toMatchObject({ ok: false, code: 'not-recipient' });
    expect(declineDiplomacyProposal(state, 'blue', id)).toMatchObject({ ok: false, code: 'not-recipient' });
    expect(withdrawDiplomacyProposal(state, 'red', id)).toMatchObject({ ok: false, code: 'not-author' });
    expect(declineDiplomacyProposal(state, 'red', 99)).toMatchObject({ ok: false, code: 'not-found' });
    expect(ok(withdrawDiplomacyProposal(state, 'blue', id)).ok).toBe(true);
    expect(state.proposals[0].status).toBe('withdrawn');
    expect(withdrawDiplomacyProposal(state, 'blue', id)).toMatchObject({ ok: false, code: 'not-pending' });
    const late = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    for (let round = 0; round < rules.proposalDeadlineRounds; round += 1) advanceDiplomacyRound(state);
    // advance автоистекает предложение: статус уже expired, операции отвечают not-pending (гейт статуса раньше срока).
    expect(state.proposals.find(item => item.id === late.proposal.id)?.status).toBe('expired');
    expect(declineDiplomacyProposal(state, 'red', late.proposal.id)).toMatchObject({ ok: false, code: 'not-pending' });
    expect(acceptDiplomacyProposal({ state, actor: 'red', proposalId: late.proposal.id, authorTreasury: richTreasury, rules }))
      .toMatchObject({ ok: false, code: 'not-pending' });
    // Ленивый гейт срока: pending-предложение с наступившим дедлайном истекает при первой операции.
    const stale = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    state.round = stale.proposal.deadlineRound;
    expect(declineDiplomacyProposal(state, 'red', stale.proposal.id)).toMatchObject({ ok: false, code: 'expired' });
    expect(state.proposals.find(item => item.id === stale.proposal.id)?.status).toBe('expired');
  });

  it('exchange accept is atomic: fails whole without touching pending state', () => {
    const state = contactedState();
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'exchange', payload: { credits: 100, minerals: 50 }, authorTreasury: richTreasury, rules }));
    const before = structuredClone(state);
    expect(acceptDiplomacyProposal({ state, actor: 'red', proposalId: proposed.proposal.id, authorTreasury: poorTreasury, rules }))
      .toMatchObject({ ok: false, code: 'insufficient-treasury' });
    expect(state).toEqual(before);
    const accepted = ok(acceptDiplomacyProposal({ state, actor: 'red', proposalId: proposed.proposal.id, authorTreasury: richTreasury, rules }));
    expect(accepted.transfer).toEqual({ credits: 100, minerals: 50 });
    expect(accepted.treaty).toBeNull();
    expect(state.proposals[0].status).toBe('accepted');
    expect(state.trust).toBe(rules.trustChanges.exchangeAccepted);
    expect(richTreasury).toEqual({ credits: 1000, minerals: 500 });
  });

  it('armistice acceptance ends the war and schedules expiry', () => {
    const state = contactedState(true);
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'armistice', payload: null, authorTreasury: richTreasury, rules }));
    const accepted = ok(acceptDiplomacyProposal({ state, actor: 'red', proposalId: proposed.proposal.id, authorTreasury: richTreasury, rules }));
    expect(state.war).toBe(false);
    expect(accepted.treaty).toMatchObject({ kind: 'armistice', acceptedRound: 0, expiryRound: rules.armisticeRounds, active: true });
    expect(state.trust).toBe(-50);
    expect(hasActiveArmistice(state)).toBe(true);
  });

  it('coop acceptance creates a fresh treaty with per-side turns and trust gain', () => {
    const state = contactedState();
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    const accepted = ok(acceptDiplomacyProposal({ state, actor: 'red', proposalId: proposed.proposal.id, authorTreasury: richTreasury, rules }));
    expect(accepted.treaty).toMatchObject({ kind: 'coop', acceptedRound: 0, expiryRound: null, coopTurnsLeft: { blue: 4, red: 4 }, coopBonusUsed: { blue: 0, red: 0 }, active: true });
    expect(state.trust).toBe(rules.trustChanges.coopAccepted);
    expect(state.war).toBe(false);
  });
});

describe('campaignDiplomacy war and rounds', () => {
  it('declareDiplomacyWar applies breach costs, veto and deactivates treaties', () => {
    const state = contactedState();
    const coop = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    ok(acceptDiplomacyProposal({ state, actor: 'red', proposalId: coop.proposal.id, authorTreasury: richTreasury, rules }));
    expect(state.treaties[0].active).toBe(true);
    ok(declareDiplomacyWar(state, 'red', rules));
    expect(state.war).toBe(true);
    expect(state.reputation.red).toBe(75);
    expect(state.trust).toBe(-40);
    expect(state.veto.breach.red).toBe(0);
    expect(state.treaties[0].active).toBe(false);
    expect(state.journal.some(entry => entry.kind === 'breach')).toBe(true);
    expect(state.journal.some(entry => entry.kind === 'coop-ended')).toBe(true);
    expect(declareDiplomacyWar(state, 'blue', rules)).toMatchObject({ ok: false, code: 'already-at-war' });
  });

  it('declareWarByCapture is a casus belli with its own veto mark and costs', () => {
    const state = contactedState();
    const result = declareWarByCapture(state, 'red', rules);
    expect(result).toEqual({ declared: true });
    expect(state.war).toBe(true);
    expect(state.veto.capture.red).toBe(0);
    expect(state.veto.breach.red).toBeNull();
    expect(state.reputation.red).toBe(75);
    expect(state.trust).toBe(-50);
    expect(state.journal.some(entry => entry.kind === 'capture')).toBe(true);
    expect(declareWarByCapture(state, 'red', rules)).toEqual({ declared: false });
  });

  it('breach veto window blocks the violator for vetoWindowRounds', () => {
    const state = contactedState(true);
    expect(vetoActive(state, 'blue', rules)).toBe(true);
    advanceDiplomacyRound(state);
    advanceDiplomacyRound(state);
    advanceDiplomacyRound(state);
    expect(vetoActive(state, 'blue', rules)).toBe(true);
    advanceDiplomacyRound(state);
    expect(vetoActive(state, 'blue', rules)).toBe(false);
    expect(vetoActive(state, 'red', rules)).toBe(false);
  });

  it('armistice expiry resumes the war exactly once at the deadline round', () => {
    const state = contactedState(true);
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'armistice', payload: null, authorTreasury: richTreasury, rules }));
    ok(acceptDiplomacyProposal({ state, actor: 'red', proposalId: proposed.proposal.id, authorTreasury: richTreasury, rules }));
    expect(state.war).toBe(false);
    expect(state.treaties[0]).toMatchObject({ kind: 'armistice', acceptedRound: 0, expiryRound: rules.armisticeRounds, active: true });
    for (let round = 1; round < rules.armisticeRounds; round += 1) advanceDiplomacyRound(state);
    expect(hasActiveArmistice(state)).toBe(true);
    expect(state.war).toBe(false);
    advanceDiplomacyRound(state);
    expect(state.war).toBe(true);
    expect(hasActiveArmistice(state)).toBe(false);
    expect(state.journal.filter(entry => entry.kind === 'armistice-expired')).toHaveLength(1);
    advanceDiplomacyRound(state);
    expect(state.journal.filter(entry => entry.kind === 'armistice-expired')).toHaveLength(1);
    expect(state.war).toBe(true);
  });

  it('proposal expiry happens at the deadline round and only once', () => {
    const state = contactedState();
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    for (let round = 1; round < rules.proposalDeadlineRounds; round += 1) advanceDiplomacyRound(state);
    expect(state.proposals.find(item => item.id === proposed.proposal.id)?.status).toBe('pending');
    advanceDiplomacyRound(state);
    expect(state.proposals.find(item => item.id === proposed.proposal.id)?.status).toBe('expired');
    expect(state.journal.filter(entry => entry.kind === 'expired')).toHaveLength(1);
    advanceDiplomacyRound(state);
    expect(state.journal.filter(entry => entry.kind === 'expired')).toHaveLength(1);
  });

  it('history trimming keeps pending proposals and active treaties', () => {
    const state = contactedState();
    for (let cycle = 0; cycle < DIPLOMACY_PROPOSAL_HISTORY_LIMIT + 4; cycle += 1) {
      const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
      ok(withdrawDiplomacyProposal(state, 'blue', proposed.proposal.id));
    }
    expect(state.proposals.length).toBe(DIPLOMACY_PROPOSAL_HISTORY_LIMIT);
    expect(state.proposals.every(item => item.status !== 'pending')).toBe(true);
  });
});

describe('campaignDiplomacy cooperation and culture', () => {
  function coopTreatyState(): { state: DiplomacyState; treatyId: number } {
    const state = contactedState();
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    const accepted = ok(acceptDiplomacyProposal({ state, actor: 'red', proposalId: proposed.proposal.id, authorTreasury: richTreasury, rules }));
    return { state, treatyId: accepted.treaty!.id };
  }

  it('coop bonus starts the round after acceptance and spends per-side turns', () => {
    const { state, treatyId } = coopTreatyState();
    expect(state.war).toBe(false);
    expect(grantCoopBonus(state, 'blue', rules)).toEqual({ bonus: 0 });
    advanceDiplomacyRound(state);
    expect(grantCoopBonus(state, 'blue', rules)).toEqual({ bonus: 25 });
    expect(grantCoopBonus(state, 'red', rules)).toEqual({ bonus: 25 });
    const treaty = state.treaties.find(item => item.id === treatyId)!;
    expect(treaty.coopTurnsLeft).toEqual({ blue: 3, red: 3 });
    expect(treaty.coopBonusUsed).toEqual({ blue: 25, red: 25 });
    expect(treaty.active).toBe(true);
  });

  it('coop bonus respects the total cap and disables the treaty when exhausted', () => {
    const { state, treatyId } = coopTreatyState();
    const treaty = state.treaties.find(item => item.id === treatyId)!;
    advanceDiplomacyRound(state);
    treaty.coopBonusUsed = { blue: 90, red: 0 };
    treaty.coopTurnsLeft = { blue: 2, red: 4 };
    expect(grantCoopBonus(state, 'blue', rules)).toEqual({ bonus: 10 });
    expect(treaty.coopBonusUsed.blue).toBe(100);
    expect(grantCoopBonus(state, 'blue', rules)).toEqual({ bonus: 0 });
    expect(treaty.coopTurnsLeft.blue).toBe(0);
    treaty.coopTurnsLeft = { blue: 0, red: 1 };
    expect(grantCoopBonus(state, 'red', rules)).toEqual({ bonus: 25 });
    expect(treaty.coopTurnsLeft).toEqual({ blue: 0, red: 0 });
    expect(treaty.active).toBe(false);
    expect(state.journal.some(entry => entry.kind === 'coop-ended')).toBe(true);
    expect(grantCoopBonus(state, 'red', rules)).toEqual({ bonus: 0 });
  });

  it('culture transfer is limited by headroom and culture points', () => {
    expect(computeCultureTransfer(0, 3, rules)).toEqual({ influenceDelta: 3, cultureSpend: 3 });
    expect(computeCultureTransfer(0, 10, rules)).toEqual({ influenceDelta: rules.culture.transferPerOwnTurn, cultureSpend: rules.culture.transferPerOwnTurn });
    expect(computeCultureTransfer(rules.culture.influenceCap - 2, 10, rules)).toEqual({ influenceDelta: 2, cultureSpend: 2 });
    expect(computeCultureTransfer(rules.culture.influenceCap, 10, rules)).toEqual({ influenceDelta: 0, cultureSpend: 0 });
    expect(computeCultureTransfer(0, 0, rules)).toEqual({ influenceDelta: 0, cultureSpend: 0 });
  });

  it('coop bonus is denied in war even with an active treaty', () => {
    const state = contactedState();
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    ok(acceptDiplomacyProposal({ state, actor: 'red', proposalId: proposed.proposal.id, authorTreasury: richTreasury, rules }));
    advanceDiplomacyRound(state);
    ok(declareDiplomacyWar(state, 'red', rules));
    expect(state.war).toBe(true);
    expect(grantCoopBonus(state, 'blue', rules)).toEqual({ bonus: 0 });
    expect(grantCoopBonus(state, 'red', rules)).toEqual({ bonus: 0 });
  });
});

describe('campaignDiplomacy scoring and own view', () => {
  it('agreement score combines reputation, trust, culture and payload benefit', () => {
    const s = rules.score;
    const base = { trust: 0, influence: 0, vetoActive: false, threat: 0, rules };
    const repTerm = Math.min(s.reputationCap, Math.floor((100 - s.reputationOffset) / s.reputationDivisor));
    const coopScore = evaluateAgreementScore({ ...base, reputation: 100, kind: 'coop', payload: null });
    expect(coopScore).toBe(s.coopBase + repTerm + s.coopBase);
    const armisticeScore = evaluateAgreementScore({ ...base, reputation: 100, kind: 'armistice', payload: null, threat: 3 });
    expect(armisticeScore).toBe(s.armisticeBase + repTerm - Math.min(s.threatCap, 3));
    const exchangeScore = evaluateAgreementScore({ ...base, reputation: 100, trust: 8, kind: 'exchange', payload: { credits: 200, minerals: 50 } });
    const benefit = Math.min(s.exchangeBenefitCap, Math.floor(200 / s.exchangeCreditsDivisor) + Math.floor(50 / s.exchangeMineralsDivisor));
    expect(exchangeScore).toBe(repTerm + Math.min(s.trustCap, Math.floor(8 / s.trustDivisor)) + benefit);
  });

  it('shouldAccept enforces veto and kind thresholds', () => {
    const base = { reputation: 100, trust: 0, influence: 0, vetoActive: false, payload: null, threat: 0, rules };
    expect(shouldAcceptDiplomacyProposal({ ...base, kind: 'coop' })).toMatchObject({ acceptable: true });
    expect(shouldAcceptDiplomacyProposal({ ...base, kind: 'armistice' })).toMatchObject({ acceptable: true });
    expect(shouldAcceptDiplomacyProposal({ ...base, kind: 'coop', vetoActive: true })).toMatchObject({ acceptable: false });
    const lowReputation = shouldAcceptDiplomacyProposal({ ...base, reputation: 0, kind: 'coop' });
    const repTerm = Math.max(-rules.score.reputationCap, Math.floor((0 - rules.score.reputationOffset) / rules.score.reputationDivisor));
    expect(lowReputation.acceptable).toBe(repTerm + rules.score.coopBase >= rules.score.acceptThreshold);
  });

  it('own view exposes counters, treaties and pending proposals per side', () => {
    const state = contactedState();
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'coop', payload: null, authorTreasury: richTreasury, rules }));
    const blueView = getDiplomacyOwnView(state, 'blue', rules);
    expect(blueView).toMatchObject({ round: 0, war: false, trust: 0, ownReputation: 100, otherReputation: 100, contacted: true });
    expect(blueView.ownPending?.id).toBe(proposed.proposal.id);
    expect(blueView.incomingPending).toBeNull();
    expect(blueView.rules).toBe(rules);
    const redView = getDiplomacyOwnView(state, 'red', rules);
    expect(redView.incomingPending?.id).toBe(proposed.proposal.id);
    expect(redView.recentIncoming).toHaveLength(1);
    ok(declineDiplomacyProposal(state, 'red', proposed.proposal.id));
    const declinedView = getDiplomacyOwnView(state, 'red', rules);
    expect(declinedView.incomingPending).toBeNull();
  });

  it('own view reports active treaties and veto state', () => {
    const state = contactedState(true);
    const proposed = ok(proposeDiplomacy({ state, author: 'blue', kind: 'armistice', payload: null, authorTreasury: richTreasury, rules }));
    ok(acceptDiplomacyProposal({ state, actor: 'red', proposalId: proposed.proposal.id, authorTreasury: richTreasury, rules }));
    const view = getDiplomacyOwnView(state, 'red', rules);
    expect(view.armisticeExpiryRound).toBe(rules.armisticeRounds);
    expect(view.treaties).toHaveLength(1);
    expect(view.otherVetoActive).toBe(true);
    expect(view.journal.some(entry => entry.kind === 'accepted')).toBe(true);
  });
});

describe('conquest integration', () => {
  function endTurn(state: Conquest): Conquest {
    const faction = activeOf(state);
    const result = executeConquestCommand(state, { kind: 'endTurn', factionId: faction, expectedTurn: state.session.schedule.turn });
    if (!result.ok) throw new Error(result.message);
    return result.state;
  }

  type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
  type CommandFields = DistributiveOmit<ConquestCommand, 'factionId' | 'expectedTurn'>;

  function runCommand(state: Conquest, command: CommandFields): Conquest {
    const full = { ...command, factionId: activeOf(state), expectedTurn: state.session.schedule.turn } as ConquestCommand;
    const result = executeConquestCommand(state, full);
    if (!result.ok) throw new Error(result.message);
    return result.state;
  }

  it('first contact is recorded via visual reveal on endTurn', () => {
    const state = createConquest();
    state.session.ships[1].systemId = state.session.ships[0].systemId;
    expect(state.diplomacy.contact.blue).toBeNull();
    const after = endTurn(state);
    expect(after.diplomacy.contact.blue).not.toBeNull();
    expect(after.diplomacy.contact.red).not.toBeNull();
    expect(after.diplomacy.journal.filter(entry => entry.kind === 'contact')).toHaveLength(2);
  });

  it('coop treaty grants the research bonus after the accepted round via endTurn', () => {
    const state0 = createConquest();
    recordDiplomacyContact(state0.diplomacy, 'blue');
    recordDiplomacyContact(state0.diplomacy, 'red');
    let state = endTurn(state0);
    state = endTurn(state);
    state = runCommand(state, { kind: 'proposeDiplomacy', offerKind: 'coop', payload: null });
    const proposalId = state.diplomacy.proposals[state.diplomacy.proposals.length - 1].id;
    state = endTurn(state);
    state = runCommand(state, { kind: 'acceptDiplomacy', proposalId });
    expect(state.diplomacy.war).toBe(false);
    expect(state.diplomacy.treaties).toHaveLength(1);
    expect(state.diplomacy.treaties[0].coopBonusUsed).toEqual({ blue: 0, red: 0 });
    state = endTurn(state);
    expect(state.diplomacy.treaties[0].coopBonusUsed).toEqual({ blue: 0, red: 0 });
    state = endTurn(state);
    expect(state.diplomacy.treaties[0].coopBonusUsed).toEqual({ blue: rules.coop.bonusPerOwnTurn, red: 0 });
    expect(state.diplomacy.treaties[0].coopTurnsLeft).toEqual({ blue: rules.coop.ownTurnsLimit - 1, red: rules.coop.ownTurnsLimit });
    state = endTurn(state);
    expect(state.diplomacy.treaties[0].coopBonusUsed).toEqual({ blue: rules.coop.bonusPerOwnTurn, red: rules.coop.bonusPerOwnTurn });
    expect(state.diplomacy.treaties[0].coopTurnsLeft).toEqual({ blue: rules.coop.ownTurnsLimit - 1, red: rules.coop.ownTurnsLimit - 1 });
  });

  it('active armistice blocks battles and its expiry resumes the war', () => {
    const state0 = createConquest();
    state0.session.ships[1].systemId = state0.session.ships[0].systemId;
    recordDiplomacyContact(state0.diplomacy, 'blue');
    recordDiplomacyContact(state0.diplomacy, 'red');
    let state = endTurn(state0);
    state = endTurn(state);
    state = runCommand(state, { kind: 'declareWar' });
    expect(state.diplomacy.war).toBe(true);
    state = endTurn(state);
    const battlesInWar = state.battles.length;
    expect(battlesInWar).toBeGreaterThan(0);
    state = runCommand(state, { kind: 'proposeDiplomacy', offerKind: 'armistice', payload: null });
    const proposalId = state.diplomacy.proposals[state.diplomacy.proposals.length - 1].id;
    state = endTurn(state);
    state = runCommand(state, { kind: 'acceptDiplomacy', proposalId });
    expect(state.diplomacy.war).toBe(false);
    expect(hasActiveArmistice(state.diplomacy)).toBe(true);
    const battlesBefore = state.battles.length;
    for (let turn = 0; turn < 8; turn += 1) state = endTurn(state);
    expect(state.battles.length).toBe(battlesBefore);
    expect(state.diplomacy.war).toBe(true);
    state = endTurn(state);
    expect(state.battles.length).toBeGreaterThan(battlesBefore);
  });

  it('diplomacy state survives the save round-trip deterministically', () => {
    const state0 = createConquest();
    recordDiplomacyContact(state0.diplomacy, 'blue');
    recordDiplomacyContact(state0.diplomacy, 'red');
    let state = endTurn(state0);
    state = runCommand(state, { kind: 'declareWar' });
    state = runCommand(state, { kind: 'proposeDiplomacy', offerKind: 'armistice', payload: null });
    const proposalId = state.diplomacy.proposals[state.diplomacy.proposals.length - 1].id;
    state = endTurn(state);
    state = runCommand(state, { kind: 'acceptDiplomacy', proposalId });
    const before = encodeConquestSave(state);
    const restored = decodeConquestSave(before);
    expect(restored.diplomacy).toEqual(state.diplomacy);
    expect(encodeConquestSave(decodeConquestSave(before))).toBe(before);
  });
});
