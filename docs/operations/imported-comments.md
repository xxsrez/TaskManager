# Runbook импортированной истории комментариев

Статус: `Implemented`

Последнее обновление: 2026-08-18

## Назначение и границы

> После runtime cutover 2026-08-18 deployed import route и external-context
> tool отсутствуют. Этот runbook сохраняется для offline reconciliation,
> rollback и проверки legacy backup, а не как текущий product API.

Runbook применяется к migration `0022_cheerful_sue_storm.sql` и проверке
unified Task Activity. Он покрывает
inventory, reconciliation, backup/restore и recovery imported comments.

Production deploy, production migration и destructive restore разрешены только
отдельной текущей командой, явно называющей production и scope. Обычная
доставка выполняет cutover только в UAT `task-manager-uat`; production data,
backup и secrets в UAT не копируются.

## Модель результата

- Каждый валидный source comment становится `comments.source='linear'`.
- `author_user_id` равен `NULL`; имя, timestamps, quote и source IDs хранятся
  отдельными immutable snapshots.
- Direct reply сохраняет root. Nested reply отображается одноуровневым под
  root, но сохраняет `source_parent_comment_id`.
- Каждая source row получает `comment_migration_outcomes.outcome`:
  `migrated` с `comment_id` либо `exception` с machine-readable `reason`.
- Raw source row остаётся только в `raw_json`/`external_records.metadata_json`.
  Task UI и Agent API возвращают bodies через unified comments endpoint, а
  provenance — только source metadata и migrated/exception counts.
- Повторный import использует deterministic Comment/source identity и не
  создаёт duplicate historical comments.

## Preflight

1. Разрешить точную среду по `.openai/hosting.json` для UAT или
   `.openai/hosting.production.json` для явно одобренного production.
2. Зафиксировать exact application SHA и убедиться, что archive собран из него.
3. Перед data cutover скачать current system backup. Для ограниченного Project
   дополнительно допустим owner-only Project backup.
4. Проверить, что backup читается validator текущего приложения и сохранён вне
   deploy archive. Не публиковать его: он содержит private content.
5. Получить read-only inventory:

```sql
SELECT COUNT(*) AS source_records,
       SUM(CASE WHEN json_valid(metadata_json)
                 AND json_type(metadata_json, '$.comments') = 'array'
                THEN json_array_length(metadata_json, '$.comments') ELSE 0 END)
         AS source_comment_rows
FROM external_records
WHERE target_type = 'task' AND source = 'linear';
```

Invalid `metadata_json` нарушает существующий backup/domain invariant. В этом
случае cutover останавливают до изменения данных; вручную «исправлять» raw
metadata без отдельного решения нельзя.

## Cutover

Migration `0022` в одной schema sequence:

1. создаёт `comment_migration_outcomes`;
2. перестраивает `comments` с nullable author и historical columns;
3. переносит прежние native comments без изменения identity/thread state;
4. инвентаризирует `external_records.metadata_json.comments`, проверяет
   обязательные ID/body/timestamps и parent topology;
5. сначала вставляет roots, затем direct/flattened replies;
6. записывает outcome каждой source row и пересчитывает `Task.comment_count`;
7. восстанавливает comments/reactions sync triggers и добавляет immutable-facts
   trigger.

Offline migration planner выполняет тот же planning contract до D1 writes и
возвращает `commentsMigrated`/`commentExceptions` в локальный report.

## Reconciliation

Сначала проверяют агрегаты, не выгружая raw bodies:

```sql
SELECT outcome, COUNT(*) AS rows
FROM comment_migration_outcomes
GROUP BY outcome
ORDER BY outcome;

SELECT reason, COUNT(*) AS rows
FROM comment_migration_outcomes
WHERE outcome = 'exception'
GROUP BY reason
ORDER BY rows DESC, reason;

SELECT COUNT(*) AS historical_comments
FROM comments
WHERE source = 'linear';
```

Для bounded списка исключений используют source identity и Task, но не
`raw_json`:

```sql
SELECT t.identifier, er.source_id AS task_source_id,
       outcome.source_index, outcome.source_comment_id, outcome.reason
FROM comment_migration_outcomes outcome
JOIN tasks t ON t.id = outcome.task_id
JOIN external_records er ON er.id = outcome.source_record_id
WHERE outcome.outcome = 'exception'
ORDER BY t.identifier, outcome.source_index
LIMIT 200;
```

Проверки целостности:

```sql
SELECT COUNT(*) AS mismatched_migrated_rows
FROM comment_migration_outcomes outcome
LEFT JOIN comments comment ON comment.id = outcome.comment_id
WHERE outcome.outcome = 'migrated'
  AND (comment.id IS NULL
    OR comment.task_id <> outcome.task_id
    OR comment.source_record_id <> outcome.source_record_id
    OR comment.source_comment_id <> outcome.source_comment_id);

SELECT COUNT(*) AS historical_impersonation_rows
FROM comments
WHERE source = 'linear' AND author_user_id IS NOT NULL;

PRAGMA foreign_key_check;
```

Ожидается `0` для обеих error counts и пустой `foreign_key_check`. Число
historical comments обязано совпасть с `migrated` outcomes для первоначального
cutover; intentional future snapshot changes документируются отдельно.

`raw_json` читают только для конкретного exception после разрешения нужной Task
и только в защищённой operator session. В отчёт и комментарий Task raw body не
копируют; достаточно source index/ID, reason и принятого решения.

## UAT smoke

1. Импортировать synthetic snapshot с root, direct reply, nested reply, quote,
   отсутствующим author и одной malformed/orphan row.
2. Повторить тот же import и подтвердить отсутствие duplicate Comments и
   outcome rows.
3. Открыть Task Activity: historical badge, author snapshot, timestamps, quote
   и flattened nested reply должны быть видны в одном thread list с native.
4. Под Viewer подтвердить read и отказ всех mutations. Под Editor подтвердить
   native reply, reaction, resolve/reopen; edit/delete historical row должны
   получать отказ.
5. Проверить offline reconciliation report: migrated/exception counts сходятся,
   raw bodies не входят в Task UI/API.
6. Проверить Agent REST/MCP `list_task_comments`/`get_task_thread` с теми же ACL
   и privacy projections; external-context tool отсутствует.
7. Экспортировать и валидировать current system и Project backup schema `13`
   (comment history введена в schema `9`, native Comment attachment index — в
   schema `13`), затем на disposable UAT data пройти restore и
   повторить counts/thread smoke.

## Rollback и recovery

Down migration отсутствует: schema rollback с удалением historical rows может
потерять уже созданные replies/reactions/resolution state.

- При ошибке до Sites deploy live state не меняется.
- При failed migration Sites/D1 transaction должна оставить прежнюю schema;
  проверить deployment events и повторно снять inventory.
- Если cutover завершён, а дефект находится в projection/UI, предпочесть
  forward fix: historical data уже участвует в unified threads.
- Application rollback на старый bundle без data recovery небезопасен: старый
  код не понимает nullable author и `source='linear'`.
- Полный возврат к pre-cutover state выполняется только через заранее
  проверенный schema `2`–`8` logical backup и current restore path. Перед этим
  скачать schema `9` backup для возможного восстановления новых discussion
  mutations. Restore является destructive replace и требует явного approval
  соответствующей среды.
- Для одного Project использовать его pre-cutover bundle и owner-only exact
  restore; sharing восстанавливать только отдельным opt-in.
- Не удалять `comment_migration_outcomes`, historical comments или raw metadata
  ручными ad-hoc SQL командами как способ «починить count».

После recovery повторяют aggregate reconciliation, `foreign_key_check`,
authenticated Activity/Agent smoke и проверку access policy Site.
