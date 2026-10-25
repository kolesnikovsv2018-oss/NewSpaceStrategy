# Н13 — исследуемая тактика

## Контракт

Подтверждённый пользователем стартовый баланс:

| Вариант | Эффективные параметры | Масса / объём / цена | Наука |
| --- | --- | --- | --- |
| high-thrust engine | тяга×1,25, maxSpeed×1,10, движение×1,35; генерация прежняя | ×1,20 / ×1,20 / ×1,30 | 3000 после engineering |
| focused beam | damage×1,20, range×1,25, accuracy+0,05 cap1, fireRate×0,80 | из ratings / ×1,20 / из ratings×1,25 | 4000 после engineering |
| rapid projectile | fireRate×1,25, damage/range×0,90, прежние accuracy/ammo | из ratings / ×1,20 / из ratings×1,25 | 4000 после ordnance |
| composite armor | armor×1,25, projectileResistance+0,10 cap1, beamResistance−0,05 floor0 | ×1,15 / ×1,10 / ×1,30 | 3500 после support |
| capacitor shield | capacity×1,30, regen×0,80, delay+0,5с | ×1,15 / ×1,20 / ×1,30 | 4000 после support |
| reinforced hull | HP×1,20, прочие лимиты/батарея прежние | масса корпуса×1,15 / прежний / цена корпуса×1,30 | 4000 после support |

Engine/armor/shield multiplies относятся к базовому расчёту исходного
компонента. Оружейные масса/энергия/цена рассчитываются из effective ratings.
Каждая ценовая надбавка округляется вверх после обычного базового расчёта.
Compact Н12 применяется затем: V×4/5, cost×5/4 ceil; боевые ratings
повторно не меняются. Объём сравнивается в точных десятых.

`tacticalVariant` зависит от kind; обычный variant — standard, службам
не назначаются боевые варианты. `hullVariant` независим от hullId.
Исходные numeric bands проверяются до преобразования. Эффект применяется
ровно один раз, runtime читает закреплённый ShipStats, не completed research.
Недопустимые effective caps отвергаются, кроме перечисленных ratio caps.

## Разгон и энергия

Только проектный путь: a=effectiveThrust/полная масса с грузом,
vNext=min(v+a×dt,vMax). Сначала оплатить шаг, затем сдвинуться на
vNext×dt. Повторный выбор цели не обнуляет скорость. Stop мгновенный,
без инерции; смена массы ограничивает скорость, не разгоняет бесплатно.
Legacy сохраняет прежнее движение. Щит платит3ЭЕ за восстановленный HP.
Fixed step0,05с/предел120с, sequential damage и opt-in правила прежние.
Стратегические дальность/fuel/arrival и карта не меняются.

## Snapshots и переоснащение

Unlock не меняет старые чертежи/orders/completed/ships/transit/operations.
New build либо [платный refit](CAMPAIGN_EQUIPMENT_REFIT.md).
Refit сохраняет абсолютный HP/fuel; снижение maxHP ниже currentHP
запрещено. Projectile ammo переносится только для того же слота с
одинаковыми effective ratings. Compact-only сохраняет ammo.
До post-encounter completion сражается старый design; destruction/capture
отменяют работу без refund. Щит/энергия/cooldown между боями не сохраняются.

## UI, AI, версии и приёмка

Свободный и кампанийный редакторы используют общие формулы. Кампания
проверяет research и физические ограничения на каждом входе.
Понятные effective ratings и nominal DPS не обещают реальный DPS через
защиту/критику/истощение энергии/ammo. Bounded AI использует те же quotes,
cooldown helper и энергобюджет; auto-refit не вводится.

Новые форматы: ShipDesign4/library4; Conquest15/rules12;
snapshot10/rules10/tree9/baseline11; мирные state5/run6/match7 rules3.
Отдельная версия design-combat-v1 фиксирует формулы/разгон, а campaign-v2
по-прежнему задаёт инициативу/RNG. Только current readers без миграций,
старые bytes не удаляются. Map3 прежний.

Приёмка: независимая арифметика, range boundaries/caps/energy/ammo,
fixed-seed full results/deltas/1×2×4×, реальный resolver/timeout,
paired equal-cost роли с реальными quotes/side-bias/CI, paid research→
build/refit→battle→save/reload/next oracle в tests и настоящем браузере.
Реализация и приёмка: [отчёт16](../reports/2026-10-25/16-n13-combat-technologies.md).
AI-score использует ограниченную оценку времени сближения и общего
энергобюджета на120с, не вторую симуляцию попаданий/восстановления щита
и не вероятность победы. Equal-cost серии используют реальные проекты
и quotes; баланс подтверждён только в измеренных составах/seed.
