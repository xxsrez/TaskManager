# ADR-0004: полный системный backup и restore

Статус: `Accepted`

Дата решения: 2026-08-14

Дополнение 2026-08-16: native comments и reactions включаются в product state;
`schemaVersion` logical backup повышена до `2`, старый schema `1` отклоняется
до staging как несовместимый.

Дополнение 2026-08-18: Task description может содержать native image token
`attachment:v1:<public-ref>`, но schema `2` не переносит Attachment metadata и
R2 objects. Поэтому export/import сохраняют fail-closed guard при наличии
любого native Attachment; отдельно переносить description с embed нельзя.

Дополнение 2026-08-18: attachment-aware container повышает `schemaVersion` до
`3`. Он включает Attachment metadata и bounded content-addressed object set с
SHA-256/size каждого original; schema `2` без Attachments остаётся импортируемой.
Restore сначала проверяет весь container и кладёт originals в isolated R2
staging, затем материализует новые environment-scoped keys, выполняет один D1
cutover и только после success удаляет прежние/staged objects. Ошибка до D1
commit компенсирует новые objects и не меняет live state.

Дополнение 2026-08-18: native writable relations повышают logical
`schemaVersion` до `5`: relation row переносит immutable ID, idempotency key,
version и updated timestamp. Schema `2`–`4` остаются импортируемыми; validator
детерминированно синтезирует metadata legacy relations до current restore.

Дополнение 2026-08-18: unified imported comment history повышает
`schemaVersion` до `9`. Snapshot переносит immutable historical facts и
`comment_migration_outcomes`; schemas `2`–`8` после проверки исходного checksum
нормализуются как native-only comments с пустым reconciliation set. Поскольку
outcome — отдельная audit row для каждой source row, row guard повышен с 1000
до 5000 при неизменных лимитах 10 MB на container и 1.5 MB на row.

Дополнение 2026-08-18: append-only Task Activity повышает `schemaVersion` до
`10`. Snapshot переносит `activity_events` и `activity_migration_outcomes`;
schemas `2`–`9` после проверки исходного checksum нормализуются с пустой
Activity и не получают выдуманный backfill из текущего Task state. Retention
совпадает с lifetime Task, а существующие 5 000 rows/table, 10 MB/container и
1.5 MB/row guards отклоняют oversized export целиком.

Дополнение 2026-08-26: единый recoverable deletion contract повышает
`schemaVersion` до `14`. Snapshot сохраняет `deleted_at`,
`deleted_by_user_id` и `purge_after` у Projects, Releases, Tasks и SavedViews;
tuple только all-null либо all-set, actor существует, timestamps валидны и
cutoff позже delete. Schemas `2`–`13` сначала проверяются по исходному checksum
и только затем получают три `NULL` поля. Operational `entity_purge_jobs` не
переносится: restore восстанавливает product deletion state, а новый runtime
создаёт retry coordination при фактическом purge.

Дополнение 2026-08-27 заменяет прежнюю цепочку совместимости единым текущим
контрактом `schemaVersion = 15`. System import принимает только schema `15`;
schemas `2`–`14` отклоняются до чтения таблиц и не проходят через upgrade.
Машиночитаемый registry классифицирует все 45 application-owned D1 tables и
каждую их колонку. Точно переносятся 24 таблицы, включая `stored_files`,
`attachments.stored_file_id` и `task_sequences`; `task_label_group_values`
перестраивается; workspace sync и purge coordination сбрасываются; API/OAuth
capabilities отзываются; import staging исключается. Для R2 точно переносятся
оригиналы из live namespaces `stored-files` и `attachments`, ключи создаются
заново в целевой среде, `backup-staging` сбрасывается, а неизвестный namespace
делает export/restore неполным и должен быть отклонён.

Текущий transport — потоковый `.tmbak` package с header, канонически
упорядоченными row/object frames и terminal manifest. Durable jobs сохраняют
phase/cursor, hash state, receipts частей, R2 inventory, lease, attempts,
ошибки, expiry, rollback linkage и cleanup state. `rootSha256` связывает
конкретный package, а нормализованный `stateSha256` не зависит от времени
export, физических object keys и R2 etag и потому сравним после exact restore.

## Контекст

Task Manager хранит структурированное product state в Sites D1: Users,
identities, ownership, grants, каталоги и пользовательские records. Внешнего
object storage для native Attachment находится в private R2. Владельцу
приложения нужен переносимый снимок для
восстановления после ошибочного изменения, проверки другой версии и ручной
операционной страховки.

ADR-0001 намеренно ограничивал Administration content-free aggregates. Полный
backup неизбежно содержит email, provider identity keys, titles, descriptions,
saved queries и ACL. Поэтому его нельзя выдавать за расширение aggregate query:
это отдельная высокопривилегированная system operation на той же server-side
admin boundary.

## Решение

1. Administration предоставляет `Export backup` и `Import backup` в отдельном
   блоке «Резервное копирование и восстановление», где чувствительность полного
   `.tmbak` и destructive replacement объяснены до открытия dialog. Общая
   полоса действий shell их не содержит. Вход в Administration остаётся в
   account menu; отдельный пункт в основной левой навигации не показывается.
2. Backup — версионированный logical snapshot, а не raw
   SQLite/SQL dump. Он включает все product, identity, ownership, ACL,
   provenance, native/historical comments, append-only Task Activity,
   reconciliation outcomes, reactions
   archived records и recoverable deletion tuple, но не
   schema/migrations, hosted secrets,
   Sites audience/deployments/analytics, browser-local preferences,
   operational import/purge staging и API/OAuth capabilities. Включая
   `oauth_registered_clients`: регистрация содержит capability metadata и
   после restore выполняется заново, а не переносится как user state.
3. Export выполняет server-side admin check до чтения cross-user данных. Одна
   D1 batch замораживает exact rows в dedicated ledger; затем bounded phase
   runner копирует полный managed R2 inventory в immutable staging и повторно
   сверяет live D1/R2 с замороженным состоянием. Один HTTP advance удерживает
   lease на короткий bounded slice и выполняет несколько внутренних шагов,
   сохраняя cursor после каждого; race прерывает export.
4. В первой версии отдельного Queue/Cron/Workflow нет. Пока `/admin` открыт,
   coordinator уровня приложения продолжает текущий export даже при закрытом
   dialog. Server endpoint поиска current job восстанавливает ту же операцию
   после reload или следующего открытия без зависимости от browser storage.
   Полностью закрытая вкладка честно приостанавливает новые slices; durable job
   продолжает существовать и возобновляется с checkpoint.
5. Import поддерживает только `replace`: merge, selective restore и remapping
   identities не выполняются. Header, каждая bounded часть и terminal manifest
   загружаются отдельно; receipts и staged bytes переживают restart. Preflight
   проверяет registry/fingerprint, порядок, counts, digests, domain topology и
   R2 bytes до изменения live tables.
6. Preview показывает origin/environment, format/schema/fingerprint, время,
   `rootSha256`, `stateSha256`, полные D1 counts, R2 counts/bytes/classes,
   policy summary, warnings и validation errors. До destructive confirmation
   администратор должен скачать текущий backup и ввести `RESTORE`.
7. Backup обязан содержать хотя бы одну provider identity текущего
   администратора. Это предотвращает случайный restore снимка, после которого
   оператор не сможет снова разрешить свою session.
8. До cutover создаётся и валидируется server-side rollback job. Import
   получает exclusive lease; materialization R2 детерминирована и идемпотентна.
   Финальный cutover одной D1 batch заменяет exact rows, выполняет
   rebuild/reset/revoke policies, инвалидирует старые import capabilities,
   фиксирует commit marker и complete old-R2 cleanup ledger. Повторный apply не
   выполняет committed replace снова.
9. Полный state не имеет пользовательского лимита 5 000 rows или 10 MB.
   Transport обязан использовать chunked staging с bounded memory; лимиты
   отдельного chunk/row защищают Worker, но не обрезают snapshot. Download
   доступен только после проверки тем же package validator, использует
   `no-store` streaming navigation и допускает resume с номера части.
10. API принимает только same-origin application requests с явным custom action
   header. Client flags и наличие кнопки не участвуют в authorization.
11. System backup capability выдаётся тому же hosted allowlist, что и текущий
    application administrator. Она не становится `AccessGrant` и не даёт
    обычным repository methods возможность просматривать чужие records.
12. Успешный replace удаляет все API credentials в той же D1 batch transaction.
    После restore каждый User обязан выдать новый token.
13. Current schema переносит фактически существующие originals byte-for-byte
    bounded object-chunk frames; live R2 keys, signed URLs и derived thumbnails
    не входят. Logical slot сохраняется и для lifecycle rows без bytes:
    ready/available state требует object, а допустимые failed/expired/
    transitional/deleted states могут его не иметь. Любой существующий managed
    object включается, в том числе orphan; size/checksum mismatch, broken ref
    или unknown namespace блокируют import до mutation.
14. Permanent Task/Project purge удаляет R2 originals до финального удаления
    D1 metadata. Ошибка оставляет durable retryable operational job; logical
    backup не переносит этот job и не может объявить незавершённый cleanup
    выполненным. Bounded maintenance после `purge_after` не гарантирует точное
    wall-clock время физического удаления.

## Последствия

- Администратор теперь технически может прочитать содержимое всех records из
  экспортированного файла. Документы больше не должны утверждать абсолютное
  отсутствие такого доступа; content-free остаётся именно overview surface.
- Logical snapshot устойчив к D1 internal tables и не может менять schema.
  Новый backup format либо in-memory migrator необходим при несовместимом
  изменении application schema.
- Import обязан валидировать foreign references и domain invariants полностью,
  поскольку текущая D1 schema не полагается на database foreign keys.
- Operational staging временно дублирует rows в D1 и package/object chunks в
  R2. Janitor bounded-шагами очищает expired jobs, parts, multipart/staged и
  materialized-orphan state. Ошибка post-commit cleanup видна как
  `cleanup_pending` и безопасно повторяется.
- Отказ от отдельной очереди сохраняет первую версию маленькой, но означает,
  что завершение export не гарантируется при полностью закрытом браузере. Это
  явная продуктовая граница, а не скрытое фоновое обещание.
- Control-plane D1 export/Time Travel остаются дополнительной операторской
  страховкой, но не являются доступным пользователю in-app contract Sites.

## Не входит в первую версию

- merge и partial restore;
- перенос backup между Sites с remapping provider identities;
- scheduled backups и долговременное хранение в R2;
- шифрование файла собственным backup key;
- включение hosted configuration, secrets, analytics или deployment history.

## Источники

- [Sites: durable storage, access и environment values](https://learn.chatgpt.com/docs/sites)
- [Cloudflare D1 batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
