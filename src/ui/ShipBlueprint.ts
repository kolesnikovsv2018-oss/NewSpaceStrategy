import type Phaser from 'phaser';
import { HULLS, type ShipDesign, type ComponentKind } from '../domain/shipDesign';

const colors: Record<ComponentKind, number> = {
  beam: 0x74e4ff, projectile: 0xffc477, engine: 0x80f5b9, shield: 0xab9dff, armor: 0xd4dce8,
  mining: 0xffdd66, repair: 0x72e693, scanner: 0xe5a7ff, cargoExpansion: 0xb8a18b
};

/** Shared by designer preview and the runtime sprite: same hull and same hardpoints. */
export function drawBlueprint(graphics: Phaser.GameObjects.Graphics, design: ShipDesign, color = 0x3388aa): void {
  const hull = HULLS[design.hullId];
  graphics.clear();
  graphics.fillStyle(color, 1);
  const width = 16 + hull.scale * 6;
  const length = 25 + hull.scale * 12;
  graphics.fillTriangle(0, -length, -width, length * 0.7, width, length * 0.7);
  graphics.fillStyle(0x17354c, 1);
  graphics.fillRoundedRect(-width * 0.5, -length * 0.15, width, length, 5);
  graphics.lineStyle(1, 0xa9d8f5, 0.7);
  graphics.strokeTriangle(0, -length, -width, length * 0.7, width, length * 0.7);
  for (const point of hull.slots) {
    const installed = design.slots.find(slot => slot.id === point.id)?.component;
    graphics.fillStyle(installed ? colors[installed.kind] : 0x34445a, 1);
    if (point.kind === 'beam' || point.kind === 'projectile') graphics.fillRect(point.x - 3, point.y - 7, 6, 14);
    else graphics.fillCircle(point.x, point.y, installed ? 5 : 3);
  }
}
