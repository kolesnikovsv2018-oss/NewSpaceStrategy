# Н13 — научное улучшение тактических характеристик

**Этап:** Н13. **Предпосылки:** Н12. **Статус:** задание, не реализация.  
Выполняй с [общим контрактом](00-execution-contract.md), [основным планом](../plan-2026-10-09.md), корабельным и боевым навыками.

## Промпт и завершённый результат

Добавь исследуемые варианты двигателей, оружия, брони/корпуса и щитов, меняющие реальную тактическую симуляцию. Не смешивай это с расстоянием стратегического хода.

Опоры: [shipDesign](../../src/domain/shipDesign.ts), [DesignedShip](../../src/entities/DesignedShip.ts), [TacticalShip](../../src/entities/TacticalShip.ts), [BattleManager](../../src/entities/BattleManager.ts), [combatSimulation](../../src/domain/combatSimulation.ts), [conquestBattle](../../src/domain/conquestBattle.ts), [combatSeries](../../src/domain/combatSeries.ts).

## Работы

1. Определи реальные handler-параметры: engine thrust/acceleration/maxSpeed, weapon damage/range/accuracy/fireRate, armor points/resistance, hull durability, shield capacity/recharge/delay. Отдельные tech variants открываются Н08.
2. Согласуй рост характеристик, цену, объём/массу и энергопотребление. Улучшенная тяга не означает бесплатную генерацию; shield regen платит энергию по действующему правилу.
3. Общие component→stats формулы применяют variant ровно один раз. Tactical runtime читает закреплённые stats, а не глобальное completed research.
4. Проверяй совместимость flight/battle, отдельные cooldown/ammo каждого слота и рабочую дальность mixed weapons. Новый range не ломает preferred-range movement.
5. Зафиксируй актуальную rules-version тактики и обнови её producers/consumers/fixtures вместе с изменением формул. Данные иной версии отклоняются. Fixed step, sequential damage, opt-in formation/cover/retreat не менять без отдельного запроса.
6. Отчёт/верфь показывают понятные реальные величины и nominal DPS с текущими ограничениями. AI-score переиспользует cooldown quantization и учитывает цену/энергию/ammo.
7. Для текущего повреждённого ship tech completion не меняет HP/щит/топливо: новый вариант через Н12 refit/new build.
8. Сделай минимум по одной работающей научной ветви двигателя, оружия и защиты; различающиеся роли и counterplay, не один универсально лучший бесплатный пакет.

## Приёмка и проверки

- При известном input реальные скорость/ускорение, порог дальности, damage, armor и shield recovery совпадают с независимой арифметикой.
- Range exact/-epsilon/+epsilon, accuracy/fireRate/cap, energy shortage и ammo depletion проверены без подмены результата resolver.
- Один effect не применяется к component и stats одновременно; cooldown использует общий устойчивый helper.
- Один seed/version/snapshot даёт одинаковые full result при render deltas и replay 1×/2×/4×.
- Snapshots актуального формата воспроизводят результат принятой policy; иная версия явно отклоняется; незавершённый бой не даёт кампанийную победу.
- Paired series нескольких equal-cost ролей проверяют настоящие quotes, side-bias и timeout; не доказывают универсальный баланс.
- Paid research→new build/refit→battle→save/load operations, browser и tests/typecheck/build.

## Не входит и независимая поставка

Без ручных боевых ходов, collisions/simultaneous fire, стратегических двигателей и оптимизаций «на всякий случай». Полезные научные варианты полностью работают в существующем resolver без Н14.
