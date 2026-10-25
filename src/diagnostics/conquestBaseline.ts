import { z } from 'zod';
import { createConquest, conquestSchema, executeConquestAction, getConquestOutcome, getConquestView,
  type Conquest, type ConquestCommand, type ConquestErrorCode } from '../domain/conquest';
import { buildConquestDesigns, planConquestAction } from '../domain/conquestAi';
import { generateGalaxy } from '../domain/galaxyGenerator';
import { GALAXY_GENERATOR_VERSION, GALAXY_PROFILE_ID, validateGalaxyMap, type GalaxyMap } from '../domain/galaxyMap';
import { getGalaxyDefinition, type CampaignFactionId } from '../domain/campaign';
import { createOperationalState } from '../domain/campaignOperations';
import { getColonyProductionQuote } from '../domain/campaignOutput';
import { decodeConquestSave, encodeConquestSave } from '../utils/ConquestSaveManager';
import { calculateShipStats } from '../domain/shipDesign';
import { getTravelCapabilities } from '../domain/campaignTravel';

export const BASELINE_VERSION = 12;
export const BASELINE_TRACE_VERSION = 1;
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
export const baselineInputSchema = inputSchema;
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
  productionPoints: number;
  researchPoints: number;
  researchSpent: number;
  researchOverflow: number;
  researchReserve: number;
  researchProgress: number;
  culturePoints: number;
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
  versions: { baseline: 12; save: 16; rules: 13; battlePolicy: Conquest['battlePolicy']; tree: 10; tacticalRules: 'design-combat-v1' };
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
  population: Record<CampaignFactionId, { total: number; capacity: number }>;
  finalState: Conquest;
  checkpoint: { turnsExecuted: number; json: string } | null;
}

function tracePosition(state: Conquest) {
  return {
    worlds: state.session.galaxy.systems.map(world => ({
      id: world.id, ownerId: world.ownerId, environment: state.environment[world.id],
      population: state.population[world.id] ? { ...state.population[world.id] } : null,
      workers: state.colonyOutput.assignments[world.id] ? { ...state.colonyOutput.assignments[world.id] } : null
    })),
    factions: (['blue', 'red'] as const).map(side => {
      const view = getConquestView(state, side);
      return { side, treasury: { ...view.treasury }, budget: structuredClone(view.economyForecast),
        research: structuredClone(view.research), reserves: { ...view.colonyOutput.reserves },
        knowledge: { known: [...view.knownSystems], habitable: [...view.knownHabitableSystems],
          surveys: { ...view.environmentKnowledge },
          visible: view.galaxy.systems.filter(world => world.visibility === 'explored').map(world => world.id),
          enemies: structuredClone(view.enemies), colonization: structuredClone(view.colonization) },
        orders: view.production.orders.map(order => ({ id: order.id, systemId: order.systemId,
          designId: order.design.id, hullId: order.design.hullId, cost: { ...order.cost },
          progress: order.productionProgress, required: order.productionCost })),
        completed: view.production.completed.map(order => ({ id: order.id, systemId: order.systemId,
          designId: order.design.id, hullId: order.design.hullId })),
        projects: view.workProjects.map(project => ({ id: project.id, kind: project.kind,
          systemId: project.systemId, progress: project.productionProgress, required: project.productionCost }))
      };
    }),
    ships: state.session.ships.map(ship => {
      const stats = calculateShipStats(ship.design);
      return { id: ship.id, side: ship.factionId, systemId: ship.systemId,
        transit: ship.transit ? { ...ship.transit } : null, fuel: ship.fuel,
        capabilities: getTravelCapabilities(ship.design.strategicEquipment),
        designId: ship.design.id, hullId: ship.design.hullId,
        operational: structuredClone(state.operations[String(ship.id)]),
        tactical: { hull: stats.hitPoints, shield: stats.shield, regen: stats.shieldRegen,
          armor: stats.armor, power: stats.powerGeneration, energy: stats.energyCapacity,
          movementPower: stats.movementPower, speed: stats.speed, thrust: stats.thrust, mass: stats.mass,
          weapons: stats.weapons.map(weapon => ({ slotId: weapon.slotId, kind: weapon.definition.kind,
            range: weapon.definition.range, damage: weapon.definition.damage, rate: weapon.definition.fireRate,
            energyPerShot: weapon.energyPerShot,
            ammunition: weapon.definition.kind === 'projectile' ? weapon.definition.ammoCapacity : null })) }
      };
    }),
    counters: { order: state.session.production.lastOrderId, battle: state.lastBattleId }
  };
}

function traceWindow(before: Conquest, after: Conquest, commands: CommandRecord[], turnsExecuted: number) {
  return { turnsExecuted, turn: before.session.turn, commands: structuredClone(commands),
    ownershipChanges: after.session.galaxy.systems.flatMap(world => {
      const previous = before.session.galaxy.systems.find(item => item.id === world.id)!;
      return previous.ownerId === world.ownerId ? [] : [{ systemId: world.id, from: previous.ownerId, to: world.ownerId }];
    }),
    battles: structuredClone(after.battles.filter(battle => battle.id > before.lastBattleId)),
    position: tracePosition(after) };
}

export type BaselineWindowTrace = ReturnType<typeof traceWindow>;
export interface BaselineDiagnostics {
  onWindow: (window: BaselineWindowTrace, checkpointJson?: string) => void;
  checkpointAt?: number;
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
    state.session.ships = [];
    state.operations = {};
    state.session.production.lastOrderId = 0;
    const systemId = getGalaxyDefinition(state.session.galaxy).systems.find(system =>
      system.habitable && !state.session.galaxy.systems.find(item => item.id === system.id)?.ownerId)!.id;
    const count = options.kind === 'supply-boundary' ? 100 : 1;
    for (const side of ['blue', 'red'] as const) {
      state.research[side].completed = state.researchTree.nodes.map(node => node.id);
      state.researchJournal[side] = Object.fromEntries(state.research[side].completed.map(id => [id, 1]));
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
          fuel: options.kind === 'supply-boundary' ? 0 : 3000 });
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
    gross: { credits: 0, minerals: 0 }, productionPoints: 0, researchPoints: 0, culturePoints: 0,
    researchSpent: 0, researchOverflow: 0, researchReserve: 0, researchProgress: 0,
    spent: {}, released: 0, losses: 0, ownEnds: 0 };
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
  if (input.schedule === 'production-first' && !view.research.activeId && !view.research.completed.length &&
    !view.ships.some(ship => ship.design.hullId !== 'colonizer') && !view.production.orders.length && !view.production.completed.length) {
    const colony = view.galaxy.systems.find(system => system.visibility === 'explored' && system.ownerId === side);
    const design = buildConquestDesigns(view.research, view.researchTree)
      .sort((a, b) => getColonyProductionQuote(a, view.colonyOutput.rules).cost.credits -
        getColonyProductionQuote(b, view.colonyOutput.rules).cost.credits ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .find(candidate => {
        const quote = getColonyProductionQuote(candidate, view.colonyOutput.rules);
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
  if (view.research.activeId) reasons.push('research-in-progress');
  if (view.production.orders.length) reasons.push('production-in-progress');
  if (view.ships.some(ship => ship.transit)) reasons.push('ships-in-transit');
  if (view.ships.some(ship => !ship.fuel)) reasons.push('ships-with-empty-fuel');
  if (Object.values(view.operations).some(operation => operation.ammunition.some(weapon => !weapon.amount))) reasons.push('empty-ammunition');
  if (!view.galaxy.systems.some(system => system.visibility === 'explored' && system.ownerId === side)) reasons.push('no-colonies');
  if (view.economyForecast.ok && view.economyForecast.upkeep.shortfallCredits) reasons.push('upkeep-shortfall');
  if (input.schedule === 'research-first' && view.research.completed.length < view.researchTree.nodes.length) reasons.push('production-deliberately-delayed');
  const designs = buildConquestDesigns(view.research, view.researchTree);
  if (designs.length && designs.every(design => {
    const quote = getColonyProductionQuote(design, view.colonyOutput.rules);
    return quote.cost.credits + 5 > view.treasury.credits || quote.cost.minerals > view.treasury.minerals;
  })) reasons.push('no-affordable-ai-design-with-reserve');
  return reasons;
}

function measure(before: Conquest, after: Conquest, command: ConquestCommand,
  turnReceipt: Extract<ReturnType<typeof executeConquestAction>, { ok: true }>['turnReceipt'],
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
  const releases = after.colonyOutput.production.completed.filter(record => record.factionId === side &&
    !before.colonyOutput.production.completed.some(old => old.id === record.id));
  if (releases.length) { mark('firstRelease'); metric.released += releases.length; }
  const treasuryBefore = before.session.treasuries[side], treasuryAfter = after.session.treasuries[side];
  if (command.kind === 'endTurn') {
    if (!turnReceipt || turnReceipt.factionId !== side || turnReceipt.turn !== turn) {
      throw new Error('Нет квитанции выпуска для успешного конца хода');
    }
    for (const faction of ['blue', 'red'] as const) {
      const count = after.session.galaxy.systems.filter(system => system.ownerId === faction &&
        !before.session.galaxy.systems.find(item => item.id === system.id)!.ownerId).length;
      const cost = { credits: count * after.rules.population.foundingCost.credits,
        minerals: count * after.rules.population.foundingCost.minerals };
      if (count) {
        const spending = metrics[faction].spent.founding ??= { credits: 0, minerals: 0 };
        spending.credits += cost.credits; spending.minerals += cost.minerals;
      }
    }
    metric.ownEnds++;
    metric.gross.credits += turnReceipt.populationIncome.credits;
    metric.gross.minerals += turnReceipt.populationIncome.minerals + turnReceipt.miningMinerals;
    metric.productionPoints += turnReceipt.productionPoints;
    metric.researchPoints += turnReceipt.reserves.research.produced;
    metric.researchSpent += turnReceipt.research.spent;
    metric.researchOverflow += turnReceipt.research.overflow;
    metric.researchReserve = turnReceipt.research.reserveAfter;
    metric.researchProgress = Object.values(after.research[side].progress).reduce((sum, value) => sum + value, 0);
    metric.culturePoints += turnReceipt.reserves.culture.produced;
    const upkeep = metric.spent.upkeep ??= { credits: 0, minerals: 0 };
    upkeep.credits += turnReceipt.creditsPaid;
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

export function getBaselineWindowAdvance(before: Conquest, after: Conquest, id: string): 0 | 1 {
  const advanced = after.session.turn - before.session.turn;
  if (advanced === 1 || advanced === 0 && getConquestOutcome(after).status === 'completed') return advanced;
  throw new Error(`Принятое окно baseline не продвинуло ход: ${id}`);
}

export function runBaseline(input: BaselineInput, resume?: { state: unknown; turnsExecuted: number },
  diagnostics?: BaselineDiagnostics): BaselineRun {
  const options = inputSchema.parse(input), start = createBaselineStart(options);
  if (diagnostics && (typeof diagnostics.onWindow !== 'function' || diagnostics.checkpointAt !== undefined &&
    (!Number.isInteger(diagnostics.checkpointAt) || diagnostics.checkpointAt < 1 || diagnostics.checkpointAt > options.maxTurns))) {
    throw new Error('Недопустимые параметры трассы baseline');
  }
  let state = resume ? decodeConquestSave(encodeConquestSave(resume.state)) : start.state;
  const first: CampaignFactionId = options.mirrored ? 'red' : 'blue';
  const result: BaselineRun = {
    input: options, versions: { baseline: 12, save: 16, rules: 13, battlePolicy: state.battlePolicy, tree: 10, tacticalRules: 'design-combat-v1' },
    map: start.map, lineups: { first, second: first === 'blue' ? 'red' : 'blue' },
    controllers: 'diagnostic-all-ai-command-runner', status: 'timeout', outcome: getConquestOutcome(state),
    turnsExecuted: resume?.turnsExecuted ?? 0, commands: [], metrics: { blue: sideMetrics(), red: sideMetrics() },
    battles: [], battleTimeouts: 0,
    population: { blue: { total: 0, capacity: 0 }, red: { total: 0, capacity: 0 } }, finalState: state, checkpoint: null
  };
  if (resume && (!Number.isInteger(resume.turnsExecuted) || resume.turnsExecuted < 0 ||
    resume.turnsExecuted > options.maxTurns || state.session.turn !== start.state.session.turn + resume.turnsExecuted ||
    JSON.stringify(state.session.galaxy.map) !== JSON.stringify(start.map) || state.seed !== options.campaignSeed)) {
    throw new Error('Checkpoint не соответствует входу baseline');
  }
  while (result.turnsExecuted < options.maxTurns && getConquestOutcome(state).status === 'ongoing') {
    let candidate = state;
    const records: CommandRecord[] = [], steps: { before: Conquest; after: Conquest; command: ConquestCommand;
      turnReceipt?: Extract<ReturnType<typeof executeConquestAction>, { ok: true }>['turnReceipt'] }[] = [];
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
      steps.push({ before: candidate, after: executed.state, command, turnReceipt: executed.turnReceipt });
      candidate = executed.state;
      if (command.kind === 'endTurn' || getConquestOutcome(candidate).status === 'completed') break;
    }
    result.commands.push(...records);
    if (result.status === 'executor-error') break;
    const advanced = getBaselineWindowAdvance(state, candidate, options.id);
    for (const step of steps) measure(step.before, step.after, step.command, step.turnReceipt, result.metrics, result.battles);
    result.turnsExecuted += advanced;
    if (diagnostics) diagnostics.onWindow(traceWindow(state, candidate, records, result.turnsExecuted),
      diagnostics.checkpointAt === result.turnsExecuted && candidate.session.turn > state.session.turn
        ? encodeConquestSave(candidate) : undefined);
    state = candidate;
    if (!resume && result.turnsExecuted === Math.min(4, options.maxTurns)) {
      result.checkpoint = { turnsExecuted: result.turnsExecuted, json: encodeConquestSave(state) };
    }
  }
  result.outcome = getConquestOutcome(state);
  if (result.outcome.status === 'completed') result.status = 'completed';
  result.finalState = state;
  for (const faction of ['blue', 'red'] as const) {
    const colonies = state.session.galaxy.systems.filter(system => system.ownerId === faction);
    result.population[faction] = {
      total: colonies.reduce((sum, colony) => sum + state.population[colony.id].population, 0),
      capacity: getConquestView(state, faction).population.reduce((sum, colony) => sum + colony.capacity, 0)
    };
  }
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
