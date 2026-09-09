import { expect } from 'vitest';
import { type CampaignFactionId, type SystemId } from '../../src/domain/campaign';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  type CampaignSession, type SessionCommand } from '../../src/domain/campaignSession';
import { createCombatDesign } from '../../src/domain/combatPresets';
import { executeAiTurn, type AiTurnErrorCode, type AiTurnResult } from '../../src/domain/campaignAiExecutor';
import { type AiObservation, type AiTurnRequest } from '../../src/domain/campaignAiPlanner';

export const sides = ['blue', 'red'] as const;
export const requestFor = (state: CampaignSession): AiTurnRequest => ({ factionId: state.turn % 2 ? 'blue' : 'red', expectedTurn: state.turn });
export function freeze(value: unknown): void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
export function frozen(value: unknown): void {
  if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen); }
}
export function failure(result: AiTurnResult, code: AiTurnErrorCode): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error('Expected failure');
  expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
  expect(result.message).toMatch(/[А-Яа-яЁё]/);
  expect(result.message.length).toBeLessThan(200);
  expect(result.message).not.toMatch(/PRIVATE|Error:|issues|exploredBy|treasuries/);
}
export function ai(state: CampaignSession) {
  const before = structuredClone(state), request = requestFor(state);
  freeze(state); freeze(request);
  const result = executeAiTurn(state, request);
  expect(state).toEqual(before);
  if (!result.ok) throw new Error(result.code);
  expect(result.state.turn).toBe(state.turn + 1);
  expect(result.summary.turn).toBe(state.turn);
  expect(result.summary.factionId).toBe(request.factionId);
  expect(result.summary.commands.length).toBeGreaterThanOrEqual(1);
  expect(result.summary.commands.length).toBeLessThanOrEqual(3);
  expect(result.summary.commands[result.summary.commands.length - 1]?.kind).toBe('endTurn');
  return result;
}
export function command(state: CampaignSession, input: SessionCommand): CampaignSession {
  const before = structuredClone(state), result = executeSessionCommand(state, input);
  expect(state).toEqual(before);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}
export function observe(state: CampaignSession, faction = requestFor(state).factionId): AiObservation {
  const view = getCampaignSessionView(state, faction);
  const result = { galaxy: view.galaxy, turn: view.turn, activeFactionId: view.activeFactionId, economyForecast: view.economyForecast };
  freeze(result);
  return result;
}
export function known(state: CampaignSession, id: SystemId, faction: CampaignFactionId, owner?: CampaignFactionId | null): void {
  const system = state.galaxy.systems.find(item => item.id === id)!;
  if (!system.exploredBy.includes(faction)) system.exploredBy.push(faction);
  if (owner !== undefined) system.ownerId = owner;
}
export function threeCommands(): CampaignSession {
  const state = createCampaignSession(); known(state, 'eden', 'blue'); return state;
}

/** Diagnostic, NOT paid gameplay: both sides, two colonies, FIFO at both colonies,
 * completed snapshots, stationary/free/group ships; no available colonization.
 */
export function rich(turn = 1, shipCount = 100): CampaignSession {
  const state = createCampaignSession(), design = createCombatDesign('fighter');
  state.turn = turn;
  for (const [index, factionId] of sides.entries()) {
    const home = factionId === 'blue' ? 'sol' : 'vega', target = factionId === 'blue' ? 'eden' : 'nexus';
    known(state, target, factionId, factionId);
    for (let offset = 0; offset < shipCount; offset++) {
      state.ships.push({ id: 1 + index * 100 + offset, factionId, systemId: home, fuel: offset < 3 ? 0 : 3,
        design: structuredClone(design), ...(offset < 3 ? { transit: { destinationId: target, remainingTurns: 1 as const } } : {}) });
    }
    state.fleets.items.push({ id: index + 1, factionId, systemId: home, shipIds: [2 + index * 100, 1 + index * 100] });
    for (const [colony, systemId] of ([home, target] as const).entries()) {
      for (let offset = 0; offset < 2; offset++) state.production.orders.push({
        id: 201 + index * 10 + colony * 2 + offset, factionId, systemId, design: structuredClone(design), remainingTurns: offset ? 4 : 1
      });
    }
    state.production.completed.unshift({ id: 230 + index, factionId, systemId: home, design: structuredClone(design) });
  }
  state.production.lastOrderId = 240; state.fleets.lastFleetId = 2;
  expect(campaignSessionSchema.safeParse(state).success).toBe(true);
  return state;
}