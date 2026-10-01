# DIS Agent Core — техническое задание v1.0

## 1. Цель

Создать универсальное модульное backend-ядро для Telegram, сайта и API на n8n, обеспечивающее:

- регистрацию и авторизацию;
- хранение состояния диалога;
- маршрутизацию;
- заявки и заказы;
- платежные сценарии;
- AI-support;
- логирование и аудит;
- защиту от повторов;
- retry / DLQ;
- мониторинг и восстановление после сбоев.

## 2. Архитектурный принцип

```text
Event
→ Validation
→ Deduplication
→ Authentication
→ Context
→ Routing
→ Business Logic
→ Persistence
→ Audit
→ Response
```

Каждое событие получает `event_id`, а пользовательский сценарий — `correlation_id`.

## 3. Первый этап: WF-00…WF-04

### WF-00 — SYS Event Intake

Назначение: единая точка входа.

Последовательность:

```text
Webhook/Telegram
→ Normalize
→ event_id
→ correlation_id
→ sanitize
→ log
→ WF-01
```

Выходной контракт:

```json
{
  "event_id": "tg_123",
  "correlation_id": "COR-...",
  "source": "telegram",
  "user_id": "123",
  "event_type": "message",
  "payload": {},
  "received_at": "..."
}
```

### WF-01 — SYS Idempotency

Назначение: исключить повторную обработку одного события.

Алгоритм:

1. Проверить `processed_events.event_id`.
2. Если `completed` — вернуть `duplicate=true`.
3. Если `processing` — вернуть `busy=true`.
4. Если отсутствует — создать запись `processing`.
5. В БД действует `UNIQUE(event_id)`.

Критические операции дополнительно должны использовать idempotency key на стороне внешнего API.

### WF-02 — SYS User Auth

Назначение: найти внутреннего пользователя по внешнему идентификатору.

Правила:

- Telegram ID не является основным PK;
- внутренний `users.id` — UUID;
- при отсутствии пользователя формируется состояние `registration_required`;
- платежи и permissions не должны определяться LLM.

### WF-03 — SYS Context Manager

Назначение: состояние диалога вне n8n execution.

Минимальные состояния:

- `new`
- `awaiting_input`
- `processing`
- `awaiting_payment`
- `awaiting_approval`
- `completed`
- `expired`
- `failed`

Обязательно:

- TTL;
- processing lock;
- `locked_at`;
- обнаружение stale-контекста.

### WF-04 — CORE Router

Приоритет маршрутизации:

1. системные команды и callback;
2. текущее состояние context;
3. известные deterministic rules;
4. только затем AI classification свободного текста.

LLM не разрешается самостоятельно подтверждать:

- оплату;
- refund;
- права доступа;
- удаление аккаунта;
- identity.

## 4. База данных

Минимальные таблицы:

- `users`
- `bot_context`
- `processed_events`
- `event_log`
- `application_log`
- `audit_log`
- `failed_events`
- `orders`
- `payments`

Миграция первого этапа находится в `db/001_core.sql`.

## 5. Надёжность

### Защита от повторов

Используются одновременно:

- event_id;
- UNIQUE constraint;
- idempotency key;
- context lock.

### Retry

Только для временных ошибок:

```text
5 сек → 30 сек → 2 мин → 10 мин
```

После исчерпания попыток событие попадает в DLQ.

### Dead Letter Queue

`failed_events` хранит событие, ошибку, workflow, node, retry_count и correlation_id.

### Audit

`audit_log` — INSERT ONLY для прикладных workflow.

## 6. Платежи

Агент не получает и не хранит данные банковской карты.

Сценарий:

```text
Order
→ Payment Session
→ Stripe/ЮKassa Checkout
→ Webhook
→ Verify signature + amount + currency + order
→ paid
→ audit
→ grant access
```

## 7. Логирование

Три слоя:

- `event_log` — что пришло;
- `application_log` — что выполняла система;
- `audit_log` — кто и что изменил.

Секреты, Authorization headers, пароли, токены и лишние персональные данные не логировать.

## 8. Monitoring

Следующие этапы должны добавить:

- `SYS Error Handler`;
- `SYS Retry`;
- `SYS DLQ`;
- `SYS Watchdog`;
- health checks;
- admin alerts;
- backup и тест восстановления.

## 9. Критерии приёмки первого этапа

- входное событие нормализуется;
- генерируются event_id и correlation_id;
- повторный event_id определяется;
- пользователь находится по external ID;
- context возвращает текущее состояние;
- router выдаёт предсказуемый `route`;
- SQL-ограничения препятствуют дублям;
- секреты не пишутся в payload логов.

## 10. Следующие модули

После WF-00…WF-04:

```text
ORDER
PAYMENT
SUPPORT AGENT
ERROR HANDLER
RETRY
DLQ
AUDIT
WATCHDOG
NOTIFICATIONS
```

Автор: **Степанов Д.А.**
