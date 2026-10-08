import { expect, it, vi } from 'vitest';
import { createConquest, getConquestOutcome, getConquestView, executeConquestCommand } from '../src/domain/conquest';
import { buildConquestDesigns, calculateConquestDesignScore, executeConquestAiTurn, planConquestAction } from '../src/domain/conquestAi';
import { calculateShipStats, createComponent, createDesign, installComponent, validateDesign, type ShipDesign } from '../src/domain/shipDesign';
import { createOperationalState } from '../src/domain/campaignOperations';
import { resolveConquestBattle } from '../src/domain/conquestBattle';
import type { CampaignShip } from '../src/domain/campaignShips';
import { getDefaultResearchTree, isCampaignDesignAvailable, researchTreeSchema } from '../src/domain/campaignResearch';
import { decodeConquestSave, encodeConquestSave } from '../src/utils/ConquestSaveManager';

function pairedDesignMean(first: ShipDesign, second: ShipDesign): number {
  const score = (winner: string | null, firstFaction: 'blue' | 'red') =>
    winner === null ? 0.5 : winner === firstFaction ? 1 : 0;
  let total = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const run = (firstFaction: 'blue' | 'red') => {
      const firstId = firstFaction === 'blue' ? 1 : 2;
      const secondFaction = firstFaction === 'blue' ? 'red' : 'blue';
      const secondId = secondFaction === 'blue' ? 1 : 2;
      const ships: CampaignShip[] = [
        { id: firstId, factionId: firstFaction, systemId: 'eden', design: first, fuel: 3 },
        { id: secondId, factionId: secondFaction, systemId: 'eden', design: second, fuel: 3 }
      ];
      const operations = Object.fromEntries(ships.map(ship => [String(ship.id), createOperationalState(ship.design)]));
      return resolveConquestBattle(ships, operations, seed).winner;
    };
    total += (score(run('blue'), 'blue') + score(run('red'), 'red')) / 2;
  }
  return total / 30;
}

it('constructs legal deterministic candidates without clocks or random factories', () => {
  const state = createConquest();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
  try {
    const designs = buildConquestDesigns(state.research.blue, state.researchTree);
    expect(designs.length).toBeGreaterThan(1);
    expect(designs.every(design => validateDesign(design, 'battle').length === 0)).toBe(true);
    expect(designs.every(design => isCampaignDesignAvailable(design, state.research.blue, state.researchTree))).toBe(true);
    expect(buildConquestDesigns(state.research.blue, state.researchTree)).toEqual(designs);
  } finally { clock.mockRestore(); }
});

it('preserves legacy AI component values for version1 trees', () => {
  const current = getDefaultResearchTree();
  if (current.version !== 2) throw new Error('Expected version2 default research tree');
  const { variantPolicy: _policy, ...legacyFields } = current;
  const legacyTree = researchTreeSchema.parse({ ...legacyFields, version: 1, id: 'legacy-ai-v1' });
  const design = buildConquestDesigns(createConquest({ mode: 'local' }, legacyTree).research.blue, legacyTree)
    .find(candidate => candidate.hullId === 'corvette')!;
  expect(design.slots.find(slot => slot.id === 'beam_1')?.component).toMatchObject({
    kind: 'beam', damage: 8, range: 300, fireRate: 1, accuracy: 0.85
  });
});

it('caps projectile output by ammo, reflects resource scarcity, defense and engagement range', () => {
  const base = createDesign('corvette', true);
  const projectile = createComponent('projectile');
  if (projectile.kind !== 'projectile') throw new Error('Invalid projectile fixture');
  const withTwentyRounds = installComponent(base, 'projectile_1', projectile);
  const withFortyRounds = installComponent(withTwentyRounds, 'projectile_1', { ...projectile, ammoCapacity: 40 });
  const treasury = { credits: 10000, minerals: 10000 };
  const standard = calculateConquestDesignScore(withTwentyRounds, treasury);
  const moreAmmo = calculateConquestDesignScore(withFortyRounds, treasury);
  const mineralScarce = calculateConquestDesignScore(withTwentyRounds, { credits: 10000, minerals: 100 });
  expect(moreAmmo.expectedDamage).toBeGreaterThan(standard.expectedDamage);
  expect(mineralScarce.resourcePressure).toBeGreaterThan(standard.resourcePressure);
  expect(mineralScarce.score).toBeLessThan(standard.score);

  const shielded = installComponent(base, 'shield_1', createComponent('shield'));
  const armored = installComponent(base, 'armor_1', createComponent('armor'));
  expect(calculateConquestDesignScore(shielded, treasury).effectiveDurability)
    .toBeGreaterThan(calculateConquestDesignScore(base, treasury).effectiveDurability);
  expect(calculateConquestDesignScore(armored, treasury).effectiveDurability)
    .toBeGreaterThan(calculateConquestDesignScore(base, treasury).effectiveDurability);

  const beam = base.slots.find(slot => slot.id === 'beam_1')!.component;
  if (beam?.kind !== 'beam') throw new Error('Invalid beam fixture');
  const longerRange = installComponent(base, 'beam_1', { ...beam, range: 900 });
  expect(calculateConquestDesignScore(longerRange, treasury).approachSeconds)
    .toBeLessThan(calculateConquestDesignScore(base, treasury).approachSeconds);
  let mixedRange = installComponent(longerRange, 'projectile_1', createComponent('projectile'));
  const engine = mixedRange.slots.find(slot => slot.id === 'engine_1')!.component;
  if (engine?.kind !== 'engine') throw new Error('Invalid engine fixture');
  mixedRange = installComponent(mixedRange, 'engine_1', { ...engine, powerGeneration: 1000 });
  const mixedStats = calculateShipStats(mixedRange);
  expect(calculateConquestDesignScore(mixedRange, treasury).approachSeconds)
    .toBeCloseTo((600 - 300) / (2 * mixedStats.speed));
});

it('ranks the twin-beam candidate above a single beam in a mirrored 30-seed Conquest series', () => {
  const state = createConquest();
  const candidates = buildConquestDesigns(state.research.blue, state.researchTree).filter(design => design.hullId === 'fighter');
  const singleBeam = candidates.find(design => design.slots.find(slot => slot.id === 'beam_2')?.component === null)!;
  const twinBeam = candidates.find(design => design.slots.find(slot => slot.id === 'beam_2')?.component?.kind === 'beam')!;
  const treasury = { credits: 10000, minerals: 10000 };

  expect(validateDesign(singleBeam, 'battle')).toEqual([]);
  expect(validateDesign(twinBeam, 'battle')).toEqual([]);
  expect(calculateConquestDesignScore(twinBeam, treasury).score)
    .toBeGreaterThan(calculateConquestDesignScore(singleBeam, treasury).score);
  expect(pairedDesignMean(twinBeam, singleBeam)).toBeGreaterThan(0.5);
});

it('does not change its plan when only hidden enemy resources and research differ', () => {
  const first = createConquest(), second = structuredClone(first);
  second.session.treasuries.red = { credits: 999, minerals: 888 };
  second.research.red.completed = ['support', 'ordnance', 'capital'];
  const firstView = getConquestView(first, 'blue'), secondView = getConquestView(second, 'blue');
  expect(firstView).toEqual(secondView);
  expect(planConquestAction(firstView)).toEqual(planConquestAction(secondView));
});
it('plans from own observation and preserves paid production through save/load', () => {
  let state = createConquest();
  const source = structuredClone(state);
  expect(planConquestAction(getConquestView(state, 'blue'))).toMatchObject({ kind: 'research', technologyId: 'support' });
  let produced = false, deployed = false, travelled = false, battles = false;
    for (let turn = 0; turn < 160 && getConquestOutcome(state).status === 'ongoing'; turn++) {
    const faction = state.session.turn % 2 ? 'blue' : 'red';
    const result = executeConquestAiTurn(state, faction, state.session.turn);
    if (!result.ok) throw new Error(`${state.session.turn}: ${result.message}`);
    expect(result.state.session.turn).toBe(state.session.turn + 1);
    expect(executeConquestAiTurn(decodeConquestSave(encodeConquestSave(state)), faction, state.session.turn)).toEqual(result);
    state = result.state;
    produced ||= state.session.production.lastOrderId > 0;
    deployed ||= state.session.ships.length > 0;
    travelled ||= state.session.ships.some(ship => ship.systemId !== (ship.factionId === 'blue' ? 'sol' : 'vega'));
    battles ||= state.battles.length > 0;
  }
  expect({ produced, deployed, travelled, battles }).toEqual({ produced: true, deployed: true, travelled: true, battles: true });
  expect(getConquestOutcome(state)).toMatchObject({ status: 'completed' });
  expect(source.session.production.lastOrderId).toBe(0);
});

it.each(['blue', 'red'] as const)('the real policy can win as %s against a passive opponent from a new start', winner => {
  let state = createConquest(winner === 'red' ? { mode: 'human-vs-ai', aiPolicy: 'conquest-v1' } : { mode: 'local' });
  for (let action = 0; action < 160 && getConquestOutcome(state).status === 'ongoing'; action++) {
    const faction = state.session.turn % 2 ? 'blue' : 'red';
    const result = faction === winner ? executeConquestAiTurn(state, faction, state.session.turn) :
      executeConquestCommand(state, { kind: 'endTurn', factionId: faction, expectedTurn: state.session.turn });
    if (!result.ok) throw new Error(result.message);
    state = result.state;
  }
  expect(state.session.production.lastOrderId).toBeGreaterThan(0);
  expect(getConquestOutcome(state)).toEqual({ status: 'completed', winner, reason: 'all-planets' });
});