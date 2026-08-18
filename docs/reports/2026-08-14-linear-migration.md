# Миграция Linear в Task Manager

Статус: `Completed`

Дата: 2026-08-14

Обновление 2026-08-18: утверждения ниже о separate read-only comment archive
фиксируют состояние исходного production-переноса 2026-08-14. Current schema
cutover `0022` мигрирует такие rows в unified historical comments и сохраняет
`migrated`/`exception` outcomes; процедура описана в
[runbook](../operations/imported-comments.md). Это обновление документа не
означает production deploy: production migration по-прежнему требует отдельной
явной команды.

## Результат

Все 204 задачи workspace `Andrei Miasnikov` перенесены в owner-only production
Task Manager вместе с проектами, milestone-релизами, сохранёнными views,
workflow, labels, hierarchy, relations и исходными metadata. Идентификаторы
`AND-1`–`AND-204` сохранены без перенумерации.

Production: <https://task-manager.example.invalid>

| Объект | Linear snapshot | Production D1 |
|---|---:|---:|
| Tasks | 204 | 204 |
| Projects | 3 | 3 |
| Milestones → Releases | 3 | 3 |
| Saved views / Kanban boards | 4 | 4 |
| Workflow statuses | 7 | 7 |
| Labels | 6 | 6 |
| Task-label assignments | 111 | 111 |
| Parent links | 91 | 91 через `parent_task_id` |
| Task relations | 231 | 231 |
| Import provenance records | 227 | 227 |

Relations нормализованы как 178 `blocks`, 52 `related` и 1 `duplicate_of`.
Снимок также содержит 187 комментариев у 99 задач, 12 attachment links у двух
задач и 56 архивных задач. Комментарии доступны в Task details как read-only
archive; attachment metadata и исходные ссылки показаны рядом с provenance.

## Mapping

- Linear issue identifier и sequence сохранены; следующая новая задача Task
  Manager продолжит owner sequence с `TM-205`.
- Linear project milestone `0.1` каждого проекта импортирован как активный
  `Release 0.1`; статус `released` не выставлялся без source evidence.
- `Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Canceled` и
  `Duplicate` сохранены. `Duplicate` использует системную category `canceled`,
  потому что отдельной category для duplicate в доменной модели нет.
- Три release views открываются как board, группируются по status, сортируются
  по priority и не показывают пустые колонки. View последних изменений
  открывается как ungrouped list с относительным окном шесть часов.
- Raw Linear metadata сохраняется в owner-scoped `external_records`: source
  URL, Git branch, status history, comments, attachments и полный исходный JSON.
- 56 archived issues остаются скрыты в обычных views и доступны в `Archived`.

## Production evidence

- Source commit: `4e5fe14223992ee927c50e0bbd3088349917e879`.
- Sites version: `4` —
  `SITE_PROJECT_ID~SITE_VERSION_ID`.
- Deployment:
  `appgdep_6a7ecfeddfd48191af3a360d6aaa892e` — `succeeded`.
- Live D1 reconciliation подтвердила 204 tasks, 227 provenance records,
  231 relations, 111 task-label assignments и точные counts остальных таблиц.
- UI показывает 148 обычных и 56 архивных задач; status counts источника:
  137 Done, 59 Canceled, 5 Todo, 1 In Progress, 1 Duplicate и 1 Backlog.
- `Homeostat — релиз 0.1` открывается как board с 43 задачами: 40 Done и
  3 Canceled.
- `AND-149` показывает обе labels, parent `AND-34`, входящие/исходящие blocks и
  related links. `AND-7` показывает 2 исходных комментария, 10 attachment links,
  4 related tasks, branch и status history.
- Чистые browser smokes главной страницы, import route и Task details завершены
  без console errors.
- В production одна identity, `access_grants = 0`; Sites deployment прошёл
  owner-only verification.

## Исправленные дефекты

- Team-scoped Linear labels отсутствовали в первоначальном workspace-level
  ответе; импорт был остановлен до записи, после чего добавлены все шесть labels.
- SavedView layout, `groupBy: none`, priority/updated order и empty-column
  semantics ранее не исполнялись UI; импортированные views теперь сохраняют
  поведение источника.
- Добавлены нормализованные relations, label assignments, hierarchy и
  provenance в authorization-scoped snapshot и Task details.
- Vinext RSC prefetch падал на ссылке utility import route; ссылка заменена на
  обычную навигацию и повторный production smoke чистый.
- Импортированные комментарии сначала были доступны только в raw D1 metadata;
  добавлен read-only archive в Task details.

## Проверка исходного кода

На exact release source выполнены:

```text
npm run typecheck
npm run lint
npm test                 # 7/7
npm run build
git diff --check
validate_docs.rb --strict-navigation
```

`npm run db:generate` создал migration
`drizzle/0001_wide_skreet.sql`; SQL проверен и включён в release.

## Осознанные границы

- 12 attachment binaries не дублировались в Task Manager storage: сохранены
  названия и исходные Linear URLs. Для автономного хранения файлов нужен новый
  R2-backed upload slice и отдельное расширение спецификации.
- Импортированные комментарии read-only. Создание, редактирование, реакции и
  native activity feed остаются вне текущего MVP.
- В Linear нет cycles для этой team; issue documents отсутствуют, project
  initiatives пусты. Поэтому для них не было записей, требующих миграции.
- Локальные JSON snapshots приватны, игнорируются Git и не входят в deployment
  archive.
