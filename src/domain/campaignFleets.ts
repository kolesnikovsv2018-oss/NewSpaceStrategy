import { z } from 'zod';
import { factionIdSchema, systemIdSchema } from './campaign';
import { orderIdSchema } from './production';

export const MAX_FLEET_ID = 1_000_000_000;
export const MAX_FLEET_SHIPS = 10;
export const MAX_CAMPAIGN_FLEETS = 20; // Per faction; ships still count toward the existing ship cap.
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

export const campaignFleetsSchema = z.object({
  lastFleetId: z.number().int().min(0).max(MAX_FLEET_ID),
  items: z.array(campaignFleetSchema).max(MAX_CAMPAIGN_FLEETS * 2)
}).strict().superRefine((state, ctx) => {
  const ids = new Set<number>(), members = new Set<number>();
  let previousId = 0;
  for (const fleet of state.items) {
    if (ids.has(fleet.id) || fleet.id <= previousId || fleet.id > state.lastFleetId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Группы требуют уникальные возрастающие выданные ID' });
    }
    ids.add(fleet.id); previousId = fleet.id;
    for (const id of fleet.shipIds) {
      if (members.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Корабль уже включён в группу' });
      members.add(id);
    }
  }
  for (const faction of factionIdSchema.options) {
    if (state.items.filter(fleet => fleet.factionId === faction).length > MAX_CAMPAIGN_FLEETS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Превышен предел групп стороны' });
    }
  }
});

export function createCampaignFleets(): z.infer<typeof campaignFleetsSchema> {
  return { lastFleetId: 0, items: [] };
}

/** Typed selector for already validated state or its detached faction projection. */
export function isShipInFleet(fleets: readonly CampaignFleet[], shipId: number): boolean {
  return fleets.some(fleet => fleet.shipIds.includes(shipId));
}
