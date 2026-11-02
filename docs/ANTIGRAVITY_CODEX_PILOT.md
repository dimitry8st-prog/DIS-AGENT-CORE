# Пилот совместной работы Antigravity и Codex

**Исходный commit (зафиксирован):** `95b823dc69b93ae12ab8c22c0d0abd65d87b71a0`  
**Ветка документации:** `docs/antigravity-codex-pilot`  
**Объект:** существующая цепочка WF-00…WF-04 (карта не переписывается).

Документ разделяет три слоя:

1. **Существующая реализация** — что уже есть в коде/SQL/тестах.
2. **Обнаруженные пробелы** — что явно отсутствует или ограничено.
3. **Предложения** — только предложения пилота; не являются внедрённым кодом.

В репозитории на этом commit **нет** файла `AGENTS.md`. Ориентиры: [README.md](../README.md), [CORE_WORKFLOWS_REPORT.md](CORE_WORKFLOWS_REPORT.md), [DIS_AGENT_CORE_TZ.md](DIS_AGENT_CORE_TZ.md).

---

## 1. Существующая карта WF-00…WF-04

Цепочка (из README):

```text
WF-00 Intake → WF-01 Idempotency → WF-02 User Auth → WF-03 Context → WF-04 Router → finish → HTTP
```

| WF | Назначение | Входы (контракт) | Выходы / эффект | Идентификация пользователя | Защита от дублей | Контекст | Маршрутизация |
|---|---|---|---|---|---|---|---|
| **WF-00** | Приём webhook, нормализация, оркестрация sub-workflows | HTTP POST body; поля `event_id` / Telegram `update_id` / `callback_query.id` / `chat.id:message_id` / header `Idempotency-Key`; внешний `user_id` или Telegram `from.id` | Нормализованный JSON: `event_id`, `correlation_id`, `source`, `user_id`, `event_type`, очищенный `payload`, `received_at`, `execution_id`; HTTP-ответ allowlist | Берёт внешний ID из тела/Telegram-структуры; строковая передача больших ID | Генерирует стабильный `event_id` (не случайный на каждый повтор); отклоняет событие без пригодного ключа | Передаёт контракт дальше | Вызывает WF-01…04 по очереди |
| **WF-01** | Идемпотентность | Контракт WF-00 | `idempotency.acquired` / `duplicate` / `busy` / `failed`; при дубликате — `correlation_id` первой обработки | Не меняет identity | `dis_core_reserve`: `INSERT … ON CONFLICT DO NOTHING` + UNIQUE `event_id`; только победитель идёт дальше | — | — |
| **WF-02** | Lookup пользователя | Контракт + результат WF-01 | `auth.found`, `registration_required`, `allowed`, внутренний `user.id` (UUID) | Lookup `users.telegram_id = user_id` в `dis_core_auth` | Не регистрирует автоматически | — | При неизвестном — дальше с `registration_required` |
| **WF-03** | Контекст диалога | Контракт + `auth` | `context.state/status`, TTL/`expired`, `processing_lock`, `stale`, `lock_acquired` | Использует внутренний UUID из auth | Lock с `lock_owner` = `execution_id` | `dis_core_context`: FOR UPDATE, TTL, stale 10 min | Не маршрутизирует бизнес-действия |
| **WF-04** | Детерминированный router | Контракт + auth + context | `routing.route`, `reason`, флаги вроде `llm_required` | Читает `auth`/`context` | — | Учитывает state, lock, expired | Команды/callback → route; free text → `ai_classification` (метка, без LLM-вызова) |

### Подтверждающие участки

- Цепочка и контракт передачи: [README.md](../README.md) (разделы «Рабочая цепочка», «События и ответы»).
- Отчёт проверки: [CORE_WORKFLOWS_REPORT.md](CORE_WORKFLOWS_REPORT.md).
- Резервация / auth / context / finish: [db/002_core_processing.sql](../db/002_core_processing.sql) (`dis_core_reserve`, `dis_core_auth`, `dis_core_context`, `dis_core_finish`).
- Нормализация входа: [workflows/WF-00_SYS_Event_Intake.json](../workflows/WF-00_SYS_Event_Intake.json) (Code-узлы webhook intake).
- Router: [workflows/WF-04_CORE_Router.json](../workflows/WF-04_CORE_Router.json) (узел Deterministic Router).
- Регрессии маршрутов/auth/context: [tests/workflows.test.mjs](../tests/workflows.test.mjs).
- SQL/E2E: [tests/test_sql.py](../tests/test_sql.py), [tests/test_e2e.py](../tests/test_e2e.py).

### Маршруты router (существующие значения, не бизнес-исполнение)

Из тестов и README: `auth`, `support`, `payment`, `order_status`, `context_input`, `approval`, `ai_classification`, `unknown`.  
Платежи, выдача прав, LLM и внешние побочные действия **не реализованы** на этом этапе; значения — только результат router.

---

## 2. Подлинность отправителя

### Существующая реализация

| Проверка | Где | Что делает | Чего не делает |
|---|---|---|---|
| Формат внешнего ID | WF-00 Code (intake) | Допускает строковый/safe integer Telegram-подобный ID | Не проверяет подпись Telegram |
| Стабильный idempotency key | WF-00 | Требует пригодный ключ события | Не привязывает ключ к секрету отправителя |
| Lookup пользователя | `dis_core_auth` в `002_core_processing.sql` | Ищет строку по `telegram_id` | **Не доказывает**, что запрос от Telegram или от этого пользователя |
| Статус `active` | `dis_core_auth` | `allowed` только для active | Не аутентифицирует канал |
| Owner fence `execution_id` | reserve/finish/context | Защита завершения и lock между execution | Не про отправителя webhook |
| Allowlist ответа / пустой payload в логах | WF-00 Safe Response, SQL | Снижает утечку в ответах/прикладных логах | Не закрывает soft-delete input в n8n |

Прямые формулировки репозитория:

- README: «**Отправитель webhook не проверяется.** Поиск `users.telegram_id` не доказывает identity.»
- CORE_WORKFLOWS_REPORT, ограничение 2: то же.

### Обнаруженные пробелы

1. Нет проверки Telegram `secret_token` / HMAC заголовка / webhook secret.
2. Нет mTLS / shared secret / signed JWT на входе WF-00.
3. Тестовый endpoint рассчитан на loopback облачной машины; публичный authenticated endpoint не заявлялся.
4. Любой, кто достучится до webhook, может подставить чужой `user_id` / Telegram-подобную структуру (при известном/угадываемом ID).
5. Конфиденциальность исходного input во внутренней БД n8n не полная (expected failure soft-delete) — смежный риск, не замена authn.

### Предложения (не внедрены этим заданием)

| Приоритет | Предложение | Критерий проверки |
|---|---|---|
| P0 | Проверка секрета webhook до нормализации (Telegram secret token или shared header) | Подделка без секрета → 401/403; валидный секрет → прежнее поведение E2E |
| P0 | Не доверять `user_id` из произвольного JSON без привязки к проверенному каналу | Тест: подмена user_id отвергается, если канал не подписан |
| P1 | Разделить «lookup пользователя» и «доказанная identity» в контракте auth | Поля вроде `identity_verified` vs `user_found` |
| P2 | Входной слой вне n8n (edge), чтобы не класть сырой input в execution_data | Отдельное решение владельца; связано с ограничением n8n soft-delete |

---

## 3. Границы пилота Antigravity ↔ Codex

| Роль | Делает | Не делает |
|---|---|---|
| **Antigravity (исполнитель)** | Документирует карту, пробелы, шаблоны заданий; при следующих задачах — изменения в **разрешённых путях** по шаблону | Не меняет credentials, production, чужие workflow IDs без mapping; не merge/deploy без решения владельца |
| **Codex (независимый review)** | Проверяет конкретный commit по шаблону review: соответствие заданию, пробелы authn, регрессии | Не «доделывает» фичу в том же прогоне review; не принимает lookup за identity |

Шаблоны:

- [templates/AGENT_TASK_TEMPLATE.md](templates/AGENT_TASK_TEMPLATE.md)
- [templates/INDEPENDENT_REVIEW_TEMPLATE.md](templates/INDEPENDENT_REVIEW_TEMPLATE.md)
- Инструкция передачи: [ANTIGRAVITY_CODEX_HANDOFF.md](ANTIGRAVITY_CODEX_HANDOFF.md)

---

## 4. Открытые вопросы владельцу

1. Нужен ли файл `AGENTS.md` в корне (сейчас отсутствует) как постоянные правила агентов?
2. Какой механизм подлинности webhook выбираем первым: Telegram `secret_token`, shared HMAC, edge-прокси?
3. Допустимо ли публиковать WF-00 за пределами loopback до закрытия P0 по authn?
4. Как отображать «доказанную личность» на строки `users` (только telegram_id или namespaced multi-bot)?
5. Политика по soft-delete n8n: отдельный входной слой или принятие ограничения с запретом секретов во входных событиях?
6. Кто утверждает merge ветки пилота документации и следующих code-веток?

---

## 5. Что сознательно не менялось в этом задании

Workflow JSON, SQL, credentials, сервисы, merge и деплой — **без изменений**.  
Только документация на ветке `docs/antigravity-codex-pilot`.
