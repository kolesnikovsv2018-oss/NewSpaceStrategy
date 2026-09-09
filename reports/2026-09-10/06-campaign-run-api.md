# 06 — Чистая модель управления партией и авторизация команд

- Дата: 2026-09-10
- Пункт плана: [S3.31](../2026-09-07/plan.md)
- Статус: выполнено в границах чистого API

## Цель и границы

Реализовать модель control/run из [контракта S3.30](../../docs/CAMPAIGN_CONTROL.md), проверку прав ручного/AI исполнения и явный переход в локальный режим. Без Phaser, расписания, UI, IO, нового кодека или изменения рабочего save1/1. Интерфейс остаётся S3.29; постоянный противник ещё не подключён.

## Изменения и решения

- [campaignControl](../../src/domain/campaignControl.ts): strict union local либо human-vs-ai/expansion-v1, CampaignControl/ControllerKind, getControllerKind как typed query проверенного control. Назначение сторон не дублируется в state.
- [campaignRun](../../src/domain/campaignRun.ts): campaignRunSchema проверяет полный session и control. createCampaignRun валидирует явный выбор до создания; executeRunCommand и executeRunAiTurn проверяют run → strict payload → stale → active → права → прежний исполнитель. convertRunToLocal меняет только control, без исполнения команд и с идемпотентным local-входом.
- В AI-режиме ручной red получает FACTION_CONTROLLED_BY_AI, AI-blue — AI_NOT_ASSIGNED. Local позволяет ручные команды и явный помощник обеих сторон. Никаких автоматических ответов после blue-endTurn в чистом API.
- Успех возвращает detached run, actual endTurnEconomy либо отдельную AI-summary. Run результата заново полностью валидируется; квитанция/summary клонируются. Ошибки не содержат run/частичного state/журнала/сырого сообщения зависимости. Первичный state/refinement — INVALID_STATE, payload — INVALID_COMMAND, исключение AI-границы — AI_EXECUTION_FAILED. Низкоуровневые API не изменялись.
- При проверке удалена хрупкая привязка request-схемы к индексу endTurn в union. Явная strict-схема использует factionIdSchema и целый turn1..MAX_TURN; добавлена регрессия совпадения границ с существующим endTurn-context.
- Новые [control-тесты](../../tests/campaignControl.test.ts), [run-тесты](../../tests/campaignRun.test.ts), [fault-тесты](../../tests/campaignRunFaults.test.ts). Существующие исходники/тесты/зависимости/save/UI не редактировались.
- Обновлены README, документы кампании/AI/save/control и план; реализованная часть отделена от будущих scheduler/UI/формата2.

## Проверки

| Проверка | Фактический результат |
| --- | --- |
| Новые тесты | 210:38 control,143 run,29 fault-only |
| yarn test --reporter=dot | 2003/2003 теста,36/36 файлов;282 сценовых без изменений |
| yarn typecheck | Strict исходников и тестов прошёл |
| yarn build | 71 модуль, main-9990d074,1678.14 kB/gzip397.33 kB; прежний warning >500 kB. Новые модули не подключены к игровому entry |
| Права и входы | Все11 kind × обе стороны × оба режима, schema/stale/active/права/лимиты, запрет plugin/scheduler-полей, hidden-invalid session, frozen/deep copies |
| Реальный старт | Human-blue/AI-red явные вызовы1→2→3→4→5, по130/65 обеим сторонам; blue-end сам не вызывает planner, red-AI один пакет без второго end |
| Пределы/атомарность | Exact/+1 обоих ресурсов с/без colonize, поздний cap с FIFO/free/group transit, сохранность принятого blue-end, takeover+ручной end либо refuel для восстановления; MAX_TURN, максимальные ID/списки, отсутствие колоний/frontier |
| Дефицит | Для обеих сторон actual paid25/due100/short75, следующий forecast20/80; FIFO/free/group arrivals продолжаются, fuel0 не пополняется, чужие записи неизменны |
| Изоляция | Запрет IO/clock/RNG/каталога/фабрик/network/scheduling, граф runtime-импортов только domain/zod, отделённые run/квитанции/summary |
| Fault-only | 29 отдельных внедрений исключений/ошибок зависимостей/refinement/final validation, неизвестный code и частичные лишние поля не проходят; не заменяет тесты настоящих правил |
| Браузер | Не запускался: чистый API, без нового пользовательского UI или persistence |

### Оплаченные сценарии

Preset/library: настоящие local-команды колонизации/дохода до29 дают380/190 каждой стороне; по два оплаченных fighter185/11, FIFO checkpoint31→45, завершения через local helper. Затем local deploy/group/send, blue helper и red API с **диагностическим назначением** AI только после оплаченной подготовки. На47 обе188/258; ID2/1 в Эдеме,4/3 в Узле, fuel2, группы прибыли; снимки/ID/порядок сохранны.

В library-варианте временная библиотека после оплаты изменена и удалена, run API её не читает. Checkpoints проходят campaignRunSchema.parse и сравниваются с непрерывной веткой: **это не кодек, слот, load/reload или доступный пользователю переход local→AI**. Тест не выдаёт ручные red-покупки за policy; она не расширена.

## Актуализация навыков

До отчёта обновлены [orion-project](../../.github/skills/orion-project/SKILL.md) и [orion-ship-design](../../.github/skills/orion-ship-design/SKILL.md): фактические экспорты/границы, тесты, сохранность снимков, отсутствие интеграции и следующий шаг. Применены обязательные навыки актуализации и отчёта; боевой навык не менялся, тактика не затронута.

## Оставшиеся вопросы и следующий шаг

**S3.32 — только новый чистый run-кодек2/1 и регрессии:** encodeCampaignRunSave/decodeCampaignRunSave, строгая явная миграция1/1→local без записи, policy/версии/UTF-8/полный run. Старые state-only API остаются1/1. Репозиторий, интеграция сцены, controller scheduling/пауза/Resume/приватность и браузерная приёмка — отдельные задачи. Постоянный противник, победа и S3 открыты. Коммитов и публикации не выполнялось.
