# 16 — Н13: исследуемые тактические характеристики

- Дата: 2026-10-25.
- Статус: выполнено в согласованных границах.
- Основа: [аудит14](14-n13-readiness.md), [подготовка15](15-n13-preparation.md),
  [задание Н13](../../plans/tasks-2026-10-09/n13-combat-technologies.md).

## Цель и результат

Предпосылка Н12 проверена, необходимые документационные доработки
выполнены до внедрения. Н13 реализован в единственном Conquest:
исследуемые двигатели, два типа оружия, броня, щиты и усиленный корпус
меняют настоящий DesignedShip/BattleManager resolver.

Коэффициенты/цены, реальный разгон и current-only форматы подтверждены
пользователем. Точный [контракт](../../docs/CAMPAIGN_COMBAT_TECHNOLOGIES.md)
содержит таблицу эффектов и порядок округления.

## Изменения и инварианты

- Kind-specific tacticalVariant отделён от standard/compact. HullVariant
  не добавляет слот и не переписывает общий HULLS.
- Общий calculateComponent выдаёт effective ratings без variant markers;
  ShipStats и runtime не применяют бонус повторно. Numeric bands исходные,
  effective caps/физика проверяются общим validator на всех входах.
- Оборудование занимает точные десятые объёма, цена округляется по
  принятому порядку. Повышенная тяга не создаёт генерацию.
- Канонический разгон a=тяга/полная масса с грузом, vNext=min(v+a×dt,vMax),
  сдвиг vNext×dt после оплаты. Retarget сохраняет скорость, stop без
  инерционного торможения. Legacy/strategic travel прежние.
- Research unlock не меняет прежние snapshots. Refit сохраняет абсолютный
  текущий HP/fuel, новые HP не лечат; ammo переносится только при равных
  effective ratings того же projectile slot. Compact-only сохраняет ammo.
- Общий FIFO, reservation, cancel/refund, старый design в бою до
  post-encounter completion, destruction/capture без refund сохранены.
- Кампанийный и свободный редакторы используют те же формулы, страницу
  «Характеристики» и общий validator. Кампания сохраняет research rights.
- Bounded AI включает shield/hull/новые оружейные роли в≤47 combat
  candidates плюс colonizer; общий предел24 commands. Score учитывает
  разгон, quantized cooldown, real quotes, ammo и общий энергобюджет.
  Это ограниченная эвристика без второй симуляции попаданий/regen;
  auto-refit намеренно не добавлен.
- Paired runner принимает design snapshots наряду с factory compositions,
  с тем же настоящим resolver и common lineup RNG streams.
- Fixed step0,05с,120с, sequential damage, initiative policy и opt-in
  formation/cover/retreat, map3 и прежние военные цели не менялись.

## Форматы

| Формат | Текущая версия |
| --- | --- |
| ShipDesign /library | 4 /4; `orion_shipyard_v4` |
| Tactical formulas /movement | `design-combat-v1` |
| Conquest save /rules | 15 /12 |
| Rules snapshot schema /rules | 10 /10 |
| Research tree /baseline | 9 /11 |
| Мирные state/run/match codecs; rules | 5/6/7;3 |
| Map /initiative policy | 3 /campaign-v2, прежние |

Только текущие readers, без миграций/fallback. Старые library keys не
удаляются менеджером. Tactical version обязательна в design, Conquest
и историческом battle report; неизвестная версия явно отклоняется.
Мирный gameplay не расширен, nested design/codecs обновлены вместе.
Никаких изменений зависимостей/lockfile, commit или push.

## Проверки

| Проверка | Фактический результат |
| --- | --- |
| Предварительный аудит | 143/9 и724/20, пересекающиеся наборы; strict/build173 |
| Финальный полный `yarn test` | **3818 тестов/70 файлов прошли** |
| Последний связанный набор | 70/4 прошли |
| Усиленные effective/paired/render assertions | 30/2 прошли |
| `yarn typecheck` | strict browser/CLI/tests прошёл |
| `yarn build` | 173 модуля; прежний warning chunk >500kB |
| `git diff --check` | прошёл после удаления trailing whitespace bulk-fixtures |
| Документация/навыки | YAML3 навыков и11 относительных ссылок новых отчётов/контракта прошли |
| Baseline11 | 18 paid6 repeat/checkpoint,4 boundary, bounded40/25616 окон |
| CSS1280×720 и390×844 | actual canvas,1canvas; страница характеристик min14px/44px |
| Free yard/library4 и мирный save7 | actual save/reload, полный следующий мирный oracle |

Новые14 тестов campaignCombatTechnologies проверяют независимые числа,
effective caps/range boundaries, реальные ускорение/груз/энергию,
damage/armor/shield recovery, HP/ammo refit, paid research/build/refit/
battle/save, bounded candidates и paired roles.
Visuals дополнительно сравнивает полный результат advanced design при
deltas25/50мс и1×/2×/4×. Прежние legacy/codec/rollback/timeout/own-view/
generated-map regressions сохранены.

Наборы пересекаются, их числа не суммируются. Длительные команды
ограничивались внешним wall-clock deadline.

### Реальные paired измерения

Технологические диагностические пары: по30 unique seeds,60 настоящих боёв,
common mirrored streams. Оба состава каждой пары имеют одинаковые
реальные quotes; выравнивание оплачивается изменением параметров двигателя,
не подставной ценой. Это допустимые free-design snapshots, не доказательство
достижимости каждого diagnostic tuning внутри campaign numeric bands.

| Пара | Цена обоих, кр./мин. | Mean first score | Approx95% CI | Side bias | Timeout |
| --- | --- | --- | --- | --- | --- |
| Обычный /тактически улучшенный | 385/22 | 0,4333 | [0,253;0,614] | 0 | 0 |
| Композитная броня /ёмкостный щит | 381/23 | 1 | [1;1] | 0 | 0 |
| Улучшенный /скорострельный с лучом | 385/29 | 0,4667 | [0,285;0,648] | 0 | 0 |

Point CI[1;1] и нулевой observed bias ограничены этими образцами:
не доказывают вероятность1, отсутствие систематического bias вообще
или универсальное превосходство технологии.

Прежняя factory matrix по100 seed изменилась из-за согласованного разгона:

| Прежняя роль | Score | Approx95% CI | Bias |
| --- | --- | --- | --- |
| near | 0,67 | [0,586;0,754] | 0,02 |
| capital | 0,49 | [0,398;0,582] | −0,04 |
| escort | 0,755 | [0,677;0,833] | −0,01 |

Все600 боёв без timeout, actual credits/minerals gap<1%.
Ожидания изменены под измеренную новую версию: бывший capital advantage
стал близок к паритету, бывший near — к преимуществу эскорта.
Старые seed-исходы не возвращались ослаблением формул.

### Baseline

18 шестимировых оплаченных партий завершились за27–35 окон:
current-ai27–29, research-first30–31, production-first27–35.
Повтор и продолжение с актуального checkpoint совпали целиком.
Четыре boundary и40/256 по16 окон также прошли repeat/roundTrip.
Supply-boundary дал по8 настоящих tactical timeouts на каждый mirror;
стратегический timeout не объявлен победой.
Полная матрица58 заново не запускалась.

### Настоящий браузер

На обеих фактических CSS-раскладках:

1. Меню → новая generated6 карта с записью до старта.
2. Обычными scene-командами оплачены исследования; без подстановки
   казны, research, населения, ships или operations.
3. Кампанийный редактор сохранил corvette; оплачен order, FIFO, deploy.
4. Через настоящий picker выбраны high-thrust/focused, reinforced hull;
   target сохранён, просмотрены эффективные характеристики.
5. Настоящий pointer к странице характеристик/refit, physical ESC
   и отмена без списания. Quote не скрыт80-символьным именем.
6. Paid refit143/8,15points, industry1 → progress1 → actual save15/
   reload/load → полное state и next-command oracle.
7. Возврат industry1000 → completion с HP500, а не новым max600,
   прежним fuel → send → настоящий campaign battle, уничтожен enemy
   colonizer → fuel2 → replay/pause без мутации → save/reload/full next.

Desktop-бой произошёл на33, mobile — на27 в независимых оплаченных
сценариях. Это не ручной mouse-only E2E: подготовка выполнялась обычными
scene-командами и событиями controls; pointer/ESC проверялись отдельно.
Native prompt в интегрированном браузере недоступен: long-name ввод
проверен контролируемым ответом prompt с восстановлением функции,
не выдаётся за native-dialog E2E.

Browser zoom1,5 учитывался фактически: viewport1920×1080 дал
inner/canvas1280×720,585×1266 дал390×844. Первая попытка1280×720 дала
CSS853×480 и не засчитана целевой приёмкой. Первый черновой browser
контекст был потерян при HMR; окончательные циклы повторены с
сохранёнными oracle/checkpoints.

Отдельно: free yard сохранила focused+compact в library4, actual reload
сохранил документ; мирный MainScene оплатил256/16 за этот проект, save7/
rules3, actual reload совпал с full match и next-command oracle.
Удалены только именованные тестовые local/sessionStorage ключи,
после очистки оба хранилища пусты; временный dev server остановлен.

## Найденные и устранённые расхождения

- Старые version assertions/raw JSON/helper envelopes и direct typed
  fixtures обновлены без ослабления guards или возврата readers.
- Старые проверки мгновенной скорости адаптированы только для canonical
  пути; legacy сохранил прежние assertions.
- Новые shield/rapid/hull AI-кандидаты первоначально отсеивались из-за
  перегруженного «всё сразу». Разведены законные роли внутри прежнего
  бюджета, проверено наличие каждого вида.
- Новые diagnostic fixtures initially превышали volume/power; исправлена
  компоновка, не физический validator.
- Избыточные введённые повторный component calculation/parse привели
  к timeout baseline-теста. Устранены дубли: standard caps уже проверены
  исходной schema, effective caps проверяются для advanced. Deadline
  не повышался, полный suite затем прошёл.

## Навыки, ограничения и следующий шаг

Актуализированы project/ship-design/combat: текущие версии, единственная
effective граница, разгон, refit, tests/baseline/browser и измеренные
новые role results. Связанные контракты, roadmap и журнал синхронизированы.

Не заявлены full58, natural FPS, реальная quota, physical touch hardware,
универсальный баланс и полный mouse-only E2E. Н14–Н20 не реализованы.
Далее доступны Н14/Н15 по прямым предпосылкам.
