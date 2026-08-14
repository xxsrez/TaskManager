# Документация Task Manager

Документация описывает целевой MVP и первый реализованный вертикальный срез.
Слова «должен» и «MVP» задают требования и не означают, что весь scope уже
существует; подтверждённое состояние перечислено ниже отдельно.

## Рекомендуемый маршрут

1. [Обзор продукта](overview.md) — зачем нужен Task Manager и где проходят его
   границы.
2. [Спецификация MVP](specs/mvp.md) — пользовательское поведение и критерии
   приёмки.
3. [Спецификация интерфейса](specs/interface.md) — Linear-like composition,
   controls, interaction states, keyboard и критерии визуальной приёмки.
4. [Доменная модель](reference/domain-model.md) — сущности, поля, связи и
   инварианты.
5. [ADR-0001: identity, sharing и Sites](decisions/0001-identity-sharing-and-sites-hosting.md)
   — принятые решения о пользователях, доступе и hosting.
6. [ADR-0002: интерфейсный паритет с Linear](decisions/0002-linear-interface-parity.md)
   — принятое правило переноса controls и границы сходства.
7. [ADR-0003: стек и authentication delivery](decisions/0003-implementation-stack-and-auth-delivery.md)
   — выбранный Sites runtime, D1/migrations и граница Google auth.
8. [ADR-0004: системный backup и restore](decisions/0004-system-backup-and-restore.md)
   — полный logical snapshot, destructive replace, admin boundary и атомарность.
9. [Начальная архитектура](architecture.md) — логические компоненты и решения,
   которые ещё предстоит принять.
10. [Исследование Linear](reports/2026-08-13-linear-product-study.md) — источник
   продуктовых заимствований и осознанных упрощений.
11. [Миграция Linear](reports/2026-08-14-linear-migration.md) — production
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
[ADR-0001](decisions/0001-identity-sharing-and-sites-hosting.md) зафиксированы
`Accepted`-решения пользователя: отдельные данные каждого пользователя,
authentication через ChatGPT или Google, sharing с единственным уровнем
`full_access` и hosting на ChatGPT Sites. В
[ADR-0002](decisions/0002-linear-interface-parity.md) принят интерфейсный
паритет с Linear для всех функций в scope; точные UI contracts остаются
`Proposed` в [спецификации интерфейса](specs/interface.md).

## Категории

- `specs/` — предлагаемое и требуемое поведение продукта.
- `reference/` — стабильная справочная модель предметной области.
- `decisions/` — принятые архитектурно значимые решения и их последствия.
- `reports/` — датированные исследования; они не подменяют спецификацию.
