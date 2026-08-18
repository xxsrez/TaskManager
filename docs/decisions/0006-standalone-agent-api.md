# ADR-0006: самостоятельный API для task-oriented clients

Статус: `Accepted`

Дата решения: 2026-08-14

Дополнение: authentication и connector transport расширены
[ADR-0008](0008-oauth-mcp-connector.md). Personal bearer token сохранён для
scripts, но основной Codex/ChatGPT flow теперь использует OAuth + remote MCP.

Дополнение 2026-08-16: task-oriented surface включает отдельные native comment
thread queries/commands; comment bodies не добавляются в Task collections или
detail projection.

Дополнение 2026-08-18: relation surface расширен отдельными versioned
create/update/delete commands. Они используют canonical Task refs, stable
relation ref, create-idempotency и требуют Editor+ на обеих Project Tasks;
`duplicate_of` также требует Task version и атомарно меняет status.

Дополнение 2026-08-18: imported comment bodies читаются через те же unified
comment endpoints, что native discussions. После lossless runtime cutover
`external-context` удалён из REST/OpenAPI/MCP; source URLs, attachment links и
branch metadata не входят в Agent contract.

## Контекст

Web UI использует Sites-authenticated JSON routes и полный
authorization-scoped `AppSnapshot`. Для автономных clients эта модель не
подходит: browser identity недоступна вне Sites session, snapshot загружает
описания и comment bodies всего workspace, а mutations возвращают UI state.

Пользователь потребовал отдельный обычный API, работающий без Web UI. Он должен
покрывать Projects/Releases, compact task search, полный Task detail и task
mutations/status transitions. Administration и другие управленческие операции
в него входить не должны.

## Решение

1. Внешний data plane — REST под `/api/agent/v1` с OpenAPI 3.1.
   `/api/bootstrap` остаётся внутренним UI contract.
2. Collections используют server-enforced compact projections. Entity bodies
   доступны только detail endpoints; unified comments, Activity и native
   Attachments используют отдельные ACL-scoped endpoints.
3. Data plane аутентифицируется personal bearer token, а не Sites
   headers/cookie. D1 хранит только SHA-256 hash, prefix, owner, scopes и
   lifecycle metadata.
4. Browser-authenticated User выдаёт/отзывает credentials через settings
   control plane. После выдачи data API не зависит от Web UI/session.
5. Scopes — `api:read` и `api:write`. Write scope разрешает только создание и
   изменение Tasks и разрешённые comment operations и не отменяет owner/ACL role.
6. Project/Release доступны для чтения и task scope. Их mutations, sharing,
   ownership transfer, workflow configuration, Administration и backup/restore
   отсутствуют во внешнем API.
7. `PATCH Task` требует optimistic `version` и повторно использует repository
   invariants/timestamp transitions. Commands возвращают Task detail.
8. Task/Project/Release используют `public_id`. WorkflowStatus/Label получают
   deterministic opaque `sts_`/`lbl_` ref из SHA-256 internal identity.
9. Credentials исключаются из logical backup. Full restore отзывает их до
   замены data state.

## Последствия

- HTTPS client работает с задачами без браузера после одноразовой выдачи token.
- UI и API разделяют доменные инварианты, но имеют разные query projections.
- Compact/detail boundary уменьшает token cost и privacy blast radius.
- Credential table и migration входят в Sites D1; secret не восстанавливается.
- Первый slice по-прежнему не редактирует labels/hierarchy и не имеет bulk
  commands либо idempotency у `POST /tasks`. Ограничение relations заменено
  последующим дополнением выше; OpenAPI показывает только фактически
  реализованные relation endpoints.
- Comment create имеет собственный idempotency key и отдельную optimistic
  version для edit/delete/resolve; это не меняет отсутствие idempotency record у
  `POST /tasks`.
- Hosted rate limits и audit retention требуют решения после измерения нагрузки.

## Отклонённые варианты

- Использовать `/api/bootstrap` — связывает clients с UI и нарушает progressive
  disclosure.
- Доверять Sites identity headers от external client — подмена trusted boundary.
- Включить admin/sharing/backup «для полноты» — расширяет capability вне scope.
- Создать отдельное хранилище/сервис — дублирует authorization и противоречит
  Sites/D1 modular-monolith решению.
