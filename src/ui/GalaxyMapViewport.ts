export interface MapPoint { x: number; y: number }
export interface MapArea extends MapPoint { width: number; height: number }
export interface MapBounds { minX: number; maxX: number; minY: number; maxY: number }
export interface MapViewport extends MapPoint { zoom: number }

export const MAP_MAX_ZOOM = 16;
export const MAP_ZOOM_STEP = 1.25;
export const MAP_PADDING = 28;

export function mapBounds(points: readonly MapPoint[]): MapBounds {
  if (!points.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return {
    minX: Math.min(...points.map(point => point.x)), maxX: Math.max(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)), maxY: Math.max(...points.map(point => point.y))
  };
}

export function fitMap(bounds: MapBounds): MapViewport {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom: 1 };
}

export function mapScale(bounds: MapBounds, area: MapArea, zoom: number): number {
  return Math.min(Math.max(1, area.width - MAP_PADDING * 2) / Math.max(1, bounds.maxX - bounds.minX),
    Math.max(1, area.height - MAP_PADDING * 2) / Math.max(1, bounds.maxY - bounds.minY)) * zoom;
}

export function clampMap(view: MapViewport, bounds: MapBounds, area: MapArea): MapViewport {
  const zoom = Math.max(1, Math.min(MAP_MAX_ZOOM, view.zoom));
  const scale = mapScale(bounds, area, zoom);
  const clampAxis = (value: number, min: number, max: number, size: number) => {
    const half = Math.max(1, size - MAP_PADDING * 2) / (2 * scale);
    return max - min <= half * 2 ? (min + max) / 2 : Math.max(min + half, Math.min(max - half, value));
  };
  return { zoom, x: clampAxis(view.x, bounds.minX, bounds.maxX, area.width),
    y: clampAxis(view.y, bounds.minY, bounds.maxY, area.height) };
}

export function projectMap(point: MapPoint, view: MapViewport, bounds: MapBounds, area: MapArea): MapPoint {
  const scale = mapScale(bounds, area, view.zoom);
  return { x: area.x + area.width / 2 + (point.x - view.x) * scale,
    y: area.y + area.height / 2 + (point.y - view.y) * scale };
}

export function unprojectMap(point: MapPoint, view: MapViewport, bounds: MapBounds, area: MapArea): MapPoint {
  const scale = mapScale(bounds, area, view.zoom);
  return { x: view.x + (point.x - area.x - area.width / 2) / scale,
    y: view.y + (point.y - area.y - area.height / 2) / scale };
}

export function zoomMap(view: MapViewport, factor: number, anchor: MapPoint, bounds: MapBounds, area: MapArea): MapViewport {
  const before = unprojectMap(anchor, view, bounds, area);
  const next = { ...view, zoom: Math.max(1, Math.min(MAP_MAX_ZOOM, view.zoom * factor)) };
  const after = unprojectMap(anchor, next, bounds, area);
  return clampMap({ ...next, x: next.x + before.x - after.x, y: next.y + before.y - after.y }, bounds, area);
}

export function panMap(view: MapViewport, delta: MapPoint, bounds: MapBounds, area: MapArea): MapViewport {
  const scale = mapScale(bounds, area, view.zoom);
  return clampMap({ ...view, x: view.x - delta.x / scale, y: view.y - delta.y / scale }, bounds, area);
}

export function focusMap(view: MapViewport, point: MapPoint, bounds: MapBounds, area: MapArea): MapViewport {
  const screen = projectMap(point, view, bounds, area);
  return screen.x < area.x + MAP_PADDING || screen.x > area.x + area.width - MAP_PADDING ||
    screen.y < area.y + MAP_PADDING || screen.y > area.y + area.height - MAP_PADDING
    ? clampMap({ ...view, ...point }, bounds, area) : view;
}

export function insideMap(point: MapPoint, area: MapArea): boolean {
  return point.x >= area.x && point.x <= area.x + area.width && point.y >= area.y && point.y <= area.y + area.height;
}
