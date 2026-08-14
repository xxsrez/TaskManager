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
13. [Начальная архитектура](architecture.md) — логические компоненты и решения,
    которые ещё предстоит принять.
14. [Исследование Linear](reports/2026-08-13-linear-product-study.md) — источник
    продуктовых заимствований и осознанных упрощений.
15. [Миграция Linear](reports/2026-08-14-linear-migration.md) — production
    mapping, reconciliation, release evidence и осознанные границы переноса.

## Статусы документов

- `Proposed` — рабочее предложение, которое можно менять до реализации.
- `Accepted` — решение, явно принятое пользователем или зафиксированное ADR.
- `Implemented` — поведение подтверждено кодом и проверками.

Спецификации целевого MVP остаются `Proposed`. Первый срез уже реализует вход
через ChatGPT, D1 persistence, owner/ACL-scoped задачи, проекты, релизы,
сохранённые views, sharing, list/board, details, filters, selection и основные
keyboard actions. Реализованы хранение и read-only details для labels,
parent/subtasks и task relations, а также идемпотентный Linear snapshot import
с provenance и read-only архивом импортированных комментариев. Administration
поддерживает полный системный export и атомарный replace-import через
версионированный logical snapshot. Редакторы
labels/hierarchy/relations/comments, assignee picker, настройка
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
Agent-facing HTTP API реализован отдельно от UI: bearer credentials,
workspace/project/release reads, compact task search, task detail/external
context и scoped task create/update описаны в
[спецификации agent API](specs/agent-api.md) и
[ADR-0006](decisions/0006-standalone-agent-api.md). Hosted smoke, rate limits,
bulk/idempotency и специализированные clients в текущий срез не входят.
ADR-0007 и текущая реализация добавляют portability slice: current Project
Owner получает logical export, staged preview и atomic exact restore.

## Категории

- `specs/` — предлагаемое и требуемое поведение продукта.
- `reference/` — стабильная справочная модель предметной области.
- `decisions/` — принятые архитектурно значимые решения и их последствия.
- `reports/` — датированные исследования; они не подменяют спецификацию.
