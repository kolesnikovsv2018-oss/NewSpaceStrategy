# 24 — Д14: фильтр разведки AI, границы вычислений и план снятия таймаутов

- Дата: 2026-10-25.
- Пункт плана: отдельная Д14 после [Д13](23-d13-timeout-analysis.md),
  по запросу «коммит/push → исправить разведку → план → проверить зависания».
- Статус: выполнено в этих границах. **Р1 устранил7 из14 таймаутов;
  оставшиеся7 не объявляются исправленными.** Р2/Р3 сохранены как план.

## Цель и границы

Сначала опубликована принятая база Д12/Д13:
`97bbd1997d6114421751f53aa732adcc202de10b`,
`main - d12 ai fuel fixes and d13 timeout diagnostics`.
Push в `origin/main` прошёл; непосредственно после него worktree был чистым,
ahead/behind0/0. Коммит содержит62 файла, включая доказательства Д13;
JSON/gzip проверены, очевидных секретов/случайных dist/log файлов не найдено.

Затем реализованы изменения Д14. Они **не входят** в этот уже отправленный
коммит и автоматически повторно не коммитились/не отправлялись.
Н15–Н20 не начинались. Игровые цены, урон, shields, HP/ammo/fuel,
научные формулы, горизонт200, бюджет24 и all-planets не менялись.
Не добавлялись скрытые сведения противника или бесплатные ресурсы.

Версии прежние: Conquest16/rules13, snapshot11/tree10, baseline12/map4,
ShipDesign5, campaign-v2/design-combat-v1. Yarn Classic/lockfile и стек
сохранены без новых зависимостей.

## Изменения и решения

### 1. Исправление фильтра разведки

[conquestAi.ts](../../src/domain/conquestAi.ts):

- Неизвестная цель исключается лишь по подтверждённому
  `environmentKnowledge[id] === 'barren'`.
  `knownSystems` без survey больше не считается отрицательным знанием.
- Вооружённый корабль может атаковать видимую чужую колонию, не изучив
  её среду. Это не разрешение основать нейтральный мир без survey.
- Общий predicate применяется к movement и readiness колонизатора;
  queued/incoming записи не создают повторных заказов.
- Д12 сохранён: реальный остаток топлива, дальность, достижимая своя
  заправка и отдельный quote возвращения из поля.

[17 регрессий](../../tests/conquestAiRecon.test.ts) проверяют обе стороны,
known-unsurveyed/visible-hostile/barren, одинаковую own-view при разном
скрытом owner, очередь, точную границу возврата, платный survey/основание,
терминальное основание без лишнего endTurn и шесть настоящих paid saves Д13.
Диагностические фикстуры с заданными исследованиями отдельно обозначены;
они не выдаются за новое оплаченное прохождение.

Реальные checkpoint60 research-first до исправления не завершали партию
одним нормальным AI-пакетом. Теперь этот же пакет без ручной подмены
команд даёт победу61/62, в Node и настоящем браузере, с полным
round-trip/input-immutability oracle.

### 2. Подтверждённые граничные риски и защиты

| Место | Риск | Исправление / доказательство |
| --- | --- | --- |
| [BattleScene.update](../../src/scenes/BattleScene.ts) |Огромный конечный delta создавал накопитель, у которого вычитание0,05 не меняет число. Если demo-бой не завершается, while не имеет собственного конечного предела. |Накопление≤120 sim seconds,≤2400 fixed steps/update; сверхлимитное время явно отбрасывается с console warning. Обычные1×/2×/4× прежние. Demo не получает автоматическую победу/новый игровой timeout. |
| [ConquestScene.update](../../src/scenes/ConquestScene.ts) |NaN/Infinity/отрицательная delta могла испортить replay clock; пустой исчезнувший массив frames приводил к обращению к отсутствующему кадру. |Invalid delta игнорируется, время≤последнего кадра, исчезнувшие frames безопасно снимают replay. Кампания/потери/turn не меняются. |
| [conquestTimeouts](../../src/cli/conquestTimeouts.ts) |После исправления AI партии завершаются раньше60; обязательный checkpoint60 ошибочно прекращал диагностику. Точка в самом конце давала бы пустой oracle. |Настоящий префикс `min(60, turnsExecuted - 1)` при необходимости; записывается фактический checkpointAt. До остановки есть непустой проверяемый суффикс. Слишком короткий случай явно отклоняется, не маскируется passed. |
| [runBaseline](../../src/diagnostics/conquestBaseline.ts) |Внешний while полагался на контракт успешного endTurn. Ошибочный success без продвижения ongoing-state мог сделать его бесконечным. |Защитный инвариант: turn+1 либо терминальная команда с нулевым продвижением. Иначе явное исключение до публикации trace. Подтверждено fault-only тестом; настоящий executor такого success в матрице не выдавал. |

Число120/2400 для защиты кадра взято из существующего бюджета симуляции.
Технически пропущенное сверхлимитное догоняющее время — намеренное изменение
только экстремального кадра, не новый численный баланс боя.
Увеличением fixed step проблему не обходили.

### 3. Аудит ограниченности реализованных расчётов

[AST-инвентарь](d14-ai-recon/loop-audit.json) охватывает97 файлов в src:
152 циклические конструкции —121 for-of,23 for и8 while. Это не
доказательство отсутствия вообще всех возможных ошибок/внешних callbacks.
Проверялись пределы и продвижение значимых циклов на валидных входах
нынешних schemas, а не произвольная подмена глобальных объектов.

| Область | Основание конечности / обработка границы |
| --- | --- |
| Стратегический AI |≤24 команд/пакет,≤47 боевых кандидатов+колонизатор, конечные own-view списки. Отказ атомарен; completed не добавляет лишний endTurn. |
| Baseline |≤200 окон,24 команд/окно; явный инвариант продвижения. Strategic timeout возвращается как результат измерения, не ошибка wall-clock. |
| Resolver / combat series |≤2400 fixed steps на бой, конечные seeds/составы. Обе стороны могут выжить — это корректный tactical timeout. |
| Scene catch-up / replay |Новые ограничения выше; обычная кадровая детерминированность и скорости проверены прежними реальными model-тестами. |
| Generator/checker |Фиксированная сетка33×33=1089 кандидатов,≤256 миров; нет бесконечного rejection sampler. Парные проверки расстояния конечны. |
| Research |≤64 nodes,≤64 проходов разрешения зависимостей; неразрешённый цикл отвергается. YAML≤256000 bytes, aliases запрещены. |
| Fleet/ships/production |Schemas ограничивают составы; Conquest100 ships/сторону,3 FIFO/колонию,100 производственных записей. Не принимаются Infinity/NaN/дробные counts. |
| Деньги/turn/save |Целые caps и явные отказы/rollback; current-only save≤5000000 bytes. Отсутствие места/некорректное состояние не выдаются за успешное сохранение. |
| UI text clipping |Убывает индекс/длина конечной строки, это не ожидание улучшения графического измерения без изменения входа. |
| AI scheduler |Один ticket, captured state/identity, consume перед запуском; callbacks после shutdown/замены инертны. Без бесконечного retry. |

Отдельно проверен необычный циклический
[reduceWorkforce](../../src/domain/campaignOutput.ts). При уменьшении
назначений сумма трёх округлённых долей оставляет не более2 единиц:
дополнение завершается максимум за6 обходов индекса, а не за величину
населения. Деление выполняется в BigInt; total=0 и population=0 имеют
ранний корректный результат. Добавлены500 комбинаций нулей/единиц/
границ1e9 и проверки invalid population, без изменения формулы.

**Важное различие:** вычислительный вызов может завершаться, а стратегическая
партия — не продвигаться к победе. Проверена принимаемая текущей схемой
искусственная позиция: у обеих сторон нет колоний/ресурсов/топлива.
Шесть вызовов endTurn завершаются, baseline возвращает timeout6;
all-planets остаётся ongoing. Это не достижимость такого состояния из
оплаченного старта и не повод тайно добавить ничью/поражение.
Продуктовое решение о таких загруженных состояниях вынесено в план,
связано с будущими условиями завершения.

## Новая18-матрица

Все inputs как в Д13: paid6, пары41/101,12345/67890,98765/43210,
три расписания, direct/mirror, maxTurns200.
[Сводка/fingerprint](d14-ai-recon/baseline/summary.json),
[сравнение](d14-ai-recon/comparison.json) и
[трассы/saves](d14-ai-recon/baseline/).

Рабочая база: опубликованный HEAD97bbd19 плюс изменения Д14.
Aggregate SHA-256 runtime-исходников/lockfile:
`23cc9665f1e785067f31ba8d5e16ff5aadc6486ae0aeb890d37317beb900b38c`.
Он совпадает с AST-аудитом и текущими файлами. Старые доказательства
Д13 не перезаписаны; незавершённый промежуточный прогон не использовался.

| ID / новая трасса | Д13 | Д14, завершённых окон | Late checkpoint |
| --- | --- | --- | --- |
| [6-41-current-ai-direct](d14-ai-recon/baseline/6-41-current-ai-direct.trace.json.gz) |timeout200 |timeout200 |60 |
| [6-41-current-ai-mirror](d14-ai-recon/baseline/6-41-current-ai-mirror.trace.json.gz) |timeout200 |timeout200 |60 |
| [6-41-research-first-direct](d14-ai-recon/baseline/6-41-research-first-direct.trace.json.gz) |timeout200 |completed54 |53 |
| [6-41-research-first-mirror](d14-ai-recon/baseline/6-41-research-first-mirror.trace.json.gz) |timeout200 |completed53 |52 |
| [6-41-production-first-direct](d14-ai-recon/baseline/6-41-production-first-direct.trace.json.gz) |completed65 |completed65 |60 |
| [6-41-production-first-mirror](d14-ai-recon/baseline/6-41-production-first-mirror.trace.json.gz) |timeout200 |completed80 |60 |
| [6-12345-current-ai-direct](d14-ai-recon/baseline/6-12345-current-ai-direct.trace.json.gz) |timeout200 |timeout200 |60 |
| [6-12345-current-ai-mirror](d14-ai-recon/baseline/6-12345-current-ai-mirror.trace.json.gz) |timeout200 |timeout200 |60 |
| [6-12345-research-first-direct](d14-ai-recon/baseline/6-12345-research-first-direct.trace.json.gz) |timeout200 |completed53 |52 |
| [6-12345-research-first-mirror](d14-ai-recon/baseline/6-12345-research-first-mirror.trace.json.gz) |timeout200 |completed52 |51 |
| [6-12345-production-first-direct](d14-ai-recon/baseline/6-12345-production-first-direct.trace.json.gz) |completed65 |completed65 |60 |
| [6-12345-production-first-mirror](d14-ai-recon/baseline/6-12345-production-first-mirror.trace.json.gz) |timeout200 |timeout200 |60 |
| [6-98765-current-ai-direct](d14-ai-recon/baseline/6-98765-current-ai-direct.trace.json.gz) |timeout200 |timeout200 |60 |
| [6-98765-current-ai-mirror](d14-ai-recon/baseline/6-98765-current-ai-mirror.trace.json.gz) |timeout200 |timeout200 |60 |
| [6-98765-research-first-direct](d14-ai-recon/baseline/6-98765-research-first-direct.trace.json.gz) |timeout200 |completed53 |52 |
| [6-98765-research-first-mirror](d14-ai-recon/baseline/6-98765-research-first-mirror.trace.json.gz) |timeout200 |completed52 |51 |
| [6-98765-production-first-direct](d14-ai-recon/baseline/6-98765-production-first-direct.trace.json.gz) |completed65 |completed65 |60 |
| [6-98765-production-first-mirror](d14-ai-recon/baseline/6-98765-production-first-mirror.trace.json.gz) |completed66 |completed66 |60 |

**Итог:11 completed/7 timeout вместо4/14.** Решены ровно7 прежних случаев,
четыре положительных контроля сохранены. Нет executor-error или
отвергнутых/откаченных пакетов. Repeat с начала/без trace и ранний checkpoint4
совпали; все18 поздних продолжений имеют непустой суффикс и совпавшие
commands/outcome/finalState/trace. В сумме2062 принятых пакета и2058
действительно завершённых окон: четыре терминальных пакета заканчиваются
победой без лишнего endTurn. Эти величины не подменяются друг другом.

Research-first завершился без боёв: незащищённые существующие колонии
занимаются реальным вооружённым присутствием по прежним правилам.
Resolver не отключался: production-first controls, boundary и остальные
ветви продолжают настоящие сражения.

### Почему оставшиеся7 — не прежний фильтр

У обеих сторон каждого остатка изучены6/6 миров, в анализе нет слепых
known-unsurveyed целей. У передовых кораблей бак9000 и ненулевой fuel.
После100 нет ни одного боя, но48/54/60 смен владельцев: флоты уходят
с захваченных миров и встреч не происходит.

Операционная проекция повторяется:

- current-ai/41 direct и mirror — период20;
- current-ai/12345 и production-first/mirror12345 —22;
- current-ai/98765 direct и mirror —24.

Сохраняются паритет, владельцы, порядок/ID/HP/ammo/fuel/transit/боевые
параметры кораблей, знания, research и очереди. Казны/население растут
и измеряются отдельно: это не byte-equal полный state и не утверждение
о бесконечности при любых будущих caps. Все семь ID и сопоставленные
фазы перечислены в [плане](../../plans/ai-timeout-remediation-2026-10-25.md).
Ближайшая Р2 должна менять выбор/удержание миссии, а не повторять Р1
или увеличивать урон/горизонт.

## Проверки

| Проверка | Результат |
| --- | --- |
| Целевой набор после replay-правки |98 тестов /4 файла, прошли |
| Полный `yarn test` |3886 тестов /74 файла, прошли |
| `yarn typecheck` |strict browser/CLI/tests, прошёл |
| `yarn build` |173 модуля, прошёл; прежний warning chunk>500kB |
|18 paid6 |repeat + early + late прошли,11/7, четыре контроля сохранены |
|4 boundary до8 |repeat/checkpoint прошли; supply даёт реальные8 tactical timeout без бесконечного расчёта |
|40/256 по16 окон |repeat/checkpoint прошли; это bounded opening, не полная приёмка больших партий |
|Формы/ошибки/численные caps |fault-success без turn отклоняется;500 workforce-комбинаций, no-income/zero-fuel, terminal colonize и прочие новые регрессии прошли |
|Настоящий браузер |catch-up, replay и6 paid checkpoint oracle прошли; подробности ниже |

Старый тест «равноудалённые цели» не задавал равенство расстояний:
fixture сделан действительно симметричным, добавлено явное сравнение
общего distance query; проверка разных целей по ship ID сохранена,
не ослаблена. Ошибки новых test doubles исправлены до финального прогона.

### Настоящий браузер, отдельно от mocks

[Данные проверки](d14-ai-recon/browser-smoke.json):

1. В настоящем Phaser BattleScene созданы два real unarmed DesignedShip
   и real BattleManager. При delta=Number.MAX_VALUE/скорости4× выполнено
   ровно120000ms симуляции, delta0 не догоняет вечный backlog,
   следующий обычный1000ms даёт124000ms. Оба корабля живы, бой не объявлен
   оконченным, HUD обновляется, оба накопителя конечны, один canvas.
   Получен ожидаемый warning об отсечённом догоняющем времени.
2. ConquestScene показывает121 кадр настоящего изолированного боя:
   invalid delta не меняет clock; обычный шаг даёт0,5с; huge delta
   ограничивается120с; исчезновение frames не вызывает исключение.
   Полный Conquest и localStorage не изменились.
3. Шесть strict paid saves Д13 выполнены текущим AI в браузере:
   completed61/62, полный save/restore result oracle совпал,
   вход не изменён. Это программная проверка checkpoint, не новый
   mouse paid E2E или UI save/reload/Resume.

Финальные проверки дали0 необработанных page errors. Первый проверочный
скрипт ошибочно перезапустил Phaser loop без callback: это ошибка harness,
не изменение приложения. Проверка повторена на свежей странице без
подмены lifecycle и прошла. Временные HTTP/SSR-процессы остановлены/
закрыты; пользовательские сохранения не переписывались.

**Не проводились:** full58-run, большие карты до200, holdout seed-матрица,
новый paid browser E2E, FPS, quota/physical touch, исчерпывающий анализ
произвольных сторонних callbacks/зависимостей/импортных правил.
Конечное число шагов не является гарантией одинакового wall-clock
времени на любых машинах или доказательством отсутствия всех багов.

## Актуализация навыков и следующий шаг

Обновлены [orion-project](../../.github/skills/orion-project/SKILL.md) и
[orion-combat](../../.github/skills/orion-combat/SKILL.md); ship-design проверен
без новых изменений: модель проектов, физика, цены/кодеки прежние.
Обновлены [AI](../../docs/CAMPAIGN_AI.md),
[время](../../docs/CAMPAIGN_TIME.md) и [baseline](../../docs/CONQUEST_BASELINE.md).
Maintenance → task-report выполнен явно; Д14 закрывается в журнале
по этим фактическим проверкам.

Сохранён отдельный [план устранения остатка](../../plans/ai-timeout-remediation-2026-10-25.md):
сначала ограниченные миссии/удержание, затем при необходимости согласованные
прибытия/цели и mission-ready замещение. Для удержания/новой памяти миссий
нужно принять поведение; экспериментальные периоды20/22/24 и ожидание4
не предлагаются как магические константы policy.
Критерий будущей работы —18/18 в исходной paid6 выборке≤200 без изменения
победы/чисел и с сохранением четырёх контролей. **Сейчас достигнуто11/18.**
