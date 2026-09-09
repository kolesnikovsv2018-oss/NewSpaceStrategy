import { v1DesignSchema } from '../../src/domain/shipDesign';

/** Frozen shape of an actual pre-service six-slot design; does not use the current factory. */
export function createV1Design() {
  return v1DesignSchema.parse({ schemaVersion: 1, id: 'v1-corvette', name: 'Архивный корвет', hullId: 'corvette',
    createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T11:00:00.000Z',
    slots: [
      { id: 'beam_1', component: { id: 'old-beam', name: 'Лазер', kind: 'beam', damage: 25, range: 500, fireRate: 2, accuracy: 0.8 } },
      { id: 'beam_2', component: null }, { id: 'projectile_1', component: null },
      { id: 'engine_1', component: { id: 'old-engine', name: 'Двигатель', kind: 'engine', thrust: 1000,
        maxSpeed: 200, maneuverability: 0.7, powerGeneration: 600 } },
      { id: 'shield_1', component: null }, { id: 'armor_1', component: null }
    ] });
}