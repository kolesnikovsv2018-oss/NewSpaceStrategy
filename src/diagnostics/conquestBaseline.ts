import { z } from 'zod';
import { createConquest, conquestSchema, executeConquestAction, getConquestOutcome, getConquestView,
  type Conquest, type ConquestCommand, type ConquestErrorCode } from '../domain/conquest';
import { buildConquestDesigns, planConquestAction } from '../domain/conquestAi';
import { generateGalaxy } from '../domain/galaxyGenerator';
import { GALAXY_GENERATOR_VERSION, GALAXY_PROFILE_ID, validateGalaxyMap, type GalaxyMap } from '../domain/galaxyMap';
import { getGalaxyDefinition, type CampaignFactionId } from '../domain/campaign';
import { createOperationalState } from '../domain/campaignOperations';
import { getProductionQuote } from '../domain/production';
import { decodeConquestSave, encodeConquestSave } from '../utils/ConquestSaveManager';

export const BASELINE_VERSION = 2;
export const BASELINE_SEEDS = [
  { mapSeed: 41, campaignSeed: 101 },
  { mapSeed: 12345, campaignSeed: 67890 },
  { mapSeed: 98765, campaignSeed: 43210 }
] as const;
const scheduleSchema = z.enum(['current-ai', 'research-first', 'production-first']);
const inputSchema = z.object({
  id: z.string().min(1).max(100),
  worldCount: z.union([z.literal(6), z.literal(40), z.literal(256)]),
  mapSeed: z.number().int().min(1).max(0xffffffff),
  campaignSeed: z.number().int().min(1).max(0xffffffff),
  mirrored: z.boolean(),
  schedule: scheduleSchema,
  kind: z.enum(['paid', 'symmetric-boundary', 'supply-boundary']),
  maxTurns: z.number().int().min(1).max(200)
}).strict();
export type BaselineInput = z.infer<typeof inputSchema>;
export type TurnMetric = { status: 'measured'; turn: number } |
  { status: 'timeout'; throughTurn: number } |
  { status: 'unavailable'; reason: 'not-observed-before-stop' };
export interface SideMetrics {
  firstResearch: TurnMetric;
  firstResearchCompleted: TurnMetric;
  firstColony: TurnMetric;
  firstOrder: TurnMetric;
  firstRelease: TurnMetric;
  firstShip: TurnMetric;
  firstEncounter: TurnMetric;
  gross: { credits: number; minerals: number };
  spent: Record<string, { credits: number; minerals: number }>;
  released: number;
  losses: number;
  ownEnds: number;
}
export interface CommandRecord {
  command: ConquestCommand;
  result: 'accepted' | 'rejected' | 'rolled-back';
  message?: string;
  executorCode?: ConquestErrorCode;
  endTurnObservations?: string[];
}
export interface BaselineRun {
  input: BaselineInput;
  versions: { baseline: 2; save: 6; rules: 3; battlePolicy: Conquest['battlePolicy']; tree: 2 };
  map: GalaxyMap;
  lineups: { first: CampaignFactionId; second: CampaignFactionId };
  controllers: 'diagnostic-all-ai-command-runner';
  status: 'completed' | 'timeout' | 'executor-error';
  outcome: ReturnType<typeof getConquestOutcome>;
  turnsExecuted: number;
  commands: CommandRecord[];
  metrics: Record<CampaignFactionId, SideMetrics>;
  battleTimeouts: number;
  battles: Conquest['battles'];
  unavailable: { scientificPoints: 'mechanic-not-implemented'; population: 'mechanic-not-implemented' };
  finalState: Conquest;
  checkpoint: { turnsExecuted: number; json: string } | null;
}

export function baselineMatrix(): BaselineInput[] {
  const matrix: BaselineInput[] = [];
  for (const seeds of BASELINE_SEEDS) for (const worldCount of [6, 40, 256] as const) {
    for (const schedule of scheduleSchema.options) for (const mirrored of [false, true]) {
      matrix.push({ id: `${worldCount}-${seeds.mapSeed}-${schedule}-${mirrored ? 'mirror' : 'direct'}`,
        ...seeds, worldCount, mirrored, schedule, kind: 'paid', maxTurns: 200 });
    }
  }
  for (const kind of ['symmetric-boundary', 'supply-boundary'] as const) for (const mirrored of [false, true]) {
    matrix.push({ id: `${kind}-${mirrored ? 'mirror' : 'direct'}`, ...BASELINE_SEEDS[0],
      worldCount: 6, mirrored, schedule: 'current-ai', kind, maxTurns: 8 });
  }
  return matrix;
}

export function createBaselineStart(input: BaselineInput): { state: Conquest; map: GalaxyMap } {
  const options = inputSchema.parse(input);
  const generated = generateGalaxy({ worldCount: options.worldCount, participantCount: 2, seed: options.mapSeed,
    generatorVersion: GALAXY_GENERATOR_VERSION, profileId: GALAXY_PROFILE_ID });
  if (!generated.ok) throw new Error(generated.message);
  let map = generated.map;
  if (options.mirrored) {
    const [first, second] = map.participants;
    const swap = (id: string) => id === first.id ? second.id : first.id;
    const checked = validateGalaxyMap({ ...map,
      participants: map.participants.map(side => ({ ...side, homeWorldId:
        side.id === first.id ? second.homeWorldId : first.homeWorldId })),
      worlds: map.worlds.map(world => ({ ...world, ownerId: world.ownerId === null ? null : swap(world.ownerId) })) });
    if (!checked.ok) throw new Error(checked.message);
    map = checked.map;
  }
  const state = createConquest({ mode: 'local' }, undefined, options.campaignSeed, map);
  if (options.kind !== 'paid') {
    const systemId = getGalaxyDefinition(state.session.galaxy).systems.find(system =>
      system.habitable && !state.session.galaxy.systems.find(item => item.id === system.id)?.ownerId)!.id;
    const count = options.kind === 'supply-boundary' ? 100 : 1;
    for (const side of ['blue', 'red'] as const) {
      state.research[side].completed = ['support', 'ordnance', 'capital'];
      const candidates = buildConquestDesigns(state.research[side], state.researchTree);
      const design = structuredClone(options.kind === 'supply-boundary'
        ? candidates.find(candidate => candidate.hullId === 'corvette' &&
          candidate.slots.some(slot => slot.component?.kind === 'projectile'))!
        : candidates.find(candidate => candidate.hullId === 'fighter')!);
      if (!design) throw new Error('Нет проекта для boundary-матрицы');
      if (options.kind === 'supply-boundary') {
        for (const slot of design.slots) if (slot.component?.kind === 'beam') slot.component = null;
        state.session.treasuries[side] = { credits: 0, minerals: 0 };
      }
      for (let index = 0; index < count; index++) {
        const id = state.session.ships.length + 1;
        state.session.ships.push({ id, factionId: side, systemId, design: structuredClone(design),
          fuel: options.kind === 'supply-boundary' ? 0 : 3 });
        const operation = createOperationalState(design);
        if (options.kind === 'supply-boundary') operation.ammunition.forEach(weapon => { weapon.amount = 0; });
        state.operations[String(id)] = operation;
      }
    }
    state.session.production.lastOrderId = state.session.ships.length;
  }
  return { state: conquestSchema.parse(state), map };
}

function sideMetrics(): SideMetrics {
  const missing = (): TurnMetric => ({ status: 'unavailable', reason: 'not-observed-before-stop' });
  return { firstResearch: missing(), firstResearchCompleted: missing(), firstColony: missing(),
    firstOrder: missing(), firstRelease: missing(), firstShip: missing(), firstEncounter: missing(),
    gross: { credits: 0, minerals: 0 }, spent: {}, released: 0, losses: 0, ownEnds: 0 };
}

function commandFor(state: Conquest, input: BaselineInput, first: CampaignFactionId): ConquestCommand {
  const side = state.session.turn % 2 ? 'blue' : 'red';
  const view = getConquestView(state, side);
  const normal = planConquestAction(view);
  if (input.kind !== 'paid') return { kind: 'endTurn', factionId: side, expectedTurn: view.turn };
  if (side !== first || input.schedule === 'current-ai') return normal;
  if (input.schedule === 'research-first' && view.research.completed.length < view.researchTree.nodes.length) {
    return normal.kind === 'enqueueProduction'
      ? { kind: 'endTurn', factionId: side, expectedTurn: view.turn } : normal;
  }
  if (input.schedule === 'production-first' && !view.research.active && !view.research.completed.length &&
    !view.ships.length && !view.production.orders.length && !view.production.completed.length) {
    const colony = view.galaxy.systems.find(system => system.visibility === 'explored' && system.ownerId === side);
    const design = buildConquestDesigns(view.research, view.researchTree)
      .sort((a, b) => getProductionQuote(a).cost.credits - getProductionQuote(b).cost.credits ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .find(candidate => {
        const quote = getProductionQuote(candidate);
        return quote.cost.credits <= view.treasury.credits && quote.cost.minerals <= view.treasury.minerals;
      });
    if (colony && design) return { kind: 'enqueueProduction', factionId: side, expectedTurn: view.turn,
      systemId: colony.id, design };
    return { kind: 'endTurn', factionId: side, expectedTurn: view.turn };
  }
  return normal;
}

function observations(state: Conquest, side: CampaignFactionId, input: BaselineInput): string[] {
  const view = getConquestView(state, side), reasons = ['no-further-command-in-diagnostic-schedule'];
  if (input.kind !== 'paid') reasons.push('boundary-end-only');
  if (view.research.active) reasons.push('research-in-progress');
  if (view.production.orders.length) reasons.push('production-in-progress');
  if (view.ships.some(ship => ship.transit)) reasons.push('ships-in-transit');
  if (view.ships.some(ship => !ship.fuel)) reasons.push('ships-with-empty-fuel');
  if (Object.values(view.operations).some(operation => operation.ammunition.some(weapon => !weapon.amount))) reasons.push('empty-ammunition');
  if (!view.galaxy.systems.some(system => system.visibility === 'explored' && system.ownerId === side)) reasons.push('no-colonies');
  if (view.economyForecast.ok && view.economyForecast.upkeep.shortfallCredits) reasons.push('upkeep-shortfall');
  if (input.schedule === 'research-first' && view.research.completed.length < view.researchTree.nodes.length) reasons.push('production-deliberately-delayed');
  const designs = buildConquestDesigns(view.research, view.researchTree);
  if (designs.length && designs.every(design => {
    const quote = getProductionQuote(design);
    return quote.cost.credits + 5 > view.treasury.credits || quote.cost.minerals > view.treasury.minerals;
  })) reasons.push('no-affordable-ai-design-with-reserve');
  return reasons;
}

function measure(before: Conquest, after: Conquest, command: ConquestCommand,
  metrics: Record<CampaignFactionId, SideMetrics>, battles: Conquest['battles']): void {
  const side = command.factionId, metric = metrics[side], turn = command.expectedTurn;
  const mark = (key: keyof Pick<SideMetrics, 'firstResearch' | 'firstResearchCompleted' | 'firstColony' |
    'firstOrder' | 'firstRelease' | 'firstShip' | 'firstEncounter'>) => {
    if (metric[key].status !== 'measured') metric[key] = { status: 'measured', turn };
  };
  if (command.kind === 'research') mark('firstResearch');
  if (command.kind === 'enqueueProduction') mark('firstOrder');
  if (command.kind === 'deployProduction') mark('firstShip');
  if (after.research[side].completed.length > before.research[side].completed.length) mark('firstResearchCompleted');
  for (const faction of ['blue', 'red'] as const) {
    if (metrics[faction].firstColony.status !== 'measured' && after.session.galaxy.systems.some(system =>
      system.ownerId === faction && before.session.galaxy.systems.find(item => item.id === system.id)?.ownerId !== faction)) {
      metrics[faction].firstColony = { status: 'measured', turn };
    }
  }
  const releases = after.session.production.completed.filter(record => record.factionId === side &&
    !before.session.production.completed.some(old => old.id === record.id));
  if (releases.length) { mark('firstRelease'); metric.released += releases.length; }
  const treasuryBefore = before.session.treasuries[side], treasuryAfter = after.session.treasuries[side];
  if (command.kind === 'endTurn') {
    metric.ownEnds++;
    const colonyIncome = before.session.galaxy.systems.filter(system => system.ownerId === side).length * 10;
    const due = before.session.ships.filter(ship => ship.factionId === side).length;
    const paid = Math.min(treasuryBefore.credits + colonyIncome, due);
    metric.gross.credits += treasuryAfter.credits - treasuryBefore.credits + paid;
    metric.gross.minerals += treasuryAfter.minerals - treasuryBefore.minerals;
    const upkeep = metric.spent.upkeep ??= { credits: 0, minerals: 0 };
    upkeep.credits += paid;
  } else {
    const credits = treasuryBefore.credits - treasuryAfter.credits;
    const minerals = treasuryBefore.minerals - treasuryAfter.minerals;
    if (credits || minerals) {
      const cost = metric.spent[command.kind] ??= { credits: 0, minerals: 0 };
      cost.credits += credits; cost.minerals += minerals;
    }
  }
  for (const battle of after.battles.filter(report => report.id > before.lastBattleId)) {
    battles.push(battle);
    for (const faction of ['blue', 'red'] as const) {
      const participant = battle.participants.some(ship => ship.factionId === faction);
      if (participant && metrics[faction].firstEncounter.status !== 'measured') {
        metrics[faction].firstEncounter = { status: 'measured', turn };
      }
      metrics[faction].losses += battle.destroyed.filter(id =>
        battle.participants.some(ship => ship.id === id && ship.factionId === faction)).length;
    }
  }
}

export function runBaseline(input: BaselineInput, resume?: { state: unknown; turnsExecuted: number }): BaselineRun {
  const options = inputSchema.parse(input), start = createBaselineStart(options);
  let state = resume ? decodeConquestSave(encodeConquestSave(resume.state)) : start.state;
  const first: CampaignFactionId = options.mirrored ? 'red' : 'blue';
  const result: BaselineRun = {
    input: options, versions: { baseline: 2, save: 6, rules: 3, battlePolicy: state.battlePolicy, tree: 2 },
    map: start.map, lineups: { first, second: first === 'blue' ? 'red' : 'blue' },
    controllers: 'diagnostic-all-ai-command-runner', status: 'timeout', outcome: getConquestOutcome(state),
    turnsExecuted: resume?.turnsExecuted ?? 0, commands: [], metrics: { blue: sideMetrics(), red: sideMetrics() },
    battles: [], battleTimeouts: 0, unavailable: { scientificPoints: 'mechanic-not-implemented',
      population: 'mechanic-not-implemented' }, finalState: state, checkpoint: null
  };
  if (resume && (!Number.isInteger(resume.turnsExecuted) || resume.turnsExecuted < 0 ||
    resume.turnsExecuted > options.maxTurns || state.session.turn !== start.state.session.turn + resume.turnsExecuted ||
    JSON.stringify(state.session.galaxy.map) !== JSON.stringify(start.map) || state.seed !== options.campaignSeed)) {
    throw new Error('Checkpoint не соответствует входу baseline');
  }
  while (result.turnsExecuted < options.maxTurns && getConquestOutcome(state).status === 'ongoing') {
    let candidate = state;
    const records: CommandRecord[] = [], steps: { before: Conquest; after: Conquest; command: ConquestCommand }[] = [];
    for (let action = 0; action < 24; action++) {
      const command: ConquestCommand = action === 23
        ? { kind: 'endTurn', factionId: candidate.session.turn % 2 ? 'blue' : 'red', expectedTurn: candidate.session.turn }
        : commandFor(candidate, options, first);
      const record: CommandRecord = { command, result: 'accepted',
        ...(command.kind === 'endTurn' ? { endTurnObservations: observations(candidate, command.factionId, options) } : {}) };
      records.push(record);
      const executed = executeConquestAction(candidate, command, true);
      if (!executed.ok) {
        record.result = 'rejected'; record.message = executed.message;
        record.executorCode = executed.code;
        for (const previous of records.slice(0, -1)) previous.result = 'rolled-back';
        result.status = 'executor-error';
        break;
      }
      steps.push({ before: candidate, after: executed.state, command });
      candidate = executed.state;
      if (command.kind === 'endTurn') break;
    }
    result.commands.push(...records);
    if (result.status === 'executor-error') break;
    for (const step of steps) measure(step.before, step.after, step.command, result.metrics, result.battles);
    state = candidate;
    result.turnsExecuted++;
    if (!resume && result.turnsExecuted === Math.min(10, options.maxTurns)) {
      result.checkpoint = { turnsExecuted: result.turnsExecuted, json: encodeConquestSave(state) };
    }
  }
  result.outcome = getConquestOutcome(state);
  if (result.outcome.status === 'completed') result.status = 'completed';
  result.finalState = state;
  result.battleTimeouts = result.battles.filter(battle => battle.timedOut).length;
  if (result.status === 'timeout') for (const metric of Object.values(result.metrics)) {
    for (const key of ['firstResearch', 'firstResearchCompleted', 'firstColony', 'firstOrder', 'firstRelease',
      'firstShip', 'firstEncounter'] as const) {
      if (metric[key].status !== 'measured') metric[key] = { status: 'timeout', throughTurn: state.session.turn - 1 };
    }
  }
  return result;
}

export function verifyBaseline(run: BaselineRun): { repeat: 'passed'; roundTrip: 'passed' | 'no-checkpoint-before-stop' } {
  if (JSON.stringify(runBaseline(run.input)) !== JSON.stringify(run)) {
    throw new Error(`Невоспроизводимый state/commands/metrics: ${run.input.id}`);
  }
  if (!run.checkpoint) return { repeat: 'passed', roundTrip: 'no-checkpoint-before-stop' };
  const continuation = runBaseline(run.input, {
    state: decodeConquestSave(run.checkpoint.json), turnsExecuted: run.checkpoint.turnsExecuted
  });
  const checkpointTurn = continuation.finalState.session.turn - (continuation.turnsExecuted - run.checkpoint.turnsExecuted);
  const suffix = run.commands.filter(record => record.command.expectedTurn >= checkpointTurn);
  if (JSON.stringify(continuation.finalState) !== JSON.stringify(run.finalState) ||
    JSON.stringify(continuation.commands) !== JSON.stringify(suffix) || continuation.status !== run.status) {
    throw new Error(`Round-trip изменил следующий ход/итог: ${run.input.id}`);
  }
  return { repeat: 'passed', roundTrip: 'passed' };
}

export function summarizeBaseline(runs: BaselineRun[]) {
  const groups = new Map<string, BaselineRun[]>();
  for (const run of runs) {
    const key = `${run.input.kind}/${run.input.worldCount}/${run.input.schedule}`;
    const group = groups.get(key) ?? [];
    group.push(run); groups.set(key, group);
  }
  return [...groups].map(([group, values]) => {
    const distribution = (numbers: number[]) => {
      const sorted = numbers.slice().sort((a, b) => a - b);
      return sorted.length ? { status: 'measured' as const, n: sorted.length, min: sorted[0],
        median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] :
          (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, max: sorted[sorted.length - 1] }
        : { status: 'unavailable' as const, reason: 'no-observations' };
    };
    const milestones = (lineup: 'first' | 'second') => Object.fromEntries(
      (['firstResearch', 'firstResearchCompleted', 'firstColony', 'firstOrder', 'firstRelease', 'firstShip',
        'firstEncounter'] as const).map(key => {
        const measurements = values.map(run => run.metrics[run.lineups[lineup]][key]);
        return [key, { distribution: distribution(measurements.flatMap(metric =>
          metric.status === 'measured' ? [metric.turn] : [])), censored: measurements.filter(metric =>
          metric.status === 'timeout').length, unavailable: measurements.filter(metric => metric.status === 'unavailable').length }];
      }));
    return { group, n: values.length, completed: values.filter(run => run.status === 'completed').length,
      timeout: values.filter(run => run.status === 'timeout').length,
      executorErrors: values.filter(run => run.status === 'executor-error').length,
      firstWins: values.filter(run => run.outcome.status === 'completed' && run.outcome.winner === run.lineups.first).length,
      secondWins: values.filter(run => run.outcome.status === 'completed' && run.outcome.winner === run.lineups.second).length,
      completionTurns: distribution(values.filter(run => run.status === 'completed').map(run => run.turnsExecuted)),
      first: milestones('first'), second: milestones('second'),
      losses: distribution(values.map(run => run.metrics.blue.losses + run.metrics.red.losses)),
      battleTimeouts: values.reduce((sum, run) => sum + run.battleTimeouts, 0),
      endTurnObservations: values.flatMap(run => run.commands.flatMap(record =>
        record.result === 'accepted' ? record.endTurnObservations ?? [] : []))
        .reduce<Record<string, number>>((counts, reason) => { counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {}) };
  });
}
