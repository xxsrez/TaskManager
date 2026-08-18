# Исследование Linear для Task Manager

Статус: `Proposed input`

Дата наблюдения: 2026-08-13

## Задача и метод

Исследование выделяет из Linear только механики, полезные для компактного Task
Manager. Проверены актуальные публичные страницы официальной документации
Linear о tasks/issues, workflows, projects, milestones, releases, cycles,
views, filters, display options, boards, subtasks и relations.

Это анализ опубликованной модели продукта, а не reverse engineering. UI не
тестировался в авторизованном workspace, внутренние API и детали реализации не
исследовались. Опубликованные UI screenshots и interaction docs были отдельно
сверены 2026-08-14; принятое направление и проверяемый UI contract находятся в
[ADR-0002](../decisions/0002-linear-interface-parity.md) и
[спецификации интерфейса](../specs/interface.md).

## Что действительно образует ядро Linear

### Issue как минимальная запись

В Linear у issue обязательны title и status; остальные свойства и relations
опциональны. Практическая ценность возникает не из количества полей, а из того,
что одни и те же properties доступны в карточке, фильтрах, grouping, ordering
и display options.

**Вывод для Task Manager:** сохранить низкий порог создания и сделать metadata
полноценными измерениями query system.

### Workflow с пользовательскими статусами и системными категориями

Linear разрешает настраивать статусы, но сохраняет категории движения от
backlog через unstarted/started к completed/canceled. Это отделяет язык команды
от системной семантики progress и terminal states.

**Вывод:** заимствовать это разделение почти без изменений, но не вводить
отдельные team workflows.

### Project как конечный outcome

Linear рассматривает project как крупную единицу с ожидаемым результатом и
сроком. Project хранит summary/description, status, lead, dates, members и
milestones; issue относится только к одному project.

**Вывод:** один project на task — полезное ограничение. Documents, resources,
multi-team и predictive graph для MVP не нужны.

### Board и list как layouts одного view

В Linear board не является отдельной сущностью. Board/list используют общий
порядок и фильтры; board по умолчанию группируется по status, может группировать
по другим properties и при drag менять значение grouping property.

**Вывод:** не создавать `Board` и не хранить копии карточек. `SavedView.layout`
выбирает list/board, а query остаётся общим.

### View как query плюс display configuration

Linear позволяет сохранить отфильтрованный list/board как custom view. Filters
задают состав, display options — layout, grouping, ordering и видимые поля.
Advanced filters поддерживают AND/OR и вложенные группы.

**Вывод:** SavedView — одна из четырёх основных сущностей продукта. Однако
первый UI ограничивается AND, одной группировкой и без swimlanes.

## Milestone, cycle и release нельзя считать синонимами

Linear различает три временных понятия:

- **Project milestone** — этап одного project, к которому относятся issues и
  для которого считается progress. Примеры Linear включают alpha, beta и
  public launch.
- **Cycle** — повторяющийся timebox команды, близкий к sprint; официальная
  документация прямо отделяет cycles от releases.
- **Release** — единица поставки внутри CI/CD pipeline с набором issues;
  scheduled и continuous pipelines отвечают на вопрос, что реально shipped.

Полное воспроизведение создаст три похожих поля и потребует teams, schedules,
environments и CI/CD.

**Решение для упрощённой модели:** оставить один `Release` внутри `Project`.
Он покрывает планируемый состав, target date, фактический `released_at` и notes.
От milestones он берёт удобство ручного планирования, от releases — явное
отличие «Done» от «shipped». Cycles не моделируются.

Это осознанное отличие от Linear, а не утверждение, что Linear устроен так же.

## Subtasks и relations

Linear использует parent/sub-issues для декомпозиции между issue и project, а
relations — для blocking, related и duplicates. Эти связи полезны даже без
комментариев и интеграций, поскольку влияют на планирование.

**Вывод:** включить данные и базовое редактирование в MVP, но не переносить
автоматическое закрытие parent, conversion между issue/project и сложные
workflow automations.

## Матрица заимствований

| Возможность Linear | Решение Task Manager | Причина |
|---|---|---|
| Issue ID, title, status | Взять | Минимальная надёжная identity |
| Priority с короткой шкалой | Взять | Меньше ложной точности |
| Assignee, labels, estimate, due date | Взять | Нужны для views и планирования |
| Custom workflow statuses | Упростить | Один workflow, системные категории |
| Projects | Взять ядро | Outcome, срок, owner, progress |
| Project milestones | Слить с Release | Не плодить похожие временные сущности |
| CI/CD releases/pipelines | Упростить | Ручной project release без integration |
| Cycles | Не брать | Отдельная sprint-модель не требуется |
| List/board | Взять | Две проекции одного query |
| Custom views | Взять ядро | Основной способ повторного доступа к срезам |
| Nested AND/OR filters | Отложить часть UI | Формат расширяемый, UI MVP только AND |
| Multiple grouping/swimlanes | Отложить | Сильно увеличивает UI/state complexity |
| Sub-issues и relations | Взять ядро | Декомпозиция и blockers без новых сущностей |
| Teams и initiatives | Не брать | Организационный слой вне продукта |
| Timeline/roadmap/forecasting | Не брать | Не нужен для ежедневного task flow |
| Comments/docs/notifications | Не брать | Коммуникационная платформа вне MVP |
| AI и analytics | Не брать | Не подтверждают основную гипотезу продукта |

## Рекомендованная форма MVP

```text
Project
└── Release (0..N)
    └── Task (0..N)

Task -> WorkflowStatus
Task -> labels / assignee / dates / estimate / relations
SavedView -> filter + layout + grouping + ordering + visible fields
```

Задача может быть в project без release и вне project. Release без project
невозможен. List и Kanban никогда не владеют задачами.

## Повторная сверка фильтров 2026-08-18

Официальные страницы [Filters](https://linear.app/docs/filters),
[Custom Views](https://linear.app/docs/custom-views) и
[Display options](https://linear.app/docs/display-options) повторно проверены
перед реализацией filter contract.

Подтверждённый baseline Linear: `F` открывает filters, изменения отражаются в
URL, property picker searchable, а условия представлены редактируемыми tokens.
Документация показывает `is`/`is not`, множественные категориальные значения,
date before/after и advanced AND/OR с nested groups. Temporary filters можно
передать ссылкой и затем сохранить/скопировать в Custom View.

Принятое отличие Task Manager: MVP UI показывает только root `AND` и не
публикует disabled `OR`, nested groups, AI filters, teams или cycles. Stored
query уже versioned (`version: 1`, `op: all`, typed conditions), поэтому это
ограничение интерфейса не создаёт второго flat формата. Собственные controls,
copy и assets сохраняют product identity Task Manager.

## Источники

Все источники — официальная документация Linear, проверенная 2026-08-13:

- [Create issues](https://linear.app/docs/creating-issues)
- [Issue status](https://linear.app/docs/configuring-workflows)
- [Projects](https://linear.app/docs/projects)
- [Project overview](https://linear.app/docs/project-overview)
- [Project milestones](https://linear.app/docs/project-milestones)
- [Releases](https://linear.app/docs/releases)
- [Cycles](https://linear.app/docs/use-cycles)
- [Custom Views](https://linear.app/docs/custom-views)
- [Filters](https://linear.app/docs/filters)
- [Display options](https://linear.app/docs/display-options)
- [Board layout](https://linear.app/docs/board-layout)
- [Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)
- [Issue relations](https://linear.app/docs/issue-relations)

## Ограничения и уверенность

Уверенность высокая в описанных продуктовых сущностях и публичном поведении,
но средняя в деталях UX, которые могут зависеть от плана Linear и workspace
settings. Исследование не подтверждает выбранный стек, database schema,
performance targets или пригодность будущей реализации — эти решения остаются
открытыми.
