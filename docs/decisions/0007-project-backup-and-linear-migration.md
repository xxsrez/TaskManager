# ADR-0007: проектный backup и самостоятельная миграция из Linear

Статус: `Accepted`

Дата решения: 2026-08-14

## Контекст

Владельцу Project нужна доступная без application-admin роль страховка от
ошибочного удаления или изменения собственного проекта. Отдельно пользователь
должен самостоятельно перенести данные из Linear, выдав Task Manager
ограниченный read-only доступ и выбрав весь workspace, конкретные Projects либо
issues выбранных assignees.

System backup из ADR-0004 для этого не подходит: он раскрывает состояние всех
пользователей и выполняет полный replace Site. Старый технический Linear import
принимал заранее собранные JSON-файлы, не давал self-service authorization,
preview или выбор scope и записывал данные несколькими независимыми batches.

## Решение

1. Project backup — отдельная owner-only capability. Manager, Editor, Viewer и
   application administrator без роли Owner не получают её через обычный
   product API.
2. Export создаёт versioned logical JSON bundle одного Project. Он включает сам
   Project, Tasks, Releases, project-scoped SavedViews, labels assignments,
   внутреннюю hierarchy/relations, Linear provenance и snapshot используемых
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
   staging namespace и показывает create/update/delete/conflict preview.
6. Для существующего Project apply требует скачать свежий backup, ввести точное
   имя Project и выполняет set-based replace subtree одной D1 `batch()`
   transaction. Ошибка не оставляет частичный restore. Для удалённого Project
   применяется тот же bundle и current owner check.
7. Relations и parent links на Tasks вне bundle не восстанавливаются как live
   связи. Их count и исходный metadata остаются в warnings/provenance, чтобы
   частичный Project не создавал скрытых cross-scope ссылок.
8. Linear migration — one-time import, не sync. Основной вход — OAuth 2.0 с
   `read`, `state` и PKCE S256. Access/refresh tokens не входят в product data;
   после получения bounded snapshot они отзываются и удаляются. В UI это одна
   кнопка `Import from Linear`, а не отдельная постоянная связь с provider.
9. Перед записью пользователь выбирает один scope: весь workspace, один или
   несколько Linear Projects либо один или несколько Linear Users. User scope
   означает issues, где выбранный User является assignee; creator/author scope
   в первой версии отсутствует.
10. Scope closure включает выбранные issues и только необходимые Project,
    milestone, workflow, label, hierarchy, relation, custom-view и archive
    metadata. Ссылки на records вне scope сохраняются как provenance/warnings,
    но не создаются как живые доменные связи.
11. Immutable Linear GraphQL UUID является `ExternalRecord.source_id` и ключом
    идемпотентности; readable issue identifier сохраняется отдельно. Повторный
    import обновляет тот же target и не создаёт дубль.
12. Linear identities не объединяются с Task Manager Users по email
    автоматически. UI показывает явное mapping; current Linear viewer по
    умолчанию сопоставляется с current User, остальные assignees остаются
    unassigned, пока пользователь не выберет доступного зарегистрированного
    User. Migration не создаёт Project grants неявно.
13. Preview сообщает counts, create/update, skipped external references,
    unmapped users и truncated provider collections; collisions отклоняются до
    apply. Apply читает только проверенный staged plan и выполняет его
    atomically.
14. Attachment/comment metadata и исходные URLs сохраняются в provenance.
    Attachment binaries не копируются до появления принятого R2-backed slice.

## Последствия

- Project backup не является уменьшенным system dump: его validator обязан
  учитывать shared catalogs и исторический owner scope child records.
- Staging используется обоими пользовательскими import flows, но не участвует
  в обычных repository queries и автоматически истекает.
- OAuth application `client_id` и optional `client_secret` задаются через
  hosted environment. Если OAuth application ещё не настроено, UI явно
  показывает configuration gap; технический JSON importer больше не считается
  пользовательским flow.
- Eager bounded Linear snapshot позволяет отозвать provider token до выбора
  scope и не хранить bearer secret между пользовательскими шагами.
- Очень большой Linear workspace, превышающий лимит staging, отклоняется до
  записи и требует будущего R2/chunked import, а не частичного молчаливого
  переноса.

## Не входит в первую версию

- расписание backup, server-side retention и автоматическое восстановление;
- merge/copy/cross-Site Project restore;
- постоянная синхронизация, webhooks и обратная запись в Linear;
- Linear scope по creator, subscriber или team membership;
- перенос attachment binaries и native редактирование комментариев.

## Источники Linear

Проверены 2026-08-14:

- [OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)
- [GraphQL API](https://linear.app/developers/graphql)
- [Filtering](https://linear.app/developers/filtering)
- [Pagination](https://linear.app/developers/pagination)
- [Rate limiting](https://linear.app/developers/rate-limiting)
