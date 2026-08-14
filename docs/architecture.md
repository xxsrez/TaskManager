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
- единая Linear-like interaction и component model для list, board, details,
  filters, selection и contextual actions;
- managed deployment и durable structured storage в ChatGPT Sites.

## Контекст

```mermaid
flowchart LR
    U[Пользователь] --> SITE[ChatGPT Site / Web UI]
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
| Administration | Server allowlist, registrations, activity и owner-scoped aggregate counts без content access |
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
2. Access строит predicate: `owner_user_id = current_user.id` либо active grant
   на resource/shareable ancestor.
3. Repository применяет predicate внутри SQL/query до pagination, aggregation,
   grouping или full-text search.
4. Mutation дополнительно проверяет `full_access`, inheritance и domain
   invariants в одной транзакции.
5. Unauthorized lookup возвращает ответ, не подтверждающий существование
   чужого resource.

### Share и revoke

1. Grantor находит уже зарегистрированного User по verified email.
2. Access проверяет, что grantor — owner либо имеет `full_access`, и что target
   является разрешённым shareable root.
3. Active grant создаётся идемпотентно с provenance grantor/timestamp.
4. Revoke атомарно закрывает grant. Следующий query/mutation grantee больше не
   включает resource subtree.
5. Project grant наследуется Tasks/Releases; SavedView grant всегда
   пересекается с собственным authorization scope grantee.

### Открытие view

1. API загружает `SavedView` только через Access scope и проверяет grant.
2. Views валидирует versioned filter AST и объединяет его со scope и временными
   URL-фильтрами.
3. Один query pipeline сначала применяет authorization predicate, затем
   фильтр, grouping, ordering и pagination.
4. API возвращает records и metadata групп; UI рисует list либо board.

Переключение layout не должно менять query semantics или состав task IDs.

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
- Authorization применяется до aggregates и error detail, чтобы исключить
  утечки counts, identifiers и существования records.
- Единственное исключение cross-user aggregation — отдельный admin query,
  который сначала проверяет hosted allowlist и возвращает только User metadata
  и counts без content user-owned records.

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

## Надёжность и проверка

- Domain tests проверяют переходы статусов, timestamps, release consistency,
  parent cycles и relation uniqueness.
- Repository/API integration tests проверяют транзакции, constraints, filters,
  pagination, concurrency conflict и отсутствие cross-user data leakage.
- Identity tests проверяют оба providers, forged headers/claims, explicit
  linking и отсутствие automatic email merge.
- Access tests покрывают project inheritance, standalone Task, SavedView
  intersection, re-share, revoke и owner implicit access.
- Admin tests покрывают allowlist normalization, отказ обычному User и
  registration/activity aggregates при изменении source counts.
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
- Разрешённый re-share при `full_access` увеличивает blast radius ошибочного
  grant; provenance и быстрый revoke обязательны.
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
