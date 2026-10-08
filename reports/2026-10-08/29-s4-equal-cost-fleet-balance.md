# 29 — Равностоимостные роли боевых флотов

- Дата: 2026-10-08
- Пункт плана: S4.10 — representative equal-cost fleet balance
- Статус: ограниченная acceptance matrix выполнена; универсальный баланс не заявляется

## Цель и границы

Проверить реальные preset fleets по production quotes в обеих валютах, зеркальным paired боям и общим seed. Искомый критерий — выявить, даёт ли линкор безусловное преимущество при близкой цене и существуют ли composition counters. Не подгонять вывод по одной стороне/seed, не менять цены или боевые формулы. Sweep ограничен штатными factory presets и четырьмя составами; это не exhaustive search всех пользовательских ShipDesign вариантов и не оценка победы произвольной кампании.

## Изменения и решения

Использованы quotes `getProductionQuote(createCombatDesign(...))`:

| Пресет | Кредиты | Минералы |
| --- | ---: | ---: |
| Fighter | 185 | 11 |
| Frigate | 432 | 29 |
| Cruiser | 750 | 64 |
| Dreadnought | 1288 | 128 |

По одной 100-seed paired series (200 mirrored battles) проверены три пары, цена которых различается менее чем на1% отдельно по credits и minerals. Score измеряет первый состав: победа1/ничья0.5/поражение0.

| Первый состав | Цена C/M | Второй состав | Цена C/M | Paired score и95% CI |
| --- | ---: | --- | ---: | ---: |
| 4 cruiser + 2 frigate | 3864/314 | 3 fighter + 3 frigate + 1 cruiser + 1 dreadnought | 3889/312 | 0.485 [0.393, 0.577] |
| 1 fighter + 1 frigate + 4 cruiser | 3617/296 | 4 fighter + 2 frigate + 1 cruiser + 1 dreadnought | 3642/294 | 0.355 [0.266, 0.445] |
| 3 cruiser + 3 frigate | 3546/279 | 3 fighter + 4 frigate + 1 dreadnought | 3571/277 | 0.635 [0.546, 0.724] |

Нет таймаутов, side-bias intervals включают0. Результаты показывают близкую пару, matchup с преимуществом капитального состава и эскортный counter в другой компоновке; корпус большего размера не побеждает безусловно. Это role-matchup evidence, не универсальная точка баланса.

Чтобы приблизить capital preset к этой матрице, accuracy штатных dreadnought beams изменена с0.85 на0.75, projectile — с0.8 на0.71. Accuracy не входит в `calculateComponent` price, поэтому production quotes остались прежними. Более сильное пробное снижение до0.70/0.65 переворачивало advantage: один non-capital состав выигрывал79%; такой вариант не принят. Exact прежние dreadnought blueprints с accuracy0.85/0.8 оставлены preset-exempt в campaign validation, чтобы сохранённые tree-v2 кампании продолжали валидироваться; произвольные варианты без exemption не попадают.

## Проверки

| Проверка | Результат |
| --- | --- |
| `tests/combatSeries.test.ts` | 6/6; три cost-checked compositions,100 общих seed, обе стороны, asserts CI/timeout, запрет global RNG |
| `tests/campaignResearch.test.ts` | 22/22; старый точный dreadnought snapshot сохраняет eligibility, произвольный custom design остаётся под tier policy |
| `tests/CombatShipFactory.test.ts` + series | 30/30 |
| Полный Vitest | 3218 тестов/51 файл прошли |
| Strict typecheck | Исходники и тесты прошли |
| Production build | Успешно,160 модулей; `main-5f3ef550.js` 1848.60 kB / gzip450.73 kB; предупреждение chunk >500 kB сохраняется |
| Browser | Не запускался: изменены данные preset и доменный баланс, UI не менялся |
| `git diff --check` | Выполнить после документации |

## Актуализация навыков

Обновлены `orion-project` и `orion-combat` с preset prices, tested matchup matrix, выбранной accuracy и ограничениями. `orion-ship-design` проверен: цены по-прежнему получаются из общей production quote, схема проектов не менялась.

## Оставшиеся вопросы и следующий шаг

Эта матрица не доказывает баланс всех affordable mixtures, всех player blueprints, других диапазонов бюджета или target priorities. Сохранённый AI score остаётся bounded heuristic, не win probability. Следующий незакрытый пункт после уже закрытых S4.11/S4.12 — fleet performance UI cadence/static graphic caching; по просьбе пользователя остановиться после S4.12 дальнейшие пункты не начинались.
