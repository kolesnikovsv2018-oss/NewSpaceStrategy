import { describe, expect, it } from 'vitest';
import { advanceResearch, createResearchState, getDefaultResearchTree, getResearchAccess,
  isCampaignComponentVariantAvailable, isCampaignDesignAvailable, isResearchStateValid, loadResearchTree,
  parseProfiledResearchTree, researchTreeSchema } from '../src/domain/campaignResearch';
import { componentSchema, createDesign, createComponentWithId, installComponent } from '../src/domain/shipDesign';
import { createCombatDesign, isCombatPresetDesign } from '../src/domain/combatPresets';
import { createCivilianDesign } from '../src/domain/civilianPresets';
import { parseResearchTreeYaml } from '../src/utils/ResearchTreeYaml';
import { stringify } from 'yaml';
import { readFileSync } from 'node:fs';

describe('campaign research', () => {
  it('imports YAML and JSON through the same strict tree boundary', () => {
    const tree = getDefaultResearchTree();
    expect(parseResearchTreeYaml(stringify(tree))).toEqual(tree);
    expect(parseResearchTreeYaml(readFileSync(new URL('../docs/research-default.yaml', import.meta.url), 'utf8'))).toEqual(tree);
    expect(parseResearchTreeYaml(JSON.stringify(tree))).toEqual(tree);
    expect(() => parseResearchTreeYaml('id: first\nid: second')).toThrow();
    expect(() => parseResearchTreeYaml('id: &loop [*loop]')).toThrow();
    expect(() => parseResearchTreeYaml(' '.repeat(256001))).toThrow();
  });
  it('requires profiled v2 for new YAML/source imports but keeps v1 parseable for legacy saves', async () => {
    const current = getDefaultResearchTree();
    if (current.version !== 2) throw new Error('Expected profiled default tree');
    const { variantPolicy: _policy, ...fields } = current;
    const legacy = { ...fields, version: 1 as const, id: 'legacy-tree' };
    expect(researchTreeSchema.parse(legacy).version).toBe(1);
    expect(() => parseResearchTreeYaml(JSON.stringify(legacy))).toThrow('профилями вариантов');
    await expect(loadResearchTree({ load: async () => legacy })).rejects.toThrow('профилями вариантов');
  });
  it.each(['magnitude', 'ratioStep', 'ammo', 'rechargeDelay'] as const)(
    'rejects narrowing the %s profile on new imports without rejecting saved snapshots', async field => {
      const tree = getDefaultResearchTree();
      if (tree.version !== 2) throw new Error('Expected profiled default tree');
      const narrowed = structuredClone(tree);
      narrowed.variantPolicy.tiers[2][field] = narrowed.variantPolicy.tiers[1][field] / 2;

      expect(researchTreeSchema.safeParse(narrowed).success).toBe(true);
      expect(() => parseProfiledResearchTree(narrowed)).toThrow('не могут сужаться');
      expect(() => parseResearchTreeYaml(JSON.stringify(narrowed))).toThrow('не могут сужаться');
      await expect(loadResearchTree({ load: async () => narrowed })).rejects.toThrow('не могут сужаться');
    });
  it('provides independent complete default trees', () => {
    const tree = getDefaultResearchTree();
    tree.nodes[0].name = 'changed';
    expect(getDefaultResearchTree().nodes[0].name).not.toBe('changed');
    expect(researchTreeSchema.safeParse(getDefaultResearchTree()).success).toBe(true);
  });
  it.each(['cycle', 'missing', 'duplicate', 'unlock', 'unknown-field', 'no-engine', 'newline-id'])('rejects malformed external tree: %s', fault => {
    const tree = getDefaultResearchTree();
    if (fault === 'cycle') tree.nodes[0].prerequisites = ['capital'];
    if (fault === 'missing') tree.nodes[0].prerequisites = ['absent'];
    if (fault === 'duplicate') tree.nodes.push(structuredClone(tree.nodes[0]));
    if (fault === 'unlock') tree.nodes[0].unlocks.hulls.push('fighter');
    if (fault === 'unknown-field') Object.assign(tree, { bad: true });
    if (fault === 'no-engine') tree.initial.components = ['beam'];
    if (fault === 'newline-id') tree.nodes[0].id += '\n';
    expect(researchTreeSchema.safeParse(tree).success).toBe(false);
  });
  it('advances exactly on the threshold without mutating the source', () => {
    const tree = getDefaultResearchTree();
    const state = { completed: [], active: { id: 'support', progress: 0 } };
    const once = advanceResearch(state, tree);
    expect(once.active?.progress).toBe(1);
    const twice = advanceResearch(once, tree);
    expect(twice).toEqual({ completed: ['support'], active: null });
    expect(advanceResearch(twice, tree)).toEqual(twice);
    expect(state.active.progress).toBe(0);
  });
  it.each([
    { completed: ['capital'], active: null },
    { completed: ['support', 'support'], active: null },
    { completed: ['unknown'], active: null },
    { completed: [], active: { id: 'ordnance', progress: 0 } },
    { completed: [], active: { id: 'support', progress: 2 } },
    { completed: ['support'], active: { id: 'support', progress: 0 } }
  ])('rejects impossible persisted progress %j', state => {
    expect(isResearchStateValid(state, getDefaultResearchTree())).toBe(false);
    expect(() => advanceResearch(state, getDefaultResearchTree())).toThrow();
  });
  it('checks real project eligibility independently of the library', () => {
    const tree = getDefaultResearchTree(), state = createResearchState();
    const fighter = createDesign('fighter', true), frigate = createDesign('frigate', true);
    expect(isCampaignDesignAvailable(fighter, state, tree)).toBe(true);
    expect(isCampaignDesignAvailable(frigate, state, tree)).toBe(false);
    state.completed.push('support');
    expect(isCampaignDesignAvailable(frigate, state, tree)).toBe(true);
    expect(getResearchAccess(state, tree).components).toContain('repair');
  });
  it('requires component-family unlocks before preset exemptions in v2 and legacy trees', () => {
    const profiled = getDefaultResearchTree();
    if (profiled.version !== 2) throw new Error('Expected profiled default tree');
    profiled.initial.hulls.push('frigate');
    profiled.nodes[0].unlocks.hulls = [];
    const { variantPolicy: _policy, ...legacyFields } = profiled;
    const legacy = researchTreeSchema.parse({ ...legacyFields, version: 1, id: 'legacy-early-frigate' });
    const frigate = createCombatDesign('frigate');
    const miner = createCivilianDesign('miner');

    for (const tree of [profiled, legacy]) {
      const state = createResearchState();
      expect(isCampaignDesignAvailable(frigate, state, tree)).toBe(false);
      expect(isCampaignDesignAvailable(miner, state, tree)).toBe(false);
      state.completed.push('support');
      expect(isCampaignDesignAvailable(frigate, state, tree)).toBe(true);
      expect(isCampaignDesignAvailable(miner, state, tree)).toBe(true);
    }
  });
  it('applies versioned numeric tiers to custom values while preserving stock blueprints', () => {
    const tree = getDefaultResearchTree(), state = createResearchState();
    const currentDreadnought = createCombatDesign('dreadnought');
    const grandfatheredDreadnought = createCombatDesign('dreadnought');
    for (const slot of grandfatheredDreadnought.slots) {
      if (slot.id === 'beam_1' || slot.id === 'beam_2') {
        const component = slot.component;
        if (component?.kind !== 'beam') throw new Error('Invalid legacy beam fixture');
        slot.component = { ...component, accuracy: 0.85 };
      }
      if (slot.id === 'projectile_1') {
        const component = slot.component;
        if (component?.kind !== 'projectile') throw new Error('Invalid legacy projectile fixture');
        slot.component = { ...component, accuracy: 0.8 };
      }
    }
    const capitalState = { completed: ['support', 'ordnance', 'capital'], active: null };
    const changedDreadnought = structuredClone(currentDreadnought);
    const changedBeam = changedDreadnought.slots.find(slot => slot.id === 'beam_1')!.component;
    if (changedBeam?.kind !== 'beam') throw new Error('Invalid current beam fixture');
    changedDreadnought.slots.find(slot => slot.id === 'beam_1')!.component = { ...changedBeam, accuracy: 0.99 };
    const factoryDesign = createDesign('corvette', true);
    const factoryBeam = factoryDesign.slots.find(slot => slot.id === 'beam_1')!.component;
    if (factoryBeam?.kind !== 'beam') throw new Error('Invalid beam fixture');
    const custom = installComponent(factoryDesign, 'beam_1', { ...factoryBeam, damage: 27.6 });

    expect(tree.version).toBe(2);
    expect(isCampaignDesignAvailable(createCombatDesign('fighter'), state, tree)).toBe(true);
    expect(isCampaignDesignAvailable(createCivilianDesign('scout'), state, tree)).toBe(true);
    expect(isCombatPresetDesign(currentDreadnought)).toBe(true);
    expect(isCampaignDesignAvailable(grandfatheredDreadnought, capitalState, tree)).toBe(true);
    expect(isCampaignDesignAvailable(currentDreadnought, capitalState, tree)).toBe(true);
    expect(isCombatPresetDesign(changedDreadnought)).toBe(false);
    expect(isCampaignDesignAvailable(changedDreadnought, capitalState, tree)).toBe(false);
    expect(isCampaignDesignAvailable(custom, state, tree)).toBe(false);
    state.completed.push('support');
    expect(isCampaignDesignAvailable(custom, state, tree)).toBe(true);
    expect(isCampaignDesignAvailable(createDesign('frigate', true), state, tree)).toBe(true);
  });
  it('enforces every declared numeric field against the current campaign tier', () => {
    const tree = getDefaultResearchTree();
    if (tree.version !== 2) throw new Error('Expected profiled default tree');
    const state = { completed: ['support', 'ordnance', 'capital'], active: null };
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
      const values = component as unknown as Record<string, number>;
      const baseline = values[field.key];
      let outside: number;
      if (field.mode === 'magnitude') outside = baseline * (1 + tier.magnitude) + 0.001;
      else if (field.mode === 'ratio') outside = baseline + tier.ratioStep + 0.001 <= 1
        ? baseline + tier.ratioStep + 0.001 : baseline - tier.ratioStep - 0.001;
      else if (field.mode === 'ammo') outside = Math.ceil(20 * (1 + tier.ammo)) + 1;
      else outside = baseline + tier.rechargeDelay + 0.01;
      const invalid = componentSchema.parse({ ...component, [field.key]: outside });
      expect(isCampaignComponentVariantAvailable(invalid, state, tree), `${field.kind}.${field.key} upper/lower cap`).toBe(false);
    }
  });
  it('keeps version1 research trees grandfathered without numeric caps', () => {
    const profiled = getDefaultResearchTree();
    if (profiled.version !== 2) throw new Error('Expected profiled default tree');
    const { variantPolicy: _variantPolicy, ...legacyFields } = profiled;
    const legacyTree = researchTreeSchema.parse({ ...legacyFields, version: 1, id: 'legacy-tree-v1' });
    const design = createDesign('corvette', true);
    const beam = design.slots.find(slot => slot.id === 'beam_1')!.component;
    if (beam?.kind !== 'beam') throw new Error('Invalid beam fixture');
    const oldCustom = installComponent(design, 'beam_1', { ...beam, damage: 27.6 });
    expect(isCampaignDesignAvailable(oldCustom, createResearchState(), legacyTree)).toBe(true);
  });
  it('loads and detaches a database/YAML adapter result, rejecting failures without fallback', async () => {
    const tree = getDefaultResearchTree();
    const loaded = await loadResearchTree({ load: async () => tree });
    expect(loaded).toEqual(tree);
    loaded.nodes[0].turns = 9;
    expect(tree.nodes[0].turns).toBe(2);
    await expect(loadResearchTree({ load: async () => ({}) })).rejects.toThrow();
    await expect(loadResearchTree({ load: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
  });
});