# 13 — Н12: технологические варианты, объём и платное переоснащение

- Дата: 2026-10-25.
- Статус: выполнено в согласованных границах.
- Основа: [аудит10](10-n11-n12-readiness.md), [подготовка11](11-n11-n12-preparation.md),
  [приёмка Н11](12-n11-terraforming.md).

## Результат

[Контракт Н12](../../docs/CAMPAIGN_EQUIPMENT_REFIT.md) фиксирует исполненную
модель и числовые решения пользователя:

- ShipDesign3 с обязательным installed technologyVariant, отдельным
  equipment-volume и общим расчётом/валидатором.
- Компактность V×0,8/cost×1,25 после paid исследования4000; не меняет
  массу, cargo, слоты, боевые ratings или старые оплаченные snapshots.
- Preset exemption убран; direct save/enqueue/refit и редактор используют
  одинаковые физические/research gates.
- Refit того же корпуса: quote/предоплата/общий FIFO, ship reservation,
  cancel/refund, capture/destruction и применение после настоящего боя.
  Актуальные HP/ammo/fuel сохраняются по принятому правилу без лечения.
- Campaign editor расширен без второго входа, full quote не скрывается
  длинным именем, есть desktop/mobile, progress/wait/pause/cancel.
- AI строит compact внутри bounded бюджета; auto-refit намеренно нет.
- Free yard/library и мирные nested saves обновлены согласованно,
  legacy readers/migrations/fallback удалены без удаления старых bytes.

## Форматы

Conquest14/rules11; snapshot9/rules9/tree8; baseline10; ShipDesign3/library3,
новый library key orion_shipyard_v3. Мирные codecs state4/run5/match6 rules2,
общий manual slot прежний. Map3 и военные цели не менялись.

Часть библиотеки/мирных codecs и связанных тестов реализована отдельным
агентом с ограниченным scope; интегрирована и проверена общим suite.
Никаких commit/push не выполнено, зависимости игры/lockfile не менялись.

## Проверки

| Проверка | Результат |
| --- | --- |
| Полный `yarn test` после финальных UI-правок | 3791 тест/69 файлов прошли |
| `yarn typecheck` | strict browser/CLI/tests прошёл |
| `yarn build` | прошёл,173 модуля; прежний chunk warning >500kB |
| Целевые scene/refit/terraform | 74 теста/3 файла прошли |
| Новый campaignRefit | 11 тестов, включая реальный бой с уничтожением на границе completion |
| Baseline10 | 18 six-world paid repeat/checkpoint и bounded40/25616 окон прошли |
| Chromium CSS1280×720 | 1canvas,20 активных controls, min14px/44px,0 page errors |
| Chromium CSS390×844 | 1canvas,14 активных controls, min14px/44px,0 page errors |
| Документы | 59 новых относительных ссылок, YAML2 навыков и diff-check прошли |

Браузерный оплаченный цикл на обеих раскладках:
исследования → кампанийный редактор → свой standard project → paid order/
deploy → сохранённый compact target с длинным именем80 → настоящий pointer
к refit control, physical ESC/cancel picker → повторный start/предоплата →
progress1 → удаление каталожного чертежа → actual save/reload/load →
полное state и next-command oracle → completion с теми же operations/fuel →
перелёт → настоящий кампанийный battle resolver → actual save/reload/load.

Отдельно на каждой browser-сессии: free yard переключает variant, ставит
копию, сохраняет library3 и проверяет persistence после reload. Мирный
MainScene на1280×720 оплатил queued design3, записал save6/rules2; actual
reload/load и полный match/next-command oracle совпали.

Кампанийная подготовка выполнялась обычными scene-командами/действиями
редактора, не инъекцией населения/казны/исследований/ship state. Pointer и
physical ESC проверены отдельно от программных событий кнопок.
Free legacy layout не объявляется новой адаптивной версткой.

## Исправленные расхождения и ограничения

- Старые тесты preset exemption и v1/v2 migration изменены под явно
  согласованный контракт отказа; другие бюджетные/codec/lifecycle/paid
  проверки сохранены. Это намеренная смена поведения, не совместимость.
- Диагностические service/боевые fixtures переведены на физически и
  технологически допустимые компоновки; volume validator не ослаблялся.
- Один battle fixture первоначально давал врагу другую ближайшую цель;
  изолирован1v1 для проверки именно уничтожаемого refit ship.
- Первые browser-попытки не подтверждали dirty select и использовали
  desktop project control на mobile; сценарии исправлены и повторены.
- Финальный strict обнаружил неиспользуемый старый preset import;
  удалён, strict/build повторены успешно.

Полная baseline58, универсальный AI-баланс, natural FPS, реальная quota,
physical touch hardware и полный mouse-only E2E не измерены.
Н13–Н20 этой задачей не реализованы.
Проверка всех старых ссылок обнаружила исторический отсутствующий
reports/2026-09-07/plan.md в прежних документах; этот несвязанный долг
не исправлялся. Новые ссылки проверены отдельно, без выдачи всей
исторической документации за полностью исправленную.

## Навыки и следующий шаг

Актуализированы orion-project/orion-ship-design: актуальная версия, общая
очередь/формулы/guards/тесты, отсутствие legacy readers и no-auto-refit AI.
Журнал и дорожная карта синхронизированы. Далее допустимы Н13/Н14/Н15
по их прямым предпосылкам, без автоматического закрытия будущих этапов.
