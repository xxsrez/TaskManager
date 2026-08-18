# Runtime cutover от Linear

Дата инвентаризации: 2026-08-18. Статус: UAT candidate; production cutover не
разрешён и не выполнялся.

## Решение

Task Manager больше не использует Linear-shaped metadata как product runtime
contract. Из deployed bundle удалены `/import/linear`, `/api/import/linear`,
browser `/api/tasks/{id}/external-source`, Agent
`/api/agent/v1/tasks/{ref}/external-context`, одноимённый MCP tool и
`provenance` в Task detail. Task UI/Peek не показывают source URL, legacy
attachment links, branch metadata или reconciliation counts.

Historical comments и status changes остаются доступны через native Comments и
Activity с публичным provider-neutral `source=native|historical`; внутренний
migration marker и source record/comment/event IDs остаются только в D1/backup
evidence. Native Attachments,
Labels, Hierarchy, Relations, Projects, Releases,
Saved Views и Task identifiers не зависят от Linear account/API/URL. Compact
bootstrap/sync не передаёт provider marker или external-context invalidation.

## Сохранённое evidence и rollback

- `external_records`, comment/activity outcomes и raw JSON не удаляются.
- Project/system backup schema `10` сохраняет migration evidence и native
  records; irreversible cleanup требует отдельной production authority.
- Versioned import planner остаётся offline migration/recovery code с
  deterministic tests, но не импортируется ни одним deployed route.
- UAT rollback до cutover — повторный deploy Sites v24, commit
  `9ef28211e6b99c11c819cabdbc3937dff8e5eb62`.
- Production binding и данные этой поставкой не меняются.

## Environment inventory перед cutover

### UAT

Sites project `task-manager-uat` перед candidate содержал 0 `external_records`,
0 comment outcomes и 0 activity outcomes. Нативные smoke records: 1 Comment,
2 Activity events и 1 ready Attachment. Таблицы `activity_events`,
`activity_migration_outcomes`, `comment_migration_outcomes` и `attachments`
присутствуют.

### Production

Read-only inventory обнаружил 227 Linear `external_records`: 204 Task, 7
WorkflowStatus, 6 Label, 4 SavedView, 3 Project и 3 Release. Production schema
на момент проверки не содержит Activity/outcome/Attachment tables последнего
UAT slice. Поэтому lossless production reconciliation не доказана, runtime
cutover в production запрещён и не выполнялся. Пагинированный Sites viewer
обрезает большие `metadata_json`, поэтому source comments/attachments/history
counts по нему не объявляются проверенными.

## Follow-up inventory: AND-1…AND-4

Read-only production inventory для TM-247 подтвердил четыре созданные
провайдером onboarding Task:

| Task | Назначение | External context |
| --- | --- | --- |
| `AND-1` | знакомство с Linear | 0 comments, 0 attachment records, 1 state-history record |
| `AND-2` | подключение Linear integrations | 0 comments, 0 attachment records, 1 state-history record |
| `AND-3` | импорт данных в Linear | 0 comments, 0 attachment records, 1 state-history record |
| `AND-4` | настройка Linear teams | 0 comments, 0 attachment records, 1 state-history record |

Descriptions содержат provider links и media embeds, а legacy context — source
URL и branch metadata. Это не product records и не подходит ни одному
продуктовому Project. Явное reconciled решение для всех четырёх: после
production Project migration оставить их в `Migration Inbox`, архивировать как
provider-only content и затем архивировать сам Project. Purge, перенос в
продуктовый Project, редактирование historical body и удаление source evidence
не выполняются.

На момент inventory production всё ещё возвращает `project=null` для всех
четырёх records, а `Migration Inbox` ещё не создан. Поэтому archive/navigation,
backup/restore и ACL gates не считаются пройденными: их mutation требует
отдельной прямой production authority. UAT не содержит этих production records,
и они не копируются туда.

## Проверяемые gates UAT candidate

- source scan не находит runtime import/external-context route, MCP tool,
  `gitBranchName` или public external-source fetch;
- OpenAPI не содержит `/tasks/{ref}/external-context` и `TaskDetail.provenance`;
- sync принимает legacy journal marker, но не публикует provider invalidation;
- raw evidence остаётся backup-only, а native history сохраняет ACL;
- обязательны полный local gate, exact-SHA Sites release, authenticated browser,
  REST/MCP 404/absence smoke и повторная проверка access policy.

Live synthetic import/reconciliation smoke TM-243 должен быть завершён до
финальной UAT приёмки. На момент составления отчёта системный file picker macOS
заблокирован locked session; это внешний операционный blocker, а не основание
скрывать или удалять raw records.
