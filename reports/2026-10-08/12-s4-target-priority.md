# 12 — Стратегия приоритета целей

- Дата: 2026-10-08
- Пункт плана: S4.4, первый tactical substep
- Статус: выполнено в ограниченных границах

## Цель и границы

Добавить один воспроизводимый выбор цели в `BattleManager`, сохранив ближайшую цель для всех существующих конфигураций. Не менять движение, weapon range, damage resolution, BattleScene UI или Conquest rules.

## Изменения и решения

- `IBattleConfig.targetPriority` — необязательное поле: `nearest` либо `lowest-hull-ratio`.
- Отсутствующее поле/`nearest` делегирует старому `findNearestEnemy`.
- `lowest-hull-ratio` выбирает наименьшее `currentHull / maxHull`; ties идут по меньшей геометрической дистанции, затем по ID для стабильности.
- Текущая цель сохраняется до уничтожения: новый priority применяется при выборе/пере выборе, не пересчитывает target каждый update.
- BattleScene и Conquest не задают опцию, поэтому их поведение не поменялось.

## Проверки

| Проверка | Результат |
| --- | --- |
| `yarn test tests/BattleManager.test.ts` | 14/14 прошли; nearest default, lowest ratio и distance tie-break |
| Межмодульный срез | 89/89 в8 файлах: BattleManager, factory, DesignedShip, runtime contracts, combat series, conquest battle/domain/scene |
| `yarn test --reporter=dot` | 3193/3193,51 файл |
| `yarn typecheck` | Strict исходников и тестов прошёл |
| `yarn build` | Успешно,160 модулей; `main-1c41f865.js`,1837.67 kB/gzip447.20 kB; прежнее предупреждение chunk>500 kB |

Браузер не запускался: пользовательские сцены/UI не менялись. Сборка подтверждает текущие сборочные entry points; нет отдельного performance/balance теста.

## Актуализация навыков

Обновлены `orion-project` и `orion-combat`; план отмечает S4.4. `orion-ship-design` проверен: проект/фабричная схема корабля не менялась, поэтому не переписывался.

## Оставшиеся вопросы и следующий шаг

Приоритет hull ratio не учитывает щит/боезапас/DPS и пока не выбирается из интерфейса. Следующие отдельные tactical шаги: ценность угрозы или дистанция/дальность, затем построения/прикрытие/отступление. Полный tactical родитель остаётся незакрытым.
