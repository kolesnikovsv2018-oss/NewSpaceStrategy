import type Phaser from 'phaser';
import { openShipyardModal } from './ShipyardModal';

export function text(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, x: number, y: number,
  value: string, size = 13, color = '#c8d9ed'): Phaser.GameObjects.Text {
  const label = scene.add.text(x, y, value, { fontFamily: 'Arial', fontSize: `${size}px`, color });
  parent.add(label);
  return label;
}

export function button(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, x: number, y: number,
  label: string, action: () => void, name = label): Phaser.GameObjects.Text {
  const item = text(scene, parent, x, y, label, 12, '#e5f5ff');
  item.setName(name).setPadding(9, 7).setBackgroundColor('#233e58').setInteractive({ useHandCursor: true });
  item.on('pointerover', () => item.setBackgroundColor('#376380'));
  item.on('pointerout', () => item.setBackgroundColor('#233e58'));
  item.on('pointerdown', action);
  return item;
}

export function panelBackground(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, width: number, height: number): void {
  const background = scene.add.graphics();
  background.fillStyle(0x101f32, 0.98).fillRoundedRect(0, 0, width, height, 12);
  background.lineStyle(1, 0x355c7d).strokeRoundedRect(0, 0, width, height, 12);
  parent.add(background);
}

export function chooseItem<T>(scene: Phaser.Scene, title: string, items: Array<{ label: string; value: T }>, select: (value: T) => void): void {
  const modal = openShipyardModal(scene);
  if (!modal) return;
  const { overlay, close } = modal;
  const width = scene.cameras.main.width;
  const height = scene.cameras.main.height;
  const content = scene.add.container(width / 2 - 250, height / 2 - 235);
  overlay.add(content);
  let page = 0;
  const render = () => {
    content.removeAll(true);
    panelBackground(scene, content, 500, 470);
    text(scene, content, 20, 20, title, 18);
    const rows = items.slice(page * 8, page * 8 + 8);
    if (!rows.length) text(scene, content, 20, 75, 'Список пуст');
    rows.forEach((item, index) => {
      button(scene, content, 20, 65 + index * 40, item.label, () => { if (close()) select(item.value); }, `choice-${page * 8 + index}`)
        .setFixedSize(460, 32);
    });
    button(scene, content, 20, 420, '←', () => { page = Math.max(0, page - 1); render(); });
    text(scene, content, 70, 430, `${page + 1} / ${Math.max(1, Math.ceil(items.length / 8))}`);
    button(scene, content, 150, 420, '→', () => { page = Math.min(Math.max(0, Math.ceil(items.length / 8) - 1), page + 1); render(); });
    button(scene, content, 385, 420, 'Закрыть', close, 'close-choice');
  };
  render();
}

export function confirmDiscard(scene: Phaser.Scene, action: () => void): void {
  const modal = openShipyardModal(scene);
  if (!modal) return;
  const { overlay, close } = modal;
  const content = scene.add.container(scene.cameras.main.width / 2 - 270, scene.cameras.main.height / 2 - 130);
  overlay.add(content);
  panelBackground(scene, content, 540, 260);
  text(scene, content, 24, 24, 'Проект не сохранён', 22, '#ffc880');
  text(scene, content, 24, 72,
    'Продолжить без сохранения текущего проекта?\nОтмените действие, чтобы вернуться и сохранить его.\nБиблиотека сохранённых проектов не изменится.', 15)
    .setWordWrapWidth(492).setLineSpacing(6);
  button(scene, content, 24, 200, 'Отмена · ESC', close, 'discard-cancel');
  button(scene, content, 236, 200, 'Продолжить без сохранения', () => { if (close()) action(); }, 'discard-confirm')
    .setBackgroundColor('#754431');
}
