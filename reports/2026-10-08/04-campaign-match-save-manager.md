# 04 — Репозиторий сохранения CampaignMatch

- Дата: 2026-10-08
- Пункт плана: S3.38
- Статус: выполнено в границах отдельного репозитория, без UI-интеграции

## Цель и границы

Добавить сохранение/загрузку полного CampaignMatch через существующий общий слот, переиспользуя кодек S3.37. Проверить ошибки IO, независимые новые экземпляры и продолжение оплаченных партий после восстановления. Подключение к сцене, выбор цели, результат/readonly/scheduler и настоящий браузер относятся к S3.39 и здесь не реализованы.

## Изменения и решения

- Добавлен [CampaignMatchSaveManager](../../src/utils/CampaignMatchSaveManager.ts), отдельный от прежних state/run-менеджеров. Ключ берётся из CampaignSaveManager.STORAGE_KEY, то есть orion_campaign_v1; второй слот не создаётся. StoragePort импортируется только как тип.
- Import/constructor без IO. Default globalThis.localStorage разрешается заново внутри try каждой операции; внедрённый порт не обращается к host. Load делает один get: null означает SAVE_NOT_FOUND, getter/read exception даёт STORAGE_READ_FAILED, остальные значения передаются готовому decoder.
- Save(unknown) сначала полностью encode, до любого storage-access; только успешный encode вызывает один set. Успех возвращается после set; getter/write exception даёт STORAGE_WRITE_FAILED. Типы LoadCampaignMatchResult/SaveCampaignMatchResult сохраняют codec failures, включая UNSUPPORTED_SCENARIO; storage-типы реэкспортированы. Сообщения фиксированные русские без частичного match/исключений.
- Strict1/2 load мигрирует только в sandbox и ничего не пишет, даже для полностью разведанной старой партии. Явный save пишет3/1; outcome не хранится. Нет кеша/чтения перед save/reread/remove/clear/fallback/repair/rollback/автомиграции/AI. Подтверждение занятого слота обязан обеспечить caller.
- Атомарность set либо throw без изменения bytes является требованием порта, не транзакцией репозитория. Между экземплярами действует последний успешный writer, не CAS.
- Добавлен один [тестовый файл](../../tests/CampaignMatchSaveManager.test.ts) с96 регрессиями. Старые исходники/кодеки/схемы/менеджеры/сцена/зависимости не менялись. Текущий UI остаётся S3.34/run/save2; новые модули не включены в entry.

## Проверки

| Проверка | Результат |
| --- | --- |
| `yarn test tests/CampaignMatchSaveManager.test.ts --reporter=dot` | 96/96 прошли; первоначальные2 и расширенные87 также прошли без ошибок |
| `yarn test --reporter=dot` | 3103 теста в44 файлах прошли; прежние3007 сохранены |
| `yarn typecheck` | Strict исходников и тестов прошёл |
| `yarn build` | Прошла,75 модулей; main-7dd0bab9,1691.37 kB/gzip400.34 kB; прежний warning chunk >500 kB |
| Граница порта | Import/constructor без storage/clock/RNG/scheduling; encode→getter→set-method→set и getter→get-method→get→decode; по одному вызову, без read-before-save |
| Ошибки | Codec union/UNSUPPORTED_SCENARIO/hidden invalid, неправильные ответы и malformed ports; SecurityError/QuotaExceededError/Error/строка/null/undefined, accessor exceptions; безопасные отказы и сохранность ключей |
| Новые экземпляры | Оба сценария/режима/стороны/исходы, независимые snapshots, отсутствие кеша, последний успешный writer, explicit legacy→save3; completed-права до CAMPAIGN_COMPLETED без dispatch |
| Обычный AI | Начальный computer match→blue end→red2 save/new manager/load не выполняет ход; только явный AI достигает3, сохранённый слот сам не обновляется |
| Размер | Реальный valid match ровно5MB write/read; +1 encode не обращается к storage, +1 decode не вызывает parse. Legacy1/2 ровно5MB читаются, upgrade3TooLarge оставляет все bytes прежними |
| Оплаченные партии | 4 preset/library×sandbox/survey цикла: доход29/380/190→по2 fighter/FIFO31→45→groups/routes45/46, checkpoints через save/new manager/load равны непрерывным целиком |
| Завершение и отказ записи | Manual завершение46 сохраняет red-transit/казну; отдельный diagnostic red-control после оплаты/отправки→AI47/188/258 каждой стороне/fuel2. Отказ save после принятого AI сохраняет match/outcome и старый checkpoint; следующий явный save успешен |
| Снимки и библиотека | Смена даты и изменение/удаление временной библиотеки не меняют оплаченные snapshots; восстановление не обращается к библиотеке |
| Документация | Диагностика редактора чистая; YAML name/description обоих обновлённых навыков проверены системным PyYAML |

Проверки используют настоящие кодек/доменные правила и контрактный Map-порт. Отдельные fault-подмены проверяют исключения, не подменяют полную валидацию реальных сохранений. Диагностическое назначение red-controller после local-покупок не является AI-производством или публичной конверсией local→AI.

Агент не проверял настоящий localStorage, reload, квоту браузера, конкурентные вкладки, производительность или UI. Пользовательское хранилище не менялось. Ранее запущенный для пользователя dev-server [localhost:3000](http://localhost:3000/) оставлен без изменений; результата пользовательской проверки нет. Коммиты и публикация не выполнялись.

## Актуализация навыков

До создания отчёта обновлены [orion-project](../../.github/skills/orion-project/SKILL.md) и [orion-ship-design](../../.github/skills/orion-ship-design/SKILL.md): новый manager/result API, порядок IO, совместимость, проверки и следующий S3.39. Выполнены процедуры orion-skill-maintenance и orion-task-report; их собственные правила не менялись. README, контракт завершения, указатели документов сохранения/controller и план приведены к текущему статусу; предыдущие отчёты не перезаписаны.

## Оставшиеся вопросы и следующий шаг

Следующий ограниченный пункт — **S3.39**: подключить match/выбор цели/публичный результат/readonly/новый менеджер и проверки ongoing к сцене, сохранить pending/captured-source/generation/blue-only/Resume-контракты и провести настоящий browser save→reload→load completed без AI. Старые API должны сохранить совместимость. Завершение мирной экспедиции не закрывает бой, технологии, баланс, соревновательную победу или весь S3.
