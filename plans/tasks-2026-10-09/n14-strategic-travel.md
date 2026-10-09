# Н14 — стратегическая скорость, дальность и топливо

**Этап:** Н14. **Предпосылки:** Н05, Н12. **Статус:** задание, не реализация.  
Выполняй с [общим контрактом](00-execution-contract.md), [основным планом](../plan-2026-10-09.md) и корабельным навыком.

## Промпт и завершённый результат

В новой policy добавь межзвёздную скорость, ограничение перехода и автономность, зависящие от изученного оснащения. Общий маршрутный калькулятор должен использоваться командами, AI, UI и генератором, если тот подключён.

Опоры: [campaignShips](../../src/domain/campaignShips.ts), [campaignFleets](../../src/domain/campaignFleets.ts), [conquest](../../src/domain/conquest.ts), [TravelPanel](../../src/ui/TravelPanel.ts), [FleetTravelPanel](../../src/ui/FleetTravelPanel.ts), [тесты маршрутов](../../tests/campaignTravel.test.ts).

## Работы

1. Зафиксируй отдельные `strategicSpeed` (distance/own-turn), `maxJumpDistance`, fuelCapacity, fuelConsumptionPerDistance и текущий fuel. Не использовать tactical maxSpeed/батарею.
2. Lane distance из Н05 — доменная длина, не UI pixels. Перед вылетом проверить существование линии, длину <= maxJumpDistance и достаточность топлива.
3. Согласуй формулы времени/топлива и точность. Предложение для одного leg: turns=max(1,ceil(distance/speed)); total fuel — один согласованный quote, списанный при отправке, не при каждом render/arrival.
4. Persist transit хранит достаточные данные для детерминированного продолжения и закреплённый route/capability snapshot; не меняется при новом research/catalog. Не дублировать route в fleet и каждой UI-панели.
5. Own endTurn двигает только own transit. В пути нет присутствия у endpoints, ремонта/refit/refuel и участия в бою. Arrival вызывает встречи/видимость по единому pipeline.
6. Группа ограничена минимальной speed и jump каждого member; у каждого свой fuel. Предложи правило синхронного arrival с групповым quote; вылет атомарен, недостаток одного member отклоняет всё.
7. Добавь научные варианты более быстрого двигателя, большего перехода и большей автономности. Каждый меняет ровно свою величину и имеет цену.
8. Quote/refuel и UI показывают время, distance, fuel, jump limit и причину отказа. AI выбирает reachable own-view цели и законный refuel, не телепортируется.
9. Общий чистый predicate начальной достижимости пригоден для [генератора](../galaxy-generator-prompt-2026-10-09.md); генератор не обязателен для поставки Н14. Travel API, codec, генератор при наличии и fixtures используют только актуальную метрическую policy.

## Приёмка и проверки

- Иллюстрация: distance=10, speed=4 → 3 own turns; speed=5 → 2; увеличение бака не меняет эти сроки.
- Exact jump limit и +1, exact fuel и -1, zero/invalid speed, finite overflow rejected.
- Группа 5/3 speed движется по 3; один member fuel shortage откатывает все fuel/transit.
- Enemy turn не продвигает маршрут; repeated send/stale/redirect in transit rejected.
- Новая tech/refit другого корабля не сокращает уже начатый перелёт; save/load midway даёт тот же arrival/бой.
- Initial reach checker и настоящая send/arrive/colonize команда согласованы без tactical flightEstimate.
- Browser single/fleet/refuel/paused/load, AI маршруты, полные tests/typecheck/build.

## Не входит и независимая поставка

Без сложных многошаговых автоконвоев, отмены в середине leg и генератора как обязательного UI. Однолинейные маршруты с многотактовым стратегическим временем и исследованиями полностью работают без будущей дипломатии.
