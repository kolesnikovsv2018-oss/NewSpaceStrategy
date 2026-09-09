import { CombatShipFactory } from '../entities/CombatShipFactory';
import { BattleManager } from '../entities/BattleManager';
import { IFaction, IBattleConfig, IBattlePosition } from '../entities/interfaces/CombatSystem';
import { ShipSprite } from '../entities/visuals/ShipSprite';
import { createDesign, designSchema, type ShipDesign } from '../domain/shipDesign';

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
  private trialDesign?: ShipDesign;

  constructor() {
    super({ key: 'BattleScene' });
  }

  init(data: { design?: ShipDesign } = {}): void {
    this.trialDesign = data.design ? designSchema.parse(data.design) : undefined;
    this.sys.settings.data = {};
  }

  create() {
    this.isPaused = false;
    this.shipSprites.clear();
    this.projectiles = [];
    this.time.paused = false;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
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
    const faction1Ships = this.trialDesign ? [CombatShipFactory.createFromDesign(this.trialDesign, 'blue')] : CombatShipFactory.createFleet('blue', {
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
      name: this.trialDesign?.name ?? 'Синяя Армада',
      color: 0x0000ff,
      ships: faction1Ships
    };

    // Создаем фракцию 2 (Красные)
    const faction2Ships = this.trialDesign ? [CombatShipFactory.createFromDesign(createDesign('corvette', true), 'red')] : CombatShipFactory.createFleet('red', {
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
      name: this.trialDesign ? 'Эталонный корвет' : 'Красный Легион',
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
    
    allShips.forEach(ship => {
      const sprite = new ShipSprite(this, ship, ship.factionId === 'blue' ? 0x4488ff : 0xff6655);
      this.shipSprites.set(ship.id, sprite);

      // Информация относится к реальному экземпляру проекта.
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
      `SPACE — Пауза | ESC — ${this.trialDesign ? 'В верфь' : 'Меню'} | Клик на корабль — Информация`, {
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
    this.input.keyboard?.on('keydown-SPACE', this.togglePause, this);
    this.input.keyboard?.on('keydown-ESC', this.returnToMenu, this);
  }

  private togglePause(): void {
    this.isPaused = !this.isPaused;
    this.time.paused = this.isPaused;
    if (this.isPaused) this.tweens.pauseAll();
    else this.tweens.resumeAll();
  }

  private returnToMenu(): void {
    if (this.trialDesign) this.scene.start('ShipyardScene', { design: this.trialDesign });
    else this.scene.start('MenuScene');
  }

  private cleanup(): void {
    this.input.keyboard?.off('keydown-SPACE', this.togglePause, this);
    this.input.keyboard?.off('keydown-ESC', this.returnToMenu, this);
    this.shipSprites.clear();
    this.projectiles = [];
    this.battleManager = undefined;
    this.infoText = undefined;
    this.statsText = undefined;
    this.isPaused = false;
    this.time.paused = false;
  }

  /**
   * Обновление сцены
   */
  update(_time: number, delta: number): void {
    if (this.isPaused) return;

    const deltaSeconds = delta / 1000;

    // Обновляем менеджер боя
    this.battleManager?.update(deltaSeconds);
    // Trial can stalemate (armor, shields, exhausted ammo). Always allow a bounded experiment.
    if (this.trialDesign && (this.battleManager?.getStats().duration ?? 0) >= 120000) this.battleManager?.stop();
    this.renderBattleEvents();

    // Представления уже содержат прямую ссылку на модель; поиска по массиву нет.
    this.shipSprites.forEach(sprite => sprite.update(deltaSeconds));

    // Обновляем UI
    this.updateUI();
  }

  private renderBattleEvents(): void {
    for (const event of this.battleManager?.drainEvents() ?? []) {
      if (event.type === 'WeaponFired') {
        this.createProjectile(event.from, event.to);
        continue;
      }

      const sprite = this.shipSprites.get(event.shipId);
      if (!sprite) continue;
      // Исключаем из обновления сразу: анимация уничтожения запускается один раз.
      this.shipSprites.delete(event.shipId);
      this.createExplosion(event.position.x, event.position.y);
      this.tweens.add({
        targets: sprite,
        alpha: 0,
        scale: 0.5,
        duration: 500,
        onComplete: () => sprite.destroy()
      });
    }
  }

  /**
   * Создать снаряд
   */
  private createProjectile(from: IBattlePosition, to: IBattlePosition): void {
    const projectile = this.add.graphics();
    projectile.lineStyle(2, 0xff0000, 1);
    projectile.lineBetween(from.x, from.y, to.x, to.y);
    
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
    const stats = this.battleManager?.getStats();
    const winner = this.battleManager?.getWinner();
    const report = `${winner ? `Победитель: ${winner.name}` : 'Испытание завершено без победителя'}\n\n` +
      `Время: ${((stats?.duration ?? 0) / 1000).toFixed(1)} с\n` +
      `Потери: ${stats?.shipsDestroyed ?? 0} / ${stats?.totalShips ?? 0}\n\n` +
      [...(stats?.factionStats ?? [])].map(([id, faction]) =>
        `${id.toUpperCase()}: осталось ${faction.shipsAlive}, потери ${faction.shipsDestroyed}\n` +
        `Нанесено ${faction.damageDealt.toFixed(0)}, получено ${faction.damageTaken.toFixed(0)}`).join('\n\n');
    
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
      this.trialDesign ? 'Вернуться в верфь' : 'Вернуться в меню',
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
      .on('pointerdown', () => this.returnToMenu());
  }
}
