# ADR-0011: нативные Attachment и приватное R2-хранилище

Статус: `Accepted`

Дата решения: 2026-08-17

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
7. Bodies, keys и delivery URLs не входят в bootstrap/sync/Agent collections.
   UI uploads, Markdown embeds, Agent/MCP и backup/restore расширяются отдельными
   срезами поверх этого foundation.

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
