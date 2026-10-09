# Н17 — несколько участников и общее расписание ходов

**Этап:** Н17. **Предпосылки:** Н05, Н16. **Статус:** задание, не реализация.  
Выполняй с [общим контрактом](00-execution-contract.md) и [основным планом](../plan-2026-10-09.md).

## Промпт и завершённый результат

Обобщи новый режим с двух сторон на утверждённый конечный диапазон P. Участники, ход, наблюдения, AI, договоры и встречи должны реально работать; простого расширения factionIdSchema недостаточно.

Опоры: [campaign](../../src/domain/campaign.ts), [campaignControl](../../src/domain/campaignControl.ts), [conquest](../../src/domain/conquest.ts), [conquestAi](../../src/domain/conquestAi.ts), [conquestBattle](../../src/domain/conquestBattle.ts), [BattleManager](../../src/entities/BattleManager.ts), [ConquestScene](../../src/scenes/ConquestScene.ts).

## Работы

1. Утверди максимальный P и минимальные размеры ручных карт. Participant IDs — стабильные ASCII ссылки из snapshot, не enum blue/red для новой policy.
2. Введи расписание: ordered participants, active index/phase, monotonic revision/turn и round. Активная сторона определяется расписанием, не parity.
3. Согласуй elimination/пропуск/observer/control takeover. Ноль колоний сам не устраняет сторону с кораблями; полный раунд и сроки договоров не должны застревать при исключённом участнике.
4. Обобщи ownership, knowledge, treasuries, research, projects, ships/fleets, limits и pair relations. Caps проверяются per faction и globally без множителя «×2».
5. Контроллеры могут быть local либо человек + несколько AI; последовательность одного bounded пакета на активного AI, один captured cancellable ticket, без рекурсивной синхронной цепочки всех сторон.
6. Обобщи encounters: три/более сторон могут присутствовать в одной системе. До кода согласуй versioned политику разрешения с реальным BattleManager: multi-faction hostile selection либо deterministic pairwise порядок. Не объявляй одновременный бой, если результат последовательный.
7. Treaty rules Н16 фильтруют допустимые противники. При coexistence/timeout захват выполняется только если все его условия соблюдены, не просто «в системе >1».
8. RNG streams привязываются к stable faction/ship IDs; порядок input arrays не даёт необоснованную инициативу. Актуальная policy должна корректно обслуживать как двух, так и несколько участников без отдельных форматов.
9. UI: выбор наблюдателя/следующей local стороны, цвета по faction metadata, own-only человек в AI mode, сообщения/standings без скрытой казны.
10. Save содержит participants/schedule/controls и полный снимок; import maps с P вне поддержанного диапазона rejected. Генератор опционален и переиспользует формат Н05.

## Приёмка и проверки

- P=2 сохраняет новую принятую двухстороннюю механику; P=3 и согласованный max имеют ровно одно начисление каждому на цикл.
- Elimination/skip/last faction/переход round и истечение договора проверены; ни один load не запускает scheduler сам.
- Человек не командует чужим AI; observers не меняют active/control.
- Три стороны в системе: разные treaty графы, уничтожение/timeout, корректные losses/operations/groups и один легальный capture.
- Перестановки массивов и зеркальные starts проверяют стабильность policy/streams в оговорённых границах.
- Save/load на каждом участнике/в пути/перед встречей равен следующему oracle; browser local+несколько AI, tests/typecheck/build.

## Не входит и независимая поставка

Без новых побед, сетевого мультиплеера и безусловных альянсных флотов. Полная многосторонняя кампания использует предыдущее условие военной победы и принятые встречи, не ждёт Н18.
