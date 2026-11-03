# Диагностика зависшего события (без авто-retry)

Автоматический повтор `processing` / снятие чужих locks **не реализован** и не должен добавляться на этом этапе.

## Что собрать до любых действий

1. `event_id` (внутренний составной ключ) и `external_event_id`.
2. `project_id`, `bot_id`, `channel`, `dialogue_id`.
3. `correlation_id` и `workflow_execution_id` / `lock_owner`.
4. Статус в `processed_events` и время `created_at` / `completed_at`.
5. Наличие строки в `failed_events` / `application_log` с тем же `correlation_id`.
6. ID execution в n8n (если доступен) и факт, жив ли ещё worker.
7. Доказательство, что побочные действия (если были за пределами ядра) не выполнены или идемпотентны.

## Безопасные SELECT

```sql
SELECT event_id, external_event_id, project_id, bot_id, channel, status,
       correlation_id, workflow_execution_id, created_at, completed_at
FROM processed_events
WHERE event_id = :event_id;

SELECT project_id, bot_id, channel, dialogue_id, user_id,
       processing_lock, lock_owner, locked_at, state, status
FROM bot_context_scoped
WHERE lock_owner = :execution_id
   OR (project_id, bot_id, channel, dialogue_id) =
      (:project_id, :bot_id, :channel, :dialogue_id);

SELECT * FROM application_log WHERE correlation_id = :correlation_id ORDER BY id;
SELECT * FROM failed_events WHERE event_id = :event_id ORDER BY id;
```

## Чего не делать

- Не `UPDATE processed_events SET status='completed'` без сверки execution.
- Не массово снимать `processing_lock`.
- Не удалять строку события, чтобы «пропустить заново».
- Не запускать `tests/run_cloud.py` на общей/production инфраструктуре.

Оператор принимает решение только после сверки конкретного execution и побочных эффектов.
