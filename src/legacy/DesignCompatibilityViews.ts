import { cargoTotals } from '../domain/cargo';
import { HULLS, type ShipDesign, type ShipStats } from '../domain/shipDesign';
import type { ShipState } from '../domain/shipState';
import type { IPowerSource, IEngine, ICargo } from '../entities/interfaces/ShipComponents';
import { writeEnergy } from '../domain/runtimeNumbers';

type ProjectPowerView = Readonly<Omit<IPowerSource, 'currentEnergy'>> & Pick<IPowerSource, 'currentEnergy'>;

/** Outbound legacy-shaped projections, not components passed into the canonical runtime.
 * Only currentEnergy remains writable. Configuration always comes from the validated design.
 */
export class DesignCompatibilityViews {
  readonly powerSource: ProjectPowerView;
  readonly engine: Readonly<IEngine>;
  readonly cargoHold: Readonly<ICargo>;

  constructor(design: ShipDesign, stats: ShipStats, state: ShipState) {
    this.powerSource = Object.freeze({
      name: 'Энергосистема проекта', cost: 0, weight: 0,
      energyCapacity: stats.energyCapacity, energyOutput: stats.powerGeneration,
      get currentEnergy() { return state.energy; },
      set currentEnergy(value: number) { writeEnergy(state, value, stats.energyCapacity); }
    });
    this.engine = Object.freeze({ name: 'Двигатель проекта', cost: 0, weight: 0,
      thrust: stats.thrust, maxSpeed: stats.speed, energyConsumption: stats.movementPower });
    this.cargoHold = Object.freeze({ name: HULLS[design.hullId].name, cost: stats.cost, weight: stats.mass,
      capacity: stats.cargoVolume, maxWeight: stats.cargoMassLimit,
      get usedSpace() { return cargoTotals(state.cargo).volume; },
      get currentWeight() { return cargoTotals(state.cargo).mass; }
    });
  }

  /** Preserve energy-only replacement used by old clients; reject silent edits of design configuration. */
  replacePowerSource(source: IPowerSource): void {
    const view = this.powerSource;
    if (!source || ['name', 'cost', 'weight', 'energyCapacity', 'energyOutput'].some(key =>
      source[key as keyof IPowerSource] !== view[key as keyof IPowerSource])) {
      throw new Error('Энергосистема проекта изменяется только через ShipDesign');
    }
    view.currentEnergy = source.currentEnergy;
  }
}