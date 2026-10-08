# 14 — Строй line-abreast при подходе к цели

- Дата: 2026-10-08
- Пункт плана: S4.6
- Статус: выполнено как opt-in formation behavior

## Цель и границы

Добавить первый тактический строй из S4, уменьшающий схождение кораблей в одну линию движения. Старые вызовы `BattleManager` должны сохранить прежнее поведение; UI, физические столкновения, перестроение после потерь и бонусы прикрытия не входят.

## Изменения и решения

- `IBattleConfig.formation` опционально принимает `line-abreast`; без поля formation выключен.
- `BattleManager` назначает стабильный lateral slot по исходному индексу корабля в `faction.ships`, центрирует строй и использует spacing60.
- Боковой вектор строится перпендикулярно направлению на target; нулевые компоненты нормализуются в `0`, чтобы не протекал signed `-0` в наблюдаемый вызов.
- `ICombatant.moveToTarget` получил необязательный approach offset. Без formation manager вызывает прежнюю форму `moveToTarget(target)`; с formation передаёт offset только на этапе движения к цели.
- Смешанная дальность S4.5 остаётся согласованной: optional optimalRange передаётся вместе с formation offset; legacy/однотипные конструкции сохраняют прежний default.

## Проверки

| Проверка | Результат |
| --- | --- |
| `yarn test tests/BattleManager.test.ts` | 15/15 прошли, включая симметрию offsets и прежнюю инициативу |
| Межмодульный срез | 156/156 в9 файлах: BattleManager, обе модели, runtime interfaces, series, conquest domain/battle/scene |
| `yarn test --reporter=dot` | 3196/3196,51 файл |
| `yarn typecheck` | Strict исходников и тестов прошёл |
| `yarn build` | Успешно,160 модулей; `main-d5a42d41.js`,1838.58 kB/gzip447.53 kB; прежнее предупреждение chunk>500 kB |
| IDE diagnostics / `git diff --check` | Ошибок и whitespace проблем не найдено |

Браузер не запускался: BattleScene/UI не менялись.

## Актуализация навыков

Обновлены `orion-project` и `orion-combat`. `orion-ship-design` прочитан и не менялся: ShipDesign, состав, стоимость и design schema не изменялись.

## Оставшиеся вопросы и следующий шаг

Это только opt-in lateral approach. Нет сохранения формации после гибели участников, collision avoidance, cover bonuses, UI настройки или смены строя; существующие BattleScene/Conquest configurations не включают formation. Следом возможен прикрывающий строй/отступление либо перестроение после потерь; выбирать и оценивать их отдельно. Родительский тактический пункт S4 остаётся открытым.
