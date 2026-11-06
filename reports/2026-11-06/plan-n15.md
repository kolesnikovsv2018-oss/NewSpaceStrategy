# План реализации Н15 — инфраструктура и специализация колоний

Дата: 2026-11-06. Исполнитель: агент. Задание: [n15-colony-infrastructure.md](../../plans/tasks-2026-10-09/n15-colony-infrastructure.md).
Предпосылки приняты: Н09 (колониальные технологии), Н11 (общий FIFO/terraform). Опора: отчёт02 Д16, раздел «После Н15».

## Продуктовый контракт Н15 (утверждается этим планом)

**Каталог зданий** (малый, в rules snapshot; эффекты/цены принадлежат rules, колония хранит только уровни):

| id | Имя | Unlock-исследование | Цель | Вклад | Уровни | Миры | Цена (build) | Содержание |
|---|---|---|---|---|---|---|---|---|
| `science-lab` | Лаборатория | `applied` | science-output | +2 science pts/уровень | max 2 | habitable, toxic | 60 кр / 30 мин | 2 кр/ход |
| `factory` | Фабрика | `automation` | production-output | +2 production pts/уровень | max 2 | habitable, toxic | 80 кр / 40 мин | 3 кр/ход |
| `cultural-center` | Культурный центр | `cultural-practices` | culture-output | +2 culture pts/уровень | max 2 | habitable, toxic | 50 кр / 25 мин | 1 кр/ход |

Поддержка жизни (capacity-add) — **не входит** в Н15 (изменяла бы демографию/ёмкость, задача допускает «при необходимости»); остаётся будущим расширением каталога.

**Решения по пунктам задания:**
1. **Каталог**: `rules.buildings` — массив `buildingDefinitionSchema` (id, name, kind, unlockResearchId, cost, productionCost, upkeep, outputBase, maxLevels, worlds). Snapshot schemaVersion/rulesVersion 11 → 12, tree version 10 → 11, treeVersion `research-tree-v11`. Unlock — новый research effect `building-unlock` (по одному на здание, без дубликатов).
2. **Хранение**: `state.colonyOutput.buildings` — record systemId → массив `{buildingId, level}`. Derived output не персистится; effects/цены — только в rules.
3. **Пределы**: per-building `maxLevels` (2), общий cap на колонию `colonyBuildingSlots` (4 суммарных уровня). Stacking с Н09: вклад здания прибавляется к базе труда **до** одного прохода effects handler (без повторения); cap честен в breakdown/AI.
4. **Конкуренция**: проект здания — новый kind `building` в общем `colonyOutput.projects` (одна FIFO-очередь с кораблями/terraform/refit, `MAX_COLONY_QUEUE=3` сохранён). Очки не удваиваются: head получает ровно productionPoints, как сейчас.
5. **Специализация**: явных профилей нет — результат выбора зданий и труда (меньше переключений, нет cooldown/free-maximum проблемы). Это заявленное решение контракта.
6. **Момент начисления**: здание завершено в T → выпуск со следующего own endTurn (head, завершённый в T, уже имел forecast без этого здания). Содержание списывается в конце хода после населения/флота; **дефицит содержания** — детерминированное последствие: здания списываются в стабильном порядке каталога; неоплаченные здания становятся неактивными на следующий ход (нет выпуска и нет upkeep), прогноз показывает это.
7. **Демонтаж/захват/среда**: демонтаж refund = floor(½ цены) мгновенно, слот освобождается (без прибыльной петли: build 80 → demolish 40). Захват: здания сохраняются физически (не удаляются), не начисляют выпуск захватившему в ход захвата (уже рассчитанный T) — эффект со следующего own endTurn. Несовместимое со средой (после terraforming) здание: сохраняется, **временно неактивно** (нет выпуска, нет upkeep); прогноз и UI показывают «неактивно». Save не чинится молча — схемы сохраняют все уровни.
8. **UI/AI**: UI показывает места (уровни/слоты), содержание, marginal output; AI — законный выбор по own-view с учётом альтернативы обороне (в рамках bounded-бюджета ходов).
9. **Save/load**: buildings/projects автономны; валидаторы принимают только реальный kind `building` с его полями.
10. **Snapshot/runtime**: все расчёты на snapshot партии + runtime-среда Н10/Н11 (worldType через getColonyWorldType). Не требует Н14/Н16/Н18.

## Техническая последовательность

1. `campaignRules.ts`: `buildingDefinitionSchema`, `rules.buildings`, версии 11→12, fixture `rules-default.json`.
2. `campaignResearch.ts`: effect `building-unlock`, tree v11, новые узлы в `defaultTree`.
3. `campaignOutput.ts`: state schema (buildings), forecast (вклад зданий, upkeep, неактивность по дефициту), refund, валидация.
4. `conquest.ts`: команды `startBuilding`/`demolishBuilding`, захват (сохранение зданий), superRefine.
5. `conquestAi.ts`: ограниченный выбор строительства по own-view.
6. UI `ConquestScene.ts`: панель зданий (места/расходы/marginal), кнопки построить/демонтировать.
7. Тесты: `campaignBuildings.test.ts` (новый), обновления существующих fixtures/версий.
8. Приёмка: vitest, typecheck, build; браузерный сценарий — отдельным шагом (отметить, если не выполнен).

## Контроль AI после Н15 (из отчёта Д16, раздел «После Н15»)

- Полезность industry для новых heads (building head в forecast/diagnostic predicate).
- Конкуренция проектов: building vs ship/terraform/refit в одном FIFO.
- Отсутствие starvation бюджета 24: AI не держит бессрочные здания без выплаты содержания.

## Статус

Реализация начинается после записи этого плана. Полный статус — в `task-status.md` (Н15 → В процессе) и отчётах этой папки.
