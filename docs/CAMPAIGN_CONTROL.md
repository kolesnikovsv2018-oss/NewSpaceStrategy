# S3.30 — Контракт постоянной компьютерной стороны

- Дата решения: 2026-09-10.
- Статус на 2026-09-10: **S3.30 — историческое проектирование; S3.31 реализовал чистый API раздела3, S3.32 — кодек/миграцию, S3.33 — репозиторий раздела7**. Новый [CampaignRunSaveManager](../src/utils/CampaignRunSaveManager.ts) не импортирован игровым entry. Игра остаётся S3.29/ручной AI/save1/1. **Разделы4–6 (UI, scheduler, pending) и подключение run-слота всё ещё будущие**; автоматического red-хода нет. S3.33:123 новых теста =118 основных/5 integration; основной агент повторно подтвердил2572/41 файлов/282 сценовых, strict/build71 модуль, `main-9990d074`,1678.14 kB/gzip397.33 kB, прежний warning. Только временные порты, браузер/реальные localStorage/reload/quota/конкуренция не проверялись. Следующий S3.34 — полная ограниченная сценовая интеграция разделов4–6 и save2, без расширения policy/боя/победы. [Отчёт S3.33](../reports/2026-09-10/08-campaign-run-save-manager.md). Заголовки сохранены ради существующих якорей.
- Основание: [план](../reports/2026-09-07/plan.md), [ручной AI](CAMPAIGN_AI.md), [сохранение](CAMPAIGN_SAVE.md), [кампания](CAMPAIGN.md).

## 1. Ограниченный выбор

Первая постоянная конфигурация — **человек blue, компьютер red**. Альтернатива — прежняя локальная игра двух людей. Не добавлять AI-blue, AI-AI, смену сложности, автоплей обоих участников или новую игровую policy. На успешный человеческий endTurn приходится не более одного автоматического red-пакета, после него всегда управление blue.

Это постоянный источник решений для red, но не военный противник: policy по-прежнему только colonize/explore/endTurn. Нет AI-покупки, размещения, отправки/заправки флотов, захвата, исследований и победы. Уже оплаченные FIFO/маршруты продолжаются штатным endTurn. Ноль колоний не означает поражение; пустые возможности дают один endTurn, не вечный поиск цели.

Выбор режима новой партии служит согласием на последующие автоматические red-ходы после успешных blue-endTurn. Сам выбор/вход/reset не выполняет AI. Загрузка на red всегда требует отдельного явного продолжения. Включение AI посреди локальной партии вне первого выпуска; предусмотрен только выход из AI-режима в локальный для восстановления после отказа.

## 2. Факты, на которых основано решение

- [CampaignSession](../src/domain/campaignSession.ts) не хранит пользователя/controller. Нечётный turn означает blue, чётный red; смена наблюдения ничего не передаёт. Успешный endTurn уже меняет turn на1, отдельное ручное завершение red после AI было бы вторым ходом и не требуется.
- [MainScene](../src/scenes/MainScene.ts) сейчас исполняет синхронные ручные команды и отдельно атомарный executeAiTurn. PendingOperation/source/generation/disposed защищают подтверждения, но **в сцене ещё нет** ни авторизации постоянной стороны, ни отложенного AI-ticket. Чистая авторизация уже есть в run-API S3.31, сцена её пока не использует. Нельзя считать старый pending готовым планировщиком.
- [Executor](../src/domain/campaignAiExecutor.ts) уже проверяет исходный forecast и возможный поздний cap после колонизации; ошибки не требуют предварительного обхода planner сценой. Валидный terminal/cap-state можно сохранять/загружать: невозможный будущий endTurn не делает snapshot невалидным.
- [Кодек действующей сцены](../src/domain/campaignSave.ts) строгий: четыре поля конверта1/1. Даже необязательное новое поле control несовместимо с ним. S3.32 добавил отдельный [run-кодек](../src/domain/campaignRunSave.ts)2/1, не ослабляя legacy-reader и не переключая сцену. Нельзя оставить schemaVersion1 и надеяться, что старый reader проигнорирует поле.
- Planner получает только разрешённую own observation, никогда полный save/run/control/вражескую view. Управляющий слой доверенно владеет полной сессией, но не расширяет знания политики.

## 3. Будущий чистый слой управления

**Реализовано S3.31, 2026-09-10; исторический заголовок оставлен ради якоря.** Текущие экспорты [campaignControl](../src/domain/campaignControl.ts) и [campaignRun](../src/domain/campaignRun.ts):

| Тип | Форма/контракт |
| --- | --- |
| CampaignControl | Строгий union `{mode:'local'}` или `{mode:'human-vs-ai', aiPolicy:'expansion-v1'}` |
| CampaignRun | Строго `{session: CampaignSession, control: CampaignControl}`; новая внешняя единица состояния, не дополнительные поля CampaignSession |
| ControllerKind | Производный human/ai: local даёт human обеим сторонам; human-vs-ai даёт human blue, ai red. Не сохранять дублирующую карту назначений |
| campaignControlSchema / campaignRunSchema | Строгие runtime-схемы control и целого run с прежней полной campaignSessionSchema |
| runAiTurnRequestSchema / RunAiTurnRequest | Строго `{factionId, expectedTurn}`: явный factionIdSchema и целое1..MAX_TURN, без coerce/default/лишних ключей и зависимости от порядка command-union |
| RunErrorCode / RunFailure | AiTurnErrorCode плюс FACTION_CONTROLLED_BY_AI/AI_NOT_ASSIGNED; отказ ровно `{ok:false,code,message}` |
| CampaignRunResult | `{ok:true,run}` либо RunFailure; создание/takeover |
| RunCommandResult | `{ok:true,run,endTurnEconomy?}` либо RunFailure; прежняя квитанция только при её наличии |
| RunAiTurnResult | `{ok:true,run,summary}` либо RunFailure; detached прежняя AI-summary |
| RunResult | Union трёх результатов; отказ без run/частичного state/summary |

Без default/coerce для нового runtime-входа: bare CampaignSession не является CampaignRun, отсутствующий control/неверные mode/лишние поля отвергаются. Единственное добавление control к старым данным — явная миграция документированного save1/1 в разделе7.

Реализованы синхронные `createCampaignRun(unknown control)`, `executeRunCommand(unknown run, unknown command)`, `executeRunAiTurn(unknown run, unknown request)` и `convertRunToLocal(unknown run)`. Создание сначала проверяет явный control и лишь затем вызывает createCampaignSession; скрытого выбора режима нет. Создание и преобразование возвращают проверяемый result, не бросают штатную validation-ошибку. `getControllerKind(control, factionId)` — типизированный производный запрос для **уже проверенных** CampaignControl/CampaignFactionId, не отдельный unknown boundary. Входы не мутируются; результаты глубоко отделены, включая control/session/design/transit/membership и квитанцию/summary.

- executeRunCommand: полная run-схема → строгая прежняя command-схема → stale → active → контроллер human → прежний executeSessionCommand. Только потом действие/лимиты. В human-vs-ai любая валидная активная ручная red-команда получает FACTION_CONTROLLED_BY_AI. Local сохраняет прежние правила обеих сторон. Исключения полной схемы/refinement — INVALID_STATE, разбора command — INVALID_COMMAND; исключение исполнения или неверный итоговый run — INVALID_STATE, без подробностей. После успеха вновь проверяется весь run; blue-end не вызывает AI следом. Это гарантия wrapper, не ещё не подключённого UI.
- executeRunAiTurn: полная run-схема → strict runAiTurnRequestSchema{factionId,expectedTurn} → stale → active → разрешение → executeAiTurn. В local обе стороны доступны явному помощнику; в human-vs-ai только red, активный blue получает AI_NOT_ASSIGNED. Автоматическое/ручное разрешение запуска будет различать будущая сцена, не флаг caller. Сохраняется известный код отказа executor, не его произвольное сообщение/лишние поля; успех вновь проверяет весь run, сохраняет control и отделяет summary. Исключение разбора request — INVALID_COMMAND, исполнения/неверный итоговый run — AI_EXECUTION_FAILED. Установка controller не обходит session validation; нет retry/fallback/второго хода.
- convertRunToLocal проверяет весь run, сохраняет session по значениям и меняет только control на local, без команды/дохода/turn/fuel/новых ID. Повтор для local допустим и идемпотентен. Подтверждение takeover принадлежит сцене. Обратного преобразования в AI-режим API первого выпуска не предоставляет.
- Ошибки слоя: прежние SessionErrorCode/AiTurnErrorCode плюс FACTION_CONTROLLED_BY_AI и AI_NOT_ASSIGNED, фиксированные русские сообщения. Неверный runtime control — INVALID_STATE, malformed command/request — INVALID_COMMAND; неизвестная версия политики во внешнем save имеет отдельный код раздела7. Не печатать Zod paths/скрытые данные/сырые исключения.
- Чистый слой не импортирует Phaser/storage/каталог/часы/RNG и не планирует вызовы. Старые session/AI API остаются низкоуровневыми примитивами, а будущие игровые callbacks идут только через run-границу. Это не защита от владельца DevTools или от редактирования локального JSON.

## 4. Наблюдение, права и интерфейс

**Весь раздел — будущая интеграция сцены, не реализация S3.31.**

В local сохраняются переключение наблюдения и помощник S3.29. В human-vs-ai наблюдение **фиксировано blue**, кнопка смены стороны и ручной помощник скрыты/отключены. Состояние red не становится доступным ради сводки AI. Blue-панели производства/бюджета остаются собственными и только для чтения на red-ходе; ручные игровые controls недоступны до blue-хода.

Выбор «Новая партия» содержит два режима, начальный выбор local, confirm создаёт выбранный CampaignRun целиком; cancel оставляет старую партию. Обычный вход из меню создаёт local без IO, как сейчас. Сброс из AI-партии не сохраняет скрыто старое назначение: выбранный в новом подтверждении режим всегда виден.

После автоматического red-успеха UI blue показывает только нейтральное «Компьютер завершил ход. Ваш ход». Red AiTurnSummary допустимо вернуть доверенному caller для тестов, **но не передавать в blue-панель/лог/хранилище**: даже список разведок или сумма содержания — собственные данные red. Полная red-summary не сохраняется в сцене AI-режима. Blue-forecast вычисляется отдельно; старая blue-квитанция/ручная summary очищается, а не заменяется red-расходами.

При ошибке показать нейтральный безопасный статус AI без деталей целей/финансов. Разрешены явное повторное поручение, save/load/new/menu и «Перейти в локальный режим» с подтверждением. Takeover сохраняет turn и всю сессию, очищает callbacks/сводки/панели и выбирает текущую активную сторону для ручного восстановления; не завершает её ход сам. Игрок может законно потратить ресурс или вручную закончить ход без необязательной колонизации. Смена режима не является победой/поражением.

## 5. Одноразовый автомат сцены

Это **не реализованный код**, а обязательные состояния будущей интеграции:

| Состояние | Смысл и допустимые переходы |
| --- | --- |
| idle | Нет запланированного AI. Local или blue-turn; render/навигация не создают ticket |
| scheduled | Один ticket после успешного человеческого blue-endTurn либо подтверждённого Resume на red. Сразу виден статус ожидания; игровые команды заблокированы |
| running | Ticket снят до синхронного executeRunAiTurn; реентерабельный вызов запрещён. Нет отмены посреди ≤3 команд |
| paused | Red ожидает явного подтверждения Resume после load, пользовательской паузы или запроса операции. Нет ticket и фоновых попыток |
| failed | Пакет отклонён/неожиданно бросил. Red-state прежний; нет ticket/retry. Новый запуск только явным Resume-confirm |

Успешный executeRunCommand blue endTurn публикует свой state **до** scheduling. Его успех не откатывается из-за последующего отказа red. После render планируется одна отменяемая одноразовая задача на следующую обработку сцены, не рекурсивный вызов/while/update-поиск подходящего хода. Конкретный Phaser-механизм выбирается при реализации и проверяется с fake scheduler и настоящим браузером; задержка не игровое время и не вход политики. Не обещать минимальную паузу/FPS. Фоновая/остановленная сцена не исполняет ticket до восстановления допустимого lifecycle.

Ticket фиксирует уникальную identity, generation, исходную identity CampaignRun, ожидаемый turn и red. До запуска и после результата проверить ticket/generation/source/disposed, отсутствие pending и режим/active/red. Ticket **потребляется до вызова**; повтор callback не вызывает executor второй раз. Render может пересоздать панель, но не добавляет задачу и не подменяет captured request. Непредвиденная same-turn замена run делает ticket устаревшим; нельзя перепривязать его к новым данным. In-place mutation turn того же объекта отклоняется по expectedTurn.

На успехе один атомарный commit run, гарантированный turn+1 и переход в idle на blue; **новый ticket не создаётся**. Сцена проверяет финальную актуальность перед commit. На отказе весь red-пакет отброшен, failed; ни fallback endTurn, ни автоматическое пропускание colonize, ни новая цель, ни повторное планирование. Неожиданное исключение границы — общий AI_EXECUTION_FAILED без stack/log. Старый результат после load/reset/shutdown/takeover не принимается и не переводит новую партию в failed.

Только два события разрешают scheduling: **успешный blue-endTurn в AI-режиме** и **Resume-confirm на red**. Не render, не выбор системы/панели, не clock tick, не ошибка, не загрузка, не сохранение, не смена наблюдения, не вход или возвращение в меню. Никакого сохранённого «осталось исполнить» и поиска red-turn каждый кадр.

## 6. Пауза, pending и сохранность операций

**Весь раздел — будущая интеграция поверх чистого run-API; в S3.31 её нет.**

- Пока scheduled, кнопка Pause/ESC отменяет ticket и переводит red в paused. Это отдельная ветка до прежнего ESC-порядка панелей. На running синхронный пакет нельзя прервать; физический ввод обработается после завершения, частичный state никогда не показывается.
- Save/load/new/menu/takeover доступны в scheduled: **сначала** убрать задачу/invalidate generation и перейти paused, **затем** создать обычную pending-операцию с captured run. Пустой слот может сохранить сразу; это всё равно не возобновляет AI. Failure/cancel операции сохраняют прежний run и paused/failed, без скрытого reschedule.
- Пока обычный pending открыт, фон и повторные операции заблокированы прежним правилом. Resume имеет собственное inline подтверждение и не может сосуществовать с pending save/load. Отмена Resume не запускает ничего. Resume-confirm снимает pending, создаёт ровно один новый ticket; это явная новая попытка, не retry-loop.
- Навигация по blue-проекции не командует red и не повторяет scheduling. При scheduled разрешена только если не меняет run/pending; callback и источник остаются захваченными. При running запрещены все операции изменения/замены; guards проверяются также после результата для тестовой реентерабельности.
- Успешный load атомарно заменяет **run вместе с control**, очищает ticket/summary/panels/catalog/draft. В local выбирает активную сторону как S3.26. В human-vs-ai наблюдение blue: при red — paused, при blue — idle. Даже известный cap/terminal не исправляется и не выполняет AI при загрузке. Failed/cancel load не подменяет control текущей партии.
- Shutdown уничтожает задачу/ESC/панели и увеличивает generation; reset/load/takeover также инвалидируют. Новый entry не наследует controller из прежнего объекта сцены. Одна сцена — максимум одна задача, один campaign-panel и один ESC-handler. Reentry/new на том же turn не разрешает старый callback.

## 7. Новый save-контракт — только будущий формат2

**Чистый кодек и строгая миграция реализованы S3.32, репозиторий — S3.33; исторический заголовок сохранён ради якоря. Сцена/пауза/Resume остаются будущими.** Выбран **schemaVersion2/rulesVersion1**: структура документа меняется, механика/формулы нет. Run-репозиторий использует тот же `orion_campaign_v1` — стабильный ключ слота, не указатель поддерживаемой версии. Не создавать второй ключ, не читать/писать библиотеку. Старый клиент отказывает, а не теряет control при round-trip.

Новый конверт имеет ровно пять обязательных полей: format='orion-campaign', schemaVersion=2, rulesVersion=1, session по всей прежней campaignSessionSchema и control по строгой схеме раздела3. aiPolicy='expansion-v1' фиксирует текущую детерминированную policy для AI-режима; local не допускает aiPolicy или других лишних полей. Изменение будущих решений AI требует нового policy ID и явной поддержки/миграции, не молчаливой смены значения. Это не новая версия тарифов.

Не сохраняются idle/scheduled/running/paused/failed, ticket, generation, request, наблюдение, pending, summary, сообщения, timestamps, seed или курсор. Кодирование red до пакета допустимо, decode ничего не исполняет. **Будущая сцена** после загрузки red всегда ставит paused независимо от прежней причины ожидания; это не состояние/действие кодека. После AI-успеха сохраняется уже blue-state. Нет сохранений между командами пакета. Ошибка отдельной записи после принятого хода не откатывает игру; это проверено репозиторием S3.33, но ещё не сценой.

**Реализован отдельный API без переопределения старых caller:** [campaignRunSave](../src/domain/campaignRunSave.ts) экспортирует `CAMPAIGN_RUN_SAVE_SCHEMA_VERSION=2`, `CampaignRunSaveErrorCode` (прежний `CampaignSaveErrorCode` плюс `UNSUPPORTED_AI_POLICY`), `CampaignRunSaveFailure`, `EncodeCampaignRunSaveResult`, `DecodeCampaignRunSaveResult`. `encodeCampaignRunSave(unknown run)` → `{ok:true,json}`, `decodeCampaignRunSave(unknown json)` → `{ok:true,run}`; любой отказ ровно `{ok:false,code,message}`, без partial state/run/summary и сырых исключений. Encode проверяет целую `campaignRunSchema`, формирует пять полей, stringify и UTF-8 cap. Переиспользованы прежние format/schema1/rules1/byte-limit константы и legacy decode. Никаких IO/часов/AI/хранилища/UI/автопланирования; старые исходники/тесты не менялись.

**Точный приоритет нового reader:** тип/UTF-8 cap5_000_000 до parse → JSON → базовые strict-ключи/**own session** → schemaVersion → rulesVersion → наличие/форма control → policy → **целая campaignRunSchema**. Базовая форма требует format/конечные положительные целые версии/own session, допускает только дополнительный ключ control; не применяет текущую session/control-схему до версий. Неизвестные корневые поля/отсутствие session/неверные типы версий дают INVALID_SAVE; неизвестная положительная schema → UNSUPPORTED_SAVE_VERSION; поддержанная schema с rules≠1 → UNSUPPORTED_RULES_VERSION раньше control. Для1 control запрещён; **только после новых priority guards вызывается прежний decodeCampaignSave**, полностью проверяет1/1 и возвращает session, к которой добавляется local. Для2 control обязателен; неверная форма → INVALID_SAVE; структурно верный human-vs-ai с неизвестным ID → UNSUPPORTED_AI_POLICY до полной run-проверки; неверный целый run → INVALID_STATE. Policy ID ограничен1..64 ASCII букв/цифр/дефисов без trim/coerce; пустая/длинная/иная форма — INVALID_SAVE. Encode принимает только текущий строгий run, неверный вход/unknown policy/refinement/stringify — INVALID_STATE, oversized — SAVE_TOO_LARGE; caller не выбирает версии.

**Реализованный S3.33:** отдельный [CampaignRunSaveManager](../src/utils/CampaignRunSaveManager.ts), optional `providedStorage?: StoragePort` (type-only импорт), `STORAGE_KEY = CampaignSaveManager.STORAGE_KEY`. Constructor без IO/lazy global внутри try каждой операции, injected порт без global getter. Load один get/null SAVE_NOT_FOUND/read или getter exception STORAGE_READ_FAILED/иначе новый decode целого detached run. Save сначала новый encode **до getter**, потом один set, getter/write exception STORAGE_WRITE_FAILED, success ровно `{ok:true}` после возврата set; фиксированные сообщения без partial/raw exception. `LoadCampaignRunResult` объединяет decode-result/storage failure, `SaveCampaignRunResult` — success/codec/storage failure; storage-типы переиспользованы/реэкспортированы, codec-union сохраняет UNSUPPORTED_AI_POLICY. Старый менеджер неизменен. Без cache/reread/read-before-save/remove/rollback/fallback/автоupgrade, библиотечных операций/AI/UI/autoscheduling. После отдельного внедрения сцена использует только run-менеджер, не выбирает reader по содержимому; legacy state-only API остаётся1/1 и отвергает2 без потери control.

### Совместимость

| Вход | Новый run-reader | Старый state-only reader |
| --- | --- | --- |
| Строгий1/1, четыре поля | Полная прежняя валидация; добавить control={mode:'local'} в detached run, без IO/AI. Это единственная явная миграция | Прежний state |
| Строгий2/1 local | Проверенный local run | Отказ; конкретный старый код может быть INVALID_SAVE из-за лишнего control, не обещать UNSUPPORTED_SAVE_VERSION |
| Строгий2/1 human-vs-ai/expansion-v1 | Проверенный AI run без исполнения; будущая сцена отдельно поставит red на паузу | Отказ, без стирания назначения |
| 1/1 с control,2/1 без control, неизвестный mode/лишнее поле | INVALID_SAVE, без default/ремонта | Отказ |
| Поддержанная schema с неизвестными rules/AI policy | Соответствующий явный отказ до session, без выполнения иной версии | Отказ |
| Bare session/ShipDesign/library/ship без fuel/неполная сессия | Прежние строгие отказы, не миграция «всего старого» | Прежние отказы |

Decode/load старого1/1 не пишет upgraded-документ; только явный save нового run записывает2/1 **даже для local**. Подтверждение загрузки1/1 в local, занятого слота и capture целого run — будущая интеграция caller/сцены, не действие менеджера. Отказ записи сохраняет предыдущие bytes по контракту atomic set/throw порта; это не транзакция/rollback менеджера или гарантия конкуренции, два экземпляра работают last-successful-writer-wins. Кап/UTF-8/независимые design snapshots/ID/порядок/fuel/FIFO/cross-state сохраняются. **В S3.33 проверено:** строгий1/1 ровно5MB загружается в local, но явный save2 превышает cap из-за control и возвращает SAVE_TOO_LARGE до set, без потери старых bytes. Нет гарантии browser quota/вместимости любых400 snapshots.

## 8. Требуемая приёмка будущей реализации

Это исходная матрица **полной будущей интеграции controller**, не список полностью выполненных проверок. S3.31 закрыл чистый control/run (210 тестов, раздел10); S3.32 — кодек/миграцию (446 тестов, раздел11); S3.33 — run-репозиторий (123 теста, раздел12). Игра и282 сценовых остаются S3.29; общих тестов теперь2572/41 файл. Save/new manager/load целого run проверен во временных портах, но подключение слота к сцене, отложенная передача, paused/Resume и browser controller ещё нет.

| Область | Обязательная проверка |
| --- | --- |
| Чистый control/run | Строгие варианты/unknown input/лишние поля; обе стороны, приоритет ошибок, запрет всех ручных red-команд в AI-режиме/AI-blue; local helper прежний; deep frozen вход/independent result; takeover только control, без clock/IO |
| Успешная передача | New AI mode turn1: ручной blue end→2/blue110/55, один отложенный red explore nexus/end→3/red110/55; blue вручную без дохода explore/colonize eden, end→4/blue130/65; red colonize nexus/explore dust/end→5/red130/65. Ни второго end red, ни нового blue-AI. Не подставлять казны/turn/владение |
| Scheduler | Один ticket/один executor/≤3 session dispatch/один commit; render/несколько кадров/повтор callback не повторяют; blue failure не schedules; run identity/generation/request/режим/pending/disposed проверены до и после; реентерабельная замена не принимает результат |
| Пауза/операции | Pause/ESC/save/load/new/menu/takeover отменяют scheduled до IO/pending. Cancel/ошибка не возобновляют. Resume-confirm одноразов, cancel без вызова; pending-фон закрыт, shutdown/reentry/тот же turn не оживляют старый ticket |
| Отказ и пределы | Исходные TURN_LIMIT/gross cap, поздний cap обоих ресурсов после colonize, exception: failed без retry/partial summary. Blue end уже принят и не откатывается. MAX_TURN−1/terminal snapshots; no-colonies/no-frontier/fullcaps/IDlimits; deficit не замораживает FIFO/free/group arrivals и не заправляет |
| UI/приватность | AI mode всегда blue-view, красных кнопок/финансов/разведок/summary нет; red-error нейтральный. Локальный помощник/side switch прежние. Смена режима, save/load-confirm имеют captured run, отказ не меняет mode. Бюджет blue не выдаёт red receipt |
| Кодек/слот | Матрица раздела7/приоритеты/точно5MB и+1/Unicode/unknownpolicy/strict/deepcopies, getter/read/set/quota fault, отсутствие IO при encode-invalid. Load1 не пишет, явный save2; два менеджера/last writer; все прочие ключи сохранны |
| Оплаченные циклы | Preset/library, обе стороны оплачены настоящими командами в local, затем подготовленный диагностический AI-run для red либо новый легальный AI-цикл без red-покупки. Явно отделять такую смену config от доступного пользователю сценария. FIFO/ships/groups/transit/checkpoints, полный run после load+Resume равен непрерывному, библиотека после оплаты изменена/удалена только во временном порте |
| Браузер | Настоящие кнопки выбора/blue end/пауза/Resume/отказ; scheduled→save→реальный reload→load paused→Resume; snapshot/summary/turn/число вызовов, обе ветви режима/старый1/1, очистка panel/ticket/ESC/canvas. Fake scheduler, события Phaser и физический mouse/ESC документировать раздельно |

Детерминизм: одинаковые run/request и поддержанная policy дают одинаковый пакет, независимо от реальной задержки callback/часов/библиотеки. Scheduler влияет только на момент исполнения/его отмену, не на выбор или бюджет. Для сравнения loaded/uninterrupted после load нужен одинаковый явный Resume; само чтение не изменяет игровое будущее.

## 9. Разбиение и критерий завершения S3.30

**S3.31 выполнен:** только чистые CampaignControl/CampaignRun, helper и авторизованные run-команды/AI/takeover с регрессиями, без Phaser/scheduler/UI/IO/save. Прежние session/AI API и браузерное поведение сохранены; новые модули не подключены к игровому entry.

**S3.32 выполнен:** чистые `encodeCampaignRunSave`/`decodeCampaignRunSave` для2/1, явная миграция только строгого1/1→local,446 новых регрессий по разделу7; старые state-only API остаются1/1. Без репозитория/UI/scheduling/нового слота, новый API не подключён к entry.

**S3.33 выполнен:** `CampaignRunSaveManager` по разделу7,123 новых регрессии, включая новые экземпляры/read-write отказы/legacy-load без автоопераций/явный save2/оплаченные циклы. **Без UI/autoscheduling**, старые API/сцена/entry неизменны.

**Следующий S3.34 — реализация полной ограниченной сценовой интеграции, не часть текущего изменения документации.** Подключить CampaignRun, выбор local либо human-blue/AI-red, авторизацию всех ручных/AI callbacks, новый менеджер/save2 и одноразовый автомат разделов4–6: один ticket только после успешного blue-end или Resume-confirm, Pause/ESC, failed без retry, подтверждённый takeover и blue-приватность без red-summary. Сохранить pending/captured run/source/generation/disposed и lifecycle, отмену scheduled до IO/pending; load AI-red paused/blue idle без автохода. Старый строгий1/1 загружается только как local с подтверждением замены, без автоматической записи; последующий save2 в занятый слот требует подтверждения. Не читать AI-run как local и не записывать control, который сцена не исполняет.

Приёмка S3.34 обязательна по разделу8: fake scheduler для одноразовости/отмены/stale/same-turn/реентерабельности/отказов и cleanup; регрессии локального переключения и подтверждаемого helper обеих сторон; настоящий браузер выбора режима/blue-end/Pause/Resume/takeover и save→реальный reload→load paused→Resume, local/legacy1/1 и сохранность снимков. Отделять события Phaser от mouse/физического ESC, временный порт от реальной persistence. Без расширения expansion-v1, AI-производства/флотов, боя, победы или закрытия всего S3.

Исторический S3.30 закрыт наличием выбранного контракта режимов, прав, конечного scheduling, отказов/паузы/совместимости, матрицы и следующего чистого шага; **не наличием runtime на том этапе**. В S3.30 src/tests/зависимости не менялись, повторные1793 теста/typecheck/build подтверждали только S3.29. S3.31 добавил API ниже; браузерная приёмка controller всё ещё предстоит.

## 10. Фактические проверки S3.31

**Историческая проверка S3.31, 2026-09-10:2003 теста/36 файлов =1793 прежних+210 новых**,282 сценовых неизменны. [Control38](../tests/campaignControl.test.ts), [run143](../tests/campaignRun.test.ts), [fault29](../tests/campaignRunFaults.test.ts). Итог основного агента исправляет промежуточные209: добавлен тест эквивалентности request-context; хрупкое получение request через `options[2]` заменено явными factionIdSchema/целым1..MAX_TURN/strict. Полный test, strict typecheck и production build прошли:71 модуль, `main-9990d074`,1678.14 kB/gzip397.33 kB, прежний warning >500 kB. Браузер **не запускался**, это pure API, а не сценовая приёмка. Последний столбец фиксирует долг **на момент S3.31**; кодек отдельно принят S3.32 в разделе11, репозиторий — S3.33 в разделе12. Подключение слота/UI/scheduler остаётся будущим.

| Область | Фактически выполнено S3.31 | Что остаётся будущим |
| --- | --- | --- |
| Схемы/экспорты | Точные типы, unknown boundaries, строгие control/run/request, лишние/missing поля, без default/migration; создание отделённого run лишь после control-validation. Request-context совпадает с прежними bounds endTurn без зависимости от порядка union | Save-конверт2/1, версии/policy-ошибки и миграция1/1 в S3.32 |
| Авторизация | Все11 command kinds × blue/red × local/human-vs-ai; full run→command/request→stale→active→controller→прежние правила. Red manual/AI-blue отказы до dispatch; local helper для обеих активных сторон | Все callbacks сцены через run-API, отключение controls и фиксация blue-view |
| Полный state/изоляция | Повреждённые скрытые enemy fuel/flight/transit/FIFO/ownership/IDs/казны/exploration отклоняются до request/прав; takeover не ремонтирует. Frozen input, независимые вложенные run/receipt/summary и результаты зависимостей | Новый кодек должен проверять целый run, а не только own state/control |
| Передача/конечность | Реальный старт: ручной blue1 end→2/110/55 без AI; явный red2 explore/end→3/110/55; ручной blue3 explore/colonize/end→4/130/65; явный red4 colonize/explore/end→5/130/65. Один executor/planner/≤3 dispatch, никакого автоматического продолжения; local четыре AI-запроса и replay | Отложенный ticket, guards до/после commit, paused/Resume/failed состояния, отмена/lifecycle |
| Реальные пределы | Обе стороны × оба ресурса × с/без colonize × exact/+1 cap; late cap с FIFO/free/group transit откатывает пакет, не ранее принятый blue-end и не ранее потраченное fuel. MAX_TURN−1→terminal; нет колоний/frontier, полные200ships/200production/40groups и maxID | Scheduler/UI отображение отказов и загрузка terminal/cap run |
| Дефицит/восстановление | Реальные paid25/due100/short75 для обеих сторон; следующий forecast20/80 отдельно, FIFO и free/group arrivals продолжаются, fuel0 не пополняется. Takeover→ручной refuel15/6 либо end без необязательной colonize снимает соответствующий cap законно; takeover сам без команд/смены turn, не обходит terminal | Подтверждение takeover/очистка UI, red-error без утечек в blue-панель |
| Оплаченные preset/library | Реальные команды **local** обеих сторон: доход29/380/190 → по2 fighter185/11 → FIFO31 remaining3/4/3/4 → явный local AI до45/170/248 → ручные deploy/group/send → явные AI-end до47/188/258 каждой стороне,4ships fuel2, groups[2,1]/[4,3], snapshots неизменны | Run-codec/слот/load+Resume, не доказаны runtime parse |
| Runtime checkpoints | На31 и перед own end после отправок — campaignRunSchema.parse и сравнение с непрерывной веткой; red получает computer control **только диагностически после оплаченной local-подготовки/отправки**, не публичным local→AI API. Временная библиотека после оплаты реально изменена, затем удалена; дальнейшие команды/AI не читают/не пишут порт | JSON encode/decode, persistence, reload; имя тестовой переменной resumed не доказывает save/load |
| Чистота | Runtime-spies запрещают clock/RNG/storage/network/catalog/factory/scheduling. Статический обход emitted runtime-imports новых модулей достигает только domain и zod, не UI/save/Phaser/каталога; новые модули не подключены к игре | Сценовая интеграция и настоящий браузер отдельно; неизменный bundle не её доказательство |
| Fault-only | 29 отдельных проверок исключений nested refinement/creator/request/getter/final schema/planner/executor, недопустимого результата/неизвестного кода и мутации detached candidate; безопасные фиксированные сообщения без partial run/summary/log, одна попытка | Не заменяют настоящие схемы/правила, не проверяют будущий scheduler или IO репозитория |

S3.31 принят только в этих API-границах, [отчёт](../reports/2026-09-10/06-campaign-run-api.md). Ручной AI/save1/1 в игре, policy expansion-v1, механика/схемы CampaignSession/ShipDesign и зависимости прежние. На том этапе save2 ещё не существовал; кодек добавлен S3.32, репозиторий run — S3.33 ниже. UI постоянной стороны, scheduling, победа и весь S3 не считаются реализованными.

## 11. Фактические проверки S3.32

**446 новых =415 основных +26 fault-only +5 интеграционных**, всего2449/39 файлов/282 сценовых. [Основные тесты](../tests/campaignRunSave.test.ts), [fault-only](../tests/campaignRunSaveFaults.test.ts), [интеграции](../tests/campaignRunSaveIntegration.test.ts); [полная матрица кодека](CAMPAIGN_SAVE.md#15-фактические-проверки-s332). Один новый исходник/три новых теста, прежний код/тесты/зависимости неизменны. Основной агент повторно подтвердил полный test/strict/build:71 модуль, `main-9990d074`,1678.14 kB/gzip397.33 kB, прежний warning. Браузер не запускался — pure codec.

- Реальные encode/decode2/migrate1: точный конверт/экспорты/приоритеты, обязательные own session/control, unknown policy до session, cross-state/hidden-invalid/FIFO/fuel/groups/ID/flight/strict, bare run/session/view/library/design отвергаются. Legacy-reader/manager остаются1/1 и не теряют control на отказе2.
- UTF-8 exact5MB/+1 до parse, encode с настоящими валидными длинными дробными datetime;400 независимых snapshots/40groups вместе, exact/+1 лимиты, MAX_TURN/ID/cap/дефицит. Frozen/detached/сохранение порядка/дат и прежний trim; следующий реальный endTurn с actual receipt равен исходному, FIFO/free+group arrivals не останавливаются и fuel не пополняется. No IO/clock/AI/commands/store/scheduler; fault-only проверяет исключения отдельно, не подменяет реальные схемы.
- Четыре **preset/library × local/diagnostic-red-ai** цикла: реальные local-доход29/380/190→оплата по2 fighter185/11→FIFO31 remaining3/4/3/4→явный local AI до45/170/248→ручные deploy/group/send→AI-end47/188/258 каждой стороне,4ships fuel2,groups[2,1]/[4,3]. **Настоящие encode/decode на31/45/46**, полные run/control/результаты/summary/receipt равны непрерывной ветке после смены дат и изменения/удаления временной библиотеки. Red-control назначен диагностически только после оплаченной local-подготовки/отправки, не публичным local→AI API/политикой. Это не campaign-storage/reload, порт только библиотечный.
- Пятый сценарий — обычный новый AI-run: blue-end→red2 round-trip без автохода/red100/50; manual-red запрещён. Явный AI→3/red110/55, полный результат равен непрерывному; повторный round-trip сохраняет права/AI-blue отказ. Ни paused/Resume, ни отложенный ticket этими тестами не заявлены.

На этапе S3.32 принят только кодек/миграция; API не подключён к сцене S3.29/save1/1. Репозиторий принят отдельно в S3.33 ниже. Чистые JSON checkpoints не заменяют сценовую/storage/browser приёмку controller.

## 12. Фактические проверки S3.33

[118 основных тестов](../tests/CampaignRunSaveManager.test.ts) и [5 интеграций](../tests/CampaignRunSaveManagerIntegration.test.ts), всего2572/41 файл/282 сценовых; основной агент повторно подтвердил test/strict/build71 модуль, `main-9990d074`,1678.14 kB/gzip397.33 kB, прежний warning. [Полная матрица](CAMPAIGN_SAVE.md#16-фактические-проверки-s333), [отчёт](../reports/2026-09-10/08-campaign-run-save-manager.md). Менеджер не подключён к entry, существующий код/тесты/зависимости неизменны.

- Общий ключ/type-only port/noIO constructor/lazy getter, load один get/new decode, save encode до getter/один set; safe getter/method/quota/wrongport ошибки и все codec-коды. Strict1 load без записи/явный save2, exact5MB/+1/Unicode/upgrade-too-large без потери bytes, hidden cross-state/независимые snapshots/frozen/две instances/last writer/noIO.
- Четыре paid preset/library × local/diagnostic-red-ai: настоящие LOCAL-доход29→оплата/FIFO31→45→deploy/group/send→47/188/258 каждой стороне/fuel2. **Save → новый manager → load31/45/46**; полные run/control/результаты/summary/receipt равны непрерывному при разных датах и изменении/удалении временной библиотеки. Red-control назначен диагностически после оплаченной local-подготовки/отправки, не политикой/публичным local→AI.
- Пятый тест: обычный новый AI-run, red2 save/load без автохода→явный AI3, права сохранены. Quota-инъекция **после принятого AI** каждой стороны не откатывает принятый run и сохраняет прежние bytes/checkpoint без повторного исполнения.

Только временные порты с atomic set-or-throw контрактом; браузер/реальный localStorage/reload/quota/конкуренция не проверялись. UI/пауза/Resume/ticket/blue-приватность остаются S3.34, а не доказательством текущих repository-тестов. Победа и S3 открыты.
