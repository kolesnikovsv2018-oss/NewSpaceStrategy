# 05 — CampaignMatch в сцене и завершение экспедиции

- Дата: 2026-10-08
- Пункт плана: S3.39
- Статус: выполнено в границах мирной экспедиции

## Цель и границы

Подключить готовые match API/кодек/репозиторий к MainScene: выбор сценария, публичный исход, readonly, сохранение полного match и остановка scheduler после конца. Военная победа, технологии, AI-производство, изменения экономики и закрытие всего S3 не входят.

## Изменения и решения

- [MainScene](../../src/scenes/MainScene.ts): единственный CampaignMatch; run/campaign/outcome производны. Create/manual/helper/scheduled AI/takeover через match API, CampaignMatchSaveManager пишет3/rules1 в прежний слот. Старые API/менеджеры не изменены.
- PendingOperation/source/candidate и AiTicket захватывают match identity. Прежние generation/disposed/active/pending/request guards до/после, consume перед executor и одна публикация сохранены. Новый match с тем же run инвалидирует старый callback. Ongoing обязателен для scheduling/Resume; completed очищает ticket/operation/summary/панели без дополнительного endTurn.
- [CampaignPanel](../../src/ui/CampaignPanel.ts): независимый выбор local/AI и sandbox/joint-survey-v1, defaults local/sandbox, confirm/cancel. «Экспедиция завершена» не перекрывает верхние команды. Own progress из SessionView/минимальный публичный outcome; полного match/чужого прогресса/казны/red-summary нет. AI blue-only после конца.
- Completed запрещает команды/helper/Resume, но оставляет просмотр/save/load/new/menu/takeover. ReadOnly передан существующим Production/Travel/Fleet/FleetTravel-панелям; их исходники не менялись.
- Save snapshot до IO, load detached candidate до confirm без reread; error/cancel сохраняет match/outcome. Strict1/2→sandbox без записи/ретрозавершения; explicit save3 подтверждает занятый слот. Completed load без AI, ongoing AI-red paused до Resume.
- [Сценовые тесты](../../tests/campaignScene.test.ts) адаптированы к match/save3;37 новых случаев. [AI integration](../../tests/campaignAiIntegration.test.ts) проверяет граф MainScene→match→run→executor→planner. Зависимости, доменные правила, библиотека и старые API неизменны.

## Проверки

| Проверка | Результат |
| --- | --- |
| Новые регрессии | 33 основных и4 оплаченных сценария прошли |
| `yarn test --reporter=dot` | 3140 тестов/44 файла,379 сценовых; все прошли |
| `yarn typecheck` | Strict исходников и тестов прошёл |
| `yarn build` | 77 модулей, main-af6bd364/1698.24 kB/gzip401.62 kB; прежний warning chunk >500 kB |
| Editor diagnostics | Изменённые исходники/тесты без ошибок |
| Навыки | YAML обоих обновлённых навыков корректен |

Node-регрессии используют fake Phaser/clock/Map-порты с реальными match/codec/production API. Покрыты выбор/default/cancel, local2 без red-income, AI11/пять пакетов/одна публикация, обе цели/режима/паритета load, takeover, readonly пяти панелей, privacy, late cap обоих ресурсов, same-run/new-match guards и cancel/read/write/unknown-scenario при completed.

Четыре paid preset/library×manual/diagnostic-AI цикла: доход29/380/190→по2 fighter/FIFO31→45→deploy/groups/send→manual46 либо AI47. Save/shutdown/reentry/load на checkpoints равен непрерывной match-ветке после смены даты и изменения/удаления временной библиотеки. Manual сохраняет red-transit; AI47 даёт188/258 каждому/fuel2 с прибытием групп. AI-control только диагностически после оплаты/отправки, не публичная local→AI конверсия/AI-покупки. Write failure после completed сохраняет принятый match/исход и старые bytes; явный повторный save успешен.

### Настоящий браузер

Отдельная страница [localhost:3000](http://localhost:3000/), изначально пустые localStorage/sessionStorage, настоящий Phaser/default storage. Использован точный entry URL, один Game/canvas, без ручного game.step.

1. Мышью local/joint-survey: blue5explore/end1/red5explore завершает на2, red100/50. Полный match равен независимому доменному oracle. Actual save3→настоящий reload→новый local/sandbox1→явный load completed2 без AI/дохода; команды отключены, save/new доступны,1canvas/1ESC.
2. Мышью new AI/joint-survey, blue вся карта и пять blue-end: completed11, idle/no ticket/no red-summary. Быстрые клики автоматизации иногда пропускались на пересозданной кнопке; poststep и обычное нажатие50ms обеспечили переходы без изменения игры. Это не оценка человеческой реакции на Pause и не browser-spy подсчёт executor.
3. Diagnostic strict1/2 из полностью разведанного снимка с turn12: actual slot→load sandbox ongoing без записи; версия1 local, версия2 AI-red paused/no ticket. Explicit save-confirm пишет3; Resume-confirm даёт13. Turn12 диагностический, не продолжение completed-партии.
4. Paid preset подготовлен обычными scene-командами без подстановки state/денег/кораблей: доход29→по2 fighter/FIFO→45→deploy/groups/send→manual completed46. Save/confirm мышью→реальный reload/load: полный match равен oracle, blue188/258, red170/248,4ships fuel2, red-группа летит. Просмотр маршрута работает, отправка запрещена. SessionStorage только oracle, не источник восстановления игры.
5. Скриншоты/геометрия desktop1280×720/mobile390×844: непустой canvas, без overflow/пересечения новых элементов; mobile new/выбор/cancel сохраняет match. SnapshotPixel дал разные непрозрачные цвета. Прежний Scale.FIT на телефоне мелкий с полями, не адаптивная раскладка.
6. Reset local/sandbox1→menu:0match/0panel/0ticket/0ESC/1canvas. Удалены только тестовый слот и oracle-ключ; оба storage снова пусты. Dev-сервер оставлен пользователю.

Не проверены реальное исчерпание quota, конкурентные вкладки, физический ESC, производительность и browser-цикл библиотеки. Paid browser подготовлен через scene API, не полный mouse E2E. Fault-порты/diagnostic snapshots не выдаются за достижимый браузерный цикл.

## Актуализация навыков

До отчёта обновлены [orion-project](../../.github/skills/orion-project/SKILL.md) и [orion-ship-design](../../.github/skills/orion-ship-design/SKILL.md): карта MainScene→match/save3, completed/readonly/privacy/ticket, проверки/ограничения и долг. YAML проверен. orion-combat не затронут, боевые формулы/представления не менялись. README/контракты/план актуализированы, прежние отчёты сохранены.

## Оставшиеся вопросы и следующий шаг

S3.39 принят только для мирной экспедиции. Технологии, угроза, стратегический бой, AI-производство и соревновательная победа остаются открытыми. Следующий ограниченный контракт согласовать отдельно по [плану](../2026-09-07/plan.md), не переходить автоматически в S4. Мобильная эргономика, размер bundle, реальная quota и профилирование остаются отдельными задачами. Коммитов/публикации/смены зависимостей нет.
