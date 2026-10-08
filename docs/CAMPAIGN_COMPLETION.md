# S3.35 — Контракт завершения мирного сценария

- Дата решения: 2026-10-08.
- Статус на 2026-10-08: **S3.36–S3.39 реализованы: match API/кодек/репозиторий и сценовая интеграция**, приёмка в разделах9–12. MainScene владеет CampaignMatch, пишет save3/1, предлагает local/AI и sandbox/совместную разведку, показывает completed/readonly. Это не соревновательная победа или закрытие всего S3.
- Основание: [план](../reports/2026-09-07/plan.md), [управление](CAMPAIGN_CONTROL.md), [кампания](CAMPAIGN.md), [сохранения](CAMPAIGN_SAVE.md).

## 1. Проверенные ограничения

[executeCampaignCommand](../src/domain/campaign.ts) разрешает бесплатную разведку любого соседа уже разведанной системы. Корабль, колония в источнике и завершение хода не нужны. Человек может последовательно разведать все шесть систем в одном окне действий. [planAiTurn](../src/domain/campaignAiPlanner.ts) выбирает не более одной разведки по исходной проекции; произвольное число ручных команд и один AI-пакет не симметричны.

На карте четыре пригодные системы, из них две изначально заняты; захват отсутствует. При обычном расширении получаются две колонии каждой стороны. Нулевая казна не означает поражение: содержание не создаёт долга и не уничтожает корабли. Нет технологий, боевой кампании или AI-производства. MAX_TURN/RESOURCE_LIMIT — технические отказы, не ничья или проигрыш. Run-схема проверяет согласованность состояния, не полную историю достижимости.

## 2. Выбор сценария

| Вариант | Решение |
| --- | --- |
| Уничтожение/захват столицы | Отложить до боевой кампании: нет соответствующих команд |
| Большинство колоний | Не выбирать: всего две свободные колонии, нормальное расширение симметрично, захвата нет |
| Гонка ресурсов/кораблей | Не выбирать: AI не строит; числа дают искусственное преимущество накоплению и не проверенный баланс |
| Первый разведал всю карту | Не выбирать: человек может закончить в первом окне команд, AI ограничен одной разведкой за пакет |
| Очки через фиксированное число ходов | Отложить: пока нечем обосновать горизонт/веса/ничью; простой таймер не создаёт содержательной победы |
| Явное завершение совместной разведки | **Выбрать как дополнительный мирный сценарий без победителя**, не как соревновательную победу |

Два явных варианта новой партии, независимо от local/human-vs-ai:

- `sandbox`: свободная игра, никаких автоматических исходов. Начальный выбор; прежние партии сохраняют это поведение.
- `joint-survey-v1`: экспедиция завершена, когда **каждая из шести систем разведана обеими сторонами**. Публичный результат «Экспедиция завершена», без winner/loser/очков/ничьей. Это общая цель, а не победа человека над компьютером.

Сценарий не меняет стоимость, доступность разведки, очередь, содержание, топливо, управление и expansion-v1. Не вводить один explore за ход ради выравнивания сторон. Человек может подготовить свою половину сразу; AI проходит связную карту за пять успешных собственных пакетов, если нет отказа endTurn. В local обе стороны могут закончить ещё во втором окне действий. Это сознательно короткая экспедиция, а не приёмка полного производственного цикла. Для производства/групп остаётся sandbox.

Не переводить существующую партию из sandbox в экспедицию или обратно. Takeover меняет только контроллер, не цель. Новой партии требуется явное подтверждение выбранных сценария и режима.

## 3. Чистая граница и исход

Реализованный [match-слой](../src/domain/campaignMatch.ts) поверх [прежнего run API](../src/domain/campaignRun.ts):

```ts
type CampaignScenario = 'sandbox' | 'joint-survey-v1';
type CampaignMatch = { run: CampaignRun; scenario: CampaignScenario };
type CampaignOutcome =
  | { status: 'ongoing' }
  | { status: 'completed'; reason: 'joint-survey-complete' };
```

Все схемы strict. Внешние входы unknown, без coerce/default/автоматического добавления сценария. Match хранит единственный run; UI не хранит вторую сессию. Отдельная оболочка позволяет сохранить строгие существующие API/кодеки и их caller, не ослабляя CampaignRun или незаметно меняя старые save2.

Outcome **производный**, не сохраняется: sandbox всегда ongoing; экспедиция completed тогда и только тогда, когда все системы полной валидной session имеют blue и red в exploredBy. Нет даты, номера завершившего хода или победителя: их нельзя достоверно вывести из текущего snapshot. Не сохранять дублирующие phase/finished/ticket/progress/счётчики. Знание не убывает в текущих правилах; после completed команды запрещены, поэтому завершение устойчиво. Изменение этих правил потребует новой версии сценария.

Реализованные операции:

- `createCampaignMatch(unknown control, unknown scenario)` валидирует оба аргумента до создания run; возвращает detached match или безопасную ошибку.
- `executeMatchCommand(unknown match, unknown command)` и `executeMatchAiTurn(unknown match, unknown request)` валидируют всю оболочку/run, строгий payload, stale, active, права, затем outcome. При completed возвращают `CAMPAIGN_COMPLETED` до вызова session/executor; иных действий и частичного результата нет. Приоритет прав прежний: manual-red в AI-mode не получает обход авторизации из-за завершения.
- Для ongoing делегировать существующему run API один раз. Успех сохраняет scenario и отделяет весь match/receipt/summary. Повторно проверить итоговую match-схему; исключение или неверный результат даёт безопасный отказ без partial match.
- `getCampaignOutcome(unknown match)` проверяет всю match-схему, включая скрытые записи ships/fleets/production, возвращает `{ok:true,outcome}` либо ошибку. Не определять конец по неполной own view и не считать malformed состояние завершённым.
- `convertMatchToLocal(unknown match)` разрешён и после completed, делегирует takeover, сохраняет scenario/session и исход по значениям. Не возобновляет завершённую экспедицию. Обратной конверсии контроллера нет.

Старые run/session/AI API остаются низкоуровневыми примитивами без знаний о сценарии. MainScene использует только match-границу для игровых операций. Новый слой не импортирует Phaser/storage/каталог/часы/RNG и ничего не планирует. Ошибки: прежние RunErrorCode плюс CAMPAIGN_COMPLETED; неверный runtime scenario/match → INVALID_STATE. Экспорты подключены к сцене/entry в S3.39.

Успех create/takeover: `{ok:true,match,outcome}`; manual добавляет необязательную `endTurnEconomy`, AI обязательную `summary`. Query возвращает только `{ok:true,outcome}`. Отказ всегда `{ok:false,code,message}` без частичной session/match. Outcome отделён от match, не сериализуется вместе с ним. Run API остаётся доверенным внутренним примитивом с собственными guards и безопасными сообщениями; match переносит его отказы без дополнительных полей, повторно проверяет полный итоговый run и копирует receipt/summary. Исключение исполнения manual/create/takeover → INVALID_STATE, AI → AI_EXECUTION_FAILED; ошибки исходной схемы → INVALID_STATE, payload → INVALID_COMMAND.

## 4. Момент завершения и атомарность

Результат виден **на границе принятой операции**, не внутри неё:

1. Ручная последняя explore принимает изменённую session и сразу даёт completed; отдельный endTurn не требуется и далее запрещён. Доход/upkeep/FIFO/arrivals не выполняются тайно.
2. AI остаётся атомарным пакетом исходных colonize/explore/endTurn. Даже если его explore закрывает общую цель, пакет обязан закончить endTurn по прежним правилам. Только весь успешный результат становится completed; нет досрочного выхода, повторного endTurn или смены policy ID.
3. Если AI-end отклонён из-за исходного/позднего cap или MAX_TURN, последняя разведка внутри пакета также отброшена. Match ongoing, сцена failed без retry. Уже принятый предыдущий человеческий endTurn не откатывается.
4. Любая иная успешная операция возвращает исход, вычисляемый из её результата, но не вводит дополнительной команды/дохода. Завершённый вход никогда не проходит до executor.

Разное наличие endTurn у ручного действия и AI допустимо именно потому, что это не гонка и нет сравнительных очков/победителя. Не объявлять такое правило честной соревновательной механикой.

Остановка не дренирует очередь и не завершает рейсы. У завершённой экспедиции могут остаться оплаченные заказы/готовые проекты/корабли в пути и топливо0; сохраняются ровно их текущие снимки/порядок/ID/ресурсы. Нет возврата оплаты, автозаправки, создания кораблей или связи с библиотекой. MAX_TURN, отсутствие колоний/границы разведки, лимиты ID/ресурсов и дефицит сами по себе не меняют outcome. В ongoing при MAX_TURN допустимая ручная explore может закончить цель без endTurn; AI при том же ограничении завершить пакет не сможет. Takeover позволяет ручное восстановление, но не отменяет технические отказы.

## 5. Сцена и приватность

MainScene владеет одним match, а run/campaign/outcome — производные getter. Outcome вычисляется из валидного match, не из UI-флага. Terminal-result имеет приоритет над idle/scheduled/paused/failed: после принятого completed очищаются ticket/operation/summary/страницы, показывается «Экспедиция завершена» и запрещаются команды/AI/helper/Resume. Нового таймера слежения за исходом нет.

- До scheduling после blue-end и до/после исполнения ticket дополнительно проверять ongoing. Captured source теперь identity match, вместе с прежними generation/request/disposed/pending. После завершающего AI-пакета один commit и отсутствие следующего ticket.
- Load заменяет match целиком. Completed сразу открывает результат без исполнения; ongoing AI-red остаётся paused, AI-blue/local — прежнее поведение. Отмена/ошибка load сохраняют предыдущий match/outcome и не запускают AI.
- Завершённая партия доступна для сохранения, загрузки другой партии, нового старта, выхода, подтверждаемого takeover и просмотра своей карты/бюджета/производства/маршрутов. Навигация не изменяет session. Продолжения той же экспедиции «после конца» нет.
- Local сохраняет переключение наблюдения, AI-mode остаётся blue-only даже после конца. Панель получает свою SessionView, собственный progress (число известных систем из6) и минимальный публичный outcome. Не передавать enemy-progress, targets, finances, red-summary или полный match.
- Публичный факт совместного завершения неизбежно сообщает, что обе стороны знают всю карту; это единственное новое раскрытие. Оно не передаёт владение/финансы: текущая own проекция остаётся источником деталей. До конца чужой прогресс скрыт.
- New-dialog выбирает control и scenario отдельно, defaults local/sandbox; cancel сохраняет старые значения. Completed-result не должен перекрывать кнопки save/load/new/menu; не создавать второй ESC-handler или возобновлять игру закрытием результата. Pending-confirm имеет обычный приоритет ESC, затем навигация/меню.

## 6. Сохранение и совместимость

**Реализован отдельный [match-кодек](../src/domain/campaignMatchSave.ts)**, не изменение действующего run-reader. Конверт3/1 содержит ровно format/schemaVersion/rulesVersion/session/control/scenario. `encodeCampaignMatchSave(unknown)` принимает целый strict match, возвращает `{ok:true,json}`; outcome не записывается. `decodeCampaignMatchSave(unknown)` возвращает `{ok:true,match}` с `{run:{session,control},scenario}` после полной проверки. Ошибки `{ok:false,code,message}`: прежние CampaignRunSaveErrorCode плюс UNSUPPORTED_SCENARIO. CAMPAIGN_MATCH_SAVE_SCHEMA_VERSION=3 отдельно от legacy1/run2. Лимит5_000_000 UTF-8 bytes прежний, без IO. Отдельный [match-репозиторий](../src/utils/CampaignMatchSaveManager.ts) использует прежний ключ `orion_campaign_v1`, не второй слот.

Сохраняется rulesVersion1: формулы/команды базовой сессии и expansion-v1 неизменны; новые правила остановки однозначно заданы scenario ID `joint-survey-v1`, не молчаливым новым смыслом старого run. Новая интерпретация этой цели требует нового ID/поддержки кодека. SchemaVersion3 необходим из-за нового обязательного поля, не из-за смены тарифов.

| Вход | Реализованный match-reader | Действующие старые API |
| --- | --- | --- |
| Строгий1/1 | Прежний run-decoder полностью проверяет и даёт local; добавить только scenario=sandbox | Legacy и run-reader прежние |
| Строгий2/1 | Прежний run-decoder полностью проверяет control/session; добавить только scenario=sandbox | Run-reader прежний |
| Строгий3/1 sandbox | Полный match, ongoing независимо от знания карты | Старые readers отказывают, не отбрасывают scenario |
| Строгий3/1 joint-survey-v1 | Полный match; ongoing/completed вычисляется без команды/AI | Старые readers отказывают |
| Старый документ с дописанным scenario/outcome,3 без scenario, bare match/session | INVALID_SAVE, без ремонта/default | Прежние строгие отказы |
| Неизвестный корректный scenario ID | UNSUPPORTED_SCENARIO, без подстановки sandbox | Не поддерживается |

Приоритет reader: string/UTF-8 cap до parse → JSON/base strict keys и обязательное own session → schemaVersion → rulesVersion → разрешённые поля и обязательность для конкретной версии → control shape/policy → scenario shape/поддержка → вся session/match. Schema1 запрещает control/scenario; schema2 требует control и запрещает scenario; schema3 требует оба. Policy проверяется раньше scenario, как расширение прежнего guard-порядка. Scenario ID —1..64 ASCII букв/цифр/дефисов без trim/coerce: неверная форма INVALID_SAVE, неизвестный ID UNSUPPORTED_SCENARIO. Не копировать слабую проверку только own данных вместо полной run-схемы. Legacy1/2 делегируются прежнему run-decoder после guards; неизвестные версии не угадываются.

Чтение1/2 ничего не пишет и **никогда не завершает старую партию** задним числом: она становится sandbox, даже если обе стороны знают все системы. Явный save создаёт3/1; MainScene вызывает его после подтверждения занятого слота. Дополнительное поле может сделать ранее допустимый документ слишком большим; кодек возвращает SAVE_TOO_LARGE, репозиторий не обращается к storage/не обрезает/не теряет старые bytes. Encode/decode completed ничего не начисляют, не продвигают и не открывают повторное исполнение.

`CampaignMatchSaveManager` использует CampaignSaveManager.STORAGE_KEY, optional type-only StoragePort. Import/constructor без IO; default globalThis.localStorage разрешается на каждой операции внутри try, injected port не обращается к host. load делает один get: null→SAVE_NOT_FOUND, getter/read exception→STORAGE_READ_FAILED, иначе decode. save(unknown) полностью encode до любого storage-access, затем один set; `{ok:true}` только после возврата, getter/set exception→STORAGE_WRITE_FAILED. LoadCampaignMatchResult/SaveCampaignMatchResult объединяют codec/storage failures, включая UNSUPPORTED_SCENARIO; storage-типы переиспользованы/реэкспортированы. Сообщения фиксированные безопасные, без exception/partial match.

Нет кеша/reread/read-before-write/remove/clear/repair/fallback/rollback/автомиграции/AI. Атомарность set либо throw без изменения bytes требуется от порта, это не транзакция менеджера и не CAS: последний успешный writer побеждает. Подтверждение перезаписи обеспечивает MainScene. Старые менеджеры неизменны,3 отвергают; MainScene использует match-менеджер/write3.

## 7. Матрица приёмки

| Область | Матрица требований; фактическая приёмка отдельно в разделе9 |
| --- | --- |
| Вычисление | Sandbox всегда ongoing; survey требует обе стороны во всех6 системах,5/6 недостаточно; начальный run ongoing; нет winner/turn/time; invalid скрытая запись отклоняется до вычисления |
| Достижимый local | Без инъекции: blue все5 новых explore в первом окне→end1→red все5 explore; последняя ручная команда завершает на turn2 без дохода red; повторные command/helper запрещены |
| Достижимый AI | Blue все5 explore/end1→red одна разведка/end; повторять обычные blue-end и AI. Пятый red-пакет завершает на turn11; один пакет/один commit, без следующих действий |
| Авторизация | Local обе стороны/human-vs-ai, все command kinds, payload/stale/active/controller/completed порядок, frozen/deep copy/без частичного результата; malformed input не считается завершённым |
| Атомарность | Последняя AI-разведка + успешный end дают completed вместе; реальный late cap после colonize откатывает пакет; исходные cap/terminal без скрытого прогресса; ручная explore при technical terminal отдельно |
| Сохранённые данные | Оплаченные preset/library/FIFO/free+group transit и fuel0 сохраняются при остановке, без автоматической оплаты/refund/arrival; если подготовка завершённости диагностическая, явно отделить от достижимого цикла |
| Совместимость | Strict1/2→sandbox без IO/завершения;3 обе цели/режимы/исходы, error priority/unknown ID/extra/missing, exactly5MB/+1/UTF8, новый экземпляр repository, write failure не меняет исход/слот |
| Lifecycle | Completed blue не schedules; completed AI не возобновляется, устаревший ticket после load/new/takeover инертен; pending cancel/failed load не заменяют исход;1panel/1ESC/не более1ticket |
| Приватность/UI | Own progress только; completed публичен без red-summary/казны/целей, AIblue-only, local переключение, просмотр без команд, defaults/cancel/new и terminal controls |
| Браузер | Выбор обоих сценариев, достижимое завершение, save→настоящий reload→load completed без AI/дохода; old-slot sandbox; размеры/cleanup. Отдельно mouse, Phaser events, fake port и диагностические snapshots |

## 8. Ограниченные следующие этапы

1. **S3.36 выполнен: чистая модель CampaignMatch/сценарии/derived outcome и авторизованные wrapper с регрессиями.** Старые run/session/AI API, save2, сцена и зависимости неизменны. Достижимые local/AI-последовательности проверены реальными командами; новые типы не считать UI-функцией.
2. **S3.37 выполнен:** отдельный match-кодек3/1 и строгая миграция1/2→sandbox, без IO/UI.
3. **S3.38 выполнен:** match-репозиторий прежнего слота и ошибки/round-trip, без сценовой интеграции.
4. **S3.39 выполнен:** интеграция match/выбора цели/результата/readonly/scheduler/слота, регрессии и настоящий браузер; раздел12.

S3.35 завершён наличием этого проверяемого контракта, не работающего конца игры. Даже после S3.39 закончится лишь мирная экспедиция: исследование технологий, угроза, бой, баланс и соревновательная победа остаются открытыми частями S3.

## 9. Фактическая приёмка S3.36

2026-10-08: [campaignMatch.test.ts](../tests/campaignMatch.test.ts),182 новых регрессии; весь набор2814/42 файла, `yarn typecheck` и `yarn build` прошли.75 модулей, main-7dd0bab9/1691.37 kB/gzip400.34 kB, прежний chunk warning. Сцена/save2/зависимости не менялись, браузер и реальное хранилище не проверялись.

- Все11 видов ручных команд × обе стороны × оба режима × оба сценария, strict payload/stale/active/controller/completed, отсутствие dispatch после конца; sandbox делегирует прежнее поведение. AI-helper local обе стороны, AI-blue остаётся AI_NOT_ASSIGNED даже после конца.
- Strict scenario/match, создание с явными аргументами, отсутствие persisted outcome, каждая из12 недостающих отметок знания оставляет ongoing. Полная проверка скрытых ships/design/transit/fleets/FIFO/ID/казны; frozen input и detached run/receipt/summary/outcome. Fault-mocks отдельно проверяют getter/refinement/dependency exceptions и неверные итоговые run.
- Без подстановки игрового состояния: local blue5explore/end1/red5explore завершает на2 без red-дохода; human-blue/AI-red завершает на11 после5 полных пакетов. После конца команды запрещены, takeover только control и идемпотентен.
- Диагностический почти разведанный match: реальный поздний cap credits/minerals после colonize/explore откатывает весь AI-пакет, не предыдущий blue-end. MAX_TURN не завершает автоматически и не мешает последней ручной explore.100own ships/fuel0/FIFO/free+group routes проверены отдельно: manual не продвигает ничего, AI завершает обычный end с дефицитом25/100/75.
- Два настоящих оплаченных цикла preset/library: заработок29/380/190 → по2 fighter/FIFO31 → completed45 → deploy/group/send → ручная разведка до завершения46, red-группа остаётся в пути. Snapshot неизменен после изменения/удаления временной библиотеки. Отдельная ветка с диагностическим red-control после оплаты/отправки заканчивает AI47/188/258 каждой стороне/fuel2 и прибытием групп; не публичная local→AI конверсия/AI-покупки и не браузерная persistence-проверка.

Матрица codec закрыта S3.37 ниже, repository — S3.38 в разделе11, lifecycle/UI/browser — S3.39 в разделе12. Ограничения отдельных этапов ниже относятся к моменту их приёмки.

## 10. Фактическая приёмка S3.37

2026-10-08: [campaignMatchSave.test.ts](../tests/campaignMatchSave.test.ts),193 новых теста; всего3007/43 файла, `yarn typecheck`/`yarn build` прошли.75 модулей, main-7dd0bab9/1691.37 kB/gzip400.34 kB, прежний chunk warning. Старые run/session/AI/кодеки/менеджеры/сцены/зависимости не менялись. `yarn dev` запущен для проверки пользователем; агент браузер и реальное хранилище не проверял.

- Type/string/JSON/base strict/own fields/schema/rules/version-specific control+scenario/policy/scenario/full-state приоритеты. Unknown сценарий1..64 ASCII → UNSUPPORTED_SCENARIO, неверная форма/пробелы/Unicode/newline → INVALID_SAVE; encode malformed match → INVALID_STATE. Outcome/run/winner/summary/ticket в конверте запрещены.
- Strict1/2→sandbox сохраняет control2 либо добавляет local1 и не наследует настройки прошлого decode. Даже полностью разведанная старая партия остаётся ongoing. Явный encode3, старые readers/менеджер отвергают3; кодек сам не делает запись/команды. Оба сценария/режима/ongoing/completed, полные detached copies, авторизация после completed-load.
- Реальные5_000_000 UTF-8 bytes принимаются, +1/многобайтовое превышение отклоняются до JSON.parse. Для encode используется настоящая валидная длинная дробная дата, не mocked schema. Старый1/2 ровно5MB читается, но upgrade3 может превысить бюджет и отказать.400 snapshots/40groups/MAX_TURN/MAX IDs/caps/fuel0/порядок массивов и hidden cross-state ошибки проверены отдельно.
- 4 оплаченных preset/library×sandbox/survey ветки: реальные доход/покупка/FIFO31→45, checkpoints маршрутов45/46, полные результаты восстановленной и непрерывной веток равны после смены даты/изменения и удаления временной библиотеки. Manual завершение46 сохраняет red-transit; отдельная diagnostic red-control ветка после оплаты/отправки принимает последний AI-пакет47/188/258 каждому/fuel2 и roundtrip completed. Это не AI-production/публичная local→AI конверсия/браузерная persistence-проверка.
- Отдельные fault-mocks: вложенные session/production/flight refinements для encode/read3/migrate1/2, JSON/TextEncoder/getter/legacy dependency exceptions и malformed result, own undefined. Без IO/clock/RNG/catalog/scheduling/dispatch. Repository/слот/reload/quota/UI остаются вне приёмки кодека.

## 11. Фактическая приёмка S3.38

2026-10-08: [CampaignMatchSaveManager.test.ts](../tests/CampaignMatchSaveManager.test.ts),96 новых тестов; всего3103/44 файла, `yarn typecheck`/`yarn build` прошли.75 модулей, main-7dd0bab9/1691.37 kB/gzip400.34 kB, прежний chunk warning. Добавлены только отдельный менеджер и тестовый файл, старые исходники/кодеки/сцена/зависимости не менялись.

- Import/constructor без storage/clock/RNG/scheduling; injected port не обращается к host, default getter разрешается заново. Проверены порядок encode→getter→set-method→set и getter→get-method→get→decode, по одному вызову, без чтения перед save.
- Codec errors, включая UNSUPPORTED_SCENARIO, сохраняются. Null только SAVE_NOT_FOUND; неверные ответы порта не считаются отсутствием. Getter/method/accessor exceptions SecurityError/QuotaExceededError/Error/строка/null/undefined безопасны; read-only/write-only и malformed ports отдельно. Нет удаления/ремонта/перечитывания/отката или обращения к другим ключам.
- Оба сценария/режима/активные стороны/исходы сохраняются через новые экземпляры; snapshots и вход независимы, обычный AI-red2 load не запускает ход, только явный AI даёт3. Completed сохраняет приоритет прав/CAMPAIGN_COMPLETED без dispatch. Strict1/2 мигрирует в sandbox только в памяти, даже при полной разведке; явный save3 и отказы старых readers проверены.
- Full hidden invalid/fuel/FIFO/group route/design/counters не доходят до getter. Настоящий valid match ровно5MB сохраняется/читается; +1 encode без storage-access, +1 decode до parse. Строгие1/2 ровно5MB загружаются, upgrade3TooLarge не меняет bytes/прочие ключи.
- 4 оплаченных preset/library×scenario цикла: реальный доход29/380/190→по2 fighter/FIFO31→45→groups/routes45/46, save/new manager/load равен непрерывной ветке целиком. Дата и временная библиотека изменены/удалены, snapshots прежние; manual completed46 не продвигает red-transit/казну. Отдельный diagnostic red-control после оплаты/отправки→AI47/188/258 каждому/fuel2. Отказ записи после принятого AI не откатывает match/outcome и не заменяет старый checkpoint; повторный явный save успешен.

Приёмка проведена с реальными кодеком/правилами и контрактными Map-портами; отдельные fault-проверки используют подмены. Атомарность проверена только для такого порта, не для произвольного адаптера. Агент не проверял browser/реальный localStorage/reload/quota/concurrency/perf и не изменял пользовательское хранилище. UI остаётся S3.34/save2; следующий S3.39 — подключение к сцене и настоящий браузер, не военная победа/закрытие всего S3.

## 12. Фактическая приёмка S3.39

2026-10-08: MainScene/CampaignPanel используют match API и CampaignMatchSaveManager/save3.37 новых регрессий в [campaignScene.test.ts](../tests/campaignScene.test.ts),379 сценовых/3140 общих/44 файла; старые проверки адаптированы к sole match owner/внешней границе/save3. [campaignAiIntegration.test.ts](../tests/campaignAiIntegration.test.ts) проверяет MainScene→match→run→executor→planner. Старые API/менеджеры/правила/зависимости и четыре вложенные панели не изменены.

| Область | Результат |
| --- | --- |
| Выбор/исход | Четыре mode×scenario/default/cancel; local2 без red-income и AI11 после пяти пакетов/одной публикации каждого |
| Readonly/privacy | Обе цели/режима/паритета load/takeover, пять панелей для просмотра, команды/helper/Resume запрещены; own progress/минимальный outcome без чужих данных |
| Lifecycle/ошибки | Same-run/new-match guards до/после ticket/confirm; late cap обоих ресурсов, cancel/read/write/unknown-scenario сохраняют completed/слот |
| Оплаченные тесты | Четыре preset/library×manual/diagnostic-AI save/shutdown/reentry/load цикла равны непрерывным после смены даты/удаления библиотеки; completed46/red-transit либо AI47/188/258 каждому/fuel2; write failure сохраняет принятый match/старые bytes |
| Проверки | 3140/44 теста, strict source+tests, build77 модулей main-af6bd364/1698.24 kB/gzip401.62 kB; прежний warning >500 kB |

Настоящий browser: mouse local2/AI11; actual save3→реальный reload→новый local/sandbox1→явный load completed2 без AI/дохода,1canvas/1ESC. Diagnostic strict1/2/all-surveyed turn12→sandbox без записи; explicit save3, red paused→Resume13. Paid preset обычными scene-командами без подстановки state→completed46→actual save/reload/load равен полному oracle: blue188/258, red170/248,4ships fuel2, red-группа в пути; просмотр маршрута доступен, отправка запрещена. SessionStorage только oracle сравнения.

Скриншоты/геометрия desktop1280×720/mobile390×844 без overflow/пересечения новых элементов; mobile new/выбор/cancel сохраняет match, snapshotPixel подтверждает непустой canvas. Прежний мелкий Scale.FIT с полями на телефоне, не адаптивная раскладка. Reset local/sandbox1→menu:0match/0panel/0ticket/0ESC/1canvas; исходно пустые storage снова пусты после удаления только тестовых ключей, сервер оставлен пользователю.

Не проверены реальная quota, конкурентные вкладки, физический ESC, производительность и browser-цикл библиотеки. Fake Phaser/Map-порты не browser evidence; оплаченная browser-подготовка через scene API, не полный mouse E2E. [Подробный отчёт](../reports/2026-10-08/05-campaign-match-ui.md). Принята только мирная экспедиция, не весь S3/военная победа.
