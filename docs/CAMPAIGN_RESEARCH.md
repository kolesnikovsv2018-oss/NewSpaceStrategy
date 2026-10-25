# Н08 — исследования за научные очки

Н08 заменяет временную кредитно-ходовую механику в единственном Conquest.
Мирная кампания и свободная верфь не меняются.
Исходные границы — [задание](../plans/tasks-2026-10-09/n08-research-points.md)
и [сверка готовности](../reports/2026-10-25/02-n08-readiness-and-follow-up.md).
При недоступном интерактивном ответе выбран предложенный базовый вариант;
числа ниже — начальный баланс, не подтверждение оптимальности пользователем.

## Дерево и эффекты

Текущее дерево Н14 — strict version10. strategic-drive и strategic-tank
стоят по3000 science после engineering и открывают fast/extended-tank.
Прежние engineering/ordnance/capital открывают выбор jump400/800/1500,
не обновляют уже построенные ships. Scanner использует отдельную
нынешнюю дальность стороны. Формулы/доплаты — [Н14](CAMPAIGN_TRAVEL.md).
Default YAML/JSON/source и snapshot используют один текущий формат.

Единственная актуальная схема дерева — version9, ID `orion-technologies-v9`.
Н12 добавил [миниатюризацию](CAMPAIGN_EQUIPMENT_REFIT.md):4000 науки после
engineering, typed equipment-variant-unlock compact. Numeric bands
сохраняются, preset exemption больше нет.
Н11 добавил [терраформирование](CAMPAIGN_TERRAFORMING.md):6000 науки после
biosphere/toxic-adaptation, typed unlock, без мгновенной смены среды.
Н13 добавил шесть [тактических направлений](CAMPAIGN_COMBAT_TECHNOLOGIES.md): tactical-propulsion3000/focused-beams4000 после engineering; rapid-projectiles4000 после ordnance; composite-armor3500/capacitor-shields4000/reinforced-hulls4000 после support. Typed tactical-variant-unlock/hull-variant-unlock открывают только новые snapshots, не лечат действующий флот.
Начально доступны fighter/corvette/colonizer и engine/beam.

| Узел | Предпосылки | Научная цена | Рабочий эффект |
| --- | --- | --- | --- |
| engineering | Нет | 2000 | Глобальные диапазоны оборудования tier2 |
| applied | Нет | 2000 | mining, repair, scanner, cargoExpansion |
| support | Нет | 3000 | frigate, shield, armor |
| ordnance | engineering, support | 6000 | destroyer, cruiser, projectile и tier3 |
| capital | ordnance | 12000 | battleship и tier4 |
| biology | Нет | 2000 | Рост +20% относительно базовой скорости |
| biosphere | biology | 4000 | Вместимость +2000, не выше абсолютного K типа |
| automation | engineering | 3000 | Промышленный выпуск +20% |
| scientific-method | applied | 3000 | Научный выпуск +20% |
| cultural-practices | Нет | 2000 | Культурный выпуск +20% |
| toxic-adaptation | Нет | 3000 | Основание на toxic после survey, без изменения типа/P/K |

Engineering/ordnance/capital также открывают стратегическую дальность400/800/1500;
начальная200. Н09 modifiers имеют явные selectors habitable/toxic.

Корневые ветви не исключают друг друга. Строгий узел содержит
id/name/prerequisites/researchCost/effects, без credits/turns.
От1 до64 узлов, цена — целое1..10⁹. DAG не имеет циклов/неизвестных ссылок,
ID уникальны, все текущие корпуса и семейства достижимы.
Повторение одной capability в альтернативных узлах разрешено;
дубликаты эффекта внутри узла и повтор начальной capability отвергаются.

Исполняются четыре строгих effect kind:

- `hull-unlock {hullId}`;
- `component-unlock {component}`;
- `variant-tier {tier:2..4}`.
- `colony-effect {effectId}` — ссылка на исполнимый modifier rules snapshot.

Н09 подключает пять [колониальных handlers](CAMPAIGN_COLONY_TECHNOLOGIES.md).
Это не активация библиотечных examples Н04: Conquest принимает только
связанные с узлами колониальные modifiers. `researchPolicy='research-points-v1'`
фиксирует прежний расход. Новая технология не меняет выпуск/рост текущего
own-end; все пять handlers читают completed из S0.
В корневом researchJournal сохраняется ход каждого открытия, own UI
показывает открытие и следующий собственный конец хода активации.
Новые среды, refit и боевые modifiers не вводились.

`component-bands-v1` сохраняет прежнюю арифметику: magnitude±10/20/30/40%,
ratio±0.05/0.10/0.15/0.20, ammo±10/20/30/40% с внешним округлением,
shield delay±0.5/1/1.5/2с. Tier — глобальный диапазон, не отдельный бонус
семейству и не изменение установленного оснащения.
Каждое поле следующих tier не сужается; это проверяется и в save, и в import.
Hull/family gates предшествуют numeric preset exemption.

## Состояние, выбор и пауза

Сторона хранит `research={completed,activeId,progress}`.
`progress` содержит единственную копию вложенных очков каждого
незавершённого выбранного ранее узла, включая нулевое значение.
ActiveId либо null, либо собственный ключ progress доступного узла.
У completed нет второй записи progress; сохранённый прогресс строго меньше
цены, а его prerequisites должны быть completed.

`research(technologyId)` бесплатно выбирает/переключает проект, не двигая
его и не расходуя резерв. Повтор того же выбора идемпотентен.
`pauseResearch` бесплатно сбрасывает только activeId и также идемпотентна.
A→B→A сохраняет вложения обоих узлов. Повтор completed или выбор узла без
prerequisites получает доменный отказ; права/stale/controller/completed
проверяются прежней общей границей.

Без колоний расход приостановлен, даже если резерв есть.
Колония с P=0 считается существующей, но не производит очков.
При нулевом выпуске доступный резерв расходуется; если его недостаточно
для завершения, дальнейший срок неизвестен. Потеря/возвращение колоний
не удаляет накопления. Захват не передаёт резерв или открытия противника.

## Один научный расчёт по исходному снимку

[calculateResearchTurn](../src/domain/campaignResearch.ts) используется
own forecast и настоящей командой конца хода.
Производится Q очков по исходным назначениям/rules, без работы новых жителей.
Для остатка цены активного узла:

1. Применить необходимую часть старого резерва R.
2. Применить необходимую часть Q.
3. Свободный остаток Q накопить в пределах cap10×исходное собственное P.
4. Сохранить старый остаток сверх уменьшившегося cap, не наращивая его
   новым выпуском без свободного места; остальной Q — overflow.

Промежуточная небезопасная сумма R+Q не создаётся.
Каждый вход резерва/выпуска/cap — неотрицательное safe integer.
Расход ограничен научной ценой; регрессионный BigInt oracle проверяет:

`reserveBefore + produced = spent + overflow + reserveAfter`.

За own-end завершается максимум один узел. Нет автоматического выбора,
каскада prerequisites или старого progress+1. Открытие разрешает новые
приказы в следующем доступном окне, но не переписывает paid designs/ships.
Научное начисление не зависит от enemy-end, боя, анимации, replay или load.
Поздний отказ mining/battle/final schema отменяет всю команду вместе с наукой.

Неперсистентная receipt хранит reserveBefore/produced/spent/overflow/
reserveAfter/cap, activeId, progressBefore/progressAfter/completedId и
accepted — ту часть нового выпуска, которая попала именно в резерв.
`colonyOutput.forecast.reserves.research.after` — окончательный остаток
после расхода, не промежуточный результат накопления.

Прогноз — typed idle/paused/unavailable либо progressing/completes с
remainingOwnTurns. Достаточного резерва хватает на ближайший own-end,
не на мгновенное завершение. При недостатке науки и нулевом выпуске
нет фиктивного срока; MAX_TURN/completed дают unavailable.

## UI, AI и импорт

Desktop показывает два узла на страницу, mobile — один; доступны эффекты,
prerequisites, цена/прогресс, расход/резерв/выпуск, срок/причина и пауза.
Смена проекта и научные назначения не меняют мирные панели.

AI направляет примерно20% P в науку до завершения дерева, сохраняя хотя бы
одного промышленного работника при ненулевом P. Остаток и прежний культурный
труд согласуются с доступным населением; при P=1 труд остаётся промышленным.
Доступный узел выбирается по конечной utility/оставшейся цене, ties по ASCII ID;
начатый проект не переключается бесконечно. Это ограниченная эвристика,
не гарантия оптимальной научной стратегии. Бюджеты≤48 designs/≤24 commands
и own-view без скрытых данных сохранены.

[YAML-пример](research-default.yaml), JSON и ResearchTreeSource принимают
только tree6, зарегистрированные colony-effect IDs и достижимые дальность/адаптацию. Лимит256000 UTF-8 bytes; aliases/custom tags/duplicate keys
отвергаются. Импорт выбирает дерево новой партии, не заменяет действующую.
Результат и ошибка только последнего запроса могут менять диалог.
Новый запрос/cancel/shutdown/reentry инвалидируют прежнее чтение;
старт во время текущего чтения явно просит дождаться его завершения.

## Форматы и проверки

Актуальны Conquest save12/rules9, rules snapshot7/rules7, tree6, baseline8.
Д08 добавил стартовый корпус colonizer и эффекты стратегической дальности:
engineering400/ordnance800/capital1500 при начальных200.
Все snapshots автономны. Старые военные форматы явно отвергаются без
миграции/fallback и без удаления прежнего слота.
Receipt/forecast/страницы не сериализуются; мирные readers не меняются.

Baseline отдельно хранит produced/spent/overflow/reserve/progress науки.
Checkpoint обычной партии берётся на четвёртом окне, чтобы короткие партии
проверяли продолжение частичного исследования, а не пропускали проверку.
Research-first намеренно ждёт всё дерево перед производством: его поражение
не равно ошибке executor или остановке научного начисления.

Регрессии: [ядро](../tests/campaignResearch.test.ts),
[интеграция](../tests/campaignResearchPoints.test.ts),
[выпуск](../tests/campaignOutput.test.ts),
[сцена/импорт](../tests/conquestScene.test.ts), остальные Conquest fixtures.
Фактическая приёмка и ограничения: [отчёт03](../reports/2026-10-25/03-n08-research-points.md).
