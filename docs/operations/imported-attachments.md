# Миграция legacy-вложений

Runbook описывает двухфазный перенос `metadata_json.attachments` из приватных
Linear `external_records` в native Attachment/D1/R2. Он не возвращает public
Linear import или external-context API.

## Authority и среды

- UAT использует default `.openai/hosting.json`, отдельные D1/R2 и только
  synthetic/approved fixtures.
- Production inventory, backup, migration, R2 write, cutover и cleanup требуют
  прямой текущей команды пользователя, явно называющей production и scope.
- Production data/URLs не копируются в UAT. `external_records` и raw outcomes
  не удаляются этим runbook.

## Конфигурация

Worker variable `TASK_MANAGER_ATTACHMENT_MIGRATION_HOSTS` содержит
comma-separated exact hosts или entries вида `*.example.com`. Пустой allowlist
fail-closed блокирует download. Не добавляйте broad wildcard, localhost,
private infrastructure или host, который не найден в проверенном inventory.

Route доступен только configured administrator и одновременно ограничивает
source rows Projects, где он current Owner или Editor+. Каждый request обязан
передать header:

```text
X-Task-Manager-Action: attachment-migration
```

## Фаза 1: inventory

Вызов `POST /api/admin/attachments/migrate` с body `{"mode":"inventory"}`:

1. bounded читает task-scoped Linear `external_records`;
2. сохраняет стабильные позиции массива `attachments`;
3. показывает только source record/index, outcome и безопасный reason code —
   без URL, filename или bytes;
4. считает pending, migrated, non-binary mapped, skipped и blocked;
5. возвращает `cutoverReady=false` при truncation, pending или blocked.

Для продолжения используйте `sourceRecordId`, `sourceIndex`, `maxRecords` и
`maxAttachments`; не увеличивайте bounds вместо checkpointed rerun.

## Фаза 1: apply

Body `{"mode":"apply"}` запускает тот же plan. Для каждого candidate Worker:

1. повторно проверяет admin и Editor+ Task ACL;
2. принимает только HTTPS URL без credentials и host из allowlist;
3. выполняет manual redirect до трёх переходов, проверяя каждый новый host;
4. не пересылает cookies/authorization/referrer и bounded читает body;
5. проверяет content type, magic bytes, size, image dimensions и SHA-256 через
   общий native Attachment boundary;
6. создаёт environment-scoped opaque R2 object с deterministic idempotency key;
7. перечитывает native row/object и сверяет task, ready state, size и SHA-256;
8. только затем записывает `migrated` outcome.

`text/html`/`application/xhtml+xml` не притворяется файлом и получает
`non_binary_mapped`. Повторный URL получает `skipped`. Malformed, unapproved,
unavailable, empty, oversized или не прошедший content/read-back candidate
получает `blocked`. Operational response/error не содержит source URL.

Повторный apply для `migrated` не скачивает source: он проверяет D1/R2 и
возвращает `already_migrated`. Потерянный object или checksum mismatch переводит
позицию в `blocked`; такой результат нельзя принять как cutover-ready.

## Backup, acceptance и cutover

До production apply скачайте и проверьте current system backup. Для одного
Project дополнительно допустим owner Project backup. Schema `11` переносит
`attachment_migration_outcomes`, native metadata и original bytes; schema
`2`–`10` импортируется с пустыми outcomes и не доказывает завершённую миграцию.

Cutover разрешён только когда один полный непрерывный inventory возвращает:

- `truncated=false`;
- `pendingCount=0`;
- `blockedCount=0`;
- `cutoverReady=true`;
- каждая binary position имеет ready native Attachment той же Task;
- Owner/Editor/Viewer читают разрешённую metadata/content, outsider и revoked
  Viewer получают fail-closed `not found`;
- повторный apply не создаёт D1/R2 duplicate или orphan;
- system/Project export, stage и restore сохраняют outcomes и originals.

Только после этих gates provider attachment surface можно убрать в той же
разрешённой production последовательности. Cleanup `external_records`, raw
JSON или mapped links — отдельная destructive операция и не следует из
успешного cutover.

## Rollback

- До cutover: исправьте allowlist/source availability и повторите apply; source
  evidence остаётся неизменным.
- При failed native create общий Attachment path удаляет новый object либо
  оставляет explicit failed metadata для bounded cleanup; outcome остаётся
  `blocked`.
- При ошибке после migration восстановите schema `11` system backup вместе с
  его verified attachment originals. Restore выдаёт новые environment-scoped
  object keys и не переиспользует source/live keys.
- Не удаляйте production data, R2 objects или source evidence без отдельной
  команды и проверенного backup/read-back.
