import type Phaser from 'phaser';
import { button, fitText, text } from './ConquestWidgets';
import { clampMap, fitMap, focusMap, insideMap, mapBounds, panMap, projectMap, zoomMap,
  MAP_MAX_ZOOM, MAP_ZOOM_STEP, type MapArea, type MapPoint, type MapViewport } from './GalaxyMapViewport';

export interface GalaxyMapWorld extends MapPoint {
  id: string;
  name: string;
  color: number;
  marker: string;
}
export interface GalaxyMapState { viewport?: MapViewport; selection?: string }
interface GalaxyMapOptions {
  area: MapArea;
  toolbarY: number;
  worlds: readonly GalaxyMapWorld[];
  lanes?: readonly (readonly [string, string])[];
  selectedId: string;
  state: GalaxyMapState;
  prefix: string;
  worldPrefix: string;
  enabled: () => boolean;
  change: (state: GalaxyMapState) => void;
  select: (id: string) => void;
}

export class GalaxyMapWidget {
  private readonly root: Phaser.GameObjects.Container;
  private readonly content: Phaser.GameObjects.Container;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly maskShape: Phaser.GameObjects.Graphics;
  private readonly mask: Phaser.Display.Masks.GeometryMask;
  private readonly bounds;
  private viewport: MapViewport;
  private selection: string;
  private disposed = false;
  private gesture?: { id: number; start: MapPoint; last: MapPoint; moved: boolean };
  private readonly labels = new Map<string, Phaser.GameObjects.Text>();
  private readonly markers = new Map<string, Phaser.GameObjects.Arc>();
  private readonly percentage: Phaser.GameObjects.Text;
  private readonly minus: Phaser.GameObjects.Text;
  private readonly plus: Phaser.GameObjects.Text;
  private readonly fit: Phaser.GameObjects.Text;

  constructor(private readonly scene: Phaser.Scene, parent: Phaser.GameObjects.Container, private readonly options: GalaxyMapOptions) {
    this.bounds = mapBounds(options.worlds);
    this.viewport = clampMap(options.state.viewport ?? fitMap(this.bounds), this.bounds, options.area);
    const selected = options.worlds.find(world => world.id === options.selectedId);
    if (selected && options.state.selection !== selected.id) this.viewport = focusMap(this.viewport, selected, this.bounds, options.area);
    this.selection = options.selectedId;
    this.root = scene.add.container(0, 0).setName(`${options.prefix}-map`);
    parent.add(this.root);
    const { area } = options;
    this.content = scene.add.container(0, 0); this.root.add(this.content);
    this.maskShape = scene.add.graphics().fillStyle(0xffffff).fillRect(area.x, area.y, area.width, area.height).setVisible(false);
    this.mask = this.maskShape.createGeometryMask();
    this.content.setMask(this.mask);
    const surface = scene.add.rectangle(area.x + area.width / 2, area.y + area.height / 2, area.width, area.height, 0x0a1524)
      .setName(`${options.prefix}-map-surface`).setInteractive();
    this.content.add(surface);
    surface.on('pointerdown', this.down);
    surface.on('pointerup', this.up);
    surface.on('wheel', this.wheel);
    if (!this.available()) surface.disableInteractive();
    this.graphics = scene.add.graphics(); this.content.add(this.graphics);
    for (const world of options.worlds) {
      const marker = scene.add.circle(0, 0, options.worlds.length > 40 ? 4 : 7, world.color)
        .setName(`${options.worldPrefix}${world.id}`).setInteractive({ useHandCursor: true });
      marker.on('pointerdown', this.down); marker.on('pointerup', this.up); marker.on('wheel', this.wheel);
      if (!this.available()) marker.disableInteractive();
      this.markers.set(world.id, marker); this.content.add(marker);
      if (options.worlds.length <= 40 || world.id === options.selectedId) {
        const label = text(scene, this.content, 0, 0, `${world.marker} ${world.name}`, 14)
          .setName(`${options.prefix}-map-label-${world.id}`).setInteractive({ useHandCursor: true });
        fitText(label, 110);
        label.on('pointerdown', this.down); label.on('pointerup', this.up); label.on('wheel', this.wheel);
        if (!this.available()) label.disableInteractive();
        this.labels.set(world.id, label);
      }
    }
    this.minus = button(scene, this.root, area.x, options.toolbarY, '−', () => this.zoom(1 / MAP_ZOOM_STEP),
      `${options.prefix}-map-minus`, 44);
    this.plus = button(scene, this.root, area.x + 52, options.toolbarY, '+', () => this.zoom(MAP_ZOOM_STEP),
      `${options.prefix}-map-plus`, 44);
    this.fit = button(scene, this.root, area.x + 104, options.toolbarY, 'Вся карта', () => {
      if (!this.available()) return;
      this.cancel(); this.viewport = fitMap(this.bounds); this.draw();
    }, `${options.prefix}-map-fit`, 120);
    this.percentage = text(scene, this.root, area.x + 232, options.toolbarY + 13, '', 14)
      .setName(`${options.prefix}-map-scale`);
    scene.input.on('pointermove', this.move);
    scene.input.on('pointerup', this.up);
    scene.input.on('pointerupoutside', this.cancel);
    scene.input.on('gameout', this.cancel);
    if (typeof window !== 'undefined') window.addEventListener('blur', this.cancel);
    this.root.once('destroy', this.release);
    this.draw();
  }

  private available(): boolean { return !this.disposed && this.options.enabled(); }

  private down = (pointer: Phaser.Input.Pointer): void => {
    if (!this.available() || this.gesture || !insideMap(pointer, this.options.area) ||
      (!pointer.wasTouch && !pointer.leftButtonDown())) return;
    this.gesture = { id: pointer.id, start: { x: pointer.x, y: pointer.y }, last: { x: pointer.x, y: pointer.y }, moved: false };
  };

  private move = (pointer: Phaser.Input.Pointer): void => {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== pointer.id) return;
    if (!this.available() || !pointer.isDown) { this.cancel(); return; }
    if (Math.hypot(pointer.x - gesture.start.x, pointer.y - gesture.start.y) >= 5) gesture.moved = true;
    if (gesture.moved) {
      this.viewport = panMap(this.viewport, { x: pointer.x - gesture.last.x, y: pointer.y - gesture.last.y }, this.bounds, this.options.area);
      this.draw();
      gesture.last = { x: pointer.x, y: pointer.y };
    }
  };

  private up = (pointer: Phaser.Input.Pointer): void => {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== pointer.id) return;
    this.cancel();
    if (!this.available() || gesture.moved || Math.hypot(pointer.x - gesture.start.x, pointer.y - gesture.start.y) >= 5 ||
      !insideMap(pointer, this.options.area)) return;
    const candidates = this.options.worlds.flatMap(world => {
      const point = projectMap(world, this.viewport, this.bounds, this.options.area);
      if (!insideMap(point, this.options.area)) return [];
      const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
      const label = this.labels.get(world.id);
      const onLabel = label && pointer.x >= label.x && pointer.x <= label.x + label.width &&
        pointer.y >= label.y && pointer.y <= label.y + label.height;
      return distance <= 22 || onLabel ? [{ world, distance }] : [];
    }).sort((a, b) => a.distance - b.distance || (a.world.id < b.world.id ? -1 : a.world.id > b.world.id ? 1 : 0));
    if (candidates.length) {
      this.selection = candidates[0].world.id;
      this.publish();
      this.options.select(this.selection);
    }
  };

  private wheel = (pointer: Phaser.Input.Pointer, _dx: number, dy: number): void => {
    if (!this.available() || !insideMap(pointer, this.options.area) || !Number.isFinite(dy) || dy === 0) return;
    this.zoom(dy < 0 ? MAP_ZOOM_STEP : 1 / MAP_ZOOM_STEP, pointer);
  };

  private zoom(factor: number, anchor: MapPoint = {
    x: this.options.area.x + this.options.area.width / 2, y: this.options.area.y + this.options.area.height / 2
  }): void {
    if (!this.available()) return;
    this.cancel(); this.viewport = zoomMap(this.viewport, factor, anchor, this.bounds, this.options.area); this.draw();
  }

  private cancel = (): void => { this.gesture = undefined; };
  private publish(): void { this.options.change({ viewport: { ...this.viewport }, selection: this.selection }); }

  private draw(): void {
    this.graphics.clear();
    const positions = new Map(this.options.worlds.map(world => [world.id, projectMap(world, this.viewport, this.bounds, this.options.area)]));
    for (const [from, to] of this.options.lanes ?? []) {
      const a = positions.get(from), b = positions.get(to);
      if (a && b) this.graphics.lineStyle(2, 0x34536d).lineBetween(a.x, a.y, b.x, b.y);
    }
    for (const world of this.options.worlds) {
      const point = positions.get(world.id)!;
      this.markers.get(world.id)!.setPosition(point.x, point.y).setVisible(insideMap(point, this.options.area));
      const label = this.labels.get(world.id);
      label?.setPosition(Math.max(this.options.area.x, Math.min(this.options.area.x + this.options.area.width - label.width,
        point.x - label.width / 2)), point.y + 12).setVisible(insideMap(point, this.options.area));
      if (world.id === this.options.selectedId) this.graphics.lineStyle(2, 0xffffff).strokeCircle(point.x, point.y, 12);
    }
    this.percentage.setText(`${Math.round(this.viewport.zoom * 100)}%`);
    for (const [item, enabled] of [[this.minus, this.viewport.zoom > 1], [this.plus, this.viewport.zoom < MAP_MAX_ZOOM], [this.fit, true]] as const) {
      if (enabled && this.available()) item.setInteractive({ useHandCursor: true }).setAlpha(1);
      else item.disableInteractive().setAlpha(0.4);
    }
    this.publish();
  }

  private release = (): void => {
    if (this.disposed) return;
    this.disposed = true; this.cancel();
    this.scene.input.off('pointermove', this.move);
    this.scene.input.off('pointerup', this.up);
    this.scene.input.off('pointerupoutside', this.cancel);
    this.scene.input.off('gameout', this.cancel);
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.cancel);
    this.mask.destroy(); this.maskShape.destroy();
  };

  destroy(): void {
    if (!this.disposed) this.root.destroy(true);
  }
}
