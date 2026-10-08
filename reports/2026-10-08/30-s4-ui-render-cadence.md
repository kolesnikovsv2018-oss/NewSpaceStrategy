# 30 — Частота HUD и статический слой replay

- Дата: 2026-10-08
- Пункт плана: S4 — UI cadence/cache после профиля флотов
- Статус: выполнено в проверенном объёме; общий FPS и все устройства не сертифицированы

## Цель и границы

Использовать уже измеренные BattleScene/Conquest workloads, чтобы убрать ненужные UI text submissions и повторную отрисовку статической геометрии. Не добавлять pools, spatial index или Worker без подтверждённой нужды. Не менять тактические формулы, seed, fixed-step cadence и Conquest исходы.

## Изменения и решения

- BattleScene HUD опрашивается каждые100ms реального времени, независимо от simulation speed1×/2×/4×. `Text.setText` вызывается только если соответствующая строка действительно поменялась. Во время паузы render path сцены по-прежнему возвращается сразу.
- Conquest replay делит графику на static backdrop и dynamic ships/events. Backdrop заполняется один раз при открытии; per-frame update очищает только динамический слой.
- `ShipSprite.drawShip` уже создаёт корпус один раз при создании sprite. Engine glow, energy bar и selection state остаются динамическими; дополнительная кэш-сложность для них не добавлялась.
- Добавлены регрессии на HUD cadence/change gating и число fill/clear у двух replay layers.

## Проверки

| Проверка | Результат |
| --- | --- |
| `tests/visuals.test.ts` | 16/16: 10 Hz реального HUD cadence и отсутствие одинакового `setText` |
| `tests/conquestScene.test.ts` | 6/6: backdrop заполняется один раз, dynamic layer очищается на каждом кадре |
| Полный Vitest | 3220 тестов/51 файл прошли |
| Strict typecheck | Исходники и тесты прошли |
| Production build | Успешно,160 модулей; `main-b4f868fe.js` 1849.05 kB / gzip450.85 kB; прежнее предупреждение chunk >500 kB сохраняется |
| Browser diagnostic | 100 принудительных BattleScene steps: HUD вызвал setText8 раз для основного блока и2 для faction строк. Replay обновлён10 раз: static backdrop не перерисован, dynamic Graphics очищен10 раз; один canvas, тестовая сцена завершена в меню |
| Diff / diagnostics | `git diff --check` чист; diagnostics затронутых файлов без ошибок |

Browser page была скрыта, поэтому использовались ручные `game.step`, а не естественный RAF. Это проверка реального Phaser update/render path, но не общий FPS/performance benchmark и не mouse E2E. Замеры не служат основанием внедрять пул/индекс/Worker.

## Актуализация навыков

Обновлены `orion-project` и `orion-combat`: HUD cadence, static/dynamic replay graphics, test coverage, browser limits и последний полный verification snapshot. `orion-ship-design` не менялся, так как корабельные формулы/проектирование не затронуты.

## Оставшиеся вопросы и следующий шаг

Пункт profile/UI/cache закрыт в границах имеющихся workloads. Pooling, spatial index и Worker не добавлены из-за отсутствия измеренной необходимости; toolchain upgrade не выполнялся. Эти следующие пункты находятся после S4.12 и в рамках текущего запроса не начинались.
