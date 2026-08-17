# Спецификация MVP

Статус: `Proposed`

Последнее обновление: 2026-08-17

## 1. Цель

MVP должен позволить вести задачи от backlog до поставленного релиза, используя
проекты, метаданные, сохранённые представления и Kanban, а также безопасно
читать и менять задачи через compact list/detail API. Спецификация описывает
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
- **Access grant** — явная роль другого User на shareable resource.
- **Application administrator** — пользователь из server-side allowlist,
  которому доступна operational статистика системы без доступа к содержимому
  чужих user-owned resources.
- **Agent API** — versioned интерфейс progressive disclosure: групповые запросы
  возвращают компактные metadata, а полный контекст читается по одной сущности.
- **API credential** — отдельно выданная и отзываемая capability, которая
  сопоставляется внутреннему User и не является Sites browser session или
  application-admin permission.
- **MCP connector** — remote task-oriented tool surface для Codex/ChatGPT;
  основной Connect flow использует OAuth 2.1 Authorization Code + PKCE.
- **Comment** — native discussion record одной Task; root Comment создаёт
  thread, reply принадлежит ровно одному root thread.
- **Attachment** — приватный файл или raster image одной Task: metadata
  хранится в D1, body — в environment-isolated R2 и не имеет публичного URL.

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

### 3.1 Администрирование

- Application administrator определяется только на сервере по нормализованному
  verified email из hosted allowlist. Клиентский флаг или URL не предоставляет
  admin access.
- Для администратора доступен `/admin` из account menu; отдельного пункта в
  основной левой навигации нет. Прямой запрос обычного User fail-closed и не
  возвращает user statistics.
- Overview показывает число зарегистрированных и активных за последние 7 дней
  пользователей, суммарные Tasks, Projects, Releases и SavedViews.
- Таблица пользователей показывает display name, verified email, дату
  регистрации, время последнего authenticated request, последнее изменение
  owned Task/Project/Release/SavedView и owner-scoped counts по этим entities.
- Admin overview не предоставляет доступ к title, description, filter query или
  другому содержимому чужих records. Shared resources считаются по owner и не
  дублируются у collaborator.
- Отдельные system operations `Export backup` и `Import backup` доступны той же
  server-side admin boundary. Export включает всё D1 application state, включая
  content, identities, ACL, provenance и archived records; hosted secrets,
  deployment/audience state, analytics, schema и browser-local preferences не
  входят.
- Import поддерживает только полную замену. До mutation сервер проверяет format
  version, типы, уникальность, ссылки, owner/domain invariants и наличие
  текущей admin identity; затем staging atomically заменяет live state одной
  D1 transaction. Merge и partial restore отсутствуют.
- Отдельный login-event или audit-event log пока не моделируется. Поэтому
  «last active» означает последний подтверждённый запрос, а не доказанный новый
  sign-in внутри уже действующей Sites session.

### 3.2 Workspace overview

- Канонический корень авторизованного продукта — `/workspace`; прежний `/`
  перенаправляется туда. `My tasks` остаётся отдельной task surface `/issues`.
- Overview показывает только доступные текущему User компактные итоги: active и
  backlog Tasks, последние Tasks, Projects и их progress, Releases с Project
  context, SavedViews и верхнеуровневые ресурсы `Shared with me`.
- Overview строится из того же server-authorized ACL-scoped snapshot. Он не
  загружает task descriptions, labels, relations, native comments, imported
  external context или admin aggregates и не вводит отдельный unscoped query.
- Create actions показываются только там, где User может создать ресурс:
  standalone Task и Project доступны авторизованному User, а Release — только
  при наличии редактируемого Project.
- Product mark/name и первый сегмент breadcrumb ведут на `/workspace`;
  Back/Forward, direct link и mobile navigation сохраняют canonical route.
- Empty state отдельно объясняет отсутствие доступных records и предлагает
  только разрешённые действия, не подменяя его административной статистикой.

## 4. Изоляция данных и sharing

- Все Tasks, Projects, Releases, SavedViews, Labels и WorkflowStatuses приватны
  по умолчанию. Наличие URL или аккаунта не даёт доступ к чужому content.
- Любой query, search, lookup и mutation сначала вычисляет effective role на
  сервере и только затем читает либо изменяет resource.
- У Project ровно один `Owner` и три grant-роли: `Manager`, `Editor`, `Viewer`.
  Каждый более сильный уровень включает полномочия более слабого. Application
  administrator из раздела 3.1 не является project role.
- `Viewer` читает Project и его subtree, но не меняет их. `Editor` дополнительно
  создаёт и изменяет Tasks, Releases и project-scoped SavedViews, двигает Tasks
  по workflow, архивирует и восстанавливает records.
- `Manager` дополнительно приглашает Users и назначает/изменяет только роли
  `Editor` и `Viewer`. `Owner` может назначать вплоть до `Manager`, отзывать
  grants и передать ownership уже добавленному участнику.
- Ownership transfer не требует подтверждения получателя: target немедленно
  становится Owner, прежний Owner — Manager. Owner grant не хранится, поэтому
  Owner всегда ровно один.
- Пользователь может выдать grant только уже зарегистрированному User,
  однозначно найденному по verified email. Email invitation не отправляется.
- Project role распространяется на Project, его Tasks, Releases и SavedViews с
  явным `scope_project_id`. Release и project child отдельно не шарятся.
- Для project child effective access определяется текущим Project owner/grant,
  а не историческим `owner_user_id`. Передача ownership не меняет immutable
  task identifiers и provenance/catalog scope дочерних records.
- Standalone Task и global SavedView можно расшарить напрямую с ролью `Editor`
  или `Viewer`. Пока standalone Task имеет direct grants, её нельзя переместить
  в Project; сначала grants должны быть отозваны.
- Global SavedView не расширяет доступ к попавшим в query Tasks. Получатель
  видит пересечение view с уже доступными ему данными.
- Resources, которыми поделились с User, доступны в `Shared with me`. Revoke
  прекращает новые чтения и mutations немедленно после завершения транзакции.
- Необратимое удаление допускается только для Owner после отдельного
  подтверждения; первый срез может ограничиться обратимым archive/restore.

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
- native comment threads, replies, reactions и resolved state;
- native attachments с проверенным type/size/checksum и processing state;
- created, updated, started, completed, canceled и archived timestamps.
- для импортированной задачи — source provenance, включая read-only archive
  исходных комментариев и ссылки на исходные attachments; этот archive отделён
  от native comments и не получает write controls.

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

### 5.5 Native comments

- Любой User с доступом к Task читает её native comments. Создание, reply,
  reaction и resolve/reopen требуют не ниже Editor; Viewer не выполняет ни одну
  comment mutation.
- Author всегда выводится из server-verified current User. Client не может
  назначить другого автора. Редактировать comment может только его author;
  soft-delete разрешён author, Project Owner или Manager и оставляет tombstone,
  чтобы replies не теряли контекст.
- Thread имеет один root и одноуровневые replies. Reply на reply нормализуется к
  root; новый reply автоматически открывает resolved thread.
- Create требует idempotency key, mutations используют optimistic `version`, а
  reaction задаётся желаемым состоянием `active`, поэтому retry не создаёт
  дубликат.
- Root threads читаются стабильной keyset pagination. Comment bodies не входят
  в `/api/bootstrap` или Task list/detail projection и запрашиваются отдельным
  ACL-scoped вызовом при открытии Activity.
- Body хранится как ограниченный plain Markdown-like text. UI безопасно
  отрисовывает форматирование без raw HTML и разрешает ссылки только схем
  `http`, `https` и `mailto`.
- Локальный draft изолирован ключом current User + Task + optional thread.
  Mentions, attachments именно к comment, notifications, subscriptions и общий
  activity feed не входят в этот срез.

### 5.6 Native attachments

- Attachment принадлежит ровно одной Task и не расширяет её ACL. Viewer может
  читать/download/preview; upload, recoverable delete и restore требуют Editor.
- Upload принимает bounded binary body с обязательным idempotency key. Сервер
  проверяет magic bytes, MIME, размер и raster dimensions, вычисляет SHA-256 и
  формирует случайный environment-scoped object key без filename.
- HTML и SVG отклоняются. Не-image content всегда скачивается как attachment;
  raster preview получает `nosniff`, private/no-store и не использует public или
  долговечный signed URL. Range request повторяет Task ACL до R2 read.
- `deleted` metadata восстанавливается в grace period; отдельный bounded cleanup
  удаляет R2 object перед metadata row. Просроченные uploads переходят в
  предсказуемый failed state, а orphan cleanup повторяем и идемпотентен.
- Attachment bodies, object keys и delivery URLs не входят в bootstrap, sync,
  compact task list или Agent Task collection. Metadata загружается отдельным
  ACL-scoped endpoint после открытия Task details. Agent REST/MCP возвращают
  только bounded metadata и bearer-protected Agent content URLs.
- Details показывает lazy attachment count/list, XHR upload progress,
  retry/cancel, safe download, recoverable delete/restore и Viewer read-only
  state. Raster list использует отдельный authenticated server thumbnail;
  full-size original загружается только в preview/download.
- Markdown description может встроить только готовый raster Attachment той же
  Task через версионированный стабильный token
  `![alt](attachment:v1:<public-ref> "caption")`. Token хранит непрозрачный
  reference, а не R2 key, public URL или signed URL. Editor вставляет image из
  picker/drop/paste в текущую позицию курсора, показывает progress/retry/cancel
  и оставляет alt/caption редактируемыми как текст.
- При каждом create/update description server проверяет синтаксис token,
  текущую Task, `kind=image` и `state=ready`; тот же repository invariant
  действует для UI, REST Agent API и MCP. Чужой, угаданный, удалённый,
  незавершённый или non-image Attachment отклоняется без раскрытия его
  существования. Attachment нельзя удалить, пока description на него ссылается.
- Read-only Markdown renderer лениво получает только ACL-scoped metadata,
  показывает responsive image/optional caption, открывает private full preview
  и при недоступности использует безопасный placeholder без утечки URL.
- Composer сначала создаёт Task и лишь затем загружает выбранные files с
  устойчивыми idempotency keys. Partial failure оставляет созданную Task и
  успешные Attachment records видимыми, явно предлагает retry и не создаёт
  object без Task.
- Attachment insert/update/delete создают ID-only `task_attachments`
  invalidation. Открытый lazy consumer перечитывает только metadata; локальный
  progress и обычный workspace snapshot не заменяются.

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

### 7.1 Project backup и restore

- Только current Owner может экспортировать и восстановить Project. Project
  roles и application-admin capability сами по себе этого доступа не дают.
- Export скачивает один versioned logical JSON bundle с Project, его Tasks,
  Releases, project-scoped SavedViews, labels, внутренней hierarchy/relations,
  native comments/reactions, provenance и dependency snapshot используемых
  каталогов.
- Bundle не содержит Users, identities, API credentials, глобальные views,
  чужие Projects или hosted configuration. Он привязан к исходным immutable
  IDs, current owner и тому же Site.
- Первая версия выполняет exact restore исходного Project: merge, copy-as-new и
  cross-Site remapping отсутствуют. Перед mutation сервер полностью проверяет
  checksum, ссылки, catalogs, collisions и domain invariants и сохраняет
  normalized rows в staging.
- Preview показывает create/update/delete, conflicts, потерянные external
  references и sharing. Для существующего Project apply требует свежий backup
  текущего состояния и точное имя Project; sharing восстанавливается только
  после отдельного opt-in.
- Replace Project subtree выполняется одной D1 transaction. Ошибка оставляет
  live state без изменений; relations к Tasks вне bundle не становятся живыми.

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
- View может иметь global scope либо явный scope одного Project.
- Project-scoped View имеет обязательный `scope_project_id`, жёстко ограничен
  этим Project и наследует его role. Он не получает отдельный `AccessGrant`.
- View без `scope_project_id` является global, может пересекать все доступные
  Projects и standalone Tasks и может получить прямой `Editor`/`Viewer` grant.
  Обычный filter по `project_id` внутри global View не меняет его access scope.
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
- Identity view/project/release/task кодируется отдельным стабильным публичным
  UUID, не раскрывающим внутренний или Linear source ID. Layout `list|board`
  кодируется стабильными path segments по контракту
  [интерфейсной навигации](interface.md#33-navigation-behavior); query
  parameters зарезервированы для временного filter state, а не выбора entity.

### 9.3 Display options

- Layout: `list` или `board`.
- Group by: `status`, `priority`, `assignee`, `project`, `release` или none.
- Order by: manual rank, priority, created, updated, due date или title.
- Direction: ascending/descending, кроме manual.
- Пользователь выбирает видимые metadata fields и показ пустых групп для
  группировок по `priority`, `assignee`, `project` и `release`. При группировке
  по `status` группы с нулевым числом задач не показываются независимо от
  сохранённой display-настройки; если результат целиком пуст, list и board
  показывают общий empty state без пустых контейнеров.
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

### 12.1 Доступ агентов

- Task Manager предоставляет agent API для workspace summary, Projects,
  Releases, compact task lists, одной полной Task, task create/update,
  отдельных native comment threads и native Attachment metadata/binary.
- List response не содержит task description, release notes, imported comments,
  native comment bodies, attachment metadata/bodies или полного provenance.
  Imported archive, native comments и native attachments читаются отдельными
  ACL-scoped запросами.
- Versioned HTTP API применяет те же server-side ownership/ACL rules и domain
  repository commands, что и product UI.
  `/api/bootstrap` остаётся внутренним UI snapshot и не является agent API.
- Canonical external reference сущности — immutable `public_id`; human task
  identifier используется для общения и только для однозначного lookup.
- Filters, pagination, counts и ambiguity resolution применяются после
  ownership/ACL scope и не раскрывают недоступные records.
- API credential не наследует admin capability. Внешний API не предоставляет
  backup/restore, sharing, ownership transfer, workflow или credential
  management operations.
- Reads требуют `api:read`; task/comment/attachment mutations — `api:write`.
  Update/edit/delete/resolve требуют optimistic version, comment/attachment
  create — idempotency key; все команды проходят те же role/domain checks, что
  UI.
- Native connector устанавливается одним plugin и подключается через OAuth
  consent без ручной передачи API secret. Он умеет получать все доступные
  Tasks, фильтровать их по Project/Release и загружать detail только после
  выбора.

Точные representations, routes, OpenAPI contract, authentication и acceptance
описаны в [спецификации agent API](agent-api.md).

### 12.2 Синхронизация интерфейса

- Hydrated application shell использует один общий sync coordinator для Tasks,
  Projects, Releases, SavedViews и membership/permissions. List, board,
  details, navigation, filters и selection не запускают собственные pollers.
- Видимая online-вкладка получает изменения других sessions через
  principal-scoped opaque cursor не реже одного раза в минуту. Hidden/offline
  вкладка приостанавливает запросы и сверяется сразу после возврата.
- Incremental create/update/archive/delete применяется идемпотентно ко всем
  surfaces. Удалённая или ставшая недоступной entity исчезает также из details,
  selection, breadcrumbs и связанных context records.
- Incremental core patch строится только по touched IDs, а не через полный
  workspace snapshot. Labels, relations, comments и imported external context
  передают только task-scoped invalidation IDs без своих records; их endpoint
  перечитывает только активный details/Peek/activity consumer. Закрытый cache
  остаётся загруженным, но помечается stale до следующего открытия.
- ACL вычисляется сервером до ответа. Grant/revoke, invalid cursor, gap и
  неизвестный event вызывают полный ACL-scoped bootstrap; клиент не получает
  payload чужой entity даже как delete metadata.
- Одновременно выполняется не больше одного sync request. Ошибки сети
  и 45-секундный timeout используют bounded backoff, reconnect продолжает с
  последнего подтверждённого cursor, а optimistic version conflicts остаются
  обязательными для writes. Journal хранится 30 дней; cursor старше retention
  boundary получает безопасный full bootstrap.

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
3. Добавить Viewer в Project: он видит Project, Tasks, Releases и
   project-scoped SavedViews, но все content mutations отклоняются сервером.
4. Повысить User до Editor: он меняет Tasks и workflow, но не управляет
   участниками. Manager добавляет/меняет только Editor/Viewer; попытка назначить
   Manager отклоняется. Owner может назначить любую grant-role.
5. Передать ownership уже добавленному User без его подтверждения: target сразу
   становится Owner, прежний Owner — Manager; immutable task IDs сохраняются.
6. Отозвать Project grant и подтвердить, что бывший collaborator больше не
   может читать или менять subtree даже по сохранённому URL.
7. Поделиться global SavedView без underlying Project grant и убедиться, что
   view не раскрывает чужие Tasks или aggregate counts; project-scoped View
   отдельно не шарится и не выходит за свой Project.
8. Создать project, release и task из колонки `Todo`; задача получает project,
   release и status без дополнительного редактирования.
9. Сохранить view «Urgent release» с фильтрами по project, active release и
   priority; после изменения задачи она появляется или исчезает без ручного
   добавления во view.
10. Переключить один view между list и board и увидеть одинаковые task IDs.
11. Перетащить task из `Todo` в `In Progress`; status и `started_at` меняются,
   а задача остаётся видна во всех подходящих views.
12. Попытаться назначить release другого project и получить отказ без частично
   сохранённых изменений.
13. Завершить release при наличии открытых задач: release становится released,
   задачи не становятся Done автоматически.
14. Заархивировать и восстановить task; идентификатор и metadata сохраняются.
15. Создать parent chain и убедиться, что попытка замкнуть цикл отклоняется.
16. Переключить list/board через toolbar и `Cmd/Ctrl+B`, открыть `Filter` через
    `F`, `Display` через `Shift+V` и Peek через `Space`; shortcuts не
    срабатывают внутри text input/editor.
17. Выбрать несколько Tasks мышью и клавиатурой, применить разрешённое bulk
    action и подтвердить атомарное server update либо полный rollback.
18. Проверить основные surfaces в light/dark theme и сверить composition,
    controls и interaction states с актуальным Linear reference по
    [UI-спецификации](interface.md), не используя бренд или assets Linear.
19. Открыть `/workspace` как отдельный ACL-scoped overview, перейти из него в
    `My tasks`, Projects, Releases, SavedViews и `Shared with me`, затем открыть
    индексы `/issues`, `/views`, `/projects`, `/releases`, список releases
    внутри Project и скопировать прямые URL saved view, его board, Project,
    Release и Task. Проверить owner/shared/empty scenarios, отсутствие lazy и
    admin content в overview, mobile layout без horizontal overflow, редирект
    `/` и старого internal-ID URL, Back/Forward и одинаковый `not found` для
    неизвестного и недоступного ID.
20. Войти администратором, открыть `/admin` и увидеть актуальные user/activity
    aggregates; повторить прямой запрос обычным User и получить fail-closed
    результат без email, counts или подтверждения существования admin surface.
21. Экспортировать полный system backup, импортировать его через preview и
    explicit `RESTORE`, затем подтвердить точное восстановление Users,
    identities, owner/ACL, catalogs, content, archived records и provenance.
    Повреждённый, несовместимый или invariant-invalid файл не меняет ни одной
    live row; обычный User не может вызвать export/import API.
22. Через agent API получить active/planned releases и compact задачи
    выбранного release: ответы содержат identifiers, titles, statuses и
    небольшие metadata, но не descriptions, comment bodies или release notes.
23. По canonical task reference загрузить одну Task с description, связями и
    provenance summary; imported archive появляется только после отдельного
    запроса. Недоступная Task возвращает тот же `not found`, что неизвестная.
24. Отозвать OAuth connection или API credential и Project grant: следующий API request
    немедленно теряет соответствующий доступ. Read-only credential не может
    вызвать task write или admin operation.
25. Через write credential создать Task в выбранном Release, перевести её в
    completed и получить обновлённые timestamps/version; повторить PATCH со
    старой version и получить полный отказ без last-write-wins.
    Тот же сценарий доступен через MCP tools после OAuth consent с
    `api:write`; read-only connection получает scope challenge.
26. Current Project Owner скачивает bundle, меняет и удаляет часть subtree,
    проходит preview и exact restore; Project IDs, Tasks, Releases, scoped
    Views, labels, hierarchy и provenance возвращаются. Manager/Editor/Viewer
    получают отказ на export и apply.
27. Повреждённый Project bundle, owner mismatch, collision или отсутствующий
    catalog dependency отклоняется до mutation. Ошибка apply откатывает весь
    subtree; sharing без opt-in не восстанавливается.
28. Из account menu открыть `Codex setup`, переключиться между `Codex Desktop`
    и `Codex CLI`, скопировать marketplace source или CLI-команды и завершить
    штатный OAuth flow без ручного MCP URL, client ID, secret или API token.
29. В Task Activity создать comment, повторить request с тем же idempotency key,
    ответить одним уровнем, поставить reaction, resolve/reopen, отредактировать
    с актуальной version и получить conflict со stale version. Viewer видит
    thread, но все mutations получают отказ; imported archive остаётся отдельным
    read-only provenance block. Те же операции доступны через Agent REST/MCP без
    user email и без comment bodies в task collections.
30. Открыть одну account/workspace в двух sessions: создать, изменить,
    заархивировать и удалить Task, Project, Release и SavedView и увидеть
    согласованный результат в list, board, details, sidebar и filters не позднее
    polling interval. Повторная доставка не создаёт дублей; gap/reconnect
    запускает full reset. После revoke бывший collaborator теряет entity и
    прямой details context без раскрытия чужого content.
31. Owner и Editor загружают PDF/raster image с idempotency key; Viewer читает
    metadata и Range/download, outsider получает такой же `not found`, как для
    неизвестной Task. После revoke доступ исчезает немедленно. MIME confusion,
    HTML/SVG, corrupted или oversized image отклоняются; delete восстанавливаем
    до grace cutoff, а cleanup не оставляет R2 object или live metadata orphan.
32. Через Agent REST и MCP отдельно получить native attachment metadata,
    загрузить binary, скачать original/thumbnail и выполнить versioned delete.
    `get_task` сообщает только count; list не содержит body/internal IDs/R2 key.
    MCP file input проходит bounded OpenAI HTTPS fetch без credentials и
    private redirect; raster ref вставляется только отдельным `update_task`.

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
10. Server-gated admin overview с registration/activity aggregates без
    расширения доступа к user-owned content.
11. Server-gated logical system backup/restore с staging, полным preflight и
    атомарным replace.
12. Agent API query/command service, compact/detail projections, OAuth-first
    remote MCP, revocable read/write credentials, REST v1, OpenAPI и tests.
13. Hosted OAuth/MCP smoke, rate limits, task-create idempotency и отдельно
    спроектированные bulk/metadata commands.
14. Owner-only Project bundle export/staging/exact restore с preview,
    confirmation, sharing opt-in и rollback tests.
15. Native task comments: Activity UI, ACL-scoped REST/Agent/MCP commands,
    idempotency/concurrency, backups и mobile verification.
16. Native attachment foundation и UI: D1 metadata, раздельные R2 bindings,
    ACL-scoped binary routes, content inspection, retry/cleanup, details/
    composer, description images и UAT smoke.
17. Native attachments для Agent REST/MCP: progressive metadata, private binary
    delivery, OpenAI file input, versioned delete и transport/security tests.
18. Attachment-aware system/project backup и restore.
