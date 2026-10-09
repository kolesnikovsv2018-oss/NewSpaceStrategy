import { generateGalaxy } from '../domain/galaxyGenerator';
import { GALAXY_GENERATOR_VERSION, GALAXY_PROFILE_ID } from '../domain/galaxyMap';

export function generateBrowserGalaxy(worldCount: number, seed: number) {
  return generateGalaxy({
    worldCount, participantCount: 2, seed,
    generatorVersion: GALAXY_GENERATOR_VERSION, profileId: GALAXY_PROFILE_ID
  });
}

export function createGalaxySeed(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] || 1;
}
