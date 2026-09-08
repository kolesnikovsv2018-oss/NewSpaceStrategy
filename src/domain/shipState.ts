import type { ShipStats } from './shipDesign';
import type { CargoItem } from './cargo';

export interface ShipPosition { x: number; y: number }
export interface WeaponState {
  slotId: string;
  cooldown: number; // Seconds remaining, not the weapon's configured firing period.
  ammo: number | null; // null means unlimited ammunition.
}

/** Mutable tactical state only: no components, derived stats, Phaser objects or target references. */
export interface ShipState {
  position: ShipPosition;
  velocity: ShipPosition;
  isMoving: boolean;
  isDestroyed: boolean;
  energy: number;
  hull: number;
  shield: number;
  shieldDelayRemaining: number;
  weapons: WeaponState[];
  cargo: CargoItem[];
}

export function createShipState(energy = 0): ShipState {
  return { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, isMoving: false,
    isDestroyed: false, energy, hull: 0, shield: 0, shieldDelayRemaining: 0, weapons: [], cargo: [] };
}

export function createDesignState(stats: ShipStats): ShipState {
  return { ...createShipState(stats.energyCapacity), hull: stats.hitPoints, shield: stats.shield,
    weapons: stats.weapons.map(({ slotId, definition }) => ({ slotId, cooldown: 0,
      ammo: definition.kind === 'projectile' ? definition.ammoCapacity : null })) };
}

/** Detached snapshot for diagnostics/views. Not a battle-save format or a restore API. */
export function snapshotShipState(state: ShipState): ShipState {
  return { ...state, position: { ...state.position }, velocity: { ...state.velocity },
    weapons: state.weapons.map(weapon => ({ ...weapon })), cargo: state.cargo.map(item => ({ ...item })) };
}
