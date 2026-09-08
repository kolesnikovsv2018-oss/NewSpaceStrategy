import { z } from 'zod';

const nonnegative = z.number().finite().min(0).max(100000);
const ratio = z.number().finite().min(0).max(1);
const identity = { id: z.string().min(1).max(128), name: z.string().trim().min(1).max(80) };
const weapon = {
  damage: z.number().finite().positive().max(100000),
  range: z.number().finite().positive().max(10000),
  fireRate: z.number().finite().min(0.1).max(20),
  accuracy: ratio
};

/** Definitions contain inputs only. Mass/cost/power are derived, never trusted from saves. */
export const componentSchema = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('beam'), ...weapon }).strict(),
  z.object({ ...identity, kind: z.literal('projectile'), ...weapon,
    ammoCapacity: z.number().int().min(1).max(10000) }).strict(),
  z.object({ ...identity, kind: z.literal('engine'), thrust: nonnegative,
    maxSpeed: z.number().finite().min(0).max(1000), maneuverability: ratio,
    powerGeneration: nonnegative }).strict(),
  z.object({ ...identity, kind: z.literal('shield'), capacity: nonnegative,
    rechargeRate: nonnegative, rechargeDelay: z.number().finite().min(0).max(60),
    beamResistance: ratio }).strict(),
  z.object({ ...identity, kind: z.literal('armor'), armorPoints: nonnegative,
    beamResistance: ratio, projectileResistance: ratio }).strict()
]);

export type ComponentDefinition = z.infer<typeof componentSchema>;
export type ComponentKind = ComponentDefinition['kind'];
export type SlotSize = 'small' | 'medium' | 'large' | 'capital';
export const hullIdSchema = z.enum(['fighter', 'corvette', 'frigate', 'destroyer', 'cruiser', 'battleship']);
export type HullId = z.infer<typeof hullIdSchema>;
export interface Hardpoint {
  id: string;
  kind: ComponentKind;
  size: SlotSize;
  x: number;
  y: number;
}
export interface HullDefinition {
  id: HullId;
  name: string;
  mass: number;
  maxMass: number;
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
    { id: 'armor_1', kind: 'armor', size, x: 24, y: 8 }
  ];
}

export const HULLS: Record<HullId, HullDefinition> = {
  fighter: { id: 'fighter', name: 'Истребитель', mass: 30, maxMass: 140, hitPoints: 200, cost: 1000, energyCapacity: 1000, scale: 0.7, slots: slots('medium') },
  corvette: { id: 'corvette', name: 'Корвет', mass: 80, maxMass: 350, hitPoints: 500, cost: 3000, energyCapacity: 2000, scale: 1, slots: slots('large') },
  frigate: { id: 'frigate', name: 'Фрегат', mass: 150, maxMass: 650, hitPoints: 900, cost: 6000, energyCapacity: 3000, scale: 1.15, slots: slots('large') },
  destroyer: { id: 'destroyer', name: 'Эсминец', mass: 250, maxMass: 1000, hitPoints: 1400, cost: 10000, energyCapacity: 4500, scale: 1.3, slots: slots('capital') },
  cruiser: { id: 'cruiser', name: 'Крейсер', mass: 400, maxMass: 1600, hitPoints: 2200, cost: 16000, energyCapacity: 6500, scale: 1.5, slots: slots('capital') },
  battleship: { id: 'battleship', name: 'Линкор', mass: 650, maxMass: 2400, hitPoints: 3500, cost: 25000, energyCapacity: 10000, scale: 1.7, slots: slots('capital') }
};

export const designSchema = z.object({
  schemaVersion: z.literal(1),
  ...identity,
  hullId: hullIdSchema,
  slots: z.array(z.object({ id: z.string().min(1).max(128), component: componentSchema.nullable() }).strict()).max(32),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine((design, ctx) => {
  const expected = HULLS[design.hullId].slots.map(slot => slot.id);
  const actual = design.slots.map(slot => slot.id);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(id => !expected.includes(id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Слоты не соответствуют корпусу' });
  }
});
export type ShipDesign = z.infer<typeof designSchema>;

export const COMPONENT_NAMES: Record<ComponentKind, string> = {
  beam: 'Лазер', projectile: 'Пушка', engine: 'Двигатель', shield: 'Щит', armor: 'Броня'
};
let sequence = 0;
export const newId = (prefix: string): string => `${prefix}_${Date.now()}_${++sequence}`;
export function createComponent(kind: ComponentKind): ComponentDefinition {
  const identity = { id: newId(kind), name: COMPONENT_NAMES[kind] };
  switch (kind) {
    case 'beam': return { ...identity, kind, damage: 25, range: 500, fireRate: 2, accuracy: 0.8 };
    case 'projectile': return { ...identity, kind, damage: 30, range: 300, fireRate: 1.5, accuracy: 0.9, ammoCapacity: 20 };
    case 'engine': return { ...identity, kind, thrust: 1000, maxSpeed: 200, maneuverability: 0.7, powerGeneration: 600 };
    case 'shield': return { ...identity, kind, capacity: 500, rechargeRate: 20, rechargeDelay: 3, beamResistance: 0.3 };
    case 'armor': return { ...identity, kind, armorPoints: 150, beamResistance: 0.2, projectileResistance: 0.3 };
  }
}

export function createDesign(hullId: HullId = 'corvette', starter = false): ShipDesign {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, id: newId('design'), name: `${HULLS[hullId].name} — проект`, hullId,
    slots: HULLS[hullId].slots.map(slot => ({ id: slot.id,
      component: starter && (slot.id === 'engine_1' || slot.id === 'beam_1') ? createComponent(slot.kind) : null })),
    createdAt: now, updatedAt: now
  };
}

export interface ComponentStats {
  mass: number;
  cost: number;
  power: number; // Energy per second at full duty; not energy per shot.
  energyPerShot: number;
  slotSize: SlotSize;
}
export function calculateComponent(component: ComponentDefinition): ComponentStats {
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
  }
  return { mass, cost: Math.round(cost), power, energyPerShot,
    slotSize: mass < 25 ? 'small' : mass < 100 ? 'medium' : mass < 250 ? 'large' : 'capital' };
}

export type WeaponDefinition = Extract<ComponentDefinition, { kind: 'beam' | 'projectile' }>;
export interface ShipStats {
  mass: number;
  cargoVolume: number; // Cubic metres, independent of equipment hardpoints.
  cargoMassLimit: number; // Tonnes after accounting for installed modules and hull maxMass.
  cost: number;
  hitPoints: number;
  speed: number;
  thrust: number;
  evasion: number;
  powerGeneration: number;
  movementPower: number;
  peakPower: number;
  energyCapacity: number;
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
  const stats: ShipStats = {
    mass: hull.mass, cargoVolume: 0, cargoMassLimit: 0, cost: hull.cost, hitPoints: hull.hitPoints, speed: 0, thrust: 0, evasion: 0,
    powerGeneration: 0, movementPower: 0, peakPower: 0, energyCapacity: hull.energyCapacity,
    shield: 0, shieldRegen: 0, shieldDelay: 0, shieldBeamResistance: 0,
    armor: 0, armorBeamResistance: 0, armorProjectileResistance: 0, dps: 0, weapons: []
  };
  for (const slot of design.slots) {
    const component = slot.component;
    if (!component) continue;
    const derived = calculateComponent(component);
    stats.mass += derived.mass;
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
    }
  }
  stats.speed *= stats.thrust / Math.max(1, stats.thrust + stats.mass * 0.1);
  const cargo = HULL_CARGO[design.hullId];
  stats.cargoVolume = cargo.volume;
  stats.cargoMassLimit = Math.max(0, Math.min(cargo.mass, hull.maxMass - stats.mass));
  return stats;
}

// Integral holds are already included in hull mass/cost; no new serialized slots or v1 migration.
const HULL_CARGO: Record<HullId, { mass: number; volume: number }> = {
  fighter: { mass: 0, volume: 0 }, corvette: { mass: 100, volume: 100 },
  frigate: { mass: 200, volume: 250 }, destroyer: { mass: 350, volume: 400 },
  cruiser: { mass: 500, volume: 600 }, battleship: { mass: 800, volume: 900 }
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
    const hardpoint = hull.slots.find(point => point.id === slot.id)!;
    if (slot.component.kind !== hardpoint.kind) issues.push({ code: 'kind', slotId: slot.id, message: `${slot.id}: несовместимый тип компонента` });
    if (sizes.indexOf(calculateComponent(slot.component).slotSize) > sizes.indexOf(hardpoint.size)) {
      issues.push({ code: 'size', slotId: slot.id, message: `${slot.id}: компонент слишком велик` });
    }
  }
  const stats = calculateShipStats(design);
  if (stats.mass > hull.maxMass) issues.push({ code: 'mass', message: `Перегрузка: ${stats.mass.toFixed(1)} / ${hull.maxMass} т` });
  if (mode !== 'draft') {
    if (stats.speed <= 0) issues.push({ code: 'engine', message: 'Нужен двигатель с тягой и скоростью' });
    if (stats.powerGeneration <= 0 || stats.peakPower > stats.powerGeneration) issues.push({ code: 'power', message: `Недостаточно мощности: ${stats.peakPower.toFixed(1)} / ${stats.powerGeneration.toFixed(1)} ед/с` });
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
