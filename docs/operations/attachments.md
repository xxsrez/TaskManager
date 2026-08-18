# Эксплуатация нативных вложений

Решение и security boundary описаны в
[ADR-0011](../decisions/0011-native-attachments-and-r2.md).

## Bindings и конфигурация

- Logical R2 binding: `ATTACHMENTS`.
- Raster thumbnails используют обязательный Worker binding `IMAGES`; source
  остаётся в private R2 и не получает public URL.
- UAT и production используют разные private buckets. Bucket нельзя делать
  public, повторно использовать между Sites или копировать вместе с test data.
- `TASK_MANAGER_ATTACHMENT_SCOPE` различается по средам (`uat`, `production`);
  если переменная не задана, runtime выводит scope из canonical public origin.
- Безопасные defaults: 25 MiB/file, 50 active attachments/Task, 40M pixels,
  2 GiB/current owner, 1 GiB/Project, upload timeout 15 минут, delete grace
  7 дней, failed retention 24 часа.
  Имена non-secret overrides перечислены в `.env.example`.

Binding создаётся/меняется через Sites storage provisioning; `.openai` binding
metadata не редактируется вручную. Любое provision/migration production требует
прямой production-команды пользователя.

## Release preflight и smoke

1. Проверить, что target hosting binding соответствует среде, `r2` равен
   `ATTACHMENTS`, Worker имеет `IMAGES`, а D1 содержит migrations `0014` и
   `0015`.
2. Через Task details и composer загрузить небольшой PDF и несколько PNG от
   Owner/Editor; проверить progress/retry, metadata, SHA-256, `ready`, thumbnail
   WebP и отсутствие filename в object key.
3. Viewer читает список, full download и Range. Outsider и revoked Viewer
   получают `404` без подтверждения существования Attachment.
4. Проверить `Content-Disposition`, `private, no-store`, `nosniff`; PDF не
   становится inline. HTML/SVG, MIME mismatch, oversized/corrupted image
   получают bounded `400` без R2 orphan.
5. Delete сохраняет object до grace; restore возвращает `ready`. Cleanup после
   cutoff удаляет object и metadata. В UAT используются только synthetic files.
6. Открыть ту же Task во второй сессии: `task_attachments` invalidation должна
   обновить только attachment list, не полный bootstrap и не текущий local
   upload progress.
7. После deploy повторно проверить access policy Site. R2 bucket policy не
   должна становиться public.
8. Через UAT personal bearer credential вызвать Agent REST: list с двумя
   страницами, raw upload, metadata, original Range, thumbnail и versioned
   delete/restore. Проверить отсутствие internal IDs/object key в JSON и
   немедленный `404` после ACL revoke.
9. `tools/list` должен объявлять `list_task_attachments`,
   `get_task_attachment`, `upload_task_attachment` и `delete_task_attachment`,
   `api:read`/`api:write` security schemes и
   `_meta["openai/fileParams"]=["file"]` для upload. Полный MCP upload smoke
   выполнять только клиентом, который передаёт нативный OpenAI file object;
   base64, local path и произвольный URL не являются fallback transport.

Fresh-chat smoke установленного marketplace plugin направлен в production и
выполняется только после отдельно разрешённого production Site/plugin release.
UAT-проверка не переключает production plugin на `task-manager-uat`.

## Recovery

- `uploading` после `upload_expires_at` cleanup переводит в `failed` и удаляет
  object; повторный запуск безопасен.
- Ошибка удаления object оставляет metadata для следующего cleanup, а не
  удаляет DB row первой.
- Missing object для `ready` — integrity incident: route отвечает `404`, restore
  запрещён. Не создавайте replacement по старому key; повторите upload с новым
  idempotency key после расследования.
- System backup schema `3` использует общий 10 MB bounded JSON container,
  Project schema `3` — 25 MB. Каждый original представлен один раз по
  `sha256:<digest>` внутри package; row не раскрывает live object key. Schema
  `2` импортируется только как legacy no-attachment state. Current schema `11`
  дополнительно переносит writable-relation, comments/activity и attachment
  migration outcomes; это не меняет R2 object contract.
- Validate проверяет package checksum, object size/SHA-256, Attachment↔Task и
  description refs до staging. Restore пишет `backup-staging`, копирует в новые
  environment-scoped keys, выполняет D1 cutover и затем удаляет прежние/staged
  objects. До commit failure удаляет новые keys; после commit cleanup failure
  считается orphan incident и обнаруживается reconciliation.
- `POST /api/admin/attachments/reconcile` с action header
  `attachment-reconciliation` — read-only admin report. Default не читает body;
  `verifyChecksums=true` boundedly читает objects для digest. Report содержит
  только counts, opaque refs и owner/Project usage. Scan отдельно сопоставляет
  live object namespace с Attachment rows, а `backup-staging` — с активными
  system/Project import descriptors; поэтому брошенный staging object тоже
  считается orphan. При превышении bounded scan limit orphan count становится
  unknown, а report помечается `truncated`, чтобы не выдавать partial scan за
  точный. Purge/repair остаются
  отдельными explicit actions; production deletion требует отдельной команды.
- Не пытайтесь обходить package limit ручным D1 export. State больше лимита
  требует новой chunked/streaming schema; unbounded base64 запрещён.
