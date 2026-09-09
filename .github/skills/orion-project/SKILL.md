---
name: orion-project
description: 'Контекст Orion, стек, карта кода и план развития. Использовать перед улучшением, рефакторингом, исправлением или тестированием игры, чтобы начать с проверенных фактов без повторного общего аудита.'
---

# Orion: быстрый вход в проект

## Назначение

Браузерный прототип 2D-стратегии в духе Master of Orion. Цикл проекта корабля выполнен в S2. S3.1–S3.4 дают модель/карту галактики и пошаговую экономику в UI; S3.5–S3.6 добавляют чистую производственную очередь и интерфейс заказов. S3.7–S3.8 — модель и UI размещения готового проекта в стратегический корабль. S3.9 — чистый перелёт одного корабля между соседними своими колониями за один свой endTurn, пока без кнопок. Группировка флотов, топливо/снабжение, исследования, дипломатия и законченная кампания ещё не реализованы.

## Стек и команды

- TypeScript strict, ES2020; Phaser 3, WebGL/Canvas; Vite 4; Yarn Classic 1.22.22.
- На исходном аудите установлены Phaser 3.90.0, TypeScript 5.9.3, Vite 4.5.14. Актуальные диапазоны — в package.json, разрешения — в yarn.lock.
- `yarn install --frozen-lockfile` — установка; `yarn dev` — запуск на порту 3000; `yarn build` — TypeScript и production-сборка; `yarn preview` — просмотр сборки.
- Vitest 3.2.7: `yarn test` — однократный прогон, `yarn test:watch` — наблюдение, `yarn typecheck` — типы исходников и тестов. Vitest имеет отдельный vitest.config.ts; основной Vite 4 не обновлялся. Проверено на Node 24.20.0, рекомендуется Node 22+.
- Бэкенда и БД нет. ShipDesignManager подключён к верфи: localStorage, JSON импорт/экспорт, Zod 3.25.76 для проверки схемы и миграции.
- Arcade Physics настроена, но движение ручное. Не добавлять физику для исправления формул движения.

## Карта кода

- src/main.ts — конфигурация Phaser, регистрация сцен, масштабируемый canvas 1280×720.
- src/scenes — меню, карта стратегии MainScene, верфь, демонстрация кораблей, бой. MainScene владеет CampaignSession; ui/CampaignPanel получает только CampaignSessionView и callbacks, не полное состояние/определение карты.
- src/entities — Ship, CombatShip, фабрики, BattleManager; визуализация отдельно в visuals/ShipSprite.
- src/domain/shipDesign.ts — ComponentDefinition с kind, ShipDesign, ShipStats, чистые формулы, корпуса и единый валидатор нового пути.
- src/domain/campaign.ts — чистая фиксированная галактика S3.1; состояния партий, строгие explore/colonize и проекции стороны. Никаких Phaser/кораблей/RNG/часов/localStorage. Контракты ниже и в docs/CAMPAIGN.md; tests/campaign.test.ts — 45 регрессий.
- src/domain/campaignSession.ts — CampaignSession{galaxy,turn,treasuries,production,ships}, строгие executeSessionCommand и getCampaignSessionView. Переиспользует схемы/правила campaign.ts; все команды карты идут через session API. tests/campaignSession.test.ts — 60 чистых регрессий, campaignScene.test.ts — 51 контракт UI с fake Phaser.
- src/domain/campaignShips.ts — строгие стратегические записи, лимит100 на сторону; deployProduction переносит completed в ships, sendShip начинает transit, advanceShipTravel завершает own trips на успешном endTurn. isShipAtColony исключает transit из обеих колоний. tests/campaignShips.test.ts — 41 регрессия, campaignTravel.test.ts — 63; без Phaser/runtime/тактических формул.
- src/utils/ProductionCatalog.ts — read-only снимок семи пресетов и библиотеки ShipDesignManager; tests/ProductionCatalog.test.ts — 5 проверок. src/ui/ProductionPanel.ts — вкладка своей колонии, получает только SessionView/каталог/callbacks; CampaignPanel владеет её destroy.
- src/domain/production.ts — S3.5: strict productionStateSchema, getProductionQuote/Refund, advanceProduction FIFO без Phaser/runtime/часов. Обязательное session.production; enqueueProduction/cancelProduction и интеграция endTurn в campaignSession. campaignEconomy.ts — общие ресурсы, реэкспорт старых символов сессии сохранён. tests/production.test.ts — 58 регрессий.
- src/domain/shipState.ts — общее тактическое состояние всех Ship: движение, энергия, HP/щит, задержка регенерации, уничтожение, состояния орудий и партии груза. getState() возвращает независимую копию; это не формат сохранения боя.
- src/domain/cargo.ts — проверка новых партий, независимые ограничения массы/объёма, атомарная загрузка и FIFO-выгрузка; никакого Phaser. legacy/cargoCompatibility переводит старый weight в mass явно, без угадывания полей.
- src/domain/runtimeNumbers.ts — конечные численные аргументы и атомарная запись энергии; flightEstimate.ts — discriminated union оценки полёта по энергии, чистой мощности и текущей скорости. ЭЕ, ЭЕ/с, секунды симуляции и тактические расстояния; не межзвёздное топливо.
- src/entities/ShipRuntime.ts — единственный владелец ShipState, нейтральные движение/энергия/груз. Операции используют getEnergyCapacity/getEnergyGeneration/getMovementPower/getCargoLimits, а не component-shaped views. loadCargoLot принимает mass; getCargo возвращает копию. Legacy Ship расширяет эту базу собственными компонентами/refit.
- src/entities/TacticalShip.ts — withTactics добавляет state-accessors/навигацию без legacy-формул. DesignedShip → TacticalShip → ShipRuntime, без Ship/CombatShip; CombatShip → withTactics(Ship) → Ship → ShipRuntime, поэтому старый instanceof Ship сохранён. Единственный any — обязательная сигнатура конструктора generic mixin, не данные оборудования.
- src/legacy/DesignCompatibilityViews.ts — выходные проектные powerSource/engine/cargoHold. Конфигурация Object.freeze, currentEnergy — live-accessor; energy-only замена powerSource допустима, изменение конфигурации отклоняется. DesignedShip создаётся из createDesignState(stats), не из синтетических компонентов; операции читают stats/state.
- src/entities/interfaces/CombatSystem.ts — структурный ICombatant для IFaction/BattleManager; interfaces/ShipView.ts — readonly-срез для ShipSprite/ShipInfoPanel без команд симуляции и equipment. Оба слоя не импортируют конкретные модели; не возвращать CombatShip[] в менеджер. Readonly действует на уровне TypeScript, не замораживает runtime.
- src/entities/interfaces/FlightShip.ts — команды для ShipTestScene без конкретного Ship; тестовая руда загружается через loadCargoLot с mass. Старый loadCargo(weight) остаётся только совместимым входом моделей.
- src/domain/combatPresets.ts и civilianPresets.ts — четыре боевых и три гражданских ShipDesign, включая добытчик. Используются фабриками и кнопкой «Готовые проекты» верфи; нет отдельного расчёта характеристик пресетов.
- src/entities/ShipFactory.ts — createFromDesign(design, factionId = neutral) валидирует flight, обслуживает гражданские пресеты и полёт из верфи. CombatShipFactory сохраняет отдельную battle-проверку.
- src/legacy — LegacyShipFactory, LegacyShipComponentFactory и схемы проверяемых старых селекторов. Старые createCustomShip/ShipComponentFactory — deprecated wrapper/реэкспорт, сохраняют числа и импорты, не преобразуют legacy в проект. Прямая установка legacy IEquipment остаётся прежним mutable API.
- src/ui — компактные панели, общие ShipyardWidgets и ShipBlueprint; каталог и установленные копии разделены.
- src/domain/shipDraft.ts — сравнение черновика с сохранённым снимком (кроме updatedAt/порядка слотов). ShipBuilderPanel хранит baseline после чтения/успешного save, новый проект dirty. ShipyardModal — один Phaser-modal на сцену, ESC отменяет, shutdown очищает; замена/меню защищены, испытания сохраняют черновик.
- src/utils/ShipDesignManager.ts — библиотека v2, явная миграция шестислотовых v1 и поддерживаемых unversioned данных; ключи v1 сохраняются, повреждённый v2 не вызывает откат к старым данным.
- docs/SHIP_DESIGN.md — новый путь проекта; SHIP_MODEL и часть VISUALIZATION описывают также legacy-пресеты.
- reports/2026-09-07/plan.md — план, зависимости этапов и критерии приёмки.
- tests — регрессии legacy-боя, доменной модели, хранилища, DesignedShip и контракта представления. Phaser в visuals.test.ts подменён, это не браузерный тест.

## Порядок работы

1. Прочитать план и профильный навык: orion-ship-design или orion-combat; для стратегии — раздел ниже и docs/CAMPAIGN.md.
2. Проверить git status и только затронутые реализации/тесты. Навыки экономят общий анализ, но не заменяют проверку текущего кода.
3. Выбрать ограниченную задачу, определить ожидаемое поведение и регрессионную проверку.
4. Выполнить изменение, проверки и обязательное закрытие через orion-skill-maintenance и orion-task-report.

## Текущее состояние

2026-09-09: S3.9 выполнен, [отчёт](../../../reports/2026-09-09/07-campaign-travel.md). 63 новых доменных теста и1 сценовый, всего708/23 файла, typecheck/build. Настоящий Phaser программно проверил обычный endTurn и диагностический completed→deploy→send→arrival, отсутствие корабля в обеих колониях до прибытия, счётчик/сообщение/reset; localStorage неизменен. Это не mouse E2E и не UI перелёта. JS chunk1642.16 kB/gzip387.27 kB, предупреждение сохранено.

S2 закрыт для канонического проектного цикла; [приёмочная сверка](../../../reports/2026-09-08/11-s2-acceptance.md). Разделение Definition/Design/Stats/State/View, общий валидатор, сохранения, испытания и защита черновика приняты. Legacy ShipComponents/IEquipment сохраняются как совместимость; топливо/AI-конструктор/службы ещё не реализованы. Изменение модулей предсказуемо меняет расчёт/отдельные атаки, не гарантирует одинаковый исход случайного боя. Прежние браузерные проверки S2 — в отчётах, в S3.1 они не повторялись.

Далее S3.10: UI отправки выбранного своего стационарного корабля в соседнюю свою колонию и просмотр собственных transit/прибытия. Захватывать полный payload/expectedTurn, блокировать stale/pending, не раскрывать чужие ships; проверить оба направления/стороны, отказы, страницы, reset/cleanup и настоящий браузер. Топливо/содержание/группировка/бой/AI/save отдельно. S3 целиком открыт; службы mining/repair/scanner, autosave/recovery/beforeunload и сохранение кампании не реализованы.

## Ограниченный перелёт S3.9

- CampaignShip сохраняет прежние id/factionId/systemId/design и optional transit{destinationId,remainingTurns:1}. Нет transit — стоит в systemId; есть — systemId означает исходную колонию, не физическое присутствие. Не добавлять второй status/sourceId. Прибытие меняет systemId на destinationId и удаляет transit; ID/flight-snapshot/порядок/число ships неизменны.
- areSystemsAdjacent из campaign.ts переиспользует двусторонние lanes. Ship schema требует прямой переход в другую систему; session проверяет собственные колонии на обоих концах. Потеря любого endpoint делает state недопустимым; захвата ещё нет. Общий предел100 включает transit.
- sendShip строго kind/factionId/expectedTurn/systemId/shipId/destinationId. После schema/turn/active: own source → собственный ID в source → не transit → own target → adjacency. Новые SHIP_NOT_FOUND/SHIP_IN_TRANSIT/INVALID_ROUTE; чужая/нейтральная цель NOT_OWN_COLONY до проверки маршрута. Нельзя отправить completed или перенаправить transit. Расходов/смены хода/новых ID нет, MAX_ORDER_ID и MAX_TURN не блокируют саму отправку.
- Успешный свой endTurn завершает все собственные transit, включая отправленные в этом окне действий; чужой не продвигает их. Отказ ресурса/MAX_TURN не начисляет доход, не продвигает производство и не меняет перелёты. advanceShipTravel валидирует/копирует список, но ownership/turn — ответственность session, не отдельный публичный обход правил.
- SessionView выдаёт только свои независимые ships/transit, даже после разведки чужих endpoints. В UI использовать isShipAtColony, а не один ship.systemId===colony; общий счётчик остаётся по всем своим ships. В S3.9 нет controls/списка маршрутов: лишь фильтрация существующих страниц, отдельное сообщение sendShip и честные подписи границ.
- Стационарные записи S3.8 без transit совместимы, поле не заполняется автоматически. Сессии без ships по-прежнему INVALID_STATE; версия save/миграция не добавлены. Нет топлива, скорости/батареи, маршрутов через несколько систем, отмены перелёта, боевого runtime. tests/campaignTravel.test.ts покрывает схемы, own/active/stale, обе стороны/направления, atomic endTurn, caps, frozen/replay, snapshot/privacy и производство/колонизацию.

## Интерфейс размещения S3.8

- Нижняя часть ProductionPanel переключается production-toggle-ships между готовыми и размещёнными в выбранной своей колонии. Готовые: production-deploy, страницы production-completed-prev/next; размещённые: production-ship, страницы production-ships-prev/next. Обе страницы по одной записи, ID/имя. Счётчики колонии отдельно от общего own ships/100, чужие записи не передаются.
- Deploy замыкает показанный record.id, MainScene замыкает factionId/systemId/expectedTurn и вызывает session-команду. Нет completed — disabled; неактивная сторона/SHIP_LIMIT остаются доменными отказами по доступной кнопке. Повтор старого callback после redraw инертен, новое нажатие может разместить следующую запись.
- MainScene хранит showShips/shipsPage отдельно от completedPage; render ограничивает обе страницы текущими списками, после deploy готовые остаются открыты, shipsPage указывает новый корабль. Выбор колонии/стороны сбрасывает страницы/режим; reset/shutdown очищают их. Переключение режима не меняет игру/каталог.
- Pending блокирует deploy/toggle/страницы; ESC сначала отменяет pending, иначе закрывает всё производство на карту. Destroy родителя освобождает дочернюю панель и callbacks. Длинный completed имеет570 px до кнопки, ship745 px; реальный text.width+многоточие без изменения snapshot. Счётчик лимита в начале подсказки не теряется при обрезке.
- UI явно говорит: размещение бесплатно, в этой колонии, без смены хода; кнопок перелёта и боя пока нет. Перелёт модели добавлен S3.9; библиотека и зависимости не менялись. Сценовые тесты с fake Phaser не являются hit testing.

## Стратегическое размещение S3.7

- Session.ships обязателен, старт[]; CampaignShip{id,factionId,systemId,design,transit?} без HP/энергии/боезапаса/груза/скорости/runtime. Общий flightDesignSchema из production, гражданский без оружия допустим. При размещении экземпляр стационарный, не флот/тактический ShipState; последующий transit описан выше.
- deployProduction строгие factionId/expectedTurn/systemId/orderId. Общие schema/turn/active проверки, затем своя колония, собственный completed именно там, затем лимит100 ships на сторону. Новые COMPLETED_NOT_FOUND/SHIP_LIMIT. До успешного переноса ничего не удалять; казны/turn/галактика/pending/чужие записи неизменны.
- ID наследуется от заказа, дополнительного счётчика/sourceOrderId нет. ships уникальны между собой и не пересекаются с orders/completed, ≤production.lastOrderId. Размещение не меняет счётчик и возможно на его пределе/при MAX_TURN (только активной стороне). Повтор на новом state — COMPLETED_NOT_FOUND; старый expectedTurn — STALE_TURN. Это не network authority/dedup.
- До100 ships на сторону отдельно от100 pending+completed. Перенос освобождает production-место; при SHIP_LIMIT completed остаётся. Порядок ships — размещения, не возрастание ID; разные completed разрешено размещать в любом порядке. Удаления кораблей пока нет.
- Session проверяет own colony для стационарных ships, с S3.9 для обоих концов transit. Вся вложенная структура копируется Zod на session boundary; query выдаёт только свои ships и не раскрывает чужие даже после разведки. ID gaps не multiplayer-защита.
- Старые runtime-сессии без ships INVALID_STATE, миграции/save нет. После HMR начать новую партию. S3.8 вызывает deployProduction отдельным callback с orderId и показывает свои ships; generic command панели не расширять до union без payload.

## Интерфейс производства S3.6

- campaign-production переключает левую карту на ProductionPanel. Только своя выбранная колония имеет controls; чужие/неизвестные очереди не передаются. Для выбора другой системы вернуться на карту. Наблюдение не меняет active; доступная кнопка неактивной стороны показывает доменный отказ.
- Каталог лениво читается при открытии и явно по production-refresh, не каждый render. Семь общих пресетов + сохранённые проекты, индексный выбор; общая локальная библиотека не фракционные технологии. load не пишет/не чинит storage; при отказе явное сообщение и пресеты. Неполный draft имеет причину и disabled enqueue. Refresh сбрасывает выбор, не меняет оплаченный snapshot.
- MainScene захватывает expectedTurn/factionId/systemId и отдельную копию выбранного design; cancel получает orderId. disposed у обеих панелей блокирует старые callbacks после любого redraw/reset/выхода, даже в том же ходу. Не заменять payload на generic kind.
- Показаны цена/срок, до3 своих заказов выбранной колонии, выполненные/оставшиеся ходы, сумма возврата на кнопке немедленной отмены. completed по одной записи на страницу; S3.8 добавляет их размещение и просмотр ships. Длинные имена нормализуются только для показа и сокращаются с многоточием по фактической text.width; wordWrap+maxLines скрывал имя после ID, не возвращать эту комбинацию. Полный проект в команде неизменен.
- Pending блокирует также вкладку/выбор/refresh/заказ/отмену/пагинацию. ESC отменяет pending, иначе сначала закрывает производство, затем запрашивает menu. Reset/shutdown очищают каталог/выбор/страницу/дочернюю панель. Сцена остаётся единственным владельцем сессии; библиотека и кампания не сохраняются действиями производства.

## Производство S3.5

- production{lastOrderId,orders,completed} обязательно, старые runtime-сессии без него INVALID_STATE, save/migration нет. После HMR старой схемы начать новую партию. ID глобальный для партии1..1e9 без часов/RNG, не переиспользуется после отмены; cap блокирует enqueue, но не cancel/endTurn.
- Заказ{id,factionId,systemId,design,remainingTurns}, готовый тот же без remainingTurns. Независимый schemaVersion2 flight-проект; validateDesign/calculateShipStats переиспользуются, цена/статы не сериализуются. Готовый — запись, не DesignedShip/флот/боевое состояние. Изменение формул потребует будущего versioning; live refit не меняет snapshot.
- Quote: credits=ceil(stats.cost/100), minerals=ceil(stats.mass/10), turns=max(1,ceil(credits/50)); полный prepay. Отмена только queued своего ID в своей колонии: floor(cost*remaining/total) каждого ресурса, overflow отменяет всё. Доход/старт прежние10/5 и100/50. Нет содержания/развёртывания, баланс предварительный.
- До3 pending на колонию, до100 pending+completed на сторону (резервирует готовность, без переполнения при finish). Pending ID строго возрастают; IDs уникальны между списками и ≤lastOrderId; remaining1..quote.turns, waiting за head не имеют прогресса. Сессия проверяет owner колонии для всех записей, захвата нет. S3.7 удаляет completed при успешном размещении в ships; UI команды подключён S3.8.
- Только первый queued каждой своей колонии прогрессирует на own endTurn; новая колония и новый заказ могут сразу получить шаг, spillover нет. Доход/turn проверяются до прогресса, отказ откатывает всю команду. MAX_TURN блокирует только endTurn, остальные команды по прежним правилам. advanceProduction — чистый detached helper, caller сессии уже проверил turn/owner.
- enqueueProduction поля factionId/expectedTurn/systemId/design, cancelProduction вместо design содержит orderId. Доп. ошибки NOT_OWN_COLONY/INVALID_DESIGN/INSUFFICIENT_RESOURCES/QUEUE_FULL/PRODUCTION_LIMIT/ORDER_NOT_FOUND/ORDER_ID_LIMIT. INVALID_DESIGN для structurally-valid не-flight, malformed→INVALID_COMMAND. cost/refund/progress лишние поля запрещены.
- View production только свои orders/completed без global counter; nested detached. Это не multiplayer security, собственные глобальные ID могут иметь пропуски. Повтор enqueue того же дизайна в одном ходу — новый оплаченный заказ, не network dedup. Повтор cancel исчезнувшего ID отказывает; stale endTurn не платит/не завершает второй раз.
- Общий command callback CampaignPanel остаётся explore/colonize/endTurn (явный union); производство подключено отдельными payload-callbacks в S3.6.

## Пошаговая сессия S3.3

- campaignSession.ts хранит одну galaxy (CampaignState), turn и казны blue/red. Нечётный turn — blue, чётный — red, отдельного mutable activeFactionId нет. Один turn — окно действий стороны, не полный раунд. Старт turn1, каждой стороне 100 credits/50 minerals без дополнительного дохода.
- Доход каждой текущей своей колонии 10/5 при собственном endTurn, включая основанную в этом ходу; чужие/нейтральные даже разведанные не учитываются. Ноль колоний = ноль дохода, не поражение. Запрос income не начисляет его. Расходы/возврат производства добавлены S3.5; населения/содержания нет, минералы не груз/служба mining.
- executeSessionCommand unknown→strict schema→expectedTurn→active side→доменный action. Explore/colonize переиспользуют campaignCommandSchema и executeCampaignCommand; бесплатны/без лимита действий, не меняют turn/treasuries. EndTurn начисляет только ending side и увеличивает turn. Базовый API остаётся географическим слоем и тестовым контрактом, но MainScene не должна вызывать его напрямую в обход session-проверок.
- Ресурсы целые0..1e9, turn целый1..1e9; строки/null/NaN/Infinity/дроби отвергаются. При превышении любого ресурса или MAX_TURN весь endTurn отклоняется до записи. Точное достижение resource cap допустимо, clamp нет; resource cap может остановить ход до расходов на производство.
- expectedTurn обязателен у всех команд: stale повтор endTurn на возвращённом state не платит снова, даже через круг сторон. Повтор на старом снимке детерминированно повторяет результат — caller обязан принимать новый state. Это не ID партии/request-id/сетевая дедупликация, не revision каждой команды внутри хода и не multiplayer authority.
- getCampaignSessionView даёт galaxy projection + public turn/activeFactionId + только собственные treasury/income/production, всё detached. Query invalid→ZodError, command invalid→typed error. Ошибки карты сохраняются; дополнительные STALE_TURN/NOT_ACTIVE_FACTION/RESOURCE_LIMIT/TURN_LIMIT и коды производства выше. Schemas runtime, не versioned save.

## Карта S3.4

- MenuScene: «Галактика», кнопка start-campaign → MainScene. Каждое create создаёт CampaignSession turn1/blue/sol, обе казны100/50. MainScene принимает result.state только при ok; правила в campaignSession.ts/campaign.ts, не UI.
- CampaignPanel получает CampaignSessionView: galaxy projection + собственные treasury/income + публичные turn/activeFactionId. Named labels campaign-turn/turn-hint/treasury/income/side, button campaign-end-turn. После endTurn наблюдаемая сторона сохраняется для просмотра начисления; для следующей команды нужно переключиться на активную. Переключение не меняет turn/казны; неверные действия доступны и показывают отказ модели, не обходят очередь.
- render захватывает expectedTurn/factionId/systemId для команды; не подставлять текущие mutable поля поздним callback. disposed-guard старой панели блокирует callback после redraw/reset/restart даже при совпадении turn1. Несоответствие захваченного хода актуальному отдельно отклоняется доменом. tests/campaignScene.test.ts покрывает stale/overflow/terminal/inactive/privacy, без настоящего hit testing.
- Выбор кнопкой system-ID (название под звездой); campaign-explore/colonize вызывают сессию. Цвет/маркер/детали не раскрывают неизвестного владельца/пригодность. campaign-side-switch сохраняет выбор и очищает сообщение/ошибку; старая казна/доход не остаются в UI.
- campaign-new/menu открывают inline-подтверждение потери партии. Пока pending, все фоновые кнопки, включая endTurn, без input; campaign-cancel/confirm активны. ESC отменяет pending, иначе закрывает производство, а на карте запрашивает menu. Сброс восстанавливает blue/sol/turn1/казны100/50; нет автоматического save/beforeunload.
- Panel пересоздаётся по действиям, не каждый кадр; destroy удаляет display list и делает stale callbacks инертными. Shutdown снимает ESC, освобождает панель/state/pending; повторный вход один handler/одна панель. Верстка рассчитана на логический canvas1280×720/FIT. Локальное управление обеими сторонами, не AI/multiplayer.

## Стратегическая модель S3.1

- campaign.ts задаёт шесть систем sol/eden/rift/nexus/dust/vega, двусторонние lanes, две стороны blue/red с домами sol/vega. Rift/dust непригодны, остальные пригодны. Координаты — раскладка, не тактическая/полётная дальность; карта не сбалансированный генератор.
- getGalaxyDefinition возвращает независимую ПОЛНУЮ карту для доверенной модели. createCampaignState — новые вложенные объекты каждой партии: системы с id/ownerId/exploredBy. Нет runtime-кораблей/боя/стоимости/времени/ресурсов.
- campaignStateSchema строго проверяет точный уникальный набор известных систем, стороны без дубликатов, owner⇒explored+habitable. Это runtime-инварианты, не versioned save. Не подключать это к ShipDesignManager как сохранение кампании.
- executeCampaignCommand принимает unknown state/command, проверяет схемы, возвращает ok/state либо ok:false/code/message. Никаких мутаций входа; успех — полностью отделённый state, содержательно меняется только цель. UI должен принять state лишь при ok, не менять его до команды.
- explore: цель неизвестна действующей стороне, сосед хотя бы одной её разведанной системы. Владение/пригодность не требуются; разведка может пройти через чужие/нейтральные/непригодные системы. colonize: разведана, свободна, пригодна, сосед собственной колонии. Порядок отказов: видимость перед владельцем/пригодностью; повторные команды отказывают. Действия мгновенные/бесплатные, без флотов/ходов; будущие миссии требуют отдельной реализации.
- getCampaignView возвращает независимые systems/lanes: неизвестные только id/name/x/y/visibility, разведанные ещё ownerId/habitable. Не раскрывать полный state/definition в UI. Имена/топология публичны; exploredBy скрыт. Знание постоянно, владелец актуальный, не last-seen snapshot. Проекция не является multiplayer-авторизацией; локальный caller задаёт factionId.
- Query getCampaignView бросает ZodError при неверном state/faction; команды возвращают типизированный отказ. Тесты проверяют ошибки, frozen-вход, независимость вложенных объектов, обе стороны, неизменную чужую проекцию, локальность результата и детерминированный replay команд; это не детерминизм тактического боя.
