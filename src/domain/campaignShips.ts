import { z } from 'zod';
import { areSystemsAdjacent, factionIdSchema, systemIdSchema, type CampaignFactionId, type SystemId } from './campaign';
import { flightDesignSchema, orderIdSchema } from './production';

export const MAX_CAMPAIGN_SHIPS = 100; // Per faction, independent of pending/completed capacity.

/** With transit, systemId is the departure colony, not the ship's current physical location. */
export const campaignShipSchema = z.object({
  id: orderIdSchema,
  factionId: factionIdSchema,
  systemId: systemIdSchema,
  design: flightDesignSchema,
  transit: z.object({ destinationId: systemIdSchema, remainingTurns: z.literal(1) }).strict().optional()
}).strict().superRefine((ship, ctx) => {
  if (ship.transit && !areSystemsAdjacent(ship.systemId, ship.transit.destinationId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Перелёт требует прямой переход в другую систему' });
  }
});
export type CampaignShip = z.infer<typeof campaignShipSchema>;

export const campaignShipsSchema = z.array(campaignShipSchema).max(MAX_CAMPAIGN_SHIPS * 2).superRefine((ships, ctx) => {
  if (new Set(ships.map(ship => ship.id)).size !== ships.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Идентификаторы кораблей должны быть уникальны' });
  }
  for (const faction of factionIdSchema.options) {
    if (ships.filter(ship => ship.factionId === faction).length > MAX_CAMPAIGN_SHIPS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Превышен предел стратегических кораблей стороны' });
    }
  }
});

/** Typed projection selector: a travelling ship is at neither endpoint until arrival. */
export function isShipAtColony(ship: CampaignShip, systemId: SystemId): boolean {
  return !ship.transit && ship.systemId === systemId;
}

/** One own endTurn completes every own one-step trip; session validates endpoint ownership first. */
export function advanceShipTravel(input: CampaignShip[], factionId: CampaignFactionId): CampaignShip[] {
  const ships = campaignShipsSchema.parse(input), faction = factionIdSchema.parse(factionId);
  for (const ship of ships) {
    if (ship.factionId !== faction || !ship.transit) continue;
    ship.systemId = ship.transit.destinationId;
    delete ship.transit;
  }
  return ships;
}
