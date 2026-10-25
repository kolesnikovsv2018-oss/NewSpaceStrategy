# 19 — Н14: стратегическое оснащение и многотактовые перелёты

- Дата:2026-10-25.
- Пункт плана: [Н14](../../plans/tasks-2026-10-09/n14-strategic-travel.md).
- Статус: выполнено в согласованных границах.
- Основа: [аудит17](17-n14-readiness.md), [подготовка18](18-n14-preparation.md),
  [согласованный контракт](../../docs/CAMPAIGN_TRAVEL.md).

## Цель и границы

После проверки Н05/Н12 выполнена Д11, затем внедрён Н14 в единственном
Conquest: возможности отдельных проектов, время и дистанционный расход,
группы, исследования, генератор, UI/AI и сохранения.

Прямую модель Д08 не заменяли линиями. Тактика Н13, мирные fuel3/
arrival1 и ownership/adjacency не расширены. Н15–Н20, автоконвои,
отмена/redirect в пути и auto-refit AI не реализованы.
Незакоммиченные изменения Н11–Н13 сохранены; commit/push не выполнялись.

## Изменения и решения

### Единый расчёт

[campaignTravel](../../src/domain/campaignTravel.ts) содержит чистые
возможности оснащения, single/fleet quotes, refuel и формат тысячных.
Нет зависимости от ShipDesign, Phaser, DOM или IO; CLI использует
то же ядро через текущие TypeScript imports.

Обязательный strategicEquipment проекта содержит policy project-travel-v1
и независимые drive/jump/tank. База100 speed/200 jump/3000 тысячных fuel;
расход ceil(distance×5), время max(1,ceil(distance/speed)).
Distance — Math.hypot исходных координат без предварительного округления.
Exact limits допустимы, неверные параметры/overflow отклоняются явно.

Fast200/+75 credits, jump400/800/1500 за50/100/150, tank9000/+60.
Fast/tank стоят по3000 science после engineering; jump открывают прежние
engineering/ordnance/capital. Доплаты складываются в общей цене,
mass/volume/tactical ratings/minerals не меняются. Штатный комплект
включён в корпус; scanner сохраняет отдельный радиус исследований стороны.

### Экземпляры, группы и pipeline

- Военная strategicShipsSchema отделена от мирной campaignShipsSchema.
  Shared selectors не смешивают их правила. Upkeep/resolver используют
  правильную схему; мирные unknown-границы не принимают военный transit.
- Transit хранит policy/destination/distance/capabilities/fuelCost/
  totalTurns/remainingTurns; сверяется с проектом и исходной картой.
  На fleet и в UI второй маршрут не сохраняется.
- Send списывает весь согласованный fuelCost однократно. В группе
  минимальные speed/jump, у каждого собственный бак; сначала проверяются
  все quotes, затем применяется весь вылет.
- Только успешный own-end уменьшает remaining. Fleet.systemId и все
  участники переносятся одновременно на последнем шаге. Чужой ход,
  повторный вылет, stale и redirect не создают второй прогресс.
- В пути нет присутствия/видимости endpoints, боя и служб. Mining
  forecast учитывает только stationary/arriving этим own-end; actual
  mining идёт только после фактического arrival перед encounters.
- S0, содержание, FIFO, late rollback, права/controller/completed,
  reservation и post-encounter completion сохранены.
- Unlock не переписывает прежние projects/orders/completed/ships.
  Ранее построенный корабль улучшается платным refit. HP/ammo контракт
  Н13 сохранён; больший бак не заправляется, меньший текущего fuel запрещён.

### Генератор, UI и AI

- Map initialTravel содержит реальную базу100/200/3000/5 без fuelPerJump.
  Initial checker и команды используют общий quote; обе ближайшие
  нейтральные habitable цели каждого дома достижимы стартовым комплектом.
  Bounded generation, canonical JSON и публикация до старта прежние.
- Кампанийная/свободная верфь: **Характеристики → Стратегическое оснащение**.
  Кампания показывает только earned options; общий dirty/price/validation.
- Выбор цели показывает quote, затем подтверждение distance/own-turns/
  fuel/jump/баков либо отказа. ESC отменяет до списания. В пути показываются
  remaining, службы и повторный групповой вылет/расформирование отключены.
- AI использует own-view reachable quotes и законный refuel. Исследования
  оцениваются по возможной дистанционной пользе; старые ограниченные
  корабли не телепортируются после unlock.
- AI может заказать более дальний оснащённый экземпляр без auto-refit.
  Прежний скрытый deploy-порог8 блокировал выдачу таких оплаченных замен;
  теперь deploy проверяет действующий общий лимит100. Конструктор
  по-прежнему ≤47 combat candidates плюс colonizer, пакет≤24 commands.
  Боевые заказы обычно ограничены4, дальние замены — до8 combat records.

## Форматы

| Формат | Текущая версия |
| --- | --- |
| ShipDesign /library |5/5; ключ orion_shipyard_v5 |
| Conquest save /rules |16/13 |
| Rules snapshot schema /rules |11/11 |
| Research tree /baseline |10/12 |
| Map schema /rules |4/4 |
| Generator /profile |galaxy-generator-v4 /balanced-start-v4 |
| Мирные state/run/match codecs; rules |6/7/8;4 |
| Tactical /initiative |design-combat-v1 /campaign-v2, прежние |

Только текущие readers, без миграций/fallback/repair defaults.
Прежние ключи библиотеки не удаляются. Мирные конверты изменены
из-за nested design5, не новой мирной механики.

## Автоматические проверки

| Проверка | Фактический результат |
| --- | --- |
| Аудит перед изменениями |395 тестов/17 файлов, strict/build173 |
| Финальный полный `yarn test` |**3835 тестов/71 файл прошли** |
| Новый campaignStrategicTravel |9 регрессий, входят в полный набор |
| Последний связанный UI/services/research набор |111/4 прошёл до добавления последнего battle oracle |
| `yarn typecheck` |strict browser/CLI/tests прошёл |
| `yarn build` |173 модуля; прежний chunk warning >500kB |
| `git diff --check` |прошёл |
| Отчёты/travel/навыки |175 локальных ссылок/якорей в7 документах и YAML3 навыков прошли |

Новые9 регрессий проверяют независимые числовые формулы и цены,
exact jump/+1, exact fuel/−1, invalid speed/overflow,5/3 group quote,
полное отсутствие early mining/services, paid science в пути без
ускорения pinned route, атомарный group shortage, синхронное прибытие,
paid equipment/refit без бесплатного fuel, реальные обе стартовые
колонизации каждой стороны и paid multi-turn arrival-battle oracle.

Сохранённые тесты проверяют schemas, unknown boundaries, rights,
immutable/detached данные, CLI subprocess/canonical JSON, P=2…8,
100 seed малого/среднего/максимального профиля, повреждённые карты,
store failures, старые мирные операции и тактические регрессии.
Наборы пересекаются, числа не суммируются.
Длительные команды ограничены внешним wall-clock deadline.

Сценовые fake Phaser и контрактные StoragePort перечислены отдельно
от настоящего Chromium ниже.

## Реальный baseline12

Запущены реальные runBaseline/verifyBaseline через Vite SSR, тот же
домен/исполнитель/resolver, без заглушек. Это выбранная матрица24,
не полный публичный CLI-прогон58.

| Группа | Количество | Результат | Repeat/checkpoint |
| --- | --- | --- | --- |
| Paid6 current-ai |6 |6 timeout на200 окнах |все совпали |
| Paid6 research-first |6 |6 timeout на200 окнах |все совпали |
| Paid6 production-first |6 |4 completed65–66,2 timeout200 |все совпали |
| Boundary symmetric/supply, direct/mirror |4 |timeout8, реальные бои |все совпали |
| Bounded40/256 |2 |timeout16 |оба совпали |

Executor-error нет.4 completed из18 не означают универсальный паритет.
**14/18 paid партий не завершились в200 окнах**; это существенное
измеренное ограничение нынешнего AI/баланса. Timeout не даёт победу.
Реальный прогресс/бои/прибывающие маршруты есть; это не ошибка countdown
или скрытая телепортация. Прежний темп Н13 не переносится на Н14.

Unit baseline-проверки18 opening schedules ограничены16 окнами:
они проверяют законность, повтор и checkpoint, не гарантируют победу.
Полный200-window repeat/checkpoint отдельно измерен выше, а не заменён
короткими тестами. Научная checkpoint-регрессия также ограничена
своим16-window предметом вместо ожидания конца новой длинной партии;
deadlines ради прохождения не повышались.

## Настоящий Chromium

Headless Chromium через локальный CDP и временный Vite. Использован
существующий displayed game по точному URL script main, без второго
импорта/канваса. Постоянная CDP-сессия удерживала viewport: фактические
CSS1280×720 и390×844 совпали с canvas,1canvas, min14px text/44px controls.
Закрытие CDP-сессии снимает viewport override: промежуточный780×493
не засчитывался как целевая приёмка.

Для обоих размеров выполнены реальные оплаченные scene-команды:

- Earn engineering/support/ordnance/capital/fast/tank.
- Кампанийный editor, выбор трёх опций, save проекта; paid refit
  стартового colonizer с сохранением fuel3000 и отдельной платной
  заправкой до9000.
- Paid два новых corvette, один standard, второй fast/galactic/extended.
- Многотактовый single и смешанная группа с двумя своими шагами,
  индивидуальным расходом/баками3000 и9000; возврат/refuel/disband.
- Физические CDP pointer new/send/confirm и Escape/cancel без изменения
  state; прочая подготовка scene-командами/событиями реальных кнопок,
  без подстановки ресурсов, ships, research или игрового state.
- Actual localStorage save → reload страницы → явный load при single
  и midway group; полное state и полный результат следующей команды
  совпали с непрерывным независимым oracle.
- Многотактовый поход оплаченного корвета к red home, настоящий resolver,
  уничтожение red colonizer/occupation, post-battle save/reload/full next.
  На обоих целевых размерах бой на45, checkpoint после боя47.
- Дополнительный actual saved40 → запись другой latest-map256 →
  reload/load сохраняет всю40-world партию и полный следующий результат.
- Actual mobile in-flight remaining3, disabled repair/resupply/refuel/
  refit/send, длинное имя с корректным сокращением, без новых page errors.
- AI-red2 paused → actual save/reload/load остаётся paused без ticket;
  pointer Resume/confirm → настоящий AI3 совпал с независимым oracle.
- Free yard: выбор fast, pointer save library5, actual reload и
  восстановление проекта/библиотеки.
- Мирный paid production/deploy/send сохранил fuel2 и remaining1,
  actual save8/rules4/reload/load на23 и полный next oracle24/arrival eden.

Это не полный mouse E2E всех действий, не physical touch hardware,
не естественный FPS и не реальная quota. Ошибки вспомогательных
диагностических скриптов исправлялись, сценарии повторялись; незавершённые
пробы не выдаются за приёмку.
Временный браузерный профиль был отдельным; только созданные ключи
удалены. Финально MenuScene/1canvas/0storage keys/0ticket/0panel/
0Conquest ESC handlers. Временные Chromium/CDP/Vite остановлены.

## Актуализация навыков

Project/ship-design/combat получили актуальные Н14 formats, точки входа,
военную ship schema, fuel units/pinned transit, неизменность тактики,
новые тесты и реальные ограничения baseline/browser.
Дорожная карта, общий контракт, указатель/журнал и прямо связанные
docs актуализированы; Н15–Н20 не объявлены реализованными.

## Оставшиеся вопросы и следующий шаг

- По прямым предпосылкам доступны Н15 и Н16.
- Нынешний AI/баланс даёт14/18 timeout200; это явно сохранённый долг,
  не гарантия завершения любой партии или универсального баланса.
- Полные58 baseline, quota, natural FPS и physical touch не измерены.
- Сохраняется предупреждение размера bundle.
- Нет миграций прежних форматов, автоконвоев, auto-refit и отмены leg.
- Зависимости/lockfile не менялись; commit/push не выполнялись.
