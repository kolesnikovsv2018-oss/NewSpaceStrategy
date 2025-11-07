import { CombatShip } from '../entities/CombatShip';
import { CombatShipFactory } from '../entities/CombatShipFactory';
import { BattleManager } from '../entities/BattleManager';
import { IFaction, IBattleConfig } from '../entities/interfaces/CombatSystem';
import { ShipSprite } from '../entities/visuals/ShipSprite';

/**
 * Сцена боя
 */
export class BattleScene extends Phaser.Scene {
  private battleManager?: BattleManager;
  private shipSprites: Map<string, ShipSprite> = new Map();
  private infoText?: Phaser.GameObjects.Text;
  private statsText?: Phaser.GameObjects.Text;
  private isPaused: boolean = false;
  private projectiles: Phaser.GameObjects.Graphics[] = [];

  constructor() {
    super({ key: 'BattleScene' });
  }

  create() {
    // Создаем звездный фон
    this.createStarfield();

    // Создаем фракции и настраиваем бой
    this.setupBattle();

    // Создаем UI
    this.createUI();

    // Создаем визуализацию кораблей
    this.createShipVisuals();

    // Начинаем бой
    this.battleManager?.start();

    // Обработчики клавиш
    this.setupKeyHandlers();
  }

  /**
   * Настройка боя
   */
  private setupBattle(): void {
    const width = this.cameras.main.width;
    const height = this.cameras.main.height;

    // Создаем фракцию 1 (Синие)
    const faction1Ships = CombatShipFactory.createFleet('blue', {
      fighters: 5,
      frigates: 2,
      cruisers: 1
    });

    // Позиционируем корабли фракции 1 слева
    faction1Ships.forEach((ship, index) => {
      ship.position = {
        x: 100 + (index % 3) * 80,
        y: 150 + Math.floor(index / 3) * 100
      };
    });

    const faction1: IFaction = {
      id: 'blue',
      name: 'Синяя Армада',
      color: 0x0000ff,
      ships: faction1Ships
    };

    // Создаем фракцию 2 (Красные)
    const faction2Ships = CombatShipFactory.createFleet('red', {
      fighters: 6,
      frigates: 1,
      cruisers: 1
    });

    // Позиционируем корабли фракции 2 справа
    faction2Ships.forEach((ship, index) => {
      ship.position = {
        x: width - 100 - (index % 3) * 80,
        y: 150 + Math.floor(index / 3) * 100
      };
    });

    const faction2: IFaction = {
      id: 'red',
      name: 'Красный Легион',
      color: 0xff0000,
      ships: faction2Ships
    };

    // Создаем конфигурацию боя
    const battleConfig: IBattleConfig = {
      factions: [faction1, faction2],
      battlefieldWidth: width,
      battlefieldHeight: height,
      autoTarget: true,
      friendlyFire: false
    };

    // Создаем менеджер боя
    this.battleManager = new BattleManager(battleConfig);

    // Callback на завершение боя
    this.battleManager.onBattleEnd((_stats) => {
      console.log(this.battleManager?.getBattleReport());
      this.showBattleResults();
    });
  }

  /**
   * Создать звездный фон
   */
  private createStarfield(): void {
    for (let i = 0; i < 200; i++) {
      const x = Phaser.Math.Between(0, this.cameras.main.width);
      const y = Phaser.Math.Between(0, this.cameras.main.height);
      const scale = Phaser.Math.FloatBetween(0.1, 1);
      const alpha = Phaser.Math.FloatBetween(0.3, 1);
      
      this.add.circle(x, y, 1, 0xffffff, 1)
        .setScale(scale)
        .setAlpha(alpha);
    }
  }

  /**
   * Создать визуализацию кораблей
   */
  private createShipVisuals(): void {
    const allShips = this.battleManager?.getAllShips() || [];
    
    allShips.forEach((ship: CombatShip) => {
      const sprite = new ShipSprite(this, ship);
      this.shipSprites.set(ship.id, sprite);

      // Меняем цвет корабля в зависимости от фракции
      sprite.on('pointerdown', () => {
        console.log(ship.getCombatInfo());
      });
    });
  }

  /**
   * Создать UI
   */
  private createUI(): void {
    // Информация о бое
    this.infoText = this.add.text(10, 10, '', {
      fontSize: '14px',
      color: '#ffffff',
      backgroundColor: '#000000',
      padding: { x: 10, y: 5 }
    });

    // Статистика
    this.statsText = this.add.text(this.cameras.main.width - 10, 10, '', {
      fontSize: '13px',
      color: '#ffffff',
      backgroundColor: '#000000',
      padding: { x: 10, y: 5 }
    }).setOrigin(1, 0);

    // Инструкции
    this.add.text(this.cameras.main.width / 2, 10, 
      'SPACE - Пауза | ESC - Меню | Клик на корабль - Информация', {
      fontSize: '12px',
      color: '#ffff00',
      backgroundColor: '#000000',
      padding: { x: 10, y: 5 }
    }).setOrigin(0.5, 0);
  }

  /**
   * Настроить обработчики клавиш
   */
  private setupKeyHandlers(): void {
    this.input.keyboard?.on('keydown-SPACE', () => {
      this.isPaused = !this.isPaused;
      console.log(this.isPaused ? '⏸️ Пауза' : '▶️ Продолжить');
    });

    this.input.keyboard?.on('keydown-ESC', () => {
      this.scene.start('MenuScene');
    });
  }

  /**
   * Обновление сцены
   */
  update(_time: number, delta: number): void {
    if (this.isPaused) return;

    const deltaSeconds = delta / 1000;

    // Обновляем менеджер боя
    this.battleManager?.update(deltaSeconds);

    // Обновляем визуализацию кораблей
    this.shipSprites.forEach((sprite, shipId) => {
      const ship = this.battleManager?.getAllShips().find(s => s.id === shipId);
      if (ship) {
        // Уничтожаем спрайт если корабль уничтожен
        if (ship.isDestroyed && sprite.visible) {
          this.createExplosion(ship.position.x, ship.position.y);
          this.tweens.add({
            targets: sprite,
            alpha: 0,
            scale: 0.5,
            duration: 500,
            onComplete: () => {
              sprite.setVisible(false);
              sprite.destroy();
              this.shipSprites.delete(shipId);
            }
          });
        } else if (!ship.isDestroyed) {
          // Обновляем только живые корабли
          sprite.update(deltaSeconds);

          // Визуализация выстрелов
          if (ship.target && !ship.target.isDestroyed) {
            const distance = ship.getDistanceTo(ship.target);
            if (distance <= ship.weaponStats.range && ship.weaponStats.currentCooldown === 0) {
              this.createProjectile(ship, ship.target);
            }
          }
        }
      }
    });

    // Обновляем UI
    this.updateUI();
  }

  /**
   * Создать снаряд
   */
  private createProjectile(from: CombatShip, to: CombatShip): void {
    const projectile = this.add.graphics();
    projectile.lineStyle(2, 0xff0000, 1);
    projectile.lineBetween(from.position.x, from.position.y, to.position.x, to.position.y);
    
    this.projectiles.push(projectile);

    // Удаляем снаряд через короткое время
    this.time.delayedCall(100, () => {
      projectile.destroy();
      const index = this.projectiles.indexOf(projectile);
      if (index > -1) {
        this.projectiles.splice(index, 1);
      }
    });
  }

  /**
   * Создать взрыв
   */
  private createExplosion(x: number, y: number): void {
    // Создаем частицы взрыва
    for (let i = 0; i < 20; i++) {
      const particle = this.add.circle(x, y, 3, 0xff6600, 1);
      const angle = (i / 20) * Math.PI * 2;
      const speed = Phaser.Math.Between(50, 150);
      
      this.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * speed,
        y: y + Math.sin(angle) * speed,
        alpha: 0,
        duration: 500,
        onComplete: () => particle.destroy()
      });
    }

    // Вспышка
    const flash = this.add.circle(x, y, 30, 0xffffff, 0.8);
    this.tweens.add({
      targets: flash,
      scale: 2,
      alpha: 0,
      duration: 300,
      onComplete: () => flash.destroy()
    });
  }

  /**
   * Обновить UI
   */
  private updateUI(): void {
    if (!this.battleManager || !this.infoText || !this.statsText) return;

    const stats = this.battleManager.getStats();
    const aliveShips = this.battleManager.getAliveShips();
    const duration = Math.floor(stats.duration / 1000);

    // Основная информация
    this.infoText.setText(`
⚔️ СРАЖЕНИЕ
Время: ${duration}с
Кораблей в бою: ${aliveShips.length}/${stats.totalShips}
Уничтожено: ${stats.shipsDestroyed}
Урон: ${stats.totalDamage.toFixed(0)}
    `.trim());

    // Статистика по фракциям
    let statsText = '';
    stats.factionStats.forEach((factionStats, factionId) => {
      statsText += `\n${factionId.toUpperCase()}: ${factionStats.shipsAlive} живых`;
    });

    this.statsText.setText(statsText.trim());
  }

  /**
   * Показать результаты боя
   */
  private showBattleResults(): void {
    const report = this.battleManager?.getBattleReport() || '';
    
    // Создаем панель с результатами
    const panel = this.add.graphics();
    panel.fillStyle(0x000000, 0.9);
    panel.fillRect(
      this.cameras.main.width / 2 - 300,
      this.cameras.main.height / 2 - 250,
      600,
      500
    );
    panel.lineStyle(3, 0x00ff00, 1);
    panel.strokeRect(
      this.cameras.main.width / 2 - 300,
      this.cameras.main.height / 2 - 250,
      600,
      500
    );

    // Текст с результатами
    this.add.text(
      this.cameras.main.width / 2,
      this.cameras.main.height / 2 - 200,
      report,
      {
        fontSize: '14px',
        color: '#ffffff',
        align: 'center',
        wordWrap: { width: 550 }
      }
    ).setOrigin(0.5, 0);

    // Кнопка возврата в меню
    const button = this.add.text(
      this.cameras.main.width / 2,
      this.cameras.main.height / 2 + 200,
      'Вернуться в меню',
      {
        fontSize: '24px',
        color: '#ffffff',
        backgroundColor: '#444444',
        padding: { x: 20, y: 10 }
      }
    )
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });

    button
      .on('pointerover', () => button.setStyle({ backgroundColor: '#666666' }))
      .on('pointerout', () => button.setStyle({ backgroundColor: '#444444' }))
      .on('pointerdown', () => this.scene.start('MenuScene'));
  }
}
