# 13 — Движение с учётом дальности смешанного вооружения

- Дата: 2026-10-08
- Пункт плана: S4.5
- Статус: выполнено в границах range-aware movement

## Цель и границы

Устранить случай, когда агрегированная максимальная дальность `DesignedShip` удерживает смешанное вооружение вне радиуса короткодействующего орудия. Сохранить legacy-поведение и обычный nearest-range default. Не менять формулы атаки, построения, retreat doctrine, BattleScene UI или Conquest-specific rules.

## Изменения и решения

- Добавлен необязательный `ICombatant.getPreferredCombatRange()`; `DesignedShip` возвращает минимальную дальность оружия, у которого есть боезапас. Когда снаряды кончаются, предпочтительная дальность пересчитывается по оставшимся орудиям.
- `BattleManager` передаёт range ratio в `moveToTarget` только если предпочтительная дальность короче прежних80% агрегированной дальности. Legacy combatants без provider и однотипный/длинно-дальнобойный loadout сохраняют старый вызов без аргумента.
- `TacticalShip.moveToTarget` при explicit close-range ratio сужает retreat boundary относительно желаемой дистанции. Для прежнего default0.8 retreat threshold остаётся прежним `0.5 * maxRange`.
- Regresсионная фикстура использует валидный по энергии mixed beam900/projectile300; manager сближается, чтобы короткое орудие смогло вступить в бой.

## Проверки

| Проверка | Результат |
| --- | --- |
| `yarn test tests/DesignedShip.test.ts` | 11/11 прошли: mixed ranges, close-range hold и ammo depletion |
| Межмодульный срез | 155/155 в9 файлах: BattleManager, DesignedShip, runtimeNumbers/contracts, фабрика, conquest domain/battle/scene и combat series |
| `yarn test --reporter=dot` | 3195/3195,51 файл |
| `yarn typecheck` | Strict исходников и тестов прошёл |
| `yarn build` | Успешно,160 модулей; `main-255cee1c.js`,1838.02 kB/gzip447.33 kB; прежнее предупреждение chunk>500 kB |
| Workspace diagnostics / `git diff --check` | Ошибок/проблем whitespace не найдено |

Браузерная проверка не проводилась: UI и сцены не менялись.

## Актуализация навыков

Обновлены `orion-project`, `orion-combat`, `orion-ship-design`; S4.5 отмечен в плане. Ограничение UI/default поведения оставлено явным.

## Оставшиеся вопросы и следующий шаг

Range preference учитывает только дальность и наличие ammo, не DPS/энергию/щит/роль; это минимальная эвристика для mixed-range loadout, не тактика дистанции для всей армады. Следующие tactical задачи остаются открыты: позиции/построения/прикрытие/отступление и объяснимый отчёт. Настройка через BattleScene UI и performance не проверялись.
