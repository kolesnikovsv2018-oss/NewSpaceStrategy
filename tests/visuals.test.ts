import { describe, expect, it, vi } from 'vitest';
import { CombatShipFactory } from '../src/entities/CombatShipFactory';
import { createDesign, type ShipDesign } from '../src/domain/shipDesign';

// Contract tests only: Phaser rendering itself is checked separately in the browser.
vi.stubGlobal('Phaser', { Scene: class {}, GameObjects: { Container: class {} } });
vi.mock('phaser', () => ({ default: { Scene: class {} } }));
const { ShipSprite } = await import('../src/entities/visuals/ShipSprite');
const { BattleScene } = await import('../src/scenes/BattleScene');
const { ShipTestScene } = await import('../src/scenes/ShipTestScene');
const { ShipyardScene } = await import('../src/scenes/ShipyardScene');

describe('simulation/view boundary', () => {
  it.each([BattleScene, ShipTestScene, ShipyardScene])('%s consumes launch data instead of replaying a stale project', Scene => {
    const scene = new Scene();
    const design = createDesign('corvette', true);
    const settings: { data: { design?: ShipDesign } } = { data: { design } };
    Object.assign(scene, { sys: { settings } });
    const internal = scene as unknown as { trialDesign?: ShipDesign; initial?: ShipDesign };
    scene.init(settings.data);
    expect(internal.trialDesign ?? internal.initial).toEqual(design);
    expect(settings.data).toEqual({});
    scene.init(settings.data); // SceneManager start without a payload reuses this object.
    expect(internal.trialDesign ?? internal.initial).toBeUndefined();
  });

  it('ShipSprite only synchronizes visuals, without advancing the model', () => {
    const ship = CombatShipFactory.createFighter('blue');
    ship.position = { x: 20, y: 40 };
    const update = vi.spyOn(ship, 'update');
    const setPosition = vi.fn();
    const fakeSprite = {
      ship, setPosition,
      drawEngineGlow: vi.fn(), drawEnergyBar: vi.fn(), drawSelectionCircle: vi.fn()
    };
    ShipSprite.prototype.update.call(fakeSprite as unknown as InstanceType<typeof ShipSprite>, 0.1);
    expect(update).not.toHaveBeenCalled();
    expect(setPosition).toHaveBeenCalledWith(20, 40);
  });

  it('ShipTestScene owns model updates after removing them from the sprite', () => {
    const ship = CombatShipFactory.createFighter('blue');
    const modelUpdate = vi.spyOn(ship, 'update');
    const viewUpdate = vi.fn();
    const fakeScene = { ships: [ship], shipSprites: [{ update: viewUpdate }] };
    ShipTestScene.prototype.update.call(fakeScene as unknown as InstanceType<typeof ShipTestScene>, 0, 100);
    expect(modelUpdate).toHaveBeenCalledExactlyOnceWith(0.1);
    expect(viewUpdate).toHaveBeenCalledExactlyOnceWith(0.1);
  });

  it('renders a destruction once while its tween is still running', () => {
    const ship = CombatShipFactory.createFighter('blue');
    ship.isDestroyed = true;
    const scene = new BattleScene();
    const sprite = { visible: true, getShip: () => ship, setVisible: vi.fn(), destroy: vi.fn() };
    const explosion = vi.fn();
    const tween = vi.fn();
    const drainEvents = vi.fn()
      .mockReturnValueOnce([{ type: 'ShipDestroyed', shipId: ship.id, position: { ...ship.position } }])
      .mockReturnValue([]);
    Object.assign(scene, {
      battleManager: { update: vi.fn(), drainEvents, getAllShips: () => [ship] },
      shipSprites: new Map([[ship.id, sprite]]),
      createExplosion: explosion,
      tweens: { add: tween }
    });
    scene.update(0, 16);
    scene.update(16, 16);
    expect(explosion).toHaveBeenCalledTimes(1);
    expect(tween).toHaveBeenCalledTimes(1);
  });

  it('paused battle does not advance simulation or consume events', () => {
    const scene = new BattleScene();
    const update = vi.fn();
    const drainEvents = vi.fn();
    Object.assign(scene, { isPaused: true, battleManager: { update, drainEvents } });
    scene.update(0, 100);
    expect(update).not.toHaveBeenCalled();
    expect(drainEvents).not.toHaveBeenCalled();
  });

  it('shutdown clears retained state and removes only its own keyboard handlers', () => {
    const scene = new BattleScene();
    const off = vi.fn();
    const sprites = new Map([['old', {}]]);
    Object.assign(scene, {
      input: { keyboard: { off } },
      shipSprites: sprites,
      projectiles: [{}],
      battleManager: {},
      isPaused: true,
      time: { paused: true }
    });
    // Invoke the exact callback registered for Phaser's SHUTDOWN event.
    const state = scene as unknown as {
      cleanup(): void;
      togglePause(): void;
      returnToMenu(): void;
      projectiles: unknown[];
      battleManager: unknown;
      isPaused: boolean;
      time: { paused: boolean };
    };
    state.cleanup();
    expect(off).toHaveBeenCalledWith('keydown-SPACE', state.togglePause, scene);
    expect(off).toHaveBeenCalledWith('keydown-ESC', state.returnToMenu, scene);
    expect(sprites.size).toBe(0);
    expect(state.projectiles).toEqual([]);
    expect(state.battleManager).toBeUndefined();
    expect(state.isPaused).toBe(false);
    expect(state.time.paused).toBe(false);
  });
});