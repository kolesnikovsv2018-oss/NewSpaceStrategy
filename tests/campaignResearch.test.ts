import { describe, expect, it } from 'vitest';
import { advanceResearch, createResearchState, getDefaultResearchTree, getResearchAccess,
  isCampaignDesignAvailable, isResearchStateValid, loadResearchTree, researchTreeSchema } from '../src/domain/campaignResearch';
import { createDesign } from '../src/domain/shipDesign';
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