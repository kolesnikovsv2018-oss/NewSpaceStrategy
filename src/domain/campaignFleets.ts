import { z } from 'zod';
import { factionIdSchema, participantIdSchema, systemIdSchema, type SystemId } from './campaign';
import type { CampaignShip } from './campaignShips';
import { orderIdSchema } from './production';
import { MAX_PARTICIPANTS } from './galaxyMap';

export const MAX_FLEET_ID = 1_000_000_000;
export const MAX_FLEET_SHIPS = 10;
export const MAX_CAMPAIGN_FLEETS = 20; // Per faction; ships still count toward the existing ship cap.
/** Н17.1: глобальный предел массива групп — «per-faction × MAX_PARTICIPANTS», без «×2». */
export const MAX_CONQUEST_FLEETS = MAX_CAMPAIGN_FLEETS * MAX_PARTICIPANTS;
export const fleetIdSchema = z.number().int().min(1).max(MAX_FLEET_ID);
export const fleetShipIdsSchema = z.array(orderIdSchema).min(2).max(MAX_FLEET_SHIPS).superRefine((ids, ctx) => {
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Участники группы должны быть уникальны' });
  }
});

/** Membership lives here only; no duplicated fleetId on ships or tactical runtime instances. */
export const campaignFleetSchema = z.object({
  id: fleetIdSchema,
  factionId: factionIdSchema,
  systemId: systemIdSchema,
  shipIds: fleetShipIdsSchema
}).strict();
export type CampaignFleet = z.infer<typeof campaignFleetSchema>;
/** Н17.2: группа военной кампании принадлежит участнику `player-NN`. */
export const conquestFleetSchema = z.object({
  id: fleetIdSchema,
  factionId: participantIdSchema,
  systemId: systemIdSchema,
  shipIds: fleetShipIdsSchema
}).strict();
export type ConquestFleet = z.infer<typeof conquestFleetSchema>;

function refineFleets(items: readonly { id: number; factionId: string; shipIds: readonly number[] }[],
  lastFleetId: number, ctx: z.RefinementCtx, sides?: readonly string[]): void {
  const ids = new Set<number>(), members = new Set<number>();
  let previousId = 0;
  for (const fleet of items) {
    if (ids.has(fleet.id) || fleet.id <= previousId || fleet.id > lastFleetId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Группы требуют уникальные возрастающие выданные ID' });
    }
    ids.add(fleet.id); previousId = fleet.id;
    for (const id of fleet.shipIds) {
      if (members.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Корабль уже включён в группу' });
      members.add(id);
    }
  }
  // Мирная песочница проверяет пределы внутри схемы; военная — по списку участников в сессии.
  for (const faction of sides ?? []) {
    if (items.filter(fleet => fleet.factionId === faction).length > MAX_CAMPAIGN_FLEETS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Превышен предел групп стороны' });
    }
  }
}

export const campaignFleetsSchema = z.object({
  lastFleetId: z.number().int().min(0).max(MAX_FLEET_ID),
  items: z.array(campaignFleetSchema).max(MAX_CAMPAIGN_FLEETS * 2)
}).strict().superRefine((state, ctx) => refineFleets(state.items, state.lastFleetId, ctx, factionIdSchema.options));
/** Н17.2: массив групп военной кампании; per-participant предел проверяет сессия по списку участников. */
export const conquestFleetsSchema = z.object({
  lastFleetId: z.number().int().min(0).max(MAX_FLEET_ID),
  items: z.array(conquestFleetSchema).max(MAX_CONQUEST_FLEETS)
}).strict().superRefine((state, ctx) => refineFleets(state.items, state.lastFleetId, ctx));

export function createCampaignFleets(): z.infer<typeof campaignFleetsSchema> {
  return { lastFleetId: 0, items: [] };
}

/** Typed selector for already validated state or its detached faction projection. */
export function isShipInFleet(fleets: readonly { shipIds: readonly number[] }[], shipId: number): boolean {
  return fleets.some(fleet => fleet.shipIds.includes(shipId));
}

/** Validated session/view only: all members have identical transit, or none. No second route stored on fleets. */
export function getFleetTransit(fleet: { shipIds: readonly number[] }, ships: readonly CampaignShip[]): CampaignShip['transit'] {
  const transit = ships.find(ship => ship.id === fleet.shipIds[0])?.transit;
  return transit ? structuredClone(transit) : undefined;
}

/** While travelling, fleet.systemId is the origin, not presence in either colony. */
export function isFleetAtColony(fleet: CampaignFleet, ships: readonly CampaignShip[], systemId: SystemId): boolean {
  return fleet.systemId === systemId && !getFleetTransit(fleet, ships);
}
