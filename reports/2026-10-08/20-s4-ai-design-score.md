# 20 — Эвристика оценки проектов Conquest AI

- Дата: 2026-10-08
- Пункт плана: S4.10b
- Статус: выполнено как ограниченная AI-эвристика; равностоимостный баланс флотов остаётся открытым

## Цель и границы

Заменить `HP × nominal DPS / credits` на воспроизводимую оценку, которая учитывает конечный горизонт боя, боезапас, оружейный cooldown, обе валюты и defensive характеристики. Не менять боевые формулы, стратегические тарифы или обещать оптимальный AI для произвольного противника.

## Изменения и решения

- `calculateConquestDesignScore` оценивает ожидаемый урон по weapon accuracy за оставшееся окно до120с. Число shots учитывает fixed-step cooldown и ограничивается projectile ammo; движение до engagement приближено для gap600 по симметричной скорости и текущему range policy.
- Effective durability моделируется для равного постоянного потока beam/projectile. Учитываются evasion, типовые armor resistance и поглощение лучей щитом; регенерация щита не включена. Слишком большие/бесконечные значения ограничиваются численно.
- Стоимость нормирована на доступную долю текущих credits/minerals; прежний AI reserve5 credits остаётся вне production cost.
- Scoring применяется только при выборе между уже доступными, affordable и валидными кандидатами. Это прозрачная campaign heuristic; range/defense/ammo фактически остаются свойствами боевого resolver, а не выводом из одной метрики.
- Регрессии проверяют ammo cap, влияние scarcity каждой валюты, shields/armor, range movement policy и парное сравнение single-/twin-beam fighter на30 общих seed через настоящий `resolveConquestBattle`.
- Обновлены `docs/CAMPAIGN_CONQUEST.md`, план и навыки. Родительский equal-cost balance не закрыт.

## Проверки

| Проверка | Результат |
| --- | --- |
| `yarn test tests/conquestAi.test.ts --reporter=dot` | 7/7 |
| `yarn test --reporter=dot` | 3203/3203, 51 файл |
| `yarn typecheck` | Успешно, strict source и tests |
| `yarn build` | Успешно, 160 модулей; `main-51da76f7`, 1840.79 kB/gzip448.45 kB; chunk warning >500 kB сохраняется |
| Diagnostics / diff | Проверка изменённых source/docs/skills без ошибок; `git diff --check` чистый |

Браузерная проверка не проводилась: UI не менялся. Парная регрессия использует настоящую Conquest тактику, но покрывает только single-vs-twin beam fighter в одной 30-seed парной серии, не all-costs balance sweep.

## Актуализация навыков

Обновлены `orion-project`, `orion-combat` и `orion-ship-design`: scorer, его допущения/границы, тесты и актуальный full-check snapshot.

## Оставшиеся вопросы и следующий шаг

S4.10b закрывает только heuristics для выбора AI-проекта. Нужны equal-credit/equal-mineral fleet sweeps, разные роли корпусов, более широкий состав парных серий и оценка shield regeneration/target-dependent range. Не выдавать этот score за баланс или win probability. Продолжать следующие открытые S4 пункты, сохраняя родительский баланс unchecked.
