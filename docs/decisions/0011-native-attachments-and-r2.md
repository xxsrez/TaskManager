# ADR-0011: нативные Attachment и приватное R2-хранилище

Статус: `Accepted`

Дата решения: 2026-08-17

Дополнение 2026-08-18: private Attachment transport добавлен в Agent REST и
MCP без расширения принятой storage/ACL boundary.

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
9. Agent REST предоставляет отдельные paginated metadata, raw binary upload,
   metadata/content и recoverable delete/restore routes. Response публикует
   только `public_id`, проверенную metadata и bearer-protected API URLs; internal
   Task/uploader IDs, object key и public/signed R2 URL остаются скрыты.
10. MCP предоставляет `list/get/upload/delete` tools. Upload использует OpenAI
    `_meta["openai/fileParams"]`: server ограниченно скачивает временный HTTPS
    URL без credentials, перепроверяет каждый redirect по OpenAI host allowlist
    и затем вызывает тот же content-inspection/idempotency path. Временный URL
    и `file_id` не становятся storage identity. Attachment-aware backup/restore
    остаётся следующим отдельным срезом.

## Последствия

- D1 остаётся источником lifecycle metadata, R2 — источником binary body; это
  требует согласованного cleanup вместо межсервисной транзакции.
- Production bucket provisioning и production migration остаются production
  change и требуют отдельной прямой команды пользователя. Обычная delivery
  может provision/migrate/smoke только UAT.
- Logical export/restore до отдельного attachment-aware среза fail-closed, если
  затронутые Tasks имеют native Attachment; неполный backup не создаётся.

## Отклонённые варианты

- Public R2 URLs или долговечные signed URLs обходят текущий ACL после revoke.
- D1 BLOB увеличивает snapshot/backup и не соответствует binary storage.
- Global checksum dedup раскрывает наличие чужого файла; idempotency ограничена
  текущими Task и uploader.
