import { z } from 'zod';
import type { GalaxyMap } from './galaxyMap';
import { campaignCommandSchema, campaignStateSchema, createCampaignState, executeCampaignCommand,
  areSystemsAdjacent, factionIdSchema, participantIdSchema, systemIdSchema, getCampaignView, getConquestGalaxyView,
  conquestGalaxyCommandSchema, conquestGalaxyStateSchema, createConquestState, getCampaignParticipants,
  getGalaxyDefinition, type CampaignErrorCode, type CampaignFactionId, type CampaignView,
  type ConquestGalaxyView, type ParticipantId, type SystemId } from './campaign';
import { treasurySchema, type Treasury } from './campaignEconomy';
import { calculateEndTurnEconomy, getUpkeepQuote, type EndTurnBudget, type EconomyCalculation } from './campaignUpkeep';
import { designSchema, validateDesign } from './shipDesign';
import { getWorldDistance, getTravelCapabilities, getTravelQuote, getFleetTravelQuotes,
  getStrategicRefuelQuote, STRATEGIC_TRAVEL_POLICY } from './campaignTravel';
import { advanceConquestShipTravel, advanceShipTravel, campaignShipsSchema, conquestShipsSchema,
  CAMPAIGN_FUEL_CAPACITY, getRefuelQuote, MAX_CAMPAIGN_SHIPS, TRAVEL_FUEL_COST,
  type CampaignShip } from './campaignShips';
import { campaignFleetsSchema, createCampaignFleets, conquestFleetsSchema, fleetIdSchema, fleetShipIdsSchema,
  getFleetTransit, isShipInFleet, MAX_CAMPAIGN_FLEETS, MAX_FLEET_ID, type CampaignFleet,
  type ConquestFleet } from './campaignFleets';
import { advanceProduction, createProductionState, getConquestProductionRefund, getProductionQuote,
  getProductionRefund, MAX_COLONY_QUEUE, MAX_ORDER_ID, MAX_PRODUCTION_RECORDS, orderIdSchema,
  productionStateSchema, conquestProductionStateSchema, type ConquestProductionView,
  type ProductionView } from './production';
import { advanceSchedule, campaignScheduleSchema, createCampaignSchedule, getActiveParticipant,
  MAX_TURN } from './campaignSchedule';
export { MAX_RESOURCE, treasurySchema, type Treasury } from './campaignEconomy';
export { MAX_TURN, type CampaignSchedule } from './campaignSchedule';

// Provisional economy, deliberately separate from tactical energy, cargo and service modules.
const turnSchema = z.number().int().min(1).max(MAX_TURN);
const initialTreasury: Readonly<Treasury> = { credits: 100, minerals: 50 };
const colonyIncome: Readonly<Treasury> = { credits: 10, minerals: 5 };

/** Мирная песочница: turn — единственный источник хода (odd=blue, even=red), формат Н16 не мигрирует. */
export const campaignSessionSchema = z.object({
  galaxy: campaignStateSchema,
  turn: turnSchema,
  treasuries: z.object({ blue: treasurySchema, red: treasurySchema }).strict(),
  production: productionStateSchema,
  ships: campaignShipsSchema,
  fleets: campaignFleetsSchema
}).strict().superRefine((state, ctx) => {
  if (state.galaxy.map) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Сгенерированная карта требует военную кампанию' });
  }
  for (const record of [...state.production.orders, ...state.production.completed]) {
    if (state.galaxy.systems.find(system => system.id === record.systemId)?.ownerId !== record.factionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Производственная запись требует собственную колонию' });
    }
  }
  const productionIds = new Set([...state.production.orders, ...state.production.completed].map(record => record.id));
  const shipsById = new Map(state.ships.map(ship => [ship.id, ship]));
  const systemIds = new Set(state.galaxy.systems.map(system => system.id));
  for (const fleet of state.fleets.items) {
    if (!systemIds.has(fleet.systemId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Система группы отсутствует на карте' });
    if (state.galaxy.systems.find(system => system.id === fleet.systemId)?.ownerId !== fleet.factionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Группа требует собственную колонию' });
    }
    const route = shipsById.get(fleet.shipIds[0])?.transit;
    for (const id of fleet.shipIds) {
      const ship = shipsById.get(id);
      if (!ship || ship.factionId !== fleet.factionId || ship.systemId !== fleet.systemId ||
        ship.transit?.destinationId !== route?.destinationId || ship.transit?.remainingTurns !== route?.remainingTurns) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Участники группы требуют общую свою колонию и согласованный перелёт' });
      }
    }
  }
  for (const ship of state.ships) {
    if (!systemIds.has(ship.systemId) || (ship.transit &&
      (!systemIds.has(ship.transit.destinationId) || !areSystemsAdjacent(ship.systemId, ship.transit.destinationId, state.galaxy)))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Корабль и маршрут должны принадлежать карте партии' });
    }
    if (productionIds.has(ship.id) || ship.id > state.production.lastOrderId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Корабль требует отдельный ранее выданный идентификатор производства' });
    }
    // Travel is restricted to own colonies at both ends; capture is not implemented.
    if (state.galaxy.systems.find(system => system.id === ship.systemId)?.ownerId !== ship.factionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Размещённый корабль требует собственную колонию' });
    }
    if (ship.transit && state.galaxy.systems.find(system => system.id === ship.transit!.destinationId)?.ownerId !== ship.factionId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Цель перелёта требует собственную колонию' });
    }
  }
});
export type CampaignSession = z.infer<typeof campaignSessionSchema>;

/**
 * Н17.2: сессия военной кампании — расписание ходов вместо parity, казна и записи
 * по участникам `player-NN`. Активная сторона берётся из расписания; порядок
 * расписания обязан совпадать с участниками карты (или фиксированного сценария).
 */
export const conquestSessionSchema = z.object({
  galaxy: conquestGalaxyStateSchema,
  schedule: campaignScheduleSchema,
  treasuries: z.record(participantIdSchema, treasurySchema),
  production: conquestProductionStateSchema,
  ships: conquestShipsSchema,
  fleets: conquestFleetsSchema
}).strict().superRefine((state, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const participants = getCampaignParticipants(state.galaxy).map(participant => participant.id);
  if (state.schedule.order.join('\n') !== participants.join('\n')) {
    fail('Расписание должно повторять участников кампании в их порядке');
  }
  if (Object.keys(state.treasuries).sort().join('\n') !== [...participants].sort().join('\n')) {
    fail('Казна требуется ровно у участников кампании');
  }
  for (const record of [...state.production.orders, ...state.production.completed]) {
    if (state.galaxy.systems.find(system => system.id === record.systemId)?.ownerId !== record.factionId) {
      fail('Производственная запись требует собственную колонию');
    }
  }
  for (const participant of participants) {
    if ([...state.production.orders, ...state.production.completed]
      .filter(record => record.factionId === participant).length > MAX_PRODUCTION_RECORDS) {
      fail('Превышен предел производственных записей стороны');
    }
    if (state.ships.filter(ship => ship.factionId === participant).length > MAX_CAMPAIGN_SHIPS) {
      fail('Превышен предел стратегических кораблей стороны');
    }
    if (state.fleets.items.filter(fleet => fleet.factionId === participant).length > MAX_CAMPAIGN_FLEETS) {
      fail('Превышен предел групп стороны');
    }
  }
  const productionIds = new Set([...state.production.orders, ...state.production.completed].map(record => record.id));
  const shipsById = new Map(state.ships.map(ship => [ship.id, ship]));
  const systemIds = new Set(state.galaxy.systems.map(system => system.id));
  for (const fleet of state.fleets.items) {
    if (!systemIds.has(fleet.systemId)) fail('Система группы отсутствует на карте');
    const route = shipsById.get(fleet.shipIds[0])?.transit;
    for (const id of fleet.shipIds) {
      const ship = shipsById.get(id);
      if (!ship || ship.factionId !== fleet.factionId || ship.systemId !== fleet.systemId ||
        ship.transit?.destinationId !== route?.destinationId || ship.transit?.remainingTurns !== route?.remainingTurns) {
        fail('Участники группы требуют общую свою колонию и согласованный перелёт');
      }
    }
  }
  for (const ship of state.ships) {
    if (ship.transit && 'policy' in ship.transit &&
      systemIds.has(ship.systemId) && systemIds.has(ship.transit.destinationId)) {
      const route = ship.transit;
      const fleet = state.fleets.items.find(item => item.shipIds.includes(ship.id));
      const members = fleet ? state.ships.filter(item => fleet.shipIds.includes(item.id)) : [ship];
      const own = getTravelCapabilities(ship.design.strategicEquipment);
      const caps = { ...own,
        strategicSpeed: Math.min(...members.map(item => getTravelCapabilities(item.design.strategicEquipment).strategicSpeed)),
        maxJumpDistance: Math.min(...members.map(item => getTravelCapabilities(item.design.strategicEquipment).maxJumpDistance)) };
      const distance = getWorldDistance(getGalaxyDefinition(state.galaxy).systems, ship.systemId, route.destinationId);
      const quote = getTravelQuote(distance, caps, caps.fuelCapacity);
      if (!quote.ok || route.distance !== distance || route.totalTurns !== quote.totalTurns ||
        route.fuelCost !== quote.fuelCost || ship.fuel + route.fuelCost > own.fuelCapacity ||
        Object.entries(caps).some(([key, value]) => route.capabilities[key as keyof typeof caps] !== value)) {
        fail('Снимок перелёта не согласован с проектом и картой');
      }
    }
    if (!systemIds.has(ship.systemId) || (ship.transit && !systemIds.has(ship.transit.destinationId))) {
      fail('Корабль и маршрут должны принадлежать карте партии');
    }
    if (productionIds.has(ship.id) || ship.id > state.production.lastOrderId) {
      fail('Корабль требует отдельный ранее выданный идентификатор производства');
    }
  }
});
export type ConquestSession = z.infer<typeof conquestSessionSchema>;

export function createCampaignSession(): CampaignSession {
  return { galaxy: createCampaignState(), turn: 1,
    treasuries: { blue: { ...initialTreasury }, red: { ...initialTreasury } }, production: createProductionState(), ships: [],
    fleets: createCampaignFleets() };
}

/** Н17.2: военная сессия создаётся с расписанием участников и казной для каждого. */
export function createConquestSession(map?: GalaxyMap): ConquestSession {
  const galaxy = createConquestState(map);
  // Участники берутся из проверенного (канонизированного) снимка состояния, а не из сырого входа.
  const participants = getCampaignParticipants(galaxy).map(participant => participant.id);
  const treasuries = Object.fromEntries(participants.map(id => [id, { ...initialTreasury }]));
  return { galaxy, schedule: createCampaignSchedule(participants),
    treasuries, production: createProductionState(), ships: [], fleets: createCampaignFleets() };
}

export const sessionCommandSchema = z.discriminatedUnion('kind', [
  campaignCommandSchema.options[0].extend({ expectedTurn: turnSchema }),
  campaignCommandSchema.options[1].extend({ expectedTurn: turnSchema }),
  z.object({ kind: z.literal('endTurn'), factionId: factionIdSchema, expectedTurn: turnSchema }).strict(),
  z.object({ kind: z.literal('enqueueProduction'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, design: designSchema }).strict(),
  z.object({ kind: z.literal('cancelProduction'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, orderId: orderIdSchema }).strict(),
  z.object({ kind: z.literal('deployProduction'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, orderId: orderIdSchema }).strict(),
  z.object({ kind: z.literal('sendShip'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, shipId: orderIdSchema, destinationId: systemIdSchema }).strict(),
  z.object({ kind: z.literal('refuelShip'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, shipId: orderIdSchema }).strict(),
  z.object({ kind: z.literal('createFleet'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, shipIds: fleetShipIdsSchema }).strict(),
  z.object({ kind: z.literal('disbandFleet'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, fleetId: fleetIdSchema }).strict(),
  z.object({ kind: z.literal('sendFleet'), factionId: factionIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, fleetId: fleetIdSchema, destinationId: systemIdSchema }).strict()
]);
export type SessionCommand = z.infer<typeof sessionCommandSchema>;

/** Н17.2: команды военной сессии адресуются участнику `player-NN` (explore остаётся формой мирного слоя). */
export const conquestSessionCommandSchema = z.discriminatedUnion('kind', [
  conquestGalaxyCommandSchema.options[0].extend({ expectedTurn: turnSchema }),
  conquestGalaxyCommandSchema.options[1].extend({ expectedTurn: turnSchema }),
  z.object({ kind: z.literal('endTurn'), factionId: participantIdSchema, expectedTurn: turnSchema }).strict(),
  z.object({ kind: z.literal('enqueueProduction'), factionId: participantIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, design: designSchema }).strict(),
  z.object({ kind: z.literal('cancelProduction'), factionId: participantIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, orderId: orderIdSchema }).strict(),
  z.object({ kind: z.literal('deployProduction'), factionId: participantIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, orderId: orderIdSchema }).strict(),
  z.object({ kind: z.literal('sendShip'), factionId: participantIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, shipId: orderIdSchema, destinationId: systemIdSchema }).strict(),
  z.object({ kind: z.literal('refuelShip'), factionId: participantIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, shipId: orderIdSchema }).strict(),
  z.object({ kind: z.literal('createFleet'), factionId: participantIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, shipIds: fleetShipIdsSchema }).strict(),
  z.object({ kind: z.literal('disbandFleet'), factionId: participantIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, fleetId: fleetIdSchema }).strict(),
  z.object({ kind: z.literal('sendFleet'), factionId: participantIdSchema, expectedTurn: turnSchema,
    systemId: systemIdSchema, fleetId: fleetIdSchema, destinationId: systemIdSchema }).strict()
]);
export type ConquestSessionCommand = z.infer<typeof conquestSessionCommandSchema>;
export type SessionErrorCode = CampaignErrorCode | 'STALE_TURN' | 'NOT_ACTIVE_FACTION' | 'RESOURCE_LIMIT' | 'TURN_LIMIT' |
  'NOT_OWN_COLONY' | 'INVALID_DESIGN' | 'INSUFFICIENT_RESOURCES' | 'QUEUE_FULL' | 'PRODUCTION_LIMIT' | 'ORDER_NOT_FOUND' | 'ORDER_ID_LIMIT' |
  'COMPLETED_NOT_FOUND' | 'SHIP_LIMIT' | 'SHIP_NOT_FOUND' | 'SHIP_IN_TRANSIT' | 'INVALID_ROUTE' | 'INSUFFICIENT_FUEL' | 'FUEL_FULL' |
  'SHIP_IN_FLEET' | 'FLEET_LIMIT' | 'FLEET_ID_LIMIT' | 'FLEET_NOT_FOUND' | 'FLEET_IN_TRANSIT';
export interface EndTurnEconomy extends EndTurnBudget {
  factionId: CampaignFactionId | ParticipantId;
  turn: number;
}
export type EconomyForecast = EconomyCalculation | { ok: false; code: 'TURN_LIMIT' };

function activeFaction(turn: number): CampaignFactionId { return turn % 2 === 1 ? 'blue' : 'red'; }

/** Income is derived, never cached in persistent state. */
function incomeFor(galaxy: { systems: readonly { id: SystemId; ownerId: string | null }[] }, factionId: string): Treasury {
  const colonies = galaxy.systems.filter(system => system.ownerId === factionId).length;
  return { credits: colonies * colonyIncome.credits, minerals: colonies * colonyIncome.minerals };
}

/** Hypothetical own endTurn, including for an inactive observer; never command authorization. */
function economyFor(state: CampaignSession, factionId: CampaignFactionId, military = false): EconomyForecast {
  if (state.turn === MAX_TURN) return { ok: false, code: 'TURN_LIMIT' };
  return calculateEndTurnEconomy(state.treasuries[factionId], incomeFor(state.galaxy, factionId),
    getUpkeepQuote(state.ships, factionId, military));
}

/** Н17.2: гипотетический собственный endTurn участника военной кампании. */
function conquestEconomyFor(state: ConquestSession, participant: ParticipantId): EconomyForecast {
  if (state.schedule.turn === MAX_TURN) return { ok: false, code: 'TURN_LIMIT' };
  return calculateEndTurnEconomy(state.treasuries[participant], incomeFor(state.galaxy, participant),
    getUpkeepQuote(state.ships, participant, true));
}

export type SessionResult = { ok: true; state: CampaignSession; endTurnEconomy?: EndTurnEconomy } |
  { ok: false; code: SessionErrorCode; message: string };
export type ConquestSessionResult = { ok: true; state: ConquestSession; endTurnEconomy?: EndTurnEconomy } |
  { ok: false; code: SessionErrorCode; message: string };

/** Pure session boundary. Callers must keep the returned state; this is not network deduplication. */
export function executeSessionCommand(inputState: unknown, inputCommand: unknown): SessionResult {
  const parsedState = campaignSessionSchema.safeParse(inputState);
  if (!parsedState.success) return { ok: false, code: 'INVALID_STATE', message: 'Недопустимое состояние стратегической партии' };
  const parsedCommand = sessionCommandSchema.safeParse(inputCommand);
  if (!parsedCommand.success) return { ok: false, code: 'INVALID_COMMAND', message: 'Недопустимая стратегическая команда' };
  const state = parsedState.data;
  const command = parsedCommand.data;
  const canTravel = (from: SystemId, to: SystemId) => areSystemsAdjacent(from, to, state.galaxy);
  if (command.expectedTurn !== state.turn) {
    return { ok: false, code: 'STALE_TURN', message: 'Номер хода изменился; обновите состояние перед командой' };
  }
  if (command.factionId !== activeFaction(state.turn)) {
    return { ok: false, code: 'NOT_ACTIVE_FACTION', message: 'Сейчас ход другой стороны' };
  }
  if (('systemId' in command && !state.galaxy.systems.some(system => system.id === command.systemId)) ||
    ('destinationId' in command && !state.galaxy.systems.some(system => system.id === command.destinationId))) {
    return { ok: false, code: 'INVALID_COMMAND', message: 'Система отсутствует на карте партии' };
  }
  if (command.kind === 'createFleet' || command.kind === 'disbandFleet' || command.kind === 'sendFleet') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Группировка доступна только в своей колонии' };
    }
    if (command.kind === 'disbandFleet' || command.kind === 'sendFleet') {
      const index = state.fleets.items.findIndex(fleet => fleet.id === command.fleetId &&
        fleet.factionId === command.factionId && fleet.systemId === command.systemId);
      if (index < 0) return { ok: false, code: 'FLEET_NOT_FOUND', message: 'Своя группа не найдена в указанной колонии' };
      const fleet = state.fleets.items[index];
      if (getFleetTransit(fleet, state.ships)) {
        return { ok: false, code: 'FLEET_IN_TRANSIT', message: 'Группа уже в пути; дождитесь прибытия' };
      }
      if (command.kind === 'disbandFleet') {
        state.fleets.items.splice(index, 1);
        return { ok: true, state };
      }
      if (state.galaxy.systems.find(system => system.id === command.destinationId)!.ownerId !== command.factionId) {
        return { ok: false, code: 'NOT_OWN_COLONY', message: 'Перелёт доступен только в свою колонию' };
      }
      if (!canTravel(command.systemId, command.destinationId)) {
        return { ok: false, code: 'INVALID_ROUTE', message: 'Цель вне доступной дальности или маршрута' };
      }
      // Membership was validated at the session boundary. Check every tank before any debit.
      const members = state.ships.filter(ship => fleet.shipIds.includes(ship.id));
      if (members.some(ship => ship.fuel < TRAVEL_FUEL_COST)) {
        return { ok: false, code: 'INSUFFICIENT_FUEL', message: 'Недостаточно топлива у одного из кораблей группы; нужна заправка' };
      }
      for (const ship of members) {
        ship.fuel -= TRAVEL_FUEL_COST;
        ship.transit = { destinationId: command.destinationId, remainingTurns: 1 };
      }
      return { ok: true, state };
    }
    // Validate every member before allocating an ID or publishing membership.
    for (const id of command.shipIds) {
      const ship = state.ships.find(item => item.id === id && item.factionId === command.factionId && item.systemId === command.systemId);
      if (!ship) return { ok: false, code: 'SHIP_NOT_FOUND', message: 'Свой корабль не найден в указанной системе' };
      if (ship.transit) return { ok: false, code: 'SHIP_IN_TRANSIT', message: 'Корабль уже в пути' };
      if (isShipInFleet(state.fleets.items, id)) {
        return { ok: false, code: 'SHIP_IN_FLEET', message: 'Корабль входит в группу; сначала расформируйте её' };
      }
    }
    if (state.fleets.items.filter(fleet => fleet.factionId === command.factionId).length >= MAX_CAMPAIGN_FLEETS) {
      return { ok: false, code: 'FLEET_LIMIT', message: 'Достигнут предел групп стороны' };
    }
    if (state.fleets.lastFleetId === MAX_FLEET_ID) {
      return { ok: false, code: 'FLEET_ID_LIMIT', message: 'Достигнут предел идентификаторов групп' };
    }
    state.fleets.items.push({ id: ++state.fleets.lastFleetId, factionId: command.factionId,
      systemId: command.systemId, shipIds: command.shipIds });
    return { ok: true, state };
  }
  if (command.kind === 'sendShip' || command.kind === 'refuelShip') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Операция корабля доступна только в своей колонии' };
    }
    const ship = state.ships.find(item => item.id === command.shipId && item.factionId === command.factionId && item.systemId === command.systemId);
    if (!ship) return { ok: false, code: 'SHIP_NOT_FOUND', message: 'Свой корабль не найден в указанной системе' };
    if (ship.transit) return { ok: false, code: 'SHIP_IN_TRANSIT', message: 'Корабль уже в пути' };
    if (command.kind === 'refuelShip') {
      const quote = getRefuelQuote(ship.fuel), treasury = state.treasuries[command.factionId];
      if (quote.amount === 0) return { ok: false, code: 'FUEL_FULL', message: 'Топливный бак уже полон' };
      if (treasury.credits < quote.cost.credits || treasury.minerals < quote.cost.minerals) {
        return { ok: false, code: 'INSUFFICIENT_RESOURCES', message: 'Недостаточно ресурсов для полной заправки' };
      }
      treasury.credits -= quote.cost.credits; treasury.minerals -= quote.cost.minerals;
      ship.fuel = CAMPAIGN_FUEL_CAPACITY;
      return { ok: true, state };
    }
    if (isShipInFleet(state.fleets.items, ship.id)) {
      return { ok: false, code: 'SHIP_IN_FLEET', message: 'Корабль входит в группу; сначала расформируйте её' };
    }
    if (state.galaxy.systems.find(system => system.id === command.destinationId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Перелёт доступен только в свою колонию' };
    }
    if (!canTravel(command.systemId, command.destinationId)) {
      return { ok: false, code: 'INVALID_ROUTE', message: 'Цель вне доступной дальности или маршрута' };
    }
    if (ship.fuel < TRAVEL_FUEL_COST) {
      return { ok: false, code: 'INSUFFICIENT_FUEL', message: 'Недостаточно стратегического топлива; нужна заправка' };
    }
    ship.fuel -= TRAVEL_FUEL_COST;
    ship.transit = { destinationId: command.destinationId, remainingTurns: 1 };
    return { ok: true, state };
  }
  if (command.kind === 'deployProduction') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Размещение доступно только в своей колонии' };
    }
    const index = state.production.completed.findIndex(record => record.id === command.orderId &&
      record.factionId === command.factionId && record.systemId === command.systemId);
    if (index < 0) return { ok: false, code: 'COMPLETED_NOT_FOUND', message: 'Готовый проект не найден в колонии' };
    if (state.ships.filter(ship => ship.factionId === command.factionId).length >= MAX_CAMPAIGN_SHIPS) {
      return { ok: false, code: 'SHIP_LIMIT', message: 'Достигнут предел стратегических кораблей стороны' };
    }
    // parsedState is detached; transfer exactly once, retaining the original ID/design/location.
    const [completed] = state.production.completed.splice(index, 1);
    state.ships.push({ ...completed, fuel: CAMPAIGN_FUEL_CAPACITY });
    return { ok: true, state };
  }
  if (command.kind === 'enqueueProduction' || command.kind === 'cancelProduction') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Производство доступно только в своей колонии' };
    }
    const production = state.production, treasury = state.treasuries[command.factionId];
    if (command.kind === 'enqueueProduction') {
      if (validateDesign(command.design, 'flight').length) return { ok: false, code: 'INVALID_DESIGN', message: 'Нужен допустимый полётный проект' };
      if (production.orders.filter(order => order.systemId === command.systemId).length >= MAX_COLONY_QUEUE) {
        return { ok: false, code: 'QUEUE_FULL', message: 'Очередь колонии заполнена' };
      }
      if ([...production.orders, ...production.completed].filter(record => record.factionId === command.factionId).length >= MAX_PRODUCTION_RECORDS) {
        return { ok: false, code: 'PRODUCTION_LIMIT', message: 'Достигнут предел производственных записей стороны' };
      }
      if (production.lastOrderId === MAX_ORDER_ID) return { ok: false, code: 'ORDER_ID_LIMIT', message: 'Достигнут предел идентификаторов заказов' };
      const quote = getProductionQuote(command.design);
      if (treasury.credits < quote.cost.credits || treasury.minerals < quote.cost.minerals) {
        return { ok: false, code: 'INSUFFICIENT_RESOURCES', message: 'Недостаточно ресурсов для заказа' };
      }
      treasury.credits -= quote.cost.credits; treasury.minerals -= quote.cost.minerals;
      production.orders.push({ id: ++production.lastOrderId, factionId: command.factionId, systemId: command.systemId,
        design: command.design, remainingTurns: quote.turns });
    } else {
      const index = production.orders.findIndex(order => order.id === command.orderId && order.systemId === command.systemId && order.factionId === command.factionId);
      if (index < 0) return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Заказ не найден в очереди колонии' };
      const refund = getProductionRefund(production.orders[index]);
      const next = { credits: treasury.credits + refund.credits, minerals: treasury.minerals + refund.minerals };
      if (!treasurySchema.safeParse(next).success) return { ok: false, code: 'RESOURCE_LIMIT', message: 'Возврат превысит предел ресурсов; заказ не отменён' };
      state.treasuries[command.factionId] = next;
      production.orders.splice(index, 1);
    }
    return { ok: true, state };
  }
  if (command.kind === 'explore' || command.kind === 'colonize') {
    // Reuse all map rules without passing the session-only field to the strict map schema.
    const result = executeCampaignCommand(state.galaxy, {
      kind: command.kind, factionId: command.factionId, systemId: command.systemId
    });
    if (!result.ok) return result;
    state.galaxy = result.state;
    return { ok: true, state };
  }
  const economy = economyFor(state, command.factionId);
  if (!economy.ok) {
    return { ok: false, code: economy.code, message: economy.code === 'TURN_LIMIT'
      ? 'Достигнут предел номера хода' : 'Доход превысит предел ресурсов; ход не завершён' };
  }
  const endTurnEconomy: EndTurnEconomy = { factionId: command.factionId, turn: state.turn,
    income: economy.income, upkeep: economy.upkeep, treasuryAfter: economy.treasuryAfter };
  state.treasuries[command.factionId] = { ...economy.treasuryAfter };
  state.production = advanceProduction(state.production, command.factionId);
  // Use the validated members' route before advancing ships; publish both arrivals together.
  for (const fleet of state.fleets.items) {
    const transit = getFleetTransit(fleet, state.ships);
    if (fleet.factionId === command.factionId && transit?.remainingTurns === 1) fleet.systemId = transit.destinationId;
  }
  state.ships = advanceShipTravel(state.ships, command.factionId);
  state.turn += 1;
  return { ok: true, state, endTurnEconomy };
}

/** Н17.2: чистая граница военной сессии; active и turn берутся из расписания. */
export function executeConquestSessionCommand(inputState: unknown, inputCommand: unknown,
  conquestEndTurnBudget?: EndTurnBudget, travelPolicy?: typeof STRATEGIC_TRAVEL_POLICY): ConquestSessionResult {
  const parsedState = conquestSessionSchema.safeParse(inputState);
  if (!parsedState.success) return { ok: false, code: 'INVALID_STATE', message: 'Недопустимое состояние стратегической партии' };
  const parsedCommand = conquestSessionCommandSchema.safeParse(inputCommand);
  if (!parsedCommand.success) return { ok: false, code: 'INVALID_COMMAND', message: 'Недопустимая стратегическая команда' };
  const state = parsedState.data;
  const command = parsedCommand.data;
  if ((command.kind === 'sendShip' || command.kind === 'sendFleet') && travelPolicy !== STRATEGIC_TRAVEL_POLICY) {
    return { ok: false, code: 'INVALID_COMMAND', message: 'Не задана политика возможностей проектов' };
  }
  if (command.expectedTurn !== state.schedule.turn) {
    return { ok: false, code: 'STALE_TURN', message: 'Номер хода изменился; обновите состояние перед командой' };
  }
  if (command.factionId !== getActiveParticipant(state.schedule)) {
    return { ok: false, code: 'NOT_ACTIVE_FACTION', message: 'Сейчас ход другой стороны' };
  }
  if (('systemId' in command && !state.galaxy.systems.some(system => system.id === command.systemId)) ||
    ('destinationId' in command && !state.galaxy.systems.some(system => system.id === command.destinationId))) {
    return { ok: false, code: 'INVALID_COMMAND', message: 'Система отсутствует на карте партии' };
  }
  if (command.kind === 'createFleet' || command.kind === 'disbandFleet' || command.kind === 'sendFleet') {
    if (command.kind === 'disbandFleet' || command.kind === 'sendFleet') {
      const index = state.fleets.items.findIndex(fleet => fleet.id === command.fleetId &&
        fleet.factionId === command.factionId && fleet.systemId === command.systemId);
      if (index < 0) return { ok: false, code: 'FLEET_NOT_FOUND', message: 'Своя группа не найдена в указанной колонии' };
      const fleet = state.fleets.items[index];
      if (getFleetTransit(fleet, state.ships)) {
        return { ok: false, code: 'FLEET_IN_TRANSIT', message: 'Группа уже в пути; дождитесь прибытия' };
      }
      if (command.kind === 'disbandFleet') {
        state.fleets.items.splice(index, 1);
        return { ok: true, state };
      }
      // Membership was validated at the session boundary. Check every tank before any debit.
      const members = state.ships.filter(ship => fleet.shipIds.includes(ship.id));
      const distance = getWorldDistance(getGalaxyDefinition(state.galaxy).systems, command.systemId, command.destinationId);
      const quotes = getFleetTravelQuotes(distance, members.map(ship => ({
        capabilities: getTravelCapabilities(ship.design.strategicEquipment), fuel: ship.fuel })));
      const failed = quotes.find(item => !item.quote.ok)?.quote;
      if (failed && !failed.ok) return { ok: false, code: failed.code === 'INSUFFICIENT_FUEL' ? 'INSUFFICIENT_FUEL' : 'INVALID_ROUTE', message: failed.message };
      for (const [index, ship] of members.entries()) {
        const { capabilities, quote } = quotes[index];
        if (!quote.ok) throw new Error('Группа не прошла предварительную проверку');
        ship.fuel -= quote.fuelCost;
        ship.transit = { policy: STRATEGIC_TRAVEL_POLICY, destinationId: command.destinationId,
          distance: quote.distance, totalTurns: quote.totalTurns, fuelCost: quote.fuelCost,
          capabilities, remainingTurns: quote.totalTurns };
      }
      return { ok: true, state };
    }
    // Validate every member before allocating an ID or publishing membership.
    for (const id of command.shipIds) {
      const ship = state.ships.find(item => item.id === id && item.factionId === command.factionId && item.systemId === command.systemId);
      if (!ship) return { ok: false, code: 'SHIP_NOT_FOUND', message: 'Свой корабль не найден в указанной системе' };
      if (ship.transit) return { ok: false, code: 'SHIP_IN_TRANSIT', message: 'Корабль уже в пути' };
      if (isShipInFleet(state.fleets.items, id)) {
        return { ok: false, code: 'SHIP_IN_FLEET', message: 'Корабль входит в группу; сначала расформируйте её' };
      }
    }
    if (state.fleets.items.filter(fleet => fleet.factionId === command.factionId).length >= MAX_CAMPAIGN_FLEETS) {
      return { ok: false, code: 'FLEET_LIMIT', message: 'Достигнут предел групп стороны' };
    }
    if (state.fleets.lastFleetId === MAX_FLEET_ID) {
      return { ok: false, code: 'FLEET_ID_LIMIT', message: 'Достигнут предел идентификаторов групп' };
    }
    state.fleets.items.push({ id: ++state.fleets.lastFleetId, factionId: command.factionId,
      systemId: command.systemId, shipIds: command.shipIds });
    return { ok: true, state };
  }
  if (command.kind === 'sendShip' || command.kind === 'refuelShip') {
    if (command.kind === 'refuelShip' &&
      state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Операция корабля доступна только в своей колонии' };
    }
    const ship = state.ships.find(item => item.id === command.shipId && item.factionId === command.factionId && item.systemId === command.systemId);
    if (!ship) return { ok: false, code: 'SHIP_NOT_FOUND', message: 'Свой корабль не найден в указанной системе' };
    if (ship.transit) return { ok: false, code: 'SHIP_IN_TRANSIT', message: 'Корабль уже в пути' };
    if (command.kind === 'refuelShip') {
      const capacity = getTravelCapabilities(ship.design.strategicEquipment).fuelCapacity;
      const quote = getStrategicRefuelQuote(ship.fuel, capacity), treasury = state.treasuries[command.factionId];
      if (quote.amount === 0) return { ok: false, code: 'FUEL_FULL', message: 'Топливный бак уже полон' };
      if (treasury.credits < quote.cost.credits || treasury.minerals < quote.cost.minerals) {
        return { ok: false, code: 'INSUFFICIENT_RESOURCES', message: 'Недостаточно ресурсов для полной заправки' };
      }
      treasury.credits -= quote.cost.credits; treasury.minerals -= quote.cost.minerals;
      ship.fuel = capacity;
      return { ok: true, state };
    }
    if (isShipInFleet(state.fleets.items, ship.id)) {
      return { ok: false, code: 'SHIP_IN_FLEET', message: 'Корабль входит в группу; сначала расформируйте её' };
    }
    const capabilities = getTravelCapabilities(ship.design.strategicEquipment);
    const quote = getTravelQuote(getWorldDistance(getGalaxyDefinition(state.galaxy).systems,
      command.systemId, command.destinationId), capabilities, ship.fuel);
    if (!quote.ok) return { ok: false, code: quote.code === 'INSUFFICIENT_FUEL' ? 'INSUFFICIENT_FUEL' : 'INVALID_ROUTE', message: quote.message };
    ship.fuel -= quote.fuelCost;
    ship.transit = { policy: STRATEGIC_TRAVEL_POLICY, destinationId: command.destinationId,
      distance: quote.distance, totalTurns: quote.totalTurns, fuelCost: quote.fuelCost,
      capabilities, remainingTurns: quote.totalTurns };
    return { ok: true, state };
  }
  if (command.kind === 'deployProduction') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Размещение доступно только в своей колонии' };
    }
    const index = state.production.completed.findIndex(record => record.id === command.orderId &&
      record.factionId === command.factionId && record.systemId === command.systemId);
    if (index < 0) return { ok: false, code: 'COMPLETED_NOT_FOUND', message: 'Готовый проект не найден в колонии' };
    if (state.ships.filter(ship => ship.factionId === command.factionId).length >= MAX_CAMPAIGN_SHIPS) {
      return { ok: false, code: 'SHIP_LIMIT', message: 'Достигнут предел стратегических кораблей стороны' };
    }
    // parsedState is detached; transfer exactly once, retaining the original ID/design/location.
    const [completed] = state.production.completed.splice(index, 1);
    state.ships.push({ ...completed, fuel: getTravelCapabilities(completed.design.strategicEquipment).fuelCapacity });
    return { ok: true, state };
  }
  if (command.kind === 'enqueueProduction' || command.kind === 'cancelProduction') {
    if (state.galaxy.systems.find(system => system.id === command.systemId)!.ownerId !== command.factionId) {
      return { ok: false, code: 'NOT_OWN_COLONY', message: 'Производство доступно только в своей колонии' };
    }
    const production = state.production, treasury = state.treasuries[command.factionId];
    if (command.kind === 'enqueueProduction') {
      if (validateDesign(command.design, 'flight').length) return { ok: false, code: 'INVALID_DESIGN', message: 'Нужен допустимый полётный проект' };
      if (production.orders.filter(order => order.systemId === command.systemId).length >= MAX_COLONY_QUEUE) {
        return { ok: false, code: 'QUEUE_FULL', message: 'Очередь колонии заполнена' };
      }
      if ([...production.orders, ...production.completed].filter(record => record.factionId === command.factionId).length >= MAX_PRODUCTION_RECORDS) {
        return { ok: false, code: 'PRODUCTION_LIMIT', message: 'Достигнут предел производственных записей стороны' };
      }
      if (production.lastOrderId === MAX_ORDER_ID) return { ok: false, code: 'ORDER_ID_LIMIT', message: 'Достигнут предел идентификаторов заказов' };
      const quote = getProductionQuote(command.design);
      if (treasury.credits < quote.cost.credits || treasury.minerals < quote.cost.minerals) {
        return { ok: false, code: 'INSUFFICIENT_RESOURCES', message: 'Недостаточно ресурсов для заказа' };
      }
      treasury.credits -= quote.cost.credits; treasury.minerals -= quote.cost.minerals;
      production.orders.push({ id: ++production.lastOrderId, factionId: command.factionId, systemId: command.systemId,
        design: command.design, remainingTurns: quote.turns });
    } else {
      const index = production.orders.findIndex(order => order.id === command.orderId && order.systemId === command.systemId && order.factionId === command.factionId);
      if (index < 0) return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Заказ не найден в очереди колонии' };
      const refund = getConquestProductionRefund(production.orders[index]);
      const next = { credits: treasury.credits + refund.credits, minerals: treasury.minerals + refund.minerals };
      if (!treasurySchema.safeParse(next).success) return { ok: false, code: 'RESOURCE_LIMIT', message: 'Возврат превысит предел ресурсов; заказ не отменён' };
      state.treasuries[command.factionId] = next;
      production.orders.splice(index, 1);
    }
    return { ok: true, state };
  }
  if (command.kind === 'explore' || command.kind === 'colonize') {
    return { ok: false, code: 'INVALID_COMMAND', message: 'Изучение и основание требуют полной границы военной кампании' };
  }
  const economy = conquestEndTurnBudget
    ? { ok: true as const, ...conquestEndTurnBudget }
    : conquestEconomyFor(state, command.factionId);
  if (!economy.ok) {
    return { ok: false, code: economy.code, message: economy.code === 'TURN_LIMIT'
      ? 'Достигнут предел номера хода' : 'Доход превысит предел ресурсов; ход не завершён' };
  }
  const endTurnEconomy: EndTurnEconomy = { factionId: command.factionId, turn: state.schedule.turn,
    income: economy.income, upkeep: economy.upkeep, treasuryAfter: economy.treasuryAfter };
  state.treasuries[command.factionId] = { ...economy.treasuryAfter };
  // Use the validated members' route before advancing ships; publish both arrivals together.
  for (const fleet of state.fleets.items) {
    const transit = getFleetTransit(fleet, state.ships);
    if (fleet.factionId === command.factionId && transit?.remainingTurns === 1) fleet.systemId = transit.destinationId;
  }
  state.ships = advanceConquestShipTravel(state.ships, command.factionId);
  // Исключённые участники (нет колоний и нет кораблей, включая транзит) пропускаются расписанием.
  state.schedule = advanceSchedule(state.schedule, participant =>
    !state.galaxy.systems.some(system => system.ownerId === participant) &&
    !state.ships.some(ship => ship.factionId === participant));
  return { ok: true, state, endTurnEconomy };
}

export interface CampaignSessionView {
  galaxy: CampaignView;
  turn: number;
  activeFactionId: CampaignFactionId;
  treasury: Treasury;
  income: Treasury;
  economyForecast: EconomyForecast;
  production: ProductionView;
  ships: CampaignShip[];
  fleets: CampaignFleet[];
}

export interface ConquestSessionView {
  galaxy: ConquestGalaxyView;
  turn: number;
  activeFactionId: ParticipantId;
  treasury: Treasury;
  income: Treasury;
  economyForecast: EconomyForecast;
  production: ConquestProductionView;
  ships: z.infer<typeof conquestShipsSchema>;
  fleets: ConquestFleet[];
}

/** Detached faction view: no opponent treasury/income, even if its colonies are explored.
 * Invalid queries throw ZodError; commands instead return typed failure results.
 */
export function getCampaignSessionView(inputState: CampaignSession, factionId: CampaignFactionId): CampaignSessionView {
  const state = campaignSessionSchema.parse(inputState);
  const faction = factionIdSchema.parse(factionId);
  return { galaxy: getCampaignView(state.galaxy, faction), turn: state.turn,
    activeFactionId: activeFaction(state.turn), treasury: { ...state.treasuries[faction] },
    income: incomeFor(state.galaxy, faction), economyForecast: economyFor(state, faction), production: {
      orders: state.production.orders.filter(order => order.factionId === faction),
      completed: state.production.completed.filter(record => record.factionId === faction)
    }, ships: state.ships.filter(ship => ship.factionId === faction),
    fleets: state.fleets.items.filter(fleet => fleet.factionId === faction) };
}

/** Н17.2: проекция военной сессии для участника; active берётся из расписания. */
export function getConquestSessionView(inputState: ConquestSession, participant: ParticipantId): ConquestSessionView {
  const state = conquestSessionSchema.parse(inputState);
  const faction = participantIdSchema.parse(participant);
  return { galaxy: getConquestGalaxyView(state.galaxy, faction), turn: state.schedule.turn,
    activeFactionId: getActiveParticipant(state.schedule), treasury: { ...state.treasuries[faction] },
    income: incomeFor(state.galaxy, faction), economyForecast: conquestEconomyFor(state, faction), production: {
      orders: state.production.orders.filter(order => order.factionId === faction),
      completed: state.production.completed.filter(record => record.factionId === faction)
    }, ships: state.ships.filter(ship => ship.factionId === faction),
    fleets: state.fleets.items.filter(fleet => fleet.factionId === faction) };
}
