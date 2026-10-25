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
