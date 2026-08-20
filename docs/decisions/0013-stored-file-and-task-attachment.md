# ADR-0013: StoredFile до TaskAttachment и file-first workflow

Статус: `Accepted`

Дата решения: 2026-08-20

## Контекст

Task-bound upload требовал существующую Task и не позволял локальному Codex
передать произвольный файл без промежуточного OpenAI file object. Binary,
привязка к Task и Markdown reference были слиты в один lifecycle. Из-за этого
composer не мог загрузить файлы до создания Task, а remote MCP зависел от
конкретного транспорта ChatGPT.

## Решение

1. `StoredFile` владеет immutable binary metadata и private R2 object. До bind
   его видит только server-verified uploader; ready unbound file имеет 24-hour
   TTL, отдельные defaults 20 files/250 MiB и bounded cleanup.
2. `TaskAttachment` — ACL-scoped binding `StoredFile` к одной Task. Существующая
   таблица `attachments` и её `public_id` остаются compatibility identity, чтобы
   не менять `attachment:v1:` refs, list/get/download/delete/restore и backups.
3. `CommentAttachmentRef` и description token ссылаются только на
   `TaskAttachment`, никогда прямо на `StoredFile` или R2 key.
4. Upload и bind имеют независимые idempotency keys. Повтор upload с тем же
   payload возвращает тот же `fileRef`; изменённый filename, media type или
   bytes даёт conflict. Compatibility task upload сохраняет прежнюю семантику:
   одинаковые bytes с тем же task-scoped key возвращают существующий
   Attachment.
5. Bind повторно проверяет uploader, current Editor+ Task access, expiry,
   active count, current owner bytes и Project bytes. Unique
   `attachments.stored_file_id` задаёт v1 single-binding; schema и opaque
   identities позволяют позже перейти к 1:N отдельным ADR.
6. После bind доступ определяется только current Task ACL. Foreign, revoked,
   guessed и expired refs возвращают одинаковый not-found outcome. Bound file
   удаляется только через recoverable TaskAttachment lifecycle и его body-ref
   guards.
7. Новые objects получают random `<environment>/stored-files/<uuid>` key.
   Migration `0030` создаёт по одному StoredFile на каждый существующий
   Attachment, не перемещает R2 bytes и сохраняет exact attachment ref,
   checksum, uploader, object key и timestamps.
8. Project/system restore старого logical format после materialization
   синтезирует StoredFile rows и связывает восстановленные Attachments в той же
   D1 batch. Storage audit считает bound и unbound StoredFiles владельцами
   objects; legacy `attachments/` namespace остаётся читаемым.

## Последствия

- Agent REST/MCP и web могут сначала получить `fileRef`, а затем независимо
  bind его к Task или composer draft.
- Локальный companion может читать local path и вызывать file upload без
  передачи path в remote MCP; remote server по-прежнему не читает filesystem.
- Unbound files расходуют только staged quota. При bind они перестают входить в
  staged usage и начинают входить в Task/owner/Project quotas.
- R2 и D1 не дают общей транзакции: upload/bind/delete используют explicit
  states, unique guards, compensation и повторяемый cleanup.

## Отклонённые варианты

- Передавать local path в hosted MCP: server не имеет доступа к filesystem и
  такой контракт раскрывает host details.
- Хранить binary в D1 или base64/JSON-RPC: нарушает bounded data plane.
- Public/signed storage URL: переживает ACL revoke.
- Global checksum dedup или cross-Task reuse в v1: создаёт existence leak и
  усложняет ownership/quota/delete semantics.
