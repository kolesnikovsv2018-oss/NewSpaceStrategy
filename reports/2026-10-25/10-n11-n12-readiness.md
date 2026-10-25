# 10 — Готовность к Н11/Н12

- Дата: 2026-10-25.
- Основа: `f0fb7d8`, исходное рабочее дерево чистое.
- Статус: аудит завершён; реализация этапов не начата.

## Вывод

Предпосылки Н05а/Н07–Н10 подтверждены кодом и проверками. Проект готов
к началу Н11/Н12 после ограниченной подготовки; переписывать стек не нужно.
Терраформирования, equipment-volume и refit в исходной базе нет.

## Необходимые доработки

| ID | По коду | Требуемая работа |
| --- | --- | --- |
| П1 | [Подбор вариантов](../../src/ui/ShipBuilderPanel.ts) вызывает бросающий installComponent вне обработчика ошибки | Независимый кандидат, общий validator, явный отказ без изменения черновика; regression массы/размера/объёма |
| П2 | [Выпуск](../../src/domain/campaignOutput.ts) отдаёт все очки ship-head | Единый FIFO ship/terraform/refit, один распределитель, без двойных очков |
| П3 | [Ход](../../src/domain/conquest.ts) рассчитывает развитие до encounters | Разделить прогресс и применение новых завершений; после capture/destruction повторно проверить owner/source/ship |
| П4 | [ShipDesign](../../src/domain/shipDesign.ts) не имеет equipment-volume/compact | Общий актуальный effective design, отдельный объём и вариант, все producers/consumers |
| П5 | [Research access](../../src/domain/campaignResearch.ts) даёт точным пресетам numeric exemption | В Н12 убрать обход: все campaign проекты проходят одинаковые research/физические ограничения |
| П6 | [Операции](../../src/domain/campaignOperations.ts) содержат HP/ammo, но нет refit lifecycle | Quote, очередь, ship-lock, отмена/потери, перенос текущих HP/ammo/fuel без бесплатного восстановления |
| П7 | [Библиотека](../../src/utils/ShipDesignManager.ts) и мирные codecs читают старые форматы | Согласованно обновить общий design/library и nested saves; только текущие версии без миграций/fallback |

П1 — существующий дефект обработки отказа, статически подтверждённый:
непомещающийся модуль способен прервать создание picker. Остальное —
не отсутствующие предпосылки, а необходимые расширения самих этапов.

## Согласованные решения

Пользователь подтвердил:

- Н11: своя toxic-колония с P>0 → habitable; barren/обратные переходы вне задачи.
  Узел6000 после biosphere/toxic-adaptation; предоплата300/150;12000 очков.
- Общий FIFO, максимум3 ожидающих работ/колонию, один head/no spillover.
  Cancel возвращает floor(cost×unusedPoints/totalPoints); capture без возврата.
- Выпуск/рост по S0; completion сам не меняет P/остаток. Initial map/latest-map
  и состав военных целей прежние.
- Н12: миниатюризация4000 после engineering, equipment-volume×0,8,
  цена компонента×1,25, масса/мощность/боевые ratings прежние.
- Объёмы beam20/projectile30/engine35/shield25/armor20/mining30/repair20/
  scanner15/cargoExpansion20. Бюджеты fighter60/corvette100/frigate140/
  destroyer180/cruiser220/battleship300/colonizer100.
- Campaign preset exemption удаляется; free yard не получает research cap.
- Refit того же корпуса: свой стоящий корабль без группы в своей колонии.
  По каждой валюте ceil(25% newCost)+max(0,newCost−oldCost); очки
  max(1,ceil(refitCredits/10)). До завершения старое оснащение и запрет
  полёта/группировки/повторного refit.
- HP/fuel не повышаются; newMaxHP<currentHP запрещён. Ammo переносится
  только для того же projectile/слота/ratings, допускается compact-only
  замена; новый/заменённый projectile пуст. Оплаченные службы отдельны.
- AI строит compact в bounded бюджете, auto-refit отсутствует.
- Один актуальный общий формат, включая демонстрационную библиотеку
  и затронутые мирные saves; старые bytes сохраняются, миграций нет.

## Проверки

| Проверка | Результат |
| --- | --- |
| Planetology/colony effects/research points/projects/output/shipDesign/library | 108 тестов/7 файлов |
| Conquest/AI/scene/research/rules/galaxy/baseline/DesignedShip/yard | 252 теста/9 файлов |
| Всего непересекающихся целевых наборов | 360 тестов/16 файлов прошли |
| yarn typecheck | browser/CLI/tests strict прошёл |
| yarn build | прошёл,174 модуля; прежний chunk warning >500kB |
| git status /diff --check | чисто до реализации |

Каждый запуск ограничен внешним timeout180s; прерываний не было.
Полный suite, новый CLI baseline и настоящий браузер не запускались.
Scene/baseline Vitest не являются browser E2E или новой baseline-матрицей.

## Навыки и следующий шаг

Проверены orion-project/orion-ship-design; их верхняя отправная точка
соответствует Н10. Процедуры maintenance/report загружены.

Порядок: П1/подготовка → Н11/самостоятельная приёмка → Н12/самостоятельная
приёмка. Н11/Н12 этим аудитом не закрыты. Несвязанный долг и Н13–Н20
не входят. Обновлять навыки/журнал и отдельный отчёт после каждого этапа.
