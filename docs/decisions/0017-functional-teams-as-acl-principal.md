# ADR-0017: функциональные Teams как отдельный ACL-принципал

Статус: `Accepted`

Дата: 2026-09-01

## Контекст

ADR-0016 заранее добавил три пустые таблицы `teams`, `team_memberships` и
`team_grants`, но намеренно не определял runtime, authorization, API, sync или
UI. Для группового sharing нужен функциональный срез, который использует эту
неизменяемую схему, сохраняет действующий owner/direct-grant contract и не
создаёт Team-owned resources либо workspace/tenant boundary.

Обычный per-user change journal не получает события для Team recipients:
триггеры знают только owner и прямые `access_grants`. При этом изменение
membership или Team grant должно менять уже открытые list, board и details без
записи дополнительного Team-specific состояния в журнал.

## Решение

1. Team является групповым ACL-принципалом, а не владельцем Project, Task,
   Release или SavedView. `owner_user_id` определяет управление самой Team.
2. Единственное Team-specific постоянное состояние хранится в `teams`,
   `team_memberships` и `team_grants`. Runtime не создаёт Team rows, shadow
   grants, cursor rows или fan-out events в других таблицах.
3. Создание Team атомарно создаёт active owner membership. Owner управляет
   именем и lifecycle участников; ordinary member может выбрать только active
   Team, в которой состоит. Изменения используют optimistic concurrency версии
   Team и конкретной membership.
4. Active Team route требует одновременно неархивированную Team, active
   membership и неотозванный Team grant. Inactive membership и archived Team
   доступа не дают.
5. Team grant поддерживает Project с ролями `manager|editor|viewer`, Task с
   `editor|viewer` и global SavedView с `editor|viewer`. Release и
   project-scoped SavedView используют Team grant родительского Project.
   Явный Task grant открывает только Task, но не Project, Releases или соседние
   Tasks.
6. Effective role вычисляется сервером как strongest role из ownership,
   direct `access_grants`, Project inheritance и всех active Team routes до
   read, search или mutation. Отзыв одного route не меняет остальные.
7. Выдать Team grant может active Team member, если его роль на целевом
   resource позволяет управлять требуемой ролью. Read-back не раскрывает Team
   или resource тому, у кого нет соответствующего доступа.
8. UI добавляет каталог `/teams`, карточку `/teams/{publicId}` и поверхность
   `People & Teams`. Principal и роль выбираются явно; direct User grants и
   Team grants показаны отдельно. Для Task UI различает Project inheritance и
   Task-only route, а для Release объясняет управление доступом на Project.
9. Центральный workspace sync сохраняет существующий journal. Cursor включает
   хешированный read-only fingerprint active Team/membership/grant versions и
   только состояния ресурсов и событий, входящих в доступные Team routes.
   Изменение fingerprint требует один полный reset, после которого polling
   снова сходится. Несвязанные приватные изменения владельца не входят в
   fingerprint Team recipient.
10. Team tables не входят в system или Project portability format этого среза.
    Delivery и приложение не выполняют автоматический cleanup Team rows.

## Последствия

- Direct sharing и Project ownership сохраняют прежнюю семантику; Team route
  является дополнительным и независимо отзываемым каналом.
- Global SavedView по-прежнему выполняется над ACL-пересечением реально
  доступных данных и не расширяет доступ к результатам.
- Сходимость Team ACL достигается без новых таблиц, migrations или Team-specific
  DML в change journal; цена — один full reset при изменении доступного
  Team-route или его видимого содержимого.
- Team не задаёт workflow, labels, assignment, cycles, templates, private
  subteams, tenant boundary или ownership пользовательских ресурсов.

## Отклонённые варианты

- **Материализовать direct grants для каждого участника.** Потерялась бы
  независимость Team route, а membership churn требовал бы fan-out writes.
- **Писать Team recipients в существующий journal.** Это создало бы
  Team-specific постоянное состояние вне трёх разрешённых таблиц.
- **Использовать общий sequence владельца в fingerprint.** Такой marker давал
  бы Team recipient наблюдать несвязанные приватные изменения владельца.
- **Сделать Team владельцем ресурсов или workspace.** Это меняет принятую
  доменную модель, ACL inheritance и portability contract за пределами среза.
