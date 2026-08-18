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
18. [Runbook релизов Sites](operations/sites-release.md) — exact-SHA workflow,
    environment bindings, проверки и recovery.
19. [Runbook вложений](operations/attachments.md) — bindings, limits, smoke,
    cleanup и recovery.
20. [Начальная архитектура](architecture.md) — логические компоненты и решения,
    которые ещё предстоит принять.
21. [Исследование Linear](reports/2026-08-13-linear-product-study.md) — источник
    продуктовых заимствований и осознанных упрощений.
22. [Миграция Linear](reports/2026-08-14-linear-migration.md) — production
    mapping, reconciliation, release evidence и осознанные границы переноса.

## Статусы документов

- `Proposed` — рабочее предложение, которое можно менять до реализации.
- `Accepted` — решение, явно принятое пользователем или зафиксированное ADR.
- `Implemented` — поведение подтверждено кодом и проверками.

Спецификации целевого MVP остаются `Proposed`. Первый срез уже реализует вход
через ChatGPT, D1 persistence, owner/ACL-scoped задачи, проекты, релизы,
сохранённые views, sharing, list/board, details, filters, selection и основные
keyboard actions. Реализованы хранение и read-only details для labels и
parent/subtasks, native create/edit/remove Task relations, а также идемпотентный Linear snapshot import
с provenance и read-only архивом импортированных комментариев. Administration
поддерживает полный системный export и атомарный replace-import через
версионированный logical snapshot. Редакторы
labels/hierarchy, assignee picker, настройка
workflow, полный filter AST, Google sign-in и исчерпывающая acceptance matrix
ещё не реализованы. В
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
workspace/project/release reads, compact task search, task detail/external
context и scoped task create/update описаны в
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
relation commands. Attachment-aware system/Project backup и relation schema
`5` реализованы с legacy compatibility.
ADR-0012 заменяет optional/standalone Task semantics: каждая Task требует
Project, получает identifier из Project code/sequence, а прежние identifiers
сохраняются как ACL-scoped aliases.

## Категории

- `specs/` — предлагаемое и требуемое поведение продукта.
- `reference/` — стабильная справочная модель предметной области.
- `decisions/` — принятые архитектурно значимые решения и их последствия.
- `operations/` — проверяемые release, recovery и эксплуатационные процедуры.
- `reports/` — датированные исследования; они не подменяют спецификацию.
