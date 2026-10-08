# 27 — Seeded BattleScene и повтор боя

- Дата: 2026-10-08
- Пункт плана: S4.1–S4.3, интеграция BattleScene
- Статус: выполнено

## Цель и границы

Довести общий seeded/fixed-step путь до BattleScene, чтобы обычный бой и испытание проекта можно было повторить по видимому seed. Не менять составы/боевые формулы, Conquest resolver, paired/equal-cost analysis или стратегические правила.

## Изменения и решения

BattleScene принимает необязательный `seed` в launch data; без него генерируется один seed на запуск. Значение проверяется в диапазоне `1..0xffffffff`. Оба варианта боя — фиксированные флоты и trial design — получают независимый random stream на faction/index и стабильные ship IDs от seed. Это сохраняет детерминированный порядок разрешения равных целей.

Сцена накапливает render delta, но передаёт BattleManager только общий `COMBAT_SIMULATION_STEP` 0.05 с. При одинаковом seed и составе simulation steps не зависят от частоты RAF. Seed отображается во время боя и в результате; кнопка результата повторно запускает ту же сцену с тем же seed и trial project.

Seed относится к боевому состоянию. Звёздный фон и скорости частиц уничтожения остаются косметическими и используют Phaser RNG отдельно; они не участвуют в симуляции и могут выглядеть иначе при повторе.

## Проверки

| Проверка | Результат |
| --- | --- |
| `tests/visuals.test.ts` | 14/14; один seed, одинаковые полные результаты при render delta25 и50ms; `Math.random` запрещён во время боя |
| Combat/factory regression slice | 55/55 в `CombatShipFactory.test.ts`, `BattleManager.test.ts`, `visuals.test.ts` |
| Полный Vitest | 3216 тестов/51 файл прошли |
| Strict typecheck | Исходники и тесты прошли |
| Production build | Успешно,160 модулей; `main-614e6957.js` 1847.66 kB / gzip450.49 kB; сохранилось предупреждение chunk >500 kB |
| Phaser browser diagnostic | Explicit seed424242 виден в HUD/результате; бой завершился; программный Phaser `pointerdown` на «Повторить бой» перезапустил BattleScene с тем же seed и16 кораблями. Затем возвращено меню,1 canvas, campaign save slot не менялся |

Browser page была скрыта, поэтому синтетический mouse click не подтвердил действие. Проверен callback настоящего Phaser display object, это программная scene-проверка, не mouse E2E/физическое нажатие. Тестовые и сборочные команды запускались установленным Node напрямую, так как Yarn/Node shim в среде блокируется `snap-confine`.

## Актуализация навыков

Обновлены `orion-project` и `orion-combat`: входной seed BattleScene, fixed-step accumulator, repeat control, тесты и ограничения. `orion-ship-design` не менялся: модель проекта и верфь не затронуты.

## Оставшиеся вопросы и следующий шаг

Первый родитель S4.1–S4.3 закрыт. Equal-cost fleet analysis остаётся отдельной задачей баланса. Родитель S4.4–S4.9 пока открыт: у BattleScene ещё нет acceleration control; отчёт боя содержит агрегаты, но нет отдельной объяснимой тактической временной шкалы. Mouse E2E повторения не подтверждён.
