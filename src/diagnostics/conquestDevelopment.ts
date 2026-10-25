import { colonyWorkQueue } from '../domain/campaignOutput';
import { conquestSchema, executeConquestAction, getConquestOutcome, type Conquest, type ConquestCommand } from '../domain/conquest';
import { getBaselineWindowAdvance } from './conquestBaseline';

export interface DevelopmentStep {
  before: Conquest;
  command: ConquestCommand;
}

function sidePosition(state: Conquest, factionId: ConquestCommand['factionId']) {
  const colonies = state.session.galaxy.systems.filter(world => world.ownerId === factionId);
  const ships = state.session.ships.filter(ship => ship.factionId === factionId);
  return {
    colonies: colonies.map(world => world.id),
    population: colonies.reduce((sum, world) => sum + state.population[world.id].population, 0),
    surveys: Object.keys(state.surveys[factionId]).length,
    research: state.research[factionId].completed.length,
    ships: ships.length,
    inTransit: ships.filter(ship => ship.transit).length,
    orders: state.colonyOutput.production.orders.filter(order => order.factionId === factionId).length,
    completed: state.colonyOutput.production.completed.filter(order => order.factionId === factionId).length,
    treasury: { ...state.session.treasuries[factionId] }
  };
}

export function summarizeDevelopmentWindow(before: Conquest, after: Conquest, steps: readonly DevelopmentStep[]) {
  if (!steps.length || steps.length > 24) throw new Error('Недопустимое число команд окна развития');
  const factionId = steps[0].command.factionId;
  if (steps.some(step => step.command.factionId !== factionId || step.command.expectedTurn !== before.session.turn)) {
    throw new Error('Команды развития относятся к разным окнам');
  }
  const idleIndustryAssignments = steps.filter(({ before: state, command }) => {
    if (command.kind !== 'assignWorkers') return false;
    const workers = state.colonyOutput.assignments[command.systemId];
    return workers.industry > 0 && command.workers.industry > workers.industry &&
      workers.research === command.workers.research && workers.culture === command.workers.culture &&
      colonyWorkQueue(state.colonyOutput, command.systemId).length === 0;
  }).length;
  const commandKinds: Partial<Record<ConquestCommand['kind'], number>> = {};
  for (const { command } of steps) commandKinds[command.kind] = (commandKinds[command.kind] ?? 0) + 1;
  return {
    turn: before.session.turn, factionId,
    advanced: getBaselineWindowAdvance(before, after, 'development'),
    before: sidePosition(before, factionId), after: sidePosition(after, factionId),
    commandKinds, commandCount: steps.length, idleIndustryAssignments,
    fullBudget: steps.length === 24,
    battles: after.lastBattleId - before.lastBattleId,
    ownershipChanges: after.session.galaxy.systems.flatMap(world => {
      const previous = before.session.galaxy.systems.find(candidate => candidate.id === world.id)!;
      return previous.ownerId === world.ownerId ? [] : [{ systemId: world.id, from: previous.ownerId, to: world.ownerId }];
    })
  };
}

export type DevelopmentWindow = ReturnType<typeof summarizeDevelopmentWindow>;

export function replayDevelopmentCommands(input: Conquest, commands: readonly ConquestCommand[], checkpointTurn: number) {
  let state = conquestSchema.parse(input), before = state;
  const windows: DevelopmentWindow[] = [], steps: DevelopmentStep[] = [];
  let checkpoint: Conquest | undefined = state.session.turn === checkpointTurn ? structuredClone(state) : undefined;
  for (const command of commands) {
    if (steps.length === 24) throw new Error('Превышен бюджет24 при воспроизведении');
    const result = executeConquestAction(state, command, true);
    if (!result.ok) throw new Error(`Воспроизведение окна${state.session.turn}: ${result.code}`);
    steps.push({ before: state, command });
    state = result.state;
    if (command.kind === 'endTurn' || getConquestOutcome(state).status === 'completed') {
      windows.push(summarizeDevelopmentWindow(before, state, steps));
      steps.length = 0;
      before = state;
      if (state.session.turn === checkpointTurn) checkpoint = structuredClone(state);
    }
  }
  if (steps.length) throw new Error('Незавершённое окно воспроизведения');
  return { finalState: state, checkpoint, windows };
}
