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

1. Administration предоставляет `Export backup` и `Import backup`. Вход в
   Administration остаётся в account menu; отдельный пункт в основной левой
   навигации не показывается.
2. В первой версии backup — версионированный logical JSON snapshot, а не raw
   SQLite/SQL dump. Он включает все product, identity, ownership, ACL,
   provenance, native comments/reactions и archived records, но не
   schema/migrations, hosted secrets,
   Sites audience/deployments/analytics, browser-local preferences и
   operational import staging и API credentials. Token hash является
   authentication capability, а не переносимым product data.
3. Export выполняет server-side admin check до чтения cross-user данных,
   считывает все включённые таблицы в одной D1 batch transaction и отдаёт файл
   с `Cache-Control: no-store`.
4. Import первой версии поддерживает только `replace`: merge, selective restore
   и remapping identities не выполняются. Файл полностью валидируется и
   помещается в изолированный staging namespace до изменения live tables.
5. Preview показывает format/schema version, время export и counts. До
   destructive confirmation администратор должен скачать текущий backup и
   ввести `RESTORE`.
6. Backup обязан содержать хотя бы одну provider identity текущего
   администратора. Это предотвращает случайный restore снимка, после которого
   оператор не сможет снова разрешить свою session.
7. Финальный cutover удаляет и восстанавливает live rows одной D1
   `batch()`-транзакцией. Любой SQL failure откатывает весь replace. Успешный
   restore сохраняет operational import session как audit metadata, удаляет
   staged payload и требует полного reload UI.
8. Payload ограничен 10 MB, 1000 application rows и 1.5 MB на одну JSON row.
   Более крупный state требует следующей версии с chunked upload/object storage,
   а не ослабления атомарности.
9. API принимает только same-origin application requests с явным custom action
   header. Client flags и наличие кнопки не участвуют в authorization.
10. System backup capability выдаётся тому же hosted allowlist, что и текущий
    application administrator. Она не становится `AccessGrant` и не даёт
    обычным repository methods возможность просматривать чужие records.
11. Успешный replace удаляет все API credentials в той же D1 batch transaction.
    После restore каждый User обязан выдать новый token.
12. До новой attachment-aware schema export и restore отклоняются, если
    существует native Attachment. Частичный logical snapshot, который сохранил
    бы description token или metadata без соответствующего R2 object, не
    создаётся и не применяется.

## Последствия

- Администратор теперь технически может прочитать содержимое всех records из
  экспортированного файла. Документы больше не должны утверждать абсолютное
  отсутствие такого доступа; content-free остаётся именно overview surface.
- Logical snapshot устойчив к D1 internal tables и не может менять schema.
  Новый backup format либо in-memory migrator необходим при несовместимом
  изменении application schema.
- Import обязан валидировать foreign references и domain invariants полностью,
  поскольку текущая D1 schema не полагается на database foreign keys.
- Operational staging временно дублирует payload в D1 и очищается после restore
  либо по expiry.
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
