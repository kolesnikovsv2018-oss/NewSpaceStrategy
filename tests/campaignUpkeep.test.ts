import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { type CampaignFactionId } from '../src/domain/campaign';
import { createCombatDesign } from '../src/domain/combatPresets';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { MAX_FLEET_ID } from '../src/domain/campaignFleets';
import { type CampaignShip } from '../src/domain/campaignShips';
import { campaignSessionSchema, createCampaignSession, executeSessionCommand, getCampaignSessionView,
  MAX_RESOURCE, MAX_TURN, sessionCommandSchema, type CampaignSession, type EndTurnEconomy,
  type SessionCommand, type SessionErrorCode } from '../src/domain/campaignSession';
import { calculateEndTurnEconomy, getUpkeepQuote, UPKEEP_CREDITS_PER_SHIP } from '../src/domain/campaignUpkeep';
import { getProductionQuote, getProductionRefund, MAX_ORDER_ID } from '../src/domain/production';

const sides = ['blue', 'red'] as const;
const home = { blue: 'sol', red: 'vega' } as const;
const destination = { blue: 'eden', red: 'nexus' } as const;
const endBlue = { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 } as const;

function freeze(value: object): void {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); });
  Object.freeze(value);
}

/** Diagnostic valid state, not a claim that a fleet was acquired through gameplay. */
function fixture(blueCount = 2, redCount = 2): CampaignSession {
  const state = createCampaignSession();
  for (const faction of sides) {
    const colony = state.galaxy.systems.find(system => system.id === destination[faction])!;
    colony.ownerId = faction; colony.exploredBy = [faction];
  }
  const designs = [createCombatDesign('fighter'), createCombatDesign('dreadnought'), createCivilianDesign('freighter')];
  state.ships = Array.from({ length: blueCount + redCount }, (_, index): CampaignShip => {
    const factionId = index < blueCount ? 'blue' : 'red';
    return { id: index + 1, factionId, systemId: home[factionId], fuel: index % 4,
      design: structuredClone(designs[index % designs.length]) };
  });
  state.production.lastOrderId = state.ships.length;
  return state;
}

function succeed(state: CampaignSession, command: SessionCommand) {
  const before = structuredClone(state), payload = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(state).toEqual(before); expect(command).toEqual(payload);
  if (!result.ok) throw Error(result.code);
  expect(result.state).not.toBe(state);
  expect(campaignSessionSchema.parse(result.state)).toEqual(result.state);
  if (command.kind === 'endTurn') {
    expect(result.endTurnEconomy).toBeDefined();
  } else {
    expect(result.endTurnEconomy).toBeUndefined();
    expect(result).not.toHaveProperty('endTurnEconomy');
  }
  return result;
}

function end(state: CampaignSession) {
  const factionId = state.turn % 2 ? 'blue' : 'red';
  const result = succeed(state, { kind: 'endTurn', factionId, expectedTurn: state.turn });
  if (!result.endTurnEconomy) throw Error('Missing endTurn receipt');
  const receipt: EndTurnEconomy = result.endTurnEconomy;
  return { state: result.state, receipt };
}

function reject(state: unknown, command: unknown, code: SessionErrorCode): void {
  const before = structuredClone(state), payload = structuredClone(command);
  const result = executeSessionCommand(state, command);
  expect(result).toMatchObject({ ok: false, code });
  expect(result).not.toHaveProperty('state'); expect(result).not.toHaveProperty('endTurnEconomy');
  expect(state).toEqual(before); expect(command).toEqual(payload);
}

function forecast(state: CampaignSession, faction: CampaignFactionId) {
  const value = getCampaignSessionView(state, faction).economyForecast;
  if (!value.ok) throw Error(value.code);
  return value;
}

function movingDeficit(): CampaignSession {
  let state = fixture(21, 3);
  state.treasuries.blue = { credits: 0, minerals: 5 };
  state.ships.slice(0, 3).forEach(ship => { ship.fuel = 1; });
  state = succeed(state, { kind: 'createFleet', factionId: 'blue', expectedTurn: 1,
    systemId: 'sol', shipIds: [2, 1] }).state;
  state = succeed(state, { kind: 'sendFleet', factionId: 'blue', expectedTurn: 1,
    systemId: 'sol', fleetId: 1, destinationId: 'eden' }).state;
  state = succeed(state, { kind: 'sendShip', factionId: 'blue', expectedTurn: 1,
    systemId: 'sol', shipId: 3, destinationId: 'eden' }).state;
  // Valid pending enemy travel, to detect accidental advancement of the other side.
  state.ships.slice(21).forEach(ship => { ship.transit = { destinationId: 'nexus', remainingTurns: 1 }; });
  state.fleets = { lastFleetId: 2, items: [...state.fleets.items,
    { id: 2, factionId: 'red', systemId: 'vega', shipIds: [24, 22] }] };
  const design = createCombatDesign('fighter');
  state.production = { lastOrderId: 28, orders: [
    { id: 25, factionId: 'blue', systemId: 'sol', design: structuredClone(design), remainingTurns: 1 },
    { id: 26, factionId: 'blue', systemId: 'sol', design: structuredClone(design), remainingTurns: getProductionQuote(design).turns },
    { id: 27, factionId: 'red', systemId: 'vega', design: structuredClone(design), remainingTurns: 1 }
  ], completed: [{ id: 28, factionId: 'blue', systemId: 'eden', design: structuredClone(design) }] };
  expect(campaignSessionSchema.safeParse(state).success).toBe(true);
  return state;
}

describe('upkeep quote boundary', () => {
  it('fixes the strategic tariff at one credit, without a mineral tariff', () => {
    expect(UPKEEP_CREDITS_PER_SHIP).toBe(1);
    expect(getUpkeepQuote([], 'blue')).toEqual({ shipCount: 0, credits: 0 });
  });
  it.each(sides)('counts 0/1/2/100 own ships for %s independently of enemy ships and mixed designs', faction => {
    for (const count of [0, 1, 2, 100]) {
      const state = faction === 'blue' ? fixture(count, 100) : fixture(100, count);
      const before = structuredClone(state.ships); freeze(state.ships);
      expect(getUpkeepQuote(state.ships, faction)).toEqual({ shipCount: count, credits: count });
      expect(state.ships).toEqual(before);
    }
  });
  it('counts stationary, grouped, free, transit and empty tanks once regardless of order', () => {
    const state = movingDeficit(), before = structuredClone(state);
    freeze(state);
    expect(getUpkeepQuote(state.ships, 'blue')).toEqual({ shipCount: 21, credits: 21 });
    expect(getUpkeepQuote([...state.ships].reverse(), 'blue')).toEqual({ shipCount: 21, credits: 21 });
    expect(getUpkeepQuote(state.ships, 'red')).toEqual({ shipCount: 3, credits: 3 });
    expect(state).toEqual(before);
    const quote = getUpkeepQuote(state.ships, 'blue'); quote.credits = 999; quote.shipCount = 0;
    expect(getUpkeepQuote(state.ships, 'blue')).toEqual({ shipCount: 21, credits: 21 });
  });
  it.each([undefined, null, {}, true, 'ships', [null], [{ id: 1 }]])('rejects malformed ship list %# with ZodError', ships => {
    expect(() => getUpkeepQuote(ships, 'blue')).toThrow(ZodError);
  });
  it.each([undefined, null, '', 'neutral', 'BLUE', 0, {}, true])('rejects invalid faction %# even for an empty list', faction => {
    expect(() => getUpkeepQuote([], faction)).toThrow(ZodError);
  });
  it.each(['duplicate', 'over-limit', 'missing-fuel', 'invalid-design', 'extra-field'] as const)('rejects %s rather than counting a partially valid list', kind => {
    const ships = fixture(2, 1).ships;
    if (kind === 'duplicate') ships.push(structuredClone(ships[0]));
    if (kind === 'over-limit') ships.splice(0, ships.length, ...fixture(101, 0).ships);
    if (kind === 'missing-fuel') delete (ships[2] as Partial<CampaignShip>).fuel;
    if (kind === 'invalid-design') ships[2].design.slots.forEach(slot => { slot.component = null; });
    if (kind === 'extra-field') Object.assign(ships[2], { upkeep: 0 });
    const before = structuredClone(ships); freeze(ships);
    expect(() => getUpkeepQuote(ships, 'blue')).toThrow(ZodError);
    expect(ships).toEqual(before);
  });
});

describe('checked end-turn economy calculation', () => {
  it.each([
    { credits: 100, count: 0, paid: 0, shortfall: 0, after: 120 },
    { credits: 0, count: 2, paid: 2, shortfall: 0, after: 18 },
    { credits: 0, count: 20, paid: 20, shortfall: 0, after: 0 },
    { credits: 0, count: 21, paid: 20, shortfall: 1, after: 0 },
    { credits: 5, count: 100, paid: 25, shortfall: 75, after: 0 }
  ])('calculates the contract table: T=$credits, N=$count', ({ credits, count, paid, shortfall, after }) => {
    const treasury = { credits, minerals: 5 }, income = { credits: 20, minerals: 10 };
    const quote = { shipCount: count, credits: count }; freeze(treasury); freeze(income); freeze(quote);
    expect(calculateEndTurnEconomy(treasury, income, quote)).toEqual({ ok: true, income,
      upkeep: { shipCount: count, dueCredits: count, paidCredits: paid, shortfallCredits: shortfall },
      treasuryAfter: { credits: after, minerals: 15 } });
    expect(treasury).toEqual({ credits, minerals: 5 }); expect(quote).toEqual({ shipCount: count, credits: count });
  });
  it('succeeds with zero available credits and zero income, without inventing debt or minerals', () => {
    expect(calculateEndTurnEconomy({ credits: 0, minerals: 0 }, { credits: 0, minerals: 0 }, { shipCount: 100, credits: 100 }))
      .toEqual({ ok: true, income: { credits: 0, minerals: 0 },
        upkeep: { shipCount: 100, dueCredits: 100, paidCredits: 0, shortfallCredits: 100 },
        treasuryAfter: { credits: 0, minerals: 0 } });
  });
  it('accepts exact gross caps before subtracting two credits', () => {
    expect(calculateEndTurnEconomy({ credits: MAX_RESOURCE - 20, minerals: MAX_RESOURCE - 10 },
      { credits: 20, minerals: 10 }, { shipCount: 2, credits: 2 })).toEqual({ ok: true,
      income: { credits: 20, minerals: 10 }, upkeep: { shipCount: 2, dueCredits: 2, paidCredits: 2, shortfallCredits: 0 },
      treasuryAfter: { credits: MAX_RESOURCE - 2, minerals: MAX_RESOURCE } });
  });
  it.each(['credits', 'minerals'] as const)('rejects gross %s overflow even if debit could fit the final credits', resource => {
    const treasury = { credits: MAX_RESOURCE - 20, minerals: MAX_RESOURCE - 10 };
    treasury[resource]++; const before = structuredClone(treasury); freeze(treasury);
    expect(calculateEndTurnEconomy(treasury, { credits: 20, minerals: 10 }, { shipCount: 2, credits: 2 }))
      .toEqual({ ok: false, code: 'RESOURCE_LIMIT' });
    expect(treasury).toEqual(before);
  });
  it('returns independently mutable income, payment and treasury snapshots on each calculation', () => {
    const treasury = { credits: 100, minerals: 5 }, income = { credits: 20, minerals: 10 }, quote = { shipCount: 2, credits: 2 };
    const run = () => calculateEndTurnEconomy(treasury, income, quote);
    const first = run(), second = run();
    if (!first.ok || !second.ok) throw Error('Expected successful calculations');
    expect(first).toEqual(second);
    expect(first.income).not.toBe(income); expect(first.treasuryAfter).not.toBe(treasury);
    expect(first.income).not.toBe(first.treasuryAfter); expect(first.upkeep).not.toBe(quote);
    first.income.credits = 999; first.upkeep.paidCredits = 999; first.treasuryAfter.minerals = 999;
    expect(second).toEqual(run()); expect(income).toEqual({ credits: 20, minerals: 10 });
    expect(treasury).toEqual({ credits: 100, minerals: 5 }); expect(quote).toEqual({ shipCount: 2, credits: 2 });
    income.credits = 0; treasury.credits = 0; quote.credits = 0;
    expect(second.income.credits).toBe(20); expect(second.treasuryAfter.credits).toBe(118); expect(second.upkeep.dueCredits).toBe(2);
  });
});

describe('session upkeep receipts and atomic advancement', () => {
  it.each(sides)('charges only %s on its successful own endTurn and reports the completed turn', faction => {
    const state = fixture(2, 3); state.turn = faction === 'blue' ? 1 : 2;
    const enemy = faction === 'blue' ? 'red' : 'blue', count = faction === 'blue' ? 2 : 3;
    freeze(state);
    const { state: next, receipt } = end(state);
    expect(receipt).toEqual({ factionId: faction, turn: state.turn, income: { credits: 20, minerals: 10 },
      upkeep: { shipCount: count, dueCredits: count, paidCredits: count, shortfallCredits: 0 },
      treasuryAfter: { credits: 120 - count, minerals: 60 } });
    expect(next.treasuries[faction]).toEqual(receipt.treasuryAfter);
    expect(next.treasuries[enemy]).toEqual(state.treasuries[enemy]);
    expect(next.ships).toEqual(state.ships); expect(next.turn).toBe(state.turn + 1);
  });
  it('preserves the previous economy with zero deployed ships, including zero-colony income', () => {
    const state = createCampaignSession(), first = end(state);
    expect(first.receipt.upkeep).toEqual({ shipCount: 0, dueCredits: 0, paidCredits: 0, shortfallCredits: 0 });
    expect(first.state.treasuries.blue).toEqual({ credits: 110, minerals: 55 });
    state.galaxy.systems.find(system => system.id === 'sol')!.ownerId = null;
    expect(end(state).receipt).toEqual({ factionId: 'blue', turn: 1, income: { credits: 0, minerals: 0 },
      upkeep: { shipCount: 0, dueCredits: 0, paidCredits: 0, shortfallCredits: 0 }, treasuryAfter: { credits: 100, minerals: 50 } });
  });
  it.each(sides)('charges a just-deployed %s ship immediately but not orders or completed records', faction => {
    let state = fixture(0, 0); state.turn = faction === 'blue' ? 1 : 2;
    const design = createCombatDesign('fighter');
    state.production = { lastOrderId: 3, orders: [
      { id: 1, factionId: faction, systemId: home[faction], design, remainingTurns: 1 },
      { id: 2, factionId: faction, systemId: home[faction], design: structuredClone(design), remainingTurns: getProductionQuote(design).turns }
    ], completed: [{ id: 3, factionId: faction, systemId: home[faction], design: structuredClone(design) }] };
    expect(forecast(state, faction).upkeep.shipCount).toBe(0);
    expect(end(state).receipt.upkeep.dueCredits).toBe(0);
    const before = structuredClone(state);
    state = succeed(state, { kind: 'deployProduction', factionId: faction, expectedTurn: state.turn,
      systemId: home[faction], orderId: 3 }).state;
    expect(state.treasuries).toEqual(before.treasuries); expect(state.turn).toBe(before.turn);
    const first = end(state);
    expect(first.receipt.upkeep).toEqual({ shipCount: 1, dueCredits: 1, paidCredits: 1, shortfallCredits: 0 });
    expect(first.state.production.completed.map(record => record.id)).toEqual([1]);
    expect(first.state.production.orders).toEqual([before.production.orders[1]]);
    expect(first.state.ships.map(ship => ship.id)).toEqual([3]);
    state = end(first.state).state;
    state = succeed(state, { kind: 'deployProduction', factionId: faction, expectedTurn: state.turn,
      systemId: home[faction], orderId: 1 }).state;
    expect(end(state).receipt.upkeep.dueCredits).toBe(2);
  });
  it('continues FIFO, grouped and free arrivals under deficit while leaving all enemy data unchanged', () => {
    const state = movingDeficit(); freeze(state);
    const { state: next, receipt } = end(state);
    expect(receipt).toEqual({ factionId: 'blue', turn: 1, income: { credits: 20, minerals: 10 },
      upkeep: { shipCount: 21, dueCredits: 21, paidCredits: 20, shortfallCredits: 1 }, treasuryAfter: { credits: 0, minerals: 15 } });
    expect(next.turn).toBe(2); expect(next.ships).toHaveLength(24);
    expect(next.ships.slice(0, 3)).toEqual(state.ships.slice(0, 3).map(({ transit: _transit, ...ship }) => ({ ...ship, systemId: 'eden' })));
    expect(next.ships.slice(0, 3).map(ship => ship.fuel)).toEqual([0, 0, 0]);
    expect(next.ships.slice(3)).toEqual(state.ships.slice(3));
    expect(next.fleets.items).toEqual([{ ...state.fleets.items[0], systemId: 'eden' }, state.fleets.items[1]]);
    expect(next.fleets.lastFleetId).toBe(state.fleets.lastFleetId);
    expect(next.production.orders).toEqual(state.production.orders.slice(1));
    const { remainingTurns: _remainingTurns, ...completed } = state.production.orders[0];
    expect(next.production.completed).toEqual([...state.production.completed, completed]);
    expect(next.production.lastOrderId).toBe(28); expect(next.treasuries.red).toEqual(state.treasuries.red);
    const enemyBefore = getCampaignSessionView(state, 'red');
    expect(getCampaignSessionView(next, 'red')).toEqual({ ...enemyBefore, turn: 2, activeFactionId: 'red' });
  });
  it('repeats deficit without debt, ship losses, group changes or paused FIFO', () => {
    let state = movingDeficit();
    for (let round = 0; round < 3; round++) {
      const ownBefore = structuredClone(state.ships.filter(ship => ship.factionId === 'blue'));
      const result = end(state);
      expect(result.receipt.upkeep).toEqual({ shipCount: 21, dueCredits: 21, paidCredits: 20, shortfallCredits: 1 });
      expect(result.receipt.treasuryAfter).toEqual({ credits: 0, minerals: 15 + round * 10 });
      expect(result.state.ships.filter(ship => ship.factionId === 'blue').map(ship => ({ id: ship.id, fuel: ship.fuel, design: ship.design })))
        .toEqual(ownBefore.map(ship => ({ id: ship.id, fuel: ship.fuel, design: ship.design })));
      expect(result.state.fleets.items[0]).toEqual({ id: 1, factionId: 'blue', systemId: 'eden', shipIds: [2, 1] });
      if (round > 0) expect(result.state.production.orders.find(order => order.id === 26)!.remainingTurns)
        .toBe(getProductionQuote(state.ships[0].design).turns - round);
      state = end(result.state).state;
    }
    expect(state.turn).toBe(7); expect(state.ships).toHaveLength(24);
  });
  it('retains all 100 own ships after paying every available credit, without per-ship penalties', () => {
    const state = fixture(100, 2); state.treasuries.blue = { credits: 5, minerals: 5 }; freeze(state);
    const result = end(state);
    expect(result.receipt).toEqual({ factionId: 'blue', turn: 1, income: { credits: 20, minerals: 10 },
      upkeep: { shipCount: 100, dueCredits: 100, paidCredits: 25, shortfallCredits: 75 }, treasuryAfter: { credits: 0, minerals: 15 } });
    expect(result.state.ships).toEqual(state.ships); expect(result.state.fleets).toEqual(state.fleets);
    expect(result.state.treasuries.red).toEqual(state.treasuries.red);
    const nextOwn = end(end(result.state).state);
    expect(nextOwn.receipt.upkeep).toEqual({ shipCount: 100, dueCredits: 100, paidCredits: 20, shortfallCredits: 80 });
    expect(nextOwn.state.ships).toEqual(state.ships);
  });
  it('gives no grouping discount, immediate fee or arrival fee, even with reordered membership and capped counters', () => {
    let state = fixture(2, 0); state.ships.forEach(ship => { ship.fuel = 1; });
    const initial = structuredClone(state.treasuries);
    state = succeed(state, { kind: 'createFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipIds: [2, 1] }).state;
    state.fleets.items[0].shipIds.reverse(); state.ships.reverse();
    state.fleets.lastFleetId = MAX_FLEET_ID; state.production.lastOrderId = MAX_ORDER_ID;
    expect(forecast(state, 'blue').upkeep.dueCredits).toBe(2);
    state = succeed(state, { kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden' }).state;
    expect(state.treasuries).toEqual(initial); expect(forecast(state, 'blue').upkeep.dueCredits).toBe(2);
    const arrived = end(state); expect(arrived.receipt.treasuryAfter).toEqual({ credits: 118, minerals: 60 });
    state = end(arrived.state).state;
    const beforeDisband = structuredClone(state);
    state = succeed(state, { kind: 'disbandFleet', factionId: 'blue', expectedTurn: 3, systemId: 'eden', fleetId: 1 }).state;
    expect(state.treasuries).toEqual(beforeDisband.treasuries); expect(state.ships).toEqual(beforeDisband.ships);
    expect(end(state).receipt.upkeep.dueCredits).toBe(2);
  });
  it('allows pre-turn production/refuel spending without a reserve and refunds only the production amount', () => {
    let state = fixture(21, 0); const design = createCombatDesign('fighter'), price = getProductionQuote(design).cost;
    state.treasuries.blue = structuredClone(price);
    state = succeed(state, { kind: 'enqueueProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', design }).state;
    expect(state.treasuries.blue).toEqual({ credits: 0, minerals: 0 });
    expect(end(state).receipt.upkeep.shortfallCredits).toBe(1);
    const refund = getProductionRefund(state.production.orders[0]);
    state = succeed(state, { kind: 'cancelProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 22 }).state;
    expect(state.treasuries.blue).toEqual(refund); expect(refund).toEqual(price);
    state.treasuries.blue = { credits: 15, minerals: 6 };
    state = succeed(state, { kind: 'refuelShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1 }).state;
    expect(state.treasuries.blue).toEqual({ credits: 0, minerals: 0 });
    expect(end(state).receipt.upkeep).toEqual({ shipCount: 21, dueCredits: 21, paidCredits: 20, shortfallCredits: 1 });
  });
  it('replays frozen snapshots deterministically but rejects stale repeated endTurn on the returned state', () => {
    const state = movingDeficit(); freeze(state); freeze(endBlue);
    const first = succeed(state, endBlue), replay = succeed(state, endBlue);
    expect(replay).toEqual(first); expect(replay.state).not.toBe(first.state);
    expect(replay.endTurnEconomy).not.toBe(first.endTurnEconomy);
    reject(first.state, endBlue, 'STALE_TURN');
    reject(first.state, { ...endBlue, expectedTurn: 2 }, 'NOT_ACTIVE_FACTION');
    const commands: SessionCommand[] = [endBlue, { kind: 'endTurn', factionId: 'red', expectedTurn: 2 },
      { kind: 'endTurn', factionId: 'blue', expectedTurn: 3 }];
    freeze(commands);
    const run = () => commands.reduce((current, command) => succeed(current, command).state, state);
    expect(run()).toEqual(run()); expect(run().treasuries.blue).toEqual({ credits: 0, minerals: 25 });
  });
  it.each(['credits', 'minerals'] as const)('rejects gross %s overflow before debit/FIFO/arrivals and keeps spent fuel', resource => {
    const state = movingDeficit();
    state.treasuries.blue = { credits: MAX_RESOURCE - 20, minerals: MAX_RESOURCE - 10 };
    state.treasuries.blue[resource]++; freeze(state);
    reject(state, endBlue, 'RESOURCE_LIMIT');
    expect(getCampaignSessionView(state, 'blue').economyForecast).toEqual({ ok: false, code: 'RESOURCE_LIMIT' });
    expect(state.ships.slice(0, 3).map(ship => ship.fuel)).toEqual([0, 0, 0]);
    expect(state.ships.slice(0, 3).every(ship => ship.transit)).toBe(true);
  });
  it('accepts exact gross caps and advances everything with the post-debit treasury', () => {
    const state = movingDeficit(); state.treasuries.blue = { credits: MAX_RESOURCE - 20, minerals: MAX_RESOURCE - 10 };
    const result = end(state);
    expect(result.receipt.treasuryAfter).toEqual({ credits: MAX_RESOURCE - 21, minerals: MAX_RESOURCE });
    expect(result.state.production.completed.map(record => record.id)).toEqual([28, 25]);
    expect(result.state.ships.slice(0, 3).every(ship => !ship.transit && ship.systemId === 'eden')).toBe(true);
  });
  it('preserves state → command → stale → active → turn limit → gross cap error priority', () => {
    const state = movingDeficit(); state.turn = MAX_TURN;
    state.treasuries.blue.credits = MAX_RESOURCE; state.treasuries.red.credits = MAX_RESOURCE;
    freeze(state);
    const command = { kind: 'endTurn', factionId: 'red', expectedTurn: MAX_TURN } as const;
    reject({ ...state, debt: 1 }, { ...command, quote: 0 }, 'INVALID_STATE');
    reject(state, { ...command, quote: 0 }, 'INVALID_COMMAND');
    reject(state, { ...command, factionId: 'blue', expectedTurn: 1 }, 'STALE_TURN');
    reject(state, { ...command, factionId: 'blue' }, 'NOT_ACTIVE_FACTION');
    reject(state, command, 'TURN_LIMIT');
    for (const faction of sides) expect(getCampaignSessionView(state, faction).economyForecast).toEqual({ ok: false, code: 'TURN_LIMIT' });
  });
  it.each(['quote', 'shipCount', 'credits', 'price', 'paidCredits', 'shortfallCredits', 'income', 'upkeep', 'treasuryAfter', 'endTurnEconomy'])
    ('strict endTurn rejects caller-supplied %s without a receipt or state', key => {
      const command = { ...endBlue, [key]: 0 }, state = movingDeficit(); freeze(state); freeze(command);
      expect(sessionCommandSchema.safeParse(command).success).toBe(false);
      reject(state, command, 'INVALID_COMMAND');
    });
});

describe('own economy forecast, compatibility and detached receipts', () => {
  it.each(sides)('matches the %s active preview to the next receipt and treats the new preview as a future payment', faction => {
    const state = fixture(2, 3); state.turn = faction === 'blue' ? 1 : 2;
    const view = getCampaignSessionView(state, faction), expected = forecast(state, faction), result = end(state);
    const { factionId: _factionId, turn: _turn, ...economy } = result.receipt;
    expect(expected).toEqual({ ok: true, ...economy });
    expect(view.income).toEqual({ credits: 20, minerals: 10 });
    const next = forecast(result.state, faction);
    expect(next.treasuryAfter.credits).toBe(result.receipt.treasuryAfter.credits + 20 - expected.upkeep.dueCredits);
    expect(next.treasuryAfter.minerals).toBe(result.receipt.treasuryAfter.minerals + 10);
    expect(next).not.toEqual(expected);
  });
  it.each(sides)('provides a hypothetical %s inactive preview, not permission to end the turn', faction => {
    const state = fixture(2, 3); state.turn = faction === 'blue' ? 2 : 1;
    const view = getCampaignSessionView(state, faction), count = faction === 'blue' ? 2 : 3;
    expect(view.economyForecast).toEqual({ ok: true, income: { credits: 20, minerals: 10 },
      upkeep: { shipCount: count, dueCredits: count, paidCredits: count, shortfallCredits: 0 },
      treasuryAfter: { credits: 120 - count, minerals: 60 } });
    reject(state, { kind: 'endTurn', factionId: faction, expectedTurn: state.turn }, 'NOT_ACTIVE_FACTION');
    const nowActive = end(state).state;
    expect(forecast(nowActive, faction)).toEqual(view.economyForecast);
  });
  it.each(sides)('reports a hypothetical resource limit for inactive %s without leaking the error to the active preview', faction => {
    const state = fixture(2, 3); state.turn = faction === 'blue' ? 2 : 1;
    const active = faction === 'blue' ? 'red' : 'blue', before = getCampaignSessionView(state, active);
    state.treasuries[faction].credits = MAX_RESOURCE - 19;
    expect(getCampaignSessionView(state, faction).economyForecast).toEqual({ ok: false, code: 'RESOURCE_LIMIT' });
    expect(getCampaignSessionView(state, active)).toEqual(before);
    reject(state, { kind: 'endTurn', factionId: faction, expectedTurn: state.turn }, 'NOT_ACTIVE_FACTION');
  });
  it('recomputes after deploy, refuel and colonize without charging upkeep during those commands', () => {
    let state = createCampaignSession(); const design = createCivilianDesign('freighter');
    state.production = { lastOrderId: 1, orders: [], completed: [{ id: 1, factionId: 'blue', systemId: 'sol', design }] };
    expect(forecast(state, 'blue').treasuryAfter).toEqual({ credits: 110, minerals: 55 });
    state = succeed(state, { kind: 'deployProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 1 }).state;
    expect(forecast(state, 'blue').treasuryAfter).toEqual({ credits: 109, minerals: 55 });
    // Diagnostic depleted tank; the subsequent refuel itself is the real command.
    state.ships[0].fuel = 0;
    state = succeed(state, { kind: 'refuelShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1 }).state;
    expect(forecast(state, 'blue').treasuryAfter).toEqual({ credits: 94, minerals: 49 });
    state = succeed(state, { kind: 'explore', factionId: 'blue', expectedTurn: 1, systemId: 'eden' }).state;
    expect(forecast(state, 'blue').treasuryAfter).toEqual({ credits: 94, minerals: 49 });
    state = succeed(state, { kind: 'colonize', factionId: 'blue', expectedTurn: 1, systemId: 'eden' }).state;
    expect(state.treasuries.blue).toEqual({ credits: 85, minerals: 44 }); expect(state.turn).toBe(1);
    expect(forecast(state, 'blue')).toEqual({ ok: true, income: { credits: 20, minerals: 10 },
      upkeep: { shipCount: 1, dueCredits: 1, paidCredits: 1, shortfallCredits: 0 }, treasuryAfter: { credits: 104, minerals: 54 } });
  });
  it('does not reveal enemy treasury, upkeep, deficit or routes even at explored enemy colonies', () => {
    const state = fixture(2, 100);
    for (const system of state.galaxy.systems) if (!system.exploredBy.includes('blue')) system.exploredBy.push('blue');
    const before = getCampaignSessionView(state, 'blue');
    state.treasuries.red = { credits: 0, minerals: 0 };
    expect(forecast(state, 'red').upkeep.shortfallCredits).toBe(80);
    state.ships.filter(ship => ship.factionId === 'red').forEach(ship => { ship.transit = { destinationId: 'nexus', remainingTurns: 1 }; });
    expect(getCampaignSessionView(state, 'blue')).toEqual(before);
    state.ships = state.ships.filter(ship => ship.factionId === 'blue' || ship.id === 3);
    expect(getCampaignSessionView(state, 'blue')).toEqual(before);
    expect(before.ships.every(ship => ship.factionId === 'blue')).toBe(true);
    expect(Object.keys(before.economyForecast).sort()).toEqual(['income', 'ok', 'treasuryAfter', 'upkeep']);
  });
  it('accepts the old valid session shape without migration or persisted upkeep/receipt/debt fields', () => {
    const old = movingDeficit(), snapshot = structuredClone(old); freeze(old);
    expect(campaignSessionSchema.parse(old)).toEqual(snapshot);
    const { state: next, receipt } = end(old);
    expect(receipt.upkeep.dueCredits).toBe(21); expect(old).toEqual(snapshot);
    expect(Object.keys(next).sort()).toEqual(['fleets', 'galaxy', 'production', 'ships', 'treasuries', 'turn']);
    expect(Object.keys(next.treasuries.blue).sort()).toEqual(['credits', 'minerals']);
    expect(Object.keys(next.fleets).sort()).toEqual(['items', 'lastFleetId']);
    for (const ship of next.ships) {
      const source = old.ships.find(item => item.id === ship.id)!;
      expect(ship.design).toEqual(source.design);
      expect(Object.keys(ship).filter(key => key !== 'transit').sort()).toEqual(['design', 'factionId', 'fuel', 'id', 'systemId']);
    }
    for (const fleet of next.fleets.items) expect(Object.keys(fleet).sort()).toEqual(['factionId', 'id', 'shipIds', 'systemId']);
    for (const key of ['upkeep', 'debt', 'lastReceipt', 'endTurnEconomy', 'economyForecast']) {
      expect(next).not.toHaveProperty(key);
      reject({ ...next, [key]: 0 }, { kind: 'endTurn', factionId: 'red', expectedTurn: 2 }, 'INVALID_STATE');
    }
  });
  it.each(['ships', 'fleets', 'fuel'] as const)('still rejects a legacy state missing required %s', key => {
    const state = fixture();
    if (key === 'fuel') delete (state.ships[0] as Partial<CampaignShip>).fuel;
    else delete (state as Partial<CampaignSession>)[key];
    reject(state, endBlue, 'INVALID_STATE');
    expect(() => getCampaignSessionView(state, 'blue')).toThrow(ZodError);
  });
  it('separates every nested forecast/receipt/treasury object from inputs, other views and returned state', () => {
    const state = movingDeficit(), snapshot = structuredClone(state);
    const view = getCampaignSessionView(state, 'blue'), otherView = getCampaignSessionView(state, 'blue');
    const preview = view.economyForecast, otherPreview = otherView.economyForecast;
    if (!preview.ok || !otherPreview.ok) throw Error('Expected successful forecasts');
    const result = end(state), receiptSnapshot = structuredClone(result.receipt), nextSnapshot = structuredClone(result.state);
    const nextPreview = forecast(result.state, 'blue'), nextPreviewSnapshot = structuredClone(nextPreview);
    const objects = [state.treasuries.blue, view.treasury, view.income, preview.income, preview.upkeep, preview.treasuryAfter,
      otherView.treasury, otherView.income, otherPreview.income, otherPreview.upkeep, otherPreview.treasuryAfter,
      result.receipt.income, result.receipt.upkeep, result.receipt.treasuryAfter, result.state.treasuries.blue,
      nextPreview.income, nextPreview.upkeep, nextPreview.treasuryAfter];
    expect(new Set(objects).size).toBe(objects.length);
    preview.income.credits = 777; preview.upkeep.shipCount = 777; preview.treasuryAfter.minerals = 777;
    view.treasury.credits = 777; view.income.minerals = 777;
    view.ships[0].design.name = 'Changed preview'; view.ships[0].transit!.destinationId = 'sol'; view.fleets[0].shipIds.reverse();
    expect(otherView).toEqual(getCampaignSessionView(state, 'blue')); expect(state).toEqual(snapshot);
    expect(result.receipt).toEqual(receiptSnapshot); expect(result.state).toEqual(nextSnapshot);
    result.receipt.income.credits = 888; result.receipt.upkeep.paidCredits = 888; result.receipt.treasuryAfter.credits = 888;
    expect(result.state).toEqual(nextSnapshot); expect(nextPreview).toEqual(nextPreviewSnapshot);
    const mutatedReceipt = structuredClone(result.receipt);
    result.state.treasuries.blue.credits = 999; result.state.ships[0].design.name = 'Changed result';
    result.state.fleets.items[0].shipIds.reverse();
    expect(result.receipt).toEqual(mutatedReceipt); expect(nextPreview).toEqual(nextPreviewSnapshot); expect(state).toEqual(snapshot);
    nextPreview.income.minerals = 555; nextPreview.upkeep.shortfallCredits = 555; nextPreview.treasuryAfter.credits = 555;
    expect(result.receipt).toEqual(mutatedReceipt); expect(result.state.treasuries.blue.credits).toBe(999);
  });
});