import type Phaser from 'phaser';
import type { SystemId } from '../domain/campaign';
import type { CampaignSessionView } from '../domain/campaignSession';
import { ProductionPanel, type ProductionPanelState, type ProductionPanelActions } from './ProductionPanel';
import { BudgetPanel } from './BudgetPanel';

export type CampaignConfirmation = 'new' | 'menu' | 'save' | 'load';
const confirmationText: Record<CampaignConfirmation, string> = {
  new: 'Начать заново?\nТекущая партия будет потеряна.',
  menu: 'Выйти в меню?\nТекущая партия будет потеряна.',
  save: 'Заменить сохранение?\nПрежний слот будет перезаписан.',
  load: 'Загрузить кампанию?\nТекущая партия будет потеряна.'
};

interface PanelState {
  selectedId: SystemId;
  message: string;
  error: boolean;
  pending?: CampaignConfirmation;
  budgetOpen?: boolean;
  production?: ProductionPanelState;
}
interface PanelActions {
  select: (id: SystemId) => void;
  switchSide: () => void;
  command: (kind: 'explore' | 'colonize' | 'endTurn') => void;
  request: (action: CampaignConfirmation) => void;
  cancel: () => void;
  confirm: () => void;
  toggleProduction: () => void;
  toggleBudget: () => void;
  production: ProductionPanelActions;
}
const ownerName = (owner: 'blue' | 'red' | null): string =>
  owner === 'blue' ? 'Синий союз' : owner === 'red' ? 'Красная лига' : 'Нет колонии';

/** Projection-only renderer: no access to full campaign state or hidden definitions. */
export class CampaignPanel {
  private readonly root: Phaser.GameObjects.Container;
  private disposed = false;
  private production?: ProductionPanel;
  private budget?: BudgetPanel;

  constructor(private readonly scene: Phaser.Scene, session: CampaignSessionView, state: PanelState, actions: PanelActions) {
    const view = session.galaxy;
    this.root = scene.add.container(0, 0).setName('campaign-panel');
    const graphics = scene.add.graphics(); this.root.add(graphics);
    graphics.fillStyle(0x101e32).fillRoundedRect(24, 104, 820, 554, 18);
    graphics.lineStyle(1, 0x29455e).strokeRoundedRect(24, 104, 820, 554, 18);
    graphics.fillStyle(0x101e32).fillRoundedRect(868, 104, 388, 554, 18);
    graphics.lineStyle(1, 0x29455e).strokeRoundedRect(868, 104, 388, 554, 18);
    this.label(28, 22, 'ORION / ГАЛАКТИКА', 26, '#b4f1ff');
    this.label(28, 60, 'Локальная пошаговая партия · S3.26 · 6 систем', 14, '#859bb6');
    this.button(475, 24, 'Сохранить кампанию', 'campaign-save', () => actions.request('save'), !!state.pending);
    this.button(675, 24, 'Загрузить кампанию', 'campaign-load', () => actions.request('load'), !!state.pending);
    this.button(875, 24, 'Новая партия', 'campaign-new', () => actions.request('new'), !!state.pending);
    this.button(1075, 24, '← Меню · ESC', 'campaign-menu', () => actions.request('menu'), !!state.pending);
    this.label(46, 126, 'КАРТА ПЕРЕХОДОВ', 13, '#859bb6');
    this.button(440, 114, state.budgetOpen ? '← Карта' : 'Бюджет', 'campaign-budget', actions.toggleBudget, !!state.pending);
    this.button(630, 114, state.production ? '← Карта' : 'Производство', 'campaign-production', actions.toggleProduction, !!state.pending);
    this.label(46, 156, `Ход ${session.turn} · ${ownerName(session.activeFactionId)}`, 20, '#e4f2ff').setName('campaign-turn');
    this.label(46, 187, session.activeFactionId === view.factionId
      ? 'Ваша очередь: действия или завершение хода.'
      : 'Ход другой стороны. Смените сторону наблюдения для управления.', 14, '#a6e5d5').setName('campaign-turn-hint');
    if (state.budgetOpen) {
      this.budget = new BudgetPanel(scene, session);
    } else if (state.production) {
      this.production = new ProductionPanel(scene, session, state.selectedId, state.production, actions.production, !!state.pending);
    } else {
      this.label(46, 620, '○ Неизвестно     ◇ Разведано     ● Колония', 15, '#b5c7dc');
      const positions = new Map(view.systems.map(system => [system.id, { x: 115 + system.x * 208, y: 348 - system.y * 108 }]));
      for (const [from, to] of view.lanes) {
        const a = positions.get(from), b = positions.get(to);
        if (a && b) graphics.lineStyle(2, 0x34536d).lineBetween(a.x, a.y, b.x, b.y);
      }
      for (const system of view.systems) {
        const point = positions.get(system.id)!;
        const known = system.visibility === 'explored';
        const color = !known ? 0x728398 : system.ownerId === 'blue' ? 0x60bdff : system.ownerId === 'red' ? 0xff927d : 0x88e5ca;
        if (system.id === state.selectedId) graphics.lineStyle(2, 0xe2f5ff).strokeCircle(point.x, point.y, 29);
        graphics.fillStyle(color, 0.12).fillCircle(point.x, point.y, 22);
        graphics.fillStyle(color).fillCircle(point.x, point.y, known ? 9 : 4);
        const marker = !known ? '○' : system.ownerId === null ? '◇' : '●';
        this.button(point.x - 67, point.y + 34, `${marker} ${system.name}`, `system-${system.id}`,
          () => actions.select(system.id), !!state.pending);
      }
    }
    this.label(892, 126, 'СТОРОНА НАБЛЮДЕНИЯ', 13, '#859bb6');
    this.label(892, 150, ownerName(view.factionId), 22, view.factionId === 'blue' ? '#60bdff' : '#ff927d').setName('campaign-side');
    this.button(892, 184, 'Сменить сторону · локально', 'campaign-side-switch', actions.switchSide, !!state.pending);
    this.label(892, 236, `Кредиты: ${session.treasury.credits}\nМинералы: ${session.treasury.minerals}`, 17, '#e4f2ff')
      .setLineSpacing(5).setName('campaign-treasury');
    this.label(892, 286, `Доход при завершении своего хода:\n+${session.income.credits} кредитов · +${session.income.minerals} минералов`, 14, '#a6e5d5')
      .setLineSpacing(5).setName('campaign-income');
    const selected = view.systems.find(system => system.id === state.selectedId);
    this.label(892, 344, selected?.name ?? 'Выберите систему', 24, '#e4f2ff').setName('campaign-system-name');
    const details = !selected || selected.visibility === 'unknown'
      ? 'Не разведана\nВладелец: неизвестен\nПригодность: неизвестна'
      : `Разведана\nВладелец: ${ownerName(selected.ownerId)}\n${selected.habitable ? 'Пригодна для колонизации' : 'Непригодна для колонизации'}`;
    this.label(892, 386, details, 15, '#c8d9ed').setLineSpacing(6).setName('campaign-system-details');
    this.button(892, 478, 'Разведать', 'campaign-explore', () => actions.command('explore'), !!state.pending);
    this.button(1050, 478, 'Колонизировать', 'campaign-colonize', () => actions.command('colonize'), !!state.pending);
    this.button(892, 526, 'Завершить ход', 'campaign-end-turn', () => actions.command('endTurn'), !!state.pending);
    this.label(892, state.pending ? 566 : 574, state.pending
      ? confirmationText[state.pending]
      : state.message, 16, state.error && !state.pending ? '#ffad9f' : '#a6e5d5')
      .setWordWrapWidth(338).setLineSpacing(5).setName('campaign-message');
    if (state.pending) {
      this.button(892, 614, 'Отмена · ESC', 'campaign-cancel', actions.cancel);
      this.button(1066, 614, 'Продолжить', 'campaign-confirm', actions.confirm);
    }
    this.label(28, 680, 'Ручной локальный слот · Обе стороны целиком · Без автосохранения · Боя и AI кампании нет.', 15, '#99adc5');
  }

  private label(x: number, y: number, value: string, size: number, color: string): Phaser.GameObjects.Text {
    const text = this.scene.add.text(x, y, value, { fontFamily: 'Arial', fontSize: `${size}px`, color });
    this.root.add(text); return text;
  }

  private button(x: number, y: number, value: string, name: string, action: () => void, disabled = false): void {
    const text = this.label(x, y, value, 15, disabled ? '#65768d' : '#e3f5ff').setName(name)
      .setPadding(10, 9).setBackgroundColor('#233e58');
    if (disabled) return;
    text.setInteractive({ useHandCursor: true });
    text.on('pointerover', () => { if (!this.disposed) text.setBackgroundColor('#345e79'); });
    text.on('pointerout', () => { if (!this.disposed) text.setBackgroundColor('#233e58'); });
    text.on('pointerdown', () => { if (!this.disposed) action(); });
  }

  destroy(): void { if (this.disposed) return; this.disposed = true; this.production?.destroy(); this.budget?.destroy(); this.root.destroy(); }
}
