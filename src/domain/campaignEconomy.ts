import { z } from 'zod';

// Strategic resources, unrelated to tactical energy and cargo lots.
export const MAX_RESOURCE = 1_000_000_000;
const amountSchema = z.number().int().min(0).max(MAX_RESOURCE);
export const treasurySchema = z.object({ credits: amountSchema, minerals: amountSchema }).strict();
export type Treasury = z.infer<typeof treasurySchema>;
