# Runbook Task Activity и Linear status history

Статус: `Implemented`

Последнее обновление: 2026-08-18

## Назначение

> После runtime cutover 2026-08-18 deployed Linear import route отсутствует.
> Этот runbook сохраняет offline reconciliation и rollback procedure.

Процедура проверяет migration `0023`, native append-only Activity, перенос
`external_records.metadata_json.stateHistory`, reconciliation, backup/restore и
UAT smoke. Она не разрешает production deploy или изменение production data:
для production по-прежнему нужна отдельная текущая команда пользователя.

## Контракт

- Каждая успешная mutation из in-scope списка в MVP создаёт ровно один
  `activity_events` row в той же transaction; no-op, retry, optimistic
  conflict и rollback не создают row.
- Native actor — server-verified User с display snapshot. Historical actor не
  имеет `actor_user_id` и не получает permissions.
- Project move — одно событие с old/new Project и identifier. Migration
  Project codes/identifiers не создаёт synthetic events на каждую Task.
- UI, REST и MCP читают bounded ACL-scoped keyset pages. Bootstrap и sync
  journal не содержат `payload_json` или `raw_json`; sync передаёт только
  `task_activity` invalidation ID.
- Event UPDATE запрещён. Retention совпадает с lifetime Task; Project/system
  logical backup schema `10` переносит events и outcomes.

## Preflight

1. Разрешить среду по `.openai/hosting.json` (UAT) или только при явном
   production approval по `.openai/hosting.production.json`.
2. Зафиксировать exact application SHA, обязательные проверки и archive SHA.
3. До data cutover экспортировать и локально провалидировать current system
   backup. Для ограниченного Project допустим дополнительный owner-only backup.
4. Получить content-free inventory:

```sql
SELECT COUNT(*) AS source_records,
       SUM(CASE WHEN json_valid(metadata_json)
                 AND json_type(metadata_json, '$.stateHistory') = 'array'
                THEN json_array_length(metadata_json, '$.stateHistory')
                ELSE 0 END) AS source_activity_rows,
       SUM(CASE WHEN json_valid(metadata_json)
                 AND json_type(metadata_json, '$.stateHistory') IS NOT NULL
                 AND json_type(metadata_json, '$.stateHistory') <> 'array'
                THEN 1 ELSE 0 END) AS invalid_collections
FROM external_records
WHERE target_type = 'task' AND source = 'linear';
```

Invalid `metadata_json` нарушает существующий provenance/backup invariant.
Cutover останавливают; raw evidence вручную не переписывают.

## Migration 0023

Migration выполняет одну schema sequence:

1. создаёт `activity_events` и `activity_migration_outcomes` с Task/provenance
   foreign keys и source-position uniqueness;
2. инвентаризирует `stateHistory` существующих Linear Task records;
3. переносит валидный status name и timestamp в historical `status_changed`,
   сохраняя previous status и actor display name, если они есть;
4. записывает `migrated`/`exception` для каждой source row и отдельный
   `invalid_activity_collection` с `source_index=-1`;
5. добавляет immutable-event trigger и `task_activity` sync invalidations.

Offline migration planner использует тот же planning contract до writes,
детерминированные `(source_record_id, source_index)` identities и возвращает
`activityMigrated`/`activityExceptions`. Повторный import обновляет outcome,
но не дублирует event.

## Reconciliation

Сначала сверяют агрегаты без raw evidence:

```sql
SELECT source, COUNT(*) AS events
FROM activity_events
GROUP BY source
ORDER BY source;

SELECT outcome, COUNT(*) AS rows
FROM activity_migration_outcomes
GROUP BY outcome
ORDER BY outcome;

SELECT reason, COUNT(*) AS rows
FROM activity_migration_outcomes
WHERE outcome = 'exception' OR reason IS NOT NULL
GROUP BY reason
ORDER BY rows DESC, reason;
```

Проверки целостности:

```sql
SELECT COUNT(*) AS mismatched_migrated_rows
FROM activity_migration_outcomes outcome
LEFT JOIN activity_events event ON event.id = outcome.activity_event_id
WHERE outcome.outcome = 'migrated'
  AND (event.id IS NULL
    OR event.task_id <> outcome.task_id
    OR event.source_record_id <> outcome.source_record_id
    OR event.source_index <> outcome.source_index);

SELECT COUNT(*) AS historical_impersonation_rows
FROM activity_events
WHERE source = 'linear'
  AND (actor_kind <> 'historical' OR actor_user_id IS NOT NULL);

SELECT COUNT(*) AS native_provenance_rows
FROM activity_events
WHERE source = 'native'
  AND (source_record_id IS NOT NULL OR source_event_id IS NOT NULL
       OR source_index IS NOT NULL);

PRAGMA foreign_key_check;
```

Ожидаются три нулевых error count и пустой `foreign_key_check`. Для bounded
exception inventory читают только Task/source identity, index и reason:

```sql
SELECT task.identifier, source.source_id, outcome.source_index,
       outcome.source_event_id, outcome.reason
FROM activity_migration_outcomes outcome
JOIN tasks task ON task.id = outcome.task_id
JOIN external_records source ON source.id = outcome.source_record_id
WHERE outcome.outcome = 'exception'
ORDER BY task.identifier, outcome.source_index
LIMIT 200;
```

`raw_json` открывают только для конкретной уже разрешённой Task в защищённой
operator session. Его не копируют в Task comment, migration report или logs.

## UAT smoke

1. Импортировать synthetic Linear snapshot минимум с двумя валидными status
   transitions, исходными timestamps/status names, actor name, строкой без actor,
   malformed row и invalid collection.
2. Повторить import. Counts events/outcomes и stable refs не должны измениться;
   report показывает тот же `activityMigrated`/`activityExceptions`.
3. Открыть Task Activity: native и historical events видны через один surface,
   historical actor/timestamp/badge не создают локального User. `Load older`
   не повторяет уже полученные events.
4. Выполнить native status, priority, label, hierarchy, relation, comment и
   archive/restore mutations. Для каждой команды count увеличивается ровно на
   один; desired-state retry и stale version count не меняют.
5. Перенести synthetic Task между двумя Projects и проверить один event с
   old/new Project и identifier.
6. Под Viewer проверить read-only page; после revoke тот же REST/UI request
   получает indistinguishable not-found. Outsider не получает count или event.
7. Проверить Agent REST `GET /api/agent/v1/tasks/{ref}/activity` и MCP
   `list_task_activity`: maximum 50, stable cursor, actor без ID/email, тот же
   ACL. Task collection/detail не содержит event bodies.
8. Экспортировать и валидировать current system и Project backup schema `11`
   (Activity введена в schema `10`); на
   disposable UAT data пройти restore и повторить event/outcome counts.
9. Проверить sync: другая session получает `taskActivities: [taskId]`, но не
   `payload_json`; открытая Activity перечитывается, закрытая остаётся lazy.

## Retention и size policy

- Event живёт до удаления Task либо exact restore; отдельного prune Activity
  нет. Operational workspace journal по-прежнему имеет независимые 30 дней.
- System backup ограничен 5 000 rows на таблицу, 10 MB container и 1.5 MB row;
  Project backup — 5 000 rows на таблицу, 25 MB container и 1.5 MB row.
- Превышение любого guard является явной ошибкой export/validate. Нельзя
  обрезать старые events, исключать outcomes или выпускать неполный backup.

## Rollback и recovery

Down migration отсутствует: удаление Activity tables потеряет новые native
events и reconciliation evidence.

- До deploy live state не меняется.
- Ошибка migration/Sites deployment означает failed release; не отмечать Task
  завершённой и не запускать ручной partial data fix.
- После успешного schema cutover откат application допускается только на версию,
  которая понимает schema `10`, либо через полный restore заранее проверенного
  backup в согласованной recovery procedure.
- При mismatch counts сохранить backup, exact SHA/version/deployment ID и
  content-free reconciliation output. Raw evidence не публиковать.
- Project-code migration остаётся отдельным report и не воспроизводится через
  Activity backfill.
