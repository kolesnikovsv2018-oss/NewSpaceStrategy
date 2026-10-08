import { describe, expect, it, vi } from 'vitest';
import { CombatShipFactory } from '../src/entities/CombatShipFactory';
import type { BattleManager } from '../src/entities/BattleManager';
import type { DesignedShip } from '../src/entities/DesignedShip';
import { createComponent, createDesign, installComponent, type ShipDesign } from '../src/domain/shipDesign';
import { COMBAT_SIMULATION_MAX_STEPS, COMBAT_SIMULATION_STEP } from '../src/domain/combatSimulation';
import { drawBlueprint } from '../src/ui/ShipBlueprint';
import type { ShipView } from '../src/entities/interfaces/ShipView';

// Contract tests only: Phaser rendering itself is checked separately in the browser.
vi.stubGlobal('Phaser', { Scene: class {}, GameObjects: { Container: class {} } });
vi.mock('phaser', () => ({ default: { Scene: class {} } }));
const { ShipSprite } = await import('../src/entities/visuals/ShipSprite');
const { BattleScene } = await import('../src/scenes/BattleScene');
const { ShipTestScene } = await import('../src/scenes/ShipTestScene');
const { ShipyardScene } = await import('../src/scenes/ShipyardScene');
const { ShipInfoPanel } = await import('../src/ui/ShipInfoPanel');
const panelLayout = ShipInfoPanel.prototype as unknown as { fitInfo(this: object, includeIcons: boolean): void };

describe('simulation/view boundary', () => {
  it('uses the supplied faction color for legacy ships regardless of their names', () => {
    const createLegacyView = (name: string): ShipView => ({
      id: name, name, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, isMoving: false,
      powerSource: { name: 'Power', currentEnergy: 100, energyCapacity: 100, energyOutput: 1 },
      engine: { name: 'Engine', thrust: 10, energyConsumption: 1 },
      cargoHold: { name: 'Cargo', capacity: 100, usedSpace: 0, currentWeight: 0, maxWeight: 50 },
      getDesign: () => undefined, getInstalledModuleNames: () => [], getInfo: () => '',
      getTotalCost: () => 0, getTotalWeight: () => 0, getCurrentMaxSpeed: () => 0, getMaxRange: () => 0,
      getFlightEstimate: () => ({ kind: 'stationary' })
    });
    const colorForName = (name: string) => {
      const fillStyle = vi.fn();
      const spritePrototype = ShipSprite.prototype as unknown as {
        drawShip(this: { ship: ShipView; shipBody: object; hullColor: number; getShipColor(): number }): void;
        getShipColor(this: { hullColor: number }): number;
      };
      const fakeSprite = { ship: createLegacyView(name), shipBody: {
        clear: vi.fn(), fillStyle, fillTriangle: vi.fn(), fillCircle: vi.fn(), fillRect: vi.fn(),
        lineStyle: vi.fn(), strokeTriangle: vi.fn()
      }, hullColor: 0xff6655, getShipColor: spritePrototype.getShipColor };
      spritePrototype.drawShip.call(fakeSprite);
      return fillStyle.mock.calls[0][0];
    };

    expect(colorForName('Разведчик')).toBe(0xff6655);
    expect(colorForName('Грузовоз')).toBe(0xff6655);
  });

  it('uses hull scale and component kind for project silhouettes and hardpoint colors', () => {
    const render = (design: ShipDesign) => {
      const graphics = {
        clear: vi.fn(), fillStyle: vi.fn(), fillTriangle: vi.fn(), fillRoundedRect: vi.fn(),
        lineStyle: vi.fn(), strokeTriangle: vi.fn(), fillRect: vi.fn(), fillCircle: vi.fn()
      };
      drawBlueprint(graphics as never, design, 0x4488ff);
      return graphics;
    };
    let fighter = createDesign('fighter');
    fighter = installComponent(fighter, 'engine_1', createComponent('engine'));
    fighter = installComponent(fighter, 'beam_1', createComponent('beam'));
    const battleship = createDesign('battleship');
    const fighterGraphics = render(fighter), battleshipGraphics = render(battleship);

    expect(fighterGraphics.fillStyle).toHaveBeenCalledWith(0x4488ff, 1);
    expect(fighterGraphics.fillStyle).toHaveBeenCalledWith(0x80f5b9, 1);
    expect(fighterGraphics.fillStyle).toHaveBeenCalledWith(0x74e4ff, 1);
    expect(battleshipGraphics.fillTriangle.mock.calls[0][3]).toBeGreaterThan(fighterGraphics.fillTriangle.mock.calls[0][3]);
  });

  it('renders a structural read-only view without legacy equipment or simulation methods', () => {
    const ship: ShipView = {
      id: 'view', name: 'View', position: { x: 20, y: 40 }, velocity: { x: 0, y: 0 }, isMoving: false,
      powerSource: { name: 'Power', currentEnergy: 100, energyCapacity: 100, energyOutput: 1 },
      engine: { name: 'Engine', thrust: 10, energyConsumption: 1 },
      cargoHold: { name: 'Cargo', capacity: 100, usedSpace: 0, currentWeight: 0, maxWeight: 50 },
      getDesign: () => undefined, getInstalledModuleNames: () => ['A', 'B'], getInfo: () => 'Read-only view',
      getTotalCost: () => 100, getTotalWeight: () => 10, getCurrentMaxSpeed: () => 20, getMaxRange: () => 100,
      getFlightEstimate: () => ({ kind: 'limited', seconds: 5, distance: 100 })
    };
    const graphics = {
      clear: vi.fn(), fillStyle: vi.fn(), fillTriangle: vi.fn(), fillCircle: vi.fn(), fillRect: vi.fn(),
      lineStyle: vi.fn(), strokeTriangle: vi.fn()
    };
    const fakeSprite = {
      ship, shipBody: graphics, getShipColor: () => 0x00aaff, setPosition: vi.fn(),
      drawEngineGlow: vi.fn(), drawEnergyBar: vi.fn(), drawSelectionCircle: vi.fn()
    };
    const draw = ShipSprite.prototype as unknown as { drawShip(this: typeof fakeSprite): void };
    draw.drawShip.call(fakeSprite);
    expect(graphics.fillCircle).toHaveBeenCalledTimes(3); // Cockpit + two module dots, no equipment array.
    ShipSprite.prototype.update.call(fakeSprite as unknown as InstanceType<typeof ShipSprite>, 0.1);
    expect(fakeSprite.setPosition).toHaveBeenCalledWith(20, 40);
    expect(ShipSprite.prototype.getShip.call(fakeSprite as unknown as InstanceType<typeof ShipSprite>)).toBe(ship);
    const panel = { ship, infoText: { setScale: vi.fn(), setText: vi.fn() }, fitInfo: vi.fn() };
    const update = ShipInfoPanel.prototype as unknown as { updateInfo(this: typeof panel): void };
    update.updateInfo.call(panel);
    expect(panel.infoText.setText).toHaveBeenCalledWith(expect.stringContaining('Установлено: 2 ед.'));
    expect(panel.infoText.setText).toHaveBeenCalledWith(expect.stringContaining('5.0 с / 100.0 такт. ед.'));
    expect(panel.infoText.setText).toHaveBeenCalledWith(expect.stringContaining('ЭЕ/с'));
    expect(panel.infoText.setText.mock.calls[0][0]).not.toContain('св.л.');
  });

  it('fits long project descriptions inside the viewport and removes legacy component icons', () => {
    const ship = CombatShipFactory.createFighter('blue');
    const background = { clear: vi.fn(), fillStyle: vi.fn(), fillRoundedRect: vi.fn(), lineStyle: vi.fn(), strokeRoundedRect: vi.fn() };
    const icon = { destroy: vi.fn() };
    const infoText = { width: 270, height: 1000, displayHeight: 1000, setText: vi.fn(), setScale: vi.fn((scale: number) => { infoText.displayHeight = infoText.height * scale; }) };
    const panel = { ship, scene: { cameras: { main: { height: 720 } } }, y: 20, background, infoText, componentIcons: [icon], fitInfo: panelLayout.fitInfo };
    const methods = ShipInfoPanel.prototype as unknown as { updateInfo(this: typeof panel): void; drawComponentVisuals(this: typeof panel): void };
    methods.updateInfo.call(panel);
    methods.drawComponentVisuals.call(panel);
    expect(infoText.setText).toHaveBeenCalledWith(ship.getInfo());
    expect(infoText.displayHeight + 84).toBeLessThanOrEqual(660);
    expect(background.fillRoundedRect).toHaveBeenCalledWith(0, 0, 300, 660, 10);
    expect(icon.destroy).toHaveBeenCalledOnce();
    expect(panel.componentIcons).toEqual([]);
  });

  it('fits legacy text in both dimensions and moves icons below it', () => {
    const background = { clear: vi.fn(), fillStyle: vi.fn(), fillRoundedRect: vi.fn(), lineStyle: vi.fn(), strokeRoundedRect: vi.fn() };
    const icon = { setY: vi.fn() };
    const infoText = { width: 600, height: 1400, displayHeight: 1400,
      setScale: vi.fn((scale: number) => { infoText.displayHeight = infoText.height * scale; }) };
    const panel = { scene: { cameras: { main: { height: 720 } } }, y: 20, background, infoText, componentIcons: [icon] };
    panelLayout.fitInfo.call(panel, true);
    expect(infoText.displayHeight + 134).toBeLessThanOrEqual(660);
    expect(infoText.width * infoText.setScale.mock.calls[0][0]).toBeLessThanOrEqual(270);
    expect(icon.setY).toHaveBeenCalledWith(84 + infoText.displayHeight);
    expect(background.fillRoundedRect).toHaveBeenCalledWith(0, 0, 300, 660, 10);
  });

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

  it('validates an explicit BattleScene seed and repeats identical combat without global RNG', () => {
    const scene = new BattleScene();
    const settings = { data: { seed: 4242 } };
    Object.assign(scene, { sys: { settings } });
    scene.init(settings.data);
    expect((scene as unknown as { battleSeed: number }).battleSeed).toBe(4242);
    expect(settings.data).toEqual({});
    expect(() => scene.init({ seed: 0 })).toThrow('Недопустимый seed боя');

    const run = (seed: number, frameDelta: number) => {
      const battleScene = new BattleScene();
      Object.assign(battleScene, {
        battleSeed: seed,
        trialDesign: undefined,
        isPaused: false,
        simulationAccumulator: 0,
        battleEnded: false,
        shipSprites: new Map(),
        cameras: { main: { width: 1280, height: 720 } },
        showBattleResults: vi.fn(),
        renderBattleEvents: () => manager?.drainEvents(),
        updateUI: vi.fn()
      });
      (battleScene as unknown as { setupBattle(): void }).setupBattle();
      const manager = (battleScene as unknown as { battleManager: BattleManager }).battleManager;
      manager.start();
      const sceneState = battleScene as unknown as { battleEnded: boolean; update(time: number, delta: number): void };
      const frameCount = COMBAT_SIMULATION_MAX_STEPS * COMBAT_SIMULATION_STEP * 1000 / frameDelta;
      for (let frame = 0; frame < frameCount && !sceneState.battleEnded; frame++) {
        sceneState.update(frame * frameDelta, frameDelta);
      }
      return {
        duration: manager.getStats().duration,
        report: manager.getBattleReport(),
        ships: manager.getAllShips().map(ship => ({ id: ship.id, position: ship.position,
          hull: ship.combatStats.currentHull, shield: ship.combatStats.currentShield,
          weapons: (ship as DesignedShip).getWeaponState() }))
      };
    };
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('global RNG used'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const at40Fps = run(4242, 25);
      const at20Fps = run(4242, 50);
      expect(at40Fps.duration).toBeGreaterThan(0);
      expect(at40Fps.duration).toBeLessThanOrEqual(COMBAT_SIMULATION_MAX_STEPS * COMBAT_SIMULATION_STEP * 1000);
      expect(at40Fps).toEqual(at20Fps);
    } finally { random.mockRestore(); log.mockRestore(); }
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

  it('accelerates simulation by accumulating more fixed steps, not by enlarging the step', () => {
    const scene = new BattleScene();
    const update = vi.fn();
    Object.assign(scene, {
      isPaused: false, simulationAccumulator: 0, simulationSpeed: 1, battleEnded: false,
      trialDesign: undefined, battleManager: { update, drainEvents: () => [] },
      shipSprites: new Map(), speedButtons: new Map()
    });
    const controls = scene as unknown as {
      setSimulationSpeed(speed: 1 | 2 | 4): void;
      update(time: number, delta: number): void;
      simulationAccumulator: number;
    };

    controls.setSimulationSpeed(4);
    controls.update(0, 100);

    expect(update).toHaveBeenCalledTimes(8);
    expect(update).toHaveBeenNthCalledWith(1, COMBAT_SIMULATION_STEP);
    expect(update).toHaveBeenNthCalledWith(8, COMBAT_SIMULATION_STEP);
    expect(controls.simulationAccumulator).toBeCloseTo(0);
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