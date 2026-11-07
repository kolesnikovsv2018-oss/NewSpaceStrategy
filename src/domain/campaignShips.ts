import { z } from 'zod';
import { factionIdSchema, participantIdSchema, systemIdSchema, type CampaignFactionId, type ParticipantId, type SystemId } from './campaign';
import { flightDesignSchema, orderIdSchema } from './production';
import type { Treasury } from './campaignEconomy';
import { getTravelCapabilities, STRATEGIC_TRAVEL_POLICY } from './campaignTravel';
import { MAX_PARTICIPANTS } from './galaxyMap';

export const MAX_CAMPAIGN_SHIPS = 100; // Per faction, independent of pending/completed capacity.
/** Н17.1: глобальный предел массива — фиксированная константа «per-faction × MAX_PARTICIPANTS», без «×2». */
export const MAX_CONQUEST_SHIPS = MAX_CAMPAIGN_SHIPS * MAX_PARTICIPANTS;
// Provisional strategic units, deliberately independent of hull, tactical battery and cargo.
export const CAMPAIGN_FUEL_CAPACITY = 3;
export const TRAVEL_FUEL_COST = 1;
export const REFUEL_CREDITS_PER_UNIT = 5;
export const REFUEL_MINERALS_PER_UNIT = 2;
export const campaignFuelSchema = z.number().int().min(0).max(CAMPAIGN_FUEL_CAPACITY);

/** With transit, systemId is the departure colony, not the ship's current physical location. */
export const campaignShipSchema = z.object({
  id: orderIdSchema,
  factionId: factionIdSchema,
  systemId: systemIdSchema,
  design: flightDesignSchema,
  fuel: campaignFuelSchema,
  transit: z.object({ destinationId: systemIdSchema, remainingTurns: z.literal(1) }).strict().optional()
}).strict().superRefine((ship, ctx) => {
  if (ship.transit && ship.systemId === ship.transit.destinationId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Цель перелёта должна отличаться от исходной системы' });
  }
});
const capabilitySchema = z.object({
  strategicSpeed: z.number().finite().positive().max(200),
  maxJumpDistance: z.number().finite().positive().max(1500),
  fuelCapacity: z.number().int().min(1).max(9000),
  fuelConsumptionPerDistance: z.number().finite().positive().max(5)
}).strict();
export const strategicTransitSchema = z.object({
  policy: z.literal(STRATEGIC_TRAVEL_POLICY), destinationId: systemIdSchema,
  distance: z.number().finite().positive().max(1500), capabilities: capabilitySchema,
  totalTurns: z.number().int().min(1).max(1_000_000_000),
  remainingTurns: z.number().int().min(1).max(1_000_000_000),
  fuelCost: z.number().int().min(1).max(9000)
}).strict();
/** Н17.2: военный корабль принадлежит участнику `player-NN`, не enum. */
export const strategicShipSchema = z.object({
  id: orderIdSchema, factionId: participantIdSchema, systemId: systemIdSchema, design: flightDesignSchema,
  fuel: z.number().int().min(0).max(9000), transit: strategicTransitSchema.optional()
}).strict().superRefine((ship, ctx) => {
  if (ship.fuel > getTravelCapabilities(ship.design.strategicEquipment).fuelCapacity ||
    ship.transit && (ship.transit.destinationId === ship.systemId || ship.transit.remainingTurns > ship.transit.totalTurns)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Недопустимый запас топлива или маршрут проекта' });
  }
});
export type CampaignShip = z.infer<typeof campaignShipSchema> | z.infer<typeof strategicShipSchema>;

/** Detached quote for filling the tank; session checks location, turn and affordability. */
export function getRefuelQuote(fuel: number): { amount: number; cost: Treasury } {
  const amount = CAMPAIGN_FUEL_CAPACITY - campaignFuelSchema.parse(fuel);
  return { amount, cost: { credits: amount * REFUEL_CREDITS_PER_UNIT, minerals: amount * REFUEL_MINERALS_PER_UNIT } };
}

function makePeaceShipsSchema() {
  return z.array(campaignShipSchema).max(MAX_CAMPAIGN_SHIPS * 2).superRefine((ships, ctx) => {
    if (new Set(ships.map(ship => ship.id)).size !== ships.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Идентификаторы кораблей должны быть уникальны' });
    }
    for (const faction of factionIdSchema.options) {
      if (ships.filter(ship => ship.factionId === faction).length > MAX_CAMPAIGN_SHIPS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Превышен предел стратегических кораблей стороны' });
      }
    }
  });
}
/** Н17.2: массив кораблей военной кампании; per-participant предел проверяет сессия по списку участников. */
function makeConquestShipsSchema() {
  return z.array(strategicShipSchema).max(MAX_CONQUEST_SHIPS).superRefine((ships, ctx) => {
    if (new Set(ships.map(ship => ship.id)).size !== ships.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Идентификаторы кораблей должны быть уникальны' });
    }
  });
}
export const campaignShipsSchema = makePeaceShipsSchema();
export const conquestShipsSchema = makeConquestShipsSchema();

/** Typed projection selector: a travelling ship is at neither endpoint until arrival. */
export function isShipAtColony(ship: CampaignShip, systemId: SystemId): boolean {
  return !ship.transit && ship.systemId === systemId;
}

/** Advance only own trips; the session publishes matching fleet arrivals atomically. */
function advanceTravel<Ship extends CampaignShip>(ships: Ship[], faction: string): Ship[] {
  for (const ship of ships) {
    if (ship.factionId !== faction || !ship.transit) continue;
    if ('policy' in ship.transit && ship.transit.remainingTurns > 1) {
      ship.transit.remainingTurns--;
      continue;
    }
    ship.systemId = ship.transit.destinationId;
    delete ship.transit;
  }
  return ships;
}

export function advanceShipTravel(input: unknown, factionId: CampaignFactionId): z.infer<typeof campaignShipsSchema> {
  const ships = campaignShipsSchema.parse(input);
  return advanceTravel(ships, factionIdSchema.parse(factionId));
}

/** Н17.2: движение кораблей военной кампании по participant IDs. */
export function advanceConquestShipTravel(input: unknown, participant: ParticipantId): z.infer<typeof conquestShipsSchema> {
  const ships = conquestShipsSchema.parse(input);
  return advanceTravel(ships, participantIdSchema.parse(participant));
}
