import { expect, it } from 'vitest';
import { clampMap, fitMap, focusMap, insideMap, mapBounds, panMap, projectMap, unprojectMap, zoomMap,
  MAP_MAX_ZOOM, MAP_PADDING, MAP_ZOOM_STEP } from '../src/ui/GalaxyMapViewport';

const area = { x: 24, y: 188, width: 680, height: 130 };
const bounds = mapBounds([{ x: 0, y: 0 }, { x: 1000, y: 1000 }]);

it.each([[], [{ x: 7, y: 7 }], [{ x: 7, y: 7 }, { x: 7, y: 7 }],
  [{ x: 0, y: 0 }, { x: 0, y: 1000 }], [{ x: -50, y: 20 }, { x: 1000, y: 20 }]].map(points => ({ points })))(
  'fits empty/degenerate bounds without non-finite coordinates: $points', ({ points }) => {
    const b = mapBounds(points), view = fitMap(b);
    for (const point of points) {
      const screen = projectMap(point, view, b, area);
      expect(insideMap(screen, area)).toBe(true);
      expect(screen.x).toBeGreaterThanOrEqual(area.x + MAP_PADDING);
      expect(screen.y).toBeGreaterThanOrEqual(area.y + MAP_PADDING);
      expect(screen.x).toBeLessThanOrEqual(area.x + area.width - MAP_PADDING);
      expect(screen.y).toBeLessThanOrEqual(area.y + area.height - MAP_PADDING);
    }
    expect(Object.values(clampMap(view, b, area)).every(Number.isFinite)).toBe(true);
  });

it('projects and unprojects exactly the same world point after zoom and pan', () => {
  const view = { x: 410, y: 600, zoom: 8 }, point = { x: 800, y: -15 };
  const restored = unprojectMap(projectMap(point, view, bounds, area), view, bounds, area);
  expect(restored.x).toBeCloseTo(point.x, 10); expect(restored.y).toBeCloseTo(point.y, 10);
});

it('keeps the anchor fixed when zooming without a boundary constraint', () => {
  const view = { x: 500, y: 500, zoom: 12 }, anchor = { x: 374, y: 263 };
  const world = unprojectMap(anchor, view, bounds, area);
  const next = zoomMap(view, MAP_ZOOM_STEP, anchor, bounds, area);
  const projected = projectMap(world, next, bounds, area);
  expect(projected.x).toBeCloseTo(anchor.x, 10); expect(projected.y).toBeCloseTo(anchor.y, 10);
});

it('clamps pan to the world bounds and centers an axis that fits entirely', () => {
  const fit = fitMap(bounds);
  expect(panMap(fit, { x: 1e6, y: -1e6 }, bounds, area)).toEqual(fit);
  const view = panMap({ ...fit, zoom: 16 }, { x: 1e6, y: -1e6 }, bounds, area);
  const corner = projectMap({ x: 0, y: 1000 }, view, bounds, area);
  expect(corner.x).toBeCloseTo(area.x + MAP_PADDING);
  expect(corner.y).toBeCloseTo(area.y + area.height - MAP_PADDING);
});

it('reaches exactly 1 and 16, including repeated zoom steps and an extra step at each limit', () => {
  let view = fitMap(bounds);
  const anchor = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  for (let i = 0; i < 50; i++) view = zoomMap(view, MAP_ZOOM_STEP, anchor, bounds, area);
  expect(view.zoom).toBe(MAP_MAX_ZOOM);
  for (let i = 0; i < 50; i++) view = zoomMap(view, 1 / MAP_ZOOM_STEP, anchor, bounds, area);
  expect(view).toEqual(fitMap(bounds));
});

it('preserves scale and center across resize except for required clamping', () => {
  const view = { x: 500, y: 450, zoom: 8 };
  expect(clampMap(view, bounds, { x: 12, y: 124, width: 366, height: 644 })).toEqual(view);
});

it('focuses an offscreen selection without resetting zoom, but leaves a visible selection untouched', () => {
  const view = { x: 500, y: 500, zoom: 16 };
  expect(focusMap(view, { x: 500, y: 500 }, bounds, area)).toBe(view);
  const focused = focusMap(view, { x: 0, y: 0 }, bounds, area);
  expect(focused.zoom).toBe(16);
  expect(insideMap(projectMap({ x: 0, y: 0 }, focused, bounds, area), area)).toBe(true);
});
