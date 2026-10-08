# 24 — Предложение numeric variant-профилей Conquest

- Дата: 2026-10-08
- Пункт плана: S4.11c
- Статус: рекомендация подготовлена; caps и новая save policy не реализованы, требуется согласование

## Цель и границы

Предложить численные ограничения вариантов компонентов внутри открытых семейств Conquest с объяснением каждого параметра. Сохранить свободную верфь и существующий `componentSchema`; не активировать caps до утверждения диапазонов и migration/compatibility policy.

## Рекомендация

Использовать factory defaults `createComponentWithId` как центр кампанийного профиля. Research variant tier хранить в версионированном снимке research tree, а не вычислять из порядка nodes или имени технологии. Предлагаемая лестница:

| Tier | Доступные изменения magnitude-полей | Ratio-поля |
| --- | --- | --- |
| Base | ±10% от factory default | ±0.05 |
| Support | ±20% | ±0.10 |
| Ordnance | ±30% | ±0.15 |
| Capital | ±40% | ±0.20 |

Новые семейства получают tier соответствующего unlock; завершение следующих уровней расширяет пределы уже доступных семейств. Значения всегда пересекаются с общими Zod schema bounds и затем проходят полную flight/battle validation.

| Семейство / параметр | Предлагаемый профиль | Зачем и особые правила |
| --- | --- | --- |
| Beam: damage | Tier magnitude band от25 | Непосредственно меняет burst/DPS и энергозатраты; ниже/выше не должен обходить power/mass validation |
| Beam: range | Tier magnitude band от500 | Меняет дальность открытия огня и движение; нужен нижний и верхний край |
| Beam: fireRate | Tier magnitude band от2 | Меняет cooldown и полную мощность; validator обязан учитывать установленное оружие целиком |
| Beam: accuracy | Tier ratio band от0.8 | Доля0..1, абсолютный offset, не процент от процента |
| Projectile: damage | Tier magnitude band от30 | Урон одного выстрела; учитывается вместе с конечным ammo |
| Projectile: range | Tier magnitude band от300 | Дальность engagement; не допускает превращения семейства в произвольный дальнобойный beam |
| Projectile: fireRate | Tier magnitude band от1.5 | Влияет на cooldown и energy-per-second |
| Projectile: accuracy | Tier ratio band от0.9 | Доля0..1, clamp по ratio schema |
| Projectile: ammoCapacity | Integer tier band от20: ±10/20/30/40% по tier | Округлять наружу до целых, минимум1; массу/цену пересчитывать из итогового ammo |
| Engine: thrust | Tier magnitude band от1000 | Влияет на movement power, speed и массу установленного проекта |
| Engine: maxSpeed | Tier magnitude band от200 | Влияет на tactical time-to-range; сохранять нижний минимум flight validation |
| Engine: maneuverability | Tier ratio band от0.7 | Доля в модели evasion; clamp0..1 |
| Engine: powerGeneration | Tier magnitude band от600 | Должна по-прежнему покрывать total peakPower проекта |
| Shield: capacity | Tier magnitude band от500 | Даёт запас beam-щита, не projectile mitigation |
| Shield: rechargeRate | Tier magnitude band от20 | Не является бесплатным: энергия и shield delay сохраняются |
| Shield: rechargeDelay | Base ±0.5с, затем ±1/1.5/2с | Отдельный additive band, min0/max60; меньшая задержка усиливает shield regeneration |
| Shield: beamResistance | Tier ratio band от0.3 | Применяется к beam only; доля0..1 |
| Armor: armorPoints | Tier magnitude band от150 | Совместно с resistance формирует diminishing-return armor model |
| Armor: beamResistance | Tier ratio band от0.2 | Не суммировать неограниченно с другими resistance; clamp0..1 |
| Armor: projectileResistance | Tier ratio band от0.3 | Отдельно от beam, clamp0..1 |
| Mining: miningSpeed | Tier magnitude band от10 | Влияет на стратегическую добычу с существующим cap/floor; не новый тактический weapon |
| Mining: efficiency | Tier ratio band от0.8 | Доля0..1 перед существующим floor/ship cap |
| Repair: repairRate | Tier magnitude band от5 | Стратегический per-command cap, не бесплатная regeneration |
| Scanner: range | Tier magnitude band от200 | UI/model currently reveals at most one lane; range не должен молча менять topology rule |
| Scanner: accuracy | Tier ratio band от0.85 | Сейчас требуется положительное значение; numeric profile не переписывает правило видимости без отдельного решения |
| CargoExpansion: bonusCapacity | Tier magnitude band от50 | Увеличивает объём, не hull cargo-mass limit |

`HullDefinition` hull HP/mass/cost/energy/scale/slots не являются редактируемыми компонентами: корпуса открываются исследованиями целиком. Derived component mass/cost/power не принимаются из проекта и пересчитываются; их caps отдельно не нужны.

## Совместимость сохранений

Предлагается новый Conquest rules version с policy ID и полным profile snapshot в каждой партии. Внешний research tree должен явно версионировать variant profiles. Старые v4/rules1 партии grandfathered: сохранять оригинальные tree/design snapshots, не обрезать существующие ships/orders и не проверять их против новых caps; новые enqueue в такой партии следуют старому policy. Новые campaigns используют profile-aware rules. Не мигрировать молча числа проекта или исследовательские snapshots.

## Проверки

| Проверка | Результат |
| --- | --- |
| Текущая base/default значения и component schemas | Просмотрены в `shipDesign.ts`, `combatPresets.ts`, `conquestAi.ts`, `campaignResearch.ts` |
| Runtime/tests | Не запускались: документальное предложение, игровых/схемных изменений нет |
| User approval | Не получено; caps/save policy не приняты и не реализованы |

## Актуализация навыков

`orion-project` и `orion-ship-design` проверены и остаются точными: numeric caps и research-policy ещё не реализованы. `orion-combat` не менялся.

## Оставшиеся вопросы и следующий шаг

Утвердить/скорректировать таблицу и grandfathered compatibility policy. Только после этого реализовывать strict external research-tree profile schema, новые rules version, domain gate для enqueue/AI, backward-save tests и paired balancing matrix. Родитель равностоимостного баланса остаётся открытым.
