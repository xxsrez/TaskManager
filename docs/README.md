# Документация Task Manager

Документация описывает целевой MVP и первый реализованный вертикальный срез.
Слова «должен» и «MVP» задают требования и не означают, что весь scope уже
существует; подтверждённое состояние перечислено ниже отдельно.

## Рекомендуемый маршрут

1. [Обзор продукта](overview.md) — зачем нужен Task Manager и где проходят его
   границы.
2. [Спецификация MVP](specs/mvp.md) — пользовательское поведение и критерии
   приёмки.
3. [API для агентов](specs/agent-api.md) — progressive disclosure,
   versioned HTTP contract, authentication, pagination и privacy boundary.
4. [Спецификация интерфейса](specs/interface.md) — Linear-like composition,
   controls, interaction states, keyboard и критерии визуальной приёмки.
5. [Доменная модель](reference/domain-model.md) — сущности, поля, связи и
   инварианты.
6. [ADR-0001: identity, sharing и Sites](decisions/0001-identity-sharing-and-sites-hosting.md)
   — принятые решения о пользователях, доступе и hosting.
7. [ADR-0002: интерфейсный паритет с Linear](decisions/0002-linear-interface-parity.md)
   — принятое правило переноса controls и границы сходства.
8. [ADR-0003: стек и authentication delivery](decisions/0003-implementation-stack-and-auth-delivery.md)
   — выбранный Sites runtime, D1/migrations и граница Google auth.
9. [ADR-0004: системный backup и restore](decisions/0004-system-backup-and-restore.md)
   — полный logical snapshot, destructive replace, admin boundary и атомарность.
10. [ADR-0005: роли проекта и передача ownership](decisions/0005-project-roles-and-ownership-transfer.md)
    — Owner/Manager/Editor/Viewer, inheritance, scoped views и transfer.
11. [ADR-0006: самостоятельный agent API](decisions/0006-standalone-agent-api.md)
    — bearer credentials, compact/detail REST и task-only write scope.
12. [ADR-0007: Project backup](decisions/0007-project-backup.md)
    — owner-only logical bundle, staged preview и atomic exact restore.
13. [ADR-0008: OAuth-first MCP connector](decisions/0008-oauth-mcp-connector.md)
    — native Connect flow, PKCE/DCR, remote MCP tools и распространение через
    расширяемый `Srez Marketplace`.
14. [ADR-0009: централизованная синхронизация workspace](decisions/0009-central-workspace-synchronization.md)
    — единый app-shell poller, principal-scoped cursor, ACL-safe change journal
    и full-reset recovery.
15. [ADR-0010: раздельные production и UAT Sites](decisions/0010-production-and-uat-sites.md)
    — отдельные Sites/D1, production approval boundary и UAT по умолчанию.
16. [ADR-0011: нативные Attachment и приватный R2](decisions/0011-native-attachments-and-r2.md)
    — metadata lifecycle, content security, ACL и cleanup.
17. [ADR-0012: обязательный Project и identifiers Tasks](decisions/0012-project-required-task-identifiers.md)
    — Project code/sequence, aliases, migration и запрет standalone Tasks.
18. [ADR-0013: StoredFile и file-first binding](decisions/0013-stored-file-and-task-attachment.md)
    — staged lifecycle, Task binding, migration и compatibility contract.
19. [ADR-0014: private UAT и on-demand local ingress](decisions/0014-private-uat-connector-edge-and-local-ingress.md)
    — superseded история неудачного loopback acceptance path.
20. [ADR-0015: production canary для file-first release gate](decisions/0015-production-file-first-release-canary.md)
    — exact production candidate, bounded fixture, hash/read-back и cleanup.
21. [ADR-0016: dormant Teams schema baseline](decisions/0016-dormant-teams-schema-baseline.md)
    — постоянные пустые Team tables до пяти функциональных прогонов, без
    runtime/API/UI и без schema rollback.
22. [Runbook релизов Sites](operations/sites-release.md) — exact-SHA workflow,
    environment bindings, проверки и recovery.
23. [Runbook вложений](operations/attachments.md) — bindings, limits, smoke,
    cleanup и recovery.
24. [Runbook импортированной истории комментариев](operations/imported-comments.md)
    — reconciliation, backup, rollback и UAT smoke для cutover/import.
25. [Runbook миграции legacy-вложений](operations/imported-attachments.md) —
    bounded inventory/apply, allowlist, outcomes, cutover и rollback.
26. [Runbook Task Activity](operations/task-activity.md) — atomic events,
    Linear status-history reconciliation, retention, backup и UAT smoke.
27. [Временный reset Teams для benchmark](operations/benchmark-team-reset.md) —
    UAT-only канал, последовательная очистка и обязательное удаление после пяти
    прогонов.
28. [Начальная архитектура](architecture.md) — логические компоненты и решения,
    которые ещё предстоит принять.
29. [Исследование Linear](reports/2026-08-13-linear-product-study.md) — источник
    продуктовых заимствований и осознанных упрощений.
30. [Миграция Linear](reports/2026-08-14-linear-migration.md) — production
    mapping, reconciliation, release evidence и осознанные границы переноса.
31. [Миграция Project task codes](reports/2026-08-18-project-task-code-migration.md)
    — UAT mapping, backup, reconciliation, smoke и recovery boundary для
    обязательных Project и Project-scoped identifiers.
32. [Runtime cutover от Linear](reports/2026-08-18-linear-runtime-cutover.md)
    — environment inventory, удалённые public surfaces, сохранённое migration
    evidence и отдельная production authority boundary.

## Статусы документов

- `Proposed` — рабочее предложение, которое можно менять до реализации.
- `Accepted` — решение, явно принятое пользователем или зафиксированное ADR.
- `Implemented` — поведение подтверждено кодом и проверками.

Спецификации целевого MVP остаются `Proposed`. Первый срез уже реализует вход
через ChatGPT, D1 persistence, owner/ACL-scoped задачи, проекты, релизы,
сохранённые views, sharing, отдельные `My tasks` и `All tasks`, list/board,
details, полный текущий filter contract, selection, атомарные bulk actions и
основные keyboard actions. Реализованы каталоги и назначения labels,
parent/subtask hierarchy, assignee controls, настройка workflow, manual
reordering с точным neighbor-bound placement и native create/edit/remove Task
relations. Runtime Linear import/provenance surfaces удалены; offline planner и
admin-only reconciliation сохраняют historical comments/activity/attachments
как native records с explicit outcomes.
Task Activity добавляет append-only native mutations и lossless Linear status
history через отдельные lazy UI/REST/MCP pages; backup сохраняет events и
attachment/comment/activity reconciliation outcomes.
Administration
поддерживает полный системный export и атомарный replace-import через
версионированный logical snapshot. Google sign-in и исчерпывающая acceptance
matrix ещё не реализованы. В
[ADR-0001](decisions/0001-identity-sharing-and-sites-hosting.md) и
[ADR-0005](decisions/0005-project-roles-and-ownership-transfer.md) зафиксированы
`Accepted`-решения пользователя: отдельные данные каждого пользователя,
authentication через ChatGPT или Google, project roles и ownership transfer,
а также hosting на ChatGPT Sites. В
[ADR-0002](decisions/0002-linear-interface-parity.md) принят интерфейсный
паритет с Linear для всех функций в scope; точные UI contracts остаются
`Proposed` в [спецификации интерфейса](specs/interface.md).
Agent-facing data plane реализован отдельно от UI: OAuth-first remote MCP,
переходные personal bearer credentials,
workspace/project/release reads, compact task search, task detail и scoped task
create/update описаны в
[спецификации agent API](specs/agent-api.md) и
[ADR-0006](decisions/0006-standalone-agent-api.md), а connector/auth delivery —
в [ADR-0008](decisions/0008-oauth-mcp-connector.md). Hosted smoke, rate limits и
bulk/idempotency в текущий срез не входят.
ADR-0007 и текущая реализация добавляют portability slice: current Project
Owner получает logical export, staged preview и atomic exact restore.
ADR-0009 добавляет единый incremental workspace sync: Tasks, Projects,
Releases, SavedViews и ACL-состав обновляются из principal-scoped D1 journal с
полным bootstrap при gap или изменении access scope.
ADR-0010 разделяет Sites на production `task-manager` и отдельный UAT
`task-manager-uat`: default binding и обычная delivery ведут в UAT, production
deploy требует прямой команды пользователя, а marketplace plugin остаётся на
production endpoint.
ADR-0011 и migrations `0014`–`0015` добавляют нативные Attachment: D1 metadata,
private environment-isolated R2, ACL-scoped upload/list/range routes, content
inspection, retry safety, recoverable cleanup, details/composer UI,
server-generated thumbnails, description images и lazy multi-session
invalidation. Agent REST/MCP добавляют paginated metadata, private binary
delivery, OpenAI native file input, versioned attachment delete и native
relation commands. System backup schema `15` имеет исчерпывающий D1/R2 registry,
включает `stored_files`, `attachments.stored_file_id` и `task_sequences`, не
поддерживает schemas `2`–`14` и отдельно классифицирует rebuild/reset/revoke/
excluded state. Project bundle использует отдельный schema `15`: внешние
`blocks`/`related` остаются provenance-only boundary descriptors и не импортируют
peer Task или внешний edge.
Task Activity, browser authoring для
root/reply/edit и lazy Comment renderer реализованы с LabelGroup topology,
versioned User preferences и resumable legacy attachment
reconciliation. Authoring и renderer переиспользуют private Task Attachment
upload/preview/download без публичных content URL.
ADR-0012 заменяет optional/standalone Task semantics: каждая Task требует
Project, получает identifier из Project code/sequence, а прежние identifiers
сохраняются как ACL-scoped aliases.
ADR-0014 сохранён как superseded incident history. ADR-0015 определяет текущий
release gate: обычный UAT остаётся private, а fresh local-path proof после
отдельного production approval выполняется bounded production canary без
Keychain, Sites bypass, публичного machine edge или hosted Codex.
ADR-0016 добавляет только постоянную dormant schema baseline для будущих Teams:
три пустые D1-таблицы с constraints/indexes и без runtime, authorization, API,
UI, sync или portability behavior. Функциональные benchmark-задачи не могут
менять эту схему; между пятью прогонами сохраняются migration и journal.

## Категории

- `specs/` — предлагаемое и требуемое поведение продукта.
- `reference/` — стабильная справочная модель предметной области.
- `decisions/` — принятые архитектурно значимые решения и их последствия.
- `operations/` — проверяемые release, recovery и эксплуатационные процедуры.
- `reports/` — датированные исследования и reconciliation reports; они не
  подменяют спецификацию.
