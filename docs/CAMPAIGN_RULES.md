# Н04 — библиотечный контракт эффектов и rules snapshot

Н04 предоставляет чистый [API](../src/domain/campaignRules.ts), строгие схемы и
[JSON-пример/fixture](../src/domain/fixtures/rules-default.json).
Это **не игровые бонусы Conquest**. Новая библиотека не импортируется сценами,
исследованиями, расчётом кораблей или военным save; их поведение и форматы сохранены.
Н06 и последующие этапы подключают минимальных реальных потребителей вместе с изменением игровой схемы.

## Формат и граница

`format=orion-rules-snapshot`, `schemaVersion=1`, `rulesVersion=1` — один актуальный
формат отдельной библиотеки. Обязательны ID снимка, `treeId/treeVersion`,
`tablesId/tablesVersion`, `policyId/policyVersion`, реестры `handlers/policies` и `effects`.
Поддерживаются только `research-tree-v2`, `campaign-tables-v1`, `component-bands-v1`;
это ссылки на контракт, не встроенное дерево/игровой state и не проверка наличия внешнего дерева по ID.
ID — 1–64 ASCII символа `a-z`, `0-9`, `-`, без trim/coercion.

`validateRulesSnapshot`/`parseRulesSnapshot` копируют и проверяют полный объект.
`encodeRulesSnapshot(unknown)` возвращает JSON-строку; `decodeRulesSnapshot(unknown)`
принимает только JSON-строку и возвращает независимый snapshot.
Ошибки codec — `RulesError` с `INVALID_JSON` или `INVALID_RULES`, без частичного результата.
Прямые схемы предоставляют подробные Zod issues.
Лишние/отсутствующие поля, иные версии, неизвестные targets/units/operations/handlers/policies,
необъявленный обработчик/политика эффекта, дубли ID отвергаются. Нет миграций,
fallback, загрузки YAML-скриптов или исполнения `formula`.

`RULES_FIXTURE_CATALOG.default` содержит тот же JSON-пример, который проверяют
`createDefaultRulesSnapshot`/`buildRulesFixture` и тесты. Snapshot не ссылается на вложенные объекты каталога.
Каталог — источник данных, не mutable текущие правила партии.

## Виды эффектов и допустимые пары

Каждый эффект явно задаёт `kind/id/target/scope/unit/operation/value/cap/stackingGroup/activationPhase/handler`.
`policy/description` необязательны, кроме обязательной `policy` у policy-reference.
`cap=null` явно означает отсутствие верхнего предела.

| Target | Scope | Units | Handler |
| --- | --- | --- | --- |
| ship-speed | ship | percent, ratio, flat | ship-stats |
| ship-growth | planet | percent, ratio | facility-output |
| ship-shield | ship | percent, flat, count | ship-stats |
| weapon-damage, weapon-range | component | percent, flat | component-stats |
| facility-output | planet | percent, flat | facility-output |
| fleet-capacity | fleet | percent, count | fleet-capacity |
| planet-habitability | player, global | percent, points | campaign-policy |
| component-unlock | component | count | component-stats |

- `modifier`: числовой эффект. `multiply` принимает только percent/ratio; отрицательный
  value разрешён только для add. Value конечен в ±1 000 000, cap конечен в 0..1 000 000
  или null; count требует целых value/cap.
- `capability`: fleet-capacity с add/set либо component-unlock с set 0/1 и cap=1.
  Целые value/cap в 0..100 000; отдельный `applyCapabilityEffects` выполняет счёт/открытие.
- `policy-reference`: planet-habitability/global или player, points/set,
  campaign-policy, явная зарегистрированная policy. Числа конечны и неотрицательны.
  Это описание версии политики, **не подстановка числа в характеристику**.

Несовместимые target/scope/handler отвергаются, даже если каждое поле отдельно известно.
`ship-growth` — лишь описание будущего роста; библиотека не определяет единицу населения,
цену технологии или баланс и не меняет принятую [границу времени Н01](CAMPAIGN_TIME.md).

## Математика

`applyNumericEffects` принимает только modifiers одного target/scope и не меняет вход.
База должна быть конечной и неотрицательной. Это низкоуровневая арифметика,
не подтверждение наличия игрового исполнителя target.

Канонический порядок групп:
`base → economy → engineering → combat → science → special`.
Внутри группы эффекты сортируются по ASCII ID (без localeCompare). Для каждой группы:

1. Зафиксировать её входную базу B (результат предыдущей группы, **без округления**).
2. Выполнить единственный set; несколько set в одной группе дают явный отказ.
   Для percent/ratio set означает B × value, для абсолютных units — value.
3. Суммировать add: percent/ratio даёт B × value, абсолютная unit — value.
   Все аддитивные значения группы используют одну B.
4. Умножить `(результат set или B + сумма add)` на произведение множителей:
   percent → `1 + value`, ratio → `value`.
5. Применить min/max/операцию cap в ASCII-порядке ID. Их value переводится
   относительно B для percent/ratio; min и cap — верхняя граница, max — нижняя.

Два add 0.1/0.2 одной группы при базе 100 дают **130**, а два percent multiply —
**132**. Перестановка объектов с теми же ID не меняет результат. Между группами
входная B меняется: flat +10 в base, затем ×2 в engineering даёт 220;
×2 в engineering, затем flat +10 в special даёт 210.

Отдельное поле `cap` — окончательный верхний предел: для percent/ratio это
максимальный относительный прирост от **исходной** базы (`base × (1 + cap)`),
для абсолютных units — абсолютный предел результата. Несколько caps используют минимум.
Поэтому cap=0.3 при базе 100 ограничивает результат 130, а cap=0.25 — 125.
Операция cap и поле cap различаются: первая ограничивает свою группу, второе — окончательный результат.

Округление выполняется только в конце, `Math.round`, без epsilon и промежуточных
округлений. Окончательный целый результат не превышает `floor(final cap)`.
Отрицательный/нечисловой/бесконечный результат — отказ, не clamp к нулю.

`applyRulesSnapshotToStats` группирует все активные modifiers одного target перед
расчётом, не применяет их по одному. Базовое поле должно существовать, иначе ошибка
(нет подстановки нулей). Поддерживаемые ключи: speed, shield, damage, range, output, capacity.
Capability/policy-reference и будущий growth не превращаются в stats молча.

## Активация и однократность

`activateRulesEffects(snapshot, ids, consumers)` проверяет весь snapshot до выбора
и копирует выбранные effects. Неизвестный/дублирующийся ID — отказ.
Наличие известного handler в описании **не означает**, что он исполним.

- `library-numeric-v1`: чистые вычислители перечисленных выше stats.
- `library-capability-v1`: чистый счётчик fleet-capacity и бинарный component-unlock.
- У policy-reference и ship-growth нет runtime-потребителей.
- `CURRENT_GAME_RULES_CONSUMERS=[]`: никакой эффект новой библиотеки не активен в Conquest.

`always` применяется вместе с явно выбранной фазой; отсутствие phase — только always.
`on-turn-start/on-build/on-research/before-combat/after-combat` — метки,
не scheduler или новый кампанийный pipeline.

Повтор ID в наборе либо пересечение с `appliedEffectIds` отклоняется
(`DUPLICATE_APPLICATION`) до расчёта. `applyNumericEffectsWithReceipt` возвращает
`value` и новый независимый список применённых ID. Следующий component/stats pass
обязан передать этот список, например в `applyRulesSnapshotToStats` через options.
Это чистый ledger одной цепочки расчёта, не module-global cache и не сетевая дедупликация:
повтор независимого вычисления по исходной базе детерминированно допустим.

## Матрица действующих producers/consumers

| Контракт | Текущий формат | Producers | Consumers/readers | Связь с Н04 |
| --- | --- | --- | --- | --- |
| Исследования Conquest | tree2 / component-bands-v1 | campaignResearch, актуальный ResearchTreeYaml, research-default.yaml | Conquest/research availability/save5 | Без новых полей/эффектов; прежние диагностические tree1 API вне Н04 |
| Военная кампания | save5 / rules3 | encodeConquestSave, ConquestSaveManager | decodeConquestSave, ConquestScene | Формат неизменен; не содержит новый rules snapshot |
| Новая библиотека | rules snapshot1 / rules1 | encodeRulesSnapshot, JSON fixture/API | decodeRulesSnapshot, typed math/activation/tests | Единственная новая граница; только текущая версия |
| Мирные/старые библиотечные save API | прежние самостоятельные форматы | существующие кодеки | прежние readers | Не изменялись; не запасной reader нового snapshot |

Будущие номера schemas не резервируются. При подключении Н06 меняются только
действительно необходимые игровые поля и их producers/consumers/fixtures в одном этапе.

## Проверки

[campaignRules.test](../tests/campaignRules.test.ts) проверяет импорт реального Zod 3 union,
strict codec/версии/fields/пары, аддитивный и multiplicative oracle, группы, cap точно/+1,
конечное округление, scopes, ledger component→stats, фазы, capabilities и копии.
Текущие research/save регрессии выполняются отдельно:

```sh
yarn test tests/campaignRules.test.ts tests/campaignResearch.test.ts tests/conquest.test.ts
yarn typecheck
yarn build
```

При Snap startup timeout в sandbox-shell используйте штатную shell task VS Code.
Это выполнение тем же Yarn/toolchain в терминале VS Code, не исправление системных профилей Snap.
Не устанавливайте второй Node/package manager и не меняйте lockfile ради этой проверки.
