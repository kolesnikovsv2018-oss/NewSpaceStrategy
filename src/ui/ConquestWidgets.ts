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
  ['Первый маршрут', '1. Назначьте часть рабочих в науку в производстве. Выберите доступную стартовую ветвь: цена — научные очки, не кредиты. На свой конец хода расходуется резерв и текущий выпуск; максимум одно открытие. Переключение и пауза сохраняют прогресс. Без колоний наука приостановлена.\n\n2. В своей колонии выберите доступный проект и оплатите производство. Промышленные рабочие нужны отдельно от научных.\n\n3. Завершайте свои ходы до готовности, затем нажмите «Разместить». Чертёж сам по себе не является кораблём.'],
  ['Разведка и перелёт', 'Наблюдение дают своя колония, стоящий корабль и сканер в радиусе стратегической дальности. Без присутствия актуальное наблюдение снова скрывается.\n\nЛиний нет: выберите корабль/группу и любую прямую цель в пределах дальности.   Начальный проект: скорость100 ед./свой ход, переход200, бак3.000. Расход округляется вверх до тысячной:0.005 топлива/ед.; срок — вверх distance/speed. Группа летит по самым медленным speed/jump; списание каждого до старта. В пути нет присутствия/служб/добычи. Исследования открывают оснащение для build/refit, не меняют старый корабль. Срок/расход/отказ показаны до подтверждения.'],
  ['Производство и службы', 'Заказ полностью оплачивается сразу. Первый FIFO-заказ колонии получает очки работников с технологическими бонусами на свой конец хода. При нуле промышленности заказ приостановлен; избыток не переносится. Готовый корабль размещается отдельно.\n\nОтмена возвращает долю цены за неприменённые очки. Научный резерв расходуется на выбранный узел. «Разбивка колонии» показывает базу, труд, технологии, предел и итог. Ремонт и снаряды оплачиваются отдельно. Добыча требует изученного barren.'],
  ['Колонизация и победа', 'Стартовый колонизатор уже есть; новые строятся в производстве. Сначала изучите наблюдаемый мир:10 кредитов/5 минералов, мгновенно. Нужен свой корабль или scanner без врагов. Toxic требует адаптацию за3000 науки; barren недоступен.\n\nЯвное основание расходует колонизатор, переносит1 млн из ближайшей своей колонии с ≥2 млн и стоит20/10. Захват сохраняет жителей и не требует колонизатора/адаптации. Победа — исходные habitable+toxic карты, не текущий unlock.'],
  ['Ход, бой и компьютер', 'Стратегический ход — окно действий стороны. Доход, содержание, FIFO, исследование и рост начисляются на её конец хода.\n\nБазовый рост2%, K10 млн; биология даёт2,4%, биосфера K12 млн без бесплатных жителей. Пять бонусов читают технологии начала хода: новое открытие действует со следующего своего конца хода. Открытия и активация показаны в научном журнале. При0/K/выше K роста нет.\n\nБой: такт0,05 с, максимум120 с. Replay не развивает колонии. После загрузки ход AI приостановлен; справка приостанавливает ожидающий AI.'],
  ['Карта галактики', 'Колесо над картой меняет масштаб относительно указателя. Кнопки +/− приближают к центру:100–1600%, шаг×1,25. «Вся карта» возвращает обзор.\n\nПеретаскивайте левой кнопкой или одним пальцем. Короткое нажатие выбирает мир; перенос не выбирает его. На desktop есть «Развернуть карту», на телефоне во вкладке «Мир» — «Карта галактики». Выбор в окне закрывает карту; ESC просто закрывает её. Pinch не поддерживается.\n\nСписок «Выбрать мир» сохранён. Навигация не выполняет ход и не записывается в save; новая партия и загрузка возвращают обзор.']
] as const;
