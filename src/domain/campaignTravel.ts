export const STRATEGIC_TRAVEL_POLICY = 'project-travel-v1';
export interface StrategicEquipment {
  policy: typeof STRATEGIC_TRAVEL_POLICY;
  drive: 'standard' | 'fast';
  jump: 'standard' | 'extended' | 'deep' | 'galactic';
  tank: 'standard' | 'extended';
}
export interface TravelCapabilities {
  strategicSpeed: number;
  maxJumpDistance: number;
  fuelCapacity: number;
  fuelConsumptionPerDistance: number;
}
export const INITIAL_TRAVEL_CAPABILITIES = Object.freeze({
  strategicSpeed: 100, maxJumpDistance: 200, fuelCapacity: 3000, fuelConsumptionPerDistance: 5
} as const);
export function createStrategicEquipment(): StrategicEquipment {
  return { policy: STRATEGIC_TRAVEL_POLICY, drive: 'standard', jump: 'standard', tank: 'standard' };
}
const jumps = { standard: 200, extended: 400, deep: 800, galactic: 1500 } as const;
const jumpPrices = { standard: 0, extended: 50, deep: 100, galactic: 150 } as const;
export function getTravelCapabilities(equipment: StrategicEquipment): TravelCapabilities {
  if (equipment.policy !== STRATEGIC_TRAVEL_POLICY || !Object.prototype.hasOwnProperty.call(jumps, equipment.jump) ||
    !['standard', 'fast'].includes(equipment.drive) || !['standard', 'extended'].includes(equipment.tank)) {
    throw new Error('Недопустимое стратегическое оснащение');
  }
  return { ...INITIAL_TRAVEL_CAPABILITIES, strategicSpeed: equipment.drive === 'fast' ? 200 : INITIAL_TRAVEL_CAPABILITIES.strategicSpeed,
    maxJumpDistance: jumps[equipment.jump], fuelCapacity: equipment.tank === 'extended' ? 9000 : INITIAL_TRAVEL_CAPABILITIES.fuelCapacity };
}
export function getStrategicEquipmentCost(equipment: StrategicEquipment): number {
  getTravelCapabilities(equipment);
  return jumpPrices[equipment.jump] + (equipment.drive === 'fast' ? 75 : 0) + (equipment.tank === 'extended' ? 60 : 0);
}
export type TravelQuote = { ok: true; distance: number; totalTurns: number; fuelCost: number } |
  { ok: false; code: 'INVALID_ROUTE' | 'INSUFFICIENT_FUEL' | 'INVALID_CAPABILITIES'; message: string };
export function getTravelQuote(distance: number, capabilities: TravelCapabilities, fuel: number): TravelQuote {
  const invalid = (): TravelQuote => ({ ok: false, code: 'INVALID_CAPABILITIES', message: 'Недопустимые возможности перелёта' });
  if (!Object.values(capabilities).every(value => Number.isFinite(value) && value > 0) ||
    !Number.isSafeInteger(capabilities.fuelCapacity) || !Number.isSafeInteger(fuel) ||
    fuel < 0 || fuel > capabilities.fuelCapacity) return invalid();
  if (!Number.isFinite(distance) || distance <= 0 || distance > capabilities.maxJumpDistance) {
    return { ok: false, code: 'INVALID_ROUTE', message: 'Цель вне предела перехода' };
  }
  const totalTurns = Math.max(1, Math.ceil(distance / capabilities.strategicSpeed));
  const fuelCost = Math.ceil(distance * capabilities.fuelConsumptionPerDistance);
  if (!Number.isSafeInteger(totalTurns) || totalTurns > 1_000_000_000 ||
    !Number.isSafeInteger(fuelCost) || fuelCost < 1) return invalid();
  if (fuel < fuelCost) return { ok: false, code: 'INSUFFICIENT_FUEL', message: 'Недостаточно топлива для выбранного расстояния' };
  return { ok: true, distance, totalTurns, fuelCost };
}
export function getStrategicRefuelQuote(fuel: number, capacity: number) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > 9000 || !Number.isSafeInteger(fuel) || fuel < 0 || fuel > capacity) {
    throw new Error('Недопустимый запас топлива');
  }
  const amount = capacity - fuel;
  return { amount, cost: { credits: Math.ceil(amount * 5 / 1000), minerals: Math.ceil(amount * 2 / 1000) } };
}
export function getFleetTravelQuotes(distance: number, members: readonly { capabilities: TravelCapabilities; fuel: number }[]) {
  if (!members.length) throw new Error('У группы нет участников');
  const strategicSpeed = Math.min(...members.map(member => member.capabilities.strategicSpeed));
  const maxJumpDistance = Math.min(...members.map(member => member.capabilities.maxJumpDistance));
  return members.map(member => ({ capabilities: { ...member.capabilities, strategicSpeed, maxJumpDistance },
    quote: getTravelQuote(distance, { ...member.capabilities, strategicSpeed, maxJumpDistance }, member.fuel) }));
}
export function formatStrategicFuel(fuel: number): string { return (fuel / 1000).toFixed(3); }

export const INITIAL_STRATEGIC_RANGE = 200;

export interface WorldPosition { id: string; x: number; y: number }

export function getWorldDistance(worlds: readonly WorldPosition[], from: string, to: string): number {
  const source = worlds.find(world => world.id === from);
  const target = worlds.find(world => world.id === to);
  if (!source || !target) throw new Error('Система отсутствует на карте партии');
  return Math.hypot(source.x - target.x, source.y - target.y);
}

export function isWorldInRange(worlds: readonly WorldPosition[], from: string, to: string, range: number): boolean {
  if (!Number.isFinite(range) || range <= 0) throw new Error('Недопустимая стратегическая дальность');
  return from !== to && getWorldDistance(worlds, from, to) <= range;
}
