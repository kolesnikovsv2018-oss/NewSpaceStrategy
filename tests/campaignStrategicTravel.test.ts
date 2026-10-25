import { describe, expect, it } from 'vitest';
import { createStrategicEquipment, getTravelCapabilities, getTravelQuote, getFleetTravelQuotes,
  getStrategicRefuelQuote, getWorldDistance, getStrategicEquipmentCost } from '../src/domain/campaignTravel';
import { createConquest, executeConquestCommand, getConquestView, conquestSchema, type Conquest } from '../src/domain/conquest';
import { createColonizerDesign } from '../src/domain/civilianPresets';
import { calculateShipStats, createDesign, createComponentWithId, designSchema, type ShipDesign } from '../src/domain/shipDesign';
import { isCampaignDesignAvailable } from '../src/domain/campaignResearch';
import { getColonyProductionQuote } from '../src/domain/campaignOutput';
import { createOperationalState } from '../src/domain/campaignOperations';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';
import { canReachInitialWorld, getNearestNeutralWorlds } from '../src/domain/galaxyMap';
import { workCommand as apply, workRound as round, earnWorkTechnology as earn } from './fixtures/colonyWork';

const base = getTravelCapabilities(createStrategicEquipment());
function scenario() {
  const generated = generateBrowserGalaxy(40, 41);
  if (!generated.ok) throw new Error(generated.message);
  const state = createConquest(undefined, undefined, 101, generated.map);
  const ship = state.session.ships[0];
  const target = generated.map.worlds.find(world => {
    const distance = getWorldDistance(generated.map.worlds, ship.systemId, world.id);
    return distance > 100 && distance <= 200;
  });
  if (!target) throw new Error('Нет многотактовой диагностической цели');
  return { state, ship, target, map: generated.map };
}
function send(state: Conquest, shipId: number, destinationId: string) {
  const ship = state.session.ships.find(item => item.id === shipId)!;
  return apply(state, { kind: 'sendShip', shipId, systemId: ship.systemId, destinationId });
}

describe('project strategic travel', () => {
  it('never mines or services in transit and forecasts only the actual arrival window', () => {
    const setup = scenario();
    let state = apply(setup.state, { kind: 'assignWorkers', systemId: setup.ship.systemId,
      workers: { industry: 1000, research: 4000, culture: 0 } });
    state = earn(state, 'applied');
    const ship = state.session.ships[0];
    ship.design.slots.find(slot => slot.id === 'service_1')!.component = createComponentWithId('mining', 'diagnostic-miner');
    const target = setup.map.worlds.find(world => world.type === 'barren' &&
      getWorldDistance(setup.map.worlds, ship.systemId, world.id) > 100 &&
      getWorldDistance(setup.map.worlds, ship.systemId, world.id) <= 200);
    if (!target) throw new Error('Нет диагностического barren для двух ходов');
    state.surveys.blue[target.id] = 'barren';
    state.session.galaxy.systems.find(world => world.id === target.id)!.exploredBy.push('blue');
    state = send(state, ship.id, target.id);
    for (const kind of ['repairShip', 'resupplyShip', 'refuelShip']) {
      const before = structuredClone(state);
      expect(executeConquestCommand(state, { kind, systemId: ship.systemId, shipId: ship.id,
        factionId: 'blue', expectedTurn: state.session.turn }).ok).toBe(false);
      expect(state).toEqual(before);
    }
    const forecast = (source: Conquest) => {
      const view = getConquestView(source, 'blue');
      return view.income.minerals - view.colonyOutput.forecast.income.minerals;
    };
    expect(forecast(state)).toBe(0);
    const first = executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: state.session.turn });
    if (!first.ok) throw new Error(first.message);
    expect(first.turnReceipt!.miningMinerals).toBe(0);
    state = apply(first.state, { kind: 'endTurn' });
    expect(forecast(state)).toBe(8);
    const last = executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: state.session.turn });
    if (!last.ok) throw new Error(last.message);
    expect(last.turnReceipt!.miningMinerals).toBe(8);
    expect(last.state.session.ships[0].transit).toBeUndefined();
  });

  it('does not accelerate a pinned route when a paid drive discovery completes in flight', () => {
    const setup = scenario();
    let state = apply(setup.state, { kind: 'assignWorkers', systemId: setup.ship.systemId,
      workers: { industry: 1000, research: 4000, culture: 0 } });
    state = earn(state, 'engineering');
    state = apply(state, { kind: 'research', technologyId: 'strategic-drive' });
    state = send(state, setup.ship.id, setup.target.id);
    const snapshot = structuredClone(state.session.ships[0].transit);
    state = round(state);
    expect(state.research.blue.completed).toContain('strategic-drive');
    expect(state.session.ships[0].transit).toEqual({ ...snapshot, remainingTurns: 1 });
    const restored = decodeConquestSave(encodeConquestSave(state));
    expect(round(restored)).toEqual(round(state));
    expect(round(state).session.ships[0].systemId).toBe(setup.target.id);
  });

  it('uses independent exact turns, jump, fuel and refuel formulas', () => {
    expect(getTravelQuote(10, { ...base, strategicSpeed: 4 }, 3000)).toEqual({ ok: true, distance: 10, totalTurns: 3, fuelCost: 50 });
    expect(getTravelQuote(10, { ...base, strategicSpeed: 5, fuelCapacity: 9000 }, 3000)).toMatchObject({ ok: true, totalTurns: 2, fuelCost: 50 });
    expect(getTravelQuote(200, base, 1000)).toMatchObject({ ok: true, fuelCost: 1000 });
    expect(getTravelQuote(201, base, 3000)).toMatchObject({ ok: false, code: 'INVALID_ROUTE' });
    expect(getTravelQuote(200, base, 999)).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUEL' });
    for (const strategicSpeed of [0, -1, NaN, Infinity, Number.MIN_VALUE]) {
      expect(getTravelQuote(10, { ...base, strategicSpeed }, 3000).ok).toBe(false);
    }
    expect(getTravelQuote(10, { ...base, fuelConsumptionPerDistance: Number.MAX_VALUE }, 3000).ok).toBe(false);
    expect(getTravelQuote(Infinity, base, 3000).ok).toBe(false);
    expect(getStrategicRefuelQuote(2999, 3000)).toEqual({ amount: 1, cost: { credits: 1, minerals: 1 } });
    expect(getStrategicRefuelQuote(0, 3000)).toEqual({ amount: 3000, cost: { credits: 15, minerals: 6 } });
    expect(() => getStrategicRefuelQuote(3001, 3000)).toThrow();
    const quotes = getFleetTravelQuotes(10, [
      { capabilities: { ...base, strategicSpeed: 5 }, fuel: 3000 },
      { capabilities: { ...base, strategicSpeed: 3 }, fuel: 3000 }
    ]);
    expect(quotes.map(item => item.quote)).toEqual(Array(2).fill({ ok: true, distance: 10, totalTurns: 4, fuelCost: 50 }));
  });

  it('changes only the selected strategic capability and canonical credits, never tactical ratings', () => {
    const design = createColonizerDesign(), original = calculateShipStats(design);
    for (const [change, capabilities, credits] of [
      [{ drive: 'fast' }, { strategicSpeed: 200 }, 75],
      [{ jump: 'extended' }, { maxJumpDistance: 400 }, 50],
      [{ jump: 'deep' }, { maxJumpDistance: 800 }, 100],
      [{ jump: 'galactic' }, { maxJumpDistance: 1500 }, 150],
      [{ tank: 'extended' }, { fuelCapacity: 9000 }, 60]
    ] as const) {
      const next = designSchema.parse({ ...design, strategicEquipment: { ...design.strategicEquipment, ...change } });
      expect(getTravelCapabilities(next.strategicEquipment)).toEqual({ ...base, ...capabilities });
      expect(getStrategicEquipmentCost(next.strategicEquipment)).toBe(credits);
      expect(calculateShipStats(next)).toEqual({ ...original, cost: original.cost + credits * 100 });
    }
    expect(designSchema.safeParse({ ...design, schemaVersion: 4 }).success).toBe(false);
    expect(designSchema.safeParse({ ...design, strategicEquipment: undefined }).success).toBe(false);
    expect(getTravelCapabilities(design.strategicEquipment)).toEqual(base);
  });

  it('counts only own turns, pins snapshots and roundtrips midway without endpoint presence', () => {
    const { state: initial, ship, target } = scenario();
    let state = send(initial, ship.id, target.id);
    const first = structuredClone(state.session.ships[0].transit);
    expect(first).toMatchObject({ policy: 'project-travel-v1', totalTurns: 2, remainingTurns: 2 });
    if (!first || !('distance' in first)) throw new Error('Нет военного снимка маршрута');
    expect(getConquestView(state, 'blue').ships[0].transit).toEqual(first);
    expect(getConquestView(state, 'red').enemies.some(item => item.id === ship.id)).toBe(false);
    expect(state.session.ships[0].fuel).toBe(3000 - Math.ceil(first.distance * 5));
    const repeat = executeConquestCommand(state, { kind: 'sendShip', factionId: 'blue', expectedTurn: 1,
      shipId: ship.id, systemId: ship.systemId, destinationId: target.id });
    expect(repeat).toMatchObject({ ok: false, code: 'SHIP_IN_TRANSIT' });
    state = apply(state, { kind: 'endTurn' });
    expect(state.session.ships[0].transit?.remainingTurns).toBe(1);
    const restored = decodeConquestSave(encodeConquestSave(state));
    expect(apply(restored, { kind: 'endTurn' })).toEqual(apply(state, { kind: 'endTurn' }));
    state = apply(state, { kind: 'endTurn' });
    expect(state.session.ships[0].transit?.remainingTurns).toBe(1);
    state = apply(state, { kind: 'endTurn' });
    expect(state.session.ships[0].transit).toBeUndefined();
    expect(state.session.ships[0].systemId).toBe(target.id);
    expect(initial.session.ships[0].fuel).toBe(3000);
    for (const change of [{ remainingTurns: 3 }, { totalTurns: 3 }, { fuelCost: 1 }, { distance: 1 }]) {
      const bad = structuredClone(restored);
      Object.assign(bad.session.ships[0].transit!, change);
      expect(conquestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects an entire fleet on one shortage and arrives synchronously with mixed drives', () => {
    const setup = scenario();
    let state = apply(setup.state, { kind: 'assignWorkers', systemId: setup.ship.systemId,
      workers: { industry: 1000, research: 4000, culture: 0 } });
    state = earn(earn(state, 'engineering'), 'strategic-drive');
    const second = structuredClone(state.session.ships[0]);
    second.id = ++state.session.production.lastOrderId;
    second.design.strategicEquipment.drive = 'fast';
    second.fuel = 1;
    state.session.ships.push(second); state.operations[String(second.id)] = createOperationalState(second.design);
    state = apply(state, { kind: 'createFleet', systemId: setup.ship.systemId, shipIds: [setup.ship.id, second.id] });
    const command = { kind: 'sendFleet', factionId: 'blue', expectedTurn: state.session.turn,
      systemId: setup.ship.systemId, destinationId: setup.target.id, fleetId: 1 };
    const before = structuredClone(state);
    expect(executeConquestCommand(state, command)).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUEL' });
    expect(state).toEqual(before);
    state = apply(state, { kind: 'refuelShip', systemId: second.systemId, shipId: second.id });
    state = apply(state, command);
    const members = () => state.session.ships.filter(item => [setup.ship.id, second.id].includes(item.id));
    expect(members().map(item => item.transit?.remainingTurns)).toEqual([2, 2]);
    state = round(state);
    expect(state.session.fleets.items[0].systemId).toBe(setup.ship.systemId);
    expect(members().map(item => item.transit?.remainingTurns)).toEqual([1, 1]);
    state = round(decodeConquestSave(encodeConquestSave(state)));
    expect(state.session.fleets.items[0].systemId).toBe(setup.target.id);
    expect(members().every(item => !item.transit && item.systemId === setup.target.id)).toBe(true);
  });

  it('earns and pays equipment through build/refit without changing old snapshots or refilling a new tank', () => {
    let state = createConquest();
    state = apply(state, { kind: 'assignWorkers', systemId: 'sol', workers: { industry: 1000, research: 4000, culture: 0 } });
    const original = structuredClone(state.session.ships[0]);
    const design: ShipDesign = { ...createColonizerDesign(), strategicEquipment: {
      policy: 'project-travel-v1', drive: 'fast', jump: 'extended', tank: 'extended' } };
    expect(isCampaignDesignAvailable(design, state.research.blue, state.researchTree)).toBe(false);
    for (const id of ['engineering', 'strategic-drive', 'strategic-tank']) state = earn(state, id);
    expect(state.session.ships[0]).toEqual(original);
    expect(isCampaignDesignAvailable(design, state.research.blue, state.researchTree)).toBe(true);
    expect(getColonyProductionQuote(design, state.rules.colonyOutput).cost).toEqual({ credits: 414, minerals: 19 });
    state = apply(state, { kind: 'startRefit', systemId: 'sol', shipId: 1, design });
    const projectId = state.session.production.lastOrderId;
    state = round(decodeConquestSave(encodeConquestSave(state)));
    expect(state.colonyOutput.projects.some(item => item.id === projectId)).toBe(false);
    expect(state.session.ships[0].design).toEqual(design);
    expect(state.session.ships[0].fuel).toBe(3000);
    state = apply(state, { kind: 'refuelShip', systemId: 'sol', shipId: 1 });
    expect(state.session.ships[0].fuel).toBe(9000);
    expect(executeConquestCommand(state, { kind: 'startRefit', factionId: 'blue', expectedTurn: state.session.turn,
      systemId: 'sol', shipId: 1, design: createColonizerDesign() })).toMatchObject({ ok: false, code: 'INVALID_DESIGN' });
  });

  it('restores a paid multi-turn combat leg and produces the identical real arrival battle', () => {
    const setup = scenario();
    let state = apply(setup.state, { kind: 'assignWorkers', systemId: setup.ship.systemId,
      workers: { industry: 1000, research: 4000, culture: 0 } });
    for (const id of ['engineering', 'support', 'ordnance', 'capital', 'strategic-drive', 'strategic-tank']) state = earn(state, id);
    const design = createDesign('corvette', true);
    design.strategicEquipment = { policy: 'project-travel-v1', drive: 'fast', jump: 'galactic', tank: 'extended' };
    state = apply(state, { kind: 'enqueueProduction', systemId: setup.ship.systemId, design });
    const id = state.session.production.lastOrderId;
    state = round(state);
    state = apply(state, { kind: 'deployProduction', systemId: setup.ship.systemId, orderId: id });
    const enemyHome = setup.map.participants[1].homeWorldId;
    state = send(state, id, enemyHome);
    expect(state.session.ships.find(ship => ship.id === id)!.transit!.remainingTurns).toBeGreaterThan(1);
    for (let step = 0; step < 20 && state.session.ships.find(ship => ship.id === id)!.transit!.remainingTurns > 1; step++) state = round(state);
    const restored = decodeConquestSave(encodeConquestSave(state));
    const uninterrupted = round(state), resumed = round(restored);
    expect(resumed).toEqual(uninterrupted);
    expect(resumed.lastBattleId).toBeGreaterThan(0);
    expect(resumed.battles.at(-1)!.systemId).toBe(enemyHome);
    expect(resumed.battles.at(-1)!.participants.some(ship => ship.id === id)).toBe(true);
  });

  it('matches initial reach and paid real colonization of both nearest worlds for both sides', () => {
    const result = generateBrowserGalaxy(6, 41);
    if (!result.ok) throw new Error(result.message);
    let state = createConquest(undefined, undefined, 101, result.map);
    for (const faction of ['blue', 'red'] as const) {
      if ((state.session.turn % 2 ? 'blue' : 'red') !== faction) state = apply(state, { kind: 'endTurn' });
      const home = result.map.participants[faction === 'blue' ? 0 : 1].homeWorldId;
      state = apply(state, { kind: 'assignWorkers', systemId: home, workers: { industry: 5000, research: 0, culture: 0 } });
      const targets = getNearestNeutralWorlds(result.map, home);
      for (const [index, target] of targets.entries()) {
        expect(canReachInitialWorld(result.map, home, target.id)).toBe(true);
        let id = faction === 'blue' ? 1 : 2;
        if (index) {
          const design = createColonizerDesign();
          state = apply(state, { kind: 'enqueueProduction', systemId: home, design });
          id = state.session.production.lastOrderId;
          state = round(state);
          state = apply(state, { kind: 'deployProduction', systemId: home, orderId: id });
        }
        state = send(state, id, target.id);
        state = round(decodeConquestSave(encodeConquestSave(state)));
        state = apply(state, { kind: 'survey', systemId: target.id });
        state = apply(state, { kind: 'colonize', systemId: target.id, shipId: id });
        expect(state.session.galaxy.systems.find(item => item.id === target.id)!.ownerId).toBe(faction);
      }
    }
  });
});
