import type { ICombatant, IFaction, IBattleConfig, IBattleStats, IAttackResult, BattleEvent } from './interfaces/CombatSystem';

const LINE_FORMATION_SPACING = 60;
const COVER_CORRIDOR_RADIUS = 20;

/**
 * Менеджер боевой системы
 */
export class BattleManager {
  private config: IBattleConfig;
  private stats: IBattleStats;
  private allShips: ICombatant[] = [];
  private isActive: boolean = false;
  private isFinished: boolean = false;
  private events: BattleEvent[] = [];
  private battleEndCallback?: (stats: IBattleStats) => void;
  private simulationStep = 0;

  constructor(config: IBattleConfig, private readonly environment: {
    now?: () => number;
    silent?: boolean;
    alternateFactionOrder?: boolean;
    firstFactionId?: string;
  } = {}) {
    this.config = config;
    
    // Собираем все корабли
    config.factions.forEach(faction => {
      this.allShips.push(...faction.ships);
    });

    // Инициализируем статистику
    this.stats = {
      startTime: this.environment.now ? this.environment.now() : Date.now(),
      duration: 0,
      totalShips: this.allShips.length,
      shipsDestroyed: 0,
      totalDamage: 0,
      factionStats: new Map()
    };

    // Инициализируем статистику фракций
    config.factions.forEach(faction => {
      this.stats.factionStats.set(faction.id, {
        shipsAlive: faction.ships.length,
        shipsDestroyed: 0,
        kills: 0,
        damageDealt: 0,
        damageTaken: 0
      });
    });
  }

  /**
   * Начать бой
   */
  start(): void {
    if (this.isActive || this.isFinished) return;
    this.isActive = true;
    this.stats.startTime = this.environment.now ? this.environment.now() : Date.now();
    if (!this.environment.silent) console.log('⚔️ Бой начался!');
  }

  /**
   * Остановить бой
   */
  stop(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.isFinished = true;
    if (!this.environment.silent) console.log('🏁 Бой завершен!');
    if (this.battleEndCallback) {
      this.battleEndCallback(this.stats);
    }
  }

  /**
   * Установить callback на завершение боя
   */
  onBattleEnd(callback: (stats: IBattleStats) => void): void {
    this.battleEndCallback = callback;
  }

  /** Забрать события ровно один раз, в том числе после завершающего бой удара. */
  drainEvents(): BattleEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /**
   * Обновление боевой системы
   */
  update(deltaTime: number): void {
    if (!this.isActive || !Number.isFinite(deltaTime) || deltaTime <= 0) return;

    this.stats.duration += deltaTime * 1000;

    if (this.environment.alternateFactionOrder) {
      const factions = [...this.config.factions];
      const firstFactionIndex = factions.findIndex(faction => faction.id === this.environment.firstFactionId);
      if (firstFactionIndex > 0) factions.push(...factions.splice(0, firstFactionIndex));
      if (this.simulationStep % 2 === 1) factions.reverse();
      factions.forEach(faction => faction.ships.forEach(ship => this.updateShip(ship, deltaTime)));
      this.simulationStep++;
    } else {
      this.allShips.forEach(ship => this.updateShip(ship, deltaTime));
    }

    // Проверяем условие окончания боя
    this.checkBattleEnd();
  }

  private updateShip(ship: ICombatant, deltaTime: number): void {
    if (ship.isDestroyed) return;
    ship.update(deltaTime);
    if (this.config.autoTarget) this.updateShipBehavior(ship);
  }

  /**
   * Обновить поведение корабля
   */
  private updateShipBehavior(ship: ICombatant): void {
    // Если нет цели или цель уничтожена, ищем новую
    if (!ship.target || ship.target.isDestroyed) {
      const enemies = this.getEnemies(ship.factionId);
      ship.target = this.selectTarget(ship, enemies);
    }

    // Если есть цель
    if (ship.target) {
      // Двигаемся к цели
      const preferredRange = ship.getPreferredCombatRange?.();
      const weaponRange = ship.weaponStats.range;
      const formationOffset = this.getFormationOffset(ship, ship.target);
      if (preferredRange !== undefined && Number.isFinite(preferredRange) && preferredRange >= 0 &&
        weaponRange > 0 && preferredRange < weaponRange * 0.8) {
        if (formationOffset) ship.moveToTarget(ship.target, preferredRange / weaponRange, formationOffset);
        else ship.moveToTarget(ship.target, preferredRange / weaponRange);
      } else if (formationOffset) {
        ship.moveToTarget(ship.target, undefined, formationOffset);
      } else {
        ship.moveToTarget(ship.target);
      }

      // Каждое готовое орудие может выстрелить в этом шаге. Обрабатываем урон сразу,
      // чтобы последующие орудия не засчитали уничтожение цели повторно.
      for (let attempt = 0; attempt < ship.getAttackAttemptsPerStep(); attempt++) {
        const attackTarget = this.getInterceptionTarget(ship, ship.target);
        const attackResult = ship.attack(attackTarget);
        if (!attackResult) break;
        this.events.push({
          type: 'WeaponFired',
          attackerId: ship.id,
          targetId: attackTarget.id,
          from: { ...ship.position },
          to: { ...attackTarget.position },
          hit: attackResult.hit
        });
        this.processAttack(ship, attackTarget, attackResult);
      }
    }
  }

  private getInterceptionTarget(attacker: ICombatant, intendedTarget: ICombatant): ICombatant {
    if (this.config.cover !== 'line-of-fire') return intendedTarget;
    const dx = intendedTarget.position.x - attacker.position.x;
    const dy = intendedTarget.position.y - attacker.position.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length === 0) return intendedTarget;
    const directionX = dx / length;
    const directionY = dy / length;
    let intercept: ICombatant | undefined;
    let interceptDistance = length;

    for (const candidate of this.allShips) {
      if (candidate === attacker || candidate === intendedTarget || candidate.isDestroyed ||
        candidate.factionId !== intendedTarget.factionId) continue;
      const relativeX = candidate.position.x - attacker.position.x;
      const relativeY = candidate.position.y - attacker.position.y;
      const along = relativeX * directionX + relativeY * directionY;
      if (along <= 0 || along >= length || along > interceptDistance) continue;
      const nearestX = attacker.position.x + directionX * along;
      const nearestY = attacker.position.y + directionY * along;
      const lateralDistance = Math.hypot(candidate.position.x - nearestX, candidate.position.y - nearestY);
      if (lateralDistance > COVER_CORRIDOR_RADIUS) continue;
      if (along === interceptDistance && intercept && candidate.id >= intercept.id) continue;
      intercept = candidate;
      interceptDistance = along;
    }
    return intercept ?? intendedTarget;
  }

  private getFormationOffset(ship: ICombatant, target: ICombatant): { x: number; y: number } | undefined {
    if (this.config.formation !== 'line-abreast') return undefined;
    const factionShips = this.config.factions.find(faction => faction.id === ship.factionId)?.ships
      .filter(member => !member.isDestroyed);
    if (!factionShips || factionShips.length < 2) return { x: 0, y: 0 };
    const slot = factionShips.indexOf(ship);
    const lateralPosition = slot - (factionShips.length - 1) / 2;
    const dx = target.position.x - ship.position.x;
    const dy = target.position.y - ship.position.y;
    const distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance) || distance === 0) return { x: 0, y: lateralPosition * LINE_FORMATION_SPACING };
    const offset = lateralPosition * LINE_FORMATION_SPACING;
    const x = -dy / distance * offset;
    const y = dx / distance * offset;
    return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
  }

  private selectTarget(ship: ICombatant, enemies: readonly ICombatant[]): ICombatant | undefined {
    if (this.config.targetPriority !== 'lowest-hull-ratio') return ship.findNearestEnemy(enemies);
    return enemies.reduce<ICombatant | undefined>((best, candidate) => {
      if (!best) return candidate;
      const candidateHullRatio = candidate.combatStats.maxHull > 0
        ? candidate.combatStats.currentHull / candidate.combatStats.maxHull : candidate.combatStats.currentHull;
      const bestHullRatio = best.combatStats.maxHull > 0
        ? best.combatStats.currentHull / best.combatStats.maxHull : best.combatStats.currentHull;
      if (candidateHullRatio !== bestHullRatio) return candidateHullRatio < bestHullRatio ? candidate : best;

      const distance = (target: ICombatant) => Math.hypot(ship.position.x - target.position.x, ship.position.y - target.position.y);
      const candidateDistance = distance(candidate);
      const bestDistance = distance(best);
      if (candidateDistance !== bestDistance) return candidateDistance < bestDistance ? candidate : best;
      return candidate.id < best.id ? candidate : best;
    }, undefined);
  }

  /**
   * Обработать результат атаки
   */
  private processAttack(attacker: ICombatant, target: ICombatant, result: IAttackResult): void {
    if (!result.hit) return;

    // Обновляем статистику
    this.stats.totalDamage += result.damage;

    const attackerStats = this.stats.factionStats.get(attacker.factionId);
    const targetStats = this.stats.factionStats.get(target.factionId);

    if (attackerStats) {
      attackerStats.damageDealt += result.damage;
    }

    if (targetStats) {
      targetStats.damageTaken += result.damage;
    }

    // Если цель уничтожена
    if (target.isDestroyed) {
      this.stats.shipsDestroyed++;
      
      if (attackerStats) {
        attackerStats.kills++;
      }
      
      if (targetStats) {
        targetStats.shipsAlive--;
        targetStats.shipsDestroyed++;
      }

      this.events.push({
        type: 'ShipDestroyed',
        shipId: target.id,
        position: { ...target.position }
      });

      if (!this.environment.silent) console.log(`💥 ${target.name} (${target.factionId}) уничтожен кораблем ${attacker.name} (${attacker.factionId})`);
    }
  }

  /**
   * Получить вражеские корабли для фракции
   */
  private getEnemies(factionId: string): ICombatant[] {
    return this.allShips.filter(ship => {
      if (this.config.friendlyFire) {
        return ship.factionId !== factionId;
      }
      return !ship.isDestroyed && ship.factionId !== factionId;
    });
  }

  /**
   * Проверить условия окончания боя
   */
  private checkBattleEnd(): void {
    // Подсчитываем живые фракции
    const aliveFactions = new Set<string>();
    
    this.allShips.forEach(ship => {
      if (!ship.isDestroyed) {
        aliveFactions.add(ship.factionId);
      }
    });

    // Бой заканчивается когда остается одна или ноль фракций
    if (aliveFactions.size <= 1) {
      this.stop();
    }
  }

  /**
   * Получить статистику боя
   */
  getStats(): IBattleStats {
    return this.stats;
  }

  /**
   * Получить победителя
   */
  getWinner(): IFaction | null {
    const aliveFactions = this.config.factions.filter(faction => {
      return faction.ships.some(ship => !ship.isDestroyed);
    });

    return aliveFactions.length === 1 ? aliveFactions[0] : null;
  }

  /**
   * Получить все корабли
   */
  getAllShips(): ICombatant[] {
    return this.allShips;
  }

  /**
   * Получить корабли фракции
   */
  getFactionShips(factionId: string): ICombatant[] {
    return this.allShips.filter(ship => ship.factionId === factionId);
  }

  /**
   * Получить живые корабли
   */
  getAliveShips(): ICombatant[] {
    return this.allShips.filter(ship => !ship.isDestroyed);
  }

  /**
   * Получить уничтоженные корабли
   */
  getDestroyedShips(): ICombatant[] {
    return this.allShips.filter(ship => ship.isDestroyed);
  }

  /**
   * Получить отчет о бое
   */
  getBattleReport(): string {
    const duration = Math.floor(this.stats.duration / 1000);
    let report = `
╔═══════════════════════════════════════╗
║         ОТЧЕТ О СРАЖЕНИИ              ║
╚═══════════════════════════════════════╝

Длительность: ${duration}с
Всего кораблей: ${this.stats.totalShips}
Уничтожено: ${this.stats.shipsDestroyed}
Общий урон: ${this.stats.totalDamage.toFixed(0)}

`;

    // Статистика по фракциям
    this.config.factions.forEach(faction => {
      const factionStats = this.stats.factionStats.get(faction.id);
      if (factionStats) {
        const aliveShips = this.getFactionShips(faction.id).filter(s => !s.isDestroyed);
        const status = aliveShips.length === 0 ? '✗ Поражение' : this.getWinner()?.id === faction.id ? '✓ Победа' : 'Без победителя';
        
        report += `
━━━ ${faction.name} ━━━
Статус: ${status}
Живых кораблей: ${aliveShips.length}/${faction.ships.length}
Потери: ${factionStats.shipsDestroyed}
Уничтожено врагов: ${factionStats.kills}
Нанесено урона: ${factionStats.damageDealt.toFixed(0)}
Получено урона: ${factionStats.damageTaken.toFixed(0)}
`;
      }
    });

    const winner = this.getWinner();
    if (winner) {
      report += `
\n🏆 Победитель: ${winner.name}`;
    } else {
      report += this.getAliveShips().length === 0 ? `\n⚔️ Ничья - все фракции уничтожены` : `\n⚔️ Бой остановлен без победителя`;
    }

    return report;
  }
}
