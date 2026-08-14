# ADR-0005: роли проекта и передача ownership

Статус: `Accepted`

Дата решения: 2026-08-14

Этот ADR заменяет решения 6–8 и соответствующие отложенные пункты
[ADR-0001](0001-identity-sharing-and-sites-hosting.md) в части resource roles,
наследования project scope и передачи ownership. Application administrator из
[ADR-0004](0004-system-backup-and-restore.md) остаётся отдельной server-side
capability и не является ролью проекта.

## Контекст

Один уровень `full_access` не позволяет безопасно дать человеку только чтение,
разрешить работу с задачами без управления участниками или делегировать
управление проектом. Project-scoped SavedView должен иметь тот же access scope,
что и Project, тогда как global SavedView может пересекать несколько доступных
проектов. Владельцу также нужна немедленная передача ownership уже добавленному
участнику без отдельного подтверждения получателя.

## Решение

1. У Project есть четыре effective roles: `owner`, `manager`, `editor` и
   `viewer`. Каждый следующий уровень включает полномочия более слабых ролей.
2. `owner` ровно один и задаётся `Project.owner_user_id`; отдельный grant для
   него не хранится. `manager`, `editor` и `viewer` хранятся в `AccessGrant`.
3. `viewer` может читать Project и его subtree, но не изменять его. `editor`
   дополнительно создаёт и изменяет Tasks, Releases и project-scoped SavedViews,
   двигает Tasks по workflow, архивирует и восстанавливает records. Необратимое
   удаление остаётся отдельной операцией только для owner с подтверждением и не
   обязательно для текущего среза.
4. `manager` дополнительно приглашает зарегистрированных Users и управляет
   только grants `editor`/`viewer`. Manager не может назначить или изменить
   другого manager, передать ownership либо удалить owner.
5. `owner` управляет grants вплоть до `manager` и может передать ownership User,
   уже имеющему active Project grant. Передача атомарна: target сразу становится
   owner, прежний owner — manager; подтверждение target и email не требуются.
6. Project role распространяется на сам Project, его Tasks, Releases и каждый
   SavedView с явным `scope_project_id` этого Project. Такие дочерние records не
   имеют самостоятельных grants.
7. `scope_project_id` — authorization boundary, а не только сохранённый фильтр.
   Project-scoped SavedView всегда ограничен своим Project. SavedView без
   `scope_project_id` остаётся global и выполняется над пересечением всех данных,
   доступных текущему User. Условие `project_id` внутри filter global view не
   превращает его в project-scoped view.
8. Standalone Task и global SavedView можно расшарить напрямую только с
   `editor` или `viewer`. Роли `manager` и передача ownership существуют только
   для Project.
9. Sharing разрешён только с уже зарегистрированным User по однозначно
   найденному verified email. При нескольких совпадениях операция отклоняется.
   Email invitation, public link и anonymous data отсутствуют.
10. Авторизация каждого read и mutation выполняется на server boundary; UI
    только отражает вычисленную сервером effective role.

## Ownership дочерних records

`Task.owner_user_id`, `Release.owner_user_id` и `SavedView.owner_user_id`
сохраняют исходный tenant/catalog и provenance scope. При передаче Project они
не переписываются: это не меняет immutable task identifier и не требует
копировать WorkflowStatus или Label.

Для record с `project_id` или `scope_project_id` эти поля не дают implicit
доступ. Единственный access root — текущий `Project.owner_user_id` и active
Project grant. Поэтому бывший owner, лишённый Project grant, не продолжает
видеть subtree через историческое `owner_user_id`. Для standalone Task и global
SavedView их собственный `owner_user_id` по-прежнему является access root.

## Последствия

- Любой repository query должен вычислять effective role до чтения content,
  aggregation, search или mutation.
- `Shared with me` определяется effective role, а не сравнением исторического
  `owner_user_id` дочерней записи с текущим User.
- Backup/restore принимает новые permissions и legacy `full_access`; при
  миграции Project `full_access` становится `manager`, а direct Task/SavedView
  `full_access` — `editor`.
- Передача ownership обновляет Project и grants одной транзакцией. Новый owner
  получает implicit access, его прежний grant отзывается, а прежнему owner
  создаётся или восстанавливается grant `manager`.
- Application administrator не получает ни одну из этих ролей и не может
  читать чужой content через обычные product surfaces.

## Не входит в решение

- приглашения незарегистрированных пользователей и отправка email;
- public share links и anonymous access;
- роли уровня workspace/team;
- принятие ownership получателем;
- отдельная роль для Release или project-scoped SavedView;
- необратимый purge в первом срезе.
