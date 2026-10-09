# Н19 — научные миссии, аномалии и ограниченное снабжение

**Этап:** Н19. **Предпосылки:** Н10, Н14, Н18. **Статус:** задание, не реализация.  
Выполняй с [общим контрактом](00-execution-contract.md), [основным планом](../plan-2026-10-09.md) и корабельным навыком.

## Промпт и завершённый результат

Добавь небольшую завершённую систему научных экспедиций с конечными наградами и научными улучшениями сенсоров/служб. Расширь снабжение измеримо, не превращая этап в полную экономику конвоев.

Опоры: [campaignOperations](../../src/domain/campaignOperations.ts), [conquest](../../src/domain/conquest.ts), [campaignResearch](../../src/domain/campaignResearch.ts), [seededRandom](../../src/domain/seededRandom.ts), [conquestAi](../../src/domain/conquestAi.ts), [ShipInfoPanel](../../src/ui/ShipInfoPanel.ts).

## Работы

1. Утверди два-три mission kinds: survey anomaly/научная экспедиция и ограниченная снабженческая операция. У каждой известны требования корабля/службы, источник, стоимость, progress и условия отказа.
2. Аномалия принадлежит snapshot сценария, имеет stable ID и bounded награду. Кто получает reward — один первый участник либо отдельная квота каждому — утвердить явно.
3. Для неопределённого результата закрепи RNG stream по campaign seed+anomaly/mission ID и version. Завершение/отмена/reload не выбирают награду заново; не хранить только «ещё раз бросить».
4. Научная награда даёт limited research reserve или заранее разрешённый progress, но не обходит prerequisites и правило одного completion в own endTurn.
5. Сенсорные открытия реально улучшают разрешённую видимость по топологии/дальности, а не показывают hidden full map. Research capability и installed module должны участвовать по принятому правилу.
6. Снабжение: одна согласованная платная полевая операция/источник, ограниченная module rate/stock/range, не бесконечный бесплатный fuel/ammo/repair. Раздели strategic fuel и tactical energy.
7. Содержание/минеральная добыча/repair/scanner работают через общий quote/receipt и pipeline, не второй симуляционный таймер. Недостаток оплаты отклоняет/приостанавливает по принятому контракту.
8. UI показывает mission/источник/цены/прогресс и причины паузы; AI выбирает missions из own-view с bounded бюджетом и не задерживает completed outcome.
9. Save сохраняет missions, claimed reward IDs, stocks и next ID; нельзя повторить reward после удаления корабля, закрытия сцены или изменения источника.

## Приёмка и проверки

- Real travel→mission start→progress→reward, при отсутствии технологии/модуля/источника отказ.
- Одно completion даёт ровно одну награду; stale/repeat/load/reentry/cancel не дублируют её.
- Два претендента в один общий период разрешаются принятой policy, без случайной привилегии array order.
- Reward exact cap и +1, science prerequisite/overflow limit соблюдены; поздний error откатывает claim и reward.
- Полевая операция не превышает rate/stock и не лечит бесплатно; quote одинаков в UI/AI/command.
- Scanner-own view/hidden-state pairs, paid save/load cycle и browser; tests/typecheck/build.

## Не входит и независимая поставка

Без случайных глобальных катастроф, шпионажа, сложных конвоев/рынков и бесконечных farming missions. Несколько законченных миссий и одна реальная новая supply-возможность дают самостоятельный публикуемый результат.
