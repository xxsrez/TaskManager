# ADR-0007: проектный backup и restore

Статус: `Accepted`

Дата решения: 2026-08-14

Дополнение 2026-08-16: Project subtree включает native comments/reactions его
Tasks и проверяет их author/reaction Users как существующие dependencies.
`schemaVersion` Project bundle повышена до `2`; schema `1` не применяется к
новой таблице Tasks с обязательным `comment_count`.

Дополнение 2026-08-18: schema `3` включает native Attachment metadata и bounded
content-addressed originals; schema `2` без Attachments остаётся импортируемой.
Project bundle читает только objects Tasks этого Project. Restore использует
R2 staging/new keys + D1 exact-replace saga и удаляет старые objects только
после успешного cutover.

Дополнение 2026-08-18: native writable relations повышают Project bundle
`schemaVersion` до `5`; immutable relation ID, idempotency key, version и
updated timestamp входят в точный subtree. Schema `2`–`4` остаются
импортируемыми через deterministic metadata upgrade.

Дополнение 2026-08-18: historical imported comments и их reconciliation
outcomes повышают Project bundle `schemaVersion` до `9`. Schema `2`–`8`
остаётся импортируемой как native-only comment state после проверки исходного
checksum.

## Контекст

Владельцу Project нужна доступная без application-admin роли страховка от
ошибочного удаления или изменения собственного проекта. System backup из
ADR-0004 для этого не подходит: он раскрывает состояние всех пользователей и
выполняет полный replace Site.

## Решение

1. Project backup — отдельная owner-only capability. Manager, Editor, Viewer и
   application administrator без роли Owner не получают её через обычный
   product API.
2. Export создаёт versioned logical JSON bundle одного Project. Он включает сам
   Project, Tasks, Releases, project-scoped SavedViews, label assignments,
   внутреннюю hierarchy/relations, native/historical comments,
   reconciliation outcomes/reactions, provenance и
   snapshot используемых
   WorkflowStatuses/Labels. Users, UserIdentities, API credentials, hosted
   secrets, global SavedViews и данные других Projects не включаются.
3. Bundle привязан к исходным immutable IDs, current owner и тому же Site.
   Первая версия поддерживает только точный restore исходного Project, без
   merge, copy-as-new, cross-Site remapping или выборочного восстановления.
4. Export сохраняет active Project grants как отдельные descriptors. Restore
   sharing выключен по умолчанию и включается только отдельным подтверждением;
   получатели должны по-прежнему существовать в том же Site.
5. Import полностью проверяет checksum, owner, ссылки, каталоги, collisions и
   domain invariants до mutation, сохраняет normalized rows в изолированный
   staging namespace и показывает create/update/delete preview.
6. Для существующего Project apply требует скачать свежий backup, ввести точное
   имя Project и выполняет set-based replace subtree одной D1 `batch()`
   transaction. Ошибка не оставляет частичный restore. Для удалённого Project
   применяется тот же bundle и current owner check.
7. Relations и parent links на Tasks вне bundle не восстанавливаются как live
   связи. Их count и исходный metadata остаются в warnings/provenance, чтобы
   частичный Project не создавал скрытых cross-scope ссылок.
8. Attachment originals входят byte-for-byte; logical `sha256:<digest>` refs
   заменяют live object keys. Thumbnail пересоздаётся. Общий container ограничен
   25 MB и полностью проверяет size/checksum, Task ownership и description
   embeds до staging.

## Последствия

- Project backup не является уменьшенным system dump: его validator обязан
  учитывать shared catalogs и исторический owner scope child records.
- Staging не участвует в обычных repository queries и автоматически истекает.
- Backup содержит пользовательский content и должен скачиваться только через
  owner-scoped no-store response.
- Restore sharing не создаёт новых identities и не сопоставляет пользователей
  по одному лишь display name.

## Не входит в первую версию

- расписание backup, server-side retention и автоматическое восстановление;
- merge/copy/cross-Site Project restore;
- выборочное восстановление отдельных Tasks или Releases;
- перенос живых relations к Tasks вне Project bundle.
