# 34 — Проверка component unlock до exemption

- Дата: 2026-10-08
- Пункт плана: R2 из [плана исправлений](./32-orion-review-fix-plan.md)
- Статус: выполнено

## Цель и границы

Не допускать корпус с закрытыми семействами модулей через preset exemption или grandfathered numeric policy; сохранять одинаковое правило в каталоге и доменной команде.

## Изменения и решения

- В [campaignResearch.ts](../../src/domain/campaignResearch.ts) доступность сначала проверяет hull и каждый установленный component kind, затем применяет preset/legacy exemption только к numeric caps.
- Единый предикат продолжает использоваться UI-каталогом и прямым `enqueueProduction`.
- Регрессии покрывают раздельные hull/component unlock, external tree v2, legacy tree v1 и civilian mining preset. Numeric grandfathering не отменяет требование открыть семейство.

## Проверки

| Проверка | Результат |
| --- | --- |
| Целевые Conquest-тесты | 5 файлов, 63 теста пройдены |
| Полный `yarn test` | 3232 теста/51 файл пройдены |
| `yarn typecheck` | Strict source и tests прошли |
| `yarn build` | 159 модулей; chunk warning >500 kB сохранён |

## Актуализация навыков

Порядок проверки зафиксирован в `orion-ship-design` и [контракте Conquest](../../docs/CAMPAIGN_CONQUEST.md).

## Оставшиеся вопросы и следующий шаг

Исправление не переоценивает и не переписывает уже сохранённые документы.
