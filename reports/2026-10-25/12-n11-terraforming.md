# 12 — Н11: платное терраформирование

- Дата: 2026-10-25.
- Статус: выполнено в согласованных границах.
- Основа: [аудит10](10-n11-n12-readiness.md), [подготовка11](11-n11-n12-preparation.md).

## Результат

[Контракт Н11](../../docs/CAMPAIGN_TERRAFORMING.md) описывает реализованные
команды, общий FIFO, цену/науку, refund/capture, S0/завершение после боёв,
own-view/AI/UI/save и неизменность initial map/военных целей.
Только toxic→habitable; barren и новые цели победы не включены.

Представление очереди уточнено относительно плана: ship records сохранены
в прежнем типизированном списке, terraform — tagged projects. Один helper
объединяет их по общим ID. Второго порядка или промышленного pool нет;
так не потребовался синтетический design для планетарной работы.

Актуальны save13/rules10/snapshot8/tree7/baseline9; map3/ShipDesign2 прежние.

## Проверки

- Полный yarn test:3575 тестов/68 файлов.
- yarn typecheck, yarn build174: прошли; прежний chunk warning.
- Baseline18 шестимировых партий с repeat/checkpoint и bounded40/25616
  окон: прошли, executor-error отсутствуют.
- Новый campaignTerraforming:13 регрессий, включая exact/±1, оплату,
  refund/cap, S0, FIFO/no-double-spend, capture на завершении, AI.
- Actual Chromium/Phaser CSS1280×720/390×844: обычные scene-команды
  заработали исследования/ресурсы, основали toxic; ship FIFO→paid start/
  cancel/restart→progress; actual save/reload/load равен полному state/
  next-command oracle; completion и второй actual reload совпадают.
  Один canvas,0 page errors. События кнопок, не полный mouse E2E.
- Первые проверки выявили устаревшие version assertions/YAML order,
  перекрытие pager новым control и неверный код оплаты; исправлены.
  Первая browser reload-попытка не подтвердила save-dialog; повторена с
  явным подтверждением. Это ошибка сценария, не скрытая удачная проверка.

Обновлены непосредственно связанные документы, orion-project и
orion-ship-design. Н12 ещё не реализован. Полная baseline58/quota/FPS
не измерены; следующий шаг — общий effective design/миниатюризация/refit.
