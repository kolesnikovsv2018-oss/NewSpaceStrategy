import type Phaser from 'phaser';
import { openShipyardModal } from './ShipyardModal';

export const CONQUEST_TEXT_SIZE = 14;
export const CONQUEST_BUTTON_HEIGHT = 44;

export function fitText(label: Phaser.GameObjects.Text, width: number): Phaser.GameObjects.Text {
  const characters = Array.from(label.text);
  while (label.context.measureText(label.text).width > width && characters.length > 1) {
    characters.pop();
    label.setText(`${characters.join('')}…`);
  }
  return label;
}

export function text(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, x: number, y: number,
  value: string, size = CONQUEST_TEXT_SIZE, color = '#c8d9ed'): Phaser.GameObjects.Text {
  const label = scene.add.text(x, y, value, { fontFamily: 'Arial', fontSize: `${Math.max(CONQUEST_TEXT_SIZE, size)}px`, color });
  parent.add(label);
  return label;
}

export function button(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, x: number, y: number,
  label: string, action: () => void, name = label, width = 170): Phaser.GameObjects.Text {
  const item = text(scene, parent, x, y, label, 14, '#e5f5ff');
  item.setName(name).setPadding(10, 12).setBackgroundColor('#233e58').setFixedSize(width, CONQUEST_BUTTON_HEIGHT)
    .setInteractive({ useHandCursor: true });
  fitText(item, width - 20);
  item.on('pointerover', () => item.setBackgroundColor('#376380'));
  item.on('pointerout', () => item.setBackgroundColor('#233e58'));
  item.on('pointerdown', () => { if (item.active) action(); });
  return item;
}

export function conquestDialogLayout(width: number, height: number): { x: number; y: number; width: number; rows: number } {
  return { x: Math.max(12, (width - 720) / 2), y: 24, width: Math.min(720, width - 24),
    rows: Math.max(1, Math.min(8, Math.floor((height - 180) / 52))) };
}

export function chooseItem<T>(scene: Phaser.Scene, title: string, items: Array<{ label: string; value: T }>, select: (value: T) => void): void {
  const modal = openShipyardModal(scene);
  if (!modal) return;
  const layout = conquestDialogLayout(scene.cameras.main.width, scene.cameras.main.height);
  const content = scene.add.container(layout.x, layout.y); modal.overlay.add(content);
  let page = 0;
  const render = () => {
    content.removeAll(true);
    text(scene, content, 0, 0, title, 20);
    items.slice(page * layout.rows, (page + 1) * layout.rows).forEach((item, index) => {
      button(scene, content, 0, 52 + index * 52, item.label, () => { if (modal.close()) select(item.value); },
        `choice-${page * layout.rows + index}`, layout.width);
    });
    const y = 62 + layout.rows * 52, pages = Math.max(1, Math.ceil(items.length / layout.rows));
    button(scene, content, 0, y, '←', () => { page = Math.max(0, page - 1); render(); }, 'choice-prev', 44);
    text(scene, content, 54, y + 13, `${page + 1} / ${pages}`);
    button(scene, content, 130, y, '→', () => { page = Math.min(pages - 1, page + 1); render(); }, 'choice-next', 44);
    button(scene, content, layout.width - 120, y, 'Закрыть', () => modal.close(), 'close-choice', 120);
  };
  render();
}

export const CONQUEST_HELP = [
  ['Первый маршрут', '1. Исследуйте support: цена списывается один раз, прогресс +1 за свой конец хода.\n\n2. В своей колонии откройте производство, выберите доступный проект и оплатите заказ.\n\n3. Завершайте свои ходы до готовности, затем нажмите «Разместить». Чертёж сам по себе не является кораблём.'],
  ['Разведка и перелёт', 'Наблюдение дают своя колония, стоящий корабль и сканер. Без присутствия прежнее наблюдение снова скрывается.\n\nВыберите мир → «Корабли» → корабль или группу → соседнюю цель. Одна линия расходует 1 топлива каждого участника; прибытие — на свой конец хода. Бак 3; заправка в своей колонии стоит 5 кредитов / 2 минерала за единицу.'],
  ['Производство и службы', 'Заказ полностью оплачивается сразу. Только первый заказ каждой своей колонии продвигается за свой конец хода; готовый корабль нужно разместить отдельно.\n\nОтмена возвращает долю цены за оставшиеся ходы. Ремонт и снаряды оплачиваются отдельно; цены показаны для выбранного корабля. В чужой системе заправка и пополнение недоступны.'],
  ['Колонизация и победа', 'Гражданский корабль может колонизировать наблюдаемую свободную пригодную планету без врагов. Вооружённый корабль занимает её автоматически на конец хода.\n\nЗахват чужого мира требует вооружённого присутствия и отсутствия живых защитников. Победа — все пригодные миры карты, а не только столица. После победы игровые команды запрещены; просмотр и сохранение доступны.'],
  ['Ход, бой и компьютер', 'Стратегический ход — окно действий одной стороны. Доход, содержание, FIFO и исследование продвигаются на её конец хода, не по секундам экрана.\n\nБой рассчитывается тактами по 0,05 с, максимум 120 с. Просмотр отчёта и replay не выполняют новую команду, не лечат и не развивают экономику.\n\nПосле загрузки ход AI приостановлен: продолжите его явно. Справка приостанавливает ожидающий AI; ESC только закрывает справку.']
] as const;
