import { describe, expect, it } from 'vitest';
import { calculateResearchTurn, createResearchState, getDefaultResearchTree, getResearchAccess,
  isCampaignComponentVariantAvailable, isCampaignDesignAvailable, isResearchStateValid, loadResearchTree,
  parseProfiledResearchTree, researchTreeSchema, researchStateSchema, getResearchProgress, type ResearchState } from '../src/domain/campaignResearch';
import { componentSchema, createDesign, createComponentWithId, installComponent } from '../src/domain/shipDesign';
import { createCombatDesign, isCombatPresetDesign } from '../src/domain/combatPresets';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { parseResearchTreeYaml } from '../src/utils/ResearchTreeYaml';
import { stringify } from 'yaml';
import { readFileSync } from 'node:fs';

describe('campaign research points', () => {
  it('uses one strict version for default, YAML, JSON and source', async () => {
    const tree = getDefaultResearchTree();
    expect(parseResearchTreeYaml(stringify(tree))).toEqual(tree);
    expect(parseResearchTreeYaml(readFileSync(new URL('../docs/research-default.yaml', import.meta.url), 'utf8'))).toEqual(tree);
    expect(parseResearchTreeYaml(JSON.stringify(tree))).toEqual(tree);
    expect(await loadResearchTree({ load: async () => tree })).toEqual(tree);
    for (const version of [1, 2, 3, 4, 5, 7]) {
      const old = { ...tree, version };
      expect(researchTreeSchema.safeParse(old).success).toBe(false);
      expect(() => parseResearchTreeYaml(JSON.stringify(old))).toThrow();
      await expect(loadResearchTree({ load: async () => old })).rejects.toThrow();
    }
    expect(() => parseResearchTreeYaml('id: first\nid: second')).toThrow();
    expect(() => parseResearchTreeYaml('id: &loop [*loop]')).toThrow();
    expect(() => parseResearchTreeYaml('!custom {}')).toThrow();
    expect(parseResearchTreeYaml(JSON.stringify(tree) + ' '.repeat(256000 - new TextEncoder().encode(JSON.stringify(tree)).length))).toEqual(tree);
    expect(() => parseResearchTreeYaml(' '.repeat(256001))).toThrow();
    expect(() => parseResearchTreeYaml('я'.repeat(128001))).toThrow();
  });

  it.each(['magnitude', 'ratioStep', 'ammo', 'rechargeDelay'] as const)('rejects narrowing %s in every current boundary', async field => {
    const tree = getDefaultResearchTree();
    tree.variantPolicy.tiers[2][field] = tree.variantPolicy.tiers[1][field] / 2;
    expect(researchTreeSchema.safeParse(tree).success).toBe(false);
    expect(() => parseProfiledResearchTree(tree)).toThrow();
    await expect(loadResearchTree({ load: async () => tree })).rejects.toThrow();
  });

  it.each(['cycle', 'missing', 'duplicate', 'unknown-field', 'no-engine', 'newline-id', 'unknown-effect', 'empty-effect', 'old-turns', 'duplicate-effect'])(
    'rejects malformed tree: %s', fault => {
      const tree = getDefaultResearchTree();
      if (fault === 'cycle') tree.nodes[0].prerequisites = ['capital'];
      if (fault === 'missing') tree.nodes[0].prerequisites = ['absent'];
      if (fault === 'duplicate') tree.nodes.push(structuredClone(tree.nodes[0]));
      if (fault === 'unknown-field') Object.assign(tree, { bad: true });
      if (fault === 'no-engine') tree.initial.components = ['beam'];
      if (fault === 'newline-id') tree.nodes[0].id += '\n';
      if (fault === 'unknown-effect') Object.assign(tree.nodes[0].effects[0], { kind: 'science-growth' });
      if (fault === 'empty-effect') tree.nodes[0].effects = [];
      if (fault === 'old-turns') Object.assign(tree.nodes[0], { credits: 10, turns: 2 });
      if (fault === 'duplicate-effect') tree.nodes[0].effects.push(structuredClone(tree.nodes[0].effects[0]));
      expect(researchTreeSchema.safeParse(tree).success).toBe(false);
    });

  it('keeps real root alternatives including adaptation and permits repeated capabilities across alternative nodes', () => {
    const tree = getDefaultResearchTree();
    expect(tree.nodes.filter(node => !node.prerequisites.length).map(node => node.id)).toEqual(
      ['engineering', 'applied', 'support', 'biology', 'cultural-practices', 'toxic-adaptation']);
    tree.nodes.push({ id: 'alternate-frigate', name: 'Другой путь', prerequisites: [], researchCost: 5000,
      effects: [{ kind: 'hull-unlock', hullId: 'frigate' }] });
    expect(researchTreeSchema.safeParse(tree).success).toBe(true);
    tree.nodes[0].name = 'changed';
    expect(getDefaultResearchTree().nodes[0].name).not.toBe('changed');
  });

  it.each<ResearchState>([
    { completed: ['capital'], activeId: null, progress: {} },
    { completed: ['support', 'support'], activeId: null, progress: {} },
    { completed: ['unknown'], activeId: null, progress: {} },
    { completed: [], activeId: 'ordnance', progress: { ordnance: 0 } },
    { completed: [], activeId: 'engineering', progress: { engineering: 2000 } },
    { completed: ['support'], activeId: 'support', progress: { support: 0 } },
    { completed: [], activeId: 'engineering', progress: {} },
    { completed: [], activeId: null, progress: { absent: 1 } }
  ])('rejects impossible persisted progress %j', state => {
    expect(isResearchStateValid(state, getDefaultResearchTree())).toBe(false);
    expect(() => calculateResearchTurn(state, getDefaultResearchTree(), 0, 1, 100, true)).toThrow();
  });

  it('rejects malformed numbers and obsolete state fields', () => {
    expect(getResearchProgress(createResearchState(), 'constructor')).toBe(0);
    expect(researchStateSchema.safeParse({ completed: [], active: null }).success).toBe(false);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => calculateResearchTurn(createResearchState(), getDefaultResearchTree(), value, 0, 10, true)).toThrow();
      expect(() => calculateResearchTurn(createResearchState(), getDefaultResearchTree(), 0, value, 10, true)).toThrow();
    }
    expect(() => calculateResearchTurn(createResearchState(), getDefaultResearchTree(), 0, 1, 10, false)).toThrow();
  });

  it.each([1999, 2000, 2001, 1_000_000])('spends exact science with a conservation oracle at output %s', produced => {
    const state = { ...createResearchState(), activeId: 'engineering', progress: { engineering: 0 } };
    const original = structuredClone(state);
    const result = calculateResearchTurn(state, getDefaultResearchTree(), 0, produced, 100, true);
    const spent = Math.min(2000, produced), remainder = produced - spent, reserve = Math.min(100, remainder);
    expect(result.receipt).toMatchObject({ spent, reserveAfter: reserve, overflow: remainder - reserve,
      progressAfter: spent, completedId: produced >= 2000 ? 'engineering' : null });
    expect(BigInt(result.receipt.reserveBefore) + BigInt(produced)).toBe(
      BigInt(spent) + BigInt(result.receipt.overflow) + BigInt(reserve));
    expect(state).toEqual(original);
    expect(result.state.completed).toHaveLength(produced >= 2000 ? 1 : 0);
  });

  it('spends before capping new output and retains old over-cap without unsafe addition', () => {
    const state = { ...createResearchState(), activeId: 'engineering', progress: { engineering: 0 } };
    const result = calculateResearchTurn(state, getDefaultResearchTree(), 100, 2000, 100, true);
    expect(result.receipt).toMatchObject({ spent: 2000, accepted: 100, reserveAfter: 100, overflow: 0 });
    const huge = calculateResearchTurn(state, getDefaultResearchTree(), Number.MAX_SAFE_INTEGER, 5000, 100, true);
    expect(huge.receipt.reserveAfter).toBe(Number.MAX_SAFE_INTEGER - 2000);
    expect(huge.receipt.overflow).toBe(5000);
    expect(BigInt(huge.receipt.reserveBefore) + 5000n).toBe(
      BigInt(huge.receipt.reserveAfter) + BigInt(huge.receipt.spent) + BigInt(huge.receipt.overflow));
  });

  it('uses stored science at zero output, pauses without colonies and never cascades', () => {
    const tree = getDefaultResearchTree(), state = { ...createResearchState(), activeId: 'engineering', progress: { engineering: 1 } };
    const paused = calculateResearchTurn(state, tree, 10000, 0, 0, false);
    expect(paused.state).toEqual(state);
    expect(paused.timing).toEqual({ status: 'paused', reason: 'no-colonies' });
    expect(paused.receipt).toMatchObject({ spent: 0, reserveAfter: 10000 });
    const spent = calculateResearchTurn(state, tree, 10000, 0, 50000, true);
    expect(spent.state).toEqual({ completed: ['engineering'], activeId: null, progress: {} });
    expect(spent.receipt).toMatchObject({ spent: 1999, reserveAfter: 8001 });
    expect(spent.timing).toEqual({ status: 'completes', remainingOwnTurns: 1 });
    const idle = calculateResearchTurn(spent.state, tree, 8001, 5000, 50000, true);
    expect(idle.state.completed).toEqual(['engineering']);
    expect(idle.receipt.spent).toBe(0);
    expect(calculateResearchTurn(state, tree, 0, 0, 100, true).timing).toEqual({ status: 'paused', reason: 'no-science' });
    expect(calculateResearchTurn(state, tree, 500, 500, 1000, true).timing).toEqual({ status: 'progressing', remainingOwnTurns: 3 });
  });

  it('checks hull and every family before preset exemptions', () => {
    const tree = getDefaultResearchTree(), state = createResearchState();
    expect(isCampaignDesignAvailable(createCombatDesign('fighter'), state, tree)).toBe(true);
    expect(isCampaignDesignAvailable(createCombatDesign('frigate'), state, tree)).toBe(false);
    expect(isCampaignDesignAvailable(createCivilianDesign('miner'), state, tree)).toBe(false);
    state.completed.push('support');
    expect(isCampaignDesignAvailable(createCombatDesign('frigate'), state, tree)).toBe(true);
    expect(isCampaignDesignAvailable(createCivilianDesign('miner'), state, tree)).toBe(false);
    state.completed.push('applied');
    expect(isCampaignDesignAvailable(createCivilianDesign('miner'), state, tree)).toBe(true);
    expect(getResearchAccess(state, tree).components).toContain('repair');
  });

  it('keeps exact preset exemptions but never grants them to edited numeric variants', () => {
    const tree = getDefaultResearchTree(), state = { ...createResearchState(), completed: tree.nodes.map(node => node.id) };
    const current = createCombatDesign('dreadnought'), historical = createCombatDesign('dreadnought');
    for (const slot of historical.slots) {
      if (slot.component?.kind === 'beam') slot.component = { ...slot.component, accuracy: 0.85 };
      if (slot.component?.kind === 'projectile') slot.component = { ...slot.component, accuracy: 0.8 };
    }
    expect(isCombatPresetDesign(current)).toBe(true);
    expect(isCampaignDesignAvailable(current, state, tree)).toBe(true);
    expect(isCampaignDesignAvailable(historical, state, tree)).toBe(true);
    const beam = current.slots.find(slot => slot.id === 'beam_1')!.component;
    if (beam?.kind !== 'beam') throw new Error('Invalid beam fixture');
    const changed = installComponent(current, 'beam_1', { ...beam, accuracy: 0.99 });
    expect(isCombatPresetDesign(changed)).toBe(false);
    expect(isCampaignDesignAvailable(changed, state, tree)).toBe(false);
    const base = createDesign('corvette', true), baseBeam = base.slots.find(slot => slot.id === 'beam_1')!.component;
    if (baseBeam?.kind !== 'beam') throw new Error('Invalid beam fixture');
    const custom = installComponent(base, 'beam_1', { ...baseBeam, damage: 27.6 });
    expect(isCampaignDesignAvailable(custom, createResearchState(), tree)).toBe(false);
    expect(isCampaignDesignAvailable(custom, { ...createResearchState(), completed: ['engineering'] }, tree)).toBe(true);
  });

  it('enforces every declared numeric field against current campaign bands', () => {
    const tree = getDefaultResearchTree(), state = { ...createResearchState(), completed: tree.nodes.map(node => node.id) };
    const fields: { kind: Parameters<typeof createComponentWithId>[0]; key: string; mode: 'magnitude' | 'ratio' | 'ammo' | 'delay' }[] = [
      ...(['damage', 'range', 'fireRate'].map(key => ({ kind: 'beam' as const, key, mode: 'magnitude' as const }))),
      { kind: 'beam', key: 'accuracy', mode: 'ratio' },
      ...(['damage', 'range', 'fireRate'].map(key => ({ kind: 'projectile' as const, key, mode: 'magnitude' as const }))),
      { kind: 'projectile', key: 'accuracy', mode: 'ratio' }, { kind: 'projectile', key: 'ammoCapacity', mode: 'ammo' },
      ...(['thrust', 'maxSpeed', 'powerGeneration'].map(key => ({ kind: 'engine' as const, key, mode: 'magnitude' as const }))),
      { kind: 'engine', key: 'maneuverability', mode: 'ratio' },
      { kind: 'shield', key: 'capacity', mode: 'magnitude' }, { kind: 'shield', key: 'rechargeRate', mode: 'magnitude' },
      { kind: 'shield', key: 'rechargeDelay', mode: 'delay' }, { kind: 'shield', key: 'beamResistance', mode: 'ratio' },
      { kind: 'armor', key: 'armorPoints', mode: 'magnitude' }, { kind: 'armor', key: 'beamResistance', mode: 'ratio' },
      { kind: 'armor', key: 'projectileResistance', mode: 'ratio' },
      { kind: 'mining', key: 'miningSpeed', mode: 'magnitude' }, { kind: 'mining', key: 'efficiency', mode: 'ratio' },
      { kind: 'repair', key: 'repairRate', mode: 'magnitude' },
      { kind: 'scanner', key: 'range', mode: 'magnitude' }, { kind: 'scanner', key: 'accuracy', mode: 'ratio' },
      { kind: 'cargoExpansion', key: 'bonusCapacity', mode: 'magnitude' }
    ];
    const tier = tree.variantPolicy.tiers[3];
    for (const field of fields) {
      const component = createComponentWithId(field.kind, `tier-${field.kind}`);
      expect(isCampaignComponentVariantAvailable(component, state, tree), `${field.kind}.${field.key} baseline`).toBe(true);
      const entry = Object.entries(component).find(([key]) => key === field.key);
      if (!entry || typeof entry[1] !== 'number') throw new Error('Missing numeric field');
      const baseline = entry[1];
      const outside = field.mode === 'magnitude' ? baseline * (1 + tier.magnitude) + 0.001 :
        field.mode === 'ratio' ? (baseline + tier.ratioStep + 0.001 <= 1 ? baseline + tier.ratioStep + 0.001 : baseline - tier.ratioStep - 0.001) :
        field.mode === 'ammo' ? Math.ceil(20 * (1 + tier.ammo)) + 1 : baseline + tier.rechargeDelay + 0.01;
      expect(isCampaignComponentVariantAvailable(componentSchema.parse({ ...component, [field.key]: outside }), state, tree)).toBe(false);
    }
  });

  it('detaches source data and propagates source errors without fallback', async () => {
    const tree = getDefaultResearchTree(), loaded = await loadResearchTree({ load: async () => tree });
    loaded.nodes[0].researchCost = 9;
    expect(tree.nodes[0].researchCost).toBe(2000);
    await expect(loadResearchTree({ load: async () => ({}) })).rejects.toThrow();
    await expect(loadResearchTree({ load: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
  });
});
