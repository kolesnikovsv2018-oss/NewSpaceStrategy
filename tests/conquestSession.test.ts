import { expect, it } from 'vitest';
import { createCampaignSession, campaignSessionSchema, conquestSessionSchema, executeSessionCommand,
  executeConquestSessionCommand, getConquestSessionView } from '../src/domain/campaignSession';
import { createDesign } from '../src/domain/shipDesign';

it('separates military presence from peaceful ownership while retaining identity and fuel', () => {
  const state = createCampaignSession();
  state.production.lastOrderId = 1;
  state.ships.push({ id: 1, factionId: 'blue', systemId: 'sol', fuel: 3, design: createDesign('fighter', true) });
  const command = { kind: 'sendShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1, destinationId: 'eden' };
  expect(executeSessionCommand(state, command).ok).toBe(false);
  const sent = executeConquestSessionCommand(state, command);
  expect(sent.ok).toBe(true);
  if (!sent.ok) throw new Error(sent.message);
  expect(campaignSessionSchema.safeParse(sent.state).success).toBe(false);
  expect(conquestSessionSchema.safeParse(sent.state).success).toBe(true);
  const arrived = executeConquestSessionCommand(sent.state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
  if (!arrived.ok) throw new Error(arrived.message);
  expect(arrived.state.ships[0]).toMatchObject({ id: 1, systemId: 'eden', fuel: 2 });
  expect(arrived.state.ships[0].transit).toBeUndefined();
  expect(state.ships[0].fuel).toBe(3);
  expect(getConquestSessionView(arrived.state, 'red').ships).toEqual([]);
  expect(executeConquestSessionCommand(arrived.state, { kind: 'refuelShip', factionId: 'blue', expectedTurn: 2,
    systemId: 'eden', shipId: 1 }).ok).toBe(false);
});

it('does not weaken production ownership or group membership', () => {
  const state = createCampaignSession();
  state.production.lastOrderId = 1;
  state.production.completed.push({ id: 1, factionId: 'blue', systemId: 'vega', design: createDesign('fighter', true) });
  expect(conquestSessionSchema.safeParse(state).success).toBe(false);
  state.production.completed = [];
  state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'vega', shipIds: [1, 2] }] };
  expect(conquestSessionSchema.safeParse(state).success).toBe(false);
});