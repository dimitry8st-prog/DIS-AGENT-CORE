# DIS Agent Core

Универсальное backend-ядро AI-агентов на **n8n + PostgreSQL** с отдельным **trusted ingress** перед WF-00.

## Назначение

Переиспользование в Telegram/Web/API: приём событий, защита от повторов, поиск пользователя, контекст диалога, детерминированная маршрутизация.

Первый практический этап: **ingress + WF-00…WF-04**.

- Ingress — проверка webhook/service credential, привязка к `project_id`/`bot_id`/`channel`, лимиты.
- `WF-00 SYS Event Intake` — приём **только** доверенного контракта от ingress.
- `WF-01 SYS Idempotency` — атомарная резервация scoped `event_id`.
- `WF-02 SYS User Auth` — поиск пользователя (не proof of identity).
- `WF-03 SYS Context Manager` — контекст/lock по project+bot+channel+dialogue.
- `WF-04 CORE Router` — детерминированная маршрутизация (без LLM/платежей).

`payment` / `order` / `approval` / `ai_classification` — **только метки маршрута**, не реализованные бизнес-функции. Регистрация и LLM не добавлены.

## Архитектура входа

```text
Telegram / trusted API service
        │  secret_token or HMAC
        ▼
 ingress (127.0.0.1)  ──rejects bad/missing/foreign creds──► 401/403
        │  strips secret headers; binds project/bot/channel
        ▼
 n8n WF-00 webhook (loopback / private network only)
        ▼
 WF-01 → WF-02 → WF-03 → WF-04 → finish → Safe Response
```

| Доверенный источник | Как проверяется | Кто утверждает `user_id` |
|---|---|---|
| Telegram bot endpoint | `X-Telegram-Bot-Api-Secret-Token` = webhook secret (**не** bot token) | Telegram update `from.id` внутри уже проверенного bot endpoint |
| Web/API sending service | `X-DIS-Signature: sha256=<hmac>` | Только если у source `may_assert_user_id: true` — это **service auth**, не аутентификация конечного пользователя |

При отсутствии конфигурации источников ingress **не стартует** (вход закрыт). Клиентские `project_id`/`bot_id`/`channel` при несовпадении с конфигом → `403 scope_mismatch`.

Составной ключ идемпотентности: `channel|project_id|bot_id|external_event_id` (сегменты без `|`). Внешний ID хранится отдельно в `external_event_id`.

## Структура

```text
ingress/                 # trusted gateway
db/
  001_core.sql
  002_core_processing.sql
  003_scoped_ingress.sql
workflows/WF-00…04
teststand/docker-compose.yml
tests/
docs/
```

## SQL и миграции

Проверено локально на PostgreSQL 16. Историческая cloud-валидация: n8n 2.42.6 (10.10.2026).

```sh
psql -v ON_ERROR_STOP=1 "$DIS_TEST_DATABASE_URL" -f db/001_core.sql
psql -v ON_ERROR_STOP=1 "$DIS_TEST_DATABASE_URL" -f db/002_core_processing.sql
psql -v ON_ERROR_STOP=1 "$DIS_TEST_DATABASE_URL" -f db/003_scoped_ingress.sql
```

`003` аддитивна: колонки scope на `processed_events`, `bot_context_scoped`, таблицы `legacy_*_scope_map`, dry-run/apply, частичный unique по `(project_id, bot_id, channel, external_event_id)`. Старые `event_id`/статусы/`correlation_id` не переписываются. После apply защита от повторов срабатывает и для нового составного ключа WF-00 (`telegram|project|bot|42` ≡ legacy `tg_42` с той же подтверждённой областью). Автоназначение project **запрещено** — только явная карта оператора. Конфликты области — через dry-run (`scope_identity_conflicts`); apply отказывается без удаления строк:

```sql
SELECT dis_core_legacy_event_scope_dry_run();
-- заполнить legacy_event_scope_map; устранить scope_identity_conflicts
SELECT dis_core_legacy_event_scope_apply();
```

Откат без потери данных: остановить ingress и unpublish WF-00; SQL-таблицы/данные оставить; не DROP/TRUNCATE volumes/`processed_events`.

## Импорт workflows

```sh
python scripts/prepare-import.py --mapping .local/mapping.json --output .local/import
```

Прямой webhook n8n держите на loopback. Публичный вход — только через ingress.

Пример вызова API-сервиса через ingress:

```sh
BODY='{"user_id":"123","dialogue_id":"123","external_event_id":"example-001","payload":{"text":"/help"}}'
SIG=$(node -e "const c=require('crypto');const b=process.argv[1];console.log('sha256='+c.createHmac('sha256',process.env.API_SERVICE_HMAC_SECRET).update(b).digest('hex'))" "$BODY")
curl -i -X POST http://127.0.0.1:8080/ingress/api/service \
  -H "Content-Type: application/json" -H "X-DIS-Signature: $SIG" -d "$BODY"
```

## Тестовый стенд

```sh
docker compose -f teststand/docker-compose.yml up -d postgres
# URL для host-psql: postgres://dis:dis_test_only_not_prod@127.0.0.1:55432/dis_core_test
# или без локального psql:
set DIS_TEST_PSQL_DOCKER=teststand-postgres-1

node --test tests/workflows.test.mjs
cd ingress && node --test test/*.test.mjs
node --test tests/sql_scoped.test.mjs
```

**Не запускайте** `tests/run_cloud.py` на общей/production инфраструктуре: helper останавливает PostgreSQL и делает fault injection.

| Проверка | Как |
|---|---|
| JS workflows | `node --test tests/workflows.test.mjs` |
| Ingress | `node --test ingress/test/*.test.mjs` |
| PostgreSQL 001–003 | `tests/sql_scoped.test.mjs` + Docker Postgres |
| Полный n8n E2E soft-delete | Требует pinned image `2.42.6`; иначе **BLOCKED**; known limitation = **EXPECTED_FAILURE** (см. ниже) |

## Конфиденциальность — факт и остаток

Ingress отсекает credentials до n8n и не форвардит secret headers. HTTP/Safe Response и прикладные логи по-прежнему allowlist.

**Не закрыто:** n8n `save=none` в проверенной версии 2.42.6 делает soft-delete input во внутренней `execution_data`; физическая запись может остаться до pruning. Проверка `test_n8n_internal_soft_deleted_input_retention_limitation` сохранена как expected failure и не ослаблялась. Свободный текст в payload может содержать ПДн/секреты — ingress это не вычищает.

## Диагностика зависших событий

См. [docs/STUCK_EVENT_DIAGNOSIS.md](docs/STUCK_EVENT_DIAGNOSIS.md). Авто-retry нет.

## Отчёты

- [docs/CORE_WORKFLOWS_REPORT.md](docs/CORE_WORKFLOWS_REPORT.md) — база 10.10.2026
- [docs/HARDENING_REPORT.md](docs/HARDENING_REPORT.md) — этот этап
- `RETURN_REPORT.txt`

Автор: **Степанов Д.А.**
