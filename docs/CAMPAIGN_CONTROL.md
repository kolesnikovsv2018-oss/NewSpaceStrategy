# S3.30 — Контракт постоянной компьютерной стороны

- Дата решения: 2026-09-10.
- Статус на 2026-09-10: **S3.30 — историческое проектирование; S3.31 реализовал только чистый API раздела3**. Схемы/типы/control helper/run-обёртки доступны, но не импортированы игровым entry. В работающей игре остаётся ручной AI S3.29 и save1/1. **Разделы4–7 (UI, scheduler, pending-интеграция и save2) всё ещё будущие**; автоматического red-хода нет. Заголовки сохранены ради существующих якорей.
- Основание: [план](../reports/2026-09-07/plan.md), [ручной AI](CAMPAIGN_AI.md), [сохранение](CAMPAIGN_SAVE.md), [кампания](CAMPAIGN.md).

## 1. Ограниченный выбор

Первая постоянная конфигурация — **человек blue, компьютер red**. Альтернатива — прежняя локальная игра двух людей. Не добавлять AI-blue, AI-AI, смену сложности, автоплей обоих участников или новую игровую policy. На успешный человеческий endTurn приходится не более одного автоматического red-пакета, после него всегда управление blue.

Это постоянный источник решений для red, но не военный противник: policy по-прежнему только colonize/explore/endTurn. Нет AI-покупки, размещения, отправки/заправки флотов, захвата, исследований и победы. Уже оплаченные FIFO/маршруты продолжаются штатным endTurn. Ноль колоний не означает поражение; пустые возможности дают один endTurn, не вечный поиск цели.

Выбор режима новой партии служит согласием на последующие автоматические red-ходы после успешных blue-endTurn. Сам выбор/вход/reset не выполняет AI. Загрузка на red всегда требует отдельного явного продолжения. Включение AI посреди локальной партии вне первого выпуска; предусмотрен только выход из AI-режима в локальный для восстановления после отказа.

## 2. Факты, на которых основано решение

- [CampaignSession](../src/domain/campaignSession.ts) не хранит пользователя/controller. Нечётный turn означает blue, чётный red; смена наблюдения ничего не передаёт. Успешный endTurn уже меняет turn на1, отдельное ручное завершение red после AI было бы вторым ходом и не требуется.
- [MainScene](../src/scenes/MainScene.ts) сейчас исполняет синхронные ручные команды и отдельно атомарный executeAiTurn. PendingOperation/source/generation/disposed защищают подтверждения, но **в сцене ещё нет** ни авторизации постоянной стороны, ни отложенного AI-ticket. Чистая авторизация уже есть в run-API S3.31, сцена её пока не использует. Нельзя считать старый pending готовым планировщиком.
- [Executor](../src/domain/campaignAiExecutor.ts) уже проверяет исходный forecast и возможный поздний cap после колонизации; ошибки не требуют предварительного обхода planner сценой. Валидный terminal/cap-state можно сохранять/загружать: невозможный будущий endTurn не делает snapshot невалидным.
- [Текущий кодек](../src/domain/campaignSave.ts) строгий: четыре поля конверта1/1. Даже необязательное новое поле control несовместимо с ним. Нельзя оставить schemaVersion1 и надеяться, что старый reader проигнорирует поле.
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

Выбран **schemaVersion2/rulesVersion1**: структура документа меняется, механика/формулы нет. Слот остаётся `orion_campaign_v1` — это стабильный ключ слота, не указатель поддерживаемой версии. Не создавать второй ключ, не читать/писать библиотеку. Старый клиент обязан отказать, а не потерять control при round-trip.

Новый конверт имеет ровно пять обязательных полей: format='orion-campaign', schemaVersion=2, rulesVersion=1, session по всей прежней campaignSessionSchema и control по строгой схеме раздела3. aiPolicy='expansion-v1' фиксирует текущую детерминированную policy для AI-режима; local не допускает aiPolicy или других лишних полей. Изменение будущих решений AI требует нового policy ID и явной поддержки/миграции, не молчаливой смены значения. Это не новая версия тарифов.

Не сохранять idle/scheduled/running/paused/failed, ticket, generation, request, наблюдение, pending, summary, сообщения, timestamps, seed или курсор. Сохранение на red до пакета допустимо, после загрузки всегда paused независимо от прежней причины ожидания. Сохранение после успеха — уже blue-state. Нет сохранений между командами пакета. Ошибка записи после принятого хода не откатывает игру.

**Выбран API расширения без скрытого переопределения старых caller:** будущие encodeCampaignRunSave(unknown run)/decodeCampaignRunSave(unknown json) возвращают json/run; отдельный CampaignRunSaveManager использует тот же контракт StoragePort/ключ, методы save(run)/load() возвращают целый run. Не добавлять второй ключ или выбирать reader по содержимому слота в MainScene. После внедрения сцена использует только run-менеджер; прежний state-only кодек/менеджер остаётся явным legacy API для1/1 и не начинает принимать2 с отбрасыванием control. Существующие общие envelope/size/IO-механизмы следует переиспользовать без ослабления старой strict-схемы. API-only подготовка не переключает игровой UI на неподдержанный controller.

Внешний новый reader: тип/UTF-8 cap5_000_000 до parse → JSON → базовая строгая форма конверта → schemaVersion → rulesVersion → точная форма поддержанного конверта/control → вся session-схема. Базовая форма требует format/положительные целые версии/наличие session, допускает только дополнительный ключ control; не применяет текущую session/control-схему до проверки версий. Для1 control запрещён, для2 обязателен. Неизвестные корневые поля/отсутствие session/неверные типы версий дают INVALID_SAVE; неизвестная положительная schema → UNSUPPORTED_SAVE_VERSION; поддержанная schema с rules≠1 → UNSUPPORTED_RULES_VERSION. Неверный control → INVALID_SAVE; структурно верный human-vs-ai с неизвестной непустой policy ID → UNSUPPORTED_AI_POLICY; затем session error → INVALID_STATE. Unknown policy ID ограничить1..64 ASCII букв/цифр/дефисов без trim/coerce; пустая/длинная/иная форма — INVALID_SAVE. Encode принимает только текущий строгий run, ошибка входа INVALID_STATE; не экспортирует произвольную версию от caller.

### Совместимость

| Вход | Новый run-reader | Старый state-only reader |
| --- | --- | --- |
| Строгий1/1, четыре поля | Полная прежняя валидация; добавить control={mode:'local'} в detached run, без IO/AI. Это единственная явная миграция | Прежний state |
| Строгий2/1 local | Проверенный local run | Отказ; конкретный старый код может быть INVALID_SAVE из-за лишнего control, не обещать UNSUPPORTED_SAVE_VERSION |
| Строгий2/1 human-vs-ai/expansion-v1 | Проверенный AI run; сцена отдельно ставит red на паузу | Отказ, без стирания назначения |
| 1/1 с control,2/1 без control, неизвестный mode/лишнее поле | INVALID_SAVE, без default/ремонта | Отказ |
| Поддержанная schema с неизвестными rules/AI policy | Соответствующий явный отказ до session, без выполнения иной версии | Отказ |
| Bare session/ShipDesign/library/ship без fuel/неполная сессия | Прежние строгие отказы, не миграция «всего старого» | Прежние отказы |

Load старого1/1 не пишет upgraded-документ. Следующий явный save нового run пишет2/1 **даже для local**, только после существующего подтверждения занятого слота. Не обещать откат на старый клиент; отказ новой записи оставляет предыдущие bytes по контракту atomic set/throw. Capture save/load берёт целый run; невозможно загрузить session из одного чтения и control из второго. Кап/UTF-8/независимые design snapshots/ID/порядок/fuel/FIFO/cross-state/байтовые пределы сохраняются. Нет гарантии browser quota/вместимости всех400 snapshots.

## 8. Требуемая приёмка будущей реализации

Это исходная матрица **полной будущей интеграции controller**, не список полностью выполненных проверок. S3.31 закрыл только чистую часть: её фактические210 тестов и отличия от будущих UI/scheduler/save проверок перечислены в разделе10. Игра и282 сценовых теста остаются S3.29; общих тестов теперь2003/36 файлов. В частности, отложенная передача, paused/Resume, loaded run и browser controller ещё не проверены.

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

**Следующий только S3.32:** новые чистые `encodeCampaignRunSave`/`decodeCampaignRunSave` для schema2/rules1, явная миграция только строгого1/1→local и тесты policy/версий/приоритетов/UTF-8/целого run по разделу7. Старые state-only API остаются1/1. **Без репозитория, UI, scheduling и нового слота.** Позже отдельными задачами run-репозиторий, сцена/режимы/авторизация/scheduler/Resume/приватность и переход на новый менеджер, сквозная приёмка. До интеграции controller не разрешать сцене молча читать AI-run как local или записывать control, который она не исполняет.

Исторический S3.30 закрыт наличием выбранного контракта режимов, прав, конечного scheduling, отказов/паузы/совместимости, матрицы и следующего чистого шага; **не наличием runtime на том этапе**. В S3.30 src/tests/зависимости не менялись, повторные1793 теста/typecheck/build подтверждали только S3.29. S3.31 добавил API ниже; браузерная приёмка controller всё ещё предстоит.

## 10. Фактические проверки S3.31

**2026-09-10:2003 теста/36 файлов =1793 прежних+210 новых**,282 сценовых неизменны. [Control38](../tests/campaignControl.test.ts), [run143](../tests/campaignRun.test.ts), [fault29](../tests/campaignRunFaults.test.ts). Итог основного агента исправляет промежуточные209: добавлен тест эквивалентности request-context; хрупкое получение request через `options[2]` заменено явными factionIdSchema/целым1..MAX_TURN/strict. Полный test, strict typecheck и production build прошли:71 модуль, `main-9990d074`,1678.14 kB/gzip397.33 kB, прежний warning >500 kB. Браузер **не запускался**, это pure API, а не сценовая приёмка.

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

S3.31 принят только в этих API-границах. Ручной AI/save1/1 в игре, policy expansion-v1, механика/схемы CampaignSession/ShipDesign и зависимости прежние. UI постоянной стороны, save2, репозиторий run, scheduling, победа и весь S3 не считаются реализованными.
