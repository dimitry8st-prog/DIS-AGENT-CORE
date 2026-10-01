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

## Важно

JSON-файлы — импортируемые заготовки n8n первого этапа. После импорта необходимо назначить PostgreSQL credentials и связать workflows через Execute Sub-workflow.

Автор: **Степанов Д.А.**
