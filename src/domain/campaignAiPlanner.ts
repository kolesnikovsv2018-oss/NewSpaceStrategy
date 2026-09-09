import type { SystemId } from './campaign';
import type { CampaignSessionView, SessionCommand } from './campaignSession';

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type AiTurnRequest = Pick<SessionCommand, 'factionId' | 'expectedTurn'>;
export type AiObservation = DeepReadonly<Pick<CampaignSessionView,
  'galaxy' | 'turn' | 'activeFactionId' | 'economyForecast'>>;
export type AiCommand = Extract<SessionCommand, { kind: 'colonize' | 'explore' | 'endTurn' }>;
export interface AiPlan { commands: readonly AiCommand[] }
export type AiPlanResult = { ok: true; plan: AiPlan } |
  { ok: false; code: 'STALE_TURN' | 'NOT_ACTIVE_FACTION' | 'TURN_LIMIT' | 'RESOURCE_LIMIT' };

/** Typed internal query, not an unknown/JSON boundary or command authorization.
 * All candidates come from this original observation, never from speculative commands.
 * Runtime dependencies deliberately absent: no full model, factories, clocks or IO.
 */
export function planAiTurn(view: AiObservation, context: Readonly<AiTurnRequest>): AiPlanResult {
  if (context.expectedTurn !== view.turn) return { ok: false, code: 'STALE_TURN' };
  if (context.factionId !== view.galaxy.factionId || context.factionId !== view.activeFactionId) {
    return { ok: false, code: 'NOT_ACTIVE_FACTION' };
  }
  if (!view.economyForecast.ok) return { ok: false, code: view.economyForecast.code };
  const explored = new Set(view.galaxy.systems.filter(system => system.visibility === 'explored').map(system => system.id));
  const owned = new Set(view.galaxy.systems.filter(system =>
    system.visibility === 'explored' && system.ownerId === context.factionId).map(system => system.id));
  const adjacent = (id: SystemId, ids: ReadonlySet<SystemId>): boolean => view.galaxy.lanes.some(([a, b]) =>
    (a === id && ids.has(b)) || (b === id && ids.has(a)));
  // Sort a new array by key, not by locale, labels, coordinates or definition order.
  const systems = [...view.galaxy.systems].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const colony = systems.find(system => system.visibility === 'explored' && system.ownerId === null &&
    system.habitable === true && adjacent(system.id, owned));
  const frontier = systems.find(system => system.visibility === 'unknown' && adjacent(system.id, explored));
  const { factionId, expectedTurn } = context;
  const commands: AiCommand[] = [];
  if (colony) commands.push({ kind: 'colonize', factionId, expectedTurn, systemId: colony.id });
  if (frontier) commands.push({ kind: 'explore', factionId, expectedTurn, systemId: frontier.id });
  commands.push({ kind: 'endTurn', factionId, expectedTurn });
  return { ok: true, plan: { commands } };
}