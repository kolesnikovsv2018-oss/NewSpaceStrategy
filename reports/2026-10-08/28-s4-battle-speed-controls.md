# 28 — Скорость симуляции BattleScene

- Дата: 2026-10-08
- Пункт плана: S4.4–S4.9, BattleScene pause/simulation speed
- Статус: реализовано

## Цель и границы

Добавить управление темпом боя в демонстрационной/испытательной BattleScene и закрыть оставшийся UI-пункт tactical parent. Не менять правила BattleManager, tactical options, preset lineup, Conquest resolver или цены проектов.

## Изменения и решения

Добавлен сегментированный выбор `1×`, `2×`, `4×` с явной подписью «Скорость симуляции» и визуальным состоянием выбранного режима. Multiplier масштабирует только время, добавляемое в accumulator; BattleManager по-прежнему получает фиксированные шаги `COMBAT_SIMULATION_STEP` (0.05 с). Render delta не становится размером simulation step. Pause оставляет накопитель и бой неподвижными.

Ускорение намеренно не масштабирует Phaser tweens, delayed projectile cleanup и частицы/вспышки: это декоративная real-time анимация, а не simulation state. Отчёт боя уже содержит победителя/отсутствие победителя, длительность, общие потери/корабли и по каждой стороне остаток, потери, нанесённый и полученный урон; S4.4–S4.9 parent теперь отмечен завершённым.

## Проверки

| Проверка | Результат |
| --- | --- |
| `tests/visuals.test.ts` | 15/15; 4× за100 ms выдаёт ровно8 fixed steps по50 ms |
| Полный Vitest | 3217 тестов/51 файл прошли |
| Strict typecheck | Исходники и тесты прошли |
| Production build | Успешно,160 модулей; `main-367ac483.js` 1848.49 kB / gzip450.69 kB; прежнее предупреждение chunk >500 kB |
| Browser diagnostic | Настоящий Phaser canvas; default1× виден, Phaser `pointerdown` на4× приводит к выбранному состоянию и за50 ms render delta двигает sim duration на200 ms. Меню восстановлено,1 canvas |

Browser page была скрыта. Mouse E2E не подтверждён; speed control проверен через программный Phaser display-object event. Screenshot подтверждает расположение controls, но из-за `Scale.FIT` на viewport549×359 текст остаётся мелким.

Yarn/Node shims в среде завершаются на `snap-confine`; тесты/typecheck/build запускались установленным Node напрямую.

## Актуализация навыков

Обновлены `orion-project` и `orion-combat`: BattleScene speed selector, fixed-step accumulator semantics, real-time decorative effects, test/build snapshot и ограничения проверки. `orion-ship-design` не менялся: проектирование кораблей не затронуто.

## Оставшиеся вопросы и следующий шаг

Equal-cost fleet balance остаётся открытым. Следующий порядок плана — продолжить S4.10 balance sweep, не переходить к пунктам после S4.12. Естественный browser RAF/FPS и mouse E2E этой сцены не заявлены.
