# ADR-0017: экспериментальный Teams runtime поверх постоянной baseline

Статус: `Accepted`

Дата решения: 2026-09-01

## Контекст

[ADR-0016](0016-dormant-teams-schema-baseline.md) зафиксировал одинаковую для
пяти сравнительных прогонов D1 baseline: `teams`, `team_memberships` и
`team_grants` существуют до функциональной реализации, а их schema и migration
journal не меняются между кандидатами. Сам ADR-0016 намеренно не выбирал
runtime, authorization, API, UI, sync, portability или production lifecycle.

Release 0.4 нужен один полностью функциональный кандидат, на котором можно
проверить создание Team, membership, дополнительный Team access route и
пользовательский поток `People & Teams`. Этот кандидат должен быть пригоден для
UAT и сравнительного замера, но не должен выдаваться за выбранный production
результат пяти прогонов.

## Решение

1. Release 0.4 активирует экспериментальный Teams runtime поверх неизменяемой
   baseline ADR-0016. Это функциональный кандидат текущего сравнительного
   прогона и UAT, а не выбор production-реализации.
2. Team является группой зарегистрированных Users и дополнительным access
   route. Team не становится tenant, workspace, владельцем Project/Task/View,
   источником workflow, labels, task identifiers или assignee semantics.
3. Runtime предоставляет authenticated catalog/create/detail и membership API:
   active User видит только Teams, в которых имеет active membership; создание
   Team атомарно создаёт active owner membership; только current Team owner
   добавляет уже зарегистрированного User по verified email, деактивирует,
   повторно активирует или удаляет member membership. Owner membership этими
   командами не изменяется.
4. `team_grants` подключается к тому же server-side ACL predicate как
   дополнительный route, не заменяя owner и direct `AccessGrant`. Если User
   получает несколько ролей через ownership, direct grant или несколько
   active Teams, effective role равна самой сильной из них. Inactive
   membership, archived Team и revoked Team grant доступа не дают.
5. Project Team grant наследуется всеми Tasks, Releases и project-scoped
   SavedViews этого Project. Отдельный exact Task Team grant открывает только
   эту Task, не меняет её Project и не открывает Project или соседние Tasks.
   Global SavedView Team grant открывает сам View, но его query остаётся
   пересечением с ACL Tasks каждого читателя. Project-scoped SavedView и Release
   не получают отдельный Team grant: доступ к ним возможен только через
   Project.
6. Project Team grant допускает `manager`, `editor`, `viewer`; exact Task и
   global SavedView — только `editor`, `viewer`. Resource actor обязан иметь
   право назначить выбранную роль: Project Owner назначает вплоть до Manager,
   Project Manager — Editor/Viewer; exact Task Team access назначает Project
   Owner/Manager; global SavedView Team access — только owner View. Само
   владение Team не даёт права расшарить чужой resource.
7. Membership update/delete и Team grant reactivate/update/revoke используют
   optimistic version; brand-new rows начинают с version 1. После успешной
   mutation клиент перечитывает канонический Team или resource-scoped grant
   list; `409` приводит к
   authoritative read-back и явному предложению повторить действие с новой
   version, без last-write-wins.
8. UI добавляет Teams catalog/detail и объединённый dialog `People & Teams`.
   Во вкладке `Teams` пустой search сначала предлагает owned Teams, введённый
   запрос ищет среди всех active Teams пользователя, а выбор Team всегда
   явный. Результат показывает число active members и текущую membership role,
   отдельно объясняет роль и access root. Direct People и Team grants остаются
   разными списками и жизненными циклами.
9. Team-specific persistence ограничена тремя существующими таблицами:
   `teams`, `team_memberships`, `team_grants`. Кандидат не меняет
   `db/schema.ts`, migrations, constraints, migration journal, direct
   `access_grants` или строки Projects/Tasks/Releases/SavedViews ради Team
   functionality.
10. Dedicated Team sync, Agent/MCP surface, production deployment/lifecycle и
    system/Project backup, export, import или restore для Team rows остаются
    вне кандидата. Portability и окончательная модель синхронизации выбираются
    отдельно после пяти сравнительных прогонов.
11. Delivery candidate не выполняет cleanup созданных UAT Team rows: exact
    counts и read-back должны остаться доступными для центрального benchmark
    capture. Последующий reset остаётся отдельной ограниченной операцией
    orchestration и не является product lifecycle или acceptance этого
    кандидата.

## Последствия

- Teams можно проверить как сквозной UAT-поток без изменения общей schema и без
  переписывания существующих resources/direct grants.
- Удаление или деактивация одного route не затрагивает другие Team/direct
  routes; effective access пересчитывается по оставшимся источникам.
- Exact Task sharing становится осознанным исключением только для Team grant;
  direct Person grant на project Task по-прежнему не создаётся.
- Team catalog и `People & Teams` должны иметь отдельные loading, empty, error,
  retry и conflict states на desktop и mobile.
- Код кандидата можно сравнить или заменить после прогонов, сохранив baseline
  ADR-0016 и migration journal.
- Наличие функционального UAT-кандидата не разрешает production deploy и не
  доказывает, что именно он выбран итоговой реализацией Teams.

## Отклонённые варианты

- изменить baseline ради удобства кандидата — нарушает сопоставимость прогонов;
- материализовать Team access как direct grant каждому member — смешивает два
  lifecycle, требует fan-out и оставляет устаревшие grants после membership
  change;
- сделать Team владельцем resources или отдельным tenant/workspace — расширяет
  identity, identifier, workflow и portability scope без принятого контракта;
- разрешить отдельный Team grant для Release или project-scoped SavedView —
  ломает Project inheritance и создаёт конкурирующие child roots;
- очищать UAT rows до центрального read-back — уничтожает доказательство
  persistence boundary текущего прогона;
- объявить кандидат production-результатом до пяти прогонов — подменяет
  сравнительное решение фактом одной реализации.
