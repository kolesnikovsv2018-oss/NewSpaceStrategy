import { z } from 'zod';
import { factionIdSchema, systemIdSchema, getGalaxyDefinition, areSystemsAdjacent, type CampaignFactionId, type SystemId } from './campaign';
import { conquestSessionSchema, createCampaignSession, executeConquestSessionCommand, getConquestSessionView,
  sessionCommandSchema, MAX_TURN, type CampaignSessionView } from './campaignSession';
import { treasurySchema } from './campaignEconomy';
import { researchTreeSchema, researchStateSchema, researchIdSchema, createResearchState, getDefaultResearchTree,
  isResearchStateValid, isCampaignDesignAvailable, advanceResearch } from './campaignResearch';
import { operationalStateSchema, createOperationalState, readOperationalState, getRepairQuote, getAmmunitionQuote } from './campaignOperations';
import { resolveConquestBattle, type BattleFrame } from './conquestBattle';
import type { CampaignShip } from './campaignShips';

export const conquestControlSchema = z.union([
  z.object({ mode: z.literal('local') }).strict(),
  z.object({ mode: z.literal('human-vs-ai'), aiPolicy: z.literal('conquest-v1') }).strict()
]);
export const conquestVictorySchema = z.object({ kind: z.literal('all-planets-v1') }).strict();
export type ConquestOutcome = { status: 'ongoing' } | { status: 'completed'; winner: CampaignFactionId; reason: 'all-planets' };
const battleReportSchema = z.object({ id: z.number().int().positive().max(MAX_TURN), turn: z.number().int().positive().max(MAX_TURN),
  systemId: systemIdSchema, winner: factionIdSchema.nullable(), timedOut: z.boolean(),
  participants: z.array(z.object({ id: z.number().int().positive(), factionId: factionIdSchema }).strict()).max(200),
  destroyed: z.array(z.number().int().positive()).max(200) }).strict();
export const conquestSchema = z.object({
  scenario: z.literal('conquest-v1'), victory: conquestVictorySchema, control: conquestControlSchema,
  session: conquestSessionSchema, researchTree: researchTreeSchema,
  research: z.object({ blue: researchStateSchema, red: researchStateSchema }).strict(),
  operations: z.record(operationalStateSchema), seed: z.number().int().min(1).max(0xffffffff),
  lastBattleId: z.number().int().min(0).max(MAX_TURN), battles: z.array(battleReportSchema).max(12)
}).strict().superRefine((state, context) => {
  const fail = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'Нарушена целостность военной кампании' });
  if (factionIdSchema.options.some(faction => !isResearchStateValid(state.research[faction], state.researchTree))) { fail(); return; }
  if (Object.keys(state.operations).length !== state.session.ships.length) fail();
  for (const ship of state.session.ships) {
    try { readOperationalState(state.operations[String(ship.id)], ship.design); } catch { fail(); }
    if (!isCampaignDesignAvailable(ship.design, state.research[ship.factionId], state.researchTree)) fail();
  }
  for (const record of [...state.session.production.orders, ...state.session.production.completed]) {
    if (!isCampaignDesignAvailable(record.design, state.research[record.factionId], state.researchTree)) fail();
  }
  if (new Set(state.battles.map(battle => battle.id)).size !== state.battles.length || state.battles.some(battle =>
    battle.id > state.lastBattleId || battle.turn >= state.session.turn ||
    new Set(battle.participants.map(ship => ship.id)).size !== battle.participants.length ||
    new Set(battle.destroyed).size !== battle.destroyed.length ||
    battle.destroyed.some(id => !battle.participants.some(ship => ship.id === id)))) fail();
});
export type Conquest = z.infer<typeof conquestSchema>;
export type ConquestResult = { ok: true; state: Conquest; frames?: BattleFrame[] } | { ok: false; message: string };
const fields = { factionId: factionIdSchema, expectedTurn: z.number().int().min(1).max(MAX_TURN) };
export const conquestCommandSchema = z.union([sessionCommandSchema,
  z.object({ ...fields, kind: z.literal('research'), technologyId: researchIdSchema }).strict(),
  z.object({ ...fields, kind: z.enum(['repairShip', 'resupplyShip']), shipId: z.number().int().positive().max(MAX_TURN), systemId: systemIdSchema }).strict()
]);
export type ConquestCommand = z.infer<typeof conquestCommandSchema>;
class ConquestRuleError extends Error {}

export function createConquest(control: unknown = { mode: 'local' }, tree: unknown = getDefaultResearchTree(), seed = 1): Conquest {
  return conquestSchema.parse({ scenario: 'conquest-v1', victory: { kind: 'all-planets-v1' }, control,
    session: createCampaignSession(), researchTree: tree, research: { blue: createResearchState(), red: createResearchState() },
    operations: {}, seed, lastBattleId: 0, battles: [] });
}

export function getConquestOutcome(state: Conquest): ConquestOutcome {
  const planets = getGalaxyDefinition().systems.filter(system => system.habitable);
  for (const winner of factionIdSchema.options) if (planets.every(planet =>
    state.session.galaxy.systems.find(system => system.id === planet.id)?.ownerId === winner)) {
    return { status: 'completed', winner, reason: 'all-planets' };
  }
  return { status: 'ongoing' };
}

export function visibleConquestSystems(state: Conquest, faction: CampaignFactionId): Set<SystemId> {
  const visible = new Set(state.session.galaxy.systems.filter(system => system.ownerId === faction).map(system => system.id));
  for (const ship of state.session.ships) {
    if (ship.factionId !== faction || ship.transit) continue;
    visible.add(ship.systemId);
    if (ship.design.slots.some(slot => slot.component?.kind === 'scanner' && slot.component.range > 0 && slot.component.accuracy > 0)) {
      for (const system of getGalaxyDefinition().systems) if (areSystemsAdjacent(ship.systemId, system.id)) visible.add(system.id);
    }
  }
  return visible;
}

export function getConquestView(input: unknown, faction: CampaignFactionId) {
  const state = conquestSchema.parse(input);
  const side = factionIdSchema.parse(faction);
  const view: CampaignSessionView = getConquestSessionView(state.session, side);
  const mined = miningYield(view.ships, side);
  view.income.minerals += mined;
  if (view.economyForecast.ok) {
    view.economyForecast.income.minerals += mined;
    view.economyForecast.treasuryAfter.minerals += mined;
    if (!treasurySchema.safeParse(view.economyForecast.treasuryAfter).success) view.economyForecast = { ok: false, code: 'RESOURCE_LIMIT' };
  }
  const visible = visibleConquestSystems(state, side);
  view.galaxy.systems = view.galaxy.systems.map(system => !visible.has(system.id)
    ? { id: system.id, name: system.name, x: system.x, y: system.y, visibility: 'unknown' as const } : system);
  return { ...view, researchTree: state.researchTree, research: state.research[side],
    operations: Object.fromEntries(view.ships.map(ship => [String(ship.id), state.operations[String(ship.id)]])),
    enemies: state.session.ships.filter(ship => ship.factionId !== side && !ship.transit && visible.has(ship.systemId))
      .map(ship => ({ id: ship.id, systemId: ship.systemId, factionId: ship.factionId, hullId: ship.design.hullId })),
    battles: state.battles.filter(battle => battle.participants.some(ship => ship.factionId === side)), outcome: getConquestOutcome(state) };
}
export type ConquestView = ReturnType<typeof getConquestView>;

function armed(ship: CampaignShip): boolean {
  return ship.design.slots.some(slot => slot.component?.kind === 'beam' || slot.component?.kind === 'projectile');
}
function reveal(state: Conquest): void {
  for (const faction of factionIdSchema.options) for (const id of visibleConquestSystems(state, faction)) {
    const system = state.session.galaxy.systems.find(item => item.id === id)!;
    if (!system.exploredBy.includes(faction)) system.exploredBy.push(faction);
  }
}
function debit(state: Conquest, faction: CampaignFactionId, credits: number, minerals: number): void {
  const treasury = state.session.treasuries[faction];
  if (treasury.credits < credits || treasury.minerals < minerals) throw new ConquestRuleError('Недостаточно ресурсов');
  treasury.credits -= credits; treasury.minerals -= minerals;
}
function miningYield(ships: readonly CampaignShip[], faction: CampaignFactionId): number {
  return ships.filter(ship => ship.factionId === faction && !getGalaxyDefinition().systems.find(system =>
    system.id === (ship.transit?.destinationId ?? ship.systemId))!.habitable).reduce((total, ship) => total +
      Math.floor(Math.min(10, ship.design.slots.reduce((sum, slot) => sum +
        (slot.component?.kind === 'mining' ? slot.component.miningSpeed * slot.component.efficiency : 0), 0))), 0);
}
function settleEncounters(state: Conquest, turn: number): BattleFrame[] | undefined {
  let frames: BattleFrame[] | undefined;
  for (const definition of getGalaxyDefinition().systems) {
    let present = state.session.ships.filter(ship => !ship.transit && ship.systemId === definition.id);
    if (new Set(present.map(ship => ship.factionId)).size > 1) {
      if (state.lastBattleId === MAX_TURN) throw new ConquestRuleError('Достигнут предел идентификаторов боёв');
      const seed = ((state.seed ^ Math.imul(turn, 2654435761) ^ (state.lastBattleId + 1)) >>> 0) || 1;
      const result = resolveConquestBattle(present, state.operations, seed);
      frames = result.frames;
      state.battles.push({ id: ++state.lastBattleId, turn, systemId: definition.id, winner: result.winner,
        timedOut: result.timedOut, participants: present.map(ship => ({ id: ship.id, factionId: ship.factionId })), destroyed: result.destroyed });
      state.battles = state.battles.slice(-12);
      state.session.ships = state.session.ships.filter(ship => !result.destroyed.includes(ship.id));
      for (const id of result.destroyed) delete state.operations[String(id)];
      for (const survivor of result.survivors) state.operations[String(survivor.id)] = survivor.operational;
      for (const fleet of state.session.fleets.items) fleet.shipIds = fleet.shipIds.filter(id => !result.destroyed.includes(id));
      state.session.fleets.items = state.session.fleets.items.filter(fleet => fleet.shipIds.length >= 2);
      present = state.session.ships.filter(ship => !ship.transit && ship.systemId === definition.id);
    }
    const sides = new Set(present.map(ship => ship.factionId));
    if (definition.habitable && sides.size === 1 && present.some(armed)) {
      const owner = present[0].factionId;
      const system = state.session.galaxy.systems.find(item => item.id === definition.id)!;
      system.ownerId = owner;
      if (!system.exploredBy.includes(owner)) system.exploredBy.push(owner);
      state.session.production.orders = state.session.production.orders.filter(record => record.systemId !== system.id || record.factionId === owner);
      state.session.production.completed = state.session.production.completed.filter(record => record.systemId !== system.id || record.factionId === owner);
    }
  }
  return frames;
}

export function executeConquestCommand(input: unknown, payload: unknown): ConquestResult {
  return executeConquestAction(input, payload, false);
}

export function executeConquestAction(input: unknown, payload: unknown, automated: boolean): ConquestResult {
  try {
    const state = conquestSchema.parse(input), command = conquestCommandSchema.parse(payload);
    const faction = command.factionId;
    if (command.expectedTurn !== state.session.turn) throw new ConquestRuleError('Номер хода изменился');
    if (faction !== (state.session.turn % 2 ? 'blue' : 'red')) throw new ConquestRuleError('Сейчас ход другой стороны');
    if (state.control.mode === 'human-vs-ai' && (automated ? faction !== 'red' : faction === 'red')) throw new ConquestRuleError('Команда недоступна этому контроллеру');
    if (getConquestOutcome(state).status === 'completed') throw new ConquestRuleError('Партия завершена');
    let frames: BattleFrame[] | undefined;
    if (command.kind === 'research') {
      const research = state.research[faction], node = state.researchTree.nodes.find(item => item.id === command.technologyId);
      if (!node || research.active || research.completed.includes(node.id) || !node.prerequisites.every(id => research.completed.includes(id))) {
        throw new ConquestRuleError('Исследование недоступно');
      }
      if (!state.session.galaxy.systems.some(system => system.ownerId === faction)) throw new ConquestRuleError('Для исследований нужна колония');
      debit(state, faction, node.credits, 0);
      research.active = { id: node.id, progress: 0 };
    } else if (command.kind === 'repairShip' || command.kind === 'resupplyShip') {
      const ship = state.session.ships.find(item => item.id === command.shipId && item.systemId === command.systemId && item.factionId === faction);
      if (!ship || ship.transit) throw new ConquestRuleError('Нет своего стоящего корабля');
      const home = state.session.galaxy.systems.some(system => system.id === ship.systemId && system.ownerId === faction);
      const repairRate = state.session.ships.filter(item => !item.transit && item.factionId === faction && item.systemId === ship.systemId)
        .flatMap(item => item.design.slots).reduce((sum, slot) => sum + (slot.component?.kind === 'repair' ? slot.component.repairRate : 0), 0);
      const operation = state.operations[String(ship.id)], maximum = createOperationalState(ship.design);
      if (command.kind === 'repairShip') {
        const quote = getRepairQuote(ship.design, operation, home, repairRate);
        if (quote.amount <= 0) throw new ConquestRuleError('Ремонт недоступен или корпус цел');
        debit(state, faction, quote.cost.credits, quote.cost.minerals);
        operation.hull += quote.amount;
      } else {
        if (!home) throw new ConquestRuleError('Боезапас пополняется только в своей колонии');
        const quote = getAmmunitionQuote(ship.design, operation);
        if (!quote.amount) throw new ConquestRuleError('Боезапас уже полон');
        debit(state, faction, quote.cost.credits, quote.cost.minerals);
        operation.ammunition = maximum.ammunition;
      }
    } else if (command.kind === 'explore' || command.kind === 'colonize') {
      if (!visibleConquestSystems(state, faction).has(command.systemId)) throw new ConquestRuleError('Нужен корабль или сканер в зоне системы');
      const system = state.session.galaxy.systems.find(item => item.id === command.systemId)!;
      if (command.kind === 'colonize') {
        if (system.ownerId || !getGalaxyDefinition().systems.find(item => item.id === system.id)!.habitable ||
          !state.session.ships.some(ship => ship.factionId === faction && !ship.transit && ship.systemId === system.id) ||
          state.session.ships.some(ship => ship.factionId !== faction && !ship.transit && ship.systemId === system.id)) throw new ConquestRuleError('Колонизация недоступна');
        system.ownerId = faction;
      }
      if (!system.exploredBy.includes(faction)) system.exploredBy.push(faction);
    } else {
      if (command.kind === 'enqueueProduction' && !isCampaignDesignAvailable(command.design, state.research[faction], state.researchTree)) throw new ConquestRuleError('Проект требует неоткрытые технологии');
      const result = executeConquestSessionCommand(state.session, command);
      if (!result.ok) return { ok: false, message: result.message };
      state.session = result.state;
      if (command.kind === 'deployProduction') {
        const ship = state.session.ships.find(item => item.id === command.orderId)!;
        state.operations[String(ship.id)] = createOperationalState(ship.design);
      }
      if (command.kind === 'endTurn') {
        if (state.session.galaxy.systems.some(system => system.ownerId === faction)) state.research[faction] = advanceResearch(state.research[faction], state.researchTree);
        state.session.treasuries[faction].minerals += miningYield(state.session.ships, faction);
        treasurySchema.parse(state.session.treasuries[faction]);
        frames = settleEncounters(state, command.expectedTurn);
      }
    }
    reveal(state);
    return { ok: true, state: conquestSchema.parse(state), ...(frames ? { frames } : {}) };
  } catch (error) {
    return { ok: false, message: error instanceof ConquestRuleError ? error.message : 'Недопустимые данные военной кампании' };
  }
}

export function convertConquestToLocal(input: unknown): Conquest {
  const state = conquestSchema.parse(input);
  state.control = { mode: 'local' };
  return state;
}