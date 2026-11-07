# 04 — Н17.2 Платформа состояния участников (player-01..08, расписание ходов)

- Дата: 2026-11-07
- Пункт плана: Н17.2 ([этап Н17](../../plans/tasks-2026-10-09/n17-multiple-factions.md), [подэтап](../../plans/tasks-2026-10-09/n17/n17-02-participants-schedule.md), [матрица](2026-11-06/plan-n17.md))
- Статус: выполнено

## Цель и границы

Военная кампания переведена с enum blue/red на участников `player-01..player-08` с явным
расписанием ходов (turn/revision/round вместо parity) и bump save 18→19. Игровая граница
P=2 сохранена (расширение диапазона — Н17.6); мирная песочница не мигрирует; встречи 3+
сторон, per-pair дипломатия, последовательность AI, диагностическая матрица — вне этапа
(Н17.3–Н17.7).

## Изменения и решения

- **Расписание** — новый `src/domain/campaignSchedule.ts`: схема order 2..8 уникальных
  participant ID, activeIndex, turn 1..1e9, revision = turn−1 (решение пользователя: turn
  растёт на каждый выполненный ИЛИ пропущенный слот, revision — отдельный счётчик, в Н17.2
  всегда turn−1), round ≤ turn; `advanceSchedule` сжигает слот пропущенного участника, round
  инкрементируется после последней позиции круга.
- **Домен** — `campaign.ts` (participantIdSchema, палитра Н17.1, `getCampaignParticipants`,
  `conquestGalaxyStateSchema`, `createConquestState`), `campaignControl.ts` (conquestControlSchema:
  `local` | `{mode:'campaign', human, aiPolicy:'conquest-v1'}`), ships/fleets/production/output/projects
  — conquest-варианты по participant ID с глобальными лимитами ×MAX_PARTICIPANTS и per-participant
  лимитами в сессии; `campaignSession.ts` переписан (инвариант «расписание = участники карты»,
  участники из канонизированного снимка карты, advanceSchedule в командном цикле).
- **Conquest-слой** — `conquest.ts` (participants metadata, все record'ы по participantId с
  проверкой «ровно участники», `diplomacySideOf`, дипраунд по schedule.round, авторизация по
  control.human), `conquestBattle.ts` (P=2 бит-идентичность: стороны — отсортированные participant
  ID, внутренние тактические метки 'blue'/'red' и имена RNG-стримов сохранены позиционно —
  пересмотр стримов отложен в Н17.3), `conquestAi.ts`.
- **Save/сцена/CLI** — `ConquestSaveManager` 19/15 (прежние 18- — явный отказ), `ConquestScene`
  (узкая и широкая раскладки через participant IDs, выбор P заблокирован на 2), `CampaignProjectPanel`
  (владелец записей каталога), diagnostics/CLI.
- **Дипломатия Н16** остаётся blue/red до Н17.4 через позиционный адаптер (индекс 0 → blue);
  дипраунд — единая точка после endTurn последнего участника круга.
- **Исключённые стороны** (нет колоний и кораблей) пропускаются производно, без сохраняемого флага.

сторон, per-pair дипломатия, последовательность AI, диагностическая матрица — вне этапа
(Н17.3–Н17.7).
- **Фикстуры** — `scripts/generate-n17-fixtures.mjs` (по прецеденту upgrade-n15-fixtures.mjs):
  два paid-сценария schema 19 в `reports/2026-11-06/n17-2-state-platform/replays/` (40 миров,
  seed 41, before-199/before-200); путь зашит в `tests/conquestAiDevelopment.test.ts`.
- **Инфраструктура тестов** — `scripts/spawn-vitest.mjs` переоформлен как документированный
  инструмент фоновых батчей (child_process detached переживает выход шелла среды, голый setsid —
  нет); неработающий `scripts/run-tests.mjs` удалён; добавлен `scripts/e2e-driver.mjs` —
  zero-dependency CDP-оракул браузерной приёмки (chromium headless, эмуляция вьюпорта, клики по
  canvas с маппингом по осям через backing store — при узком вьюпорте Phaser меняет game size
  на размер окна, равномерный масштаб некорректен).
- **Baseline-диагностика**: `versions` в записи (baseline 13 / save 17 / rules 14 / tree 11) —
  замороженные метаданные зафиксированного входа, не переписываются по правилу диагностики
  (cutoff 200 не переписывается); актуальная версия сохранений 19 enforced ConquestSaveManager.

## Проверки

| Проверка | Результат |
| --- | --- |
| Вит-тесты, свежий прогон 77 файлов | 3957 тестов — все зелёные |
| Точечные свежие прогоны тяжёлых файлов | conquestAiMissions 17/26, conquestAiRecon 13/17 зелёные; по 9 и 4 тяжёлых матричных кейса (paid 6-world, до 60 с на кейс) — зелёные в батчах полного прогона задания |
| Финальный батч (conquestBaseline, conquestBaselineTrace, conquestSession, conquestAiDevelopment) | 4 passed (4), exit 0 — подтверждено done-маркером в начале сеанса |
| typecheck | main / cli / test конфиги — чисто |
| build | tsc + vite build — зелёные, 177 модулей; прежний warning о чанке >500 кБ сохраняется (известный, вне этапа) |
| Браузер, настоящий chromium (Chrome/156 headless) 1280×720 | Полный оракул e2e-driver: новая кампания P=2 (Локальная партия) → ход (turn 1→2) → save (schemaVersion 19, rulesVersion 15, schedule.turn 2, order/participants [player-01, player-02]) → reload → load (turn 2 восстановлен) → ход (turn 3) → save → выход в меню через confirm; savedOk/afterLoadOk = true |
| Браузер 390×844 | Тот же полный оракул на узкой раскладке: savedOk/afterLoadOk = true |
| Save/load oracle | Побайтовая идентичность round-trip в тестах; прежние версии 18- — явный отказ |
| Инварианты участников | Лишний/недостающий ключ участника в record отклоняется; «расписание = участники карты»; человек не командует AI-стороной; skip не ломает полный круг — кампания тестов campaignSchedule/conquestParticipants/conquestSession |

Ограничение проверки: полный `yarn test` одним процессом в текущей среде невозможен —
песочница убивает фоновые процессы (детач через setsid и detached-child погибают), а окно
команды ~30 с не вмещает тяжёлые матричные кейсы; использованы батчи переднего плана плюс
подтверждённый фоновый финальный батч. Полный цельный прогон — в Н17.6/Н17.8.

## Актуализация навыков

- `orion-task-report` — применён без изменения.
- Паттерн фоновых вит-батчей закреплён в комментарии `scripts/spawn-vitest.mjs`; паттерн
  браузерного оракула (CDP, эмуляция вьюпорта, per-axis маппинг кликов, confirm-потоки
  сохранения/загрузки/выхода) — в комментарии `scripts/e2e-driver.mjs`.

## Оставшиеся вопросы и следующий шаг

- Суммарный счётчик полного цельного прогона не зафиксирован из-за ограничения среды
  (см. выше); контроль — Н17.6/Н17.8.
- Внутренние тактические метки 'blue'/'red' и позиционные RNG-стримы — осознанный долг Н17.3.
- Браузерный чек покрывает меню → кампанию → ход → save/reload/load → выход; приёмка
  «Дипломатии» UI и полные сценарии Р1/Р2 — Н17.8.
- Следующий шаг: Н17.3 `conquest-encounters-v2` — pairwise-бои реальным BattleManager,
  RNG-стримы по stable IDs, обобщённые отчёты и захват.
