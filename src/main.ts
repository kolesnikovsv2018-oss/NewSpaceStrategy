import 'phaser';
import { MainScene } from './scenes/MainScene';
import { LoadingScene } from './scenes/LoadingScene';
import { MenuScene } from './scenes/MenuScene';
import { ShipTestScene } from './scenes/ShipTestScene';
import { BattleScene } from './scenes/BattleScene';
import { ShipyardScene } from './scenes/ShipyardScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: 1280,
  height: 720,
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },
      debug: false
    }
  },
  scene: [LoadingScene, MenuScene, MainScene, ShipTestScene, BattleScene, ShipyardScene],
  backgroundColor: '#000000',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH
  }
};

export default new Phaser.Game(config);