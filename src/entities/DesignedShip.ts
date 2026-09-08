import { CombatShip } from './CombatShip';
import type { IAttackResult } from './interfaces/CombatSystem';
import type { IEquipment } from './interfaces/ShipComponents';
import { createDesignState, type WeaponState } from '../domain/shipState';
import { cargoTotals, type CargoLimits } from '../domain/cargo';
import { calculateShipStats, designSchema, HULLS, newId, validateDesign,
  type ShipDesign, type ShipStats } from '../domain/shipDesign';

/** Runtime instance of an immutable design snapshot. The legacy base is only a compatibility boundary for scenes/AI. */
export class DesignedShip extends CombatShip {
  private readonly design: ShipDesign;
  private readonly stats: ShipStats;

  constructor(input: ShipDesign, factionId: string, mode: 'flight' | 'battle' = 'battle') {
    const issues = validateDesign(input, mode);
    if (issues.length) throw new Error(issues.map(issue => issue.message).join('\n'));
    const design = designSchema.parse(input);
    const stats = calculateShipStats(design);
    super(newId('ship'), design.name,
      { name: 'Энергосистема проекта', cost: 0, weight: 0, energyCapacity: stats.energyCapacity,
        currentEnergy: stats.energyCapacity, energyOutput: stats.powerGeneration },
      { name: 'Двигатель проекта', cost: 0, weight: 0, thrust: stats.thrust,
        maxSpeed: stats.speed, energyConsumption: stats.movementPower },
      { name: HULLS[design.hullId].name, cost: stats.cost, weight: stats.mass,
        capacity: stats.cargoVolume, usedSpace: 0, maxWeight: stats.cargoMassLimit, currentWeight: 0 }, factionId);
    this.design = design;
    this.stats = stats;
    this.combatStats = { maxHull: stats.hitPoints, currentHull: stats.hitPoints,
      maxShield: stats.shield, currentShield: stats.shield, shieldRegenRate: stats.shieldRegen,
      armor: stats.armor, evasion: stats.evasion };
    // Aggregate summary is for AI/UI only. Each weapon actually shoots on its own cooldown.
    this.weaponStats = { damage: stats.weapons.reduce((sum, item) => sum + item.definition.damage, 0),
      range: Math.max(0, ...stats.weapons.map(item => item.definition.range)),
      fireRate: stats.weapons.reduce((sum, item) => sum + item.definition.fireRate, 0),
      accuracy: 0, energyCost: 0, cooldown: 0, currentCooldown: 0 };
    Object.assign(this.state, createDesignState(stats));
  }

  override getDesign(): ShipDesign { return designSchema.parse(this.design); }
  override getTotalCost(): number { return this.stats.cost; }
  override getTotalWeight(): number { return this.stats.mass + cargoTotals(this.state.cargo).mass; }
  override getCurrentMaxSpeed(): number {
    const mass = cargoTotals(this.state.cargo).mass;
    return mass === 0 ? this.stats.speed : this.stats.speed *
      (this.stats.thrust + this.stats.mass * 0.1) / (this.stats.thrust + (this.stats.mass + mass) * 0.1);
  }
  override getCargoLimits(): CargoLimits { return { mass: this.stats.cargoMassLimit, volume: this.stats.cargoVolume }; }
  override getAvailableCargoSlots(): number { return this.design.slots.length; }
  override getInstalledModuleNames(): string[] { return this.design.slots.flatMap(slot => slot.component ? [slot.component.name] : []); }

  // Refitting belongs to the design editor, not a mutable legacy equipment array.
  override installEquipment(_equipment: IEquipment): boolean { return false; }
  override uninstallEquipment(_equipmentId: string): boolean { return false; }

  getWeaponState(): WeaponState[] {
    return this.state.weapons.map(weapon => ({ ...weapon }));
  }

  override getAttackAttemptsPerStep(): number { return this.state.weapons.length; }

  override attack(target: CombatShip): IAttackResult | null {
    if (this.isDestroyed || target.isDestroyed) return null;
    for (let index = 0; index < this.state.weapons.length; index++) {
      const state = this.state.weapons[index];
      const { definition, energyPerShot } = this.stats.weapons[index];
      if (state.cooldown > 0 || state.ammo === 0 || this.getDistanceTo(target) > definition.range) continue;
      if (!this.consumeEnergy(energyPerShot)) continue;
      state.cooldown = 1 / definition.fireRate;
      if (state.ammo !== null) state.ammo--;
      const hit = Math.random() < definition.accuracy * (1 - target.combatStats.evasion);
      if (!hit) return { hit: false, damage: 0, shieldDamage: 0, hullDamage: 0, critical: false, evaded: true };
      const critical = Math.random() < 0.1;
      return target.takeDamage(definition.damage * (critical ? 2 : 1), critical, definition.kind);
    }
    return null;
  }

  override takeDamage(damage: number, critical = false, damageType: 'beam' | 'projectile' = 'beam'): IAttackResult {
    let remaining = damage;
    let shieldDamage = 0;
    this.state.shieldDelayRemaining = this.stats.shieldDelay;
    if (damageType === 'beam' && this.combatStats.currentShield > 0) {
      remaining *= 1 - this.stats.shieldBeamResistance;
      shieldDamage = Math.min(this.combatStats.currentShield, remaining);
      this.combatStats.currentShield -= shieldDamage;
      remaining -= shieldDamage;
    }
    const resistance = damageType === 'beam' ? this.stats.armorBeamResistance : this.stats.armorProjectileResistance;
    const hullDamage = Math.min(this.combatStats.currentHull, remaining * (1 - resistance) * 100 / (100 + this.stats.armor));
    this.combatStats.currentHull -= hullDamage;
    if (this.combatStats.currentHull <= 0) { this.isDestroyed = true; this.stopMoving(); }
    return { hit: true, damage: shieldDamage + hullDamage, shieldDamage, hullDamage, critical, evaded: false };
  }

  override update(deltaTime: number): void {
    if (this.isDestroyed || !Number.isFinite(deltaTime) || deltaTime <= 0) return;
    this.rechargeEnergy(deltaTime);
    if (this.isMoving) {
      if (this.consumeEnergy(this.stats.movementPower * deltaTime)) {
        this.position.x += this.velocity.x * deltaTime;
        this.position.y += this.velocity.y * deltaTime;
      } else this.stopMoving();
    }
    const regenTime = Math.max(0, deltaTime - this.state.shieldDelayRemaining);
    this.state.shieldDelayRemaining = Math.max(0, this.state.shieldDelayRemaining - deltaTime);
    const restored = Math.min(this.stats.shieldRegen * regenTime,
      this.combatStats.maxShield - this.combatStats.currentShield, this.powerSource.currentEnergy / 3);
    this.consumeEnergy(restored * 3);
    this.combatStats.currentShield += restored;
    this.state.weapons.forEach(state => { state.cooldown = Math.max(0, state.cooldown - deltaTime); });
  }

  override getInfo(): string {
    return `${this.name}\nПроект: ${this.design.id}\nКорпус: ${HULLS[this.design.hullId].name}\n` +
      `Масса: ${this.getTotalWeight().toFixed(1)} т | Стоимость: ${this.stats.cost}\n` +
      `Скорость: ${this.getCurrentMaxSpeed().toFixed(1)} | DPS без критов/защиты: ${this.stats.dps.toFixed(1)}\n` +
      `Энергия: ${this.powerSource.currentEnergy.toFixed(0)}/${this.stats.energyCapacity}\n` +
      `Груз: ${cargoTotals(this.state.cargo).mass.toFixed(1)}/${this.stats.cargoMassLimit.toFixed(1)} т, ` +
      `${cargoTotals(this.state.cargo).volume.toFixed(1)}/${this.stats.cargoVolume} м³\n` +
      `Оборудование: ${this.getInstalledModuleNames().join(', ')}`;
  }
}
