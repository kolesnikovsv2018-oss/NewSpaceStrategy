import { afterEach, expect, it, vi } from 'vitest';
import { resizeCampaignViewport } from '../src/ui/CampaignViewport';

vi.stubGlobal('Phaser', { Scene: class {} });
const { MenuScene } = await import('../src/scenes/MenuScene');
afterEach(() => vi.unstubAllGlobals());

it('refreshes parent bounds before FIT sizing in both directions, preserving CSS thresholds', () => {
  const host = { innerWidth: 1280, innerHeight: 720 };
  vi.stubGlobal('window', host);
  const scene = new MenuScene();
  let parentWidth = 1280, parentHeight = 720;
  const calls: string[] = [];
  let display = { width: 1280, height: 720 };
  Object.assign(scene, { scale: {
    getParentBounds: () => { calls.push('bounds'); parentWidth = host.innerWidth; parentHeight = host.innerHeight; return true; },
    setGameSize: (width: number, height: number) => {
      calls.push('size');
      const ratio = Math.min(parentWidth / width, parentHeight / height);
      display = { width: width * ratio, height: height * ratio };
      expect(14 * ratio).toBeGreaterThanOrEqual(14);
      expect(44 * ratio).toBeGreaterThanOrEqual(44);
    }
  } });
  host.innerWidth = 390; host.innerHeight = 844;
  resizeCampaignViewport(scene);
  expect(display).toEqual({ width: 390, height: 844 });
  host.innerWidth = 1280; host.innerHeight = 720;
  resizeCampaignViewport(scene);
  expect(display).toEqual({ width: 1280, height: 720 });
  expect(calls).toEqual(['bounds', 'size', 'bounds', 'size']);
});
