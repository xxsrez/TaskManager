# API для агентов

Статус: `Implemented`

Последнее обновление: 2026-08-19

## 1. Назначение и граница

Task Manager предоставляет самостоятельный versioned data plane, через который
обычный HTTPS client или native MCP connector может без Web UI:

- получить карту доступной работы и каталог workflow statuses;
- найти проекты и готовящиеся релизы;
- получить задачи проекта или релиза в компактной форме;
- загрузить полный контекст одной выбранной задачи;
- создать задачу с базовыми metadata и изменить title/description, status,
  priority, assignee, release, estimate, due date, archive и manual rank;
- назначить/снять один Label, атомарно заменить весь набор Labels, установить
  или очистить parent и создать subtask;
- читать bounded native/historical Task Activity без загрузки event bodies в
  Task collections/detail;
- читать unified native/historical comment threads, добавлять/reply/edit/delete
  native comments, менять reaction и resolve/reopen state;
- отдельно перечислять, загружать, скачивать и удалять private native Task
  attachments; raster ref можно затем вставить в description через обычный
  versioned `update_task`.
- создавать, менять и удалять native Task relations по canonical Task refs и
  stable relation ref.

API не является обёрткой над `/api/bootstrap`: list queries не загружают и не
возвращают описания всех задач. UI и внешний API используют одну D1-модель и
одинаковые owner/ACL-инварианты, но разные response projections.

Administration, system backup/restore, sharing, ownership transfer, настройка
workflow и управление credentials во внешний API не входят. Это control-plane,
а не task-oriented operations. В текущий scope входит один официальный Task
Manager plugin/skill для Codex и ChatGPT.

REST/write boundary зафиксирован в
[ADR-0006](../decisions/0006-standalone-agent-api.md), OAuth/MCP delivery — в
[ADR-0008](../decisions/0008-oauth-mcp-connector.md).

## 2. Архитектура и progressive disclosure

```mermaid
flowchart LR
    C["Codex / ChatGPT"] --> M["Remote MCP /api/mcp"]
    H["HTTP client"] --> R["REST /api/agent/v1"]
    M --> I["OAuth token и scopes"]
    R --> I
    I --> Q["ACL-scoped query/command service"]
    Q --> D["Domain repositories"]
    D --> DB[("Sites D1")]
```

- Collections возвращают фиксированные summaries.
- `TaskSummary` не содержит `description`, native/imported comment bodies,
  attachment URLs, relation bodies, internal IDs или user email.
- `ProjectSummary` не содержит description; `ReleaseSummary` не содержит ни
  description, ни release notes.
- Полный `TaskDetail` читается только отдельным запросом.
- Task Activity, unified comments и native attachment metadata читаются
  разными отдельными endpoints; provider provenance отсутствует в contract, а binary body возвращает
  только отдельный bearer-protected content endpoint.
- `fields=*` и `include=description` не поддерживаются и отклоняются.

## 3. Authentication, OAuth и credentials

Основной connector flow:

1. Client читает Protected Resource Metadata для `https://<site>/api/mcp` и
   Authorization Server Metadata на том же site origin.
2. Client либо использует HTTPS Client ID Metadata Document (CIMD), либо
   регистрирует public client через `POST /oauth/register`; затем генерирует
   PKCE S256 и передаёт `resource=https://<site>/api/mcp`.
3. `/oauth/authorize` использует Sites `Sign in with ChatGPT`, показывает
   consent и выдаёт одноразовый authorization code.
4. `/oauth/token` проверяет client ID, redirect, resource и verifier, затем
   возвращает непрозрачные access/refresh tokens.
5. MCP принимает `Authorization: Bearer tm_oat_...`, повторно проверяет expiry,
   revoke, resource audience и scopes до создания tool context.

Sites browser cookie и `oai-authenticated-user-*` headers не являются API
authentication от client. Они доверяются только authorization endpoint на
server boundary и сопоставляют OAuth grant тому же внутреннему User, что UI.

OAuth lifecycle:

- authorization request — 10 минут, code — 5 минут, access token — 15 минут;
- refresh token — до 30 дней с rotation; reuse старого refresh token отзывает
  всю token family и grant;
- поддерживаются scopes `api:read` и `api:write`; write автоматически включает
  read;
- token/code/refresh secrets сохраняются только как SHA-256 hashes;
- client secret, implicit flow и password grant не поддерживаются;
- consent page разрешает form navigation только на собственный origin и точный
  origin зарегистрированного `redirect_uri`, после POST используется `303`;
- CIMD origin разрешается server allowlist; dynamic registration принимает
  только public clients без client secret и redirect на разрешённый HTTPS
  origin либо loopback HTTP URI native client;
- redirect должен совпасть буквально; несколько одинаковых значений
  `resource` принимаются как одно, а конфликтующие значения отклоняются.

Authorization Server Metadata публикует `registration_endpoint`. Codex Desktop
может автоматически зарегистрировать свой локальный OAuth client во время
первого Connect/Login; пользователю не требуется создавать или переносить
`client_id` вручную.

Personal token `tm_pat_...` сохранён для scripts, local smoke и REST clients:

- создаётся authenticated User и показывается только один раз;
- хранится как SHA-256 hash и безопасный prefix;
- по умолчанию действует 90 дней, допустимый срок — 1–365 дней;
- повторно применяет owner/ACL scope и не наследует admin capability.

Browser-authenticated control plane, не входящий во внешний OpenAPI contract:

| Method и path | Назначение |
|---|---|
| `GET /api/settings/api-credentials` | Metadata личных credentials без token/hash |
| `POST /api/settings/api-credentials` | Выдать token: `name`, `scopes`, `expiresInDays` |
| `DELETE /api/settings/api-credentials/{id}` | Отозвать личный token |
| `GET /api/settings/oauth-connections` | Активные OAuth grants без secrets |
| `DELETE /api/settings/oauth-connections/{id}` | Отозвать grant и его tokens |

Публичный protocol endpoint `POST /oauth/register` не использует browser
session: он выдаёт только opaque `client_id` для проверенного public-client
metadata и не предоставляет доступ к данным до отдельного consent пользователя.

Logical backup не переносит credentials, OAuth grants, codes или tokens. Full
restore атомарно отзывает все authentication capabilities, чтобы они не
пережили замену identity/data state.

## 4. References

- Task, Project, Release и SavedView используют immutable database `public_id` как
  `ref`.
- Task также возвращает текущий `identifier` (`TM-123`). Для detail/update
  lookup принимаются canonical identifier и прежние aliases. Несколько
  доступных совпадений дают
  `ambiguous_reference` с безопасным списком кандидатов.
- WorkflowStatus и Label не раскрывают internal IDs. Их `sts_...` и
  `lbl_...` refs детерминированно выводятся через SHA-256.
- User IDs и email не публикуются. Assignee содержит только `displayName` и
  `isCurrentUser`.
- Comment `ref` является immutable internal identity, безопасной только внутри
  уже ACL-разрешённой Task. Author содержит `displayName` и `isCurrentUser` без
  User ID/email.

## 5. REST v1

Базовый prefix: `/api/agent/v1`. OpenAPI 3.1 доступен через
`GET /api/agent/v1/openapi.json` без доступа к пользовательским данным.

| Method и path | Scope | Результат |
|---|---|---|
| `GET /workspace` | `api:read` | Counts, capabilities и status catalog |
| `GET /projects` | `api:read` | Paginated `ProjectSummary[]` |
| `GET /projects/{ref}` | `api:read` | `ProjectDetail` и compact releases |
| `GET /releases` | `api:read` | Paginated `ReleaseSummary[]` |
| `GET /releases/{ref}` | `api:read` | `ReleaseDetail` с release notes |
| `GET /views` | `api:read` | Paginated SavedViews с query/display/scope/version |
| `GET /views/{ref}` | `api:read` | Один SavedView с полным persisted contract |
| `GET /labels` | `api:read` | Bounded native Labels доступных owner catalogs |
| `GET /tasks` | `api:read` | Paginated `TaskSummary[]` |
| `POST /tasks` | `api:write` | Создать Task и вернуть `TaskDetail` |
| `GET /tasks/{ref}` | `api:read` | Один `TaskDetail` |
| `GET /tasks/{ref}/activity` | `api:read` | Paginated native/historical Activity events |
| `PATCH /tasks/{ref}` | `api:write` | Изменить Task с optimistic version |
| `POST /tasks/{ref}/move` | `api:write` | Атомарно перенести Task и вернуть authoritative identifier |
| `PUT /tasks/{ref}/labels` | `api:write` | Атомарно заменить полный набор Labels с Task version |
| `PUT /tasks/{ref}/labels/{labelRef}` | `api:write` | Идемпотентно назначить active Label |
| `DELETE /tasks/{ref}/labels/{labelRef}` | `api:write` | Идемпотентно снять Label, включая archived |
| `POST /tasks/{ref}/relations` | `api:write` | Создать relation идемпотентно |
| `PATCH /tasks/{ref}/relations/{relationRef}` | `api:write` | Изменить type/direction с relation version |
| `DELETE /tasks/{ref}/relations/{relationRef}` | `api:write` | Удалить relation с relation version |
| `GET /tasks/{ref}/attachments` | `api:read` | Paginated native Attachment metadata |
| `POST /tasks/{ref}/attachments` | `api:write` | Bounded binary upload с idempotency key |
| `GET /tasks/{ref}/attachments/{attachmentRef}` | `api:read` | Metadata и private content links |
| `PATCH /tasks/{ref}/attachments/{attachmentRef}` | `api:write` | Restore с optimistic version |
| `DELETE /tasks/{ref}/attachments/{attachmentRef}` | `api:write` | Recoverable delete с optimistic version |
| `GET /tasks/{ref}/attachments/{attachmentRef}/content` | `api:read` | Original/thumbnail; original поддерживает Range |
| `GET /tasks/{ref}/comments` | `api:read` | Paginated native root threads с bounded replies |
| `POST /tasks/{ref}/comments` | `api:write` | Создать root/reply с idempotency key |
| `GET /tasks/{ref}/comments/{commentRef}` | `api:read` | Один полный native thread |
| `PATCH /tasks/{ref}/comments/{commentRef}` | `api:write` | Изменить собственный comment с version |
| `DELETE /tasks/{ref}/comments/{commentRef}` | `api:write` | Создать tombstone с version |
| `PUT /tasks/{ref}/comments/{commentRef}/reactions` | `api:write` | Задать desired reaction state |
| `PUT /tasks/{ref}/comments/{commentRef}/resolution` | `api:write` | Resolve/reopen root с version |

Project/Release/SavedView endpoints read-only: они нужны для ориентации, task
scope и чтения актуальной query/display конфигурации.
Нативное UI изменение Project не расширяет `api:write`; remote Project
или SavedView mutation появится только вместе с отдельно документированным
OAuth scope. Task query принимает явные filters и не зависит от UI display
configuration.

### 5.1 Remote MCP connector

Endpoint: `/api/mcp` (Streamable HTTP; stateless compatibility для актуальных
protocol revisions).

| Tool | Scope | Назначение |
|---|---|---|
| `get_workspace` | `api:read` | User, capabilities, counts и status catalog |
| `list_projects`, `get_project` | `api:read` | Найти Project, releases и допустимые statuses |
| `list_releases`, `get_release` | `api:read` | Найти Release и его task scope |
| `list_views`, `get_view` | `api:read` | Прочитать SavedView query, Display, scope и version |
| `list_labels` | `api:read` | Найти active либо archived Label и canonical ref |
| `list_tasks` | `api:read` | Все доступные Tasks или filters Project/Release/status/priority/assignee/search |
| `get_task` | `api:read` | Полный контекст выбранной Task и актуальная version |
| `list_task_activity` | `api:read` | Читать bounded native/historical Activity отдельно от Task detail |
| `create_task` | `api:write` | Создать Task по canonical refs |
| `update_task` | `api:write` | Изменить Task с optimistic version |
| `move_task` | `api:write` | Атомарно перенести Task между Projects |
| `set_task_parent`, `create_subtask` | `api:write` | Менять hierarchy по canonical refs и versions |
| `add_task_label`, `remove_task_label` | `api:write` | Задать желаемое состояние одного native Label идемпотентно |
| `replace_task_labels` | `api:write` | Атомарно заменить полный набор Labels с Task version |
| `create_task_relation` | `api:write` | Создать native relation с idempotency key |
| `update_task_relation`, `delete_task_relation` | `api:write` | Изменить или удалить relation по current version |
| `list_task_attachments`, `get_task_attachment` | `api:read` | Читать bounded native metadata и private content links |
| `upload_task_attachment` | `api:write` | Принять native OpenAI file input и идемпотентно сохранить binary |
| `delete_task_attachment` | `api:write` | Recoverable delete с optimistic version |
| `list_task_comments`, `get_task_thread` | `api:read` | Читать unified native/historical threads отдельно от Task detail |
| `add_task_comment`, `reply_to_task_comment` | `api:write` | Создать root/reply идемпотентно |
| `edit_task_comment`, `delete_task_comment` | `api:write` | Изменить собственный native comment или создать разрешённый native tombstone; historical всегда immutable |
| `set_comment_reaction` | `api:write` | Задать reaction `active=true|false` |
| `resolve_task_thread` | `api:write` | Resolve/reopen root thread |

`tools/list` сохраняет канонические имена без namespace. Codex app runtime
может отправлять вызов как `task_manager.<tool>`; transport boundary снимает
только этот известный prefix перед MCP dispatch.

Рекомендуемый agent flow: `get_workspace` → разрешить Project/Release через
list/get → вызвать compact `list_tasks` → выбрать candidate → `get_task` → при
явном намерении пользователя create/update. Если пользователь просит «все» и
`hasMore=true`, agent продолжает с `nextCursor`; иначе не загружает страницы
без необходимости.

Каждый tool публикует read/write annotations и OAuth security metadata. При
недостаточном scope write tool возвращает `mcp/www_authenticate`, чтобы client
мог повторно запустить Connect flow с `api:write`.

Для регистрации нового connector без bearer token доступны только безопасные
MCP discovery methods: `initialize`, `notifications/initialized`, `ping` и
`tools/list`. Они раскрывают protocol capabilities и схемы task-oriented tools,
но не пользовательские данные. Любой `tools/call` проходит bearer verification,
scope check и owner/ACL scope до обращения к repository.

### 5.2 Parity matrix базовых Task metadata

| UI capability | Agent REST v1 | MCP tool | Marketplace adapter documentation |
|---|---|---|---|
| title, description, status, priority, assignee, release, estimate, due date, archive/restore, rank | `PATCH /tasks/{ref}` | `update_task` | current version + canonical status/release refs; assignee передаётся write-only `assigneeEmail`, `null` очищает |
| create с базовыми metadata и Labels | `POST /tasks` | `create_task` | canonical `projectRef`, optional `releaseRef`/`statusRef`/`labelRefs`; `assigneeEmail` проверяется по Project access |
| add/remove одного Label | `PUT`/`DELETE /tasks/{ref}/labels/{labelRef}` | `add_task_label`, `remove_task_label` | desired-state idempotency; archived Label можно снять, но нельзя назначить |
| replace полного набора Labels | `PUT /tasks/{ref}/labels` | `replace_task_labels` | current Task version + полный `labelRefs[]`; пустой список очищает все назначения, уже назначенный archived Label можно сохранить или снять |
| set/change/clear parent | `PUT`/`DELETE /tasks/{ref}/parent` | `set_task_parent` | same-Project, no self/cycle, current child version |
| create subtask | `POST /tasks/{ref}/subtasks` | `create_subtask` | current parent version; Project наследуется, metadata/Labels создаются атомарно |
| blocks/blocked_by, related, duplicate_of/duplicates | relation `POST`/`PATCH`/`DELETE` | `create_task_relation`, `update_task_relation`, `delete_task_relation` | create idempotency key; update/delete relation version; `taskVersion` для перехода в `duplicate_of` |

`blocked_by` и `duplicates` — относительные read presentations, а не хранимые
relation types. Cross-Project relation допустима только при `Editor+` на обеих
Project Tasks и не распространяет ACL. REST и MCP вызывают один
application/repository boundary; отдельной connector-реализации business rules
нет.

Явно не поддерживаются generic Task move через `PATCH`, изменение Project,
Label или Workflow catalog, sharing/ownership, administration, backup/restore,
irreversible purge, а также comments/attachments внутри generic metadata patch.
Для move, comments и attachments сохраняются отдельные специализированные
contracts.

In-repo MCP `tools/list`, OpenAPI и этот документ являются исходной tool
metadata для marketplace adapter. Версия/manifest опубликованного
`task-manager@srez-marketplace` меняются только в marketplace repository и
проверяются после установки в новой Codex-задаче; локальная реализация этого
контракта сама по себе не является публикацией plugin package.

### 5.3 Pagination и envelope

Collections имеют default `limit=50`, maximum `200` и opaque `cursor`.
Native attachments имеют maximum `100`; Activity events и unified comment roots — maximum `50`
и до 100 replies на root. Cursor связан с Task, filters,
sort и limit;
cursor другого query отклоняется. Collections используют keyset position из
стабильного sort value и immutable `public_id`, поэтому вставка или удаление
строки на уже прочитанной странице не сдвигает следующую страницу. Offset
не используется для provenance summary.

```json
{
  "data": [],
  "page": { "nextCursor": null, "hasMore": false },
  "meta": {
    "apiVersion": "1",
    "asOf": "2026-08-14T16:00:00.000Z",
    "requestId": "req_..."
  }
}
```

Data responses используют `Cache-Control: private, no-store` и
`X-Request-Id`.

### 5.4 Filters

`GET /tasks` поддерживает:

- `project_ref`, `release_ref`;
- повторяемые или comma-separated `status_category` и `priority`;
- `assignee=me|unassigned`, `archived=true|false`;
- bounded prefix `search` по identifier/title без full-scan contains;
- `order=manual|updated|created|priority|due|title`;
- `direction=asc|desc`.

REST/MCP параметры переводятся в тот же versioned Task filter AST и SQL
executor, что Saved Views и UI. Внешний API намеренно сохраняет bounded prefix
семантику `search`; это compile mode общего executor, а не отдельный набор
ACL/filter predicates. Cursor order/predicate добавляется после того же
authoritative filtered Task set.

`GET /projects` поддерживает prefix `search` по name/summary и `archived`.
`GET /releases` — `project_ref`, повторяемый `status`, prefix `search` по
name. Неизвестные parameters отклоняются.

## 6. Representations

`TaskSummary` содержит `ref`, `identifier`, `title`, status, priority,
compact project/release/assignee/labels, dueDate, updatedAt, version и
`contextHints`. Summary сообщает о наличии detail context, но не передаёт body.

`Label` содержит canonical `lbl_...` ref, name, color, description,
`archivedAt`, version и только флаг `owner.isCurrentUser`; internal ID и owner
identity не раскрываются. `GET /labels` по умолчанию возвращает active labels
owner catalogs, доступных через owned/shared Projects; `archived=true` добавляет
архивные labels для исторического чтения и снятия.

`TaskDetail` добавляет description, estimate, rank, lifecycle timestamps,
access role/canEdit, расширенный project/release context, parent, subtasks,
relations. Native `commentCount` и `attachmentCount`
присутствуют только как context hints; bodies/metadata читаются через
`/activity`, `/comments` и `/attachments`. Activity event содержит `ref`,
`eventType`, privacy-minimized actor display snapshot/kind, structured payload,
provider-neutral `source=native|historical`, timestamp и schema version; User
ID/email и migration source identifiers не выдаются. Historical comment bodies
находятся в том же `/comments`; source
URLs, legacy attachment links, branch metadata и reconciliation counts в Agent
API не возвращаются. Detail также возвращает `availableStatuses`,
валидные для изменения именно этой Task.

`ProjectSummary` возвращает name, code/lock/sequence, summary, lifecycle
status, start/target dates, icon/color, archivedAt, task counts, progress,
release count, updatedAt и version. Detail добавляет Markdown description,
current lead и compact releases. `ReleaseSummary` возвращает project, name, status, dates,
task counts, progress, updatedAt и version; detail добавляет description и
release notes. Project/Release detail возвращают `workflowStatuses`, валидные
для создания Task в этом scope. Задачи release читаются через
`GET /tasks?release_ref=...`.

## 7. Task commands

`POST /tasks` принимает `title`, `description`, `statusRef`, `priority`,
`projectRef`, `releaseRef`, write-only `assigneeEmail`, `labelRefs`, `estimate`,
`dueDate` и optional
`confirmReleasedComposition`. Обязательны `title` и
canonical `projectRef`; release не заменяет явный Project.
Несовместимые project/release и status другого owner scope отклоняются до записи.
Каждый `labelRef` обязан обозначать active Label owner catalog выбранного
Project; assignee обязан быть зарегистрированным User с доступом к Project.
Все эти поля записываются одной Task-create transaction.

`PATCH /tasks/{ref}` требует актуальный `version` и принимает `title`,
`description`, `statusRef`, `priority`, `projectRef`, `releaseRef`,
write-only `assigneeEmail`, `estimate`, `dueDate`, `rank`, `archived`,
`confirmReleasedComposition`.
Generic patch не очищает и не меняет
Project; отдельный атомарный move contract меняет Project и identifier вместе.

`POST /tasks/{ref}/move` требует `version` и canonical `targetProjectRef`.
Optional `releaseRef` и write-only `assigneeEmail` принимают compatible value
либо явный `null`; если текущие значения несовместимы, отсутствие поля является
validation error. Если операция добавляет Task в выпущенный Release либо
удаляет её оттуда, caller обязан явно передать
`confirmReleasedComposition=true`; тот же флаг доступен create/subtask
contracts и MCP schemas. Server проверяет edit access к обеим сторонам, active target
и hierarchy, затем в одной transaction резервирует target sequence, меняет
Project/identifier, записывает alias и применяет dependent changes. Same-Project
возвращает неизменённую Task. Ответный `TaskDetail.identifier` authoritative;
preview номера не является reservation. MCP tool `move_task` вызывает тот же
command service и использует те же canonical refs/version.

`PUT /tasks/{ref}/parent` принимает current child `version` и nullable
`parentTaskRef`; `DELETE /tasks/{ref}/parent` принимает `version` и выполняет
detach. Parent обязан быть доступной Task того же Project, self/cycle и
archived target отклоняются. Desired state, уже применённый к той же version,
возвращает текущий detail без лишней записи. MCP `set_task_parent` использует
тот же contract.

`POST /tasks/{ref}/subtasks` принимает current parent `version`, обязательный
`title`, write-only `assigneeEmail`, `labelRefs` и optional Task fields кроме
Project. Project наследуется, identifier
выделяется внутри атомарной transaction, а parent version повышается; stale
retry не создаёт duplicate. MCP `create_subtask` использует те же canonical
refs и возвращает authoritative child `TaskDetail`.

`description` может содержать native raster embed
`![alt](attachment:v1:<public-ref> "optional caption")` и downloadable file link
`[label](attachment:v1:<public-ref>)`. Сначала Attachment должен стать `ready`
в этой же Task через Agent REST upload или MCP `upload_task_attachment`, затем
ref вставляется обычным versioned Task update. Image embed дополнительно требует
`kind=image`; file link допускает ready file/image. Общий repository path для
REST, MCP и UI игнорирует literal inline/fenced code и отклоняет malformed,
cross-Task, incompatible, deleted или неготовый reference без подтверждения
существования недоступного resource. Task create с native reference отклоняется,
потому что Attachment ещё не может принадлежать создаваемой Task.

```json
{
  "version": 7,
  "statusRef": "sts_...",
  "archived": false
}
```

Repository атомарно обновляет `startedAt`, `completedAt` и `canceledAt` из
системной категории status. Устаревшая version даёт
`409 version_conflict`; Viewer — `403 forbidden`. Response содержит новый
`TaskDetail`, а не workspace snapshot.

Assignee другого User задаётся только write-only verified email и никогда не
возвращает email/User ID в projection. Labels имеют отдельные desired-state
`PUT`/`DELETE` и MCP add/remove commands:
Editor+ может назначить active Label только owner catalog Task, Viewer получает
отказ, retry не создаёт дубликат и archived Label можно снять, но нельзя
назначить заново. `PUT /tasks/{ref}/labels` и MCP `replace_task_labels`
принимают current Task version и атомарно заменяют полный набор; успешная
single add/remove или replace возвращает detail с актуальной Task version.
Relations имеют отдельные create/update/delete commands: обе Tasks должны
принадлежать Project, caller должен иметь Editor+ на обеих, `related`
канонизируется, `blocks` хранит direction, а outgoing `duplicate_of` требует
актуальную Task version и атомарно назначает системный `Duplicate`. Remove или
смена type не восстанавливает прежний status. Task create ещё не имеет
server-side idempotency record,
поэтому client не должен слепо повторять POST после неизвестного network outcome.

Relation create требует `targetTaskRef`, `type`, `direction` и
`idempotencyKey`; retry одного semantic command с тем же key возвращает ту же
relation. Update/delete используют stable `relationRef` из `get_task` и
актуальную relation `version`. Relation detail возвращает relative
`direction`/`presentation`, peer compact Task и timestamps без internal Task IDs.

### 7.1 Comment commands

`POST /tasks/{ref}/comments` принимает `body`, обязательный `idempotencyKey` и
optional `parentCommentRef`. Author берётся из bearer identity; неизвестные
поля, включая client-provided author, отклоняются. Reply на reply сохраняется
как reply root thread, новый reply переоткрывает resolved root.

Edit/delete/resolve требуют актуальный comment `version`. Edit разрешён только
author; delete — author либо Owner/Manager соответствующего Project и оставляет
tombstone. Любой comment write требует `api:write` и effective Editor или выше;
Viewer сохраняет read access. Reaction PUT принимает `emoji` и desired boolean
`active`; composite uniqueness делает retry безопасным.

Body нормализует line endings, отбрасывает внешний whitespace, запрещает empty,
unsupported control characters и размер больше 100 000 characters. Он остаётся
Markdown-like text: transport не принимает raw rendered HTML. Reactions
возвращаются как aggregate count + `reactedByCurrentUser`, без списка Users.

### 7.2 Native attachment commands

`POST /tasks/{ref}/attachments` принимает raw binary body. Обязательны
`Idempotency-Key`, percent-encoded `X-Attachment-Filename` и фактический
`Content-Type`; сервер всё равно проверяет magic bytes, размер, raster
dimensions и SHA-256. Response не содержит internal Task/uploader IDs, R2 key,
public или долговечный signed URL. Original/thumbnail URLs указывают только на
Agent API и требуют тот же bearer token при каждом чтении.

`GET /tasks/{ref}/attachments` использует стабильную keyset pagination по
`createdAt/ref`. `include_deleted=true` доступен только Editor и выше. Delete
требует `X-Attachment-Version`, остаётся recoverable в grace period и
отклоняется, пока description использует image ref; REST `PATCH` с
`{"version": n, "deleted": false}` выполняет restore.

MCP `upload_task_attachment` следует актуальному OpenAI file-input contract:
верхнеуровневое поле `file` объявлено в `_meta["openai/fileParams"]`, содержит
обязательные `download_url`/`file_id` и optional `mime_type`/`file_name`.
Временный URL не сохраняется и не логируется. Worker принимает только HTTPS URL
на OpenAI/OpenAIusercontent host, не передаёт credentials, вручную проверяет
каждый redirect и ограничивает как declared, так и фактически прочитанный body.
После server fetch действуют те же content inspection, idempotency и Task ACL,
что для REST/UI upload. Contract основан на официальном
[OpenAI plugin reference](https://developers.openai.com/plugins/reference).

## 8. Errors и authorization

Error envelope:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "Task was changed in another session",
    "requestId": "req_..."
  }
}
```

Codes: `unauthenticated`, `insufficient_scope`, `invalid_argument`,
`not_found`, `ambiguous_reference`, `forbidden`, `version_conflict`,
`internal_error`. Неизвестный и недоступный resource дают одинаковый
`not_found`.

Authorization invariants:

1. OAuth grant или personal credential сопоставляется внутреннему User до data query.
2. ACL применяется до filters, pagination, counts, ambiguity и relations.
3. Project roles распространяются на все Tasks/Releases как в UI; прямого Task
   grant нет.
4. `api:write` разрешает только task commands и не отменяет resource role.
5. API не вызывает admin, backup/restore, sharing, ownership transfer или
   credential management.
6. Token, hash, internal IDs, emails и response bodies не логируются.
7. Comment lookup всегда начинается с ACL-разрешения parent Task; comment ref
   сам по себе не подтверждает существование thread.

## 9. Версионирование и проверка

- REST major version находится в path; breaking changes создают `/v2`.
- Additive optional fields допустимы в v1, удаление/переименование — нет.
- Runtime OpenAPI document является внешним transport contract.
- UI `/api/bootstrap` остаётся внутренним.

Обязательные сценарии:

1. Codex Desktop получает зарегистрированный Task Manager app connector из
   plugin `.app.json`; OAuth Connect через выбранный connector builder DCR
   (`/oauth/register`) выполняет
   `workspace → create → compact search → detail → status update` без Sites
   headers. Raw MCP clients также могут использовать DCR или разрешённый CIMD.
2. Marker из description отсутствует в list и появляется только в detail.
3. Status transition меняет timestamps/version; stale version даёт `409`.
4. Read-only и revoked/expired token получают соответственно `403` и `401`;
   refresh rotation не допускает reuse.
5. Owner/Editor/Viewer и post-revoke access совпадают с UI.
6. Project/release filters не раскрывают недоступный resource.
7. Full restore отзывает personal/OAuth capabilities, не включая secrets или
   hashes в backup.
8. MCP `tools/list` показывает только task-oriented surface; `list_tasks`
   фильтрует по Project и Release, сохраняет compact/detail boundary и cursor.
9. Новый connector получает `initialize` и `tools/list` без bearer token, но
   анонимный `tools/call` получает `401` и не выполняет repository query.
10. Native comment create retry не дублирует row; Viewer читает, но не пишет;
    reply открывает resolved thread; stale edit/delete/resolve получает conflict;
    Agent author projection не содержит ID/email. Historical author имеет
    `kind=historical`, `id=null`; source facts нельзя edit/delete, но Editor+
    может reply/react/resolve. Provider provenance и raw migration evidence не
    входят ни в Task detail, ни в отдельный public endpoint/tool.
11. Agent REST upload/list/get/range/delete повторяет Task ACL, не публикует
    internal IDs/R2 keys и сохраняет стабильную attachment pagination. MCP
    `tools/list` объявляет четыре attachment tools, а upload schema содержит
    `_meta["openai/fileParams"]`; invalid/private redirect, oversized body,
    MIME mismatch и stale version отклоняются до небезопасной mutation.
12. Agent REST/MCP relation create retry сохраняет один stable relation ref;
    stale update/delete конфликтует, Viewer не пишет, ACL проверяется на обеих
    Tasks, а outgoing duplicate atomically меняет source status. `get_task`
    показывает resolved blocker как `related` и не раскрывает internal Task IDs.
13. `GET /tasks/{ref}/activity` и MCP `list_task_activity` возвращают одинаковую
    bounded page native/historical events. Viewer читает, outsider/post-revoke
    получает `not_found`; actor projection не содержит ID/email, cursor другой
    Task отклоняется, а Task list/detail не получает event bodies.
14. REST и MCP создают Task с assignee/Labels и изменяют базовые metadata с
    read-back новой Task version; атомарный replace Labels отклоняет stale
    version без partial write. Hierarchy отклоняет self/cycle/cross-Project и
    stale version; relation retry сохраняет одну identity, cross-Project
    relation требует write access к обеим Tasks, stale relation version не
    изменяет edge.

Hosted smoke и rate-limit policy остаются release work, а не заявляются
проверенными локальной реализацией.
