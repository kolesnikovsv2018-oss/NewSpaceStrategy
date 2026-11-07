import { expect, it } from 'vitest';
import { createCampaignSession, campaignSessionSchema, conquestSessionSchema, executeSessionCommand,
  executeConquestSessionCommand, getConquestSessionView, createConquestSession } from '../src/domain/campaignSession';
import { createDesign } from '../src/domain/shipDesign';

it('separates military presence from peaceful ownership while retaining identity and fuel', () => {
  const state = createConquestSession();
  state.production.lastOrderId = 1;
  state.ships.push({ id: 1, factionId: 'player-01', systemId: 'sol', fuel: 3000, design: createDesign('fighter', true) });
  const command = { kind: 'sendShip', factionId: 'player-01', expectedTurn: 1, systemId: 'sol', shipId: 1, destinationId: 'eden' };
  expect(executeSessionCommand(createCampaignSession(), command).ok).toBe(false);
  const sent = executeConquestSessionCommand(state, command, undefined, 'project-travel-v1');
  expect(sent.ok).toBe(true);
  if (!sent.ok) throw new Error(sent.message);
  expect(campaignSessionSchema.safeParse(sent.state).success).toBe(false);
  expect(conquestSessionSchema.safeParse(sent.state).success).toBe(true);
  const arrived = executeConquestSessionCommand(sent.state, { kind: 'endTurn', factionId: 'player-01', expectedTurn: 1 });
  if (!arrived.ok) throw new Error(arrived.message);
  expect(arrived.state.ships[0]).toMatchObject({ id: 1, systemId: 'eden', fuel: 2992 });
  expect(arrived.state.ships[0].transit).toBeUndefined();
  expect(state.ships[0].fuel).toBe(3000);
  expect(getConquestSessionView(arrived.state, 'player-02').ships).toEqual([]);
  expect(executeConquestSessionCommand(arrived.state, { kind: 'refuelShip', factionId: 'player-01', expectedTurn: 2,
    systemId: 'eden', shipId: 1 }).ok).toBe(false);
});

it('does not weaken production ownership or group membership', () => {
  const state = createConquestSession();
  state.production.lastOrderId = 1;
  state.production.completed.push({ id: 1, factionId: 'player-01', systemId: 'vega', design: createDesign('fighter', true) });
  expect(conquestSessionSchema.safeParse(state).success).toBe(false);
  state.production.completed = [];
  state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: 'player-01', systemId: 'vega', shipIds: [1, 2] }] };
  expect(conquestSessionSchema.safeParse(state).success).toBe(false);
});

it('cannot bypass military survey/adaptation through the old map-only colonization command', () => {
  const state = createConquestSession();
  state.galaxy.systems.find(system => system.id === 'eden')!.exploredBy = ['player-01'];
  const payload = { kind: 'colonize', factionId: 'player-01', expectedTurn: 1, systemId: 'eden' };
  expect(executeConquestSessionCommand(state, payload)).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  const peace = createCampaignSession();
  peace.galaxy.systems.find(system => system.id === 'eden')!.exploredBy = ['blue'];
  expect(executeSessionCommand(peace, { ...payload, factionId: 'blue' }).ok).toBe(true);
});
