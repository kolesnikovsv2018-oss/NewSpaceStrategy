import type Phaser from 'phaser';
import type { CampaignSessionView } from '../domain/campaignSession';

/** Read-only budget projection. Never reconstructs prices, counts or payments from ships. */
export class BudgetPanel {
  private readonly root: Phaser.GameObjects.Container;
  private disposed = false;

  constructor(private readonly scene: Phaser.Scene, session: CampaignSessionView) {
    this.root = scene.add.container(0, 0).setName('campaign-budget-panel');
    const faction = session.galaxy.factionId;
    this.label(232, `БЮДЖЕТ · ${faction === 'blue' ? 'Синий союз' : 'Красная лига'}`, 'budget-title', 24, '#b4f1ff');
    this.label(273, session.activeFactionId === faction ? 'Прогноз завершения текущего хода'
      : 'Условный прогноз своего хода · сейчас ход другой стороны', 'budget-context', 16, '#a6e5d5');
    this.label(310, `Сейчас: ${session.treasury.credits} кр. / ${session.treasury.minerals} мин.`, 'budget-treasury');
    this.label(347, `Валовой доход: +${session.income.credits} кр. / +${session.income.minerals} мин.`, 'budget-income');
    const forecast = session.economyForecast;
    if (forecast.ok) {
      this.label(384, `Кораблей на содержании: ${forecast.upkeep.shipCount}`, 'budget-ships');
      this.label(416, `Начислено: ${forecast.upkeep.dueCredits} кр.`, 'budget-due');
      this.label(448, `Будет списано: ${forecast.upkeep.paidCredits} кр.`, 'budget-paid');
      this.label(480, `Дефицит: ${forecast.upkeep.shortfallCredits} кр. (без долга)`, 'budget-shortfall', 18,
        forecast.upkeep.shortfallCredits ? '#ffcc86' : '#a6e5d5');
      this.label(518, `Остаток после расчёта: ${forecast.treasuryAfter.credits} кр. / ${forecast.treasuryAfter.minerals} мин.`,
        'budget-after', 20, '#b4f1ff');
    } else {
      this.label(390, forecast.code === 'TURN_LIMIT'
        ? 'TURN_LIMIT: достигнут предел номера хода. Расчёт не будет выполнен.'
        : 'RESOURCE_LIMIT: валовой доход превысит предел ресурсов. Списание не исправляет переполнение.',
      'budget-error', 19, '#ffad9f').setWordWrapWidth(750);
    }
    this.label(563, 'Участие в группах и перелёты не дают скидок. Дефицит — не долг и не блокирует ход.',
      'budget-rule', 14, '#99adc5').setWordWrapWidth(750);
    this.label(612, 'Это прогноз, не квитанция. Фактический платёж — в сообщении справа.',
      'budget-note', 14, '#99adc5').setWordWrapWidth(750);
  }

  private label(y: number, text: string, name: string, size = 18, color = '#e4f2ff'): Phaser.GameObjects.Text {
    const node = this.scene.add.text(46, y, text, { fontFamily: 'Arial', fontSize: `${size}px`, color }).setName(name);
    this.root.add(node); return node;
  }

  destroy(): void { if (this.disposed) return; this.disposed = true; this.root.destroy(); }
}