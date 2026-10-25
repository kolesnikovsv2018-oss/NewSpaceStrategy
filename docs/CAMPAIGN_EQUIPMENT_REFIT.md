# Н12 — объём оборудования, варианты и переоснащение

## Единственный эффективный проект

Текущий ShipDesign5 сохраняет независимые параметры установленных модулей,
`tacticalRules`, `hullVariant`, kind-specific `tacticalVariant`
и обязательный `technologyVariant: standard | compact`. [Н13](CAMPAIGN_COMBAT_TECHNOLOGIES.md)
расширил формулы без изменения paid FIFO/reservation. Базовые числовые
definitions, идентичность технологического варианта, установленный snapshot
и operations — разные данные. Производные stats/цена/прогноз не сохраняются.

Н14 добавляет обязательный отдельный strategicEquipment и его каноническую
доплату. Refit того же корпуса сохраняет абсолютное fuel: больший бак
не заправляется, меньший текущего запаса отвергается. Стратегические
возможности действуют только после оплаченного completion; в пути refit
запрещён. [Контракт и цены](CAMPAIGN_TRAVEL.md).

`calculateComponent` и `calculateShipStats` — единственные расчёты для
свободной верфи, кампании, производства, AI и настоящего resolver.
Результат чтения оплаченного проекта не зависит от текущего research,
внешней библиотеки или её изменений.

| Оборудование | Базовый equipment-volume |
| --- | --- |
| beam /projectile /engine | 20 /30 /35 |
| shield /armor | 25 /20 |
| mining /repair /scanner /cargoExpansion | 30 /20 /15 /20 |

| Корпус | Бюджет equipment-volume |
| --- | --- |
| fighter /corvette /frigate | 60 /100 /140 |
| destroyer /cruiser /battleship /colonizer | 180 /220 /300 /100 |

Объём оборудования — не масса, размер hardpoint или грузовой cargoVolume.
Все ограничения проверяются независимо общим `validateDesign` и повторно
при установке/сохранении/заказе/refit. Произвольные caller volume/cost
поля запрещены strict schema.

Компактный вариант открывает миниатюризация:4000 науки после engineering.
Объём ×4/5, цена компонента ×5/4 с округлением вверх после базовой цены;
масса/мощность/боевые ratings прежние. Данные объёмов кратны5, поэтому
equipment-volume остаётся точным целым; budget+1 не допускается.

В кампании один доступ: hull/family/numeric bands/variant и общие
физические ограничения. **Preset exemption отсутствует.** Даже точный
старый dreadnought не обходит закрытые numeric характеристики. Пресет,
который действительно укладывается в текущие правила, доступен.
Свободная верфь не получает campaign research caps.

Новый unlock не меняет проекты/оплаченные orders/completed/ships/transit.
Сохранённые чертежи своей стороны редактируются явно; обновление корабля
требует нового заказа или refit.

## Refit

`startRefit {factionId, expectedTurn, systemId, shipId, design}`:

- Полные state/payload/stale/active/controller/completed проверки.
- Только свой стоящий корабль того же корпуса, без fleet membership,
  в собственной колонии; target должен быть доступным flight design.
- Quote пересчитывается доменом: для каждой валюты
  `ceil(newFullCost/4) + max(0, newFullCost−oldFullCost)`.
- ProductionCost = `max(1,ceil(refitCredits / productionCreditsPerPoint))`,
  divisor в текущих rules равен10. Полная предоплата.
- Работа получает новый общий production ID, но сохраняет ID корабля.

Refit использует [тот же промышленный FIFO](CAMPAIGN_TERRAFORMING.md),
а не отдельный поток очков. В `colonyOutput.projects` хранится tagged refit
с shipId/target snapshot/закреплёнными cost/progress. Общие лимиты3/колонию,
100 pending+completed/сторону, один head/no spillover.

С постановки до completion/cancel заблокированы отправка, включение
в группу и повторный refit. Schema запрещает reservation вместе с transit/
membership. Корабль остаётся на месте, платит upkeep и **сражается старым
оснащением**. Отдельные платные repair/resupply/refuel не бесплатны и
не откатываются при завершении.

Завершение применяется после encounters к сохранившемуся ship/own colony.
Уничтожение корабля или захват колонии отменяет работу без refund, включая
работу, набравшую последние очки в этом endTurn. Квитанция выдаёт только
собственные completed/cancelled IDs.

`getRefitOperationalState` переносит актуальный, а не стартовый HP.
NewMaxHP ниже currentHP запрещён. Fuel остаётся на CampaignShip и
не пополняется. У нового/заменённого projectile ammo=0. Только тот же слот
с неизменными эффективными damage/range/fireRate/accuracy/ammoCapacity сохраняет остаток;
compact-only замена допускается. Щит/энергия/cooldown по-прежнему
не сохраняются между боями.

`cancelColonyProject` освобождает корабль и возвращает только unused
долю предоплаты по точной BigInt-формуле Н11. Старый design и текущие
operations остаются. Refund cap отклоняет всю отмену.

## UI и AI

Кампанийный редактор Н05а показывает открытые standard/compact и остаток
equipment-volume. Установка/сохранение используют общую проверку.
Новый параллельный редактор или импорт внешней библиотеки не вводились.

Выберите свой корабль → **Переоснастить** → свой сохранённый проект того же
корпуса. Полный quote и условия показаны в подтверждении, даже если длинное
имя сокращено в picker. Во время refit эта кнопка показывает progress/
wait/pause и отмену/refund. Работа также доступна в Производство →
**Работы мира**. Desktop/mobile сохраняют captured source, pending,
ESC/resize/shutdown guards. Оплата не происходит при просмотре/отмене.

AI рассматривает standard/compact внутри прежнего bounded бюджета
кандидатов и команд. **Auto-refit отсутствует намеренно:** первая policy
не останавливает действующий флот ради повторной оплаты. Это не скрытая
автоматическая модернизация и не требование будущих Н13/Н14.

В демонстрационной верфи переключатель варианта есть у компонента; его
изменение не меняет уже установленную копию. Каталог сохраняется отдельно.
Демонстрационный legacy UI остаётся фиксированным, не новой мобильной
кампанийной раскладкой.

## Форматы и совместимость

Только текущие версии:

| Формат | Версия |
| --- | --- |
| Conquest save/rules | 15/12 |
| Rules snapshot schema/rules | 10/10 |
| Research tree /baseline | 9 /11 |
| ShipDesign /library | 4 /4 |
| Мирные state/run/match codecs; rules | 5/6/7;3 |
| Galaxy map/rules/generator/profile | 3/3/v3/v3, без изменения |

Library пишет `orion_shipyard_v4`; старые ключи не удаляются и не читаются
как fallback. Import/decode старых версий явно отказывает. Мирные игровые
API/правила не расширены, но nested design и связанные codecs обновлены.
Общий ручной слот прежний; неудачный load/write не заменяет старые байты.
Миграций, старых readers и автоматических grants нет.

## Проверки и ограничения

Ниже историческая приёмка Н12. Текущая сквозная приёмка Н13 —
[отчёт16](../reports/2026-10-25/16-n13-combat-technologies.md).

Регрессии: [campaignRefit](../tests/campaignRefit.test.ts),
[campaignProjects](../tests/campaignProjects.test.ts),
[conquestScene](../tests/conquestScene.test.ts) и codec/library suites.
Включены exact/+1 volume, независимые mass/power, закрытый variant/preset,
неизменные paid snapshots, операции/топливо, reservation/refund и настоящий
бой на границе завершения с уничтожением refit ship.

Actual Chromium1280×720/390×844: кампанийный редактор→свой проект→paid order→
compact edit→pointer refit/ESC→progress→удаление чертежа→actual reload/full
state/next oracle→completion→настоящий бой→actual reload. Отдельная free
yard/library3 с настоящим сохранением и reload; мирный paid nested design3/
save6/rules2/reload/next oracle. Обычные команды сцены и события кнопок,
не полный mouse E2E/physical touch hardware/quota/FPS.
