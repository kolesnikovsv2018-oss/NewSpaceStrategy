import { expect, it } from 'vitest';
import { createConquest, executeConquestCommand, getConquestOutcome, getConquestView, conquestSchema, type Conquest } from '../src/domain/conquest';
import { createDesign, createComponentWithId, installComponent, validateDesign } from '../src/domain/shipDesign';
import { getDefaultResearchTree, researchTreeSchema } from '../src/domain/campaignResearch';
import { buildConquestDesigns } from '../src/domain/conquestAi';
import { createOperationalState } from '../src/domain/campaignOperations';
import { encodeConquestSave, decodeConquestSave, ConquestSaveManager } from '../src/utils/ConquestSaveManager';
import { ShipDesignManager } from '../src/utils/ShipDesignManager';
import { getProductionQuote } from '../src/domain/production';

function end(state: Conquest): Conquest {
  const result = executeConquestCommand(state, { kind: 'endTurn', factionId: state.session.turn % 2 ? 'blue' : 'red', expectedTurn: state.session.turn });
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

function diagnosticServiceState() {
  const state = createConquest();
  state.research.blue.completed = ['support', 'ordnance'];
  const design = buildConquestDesigns(state.research.blue, state.researchTree).find(item => item.hullId === 'corvette')!;
  design.slots.find(slot => slot.id === 'service_1')!.component = createComponentWithId('mining', 'miner');
  design.slots.find(slot => slot.id === 'service_2')!.component = createComponentWithId('repair', 'repair');
  expect(validateDesign(design, 'flight')).toEqual([]);
  state.session.production.lastOrderId = 1;
  state.session.ships.push({ id: 1, factionId: 'blue', systemId: 'rift', fuel: 2, design });
  state.operations['1'] = { ...createOperationalState(design), hull: 100 };
  return conquestSchema.parse(state);
}

it('diagnostic mining earns minerals only on own endTurn and preserves damaged state through load', () => {
  const source = diagnosticServiceState(), before = structuredClone(source);
  const view = getConquestView(source, 'blue');
  expect(view.income.minerals).toBe(13);
  expect(view.economyForecast.ok && view.economyForecast.treasuryAfter.minerals).toBe(63);
  const next = end(source);
  expect(next.session.treasuries.blue.minerals).toBe(63);
  expect(end(next).session.treasuries.blue.minerals).toBe(63);
  expect(decodeConquestSave(encodeConquestSave(next)).operations['1'].hull).toBe(100);
  expect(source).toEqual(before);
});

it('diagnostic field repair uses real module rate and debits both resources atomically', () => {
  const source = diagnosticServiceState();
  const command = { kind: 'repairShip', shipId: 1, systemId: 'rift', factionId: 'blue', expectedTurn: 1 };
  const result = executeConquestCommand(source, command);
  if (!result.ok) throw new Error(result.message);
  expect(result.state.operations['1'].hull).toBe(105);
  expect(result.state.session.treasuries.blue).toEqual({ credits: 99, minerals: 49 });
  source.session.treasuries.blue.minerals = 0;
  const before = structuredClone(source);
  expect(executeConquestCommand(source, command).ok).toBe(false);
  expect(source).toEqual(before);
});

it('diagnostic scanner extends presence by one lane without exposing a distant enemy treasury', () => {
  const source = diagnosticServiceState();
  source.session.ships[0].design.slots.find(slot => slot.id === 'service_1')!.component = createComponentWithId('scanner', 'scanner');
  const result = executeConquestCommand(source, { kind: 'explore', systemId: 'dust', factionId: 'blue', expectedTurn: 1 });
  if (!result.ok) throw new Error(result.message);
  const view = getConquestView(result.state, 'blue');
  expect(view.galaxy.systems.find(system => system.id === 'dust')?.visibility).toBe('explored');
  expect(view.galaxy.systems.find(system => system.id === 'vega')).not.toHaveProperty('ownerId');
  expect(view).not.toHaveProperty('treasuries');
  source.session.ships[0].design.slots.find(slot => slot.id === 'service_1')!.component = null;
  expect(executeConquestCommand(source, { kind: 'explore', systemId: 'dust', factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
});

it('diagnostic ammunition remains depleted after reload and is replenished only by payment at a colony', () => {
  const source = diagnosticServiceState();
  const design = buildConquestDesigns(source.research.blue, source.researchTree).find(item =>
    item.hullId === 'corvette' && item.slots.some(slot => slot.id === 'projectile_1' && slot.component?.kind === 'projectile'))!;
  const ammoCapacity = design.slots.find(slot => slot.id === 'projectile_1')!.component;
  if (ammoCapacity?.kind !== 'projectile') throw new Error('Missing projectile fixture');
  source.session.ships[0].design = design;
  source.operations['1'] = createOperationalState(design);
  source.operations['1'].ammunition[0].amount = 0;
  const loaded = decodeConquestSave(encodeConquestSave(source));
  expect(loaded.operations['1'].ammunition[0].amount).toBe(0);
  expect(executeConquestCommand(loaded, { kind: 'resupplyShip', shipId: 1, systemId: 'rift', factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
  loaded.session.ships[0].systemId = 'sol';
  const result = executeConquestCommand(loaded, { kind: 'resupplyShip', shipId: 1, systemId: 'sol', factionId: 'blue', expectedTurn: 1 });
  if (!result.ok) throw new Error(result.message);
  expect(result.state.operations['1'].ammunition[0].amount).toBe(ammoCapacity.ammoCapacity);
  expect(result.state.session.treasuries.blue).toEqual({ credits: 100 - ammoCapacity.ammoCapacity,
    minerals: 50 - ammoCapacity.ammoCapacity });
});
it('charges research once, advances only on own turns and preserves a detached tree through save', () => {
  const original = createConquest();
  const started = executeConquestCommand(original, { kind: 'research', factionId: 'blue', expectedTurn: 1, technologyId: 'support' });
  if (!started.ok) throw new Error(started.message);
  expect(started.state.session.treasuries.blue.credits).toBe(90);
  expect(original.session.treasuries.blue.credits).toBe(100);
  expect(executeConquestCommand(started.state, { kind: 'research', factionId: 'blue', expectedTurn: 1, technologyId: 'support' }).ok).toBe(false);
  const loaded = decodeConquestSave(encodeConquestSave(end(started.state)));
  expect(end(end(loaded)).research.blue.completed).toEqual(['support']);
  expect(end(loaded).research.blue.active?.progress).toBe(1);
  expect(loaded.researchTree).not.toBe(started.state.researchTree);
});
it('requires all habitable planets, not merely the enemy capital', () => {
  const state = createConquest();
  const vega = state.session.galaxy.systems.find(system => system.id === 'vega')!;
  vega.ownerId = 'blue'; vega.exploredBy.push('blue');
  expect(getConquestOutcome(state)).toEqual({ status: 'ongoing' });
  for (const system of state.session.galaxy.systems.filter(system => ['eden', 'nexus'].includes(system.id))) {
    system.ownerId = 'blue'; system.exploredBy.push('blue');
  }
  expect(getConquestOutcome(conquestSchema.parse(state))).toEqual({ status: 'completed', winner: 'blue', reason: 'all-planets' });
  expect(executeConquestCommand(state, { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
});
it('rejects free remote exploration and locked library projects', () => {
  const state = createConquest();
  expect(executeConquestCommand(state, { kind: 'explore', systemId: 'eden', factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
  expect(executeConquestCommand(state, { kind: 'enqueueProduction', systemId: 'sol', design: createDesign('frigate', true), factionId: 'blue', expectedTurn: 1 }).ok).toBe(false);
  const view = getConquestView(state, 'blue');
  expect(view.galaxy.systems.find(system => system.id === 'vega')).not.toHaveProperty('ownerId');
  expect(view).not.toHaveProperty('treasuries');
  expect(view.enemies).toEqual([]);
});
it('resolves arrival, captures, removes lost groups and cannot apply a stale end twice', () => {
  const state = createConquest(), design = createDesign('fighter', true);
  state.session.production.lastOrderId = 2;
  state.session.ships = [
    { id: 1, factionId: 'blue', systemId: 'sol', fuel: 2, design, transit: { destinationId: 'eden', remainingTurns: 1 } },
    { id: 2, factionId: 'red', systemId: 'eden', fuel: 2, design }
  ];
  state.operations = { '1': createOperationalState(design), '2': { hull: 1, ammunition: [] } };
  const command = { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 };
  const result = executeConquestCommand(state, command);
  if (!result.ok) throw new Error(result.message);
  expect(result.state.battles).toHaveLength(1);
  expect(executeConquestCommand(state, command)).toEqual(result);
  expect(executeConquestCommand(result.state, command).ok).toBe(false);
  expect(decodeConquestSave(encodeConquestSave(result.state))).toEqual(result.state);
  expect(state.operations['2'].hull).toBe(1);
});
it('validates before storage access and preserves previous bytes on write failure', () => {
  let bytes = encodeConquestSave(createConquest());
  const before = bytes;
  const manager = new ConquestSaveManager({ getItem: () => bytes, setItem: (_key, value) => { if (value) throw new Error('quota'); bytes = value; } });
  expect(manager.save(createConquest()).ok).toBe(false);
  expect(bytes).toBe(before);
  expect(manager.load().ok).toBe(true);
  expect(() => decodeConquestSave(before.replace('"schemaVersion":4', '"schemaVersion":999'))).toThrow();
});

it('versions campaign variant profiles and grandfathers v4/rules1 ship designs', () => {
  const current = createConquest();
  const currentEnvelope = JSON.parse(encodeConquestSave(current));
  expect(currentEnvelope).toMatchObject({ schemaVersion: 4, rulesVersion: 2, conquest: { researchTree: { version: 2 } } });
  expect(decodeConquestSave(JSON.stringify(currentEnvelope))).toEqual(current);

  const currentTree = getDefaultResearchTree();
  if (currentTree.version !== 2) throw new Error('Expected profiled research tree');
  const { variantPolicy: _variantPolicy, ...legacyFields } = currentTree;
  const legacyTree = researchTreeSchema.parse({ ...legacyFields, version: 1, id: 'grandfathered-v1' });
  const legacy = createConquest({ mode: 'local' }, legacyTree);
  let legacyDesign = createDesign('corvette', true);
  const beam = legacyDesign.slots.find(slot => slot.id === 'beam_1')!.component;
  if (beam?.kind !== 'beam') throw new Error('Invalid beam fixture');
  legacyDesign = installComponent(legacyDesign, 'beam_1', { ...beam, damage: 27.6 });
  legacy.session.production.lastOrderId = 1;
  legacy.session.ships.push({ id: 1, factionId: 'blue', systemId: 'sol', fuel: 3, design: legacyDesign });
  legacy.operations['1'] = createOperationalState(legacyDesign);

  const legacyBytes = encodeConquestSave(legacy);
  expect(JSON.parse(legacyBytes)).toMatchObject({ schemaVersion: 4, rulesVersion: 1,
    conquest: { researchTree: { version: 1 }, session: { ships: [{ design: { slots: expect.any(Array) } }] } } });
  expect(decodeConquestSave(legacyBytes)).toEqual(legacy);
  expect(decodeConquestSave(legacyBytes).session.ships[0].design.slots.find(slot => slot.id === 'beam_1')?.component)
    .toMatchObject({ kind: 'beam', damage: 27.6 });
  expect(() => decodeConquestSave(legacyBytes.replace('"rulesVersion":1', '"rulesVersion":2'))).toThrow();
});

it('removes captured production and invalidated groups while preserving surviving IDs', () => {
  const state = createConquest(), design = createDesign('fighter', true);
  state.session.production.lastOrderId = 5;
  const eden = state.session.galaxy.systems.find(system => system.id === 'eden')!;
  eden.ownerId = 'red'; eden.exploredBy = ['red'];
  state.session.ships = [
    { id: 1, factionId: 'blue', systemId: 'sol', fuel: 2, design, transit: { destinationId: 'eden', remainingTurns: 1 } },
    { id: 2, factionId: 'blue', systemId: 'sol', fuel: 2, design, transit: { destinationId: 'eden', remainingTurns: 1 } },
    { id: 3, factionId: 'red', systemId: 'eden', fuel: 2, design },
    { id: 4, factionId: 'red', systemId: 'eden', fuel: 2, design }
  ];
  state.operations = { '1': createOperationalState(design), '2': createOperationalState(design),
    '3': { hull: 1, ammunition: [] }, '4': { hull: 1, ammunition: [] } };
  state.session.fleets = { lastFleetId: 2, items: [
    { id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] },
    { id: 2, factionId: 'red', systemId: 'eden', shipIds: [3, 4] }
  ] };
  state.session.production.completed = [{ id: 5, factionId: 'red', systemId: 'eden', design }];
  const result = end(state);
  expect(result.session.galaxy.systems.find(system => system.id === 'eden')?.ownerId).toBe('blue');
  expect(result.session.production.completed).toEqual([]);
  expect(result.session.fleets.items).toEqual([{ id: 1, factionId: 'blue', systemId: 'eden', shipIds: [1, 2] }]);
  expect(result.session.ships.map(ship => ship.id)).toEqual([1, 2]);
  expect(Object.keys(result.operations)).toEqual(['1', '2']);
  expect(result.session.production.lastOrderId).toBe(5);
});

it('rolls back a mining overflow and does not expose unexpected exception details', () => {
  const state = diagnosticServiceState();
  state.session.treasuries.blue.minerals = 999999995;
  const before = structuredClone(state);
  const command = { kind: 'endTurn', factionId: 'blue', expectedTurn: 1 };
  expect(executeConquestCommand(state, command).ok).toBe(false);
  expect(state).toEqual(before);
  const hostile = Object.defineProperty({}, 'scenario', { get: () => { throw new Error('private diagnostic'); } });
  expect(executeConquestCommand(hostile, command)).toEqual({ ok: false, message: 'Недопустимые данные военной кампании' });
});

it('earns research, pays for a library service ship and mines after arrival without injected resources', () => {
  let state = createConquest();
  const command = (payload: Record<string, unknown>) => {
    const result = executeConquestCommand(state, { ...payload, factionId: 'blue', expectedTurn: state.session.turn });
    if (!result.ok) throw new Error(result.message);
    state = result.state;
  };
  command({ kind: 'research', technologyId: 'support' });
  state = end(end(end(end(state))));
  const design = buildConquestDesigns(state.research.blue, state.researchTree).find(item => item.hullId === 'corvette')!;
  design.slots.find(slot => slot.id === 'service_1')!.component = createComponentWithId('mining', 'paid-miner');
  design.slots.find(slot => slot.id === 'service_2')!.component = createComponentWithId('scanner', 'paid-scanner');
  const storage = new Map<string, string>();
  const library = new ShipDesignManager({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } });
  const snapshot = library.saveDesign(design), quote = getProductionQuote(snapshot);
  for (let attempt = 0; attempt < 100 && (state.session.treasuries.blue.credits < quote.cost.credits ||
    state.session.treasuries.blue.minerals < quote.cost.minerals); attempt++) state = end(end(state));
  const before = structuredClone(state.session.treasuries.blue);
  command({ kind: 'enqueueProduction', systemId: 'sol', design: library.load().designs[0] });
  expect(state.session.treasuries.blue).toEqual({ credits: before.credits - quote.cost.credits, minerals: before.minerals - quote.cost.minerals });
  storage.clear();
  for (let turn = 0; turn < quote.turns * 2; turn++) state = decodeConquestSave(encodeConquestSave(end(state)));
  command({ kind: 'deployProduction', systemId: 'sol', orderId: 1 });
  expect(state.session.ships[0].design).toEqual(snapshot);
  command({ kind: 'sendShip', shipId: 1, systemId: 'sol', destinationId: 'rift' });
  const minerals = state.session.treasuries.blue.minerals;
  expect(getConquestView(state, 'blue').income.minerals).toBe(13);
  command({ kind: 'endTurn' });
  expect(state.session.treasuries.blue.minerals).toBe(minerals + 13);
  expect(getConquestView(state, 'blue').galaxy.systems.find(system => system.id === 'dust')?.visibility).toBe('explored');
  expect(state.session.ships[0].fuel).toBe(2);
  expect(storage.size).toBe(0);
});