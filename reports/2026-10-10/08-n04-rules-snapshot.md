# 08 — N04: rules snapshot и strict validation boundary

- Дата: 2026-10-10
- Пункт плана: Н04
- Статус: частично / заблокировано на валидации окружением

## Цель и границы

Реализовать отдельный библиотечный контракт для правил/эффектов кампании без подключения к текущему gameplay и save-форматам Conquest. Задача должна оставить текущие runtime state/tree/save прежними и дать строгий, typed rules snapshot с проверкой эффектов и версий.

В задачу не входит интеграция в боевую симуляцию, Conquest save v5/rules v3 или runtime-обработчики военной кампании.

## Изменения и решения

- Добавлен отдельный модуль [src/domain/campaignRules.ts](../../src/domain/campaignRules.ts):
  - strict Zod validation для targets/units/operations/handlers/policies;
  - discriminated union для `capability`, `modifier` и `policy-reference` effects;
  - уникальные `effect.id` и reject unknown handler/policy в snapshot;
  - strict rules snapshot с `format/schemaVersion/rulesVersion` и явной версией дерева/таблиц/политик;
  - helper `encodeRulesSnapshot`/`decodeRulesSnapshot`; 
  - default fixture `createDefaultRulesSnapshot` и `buildRulesFixture`.
- После пользовательского запуска Vitest выявлен startup-crash схемы: `z.discriminatedUnion` получал варианты capability/modifier, уже обёрнутые в `.superRefine()` (ZodEffects), тогда как Zod 3 требует обычные object-схемы для извлечения discriminator.
- Исправлена граница схемы: `z.discriminatedUnion('kind', ...)` теперь строится из строгих object-схем; проверка target/unit и отрицательного percent `set` перенесена в `.superRefine()` поверх готового union.
- Добавлены числовые helper-проверки:
  - canonical stacking order;
  - additive vs multiplicative semantics;
  - cap-aware `applyNumericEffects`.
- Добавлены focused regression tests в [tests/campaignRules.test.ts](../../tests/campaignRules.test.ts):
  - round-trip valid snapshot;
  - duplicate ID rejection;
  - unknown handler rejection;
  - invalid target/unit pair rejection;
  - additive percent/cap numerics.

## Проверки

| Проверка | Результат |
| --- | --- |
| Статический просмотр контракта и задачи | Выполнено: код и описание находятся в пределах N04 и изолированы от runtime/gameplay |
| Проверка проекта и файла статуса | Выполнено: строка Н04 в [plans/tasks-2026-10-09/task-status.md](../../plans/tasks-2026-10-09/task-status.md) обновлена до `В процессе` |
| Пользовательский `yarn test tests/campaignRules.test` до исправления | Запущен Vitest v5.0.3; suite завершился до объявления тестов: `TypeError: Cannot read properties of undefined (reading 'kind')` при создании `rulesEffectSchema` в `campaignRules.ts` |
| Диагностика и исправление Zod schema construction | Причина локализована: Zod 3 discriminated union получил ZodEffects вместо ZodObject; refinement перемещён на результат union |
| Problems для изменённых TS-файлов | Ошибок редакторной диагностики нет |
| `git diff --check` | Успешно |
| Повторный запуск Vitest после исправления | Не подтверждён: доступный shell по-прежнему падает при старте snap Node/Yarn с `timeout waiting for snap system profiles to get updated`; обновлённый код должен быть повторно прогнан в терминале пользователя |
| Полный `tsc` / `yarn typecheck` / `yarn build` | Не запускались после исправления; требуют успешного Node/Yarn runtime |

Непроведённые проверки и ограничения:

- Первый failing test run был реальным пользовательским запуском и воспроизвёл ошибку во время импорта модуля; исправление внесено, но post-fix Vitest/typecheck/build в shell агента заблокированы окружением.
- Приложение, открытое в браузере на `localhost:3001`, подтверждало работу существующего dev-сервера, но не запускает и не проверяет Vitest/TypeScript build.
- Задача остаётся частичной, пока пользователь не выполнит post-fix Vitest и строгие проверки проекта.

## Актуализация навыков

Проверены и соответствуют актуальному состоянию:

- [orion-project](../../.github/skills/orion-project/SKILL.md) — текущий проектный контекст и ограничения N04 остались корректными;
- [orion-skill-maintenance](../../.github/skills/orion-skill-maintenance/SKILL.md) — применён после задачи;
- [orion-task-report](../../.github/skills/orion-task-report/SKILL.md) — использован для записи результата.

## Оставшиеся вопросы и следующий шаг

- Снять блокировку окружения: исправить или заменить snap-based Node/Yarn runtime в sandbox, чтобы выполнить `vitest run tests/campaignRules.test.ts` и `yarn typecheck`.
- После восстановления среды проверить, что N04 действительно проходит в проекте без конфликтов с текущим Conquest save/tree format.
- Если окружение останется блокированным, это следует считать технической, но не логической, проблемой реализации: кода N04 уже создан, а фактическая acceptance validation не завершена вне проекта.
