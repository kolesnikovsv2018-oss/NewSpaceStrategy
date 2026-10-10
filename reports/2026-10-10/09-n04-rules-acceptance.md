# 09 — Н04: завершение rules snapshot и восстановление запуска проверок

- Дата: 2026-10-10
- Пункт плана: [Н04](../../plans/tasks-2026-10-09/n04-effects-rules.md)
- Статус: выполнено в библиотечных границах задания

## Цель и границы

Завершить строгий контракт effects/rules snapshot, восстановить доступный исполнителю
запуск тестов/типизации/сборки и проверить критерии Н04 фактическим исполнением.
Предпосылка Н01 принята документально. Новая библиотека не подключена к Conquest,
не начисляет будущие бонусы и не меняет tree2 или военный save5/rules3.

Предыдущий [отчёт08](08-n04-rules-snapshot.md) фиксировал частичный результат.
Его утверждение о готовой логической реализации было преждевременным:
помимо импортного сбоя Zod остались реальные дефекты теста и арифметики.
Этот отчёт фиксирует завершённую, проверенную поставку, а не только снятие окруженческой блокировки.

## Изменения и решения

### Запуск проверок

В sandbox-shell `yarn` разрешается через Snap и завершается до старта проекта:
диагностика cgroup и `timeout waiting for snap system profiles to get updated`, exit46.
В штатной shell task VS Code **тот же Yarn Classic1.22.22 успешно запускает Vitest5.0.3,
TypeScript и Vite8**. Различие относится к окружению запуска Snap, не к package scripts,
зависимостям или работоспособности dev-сервера.

Использована штатная VS Code shell task с нужными командами. Установка второго
Node, изменение lockfile, настройка системных Snap-профилей или смена стека не потребовались.
Временный tasks.json удалён после проверки; доступный способ запуска закреплён в навыке и контракте.
Сам sandbox Snap не перенастраивался — устранена блокировка рабочего процесса проверок.

### Модель/codec/API

- [campaignRules.ts](../../src/domain/campaignRules.ts): discriminated union из object-схем,
  refinements поверх union; строгие target/scope/unit/handler/operation, finite значения,
  обязательные cap/фазы/группы, текущие версии и явные ID дерева/таблиц/политики.
- Codec принимает unknown, отвергает missing/extra и неподдерживаемые версии без преобразований;
  ошибки JSON/snapshot имеют явные code/message, входы и результаты независимы.
- Известное описание handler отделено от разрешённой активации.
  `CURRENT_GAME_RULES_CONSUMERS=[]`; policy-reference/growth не получают игрового исполнителя.
- Numeric, capability и activation — отдельные чистые API. Capability unlock — set0/1 с cap1.
  Policy-reference не исполняется как простое присваивание числа.
- Арифметика: фиксированная база одной группы, совместный add, отдельный multiply,
  канонический порядок групп/ASCII ID, явные set/min/max/cap и окончательный cap.
  Единственное конечное округление не пересекает fractional final cap.
- Stats-helper объединяет эффекты по target; нет последовательного округления каждого
  бонуса, скрытых нулей для missing stats или пропуска неизвестного эффекта.
- `applyNumericEffectsWithReceipt` возвращает ledger; component→stats повтор ID явно отклоняется.
  Нет глобального кеша, мутации caller или мнимой сетевой дедупликации.
- [JSON-fixture](../../src/domain/fixtures/rules-default.json) — общий пример каталога для прямого API и тестов;
  [контракт](../../docs/CAMPAIGN_RULES.md) описывает математику, профили активации и матрицу producers/consumers.

### Исправленные ошибки

1. Zod3 `.superRefine()` превращал options в ZodEffects до создания discriminatedUnion;
   это вызывало импортный crash, не отсутствие тестов.
2. Тест «дубликата» добавлял новый ID; теперь реально повторяет существующий.
3. Percent cap0.3 ошибочно применялся как абсолютное число0.3, затем округлялся до0.
   Теперь относительный cap переводится от исходной базы; абсолютные caps проверяются отдельно.
4. Прежний stats-helper начислял эффекты по одному, что давало compounding вместо совместного add;
   исправлено объединением target перед расчётом.
5. Нет silent fallback для будущих targets, несовместимых scopes или неподдерживаемых операций.

## Проверки

| Проверка | Результат |
| --- | --- |
| Sandbox `yarn test tests/campaignRules.test.ts` | Повторно подтверждён startup exit46 до Vitest; не ошибка тестовых assertions |
| Первый VS Code shell task после восстановления запуска | Yarn/Vitest работают; 2/4 теста выявили ошибочный duplicate fixture и cap=0 |
| Промежуточный прогон после исправлений | 47/47 rules tests, strict typecheck и production build успешно |
| Финальный `yarn test tests/campaignRules.test.ts tests/campaignResearch.test.ts tests/conquest.test.ts` | **95/95**, 3 файла: rules52, research27, Conquest16 |
| `yarn typecheck` | Успешно: browser, CLI и test tsconfigs |
| `yarn build` | Успешно:165 модулей, main-z-8A62xJ.js,1615.28kB/gzip435.79kB — игровой bundle не изменился |
| Problems для новых TS-файлов | Ошибок нет |
| `git diff --check` | Успешно |

52 rules tests покрывают действительный импорт union, схемы/версии/missing/extra,
target/unit/scope/handler, negative/nonfinite/count, независимые100→130/132 oracles,
перестановки/межгрупповой порядок, cap точно/+1/дробный cap, округление, ledger component→stats,
фазы, реальные capability операции и detached каталоги/codec/activation.
Research/Conquest тесты используют существующие реальные кодеки и подтверждают прежний формат save/tree.

Полный baseline/full suite и новый браузерный игровой цикл в этой поставке не запускались:
новая библиотека не подключена к игре/UI. Ранее открытое главное меню не выдаётся за проверку
rules API. Vite warning о chunk>500kB остаётся прежним и не является ошибкой Н04.
Производительность/FPS/реальная quota не измерялись.

## Актуализация навыков

- Обновлён [orion-project](../../.github/skills/orion-project/SKILL.md):
  поставка Н04, API/fixture/ledger, тесты, границы и следующая научная задача Н06.
- [orion-skill-maintenance](../../.github/skills/orion-skill-maintenance/SKILL.md) и
  [orion-task-report](../../.github/skills/orion-task-report/SKILL.md) выполнены без изменения процедур.
- Корабельные/боевые навыки не изменялись: текущие модели кораблей и симуляция не затронуты.
- [Журнал](../../plans/tasks-2026-10-09/task-status.md) и
  [план](../../plans/plan-2026-10-09.md) обновлены по фактической приёмке.

## Оставшиеся вопросы и следующий шаг

Нерешённых ошибок Н04 в принятых библиотечных границах нет.
Следующий научный этап — Н06 после принятых Н04/Н05; Н05а остаётся независимым.
Рост/население/научные очки/игровые handlers и новые save schemas не реализованы
и не зарезервированы. Подключать их вместе с минимальными действующими consumers,
примерами/fixtures и новой проверкой игрового цикла, а не объявлять описательный target бонусом.
