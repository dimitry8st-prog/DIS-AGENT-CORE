# Инструкция: передача Codex на независимую проверку

## Зачем

Исполнитель (Antigravity/Cursor) и reviewer (Codex) не смешивают роли. Codex проверяет **конкретный commit**, а не намерения из чата.

## Что передать Codex

1. URL репозитория: `https://github.com/dimitry8st-prog/DIS-AGENT-CORE`
2. Полный SHA commit для review (после push ветки).
3. База: `95b823dc69b93ae12ab8c22c0d0abd65d87b71a0` (или merge-base, если ветка ушла дальше).
4. Документы:
   - `docs/ANTIGRAVITY_CODEX_PILOT.md` — карта WF-00…04, authn gaps, предложения
   - заполненный `docs/templates/AGENT_TASK_TEMPLATE.md` (копия/вложение в задание)
   - пустой `docs/templates/INDEPENDENT_REVIEW_TEMPLATE.md` для заполнения
5. Список разрешённых путей из задания.
6. Фактические команды проверки и их результаты (таблица).

## Текст-заготовка промпта для Codex

```text
Независимый review commit <FULL_SHA> репозитория DIS-AGENT-CORE.

База сравнения: 95b823dc69b93ae12ab8c22c0d0abd65d87b71a0
Задание исполнителя: <кратко / ссылка>
Разрешённые пути: <список>

Прочитай docs/ANTIGRAVITY_CODEX_PILOT.md и docs/CORE_WORKFLOWS_REPORT.md.
Заполни docs/templates/INDEPENDENT_REVIEW_TEMPLATE.md по фактам diff и кода.
Не внедряй новые фичи в этом прогоне.
Явно проверь: не принят ли lookup telegram_id за доказательство identity;
не ослаблена ли идемпотентность; не выходит ли diff за разрешённые пути.
Верни verdict: Approve / Approve with follow-ups / Request changes / Reject.
```

## Для текущего docs-пилота (эта ветка)

| Поле | Значение |
|---|---|
| Ветка | `docs/antigravity-codex-pilot` |
| Исходный / base commit | `95b823dc69b93ae12ab8c22c0d0abd65d87b71a0` |
| Scope | только `docs/**` |
| Ожидание от Codex | подтвердить, что документация не искажает карту WF и корректно отделяет пробелы authn от реализации; проверить отсутствие изменений вне docs |

После первого code-изменения по шаблону задания — новый SHA и новый review (не переиспользовать вердикт docs-пилота).

## Чего Codex не должен делать в review-прогоне

- merge / push в `main`
- деплой / publish workflows
- правка SQL/credentials «заодно»
- объявление проверок пройденными без запуска, если запуск был критерием
