# Начальная архитектура

Статус: `Proposed`

Последнее обновление: 2026-08-14

Архитектура реализована первым вертикальным срезом на TypeScript, React 19,
Vinext/Vite, Sites Worker runtime и D1. Выбор и границы authentication
зафиксированы в
[ADR-0003](decisions/0003-implementation-stack-and-auth-delivery.md). Документ
также содержит целевые модули следующих срезов; их наличие здесь не означает,
что весь MVP уже реализован.

## Архитектурные цели

- одна транзакционная модель данных для list, board и saved views;
- быстрые интерактивные mutations с явным разрешением конфликтов;
- строгие project/release и workflow invariants на сервере;
- server-side tenant isolation и authorization для любого data access;
- две внешние identities вокруг одного внутреннего `User`;
- возможность развивать фильтры и metadata без копирования query-логики по UI;
- progressive-disclosure read model для агентов без загрузки task bodies в
  групповых запросах;
- единая Linear-like interaction и component model для list, board, details,
  filters, selection и contextual actions;
- managed deployment и durable structured storage в ChatGPT Sites.

## Контекст

```mermaid
flowchart LR
    U[Пользователь] --> SITE[ChatGPT Site / Web UI]
    AG[HTTP API client] --> RT
    CG[Sign in with ChatGPT] --> RT[Sites server runtime]
    G[Google identity provider] --> RT
    SITE --> RT
    RT --> IA[Identity and Access]
    IA --> D[Domain modules]
    D --> DB[(Sites D1)]
```

ChatGPT Sites — production target, D1 — relational binding для
структурированных пользовательских данных. Приложение использует Vinext/Vite,
prepared D1 queries за repository boundary и Drizzle Kit для versioned SQL
migrations. Это соответствует
[официальной документации Sites](https://learn.chatgpt.com/docs/sites).

## Логические модули

| Модуль | Ответственность |
|---|---|
| Tasks | Task lifecycle, workflow, labels, subtasks, relations, rank |
| Projects | Project metadata, scope и вычисляемый progress |
| Releases | Release lifecycle, состав и project consistency |
| Views | Filter AST, query compilation, grouping, ordering, display config |
| Search | Identifier lookup и text search поверх разрешённого scope |
| Identity | ChatGPT/Google adapters, UserIdentity linking, sessions, current User |
| Access | Ownership scope, AccessGrant inheritance, share/revoke decisions |
| Administration | Server allowlist, content-free overview и explicit full-state backup/restore |
| Portability | Owner Project bundles, validation/preview и atomic exact restore |
| Agent API | Compact/detail projections, versioned REST, remote MCP и OAuth/personal credential scopes |
| UI shell | Linear-like navigation, shared controls, keyboard, themes и state |

Модули — границы кода внутри одного приложения, а не отдельные сервисы. Для MVP
предпочтителен modular monolith: независимое развёртывание этих частей пока не
даёт подтверждённой пользы, но увеличивает транзакционную сложность.

## Hosting и runtime boundary

- Sites project связывается с локальным repository через
  `.openai/hosting.json`, который создаётся/обновляется только provisioning
  workflow и содержит binding metadata, а не secrets.
- Structured records сохраняются через D1 binding. R2 не требуется, пока в
  продукте нет uploads.
- Provider credentials и session secrets задаются только в hosted environment
  settings; локально перечисляются лишь имена переменных в `.env.example`.
- `TASK_MANAGER_ADMIN_EMAILS` хранится в hosted environment и разбирается как
  нормализованный comma-separated allowlist. Значение не коммитится в source.
- Save version создаёт reviewable deployment candidate; Deploy version делает
  выбранную версию production. Documentation-only изменение этого репозитория
  не является deployment.
- Site может быть доступен в интернете как sign-in shell, но application data
  всегда требует authenticated User. Site audience и in-app authorization
  проверяются независимо.
- Sites находится в public beta, зависит от plan/region/workspace settings и на
  старте не предоставляет data residency guarantees. Эти ограничения должны
  быть повторно проверены перед production release.

## Основные потоки

### Вход и identity linking

1. Пользователь выбирает ChatGPT либо Google.
2. Sites ChatGPT flow возвращает trusted email/name headers server runtime;
   Google adapter завершает проверенный OAuth/OIDC flow.
3. Identity module находит `UserIdentity` по `(provider, provider_account_key)`
   либо создаёт новый User и identity.
4. Связать второй provider можно только из authenticated session через flow,
   доказывающий контроль над обеими identities; email match не достаточен.
5. Session содержит internal `User.id`; client-provided user/email/owner claims
   не участвуют в authorization.

### Авторизованный доступ к данным

1. Identity middleware устанавливает current User из server-verified session.
2. Access вычисляет effective role: для Project и его subtree — через current
   Project owner/active Project grant; для standalone Task/global SavedView —
   через собственный owner/active direct grant.
3. Repository применяет predicate внутри SQL/query до pagination, aggregation,
   grouping или full-text search.
4. Mutation дополнительно требует minimum role (`editor` для content,
   `manager`/`owner` для разрешённого member management), inheritance и domain
   invariants в одной транзакции.
5. Unauthorized lookup возвращает ответ, не подтверждающий существование
   чужого resource.

### Share и revoke

1. Grantor находит уже зарегистрированного User по verified email.
2. Access проверяет role actor, допустимый shareable root и ceiling: Owner
   назначает Manager/Editor/Viewer, Manager — только Editor/Viewer.
3. Active grant с выбранной role создаётся или обновляется идемпотентно с
   provenance grantor/timestamp. Verified email обязан разрешаться однозначно.
4. Revoke атомарно закрывает grant. Следующий query/mutation grantee больше не
   включает resource subtree.
5. Project grant наследуется Tasks/Releases/project-scoped SavedViews. Direct
   Task/global SavedView grant поддерживает только Editor/Viewer.
6. Ownership transfer одним batch обновляет Project owner, отзывает grant нового
   owner и создаёт прежнему owner grant Manager.

### Открытие view

1. API загружает `SavedView` только через Access scope и проверяет grant.
2. Views валидирует versioned filter AST и объединяет его со scope и временными
   URL-фильтрами.
3. Один query pipeline сначала применяет authorization predicate, затем
   фильтр, grouping, ordering и pagination.
4. API возвращает records и metadata групп; UI рисует list либо board.

Переключение layout не должно менять query semantics или состав task IDs.

### Чтение и task commands через agent API

1. Codex/ChatGPT подключается к `/api/mcp` через OAuth Authorization Code +
   PKCE/CIMD; scripts могут использовать переходную personal API credential.
   Оба способа сопоставляются внутреннему User до data query; browser headers
   нельзя синтезировать client-side.
2. Agent query service применяет тот же ownership/ACL predicate до filters,
   counts, ambiguity resolution и cursor pagination.
3. Collection use case строит фиксированный compact projection без description,
   comments, attachments, internal IDs и user emails.
4. Detail use case по canonical `public_id` загружает одну сущность; большой
   imported archive остаётся отдельным paginated вызовом.
5. REST возвращает versioned schema и request/as-of metadata. MCP публикует
   task-oriented tools с теми же projections. Любой client переходит от summary
   к detail только через явный отдельный запрос.

Реализованный контракт описан в [спецификации agent API](specs/agent-api.md),
а credential/write boundary принят в
[ADR-0006](decisions/0006-standalone-agent-api.md), а OAuth/MCP delivery — в
[ADR-0008](decisions/0008-oauth-mcp-connector.md). Task commands транслируют
external refs во внутренние IDs и вызывают те же domain repository methods с
role checks, release/project validation и optimistic version.

### Открытие прямой ссылки

1. Server route нормализует catch-all segments ровно через один
   percent-decode/encode cycle, независимо от того, передал runtime decoded или
   encoded params, затем разбирает allowlisted path contract `/issues`,
   `/views`, `/projects`, `/releases`, project-scoped releases и layout
   `list|board`; неизвестные extra segments отклоняются.
2. Repository строит один ACL-scoped snapshot до разрешения route ID, поэтому
   неизвестный и недоступный record имеют одинаковый `not found` результат.
3. Внутренний `id` остаётся ключом связей и import idempotency, а отдельный
   immutable `public_id` UUID адресует Task, Project, Release и SavedView.
   Legacy internal-ID route разрешается только внутри ACL snapshot и отвечает
   redirect на канонический публичный path.
4. Route разрешается в UI state `{surface, layout, taskId}`. Issue URL открывает
   details поверх доступного project/release context, но сам остаётся
   каноническим `/issues/{public-id}`.
5. Client-side переходы используют `history.pushState`; для `/issues/{id}`
   history entry дополнительно хранит проверяемый background surface/layout,
   чтобы Back/Forward возвращали исходный board без добавления query parameter.
   При отсутствии или подмене state path разрешается заново. Синтаксис и ACL
   снова проверяются server-side при прямой загрузке или refresh.
6. Metadata независимо шаримой route формируются из уже авторизованного record;
   inherited social image очищается, чтобы приватная entity не получала
   вводящий в заблуждение общий preview.

### Перетаскивание карточки

1. UI оптимистично показывает новое положение и отправляет target group,
   соседние ranks и record version.
2. API переводит target group в изменение доменного поля.
3. Domain проверяет workflow и project/release invariants.
4. Транзакция меняет поле, rank, timestamps и version.
5. При validation/conflict UI восстанавливает server state и показывает
   понятную причину.

### Назначение релиза

1. Release загружается вместе с owner project.
2. Для task без project API назначает project и release одной командой.
3. Для task другого project операция отклоняется либо требует отдельной команды
   `move_to_project_and_release` с подтверждением.
4. Ни один промежуточный commit не нарушает инвариант.

## API-принципы

- Commands выражают доменное намерение, когда обычный PATCH может создать
  промежуточное неверное состояние.
- Read API поддерживает cursor pagination и возвращает стабильный sort key.
- Filter AST версионируется и валидируется по allowlist полей/операторов.
- Ошибки различают validation, not found, permission denied и version conflict.
- Timestamps назначает сервер; клиент передаёт local date/timezone только там,
  где это часть семантики.
- Любая endpoint/query abstraction требует current User и не предоставляет
  unscoped repository methods application layer.
- UI snapshot и agent API используют разные response projections и query
  methods, но одинаковые server-side ownership/ACL semantics и domain command
  repositories. `/api/bootstrap` не является versioned внешним контрактом.
- Agent collection endpoints имеют fixed compact representation и cursor
  pagination; task bodies доступны только detail use case.
- Authorization применяется до aggregates и error detail, чтобы исключить
  утечки counts, identifiers и существования records.
- Единственное исключение cross-user aggregation — отдельный admin query,
  который сначала проверяет hosted allowlist и возвращает только User metadata
  и counts без content user-owned records.
- Второе explicit исключение — system backup/restore по ADR-0004. Оно не
  переиспользуется product surfaces: export читает полный logical state, а
  restore работает только через validated staging и atomic replace.

Первый срез использует JSON HTTP route handlers: bootstrap snapshot и команды
создания/изменения Task, Project, Release, SavedView и AccessGrant. Каждая
команда возвращает новый authorization-scoped snapshot; дальнейшая pagination
и command-specific responses будут добавлены при росте объёма данных.

## Хранение и индексы

В migration baseline уже входят:

- D1 migrations для User, UserIdentity, AccessGrant и доменных таблиц;
- unique index `(provider, provider_account_key)` для identities;
- unique active-grant constraint для resource/grantee;
- owner-prefixed indexes для каждого user-owned query path;
- owner-scoped sequence/index для `Task.identifier`;
- индексы по owner/status/archive, project/release и updated time;
- join table для labels;
- нормализованная `task_relations` для `blocks`, `related` и `duplicate_of`;
- `external_records` для owner-scoped provenance идемпотентного импорта;
- `user_import_sessions` и `user_import_rows` для owner-scoped Project restore
  staging, preview и bounded lifecycle;
- `admin_import_sessions` и `admin_import_rows` для изолированного preflight,
  payload staging и минимального audit metadata полного restore;
- constraint или transactional validation project/release consistency;
- стратегия fractional/lexicographic ranks с периодической локальной
  нормализацией.

Полнотекстовый индекс, дополнительные assignee/priority/due indexes и
database-level foreign keys остаются следующими schema slices.
Owner consistency и project/release invariants в текущем срезе проверяются на
server mutation boundary.

Authenticated endpoint `/api/import/linear` принимает заранее
инвентаризированный JSON snapshot, полностью валидирует ссылки до записи и
выполняет deterministic upsert. Техническая страница `/import/linear` добавляет
к workspace snapshot отдельно собранный archive комментариев. Импорт сохраняет
исходные identifiers, timestamps, archive state, hierarchy, labels, relations,
saved-view query/display и полный provider metadata в `external_records`.

### Системный backup и restore

1. `POST /api/admin/export` проверяет allowlist и одной read-only D1 batch
   transaction получает все live application tables в стабильном порядке.
2. Versioned JSON envelope получает timestamp, per-table counts и SHA-256;
   response не кэшируется и скачивается как attachment.
3. `POST /api/admin/import/validate` ограничивает payload, полностью проверяет
   schema/domain/identity references и atomically сохраняет verified rows в
   staging namespace.
4. UI показывает preview и требует отдельный текущий backup плюс literal
   `RESTORE` confirmation.
5. `POST /api/admin/import` разрешает только создателя staged session и одной
   D1 batch transaction удаляет live rows, вставляет verified staged rows,
   отмечает session applied и очищает payload. Batch failure откатывает весь
   cutover.

### Project backup и restore

1. Export repository сначала загружает Project с effective role `owner`, затем
   одной consistent D1 batch читает subtree, internal joins/relations,
   provenance, catalog dependencies и active Project grants.
2. Format layer canonicalizes bundle, считает counts/warnings и SHA-256; Users,
   identities, credentials и unrelated rows не входят.
3. Validate endpoint проверяет owner/site binding, checksum, references,
   collisions и доступность shared catalogs до записи normalized rows в
   `user_import_rows`.
4. Preview сравнивает staged и live subtree. Apply повторно проверяет session,
   confirmation и current ownership, затем set-based SQL одной D1 `batch()`
   transaction заменяет subtree; grants вставляются только при opt-in.

## Надёжность и проверка

- Domain tests проверяют переходы статусов, timestamps, release consistency,
  parent cycles и relation uniqueness.
- Repository/API integration tests проверяют транзакции, constraints, filters,
  pagination, concurrency conflict и отсутствие cross-user data leakage.
- Identity tests проверяют оба providers, forged headers/claims, explicit
  linking и отсутствие automatic email merge.
- Access tests покрывают role hierarchy/ceiling, viewer mutation denial,
  project inheritance к Task/Release/scoped View, global View intersection,
  revoke и atomic ownership transfer.
- Admin tests покрывают allowlist normalization, отказ обычному User и
  registration/activity aggregates при изменении source counts.
- Backup tests покрывают format/domain validation, identity continuity,
  отсутствие Administration в primary sidebar, preview без live mutation и
  atomic replace/rollback boundary.
- Project portability tests покрывают format/checksum, boundary validation и
  transaction rollback; owner scope дополнительно проверяется repository
  predicates и live smoke.
- UI tests проверяют одинаковый состав list/board, selection/bulk actions,
  keyboard controls, Peek, drag rollback и сохранение views.
- Visual regression и accessibility checks следуют
  [спецификации интерфейса](specs/interface.md); сравнение с Linear проверяет
  composition и interaction parity, а не чужие assets.
- End-to-end сценарии следуют разделу приёмки в
  [спецификации MVP](specs/mvp.md#13-проверяемые-сценарии-приёмки).

## Риски

- Универсальный filter builder может стать отдельным продуктом; MVP ограничивает
  UI оператором AND и allowlist полей.
- Manual rank сложен при параллельных перемещениях; version conflict должен быть
  предусмотрен до оптимистичного DnD.
- Одновременная редактируемость released scope ослабляет доверие к истории;
  безопасный первый вариант — запрещать её.
- Одна забытая unscoped query может раскрыть чужие данные; owner/ACL scope
  должен быть частью repository API, schema indexes и integration tests.
- Admin query намеренно cross-user и поэтому должен оставаться отдельным,
  content-free и server-gated; повторное использование его projection в
  обычных user surfaces увеличит риск утечки email и aggregate activity.
- System backup содержит весь cross-user content и identity metadata. Файл
  следует считать чувствительным, import ограничивать same-origin admin
  operation, а invalid snapshot отклонять до staging/cutover.
- Project bundle остаётся чувствительным пользовательским content. Same-Site
  owner binding и no-store response обязательны; sharing descriptors не должны
  превращаться в implicit grants.
- Если agent API не отделить от UI snapshot, рост descriptions/imported archive
  создаст большой token и privacy blast radius. Summary/detail boundary должна
  проверяться schema и integration tests, а не только дисциплиной клиента.
- OAuth/token connector добавляет новую identity boundary. Нельзя считать
  Sites browser session переносимой во внешний client или выдавать API
  credential implicit admin access. CIMD, exact redirect/resource, PKCE,
  expiry, refresh rotation и revoke должны проверяться server-side.
- Ошибка в role ceiling увеличивает blast radius grant; server-side hierarchy,
  provenance и быстрый revoke обязательны.
- Sites contract сегодня даёт ChatGPT identity через email/name headers, а не
  отдельный immutable subject; account linking и provider key требуют
  осторожной миграционной стратегии.
- Google external auth должен быть доказан на реальном Sites runtime до
  заявления о готовом login flow.
- Project progress без effort weighting прост, но может вводить в заблуждение
  на задачах разного размера; UI должен явно показывать метод подсчёта.
- Linear меняет UI независимо от Task Manager. Reference должен быть датирован,
  а изменения не должны автоматически ломать наш contract или расширять scope.
- Слишком буквальное сходство может стереть product identity или привести к
  копированию чужих assets; ADR-0002 требует собственного брендинга и
  документированных отклонений.
- Sites public beta limits и отсутствие data residency могут потребовать
  пересмотра hosting до обработки чувствительных или регулируемых данных.

## Открытые решения следующих срезов

1. Конкретный Google OAuth/OIDC adapter и callback/session contract в Sites.
2. CSRF hardening сверх Sites session boundary, audit event minimum и account
   recovery.
3. UX explicit linking/unlinking providers и смены primary email.
4. Порог перехода snapshot API к cursor pagination и точечным responses.
5. Политика immutability released scope и нормализация manual ranks.
6. Server-side idempotency task create, bulk command contract, OAuth/API rate
   limits, retention audit events и критерии перехода на managed IdP перед
   публичным каталогом.
