# Спецификация MVP

Статус: `Proposed`

Последнее обновление: 2026-08-14

## 1. Цель

MVP должен позволить вести задачи от backlog до поставленного релиза, используя
проекты, метаданные, сохранённые представления и Kanban. Спецификация описывает
поведение, а не выбранную реализацию.

## 2. Термины

- **Task** — минимальная отслеживаемая единица работы.
- **Project** — ограниченная по результату и времени группа задач.
- **Release** — именованный состав задач одного проекта, планируемый или уже
  поставленный в определённый момент.
- **Workflow status** — пользовательское состояние задачи внутри стабильной
  системной категории.
- **Saved view** — сохранённая комбинация scope, фильтра и display options.
- **Layout** — способ отрисовки результата view: `list` или `board`.
- **User** — внутренний пользователь Task Manager, не зависящий от конкретного
  login provider.
- **User identity** — подтверждённая связь User с аккаунтом ChatGPT или Google.
- **Access grant** — явный полный доступ другого User к shareable resource.

### 2.1 Интерфейсный принцип

Для каждой функции в scope актуальный интерфейс Linear является основным
референсом. Controls должны быть максимально близки по назначению,
расположению, interaction patterns, плотности и визуальному языку. Похожий
control обязан работать, а не быть декоративной копией.

Полный контракт определён в
[спецификации интерфейса](interface.md), а принятое направление — в
[ADR-0002](../decisions/0002-linear-interface-parity.md). При конфликте
приоритет имеют эта спецификация MVP, доменные/authorization invariants,
accessibility и ограничения ChatGPT Sites. Функции Linear вне границ MVP не
должны появляться как пустые или disabled controls.

## 3. Пользователи и authentication

- Для чтения или изменения данных Task Manager пользователь должен войти через
  ChatGPT либо Google. Anonymous application data в MVP нет.
- Первый успешный вход создаёт внутренний `User` и `UserIdentity` выбранного
  provider. Повторный вход находит тот же User по проверенному provider key.
- Один User может явно связать ChatGPT- и Google-identity. Совпадение email без
  подтверждённого linking flow не объединяет аккаунты автоматически.
- `Sign in with ChatGPT` использует platform-provided Sites routes и trusted
  headers на server boundary. UI не может передать identity собственным полем.
- Google sign-in является обязательным external provider. Реализация должна
  проверить Sites-compatible OAuth/OIDC flow и валидировать provider response
  server-side до создания session.
- В профиле доступны display name, verified email, timezone, список связанных
  providers и sign out. Пароли Task Manager не хранит.

## 4. Изоляция данных и sharing

- Все Tasks, Projects, Releases, SavedViews, Labels и WorkflowStatuses имеют
  одного владельца и приватны по умолчанию.
- Любой query, search, lookup и mutation возвращает только собственные records
  текущего User и resources с действующим `AccessGrant`.
- Единственная permission в MVP — `full_access`; read-only/editor/admin ролей
  пока нет.
- `full_access` включает чтение, редактирование, создание дочерних records,
  архивирование, восстановление и управление sharing в пределах выданного
  resource subtree. Владелец остаётся владельцем и всегда сохраняет доступ.
- Пользователь может выдать или отозвать grant только уже зарегистрированному
  User, найденному по verified email. Отправка email invitation не входит в
  MVP.
- Share Project распространяется на его Tasks и Releases. Release отдельно не
  шарится. Task внутри Project доступна collaborator только через grant Project.
- Напрямую можно поделиться standalone Task. Пока у неё есть direct grants, её
  нельзя переместить в Project; сначала grants должны быть отозваны.
- SavedView можно расшарить отдельно, но grant view не предоставляет доступ к
  найденным им Tasks. Получатель видит пересечение view с уже доступными ему
  данными.
- Resources, которыми поделились с User, доступны в `Shared with me`. Revoke
  прекращает новые чтения и mutations немедленно после завершения транзакции.
- Task/Release, созданные collaborator внутри shared Project, наследуют
  `owner_user_id` Project; `creator_id` сохраняет фактического автора.

## 5. Задачи

### 5.1 Создание и идентичность

- Пользователь может создать задачу из глобального списка, проекта, релиза или
  конкретной колонки Kanban.
- Пользователь вводит только заголовок; система атомарно назначает уникальный
  в пределах owner scope идентификатор вида `TM-123`, начальный статус и
  позицию.
- Идентификатор не переиспользуется после архивирования или удаления.
- Контекст создания предварительно заполняет metadata: проект, релиз, статус
  либо значение текущей группы.
- Standalone Task получает owner текущего User. Task, созданная в Project,
  наследует owner Project даже при создании collaborator.

### 5.2 Metadata

Карточка задачи позволяет читать и менять:

- title и Markdown description;
- workflow status и priority;
- assignee;
- project и совместимый release;
- labels;
- estimate и due date;
- parent и subtasks;
- relations: `blocks`, `related`, `duplicate_of`;
- created, updated, started, completed, canceled и archived timestamps.

Assignee обязан быть владельцем Task либо пользователем с доступом к Task или
её Project. Выбор пользователя без доступа отклоняется.

Точные поля и допустимые значения определены в
[доменной модели](../reference/domain-model.md).

### 5.3 Жизненный цикл

- Переход в системную категорию `started` впервые выставляет `started_at`.
- Переход в `completed` выставляет `completed_at` и очищает `canceled_at`.
- Переход в `canceled` выставляет `canceled_at` и очищает `completed_at`.
- Повторное открытие очищает terminal timestamp, но не историю изменений, если
  такая история будет добавлена позднее.
- Архивная задача исключена из обычных views, но доступна через архив и может
  быть восстановлена.
- Необратимое удаление требует отдельного подтверждения и не является
  обязательным для первого вертикального среза.

### 5.4 Иерархия и отношения

- У задачи может быть не более одного parent и любое количество subtasks.
- Система запрещает прямые и косвенные циклы в иерархии.
- `blocks` направлено; обратная сторона показывается как `blocked_by`.
- `related` симметрично.
- `duplicate_of` направлено на каноническую задачу; self-relations и дубликаты
  одной связи запрещены.
- Автоматическое закрытие parent по subtasks не входит в MVP.

## 6. Workflow

- Система поставляется со статусами `Backlog`, `Todo`, `In Progress`, `Done`,
  `Canceled`.
- Пользователь может переименовать, перекрасить, добавить и упорядочить
  workflow statuses.
- Каждый статус принадлежит одной неизменяемой категории: `backlog`,
  `unstarted`, `started`, `completed`, `canceled`.
- В каждой категории должен оставаться хотя бы один разрешённый статус, если
  категория используется системными действиями.
- Один статус категории `backlog` или `unstarted` является default для новых
  задач.
- Workflow statuses принадлежат User. Shared Project использует каталог своего
  owner; collaborator может применять существующие statuses, но не получает
  доступ к account-wide настройке каталога только из project grant.

## 7. Проекты

- Для проекта обязателен только name.
- Новый Project принадлежит создавшему его User.
- Проект поддерживает summary, Markdown description, status, lead, start date,
  target date, icon/color и timestamps.
- Задача принадлежит максимум одному проекту.
- Экран проекта содержит overview, прогресс и views его задач.
- Базовый прогресс — доля неархивных задач проекта в категории `completed`;
  canceled-задачи не входят в знаменатель. Взвешивание по estimate отложено.
- Завершение проекта не завершает открытые задачи автоматически; интерфейс
  должен показать предупреждение и их количество.
- Lead обязан иметь доступ к Project. Task, созданная collaborator внутри
  Project, остаётся в owner scope Project.

## 8. Релизы

- Release всегда принадлежит ровно одному Project.
- `owner_user_id` Release совпадает с owner Project и не меняется отдельно.
- Release поддерживает name/version, description, status, target date,
  released_at и release notes.
- Статусы release: `planned`, `active`, `released`, `canceled`.
- Задача входит максимум в один release и только в release своего проекта.
- Выбор release для задачи без проекта автоматически выбирает его проект.
- Смена проекта при несовместимом release требует подтверждения и атомарно
  очищает release.
- Перевод release в `released` фиксирует `released_at`, но не переводит задачи
  в Done автоматически.
- Состав выпущенного release остаётся редактируемым только через явно
  подтверждённую операцию; изменения должны быть заметны пользователю. Полный
  audit log отложен, поэтому реализация может сначала запрещать такие правки.
- Прогресс release считается по той же формуле, что и прогресс project, но
  только для задач release.

## 9. Views и фильтры

### 9.1 Модель

- View не хранит снимок задач; при открытии он выполняет сохранённый запрос к
  текущим данным.
- Встроенные views: `All tasks`, `Active`, `Backlog`, `My tasks` и `Archived`.
- Пользователь может сохранить изменённый view под новым именем, обновить его
  или удалить.
- View может иметь global scope либо scope одного project.
- View приватен по умолчанию и может получить отдельный `AccessGrant`.
- Исполнение view всегда пересекает filter с authorization scope читателя;
  shared view не раскрывает недоступные records и их aggregate counts.

### 9.2 Фильтрация

Фильтры должны покрывать status/category, priority, assignee, project, release,
labels, estimate, due date, parent/subtask, relation presence, created/updated/
completed dates и archived state.

- Для категориальных полей доступны `is`, `is_not`, `in`, `not_in`, `is_empty`.
- Для дат и чисел доступны равенство и сравнения; даты также поддерживают
  относительные интервалы вроде `overdue` и `next_7_days`.
- Первый UI может соединять условия только через `AND`; формат хранения не
  должен препятствовать последующему добавлению `OR` и вложенных групп.
- Временные фильтры меняют URL/session state, но не сохранённый view, пока
  пользователь явно не нажал Save.

### 9.3 Display options

- Layout: `list` или `board`.
- Group by: `status`, `priority`, `assignee`, `project`, `release` или none.
- Order by: manual rank, priority, created, updated, due date или title.
- Direction: ascending/descending, кроме manual.
- Пользователь выбирает видимые metadata fields и показ пустых групп.
- Sub-grouping/swimlanes и независимые настройки одного view для разных
  пользователей отложены.

## 10. List и Kanban

- List и board показывают один результат фильтра и одинаковый набор задач.
- Оба layout используют одну Linear-like toolbar: `Filter`, layout switch,
  `Display`, save/update view и contextual create action.
- Board по умолчанию группируется по status; каждая группа — колонка.
- Перетаскивание карточки между колонками меняет значение поля группировки.
- Перетаскивание внутри колонки меняет manual rank.
- При non-manual sort вертикальное перетаскивание отключено, чтобы UI не
  обещал порядок, который запрос затем проигнорирует.
- Создание в колонке предварительно назначает значение этой колонки.
- Карточка показывает title и выбранные display fields; полное описание
  открывается в details panel/page.
- Ошибка серверной валидации возвращает карточку в подтверждённое положение и
  объясняет причину.
- Task в list/board можно highlight, выбрать через hover checkbox или `X` и
  добавить в multi-selection через `Shift`. Для выбранных задач доступны
  только поддержанные MVP и разрешённые ACL bulk actions.
- Right-click, overflow menu и `Cmd/Ctrl+K` используют одну модель contextual
  actions. Полная глобальная command palette Linear в MVP не входит.
- `Space` открывает read-only Peek выбранной/highlighted Task или Project без
  потери текущего filter, scroll и selection context.
- Mouse и keyboard actions, визуальные состояния и layout surfaces следуют
  [спецификации интерфейса](interface.md).

## 11. Поиск

- Поиск находит точный task identifier и полнотекстовые совпадения в title и
  description.
- Результат поиска можно дополнительно фильтровать и открыть в list/board.
- Search применяет authorization scope до формирования matches, counts и
  подсказок и не подтверждает существование чужого identifier.
- `/` открывает global search overlay, а `Cmd/Ctrl+F` ищет внутри текущего view.
- Нечёткий поиск, полная workspace-wide command palette и поиск по комментариям
  не входят в MVP. Ограниченное contextual actions menu по `Cmd/Ctrl+K`
  содержит только уже реализованные действия MVP.

## 12. Сквозные требования

- Все изменения проходят одинаковую серверную валидацию независимо от экрана.
- Authentication и authorization выполняются server-side. Клиентские owner,
  email, provider и permission claims не считаются доверенными.
- Ошибка доступа не должна раскрывать, существует ли чужой resource.
- Конфликт параллельного обновления не должен молча затирать более новую
  версию; API возвращает conflict с актуальным record.
- Время хранится в UTC и показывается в timezone пользователя.
- Обычные views по умолчанию исключают архивные записи.
- Пустые и loading/error состояния являются частью каждой основной
  поверхности.
- Accessibility baseline: работа с клавиатуры, видимый focus, семантические
  controls и достаточный contrast.
- Обязательны `system`, `light` и `dark` theme в единой Linear-like visual
  system. Product name, logo, тексты и assets остаются собственными.
- Каждый видимый control должен иметь реализованное действие или ясное
  disabled-состояние по текущему контексту; controls функций вне MVP не
  показываются.
- Structured application data сохраняются в Sites D1. Provider secrets и
  session secrets хранятся только в hosted environment settings.

## 13. Проверяемые сценарии приёмки

1. Войти через ChatGPT и через Google, получить устойчивые sessions и не иметь
   возможности подменить User клиентским header/parameter.
2. Создать два User с одинаковыми task identifiers и убедиться, что каждый без
   grant видит только собственные records, search results и counts.
3. Поделиться Project с зарегистрированным User: он видит и меняет Project,
   Tasks и Releases, а созданная им Task наследует owner Project.
4. Отозвать Project grant и подтвердить, что бывший collaborator больше не
   может читать или менять subtree даже по сохранённому URL.
5. Поделиться SavedView без underlying Project grant и убедиться, что view не
   раскрывает чужие Tasks или aggregate counts.
6. Создать project, release и task из колонки `Todo`; задача получает project,
   release и status без дополнительного редактирования.
7. Сохранить view «Urgent release» с фильтрами по project, active release и
   priority; после изменения задачи она появляется или исчезает без ручного
   добавления во view.
8. Переключить один view между list и board и увидеть одинаковые task IDs.
9. Перетащить task из `Todo` в `In Progress`; status и `started_at` меняются,
   а задача остаётся видна во всех подходящих views.
10. Попытаться назначить release другого project и получить отказ без частично
   сохранённых изменений.
11. Завершить release при наличии открытых задач: release становится released,
   задачи не становятся Done автоматически.
12. Заархивировать и восстановить task; идентификатор и metadata сохраняются.
13. Создать parent chain и убедиться, что попытка замкнуть цикл отклоняется.
14. Переключить list/board через toolbar и `Cmd/Ctrl+B`, открыть `Filter` через
    `F`, `Display` через `Shift+V` и Peek через `Space`; shortcuts не
    срабатывают внутри text input/editor.
15. Выбрать несколько Tasks мышью и клавиатурой, применить разрешённое bulk
    action и подтвердить атомарное server update либо полный rollback.
16. Проверить основные surfaces в light/dark theme и сверить composition,
    controls и interaction states с актуальным Linear reference по
    [UI-спецификации](interface.md), не используя бренд или assets Linear.

## 14. Рекомендуемые вертикальные срезы

1. Sites-compatible Linear-like shell + visual tokens + ChatGPT/Google
   authentication + UserIdentity.
2. D1 + owner scoping на repository/API boundary + isolation integration tests.
3. Tasks + default workflow + dense list, composer и details.
4. Kanban по status + manual rank + selection/context actions + Peek.
5. Projects + project-scoped Tasks + Releases.
6. AccessGrant + `Shared with me` + share dialog + revoke и re-share tests.
7. Filters + SavedView + authorization-aware queries/display options.
8. Labels, assignee, dates, estimates, subtasks и relations.
9. Search, archive, concurrency conflicts, responsive/accessibility и visual
   parity hardening.
