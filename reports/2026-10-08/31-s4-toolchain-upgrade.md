# 31 — Обновление toolchain S4

- Дата: 2026-10-08
- Пункт плана: S4.18
- Статус: выполнено

## Цель и границы

Обновить устаревший build/test toolchain после завершения функциональных этапов S4, не затрагивая runtime-зависимости и игровую механику. Сохранить Yarn Classic и существующий `yarn.lock`.

## Изменения и решения

- Обновлены devDependencies: Vite `^8.3.3`, Vitest `^5.0.3`, TypeScript `^6.0.3`, `@types/node` `^24.19.1`. Runtime-зависимости не менялись.
- Выполнен `yarn install --non-interactive` через Yarn Classic1.22.22; `yarn.lock` обновлён, второй lockfile не добавлялся.
- TypeScript6 требует убрать устаревший `baseUrl` для `paths`; alias приведён к `./src/*`. Для тестового проекта выставлены ES2022 libs, поскольку существующие тесты используют `Array.at`; приложение сохраняет ES2020.
- Vite config перешёл с `__dirname` на `import.meta.dirname` и совместим с native config loader Vite8.
- TypeScript7.0.2 не выбран: его native package больше не экспортирует compiler API, который используется существующими тестами. TypeScript6.0.3 — актуальная совместимая версия.
- Измеренный build: 159 модулей, `main-DW5IdQr-` 1576.52 kB / gzip424.99 kB. Остался штатный warning о chunk >500 kB; code splitting в этой задаче не менялся.

## Проверки

| Проверка | Результат |
| --- | --- |
| `yarn install --non-interactive` (Yarn Classic1.22.22) | Установка завершилась, `yarn.lock` обновлён |
| `yarn test` | 51 файла, 3220/3220 тестов прошли на Vitest5.0.3 |
| `yarn typecheck` | Успешно: `tsc --noEmit` и `tsc -p tsconfig.test.json` |
| `yarn build` | Успешно: TypeScript и Vite8.3.3 production build, 159 modules |
| Native Vite config loader | Build больше не сообщает о `__dirname` |

Vitest вывел informational note: 51 isolated workers со startup overhead, `isolate:false` мог бы ускорить прогон. Изоляцию не меняли, так как это не требовалось для toolchain upgrade и меняет test execution semantics. Build оставляет прежнее предупреждение о размере chunk. Yarn выбрал writable cache в VS Code temp directory, поскольку предпочтительный cache недоступен для записи; установка и команды при этом завершились успешно.

Репозиторий отслеживает `node_modules` (2808 файлов); после установки 354 tracked-файла зависимостей изменились или удалены согласно новому lockfile. Это побочный результат запрошенной установки, package contents вручную не редактировались. Общий `git diff --check` находит upstream trailing whitespace в этих установленных файлах; task-owned source/config/docs проходят scoped `git diff --check`.

## Актуализация навыков

Обновлены `.github/skills/orion-project/SKILL.md` и `.github/skills/orion-combat/SKILL.md`: версии стека, актуальные результаты полного прогона, TS7 compatibility caveat и оставшиеся warnings. План отмечен как S4.18 complete.

## Оставшиеся вопросы и следующий шаг

Функциональное code splitting не входит в этот пункт. Возвращаться к нему следует при отдельном обосновании/этапе оптимизации; тестовую изоляцию сохранять до отдельного доказательства корректности её изменения.
