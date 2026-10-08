# 23 — Семантика цвета и проектных визуалов

- Дата: 2026-10-08
- Пункт плана: S4.12
- Статус: выполнено для текущего визуального контракта; родительские UI/performance задачи S4 открыты

## Цель и границы

Проверить правило «цвет — сторона, силуэт — корпус, hardpoint/effect — тип компонента» и убрать вывод роли по имени корабля. Не менять тактическую симуляцию, ShipDesign или значения компонентов.

## Изменения и решения

- Legacy fallback в `ShipSprite` теперь использует явно переданный `hullColor` либо единый default; проверки имени вроде «разведчик/грузовоз» удалены.
- Проектный путь остаётся общим: BattleScene задаёт цвет стороны, `ShipBlueprint` масштабирует силуэт по `HullDefinition` и красит hardpoints по `ComponentKind`.
- Регрессии в `visuals.test.ts` проверяют одинаковый faction color для разных legacy-имён, hull-specific размеры и цвета beam/engine hardpoints.
- Обновлены `docs/VISUALIZATION.md`, план, `orion-project` и `orion-combat`.

## Проверки

| Проверка | Результат |
| --- | --- |
| `yarn test tests/visuals.test.ts --reporter=dot` | 13/13 |
| `yarn test --reporter=dot` | 3209/3209, 51 файл |
| `yarn typecheck` | Успешно |
| `yarn build` | Успешно,160 модулей; `main-72d8a78b`,1841.19 kB/gzip448.54 kB; Vite warning >500 kB сохраняется |
| IDE diagnostics / diff | Source/tests/plan/skills без ошибок; `git diff --check` чистый. В `docs/VISUALIZATION.md` IDE сообщает legacy MD032/MD026/MD022 вокруг старых списков/заголовков в других разделах; новый overview абзац не менял эту структуру |

В этой итерации не запускался браузерный smoke; визуальный контракт проверен Phaser-mocked unit regression. Предыдущий browser project preview подтверждал общий blueprint, но не является новым smoke этого изменения.

## Актуализация навыков

Обновлены `orion-project` и `orion-combat`. `orion-ship-design` не менялся: формулы, дизайн и сохранения не затрагивались.

## Оставшиеся вопросы и следующий шаг

Нужно отдельно проверить визуальный контраст/читабельность цветов и эффекты в реальных сценах. Остальные открытые пункты S4 — equal-cost balance, Conquest numeric variant policy, performance, pools/index/worker и обновление toolchain. Не вводить оптимизацию без профиля.
