import type Phaser from 'phaser';

export function resizeCampaignViewport(scene: Phaser.Scene): void {
  if (typeof window === 'undefined' || !scene.scale) return;
  scene.scale.getParentBounds();
  scene.scale.setGameSize(Math.min(1280, window.innerWidth),
    window.innerWidth < 1280 ? window.innerHeight : Math.min(720, window.innerHeight));
}
