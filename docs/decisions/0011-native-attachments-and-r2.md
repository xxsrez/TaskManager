# ADR-0011: нативные Attachment и приватное R2-хранилище

Статус: `Accepted`

Дата решения: 2026-08-17

Дополнение 2026-08-18: private Attachment transport добавлен в Agent REST и
MCP без расширения принятой storage/ACL boundary.

Дополнение 2026-08-18: system/project backup schema `3` переносит metadata и
originals согласованно, а read-only reconciliation сравнивает D1/R2 и
description refs. Restore никогда не повторно использует source object key.

Дополнение 2026-08-18: schema `11` сохраняет per-source
`attachment_migration_outcomes`. Legacy binary port выполняется только
admin-only bounded reconciler через явный HTTPS host allowlist; public Linear
import/external-context contract не возвращается.

Дополнение 2026-08-19: `attachment:v1:` также поддерживает downloadable
Markdown file links. Canonical body по-прежнему хранит только opaque ref и
пользовательский label; private original разрешается через current Task ACL.

Дополнение 2026-08-19: live native Comments используют тот же Markdown contract
и normalized `comment_attachment_refs`; backup schema `13` переносит index.

## Контекст

D1 хранит структурированные данные, но binary body не должен попадать в D1,
bootstrap или публичный URL. Attachment обязан менять доступ синхронно с Task,
включая Project grant/revoke и ownership transfer, без копии ACL в metadata.

## Решение

1. D1 `attachments` хранит immutable internal/public identity, Task/uploader,
   нормализованные имена, проверенные MIME/size/SHA-256, непрозрачный object key,
   image metadata, idempotency, processing state, version и lifecycle times.
2. Body хранится в binding `ATTACHMENTS`. UAT и production используют разные
   buckets; scope среды входит в случайный key. Filename и client path никогда
   не образуют key, bucket не публикуется.
3. Каждый metadata/content request сначала загружает Task через её текущий ACL.
   Viewer читает; content mutation требует Editor. Недоступный и неизвестный
   resource возвращают одинаковый `not found`.
4. Upload bounded и retry-safe. Сервер читает тело с hard limit, проверяет magic
   bytes/claim, блокирует HTML/SVG, безопасно декодирует raster dimensions,
   ограничивает pixels/count и только затем пишет R2. Ошибка storage оставляет
   `failed` metadata и удаляет возможный object.
5. Content выдаётся только через authenticated Worker. Один Range поддержан;
   ответ `private, no-store`, `nosniff`, с безопасным `Content-Disposition`.
   Только проверенный raster image может быть inline.
6. Delete переводит metadata в `deleted`; object остаётся на grace period.
   Restore проверяет version, cutoff и наличие object. Bounded garbage cleanup
   сначала удаляет object и затем metadata; interrupted upload становится
   `failed`, а Task purge обязан вызвать object cleanup до удаления rows.
7. Bodies, keys и delivery URLs не входят в bootstrap/sync/compact Agent Task
   collections.
   UI читает metadata лениво, thumbnail создаётся Worker binding `IMAGES`, а
   отдельная `task_attachments` invalidation обновляет только mounted consumer.
8. Markdown image embed хранится как versioned token
   `![alt](attachment:v1:<public-ref> "caption")`. Общий repository invariant
   для UI, Agent REST и MCP требует ready raster Attachment той же Task и
   блокирует delete, пока reference используется. Renderer лениво разрешает
   reference через текущий Task ACL и никогда не сохраняет content URL.
   Downloadable file link использует `[label](attachment:v1:<public-ref>)`,
   допускает ready file/image той же Task и ведёт на тот же ACL-scoped original
   с `Content-Disposition: attachment`. Literal code reference не создаёт edge.
9. Agent REST предоставляет отдельные paginated metadata, raw binary upload,
   metadata/content и recoverable delete/restore routes. Response публикует
   только `public_id`, проверенную metadata и bearer-protected API URLs; internal
   Task/uploader IDs, object key и public/signed R2 URL остаются скрыты.
10. MCP предоставляет `list/get/upload/delete` tools. Upload использует OpenAI
    `_meta["openai/fileParams"]`: server ограниченно скачивает временный HTTPS
    URL без credentials, перепроверяет каждый redirect по OpenAI host allowlist
    и затем вызывает тот же content-inspection/idempotency path. Временный URL
    и `file_id` не становятся storage identity.
11. Backup container хранит только logical content address, bounded base64 body,
    size и SHA-256. Restore записывает staged originals в новые keys текущей
    среды, затем атомарно заменяет D1 subtree/state и компенсирует pre-commit
    failure. Read-only reconciliation и quotas не возвращают filename,
    description body, object key или file body; explicit checksum mode читает
    object только для внутренней проверки digest.
12. Reconciliation считает владельцем R2 object либо live Attachment row, либо
    descriptor активной system/Project import session. Live и backup-staging
    namespaces проверяются отдельно; truncated scan возвращает unknown orphan
    count. Derived thumbnail не хранится в R2: он создаётся bounded IMAGES
    transform на чтении, поэтому отдельного variant object lifecycle нет.
13. Live native Comment использует тот же executable Markdown contract для
    image/file refs, но хранит normalized edge в `comment_attachment_refs`.
    Comment create/edit/delete, Task Activity/sync и exact edge replacement
    выполняются одной D1 batch; Attachment delete повторяет indexed
    `NOT EXISTS` guard в atomic update. Historical bodies не переписываются,
    reply на historical root остаётся native. Backup schema `13` переносит и
    проверяет index, а schema `2`–`12` получает пустой edge set.

## Последствия

- D1 остаётся источником lifecycle metadata, R2 — источником binary body; это
  требует согласованного cleanup вместо межсервисной транзакции.
- Production bucket provisioning и production migration остаются production
  change и требуют отдельной прямой команды пользователя. Обычная delivery
  может provision/migrate/smoke только UAT.
- Bounded JSON container остаётся ограничением первой версии: system 10 MB,
  Project 25 MB. Более крупный state требует chunked streaming manifest в новой
  schema, а не ослабления validation/atomicity.

## Отклонённые варианты

- Public R2 URLs или долговечные signed URLs обходят текущий ACL после revoke.
- D1 BLOB увеличивает snapshot/backup и не соответствует binary storage.
- Global checksum dedup раскрывает наличие чужого файла; idempotency ограничена
  текущими Task и uploader.
