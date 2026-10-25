import { z } from 'zod';

export const worldTypeSchema = z.enum(['habitable', 'toxic', 'barren']);
export type WorldType = z.infer<typeof worldTypeSchema>;
export const environmentStateSchema = z.record(worldTypeSchema);
export type EnvironmentState = z.infer<typeof environmentStateSchema>;

export function getEnvironmentType(environment: EnvironmentState, systemId: string): WorldType {
  if (!Object.prototype.hasOwnProperty.call(environment, systemId)) throw new Error('Среда отсутствующего мира недоступна');
  return environment[systemId];
}
