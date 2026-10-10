# DIS Agent Core

Универсальное backend-ядро AI-агентов на **n8n + PostgreSQL**.

## Назначение

Ядро предназначено для переиспользования в Telegram/Web/API-проектах: авторизация, state machine, маршрутизация, платежи, логирование, аудит, защита от повторов и восстановление после ошибок.

Первый практический этап: **WF-00…WF-04**.

- `WF-00 SYS Event Intake` — приём и нормализация событий.
- `WF-01 SYS Idempotency` — защита от повторной обработки.
- `WF-02 SYS User Auth` — поиск/регистрация пользователя.
- `WF-03 SYS Context Manager` — загрузка и контроль состояния диалога.
- `WF-04 CORE Router` — детерминированная маршрутизация.

## Структура

```text
docs/
  DIS_AGENT_CORE_TZ.md

db/
  001_core.sql

workflows/
  WF-00_SYS_Event_Intake.json
  WF-01_SYS_Idempotency.json
  WF-02_SYS_User_Auth.json
  WF-03_SYS_Context_Manager.json
  WF-04_CORE_Router.json
```

## Рабочая цепочка первого этапа

`WF-00 Intake → WF-01 Idempotency → WF-02 User Auth → WF-03 Context → WF-04 Router → завершение → HTTP-ответ`.

WF-00 последовательно вызывает четыре sub-workflows с ожиданием результата. Триггеры WF-01…WF-04 используют `Accept all data`: `event_id`, `correlation_id`, `source`, внешний `user_id`, `event_type`, очищенный `payload`, `received_at` и внутренний `execution_id` передаются целиком. `execution_id` содержит ID n8n execution и случайный UUID для защиты владельца между экземплярами/перезапусками. Дубликат получает `correlation_id` первоначальной обработки.

Результат первого этапа — маршрут и состояние регистрации/контекста. Значения `payment`, `approval`, `order`, `ai_classification` являются только результатами существующего router: платежей, выдачи прав, новых агентов, LLM-вызовов и бизнес-действий здесь нет. Неизвестный пользователь получает `registration_required`; автоматическая регистрация не добавлена.

**Отправитель webhook не проверяется.** Поиск `users.telegram_id` не доказывает identity. Тестовый endpoint доступен только через loopback облачной машины. Эти экспорты нельзя считать готовым публичным authenticated endpoint.

## SQL и credentials

Проверено на PostgreSQL 16 и n8n 2.42.6. Сначала примените обе миграции в выбранной **тестовой** БД:

```sh
psql -v ON_ERROR_STOP=1 -d YOUR_TEST_DATABASE -f db/001_core.sql
psql -v ON_ERROR_STOP=1 -d YOUR_TEST_DATABASE -f db/002_core_processing.sql
```

Вторая миграция добавляет `bot_context.lock_owner` и четыре функции `dis_core_reserve`, `dis_core_auth`, `dis_core_context`, `dis_core_finish`; существующие таблицы и данные не удаляются. Миграции проверены повторным применением. Функции работают с правами вызывающего (`SECURITY INVOKER`); используйте PostgreSQL `READ COMMITTED`, отдельную роль для этой БД и ограничение `statement_timeout`.

В подготовленной облачной среде `python3 tests/cloud_setup.py` создаёт отдельную БД и роль `dis_core_workflows_test`, импортирует credential `disCoreTestPg` и назначает его всем PostgreSQL-узлам. Соединение: `dis-core-postgres:5432`, БД/роль `dis_core_workflows_test`, пустой пароль, SSL disabled **только внутри частной Docker-сети с trust-аутентификацией тестового PostgreSQL**. Порт PostgreSQL на хост не публикуется. Рабочая БД пользователя не используется; исходная облачная `dis_core` также не является БД этих тестов. Значения настоящих секретов в репозитории отсутствуют.

Для другого тестового экземпляра создайте свой PostgreSQL credential через защищённый интерфейс n8n и укажите только его ID/имя в mapping. Не сохраняйте пароль в mapping, экспортах или Git. SSL и аутентификацию выбирайте по настройкам своей тестовой БД; отключение проверки сертификатов не требуется.

## Импорт и workflow IDs

1. Сохраните существующие экспорты (`n8n export:workflow --all --output=BACKUP.json`) вне Git; сохраните резервную копию тестовой БД штатным `pg_dump`.
2. Примените SQL, создайте тестовый credential.
3. Подготовьте копии JSON с ID конкретного экземпляра, затем импортируйте WF-04, WF-03, WF-02, WF-01 и WF-00. В n8n все пять должны принадлежать одному owner/project. При CLI `--separate` импорт всех пяти выполняется одним вызовом, затем публикация идёт от WF-04 к WF-00.
4. Опубликуйте/активируйте тестовые workflows. CLI `publish:workflow --id=...` в n8n 2.42.6 требует перезапуска сервера; дождитесь не только `/healthz/readiness`, но и ответа настоящего webhook. Публикация workflow в локальном n8n отличается от Publish облачной среды.

| Экспорт | Переносимый ID |
|---|---|
| WF-00 | `disCoreWF00` |
| WF-01 | `disCoreWF01` |
| WF-02 | `disCoreWF02` |
| WF-03 | `disCoreWF03` |
| WF-04 | `disCoreWF04` |

В JSON credential `DIS_CORE_POSTGRES` — ссылка-заполнитель, а не секрет. CLI может сохранить переносимые workflow IDs; GUI или уже существующий экземпляр могут иметь другие IDs. Узлы `Call WF-01…04` в WF-00 должны ссылаться на фактически импортированные IDs, не на названия.

Пример локального mapping (не секретные значения, замените IDs своими):

```json
{
  "workflow_ids": {
    "disCoreWF00": "ACTUAL_WF00_ID",
    "disCoreWF01": "ACTUAL_WF01_ID",
    "disCoreWF02": "ACTUAL_WF02_ID",
    "disCoreWF03": "ACTUAL_WF03_ID",
    "disCoreWF04": "ACTUAL_WF04_ID"
  },
  "postgres_credential": {"id": "YOUR_TEST_CREDENTIAL_ID", "name": "Your test PostgreSQL"},
  "webhook_path": "dis-agent-core-test"
}
```

```sh
python3 scripts/prepare-import.py --mapping .local/mapping.json --output .local/import
n8n import:workflow --separate --input=.local/import
```

`prepare-import.py` меняет IDs и credential references только в копиях, не в исходных workflow. Для нового экземпляра можно задать в mapping переносимые IDs из таблицы. Не импортируйте с совпадающими IDs поверх чужой работы. Облачный helper находит ровно один существующий workflow каждого имени, сохраняет его ID; при неоднозначности останавливается. В этой среде исходные пять IDs сохранены. Mapping, резервные экспорты, подготовленные JSON и результаты находятся в `/workspace/dis-agent-dev/core-test/`.

## События и ответы

Нужен стабильный несекретный идентификатор: `body.event_id`, Telegram `update_id`/`callback_query.id`, пара `chat.id:message_id` или HTTP `Idempotency-Key`. Случайный ID при каждом повторе не генерируется. Используйте строковый `user_id` для внешнего Telegram ID, особенно вне диапазона безопасных JS-чисел. Разные Telegram-боты должны передавать namespaced `event_id`, если используют общую БД/точку входа.

```sh
curl -i -X POST http://127.0.0.1:5678/webhook/dis-agent-core-test \
  -H 'Content-Type: application/json' \
  -d '{"event_id":"example-001","user_id":"123","text":"/help"}'
```

Это команда внутренней проверки, не ссылка на web preview. Используйте только тестовый ID пользователя; если его нет, получите `registration_required`.

| Ситуация | HTTP / результат |
|---|---|
| Обычное событие | 200, `completed`, `routing` |
| Неизвестный пользователь | 200, `registration_required`, route `auth` |
| Завершённый повтор | 200, `duplicate=true`, downstream не запускается |
| Повтор ещё обрабатывается | 409, `busy=true`, downstream не запускается |
| Предыдущая ошибка | 409, `previous_failed`, автоматического retry нет |
| Неактивный пользователь | 403, `rejected` |
| Занятый/stale/неактивный контекст | 409, безопасный ответ и route `unknown` |
| Некорректное событие | 400, `invalid_event`, без резервации |
| Ошибка обработки/БД | 503, общий код без SQL-текста/stack trace |

`completed` в `processed_events` означает, что первый этап определил и сохранил результат, а не оплату или выполнение бизнес-действий. Ответ о заблокированном контексте также терминален для этого события; после изменения контекста нужно новое событие. Системные команды/callback имеют приоритет над состоянием только после проверок пользователя и блокировки. Истёкший контекст получает эффективное состояние `expired`; старое состояние в БД не переписывается. Stale-lock не снимается автоматически: старый execution мог ещё работать.

## Идемпотентность и ошибки

`INSERT ... ON CONFLICT DO NOTHING` атомарно резервирует событие. Проигравший конкурент читает существующую строку отдельным SQL-оператором, чтобы при `READ COMMITTED` увидеть только что завершившийся INSERT. Только победитель записывает `event_log` и проходит дальше. Завершение/ошибка обновляют строку только при совпадении владельца и статусе `processing`; запись `application_log`, `failed_events` и снятие принадлежащей ему context-lock выполняются в одной транзакции. Повторное завершение и повтор события не создают этих побочных действий повторно.

При доступной БД ошибки после резервации записываются как `failed` и в `failed_events`. При полном отказе PostgreSQL невозможно записать ошибку в эту же БД: возвращается 503, но резервация может остаться `processing`, а lock — удержанным. После восстановления такие события продолжают возвращать `busy`, сохраняя защиту от повторных действий. Нужна проверенная оператором сверка конкретного execution и его побочных действий; нельзя массово сбрасывать `processing`/stale-lock или создавать новый ID ради обхода защиты. Автоматическое восстановление, retry и watchdog следующих этапов не добавлены. Оба варианта отказа БД проверяются тестами.

## Проверки в облачной среде

Требуются подготовленные Docker-контейнеры `dis-core-n8n` (2.42.6) и `dis-core-postgres` (16), Node.js и Python 3. Внешних Python/npm-зависимостей для тестов нет.

```sh
cd /workspace/DIS-AGENT-CORE
node --test tests/workflows.test.mjs
python3 tests/run_cloud.py
```

Runner проверяет SQL на отдельной БД, запускает реальную импортированную цепочку HTTP-запросами, повторно импортирует те же исправленные экспорты и повторяет весь end-to-end набор с новыми fixture IDs. Итоги каждой фазы: `/workspace/dis-agent-dev/core-test/results.json`. Для отдельных проверок после подготовки:

```sh
python3 -m unittest discover -s tests -p test_sql.py -v
python3 -m unittest discover -s tests -p test_e2e.py -v
```

Тесты временно останавливают **облачный тестовый PostgreSQL**, отзывают права только тестовой роли и устанавливают fault injection только в тестовой БД; `finally` возвращает сервис/права/функции. Не запускайте этот helper в общем или production окружении. Данные тестов сохраняются, DELETE/TRUNCATE/DROP DATABASE не выполняются. Из DDL удаляются только созданные текущим тестом trigger/function fault injection. Не запускайте два cloud runner одновременно.

## Секреты: проверенное поведение и ограничение n8n

HTTP-ответы используют allowlist; headers, входной payload, свободный текст, email/phone и context payload не возвращаются. В `event_log`/`failed_events` payload — `{}`, в `application_log` — только event ID. Даже искусственная SQL-ошибка с секретным маркером перехватывается внутри sub-workflow; её текст не попадает в ответы/прикладные логи/console n8n. Event IDs должны быть несекретными. Входной текст используется в памяти для маршрутизации.

Во всех пяти workflow отключено сохранение success/error/manual execution и progress. Проверено отсутствие маркеров в **доступной истории execution**, прикладных логах и console n8n. Однако n8n 2.42.6 сначала сохраняет исходный input во внутренней `execution_data`, затем выполняет **soft-delete** при `save=none`; физическая запись остаётся до штатного pruning. Ошибочная первая строгая проверка обнаружила это поведение. Она сохранена отдельным `expectedFailure`: `test_n8n_internal_soft_deleted_input_retention_limitation`, её assertion не отключён. Остальные проверки секретов остаются обычными обязательными тестами.

Поэтому гарантия «никаких следов секретов на диске n8n» **не выполнена**. Существующие записи и политику pruning не меняли. Для такой гарантии требуется отдельное решение по входному слою/хранению n8n; исправление WF-00 после запуска execution не может очистить ранее сохранённый исходный input. Не отправляйте реальные секреты в тестовые события. Не считать общий результат полностью соответствующим строгому требованию конфиденциальности внутренней БД n8n.

## Откат без удаления данных

1. Сначала остановите вход: unpublish только WF-00 (`n8n unpublish:workflow --id=ACTUAL_WF00_ID`) и перезапустите облачный тестовый n8n. Не применяйте `--all` к чужим workflows.
2. Импортируйте сохранённый до исправлений полный экспорт с исходными IDs; не активируйте старые заготовки автоматически — у них известны синтаксические ошибки.
3. Оставьте SQL-таблицы, данные, additive `lock_owner` и функции на месте. Не удаляйте БД/volumes и не сбрасывайте `processed_events`. Для последующего восстановления согласуйте конкретные ошибки/блокировки отдельно.

В этой сессии неизменённые исходные файлы и полный экспорт n8n сохранены в `/workspace/dis-agent-dev/baseline-8303b90/`, источник Git — `8303b90c366ea67df66dd07baeccb9e2aeba9255`; для пяти исходных JSON есть `SHA256SUMS`. Этот архив локален для подготовленной среды; исходники также доступны через Git history.

Краткий отчёт о выполненных проверках: [docs/CORE_WORKFLOWS_REPORT.md](docs/CORE_WORKFLOWS_REPORT.md).

Автор: **Степанов Д.А.**
