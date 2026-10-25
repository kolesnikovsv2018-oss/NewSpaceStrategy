import { z } from 'zod';
import { createStrategicEquipment, getStrategicEquipmentCost, getTravelCapabilities, STRATEGIC_TRAVEL_POLICY } from './campaignTravel';

const nonnegative = z.number().finite().min(0).max(100000);
const ratio = z.number().finite().min(0).max(1);
const identity = { id: z.string().min(1).max(128), name: z.string().trim().min(1).max(80) };
const componentIdentity = { ...identity, technologyVariant: z.enum(['standard', 'compact']) };
const weapon = {
  damage: z.number().finite().positive().max(100000),
  range: z.number().finite().positive().max(10000),
  fireRate: z.number().finite().min(0.1).max(20),
  accuracy: ratio
};

/** Definitions contain inputs only. Mass/cost/power are derived, never trusted from saves. */
const baseComponentSchema = z.discriminatedUnion('kind', [
  z.object({ ...componentIdentity, kind: z.literal('beam'), tacticalVariant: z.enum(['standard', 'focused']), ...weapon }).strict(),
  z.object({ ...componentIdentity, kind: z.literal('projectile'), tacticalVariant: z.enum(['standard', 'rapid']), ...weapon,
    ammoCapacity: z.number().int().min(1).max(10000) }).strict(),
  z.object({ ...componentIdentity, kind: z.literal('engine'), tacticalVariant: z.enum(['standard', 'high-thrust']), thrust: nonnegative,
    maxSpeed: z.number().finite().min(0).max(1000), maneuverability: ratio,
    powerGeneration: nonnegative }).strict(),
  z.object({ ...componentIdentity, kind: z.literal('shield'), tacticalVariant: z.enum(['standard', 'capacitor']), capacity: nonnegative,
    rechargeRate: nonnegative, rechargeDelay: z.number().finite().min(0).max(60),
    beamResistance: ratio }).strict(),
  z.object({ ...componentIdentity, kind: z.literal('armor'), tacticalVariant: z.enum(['standard', 'composite']), armorPoints: nonnegative,
    beamResistance: ratio, projectileResistance: ratio }).strict()
]);

export const serviceComponentSchema = z.discriminatedUnion('kind', [
  z.object({ ...componentIdentity, tacticalVariant: z.literal('standard'), kind: z.literal('mining'), miningSpeed: nonnegative, efficiency: ratio }).strict(),
  z.object({ ...componentIdentity, tacticalVariant: z.literal('standard'), kind: z.literal('repair'), repairRate: nonnegative }).strict(),
  z.object({ ...componentIdentity, tacticalVariant: z.literal('standard'), kind: z.literal('scanner'), range: nonnegative, accuracy: ratio }).strict(),
  z.object({ ...componentIdentity, tacticalVariant: z.literal('standard'), kind: z.literal('cargoExpansion'), bonusCapacity: nonnegative }).strict()
]);
export const componentSchema = z.discriminatedUnion('kind', [
  ...baseComponentSchema.options, ...serviceComponentSchema.options
]);
export type ServiceDefinition = z.infer<typeof serviceComponentSchema>;
export function isServiceComponent(component: ComponentDefinition): component is ServiceDefinition {
  return component.kind === 'mining' || component.kind === 'repair' || component.kind === 'scanner' || component.kind === 'cargoExpansion';
}
export function componentStatus(component: ComponentDefinition): string {
  if (component.kind === 'cargoExpansion') return 'Расширение объёма действует; предел массы корпуса прежний';
  return isServiceComponent(component) ? 'В испытании действия ещё не исполняются; действуют в военной кампании' : '';
}

export type ComponentDefinition = z.infer<typeof componentSchema>;
export type ComponentKind = ComponentDefinition['kind'];
export const EQUIPMENT_VOLUMES: Readonly<Record<ComponentKind, number>> = Object.freeze({
  beam: 20, projectile: 30, engine: 35, shield: 25, armor: 20, mining: 30, repair: 20, scanner: 15, cargoExpansion: 20
});
export type SlotSize = 'small' | 'medium' | 'large' | 'capital';
export const hullIdSchema = z.enum(['fighter', 'corvette', 'frigate', 'destroyer', 'cruiser', 'battleship', 'colonizer']);
export type HullId = z.infer<typeof hullIdSchema>;
export interface Hardpoint {
  id: string;
  kind: ComponentKind | 'service';
  size: SlotSize;
  x: number;
  y: number;
}
export interface HullDefinition {
  id: HullId;
  name: string;
  mass: number;
  maxMass: number;
  equipmentVolume: number;
  hitPoints: number;
  cost: number;
  energyCapacity: number;
  scale: number;
  slots: Hardpoint[];
}

function slots(size: SlotSize): Hardpoint[] {
  return [
    { id: 'beam_1', kind: 'beam', size, x: -22, y: -25 },
    { id: 'beam_2', kind: 'beam', size, x: 22, y: -25 },
    { id: 'projectile_1', kind: 'projectile', size, x: 0, y: -35 },
    { id: 'engine_1', kind: 'engine', size, x: 0, y: 32 },
    { id: 'shield_1', kind: 'shield', size, x: -24, y: 8 },
    { id: 'armor_1', kind: 'armor', size, x: 24, y: 8 },
    { id: 'service_1', kind: 'service', size, x: -10, y: 18 },
    { id: 'service_2', kind: 'service', size, x: 10, y: 18 }
  ];
}

export const HULLS: Record<HullId, HullDefinition> = {
  fighter: { id: 'fighter', name: 'Истребитель', mass: 30, maxMass: 140, equipmentVolume: 60, hitPoints: 200, cost: 1000, energyCapacity: 1000, scale: 0.7, slots: slots('medium') },
  corvette: { id: 'corvette', name: 'Корвет', mass: 80, maxMass: 350, equipmentVolume: 100, hitPoints: 500, cost: 3000, energyCapacity: 2000, scale: 1, slots: slots('large') },
  frigate: { id: 'frigate', name: 'Фрегат', mass: 150, maxMass: 650, equipmentVolume: 140, hitPoints: 900, cost: 6000, energyCapacity: 3000, scale: 1.15, slots: slots('large') },
  destroyer: { id: 'destroyer', name: 'Эсминец', mass: 250, maxMass: 1000, equipmentVolume: 180, hitPoints: 1400, cost: 10000, energyCapacity: 4500, scale: 1.3, slots: slots('capital') },
  cruiser: { id: 'cruiser', name: 'Крейсер', mass: 400, maxMass: 1600, equipmentVolume: 220, hitPoints: 2200, cost: 16000, energyCapacity: 6500, scale: 1.5, slots: slots('capital') },
  battleship: { id: 'battleship', name: 'Линкор', mass: 650, maxMass: 2400, equipmentVolume: 300, hitPoints: 3500, cost: 25000, energyCapacity: 10000, scale: 1.7, slots: slots('capital') },
  colonizer: { id: 'colonizer', name: 'Колонизатор', mass: 130, maxMass: 350, equipmentVolume: 100, hitPoints: 500, cost: 8000, energyCapacity: 2000, scale: 1, slots: slots('large') }
};

const designFields = {
  ...identity,
  hullId: hullIdSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
};
function checkSlots(design: { hullId: HullId; slots: { id: string }[] }, ctx: z.RefinementCtx): void {
  const expected = HULLS[design.hullId].slots.map(slot => slot.id);
  const actual = design.slots.map(slot => slot.id);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(id => !expected.includes(id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Слоты не соответствуют корпусу' });
  }
}
export const strategicEquipmentSchema = z.object({ policy: z.literal(STRATEGIC_TRAVEL_POLICY),
  drive: z.enum(['standard', 'fast']), jump: z.enum(['standard', 'extended', 'deep', 'galactic']),
  tank: z.enum(['standard', 'extended']) }).strict();
export const designSchema = z.object({ ...designFields, schemaVersion: z.literal(5),
  tacticalRules: z.literal('design-combat-v1'), hullVariant: z.enum(['standard', 'reinforced']),
  strategicEquipment: strategicEquipmentSchema,
  slots: z.array(z.object({ id: z.string().min(1).max(128), component: componentSchema.nullable() }).strict()).max(32)
}).strict().superRefine(checkSlots);
export type ShipDesign = z.infer<typeof designSchema>;

export function acceptsComponent(point: Hardpoint, component: ComponentDefinition): boolean {
  return point.kind === 'service' ? isServiceComponent(component) : component.kind === point.kind;
}

export const COMPONENT_NAMES: Record<ComponentKind, string> = {
  beam: 'Лазер', projectile: 'Пушка', engine: 'Двигатель', shield: 'Щит', armor: 'Броня',
  mining: 'Добыча', repair: 'Ремонт', scanner: 'Сканер', cargoExpansion: 'Трюм+'
};
let sequence = 0;
export const newId = (prefix: string): string => `${prefix}_${Date.now()}_${++sequence}`;
export function createComponent(kind: ComponentKind): ComponentDefinition {
  return createComponentWithId(kind, newId(kind));
}
export function createComponentWithId(kind: ComponentKind, id: string): ComponentDefinition {
  const identity = { id, name: COMPONENT_NAMES[kind], technologyVariant: 'standard' as const, tacticalVariant: 'standard' as const };
  switch (kind) {
    case 'beam': return { ...identity, kind, damage: 25, range: 500, fireRate: 2, accuracy: 0.8 };
    case 'projectile': return { ...identity, kind, damage: 30, range: 300, fireRate: 1.5, accuracy: 0.9, ammoCapacity: 20 };
    case 'engine': return { ...identity, kind, thrust: 1000, maxSpeed: 200, maneuverability: 0.7, powerGeneration: 600 };
    case 'shield': return { ...identity, kind, capacity: 500, rechargeRate: 20, rechargeDelay: 3, beamResistance: 0.3 };
    case 'armor': return { ...identity, kind, armorPoints: 150, beamResistance: 0.2, projectileResistance: 0.3 };
    case 'mining': return { ...identity, kind, miningSpeed: 10, efficiency: 0.8 };
    case 'repair': return { ...identity, kind, repairRate: 5 };
    case 'scanner': return { ...identity, kind, range: 200, accuracy: 0.85 };
    case 'cargoExpansion': return { ...identity, kind, bonusCapacity: 50 };
  }
}

export function createDesign(hullId: HullId = 'corvette', starter = false): ShipDesign {
  const now = new Date().toISOString();
  return {
    schemaVersion: 5, tacticalRules: 'design-combat-v1', hullVariant: 'standard', strategicEquipment: createStrategicEquipment(),
    id: newId('design'), name: `${HULLS[hullId].name} — проект`, hullId,
    slots: HULLS[hullId].slots.map(slot => ({ id: slot.id,
      component: starter && (slot.kind === 'engine' || slot.id === 'beam_1') ? createComponent(slot.kind === 'engine' ? 'engine' : 'beam') : null })),
    createdAt: now, updatedAt: now
  };
}

export interface ComponentStats {
  effective: EffectiveComponent;
  equipmentVolume: number;
  mass: number;
  cost: number;
  power: number; // ЭЕ/с при полной нагрузке, не энергия выстрела.
  energyPerShot: number; // ЭЕ на выстрел.
  slotSize: SlotSize;
}
type Effective<T> = T extends ComponentDefinition ? Omit<T, 'tacticalVariant' | 'technologyVariant'> : never;
export type EffectiveComponent = Effective<ComponentDefinition>;
export const TACTICAL_VARIANTS = {
  beam: 'focused', projectile: 'rapid', engine: 'high-thrust', shield: 'capacitor', armor: 'composite'
} as const;
export function withTacticalVariant(component: ComponentDefinition): ComponentDefinition {
  switch (component.kind) {
    case 'beam': return { ...component, tacticalVariant: 'focused' };
    case 'projectile': return { ...component, tacticalVariant: 'rapid' };
    case 'engine': return { ...component, tacticalVariant: 'high-thrust' };
    case 'shield': return { ...component, tacticalVariant: 'capacitor' };
    case 'armor': return { ...component, tacticalVariant: 'composite' };
    default: return { ...component };
  }
}

function effectiveComponent(source: ComponentDefinition): EffectiveComponent {
  const { tacticalVariant, technologyVariant: _technologyVariant, ...base } = source;
  if (tacticalVariant === 'standard') return base;
  switch (base.kind) {
    case 'engine': return { ...base, thrust: base.thrust * 1.25, maxSpeed: base.maxSpeed * 1.1 };
    case 'beam': return { ...base, damage: base.damage * 1.2, range: base.range * 1.25,
      accuracy: Math.min(1, base.accuracy + 0.05), fireRate: base.fireRate * 0.8 };
    case 'projectile': return { ...base, damage: base.damage * 0.9, range: base.range * 0.9, fireRate: base.fireRate * 1.25 };
    case 'armor': return { ...base, armorPoints: base.armorPoints * 1.25,
      beamResistance: Math.max(0, base.beamResistance - 0.05), projectileResistance: Math.min(1, base.projectileResistance + 0.1) };
    case 'shield': return { ...base, capacity: base.capacity * 1.3,
      rechargeRate: base.rechargeRate * 0.8, rechargeDelay: base.rechargeDelay + 0.5 };
    default: return base;
  }
}

function componentRatings(component: EffectiveComponent) {
  let mass = 0;
  let cost = 0;
  let power = 0;
  let energyPerShot = 0;
  switch (component.kind) {
    case 'beam':
      energyPerShot = component.damage * 2 + component.range / 10;
      power = energyPerShot * component.fireRate;
      mass = component.damage * 0.4 + component.range * 0.01;
      cost = component.damage * 40 + component.range * 2 + component.fireRate * 300 + power * 10;
      break;
    case 'projectile': {
      const projectileMass = component.damage * 0.1 + component.range * 0.002;
      energyPerShot = projectileMass * 50 + component.range / 5;
      power = energyPerShot * component.fireRate;
      mass = component.fireRate * 3 + component.damage * 0.3 + component.range * 0.02 + projectileMass * component.ammoCapacity;
      cost = component.damage * 50 + component.range * 2 + component.fireRate * 300 + component.ammoCapacity * 10;
      break;
    }
    case 'engine':
      mass = component.thrust * 0.02 + component.maxSpeed * 0.1 + component.powerGeneration * 0.02;
      power = component.thrust * 0.03; // Gross consumption; generation counted only once in ShipStats.
      cost = component.thrust * 1.5 + component.maxSpeed * 7 + component.powerGeneration * 20;
      break;
    case 'shield':
      mass = component.capacity * 0.03 + component.rechargeRate * 0.5;
      power = component.rechargeRate * 3; // Active regeneration costs 3 energy per restored shield point.
      cost = component.capacity * 4 + component.rechargeRate * 100 + component.beamResistance * 1000;
      break;
    case 'armor':
      mass = component.armorPoints * 0.15;
      cost = component.armorPoints * 4 + (component.beamResistance + component.projectileResistance) * 800;
      break;
    // Service ratings reserve peak power; active systems are not executed yet.
    case 'mining':
      mass = 20 + component.miningSpeed * 4;
      cost = 1000 + component.miningSpeed * 200 + component.efficiency * 1250;
      power = component.miningSpeed * 5;
      break;
    case 'repair':
      mass = 10 + component.repairRate * 3;
      cost = 500 + component.repairRate * 400;
      power = component.repairRate * 10;
      break;
    case 'scanner':
      mass = 5 + component.range * 0.025;
      cost = 250 + component.range * 2 + component.accuracy * 1000;
      power = component.range * 0.05;
      break;
    case 'cargoExpansion':
      mass = 5 + component.bonusCapacity * 0.3;
      cost = 250 + component.bonusCapacity * 15;
      break;
  }
  return { mass, cost: Math.round(cost), power, energyPerShot };
}

export function calculateComponent(source: ComponentDefinition): ComponentStats {
  const effective = effectiveComponent(source);
  const tactical = source.tacticalVariant !== 'standard';
  const derived = componentRatings(effective);
  if (tactical) {
    const base = source.kind === 'beam' || source.kind === 'projectile' ? derived : componentRatings(source);
    if (source.kind === 'engine') { derived.mass = base.mass * 1.2; derived.power = base.power * 1.35; }
    if (source.kind === 'armor' || source.kind === 'shield') derived.mass = base.mass * 1.15;
    derived.cost = Math.ceil((source.kind === 'beam' || source.kind === 'projectile' ? derived.cost : base.cost) *
      (source.kind === 'beam' || source.kind === 'projectile' ? 1.25 : 1.3));
  }
  const compact = source.technologyVariant === 'compact';
  const volumeTenths = EQUIPMENT_VOLUMES[source.kind] * (tactical ? source.kind === 'armor' ? 11 : 12 : 10);
  return { ...derived, effective, cost: compact ? Math.ceil(derived.cost * 5 / 4) : derived.cost,
    equipmentVolume: volumeTenths * (compact ? 4 : 5) / 50,
    slotSize: derived.mass < 25 ? 'small' : derived.mass < 100 ? 'medium' : derived.mass < 250 ? 'large' : 'capital' };
}

export type WeaponDefinition = Extract<EffectiveComponent, { kind: 'beam' | 'projectile' }>;
export interface ShipStats {
  equipmentVolume: number;
  mass: number;
  cargoVolume: number; // Cubic metres, independent of equipment hardpoints.
  cargoMassLimit: number; // Tonnes after accounting for installed modules and hull maxMass.
  cost: number;
  hitPoints: number;
  speed: number; // Тактические единицы расстояния / с симуляции (без груза).
  thrust: number;
  evasion: number;
  powerGeneration: number; // ЭЕ/с.
  movementPower: number; // ЭЕ/с во время движения.
  peakPower: number; // ЭЕ/с, включая номиналы пока неисполняемых служб.
  energyCapacity: number; // ЭЕ, батарея не стратегическое топливо.
  shield: number;
  shieldRegen: number;
  shieldDelay: number;
  shieldBeamResistance: number;
  armor: number;
  armorBeamResistance: number;
  armorProjectileResistance: number;
  dps: number;
  weapons: Array<{ slotId: string; definition: WeaponDefinition; energyPerShot: number }>;
}

export function calculateShipStats(design: ShipDesign): ShipStats {
  const hull = HULLS[design.hullId];
  let bonusVolume = 0;
  const stats: ShipStats = {
    equipmentVolume: 0, mass: hull.mass * (design.hullVariant === 'reinforced' ? 1.15 : 1),
    cargoVolume: 0, cargoMassLimit: 0, cost: Math.ceil(hull.cost * (design.hullVariant === 'reinforced' ? 1.3 : 1)) +
      getStrategicEquipmentCost(design.strategicEquipment) * 100,
    hitPoints: hull.hitPoints * (design.hullVariant === 'reinforced' ? 1.2 : 1), speed: 0, thrust: 0, evasion: 0,
    powerGeneration: 0, movementPower: 0, peakPower: 0, energyCapacity: hull.energyCapacity,
    shield: 0, shieldRegen: 0, shieldDelay: 0, shieldBeamResistance: 0,
    armor: 0, armorBeamResistance: 0, armorProjectileResistance: 0, dps: 0, weapons: []
  };
  for (const slot of design.slots) {
    if (!slot.component) continue;
    const derived = calculateComponent(slot.component), component = derived.effective;
    stats.mass += derived.mass;
    stats.equipmentVolume += derived.equipmentVolume;
    stats.cost += derived.cost;
    stats.peakPower += derived.power;
    switch (component.kind) {
      case 'beam': case 'projectile':
        stats.weapons.push({ slotId: slot.id, definition: { ...component }, energyPerShot: derived.energyPerShot });
        stats.dps += component.damage * component.fireRate * component.accuracy;
        break;
      case 'engine':
        stats.powerGeneration += component.powerGeneration;
        stats.movementPower += derived.power;
        stats.speed = component.maxSpeed;
        stats.thrust = component.thrust;
        stats.evasion = component.maneuverability * 0.3;
        break;
      case 'shield':
        stats.shield = component.capacity;
        stats.shieldRegen = component.rechargeRate;
        stats.shieldDelay = component.rechargeDelay;
        stats.shieldBeamResistance = component.beamResistance;
        break;
      case 'armor':
        stats.armor = component.armorPoints;
        stats.armorBeamResistance = component.beamResistance;
        stats.armorProjectileResistance = component.projectileResistance;
        break;
      case 'cargoExpansion': bonusVolume += component.bonusCapacity; break;
    }
  }
  stats.equipmentVolume = Math.round(stats.equipmentVolume * 10) / 10;
  stats.speed *= stats.thrust / Math.max(1, stats.thrust + stats.mass * 0.1);
  const cargo = HULL_CARGO[design.hullId];
  stats.cargoVolume = cargo.volume + bonusVolume;
  stats.cargoMassLimit = Math.max(0, Math.min(cargo.mass, hull.maxMass - stats.mass));
  return stats;
}

export function describeDesign(design: ShipDesign): string[] {
  const travel = getTravelCapabilities(design.strategicEquipment);
  const stats = calculateShipStats(design);
  return [
    `${HULLS[design.hullId].name} · ${design.hullVariant}\nHP ${stats.hitPoints} · масса ${stats.mass.toFixed(2)} т\n` +
    `Объём ${stats.equipmentVolume}/${HULLS[design.hullId].equipmentVolume} · цена ${stats.cost}\n` +
    `Скорость ${stats.speed.toFixed(2)} ед/с · разгон ${(stats.thrust / stats.mass).toFixed(2)} ед/с²\n` +
    `Энергия ${stats.energyCapacity} ЭЕ · генерация ${stats.powerGeneration} ЭЕ/с\n` +
    `Полная нагрузка ${stats.peakPower.toFixed(2)} ЭЕ/с\n` +
    `DPS* ${stats.dps.toFixed(2)}: номинальный до исчерпания снарядов/энергии, без критов/защиты`,
    `Стратегия: ${travel.strategicSpeed} гал. ед./свой ход\nПереход ${travel.maxJumpDistance} · бак ${(travel.fuelCapacity / 1000).toFixed(3)}\nРасход ${travel.fuelConsumptionPerDistance}/1000 на гал. ед.`,
    ...design.slots.flatMap(slot => {
      if (!slot.component) return [];
      const input = slot.component, derived = calculateComponent(input), c = derived.effective;
      let ratings = '';
      switch (c.kind) {
        case 'beam': case 'projectile':
          ratings = `Урон ${c.damage} · дальность ${c.range}\nТочность ${c.accuracy.toFixed(3)} · темп ${c.fireRate}/с\n` +
            `Выстрел ${derived.energyPerShot.toFixed(2)} ЭЕ${c.kind === 'projectile' ? ` · ammo ${c.ammoCapacity}` : ''}`; break;
        case 'engine': ratings = `Тяга ${c.thrust} · maxSpeed ${c.maxSpeed}\nГенерация ${c.powerGeneration} ЭЕ/с`; break;
        case 'armor': ratings = `Броня ${c.armorPoints}\nСопротивление лучам ${c.beamResistance.toFixed(3)}, снарядам ${c.projectileResistance.toFixed(3)}`; break;
        case 'shield': ratings = `Щит ${c.capacity} HP · regen ${c.rechargeRate} HP/с\nЗадержка ${c.rechargeDelay}с · лучи ${c.beamResistance}\n3 ЭЕ/HP восстановления`; break;
        default: ratings = componentStatus(input);
      }
      return [`${COMPONENT_NAMES[c.kind]} · ${input.tacticalVariant} / ${input.technologyVariant}\n` +
        `Масса ${derived.mass.toFixed(2)} т · V${derived.equipmentVolume} · цена ${derived.cost}\n` +
        `Нагрузка ${derived.power.toFixed(2)} ЭЕ/с\n${ratings}`];
    })
  ];
}

// Integral holds are already included in hull mass/cost; no new serialized slots or v1 migration.
const HULL_CARGO: Record<HullId, { mass: number; volume: number }> = {
  fighter: { mass: 0, volume: 0 }, corvette: { mass: 100, volume: 100 },
  frigate: { mass: 200, volume: 250 }, destroyer: { mass: 350, volume: 400 },
  cruiser: { mass: 500, volume: 600 }, battleship: { mass: 800, volume: 900 },
  colonizer: { mass: 100, volume: 100 }
};

export interface DesignIssue { code: string; message: string; slotId?: string }
const sizes: SlotSize[] = ['small', 'medium', 'large', 'capital'];
/** Same validation is used by editor, repository diagnostics and runtime creation. Drafts may be incomplete. */
export function validateDesign(input: unknown, mode: 'draft' | 'flight' | 'battle' = 'battle'): DesignIssue[] {
  const parsed = designSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map(issue => ({ code: 'schema', message: `${issue.path.join('.')}: ${issue.message}` }));
  const design = parsed.data;
  const issues: DesignIssue[] = [];
  const hull = HULLS[design.hullId];
  for (const slot of design.slots) {
    if (!slot.component) continue;
    const derived = calculateComponent(slot.component);
    if (slot.component.tacticalVariant !== 'standard' &&
      !componentSchema.safeParse({ ...derived.effective, tacticalVariant: 'standard', technologyVariant: 'standard' }).success) {
      issues.push({ code: 'effective-cap', slotId: slot.id, message: `${slot.id}: эффективные параметры вне допустимых пределов` });
    }
    const hardpoint = hull.slots.find(point => point.id === slot.id)!;
    if (!acceptsComponent(hardpoint, slot.component)) issues.push({ code: 'kind', slotId: slot.id, message: `${slot.id}: несовместимый тип компонента` });
    if (sizes.indexOf(derived.slotSize) > sizes.indexOf(hardpoint.size)) {
      issues.push({ code: 'size', slotId: slot.id, message: `${slot.id}: компонент слишком велик` });
    }
  }
  const stats = calculateShipStats(design);
  if (Math.round(stats.equipmentVolume * 10) > hull.equipmentVolume * 10) issues.push({ code: 'equipment-volume',
    message: `Объём оборудования: ${stats.equipmentVolume} / ${hull.equipmentVolume}` });
  if (stats.mass > hull.maxMass) issues.push({ code: 'mass', message: `Перегрузка: ${stats.mass.toFixed(1)} / ${hull.maxMass} т` });
  if (mode !== 'draft') {
    if (stats.speed <= 0) issues.push({ code: 'engine', message: 'Нужен двигатель с тягой и скоростью' });
    if (stats.powerGeneration <= 0 || stats.peakPower > stats.powerGeneration) issues.push({ code: 'power', message: `Недостаточно мощности: ${stats.peakPower.toFixed(1)} / ${stats.powerGeneration.toFixed(1)} ЭЕ/с` });
    if (mode === 'battle' && !stats.weapons.length) issues.push({ code: 'weapon', message: 'Для боя установите оружие' });
    if (stats.weapons.some(weapon => weapon.energyPerShot > stats.energyCapacity)) issues.push({ code: 'battery', message: 'Энергии батареи не хватает на один выстрел' });
  }
  return issues;
}

/** Immutable installation: catalogue entries are blueprints, each slot stores its own snapshot. */
export function installComponent(design: ShipDesign, slotId: string, component: ComponentDefinition | null): ShipDesign {
  const next = designSchema.parse(design);
  const slot = next.slots.find(item => item.id === slotId);
  if (!slot) throw new Error('Неизвестный слот');
  slot.component = component === null ? null : componentSchema.parse(component);
  const issues = validateDesign(next, 'draft');
  if (issues.length) throw new Error(issues.map(issue => issue.message).join('\n'));
  next.updatedAt = new Date().toISOString();
  return next;
}
