# ADR-0016: постоянная dormant schema baseline для Teams

Статус: `Accepted`

Дата решения: 2026-08-31

## Контекст

Teams будут реализованы пять раз из одной и той же исходной версии, чтобы
сравнить режимы ShipTask/Issue Grinder. Если каждый прогон добавляет или
откатывает собственную D1 migration, следующие кандидаты получают другую схему
и другой migration journal. Откат всей D1 также затрагивает данные, которые не
относятся к эксперименту.

Пользователь принял отдельный одноразовый шаг: до сравнительных прогонов создать
целевую структуру Teams, оставить её пустой и больше не менять между режимами.

## Решение

1. Одна versioned migration добавляет три dormant-таблицы:
   - `teams` — стабильный public ref, имя, current owner, archive lifecycle,
     timestamps и optimistic version;
   - `team_memberships` — одна versioned запись на пару Team–User с ролью
     `owner` или `member`, состоянием `active` или `inactive` и согласованным
     `deactivated_at`;
   - `team_grants` — одна versioned запись на Team и share target с revoke
     lifecycle, grantor и допустимой ролью.
2. `team_grants.resource_type` допускает `project`, `task` и `saved_view`.
   Project поддерживает `manager`, `editor`, `viewer`; Task и SavedView —
   `editor`, `viewer`. Полиморфная ссылка на resource проверяется будущим
   server contract, а Team/User references и lifecycle domains защищены D1.
3. Индексы покрывают public Team lookup, owner catalog, Team member list,
   поиск Teams пользователя и active grant lookup по Team или resource.
4. Migration входит в общую Git/D1 baseline до первого сравнительного прогона.
   Между режимами таблицы и migration journal сохраняются; удаляются только
   синтетические строки этих трёх таблиц.
5. Baseline не добавляет repository methods, HTTP/Agent/MCP routes,
   authorization joins, UI, sync events или пользовательское поведение. Пока
   функциональный срез не подключён, приложение не читает и не пишет новые
   таблицы.
6. Все функциональные задачи Epic TM-329 обязаны использовать эту структуру без
   изменения `db/schema.ts`, SQL migrations, таблиц, колонок, индексов,
   constraints или migration journal. Недостаточность baseline является
   blocker-ом, а не разрешением расширить schema scope режима.
7. Dormant-таблицы не включаются в D1 registry системного backup. Для них
   зафиксировано явное schema-only исключение, поэтому прежний backup format и
   fingerprint не меняются и Team export/import/restore не добавляются.
   Пересмотр portability выполняется отдельно после выбора функционального
   результата.
8. Production deployment и production migration не входят в это решение.

## Последствия

- Все пять режимов получают одинаковую схему и пустое Team-state.
- Код функционального эксперимента можно откатывать независимо от D1 migration.
- Синтетические Team rows не должны попадать в обычные данные или переживать
  reset между прогонами.
- До подключения runtime наличие таблиц не означает, что Teams вошли в
  пользовательский MVP или появились в интерфейсе.
- System/Project backup не сохраняют Team rows в экспериментальном срезе;
  backup/export/import/restore не являются guardrail или acceptance TM-329 и
  запускаются только по отдельной прямой команде пользователя.

## Отклонённые варианты

- отдельная migration в каждой benchmark-ветке — меняет исходное состояние
  поздних прогонов;
- rollback schema и migration journal между режимами — дорогой и рискованный
  путь с затрагиванием общей D1;
- добавление runtime/API/UI вместе с baseline — смешивает одноразовую схему с
  повторяемым функциональным результатом;
- полный D1 backup/restore как reset эксперимента — выходит за согласованный
  scope и затрагивает несвязанные данные.

## Функциональное продолжение в Release 0.4

Release 0.4 активирует заранее подготовленную baseline в одном функциональном
кандидате: Team catalog и membership lifecycle, HTTP API, `/teams`,
`People & Teams` и Team-derived ACL для Project, конкретной project-bound Task
и global SavedView. Это продолжение не меняет исходное решение о схеме:
`db/schema.ts`, migrations, indexes, constraints и migration journal остаются
неизменными.

TeamGrant остаётся отдельным от direct `AccessGrant` route. Effective role
выбирается как strongest из owner, direct User grant, Project inheritance и
всех active Team routes. Task route открывает только указанную Task, а global
SavedView не расширяет ACL underlying records. Team-owned resources, tenant,
workflow, backlog, sync и portability в продолжение не входят.

Исторические утверждения выше описывают состояние одноразового schema step до
функциональных прогонов и не переписываются задним числом. Production lifecycle
и включение Team rows в system/Project backup по-прежнему требуют отдельного
решения и отдельной release authority.
