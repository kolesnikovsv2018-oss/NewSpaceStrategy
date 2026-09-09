import { describe, expect, it } from 'vitest';
import { campaignCommandSchema, campaignStateSchema, createCampaignState, executeCampaignCommand,
  getCampaignView, getGalaxyDefinition, type CampaignCommand, type CampaignErrorCode,
  type CampaignFactionId, type CampaignState, type SystemId } from '../src/domain/campaign';

const command = (kind: CampaignCommand['kind'], systemId: SystemId, factionId: CampaignFactionId = 'blue'): CampaignCommand =>
  ({ kind, systemId, factionId });
function apply(state: CampaignState, input: CampaignCommand): CampaignState {
  const result = executeCampaignCommand(state, input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(campaignStateSchema.safeParse(result.state).success).toBe(true);
  return result.state;
}
function reject(state: CampaignState, input: unknown, code: CampaignErrorCode): void {
  const before = structuredClone(state);
  expect(executeCampaignCommand(state, input)).toMatchObject({ ok: false, code });
  expect(state).toEqual(before);
}
function reachNexus(): CampaignState {
  return apply(apply(createCampaignState(), command('explore', 'eden')), command('explore', 'nexus'));
}

describe('fixed campaign scenario', () => {
  it('has six distinct systems, two homes and a connected undirected graph', () => {
    const definition = getGalaxyDefinition();
    expect(definition.factions.map(faction => faction.id)).toEqual(['blue', 'red']);
    expect(new Set(definition.systems.map(system => system.id)).size).toBe(6);
    const reached = new Set<SystemId>(['sol']);
    for (let pass = 0; pass < definition.systems.length; pass++) {
      for (const [from, to] of definition.lanes) {
        expect(from).not.toBe(to);
        expect(definition.systems.some(system => system.id === from)).toBe(true);
        expect(definition.systems.some(system => system.id === to)).toBe(true);
        if (reached.has(from)) reached.add(to);
        if (reached.has(to)) reached.add(from);
      }
    }
    expect(reached.size).toBe(6);
    expect(new Set(definition.lanes.map(lane => [...lane].sort().join(':'))).size).toBe(definition.lanes.length);
  });

  it('starts each side in its own explored home, with four neutral systems', () => {
    const state = createCampaignState();
    expect(campaignStateSchema.parse(state)).toEqual(state);
    for (const faction of getGalaxyDefinition().factions) {
      expect(state.systems.find(system => system.id === faction.homeSystemId))
        .toEqual({ id: faction.homeSystemId, ownerId: faction.id, exploredBy: [faction.id] });
    }
    expect(state.systems.filter(system => system.ownerId === null)).toHaveLength(4);
  });

  it('does not share state or definitions across games or queries', () => {
    const expected = createCampaignState();
    const first = createCampaignState();
    first.systems[0].exploredBy.push('red');
    first.systems[0].ownerId = 'red';
    const definition = getGalaxyDefinition();
    definition.systems[0].habitable = false;
    definition.factions[0].homeSystemId = 'dust';
    definition.lanes[0][1] = 'vega';
    expect(createCampaignState()).toEqual(expected);
    expect(getGalaxyDefinition().systems[0].habitable).toBe(true);
    expect(apply(expected, command('explore', 'eden')).systems[1].exploredBy).toEqual(['blue']);
  });
});

describe('campaign commands', () => {
  it.each([['blue', 'eden'], ['red', 'nexus']] as const)('explores a neighbour for %s only', (factionId, systemId) => {
    const state = createCampaignState();
    const before = structuredClone(state);
    const input = command('explore', systemId, factionId);
    expect(campaignCommandSchema.parse(input)).toEqual(input);
    const next = apply(state, input);
    expect(state).toEqual(before);
    for (const system of next.systems) {
      expect(system).toEqual(system.id === systemId
        ? { id: systemId, ownerId: null, exploredBy: [factionId] }
        : state.systems.find(item => item.id === system.id));
    }
    expect(input).toEqual(command('explore', systemId, factionId));
  });

  it('accepts frozen input and produces fully detached nested state', () => {
    const state = createCampaignState();
    for (const system of state.systems) { Object.freeze(system.exploredBy); Object.freeze(system); }
    Object.freeze(state.systems); Object.freeze(state);
    const next = apply(state, Object.freeze(command('explore', 'eden')));
    next.systems[0].exploredBy.push('red');
    next.systems[0].ownerId = 'red';
    expect(state).toEqual(createCampaignState());
  });

  it('rejects repeated exploration without duplicating knowledge', () => {
    reject(createCampaignState(), command('explore', 'sol'), 'ALREADY_EXPLORED');
    reject(apply(createCampaignState(), command('explore', 'eden')), command('explore', 'eden'), 'ALREADY_EXPLORED');
  });

  it('rejects exploration not adjacent to this side’s knowledge', () => {
    reject(createCampaignState(), command('explore', 'nexus'), 'OUT_OF_REACH');
    reject(createCampaignState(), command('explore', 'eden', 'red'), 'OUT_OF_REACH');
  });

  it('can explore via unowned and uninhabitable systems without colonizing them', () => {
    const next = apply(apply(createCampaignState(), command('explore', 'rift')), command('explore', 'dust'));
    expect(next.systems.find(system => system.id === 'dust')).toEqual({ id: 'dust', ownerId: null, exploredBy: ['blue'] });
  });

  it.each(['eden', 'rift', 'vega'] as const)('does not disclose hidden properties when colonizing %s', systemId => {
    reject(createCampaignState(), command('colonize', systemId), 'NOT_EXPLORED');
  });

  it('colonizes only the explored target and preserves all other content', () => {
    const state = apply(createCampaignState(), command('explore', 'eden'));
    const before = structuredClone(state);
    const next = apply(state, command('colonize', 'eden'));
    expect(state).toEqual(before);
    expect(next.systems).toEqual(state.systems.map(system => system.id === 'eden' ? { ...system, ownerId: 'blue' } : system));
    reject(next, command('colonize', 'eden'), 'OCCUPIED');
  });

  it('requires a neighbouring colony, not just an explored path', () => {
    const state = reachNexus();
    reject(state, command('colonize', 'nexus'), 'OUT_OF_REACH');
    const next = apply(apply(state, command('colonize', 'eden')), command('colonize', 'nexus'));
    expect(next.systems.find(system => system.id === 'nexus')?.ownerId).toBe('blue');
  });

  it('rejects barren systems even next to a home colony', () => {
    reject(apply(createCampaignState(), command('explore', 'rift')), command('colonize', 'rift'), 'UNINHABITABLE');
  });

  it('does not capture enemy colonies; both sides may explore a system independently', () => {
    let state = reachNexus();
    state = apply(state, command('explore', 'nexus', 'red'));
    state = apply(state, command('colonize', 'nexus', 'red'));
    reject(state, command('colonize', 'nexus'), 'OCCUPIED');
    expect(state.systems.find(system => system.id === 'nexus')?.exploredBy).toEqual(['blue', 'red']);
    state = apply(state, command('explore', 'vega'));
    reject(state, command('colonize', 'vega'), 'OCCUPIED');
  });

  it('replays the same commands deterministically without clocks or RNG', () => {
    const inputs = [command('explore', 'eden'), command('colonize', 'eden'), command('explore', 'nexus'), command('colonize', 'nexus')];
    const run = () => inputs.reduce(apply, createCampaignState());
    expect(run()).toEqual(run());
  });

  it.each([null, undefined, [], {}, 'explore', 1,
    { kind: 'attack', factionId: 'blue', systemId: 'eden' },
    { kind: 'explore', factionId: 'green', systemId: 'eden' },
    { kind: 'explore', factionId: 'blue', systemId: 'unknown' },
    { kind: 'explore', factionId: 'blue', systemId: ' eden ' },
    { kind: 'explore', factionId: 'blue', systemId: 'eden', free: true },
    { kind: 'colonize', systemId: 'eden' }
  ])('rejects malformed command %j atomically', input => {
    reject(createCampaignState(), input, 'INVALID_COMMAND');
  });
});

describe('campaign invariants and faction view', () => {
  it.each([
    ['missing system', (state: CampaignState) => { state.systems.pop(); }],
    ['duplicate system', (state: CampaignState) => { state.systems[1].id = 'sol'; }],
    ['duplicate knowledge', (state: CampaignState) => { state.systems[0].exploredBy.push('blue'); }],
    ['owner without exploration', (state: CampaignState) => { state.systems[0].exploredBy = []; }],
    ['barren colony', (state: CampaignState) => { state.systems[2].ownerId = 'blue'; state.systems[2].exploredBy = ['blue']; }]
  ] as const)('rejects invalid state: %s', (_label, mutate) => {
    const state = createCampaignState(); mutate(state);
    reject(state, command('explore', 'eden'), 'INVALID_STATE');
    expect(() => getCampaignView(state, 'blue')).toThrow();
  });

  it.each([null, undefined, {}, { systems: [] }, { ...createCampaignState(), extra: true },
    { systems: createCampaignState().systems.map(system => ({ ...system, ownerId: 'green' })) }
  ])('rejects malformed state %j', state => {
    expect(executeCampaignCommand(state, command('explore', 'eden'))).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it.each(['blue', 'red'] as const)('shows only %s knowledge, with no hidden owner/habitability fields', factionId => {
    const state = createCampaignState();
    const view = getCampaignView(state, factionId);
    expect(view.systems).toHaveLength(6);
    expect(view.systems.filter(system => system.visibility === 'explored')).toHaveLength(1);
    for (const system of view.systems) {
      expect(system).not.toHaveProperty('exploredBy');
      if (system.visibility === 'unknown') {
        expect(Object.keys(system).sort()).toEqual(['id', 'name', 'visibility', 'x', 'y']);
      } else {
        expect(system.ownerId).toBe(factionId);
        expect(system.habitable).toBe(true);
      }
    }
  });

  it('keeps the other side’s view unchanged after private exploration and colonization', () => {
    const state = createCampaignState();
    const next = apply(apply(state, command('explore', 'eden')), command('colonize', 'eden'));
    expect(getCampaignView(next, 'red')).toEqual(getCampaignView(state, 'red'));
    expect(getCampaignView(next, 'blue').systems.find(system => system.id === 'eden'))
      .toMatchObject({ visibility: 'explored', ownerId: 'blue', habitable: true });
  });

  it('exposes current ownership of previously explored systems, not stale intelligence', () => {
    const state = reachNexus();
    const next = apply(apply(state, command('explore', 'nexus', 'red')), command('colonize', 'nexus', 'red'));
    expect(getCampaignView(next, 'blue').systems.find(system => system.id === 'nexus'))
      .toMatchObject({ visibility: 'explored', ownerId: 'red' });
  });

  it('returns detached views and rejects an invalid faction at runtime', () => {
    const state = createCampaignState();
    const expected = getCampaignView(state, 'blue');
    const view = getCampaignView(state, 'blue');
    view.systems[0].name = 'changed'; view.lanes[0][1] = 'vega'; view.systems.pop();
    expect(getCampaignView(state, 'blue')).toEqual(expected);
    expect(() => getCampaignView(state, 'green' as CampaignFactionId)).toThrow();
  });
});
