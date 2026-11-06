# 01 — Н15: инфраструктура и специализация колоний — реализация

- Дата: 2026-11-06.
- Задание: [n15-colony-infrastructure](../../plans/tasks-2026-10-09/n15-colony-infrastructure.md)
  с [контрактом исполнения](../../plans/tasks-2026-10-09/00-execution-contract.md) и
  [планом](plan-n15.md).
- Статус: **вертикаль реализована и принята браузерной приёмкой** — actual
  Chromium CSS1280×720 и CSS390×844, 28/28 проверок на каждом профиле.
  Н15 отмечен «Выполнено» в [журнале](../../plans/tasks-2026-10-09/task-status.md).

## Продуктовый контракт (утверждён планом при недоступном интерактивном ответе)

По прецеденту Н08 выбран предложенный базовый вариант; числа — начальный баланс,
не подтверждение оптимальности пользователем.

- Каталог (rules snapshot v12, `rules.buildings`): `science-lab` (unlock `applied`),
  `factory` (unlock `automation`), `cultural-center` (unlock `cultural-practices`).
  Каждое: цена 60/30, 80/40, 50/25 кр/мин; productionCost 800/1000/600;
  содержание 2/3/1 кр/ход; +2 очка за уровень; maxLevels 2; миры habitable+toxic.
  Поддержка жизни (capacity-add) в Н15 не входит — меняла бы демографию.
- Пределы: per-building maxLevels 2; суммарные установленные + строящиеся
  уровни колонии ≤ `colonyBuildingSlots` = 4. Stacking с Н09 — один проход
  эффектов над суммой «труд + здания»; предел честен в breakdown/AI.
- Специализация — результат выбора зданий и труда; отдельной команды профиля
  нет, поэтому проблема cooldown/free-maximum не возникает (заявленное решение).
- Момент действия: здание, завершённое в T, повышает выпуск со следующего
  собственного конца хода (rows T рассчитаны до применения завершения).
- Содержание: списывается после населения/флота, детерминированный порядок
  (каталог × колонии × уровни); неоплаченное здание неактивно на этот ход —
  без выпуска и без списания, без накопления долга; прогноз показывает
  `buildingPaidCredits`/`buildingShortfallCredits` и активность зданий.
- Демонтаж: один уровень мгновенно, refund floor(½ цены) — build 80 → снос 40,
  прибыльной петли нет. Отмена проекта — прежний пропорциональный refund.
- Захват: здания сохраняются за новой стороной; выпуск/содержание — со
  следующего её собственного конца хода. Несовместимая со средой (после
  терраформирования) модификация — временно неактивна; save не правится.
- Save/load: buildings и building-проекты автономны; валидатор принимает
  только реальный kind `building` с полями здания (не соседнего вида).

## Изменённые поверхности

| Поверхность | Изменение |
| --- | --- |
| [campaignRules](../../src/domain/campaignRules.ts) | версии 11→12; `buildingDefinitionSchema`; `rules.buildings` (max16, уникальные id/unlock); `colonyOutput.colonyBuildingSlots`; export `ruleIdentifierSchema` |
| [fixture rules-default](../../src/domain/fixtures/rules-default.json) | версии 12/12, treeId v11, treeVersion v11, buildings, slots 4 |
| [campaignResearch](../../src/domain/campaignResearch.ts) | tree v11 (`orion-technologies-v11`); эффект `building-unlock`; узлы applied/automation/cultural-practices; `describeResearchEffect` |
| [research-default.yaml](../../docs/research-default.yaml) | зеркалирует встроенное дерево v11 (тест сверки) |
| [campaignColonyEffects](../../src/domain/campaignColonyEffects.ts) | `calculateColonyValue(..., buildingOutput)` — вклад зданий до эффектов |
| [campaignOutput](../../src/domain/campaignOutput.ts) | `colonyBuildingLevelSchema`, `buildings` в state; kind `building` в проектах; детерминированная оплата содержания в forecast (treasury-aware); buildingOutput в rows/breakdown; завершение проекта → уровень; валидация каталога/пределов/pending; refund |
| [conquest](../../src/domain/conquest.ts) | команды `startBuilding`/`demolishBuilding`; `buildingAvailability` (unlock/среда/уровни/pending/слоты); superRefine: cross-check tree↔каталог, цена/лимиты проектов и уровней; view/endTurn передают каталог и казну до оплаты |
| [conquestAi](../../src/domain/conquestAi.ts) | ограниченный выбор зданий после флота и terraform по own-view (unlock, среда, слоты+pending, очередь<3, afford+резерв); порядок каталога/ID |
| [ConquestScene](../../src/scenes/ConquestScene.ts) | пункт «Здания колонии…» в Работы мира; диалог слотов/содержания/маржинального выпуска; постройка/демонтаж с подтверждениями |
| [ConquestSaveManager](../../src/utils/ConquestSaveManager.ts) | save17/rules14, сообщение загрузки |
| [conquestBaseline](../../src/diagnostics/conquestBaseline.ts) | versions baseline13/save17/rules14/tree11 |

Документы: [CAMPAIGN_OUTPUT](../../docs/CAMPAIGN_OUTPUT.md),
[CAMPAIGN_RULES](../../docs/CAMPAIGN_RULES.md),
[CAMPAIGN_RESEARCH](../../docs/CAMPAIGN_RESEARCH.md),
[CAMPAIGN_UI](../../docs/CAMPAIGN_UI.md),
[CONQUEST_BASELINE](../../docs/CONQUEST_BASELINE.md). Мирные кодеки 6/4, run7, match8 не тронуты.

## Контроль AI после Н15 (отчёт Д16, раздел «После Н15»)

- Полезность industry для новых heads: building-проект попадает в общий
  `colonyWorkQueue`; `forecast.production[].orderId` представляет building head,
  тот же признак у AI, forecast и диагностики согласован (регрессия
  «fills new industrial workers for a real paid building head»).
- Конкуренция проектов: здания конкурируют с ship/terraform/refit за одну
  очередь и одни очки; AI выбирает здания только при свободных слотах/очереди
  и учитывает альтернативу обороне (флот и terraform раньше зданий).
- Starvation бюджета 24: ограниченный выбор по own-view; неоплачиваемое
  содержание делает здание неактивным вместо накопления долга; новых
  бессрочных расходов AI нет.

## Дефекты, найденные и исправленные при приёмке

1. **Предсуществующий AI-дефект:** ship-enqueue считал очередь колонии только
   по `production.orders` без workProjects — с проектом в очереди AI получал
   QUEUE_FULL на исполнении и срывал AI-ход. Исправлен подсчёт (orders +
   workProjects) в плане.
2. **Новый дефект пределов:** лимит мест учитывал только установленные уровни;
   pending-проекты нескольких зданий могли дать 6 будущих уровней > 4 слотов
   → нарушение целостности после завершения. Учёт pending добавлен в
   `buildingAvailability`, `validateColonyOutputState` и AI-план; тест
   «keeps the bounded building choice inside the shared queue and slot caps».

## Перебазирование диагностик (без миграций)

Архивы Д13/Д14/Д15/Д16 (save16/rules13/tree10) нечитаемы актуальным форматом
17/14; по контракту миграций нет. Suites перебазированы на текущую схему:

- [conquestAiDevelopment](../../tests/conquestAiDevelopment.test.ts) — процедурные
  late-состояния + новые чекпоинты
  [40-41 before-199/200](n15-ai-development/replays/) (save17/14,
  текущая политика, 200 ходов); добавлены Н15-регрессии building head и слотов.
- [conquestAiMissions](../../tests/conquestAiMissions.test.ts) — 7 paid6
  чекпоинтов заменены свежими полными прогонами (completed ≤ 200, бои, accepted).
- [conquestAiRecon](../../tests/conquestAiRecon.test.ts) — 6 research-first
  чекпоинтов заменены двухфазными свежими прогонами (полный → T-1 → один
  AI-ход завершает партию); «counts a queued colonizer» допускает законный
  startBuilding вместо бездействующего endTurn.

## Фактические проверки

| Проверка | Результат |
| --- | --- |
| Полный тест-набор | **3989/3989, 80 файлов** прошли (было 3928/77) |
| `yarn typecheck` | 0 ошибок (3 tsconfig-проекта) |
| `yarn build` | production build прошёл |
| Точечные прогоны затронутых файлов | campaignOutput 17, campaignRules, campaignResearch, campaignColonyEffects, campaignTerraforming/Refit/Projects, conquest, galaxyCampaign, conquestAi×3, conquestAiDevelopment 8, conquestAiMissions 26, conquestAiRecon 17, campaignAiExecutor/Planner/Faults/Integration, conquestBaseline (по тестам), мирные save-кодеки — пройдены |
| Доменные регрессии зданий [campaignBuildings](../../tests/campaignBuildings.test.ts) — **10/10**, добавлены после аудита приёмки: unlock-гейтинг до/после, неизвестный id, несовместимая среда (командой и в forecast), ровно +1 уровень и предел каталога, предел слотов по установленным уровням, демонтаж ½ цены/пустая запись/reject, детерминированная неактивность при дефиците (порядок каталога, без содержания у неактивных, legacy-вызов без казны), момент начисления (T без бонуса → T+1 с уровнем), сохранение зданий при захвате + валидация, save round-trip |
| `git diff --check` | чисто |
| Браузерная приёмка (actual Chromium, puppeteer-core + системный chromium, статический dist) | **Desktop 1280×720: 28/28; Mobile 390×844: 28/28** — настоящий canvas, pointer-клики, 0 pageerrors, 0 console-ошибок приложения, ровно 1 canvas, слот сохранения записан/восстановлен |

Браузерный сценарий (каждый профиль, платный путь руками через настоящий UI):
новая локальная партия → назначение 4500/500 через настоящие ±-кнопки
(сходящийся цикл) → выбор applied в UI исследования → 4 пары ходов (свой endTurn
+ переключение стороны для соперника) → applied отмечен «Открыто» → Работы мира →
«Здания колонии…» → мест 0/4 → постройка Лаборатории с подтверждением →
списание 60/30 → проект #3 в общем FIFO (0/800, «1 своих ходов») → повторный
выбор rejected → завершение на своём endTurn → наука 500 → 502 (+2 маржинально),
мест 1/4, уровень 1/2 → сохранение (schemaVersion:17) → reload → load →
oracle 502 и 1/4 → демонтаж уровня с возвратом 30/15, мест 0/4, уровень 0/2 →
отмена постройки Фабрики без списания и без проекта → повторный вход в диалоги,
ESC. Ограничения сценария: AI-ходы в браузере не гонялись (ограниченный выбор
зданий покрыт регрессиями conquestAiDevelopment); дефицит содержания в браузере
не создавался (казна велика) — детерминированная неактивность покрыта доменными
тестами; favicon 404 отфильтрован как сетевой шум сервера. Инструмент приёмки
(puppeteer-core) временный, вне репозитория, не входит в зависимости проекта.

## Ограничения и следующий шаг

- Полные 58 baseline/quota/FPS, темп больших партий — не измерялись (как и до Н15).
- Каталог/цены — начальный баланс по предложенному варианту, не утверждён
  пользователем (прецедент Н08); поддержка жизни (capacity-add) вне Н15.
- 44 large timeout остаются отдельной диагностикой, не этапом Н15.
- Следующий допустимый этап — Н16 (дипломатия) по прежнему графу.
