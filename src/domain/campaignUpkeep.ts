import { factionIdSchema } from './campaign';
import { campaignShipsSchema } from './campaignShips';
import { treasurySchema, type Treasury } from './campaignEconomy';

// Provisional flat tariff: neither fleet membership nor travel grants a discount.
export const UPKEEP_CREDITS_PER_SHIP = 1;
export interface UpkeepQuote { shipCount: number; credits: number }
export interface UpkeepPayment {
  shipCount: number;
  dueCredits: number;
  paidCredits: number;
  shortfallCredits: number;
}
export interface EndTurnBudget {
  income: Treasury;
  upkeep: UpkeepPayment;
  treasuryAfter: Treasury;
}
export type EconomyCalculation = ({ ok: true } & EndTurnBudget) | { ok: false; code: 'RESOURCE_LIMIT' };

/** Strict query boundary; colony ownership and fleet consistency belong to the session. */
export function getUpkeepQuote(inputShips: unknown, inputFaction: unknown): UpkeepQuote {
  const ships = campaignShipsSchema.parse(inputShips), faction = factionIdSchema.parse(inputFaction);
  const shipCount = ships.filter(ship => ship.factionId === faction).length;
  return { shipCount, credits: shipCount * UPKEEP_CREDITS_PER_SHIP };
}

/** Pure calculation for already validated inputs. Gross cap is checked BEFORE any debit. */
export function calculateEndTurnEconomy(treasury: Treasury, income: Treasury, quote: UpkeepQuote): EconomyCalculation {
  const gross = { credits: treasury.credits + income.credits, minerals: treasury.minerals + income.minerals };
  if (!treasurySchema.safeParse(gross).success) return { ok: false, code: 'RESOURCE_LIMIT' };
  const paidCredits = Math.min(gross.credits, quote.credits);
  return { ok: true, income: { ...income },
    upkeep: { shipCount: quote.shipCount, dueCredits: quote.credits, paidCredits,
      shortfallCredits: quote.credits - paidCredits },
    treasuryAfter: { credits: gross.credits - paidCredits, minerals: gross.minerals } };
}