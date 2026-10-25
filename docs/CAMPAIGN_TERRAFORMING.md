# Н11 — платное терраформирование

## Правило

Собственная населённая toxic-колония превращается в habitable. Barren,
обратные переходы и инфраструктура не входят. Узел terraforming стоит6000
науки после biosphere/toxic-adaptation; typed terraform-unlock разрешает
переход из автономного rules snapshot.

Предоплата300 credits/150 minerals,12000 production points. Цена/переход
сохраняются в партии и работе. Внешние таблицы не меняют текущую партию.

## Общий промышленный FIFO

В `colonyOutput.production.orders` остаются ship records, в
`colonyOutput.projects` — tagged стратегические работы. Это физически
раздельные типизированные списки, **одна логическая очередь**:
`colonyWorkQueue` объединяет их по общему монотонному ID. Отдельный список
порядка/распределение очков не сохраняется. Это сохраняет ship consumers
без синтетического design у планетарной работы.

Общие ограничения:3 ожидающих записи/колонию,100 pending+completed
на сторону, один head/own-end/no spillover. Только head получает весь
промышленный выпуск строки. Наука/культура и assignments не дублируются.
Нулевой выпуск означает pause, работа позади head ожидает FIFO.
Допускается только одна terraform-работа мира.

`startTerraform` и `cancelColonyProject` используют общие права и expectedTurn.
Сначала проверяется собственная колония, затем переход/наука/очередь/ID/
ресурсы. Caller не задаёт цену, target или progress.

Отмена возвращает по каждой валюте
`floor(prepaid × (productionCost−progress) / productionCost)`, через BigInt.
При progress0 возврат полный; прогресс не возвращается и не переносится
при повторном старте. Cap возврата отклоняет всю команду.

## Время, захват и знание

Выпуск и обычный рост вычисляются по S0 и старой среде. Завершение работы
применяется после encounters: повторно проверяются owner/source/P>0.
Захват отменяет ожидающие/завершающиеся работы без возврата.
Квитанция сообщает завершённые/отменённые IDs.

Completion сам не меняет P/остаток и не даёт второй рост. K вычисляется
по новой среде/earned effects; следующее развитие использует новый тип.
Own surveys обновляются обычным reveal. Сторона вне наблюдения сохраняет
старое изученное знание, чужой проект/актуальный тип не раскрываются.

Меняется только runtime environment. Initial map/latest-map и военная
цель по исходным пригодным мирам неизменны. Нового terraform-barren нет.

## UI, AI, форматы

В своей колонии откройте Производство → **Работы мира**:
переход/цена/очковая стоимость, progress/wait/pause/own-turn forecast,
отмена с точным refund и подтверждение оплаты. Есть desktop/mobile.

AI после потребности во флоте рассматривает доступный terraform при
фактическом ограничении роста текущей K и свободном производстве.
Это bounded heuristic по собственной view, не обещание оптимальности.

Историческая приёмка Н11: save13/rules10, snapshot8/tree7/baseline9.
Н12 расширил этот же FIFO [refit](CAMPAIGN_EQUIPMENT_REFIT.md):
текущие save14/rules11/snapshot9/tree8/baseline10/ShipDesign3.
Map3 не изменён; прежние форматы отвергаются без миграции.

## Приёмка

Регрессии [campaignTerraforming](../tests/campaignTerraforming.test.ts):
оплата/нехватка двух валют, exact/±1 прогресс, FIFO/нет двойных очков,
pause/refund0/partial/перед завершением/cap, запреты, capture на последнем
шаге, AI и paid save/next oracle. Общая suite3575/68, strict/build174.
Baseline18 six-world repeat/checkpoint и bounded40/25616 окон прошли.
Actual Chromium CSS1280×720/390×844: оплаченные исследования/основание,
ship FIFO→terraform start/cancel/restart/progress, actual reload и full
next oracle, completion и второй actual reload. Один canvas,0 page errors.
Подготовка scene-командами и событиями кнопок, не полный mouse E2E/quota/FPS.
