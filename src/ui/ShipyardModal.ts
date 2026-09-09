import type Phaser from 'phaser';

const active = new WeakMap<Phaser.Scene, () => void>();

export function isShipyardModalOpen(scene: Phaser.Scene): boolean { return active.has(scene); }
export function closeShipyardModal(scene: Phaser.Scene): void { active.get(scene)?.(); }

/** One modal per scene; Escape only cancels, and shutdown invalidates retained callbacks. */
export function openShipyardModal(scene: Phaser.Scene): {
  overlay: Phaser.GameObjects.Container;
  close: () => boolean;
} | undefined {
  if (active.has(scene)) return undefined;
  const { width, height } = scene.cameras.main;
  const overlay = scene.add.container(0, 0).setDepth(1000).setName('shipyard-modal');
  overlay.add(scene.add.rectangle(width / 2, height / 2, width, height, 0x020913, 0.85).setInteractive());
  let closed = false;
  const close = (): boolean => {
    if (closed) return false;
    closed = true;
    active.delete(scene);
    scene.input.keyboard?.off('keydown-ESC', close);
    scene.events.off('shutdown', close);
    overlay.destroy();
    return true;
  };
  active.set(scene, close);
  scene.input.keyboard?.on('keydown-ESC', close);
  scene.events.once('shutdown', close);
  return { overlay, close };
}