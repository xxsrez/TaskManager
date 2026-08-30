# Спецификация MVP

Статус: `Proposed`

Последнее обновление: 2026-08-25

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
- **Owner workspace scope** — UI-проекция доступных records по владельцу,
  применяемая только как дополнительное сужение уже вычисленного ACL; это не
  entity, tenant, grant или источник authorization.

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
- Каноническая Settings surface доступна по section routes
  `/settings/profile`, `/settings/appearance`, `/settings/workflow-statuses`,
  `/settings/labels`, `/settings/integrations`,
  `/settings/recently-deleted` и `/settings/project-backup`;
  direct URL, reload и browser history сохраняют выбранный раздел.
- В профиле доступны versioned display name, verified email, IANA timezone,
  server-projected список связанных providers и sign out. Email и provider
  identities нельзя подменить client payload; stale version и invalid timezone
  не оставляют частично сохранённую форму. Пароли Task Manager не хранит.
- Theme `system`/`light`/`dark` и default sidebar state принадлежат User, а не
  общей browser key, поэтому второй account не наследует чужие preferences.
- Account menu показывает интерактивный identity block с переходом в
  `/settings/profile`, `Workspace` с canonical anchor `/workspace`, единый
  `Settings` и только для server-authorized администратора `Administration`.
  Детальные каталоги, интеграции, backup и appearance доступны внутри Settings,
  но не дублируются прямыми пунктами account menu. Sign out остаётся отдельным
  action и не объединяется с account trigger или identity block.

### 3.1 Администрирование

- Application administrator определяется только на сервере по нормализованному
  verified email из hosted allowlist. Клиентский флаг или URL не предоставляет
  admin access.
- Для администратора доступен `/admin` из account menu; отдельного пункта в
  основной левой навигации нет. Прямой запрос обычного User fail-closed и не
  возвращает user statistics.
- Overview показывает число зарегистрированных и активных за последние 7 дней
  пользователей, суммарные Tasks, Projects, Releases, SavedViews и
  content-free Attachment count/bytes/states.
- Таблица пользователей показывает display name, verified email, дату
  регистрации, время последнего authenticated request, последнее изменение
  owned Task/Project/Release/SavedView и owner-scoped counts по этим entities.
- Admin overview не предоставляет доступ к title, description, filename,
  object key, file body, filter query или другому содержимому чужих records.
  Shared resources считаются по owner и не дублируются у collaborator.
- Отдельные system operations `Export backup` и `Import backup` доступны той же
  server-side admin boundary и находятся только в отдельном блоке резервного
  копирования на `/admin`, а не в общих действиях shell. Export создаёт
  resumable durable job и потоковый `.tmbak`, включающий всё D1 application state, включая
  content, identities, ACL, provenance, archived records и recoverable deletion
  tuple основных сущностей; hosted secrets, deployment/audience state,
  analytics, schema, browser-local preferences и operational purge jobs не
  входят.
- Одна команда продолжения export выполняет несколько bounded внутренних
  шагов под одной lease и сохраняет курсор после каждого шага. Пока
  административная страница открыта, application-level coordinator продолжает
  тот же job независимо от состояния dialog. Закрытие вкладки безопасно
  приостанавливает новые команды: повторное открытие находит текущий job на
  сервере и продолжает его без дублирования. Для одного администратора, Site и
  environment существует не больше одного текущего ordinary export в
  `running`/`ready`: обычный повтор переиспользует и выполняющийся, и уже
  готовый job. Явный новый export атомарно заменяет готовый job; если другой
  export ещё выполняется, сервер возвращает conflict и UI перечитывает
  канонический job, не выдавая его за новый страховочный снимок. Первая версия
  не использует Queue, Cron или обещание автономного выполнения при полностью
  закрытом браузере.
- Import поддерживает только полную замену. До mutation сервер проверяет format
  version, типы, уникальность, ссылки, owner/domain invariants и наличие
  текущей admin identity; затем staging atomically заменяет live state одной
  D1 transaction. Первый authenticated request после cutover может обновить
  `users.email`/`updated_at` и `verified_email` ровно той provider identity,
  которой выполнен запрос. Post-restore verification допускает только этот
  server-verified drift; любая другая identity mutation остаётся fail-closed.
  Merge и partial restore отсутствуют.
- Current system backup schema `15` — единственный принимаемый формат. Он
  следует исчерпывающему D1/R2 registry, включает `stored_files`,
  `attachments.stored_file_id` и `task_sequences`; schemas `2`–`14`
  отклоняются без upgrade. Project bundle использует отдельный schema `15` и
  свой compatibility contract.
- Отдельный login-event или audit-event log пока не моделируется. Поэтому
  «last active» означает последний подтверждённый запрос, а не доказанный новый
  sign-in внутри уже действующей Sites session.

### 3.2 Workspace overview

- Канонический корень авторизованного продукта — `/workspace`; прежний `/`
  перенаправляется туда. `My tasks` остаётся отдельной task surface `/issues`.
- В header доступен owner workspace selector: по умолчанию выбран текущий User,
  далее доступны владельцы хотя бы одного уже доступного root и `All
  accessible`. Для Project, Task, Release и project-scoped SavedView владельцем
  этой проекции всегда считается current Project owner; для global SavedView —
  собственный owner View. Исторический `owner_user_id` project child не
  определяет UI scope.
- Scope применяется на сервере после ownership/ACL predicate, но до totals,
  recents, task query, pagination и Project/Release/SavedView/Label catalogs.
  Поэтому selector не расширяет права и не может сделать видимым недоступный
  record. Agent API и прочие не-UI callers, не передавшие UI scope, сохраняют
  прежнее ACL-union поведение.
- Selector получает только compact opaque tokens и display labels без email и
  внутренних IDs. Выбор сохраняется для User в browser storage и history state,
  но не меняет canonical public-ID URL. Reload и Back/Forward восстанавливают
  доступный выбор; forged, stale, revoked или исчезнувший после ownership
  transfer token атомарно сбрасывается на scope текущего User.
- Прямой доступный deep link остаётся открываемым независимо от сохранённого
  фильтра и показывает owner context адресованного resource. Создание Project в
  чужом owner scope всё равно создаёт Project текущего User, переключает scope
  на текущего User и открывает канонический URL созданного Project.
- Overview показывает только доступные текущему User компактные итоги: active и
  backlog Tasks, последние Tasks, Projects и их progress, Releases с Project
  context, SavedViews и верхнеуровневые ресурсы `Shared with me`.
- Recent Projects, Releases и SavedViews используют тот же bounded contract,
  что sidebar: максимум три записи в порядке `updatedAt DESC, id DESC`; полные
  ACL-scoped коллекции остаются доступны через свои index surfaces.
- Bounded navigation projection не является каталогом picker-ов. Composer,
  filters, move/bulk dialogs, Saved View scope и Release create лениво
  дочитывают полный ACL-scoped Project/Release catalog по keyset pages.
- Bootstrap/sync reset явно сообщает bounded либо complete coverage. Отсутствие
  record в bounded payload не означает revoke/delete и не удаляет уже
  загруженный direct-route/catalog context; removal требует explicit change,
  targeted not-found либо authoritative complete snapshot.
- Overview строится из того же server-authorized ACL-scoped snapshot. Он не
  загружает task descriptions, labels, relations, unified comments,
  migration metadata или admin aggregates и не вводит отдельный unscoped query.
- Create actions показываются только там, где User может создать ресурс: Task
  и Release требуют редактируемый Project, а новый Project доступен
  авторизованному User.
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
  по workflow, назначает доступные labels, архивирует и восстанавливает records.
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
  task identifiers и provenance/catalog scope дочерних records. Явный перенос
  Task меняет identifier только по отдельному атомарному move contract.
- Global SavedView можно расшарить напрямую с ролью `Editor` или `Viewer`.
  Каждая Task наследует доступ только от своего Project.
- Global SavedView не расширяет доступ к попавшим в query Tasks. Получатель
  видит пересечение view с уже доступными ему данными.
- Resources, которыми поделились с User, доступны в `Shared with me`. Revoke
  прекращает новые чтения и mutations немедленно после завершения транзакции.
- `Shared with me` перечисляет только top-level Projects с явным Project grant
  и напрямую расшаренные global SavedViews. Унаследованные Tasks, Releases и
  project-scoped SavedViews не становятся отдельными строками этой surface.
  Открытие этой специальной collection использует `All accessible` и полные
  server-paginated Project/View catalogs, а не bounded snapshot `Your work`.
- Доступность Viewer/Editor/Manager/Owner controls определяется только
  server-derived `accessRole`; owner workspace scope не повышает role и не
  служит условием показа mutation controls.
- Archive и delete — разные lifecycle. Archive обратимо убирает record из
  обычной работы без запуска retention; `Delete` помещает Task, Project,
  Release или SavedView в `Recently deleted` на 30 дней. Delete/restore
  доступны той же роли Editor+, что обычное изменение content, а необратимый
  `Delete permanently` — только current Owner после отдельного подтверждения.
- Recoverable delete атомарно сохраняет `deleted_at`, server-verified
  `deleted_by_user_id` и `purge_after = deleted_at + 30 days`. Все три поля
  одновременно заполнены либо одновременно пусты. До `purge_after` record
  можно восстановить; после cutoff restore запрещён, но физический purge
  выполняется bounded opportunistic maintenance и не обещает точный
  wall-clock момент удаления.
- Обычные collection, search, navigation, pickers, filters и direct routes не
  проецируют deleted records. `Recently deleted` — отдельный ACL-scoped read
  contract; отсутствие либо недоступность record не раскрывается через URL,
  counts или filter suggestions. Delete приходит в обычные surfaces как sync
  remove, restore — как authoritative upsert.
- Project delete является shadow для всего subtree: Project, его Tasks,
  Releases и project-scoped SavedViews одновременно исчезают из рабочих
  surfaces без переписывания deletion tuple каждого child. Restore Project
  снимает только shadow Project и не восстанавливает child, который был удалён
  отдельно до удаления Project.
- Перед recoverable Project delete UI читает versioned Editor+ preview с
  физическими counts Tasks, Releases, project-scoped SavedViews, Comments и
  Attachments, а также отдельными `activeNavigation.releases` и
  `activeNavigation.savedViews`, исключающими уже deleted/archived navigation
  children. Это позволяет не вычитать скрытые ранее rows из global totals.
- Release delete не удаляет Tasks и сохраняет их внутренний `release_id` для
  lossless restore; deleted Release не является picker/filter target и не
  отображается как активное membership. Permanent purge Release атомарно
  очищает оставшиеся Task links. SavedView delete/restore не меняет Tasks и
  сохраняет base query, Display и scope.
- Delete/restore Task не каскадирует subtasks. Пока parent deleted, ordinary
  child projection скрывает parent ref; detach/reparent использует внутренний
  stored ref и сохраняется после restore. Parent lifecycle публикует child
  summary/detail и relation-detail invalidations без ложного повышения child
  version. Permanent Task purge отсоединяет оставшихся children, удаляет
  relations/Comments/Activity/Attachments после R2 cleanup и не возвращает
  identifier sequence в allocator.

## 5. Задачи

### 5.1 Создание и идентичность

- Пользователь может создать задачу из глобального списка, проекта, релиза или
  конкретной колонки Kanban.
- Пользователь вводит заголовок и выбирает Project; система атомарно назначает
  уникальный в пределах Project identifier вида `<project_code>-123`,
  начальный статус и позицию.
- Project sequence монотонна, поэтому identifier не переиспользуется после
  архивирования, удаления или переноса Task. При переносе Task получает новый
  identifier целевого Project, а прежний сохраняется как alias.
- Перенос — отдельная атомарная command, а не обычный Task patch. Она требует
  актуальную Task version и edit access к Task, исходному и целевому Projects;
  archived/canceled target отклоняется. Same-Project selection является no-op и
  не расходует sequence.
- Несовместимый Release и Assignee без доступа к target нельзя очистить молча:
  command содержит явный compatible replacement либо `null`. Task с parent или
  subtask сначала detach/reparent. `duplicate_of` необходимо явно unlink до
  переноса, потому что этот type остаётся same-Project; допустимые `blocks` и
  `related` сохраняют immutable relation identity при переносе.
- В одной D1 transaction allocator целевого Project, новый
  `project_id`/sequence/identifier, Release/Assignee и alias прежнего identifier
  либо применяются вместе, либо полностью откатываются. `public_id`, content,
  comments, attachments, labels и внутренние keys не меняются.
- Контекст создания предварительно заполняет metadata: проект, релиз, статус
  либо значение текущей группы.
- Каждая Task требует Project и наследует его owner даже при создании
  collaborator. Глобальный composer требует явного выбора Project.

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
- unified comment threads: native discussions и импортированная история,
  replies, reactions и resolved state;
- append-only Task Activity с native mutations и перенесённой Linear status
  history;
- native attachments с проверенным type/size/checksum и processing state;
- created, updated, started, completed, canceled и archived timestamps.
- Provider provenance, source URLs, legacy attachment links и branch metadata
  не входят в Task product surface. Перенесённые комментарии и status history
  доступны только через native Comments/Activity; raw migration evidence
  остаётся в backup/reconciliation слое до отдельно разрешённого cleanup.

Assignee обязан быть владельцем Task либо пользователем с доступом к Task или
её Project. Выбор пользователя без доступа отклоняется.

Label принадлежит owner catalog Task. Только владелец каталога создаёт,
редактирует, архивирует и восстанавливает labels; имя активно и уникально в
этом catalog без учёта регистра. `Editor` может назначать Task несколько
активных labels её owner catalog, `Viewer` только читает назначения. Архивный
label остаётся видимым на уже размеченных Tasks и доступен для снятия, но не для
нового назначения. Composer принимает несколько labels, одиночные add/remove
commands задают желаемое состояние идемпотентно, а bulk add/remove применяется
атомарно к выбранному совместимому набору Tasks.

Owner также управляет ordered `LabelGroup`: active name уникально без учёта
регистра, archive/restore сохраняет историю, а Labels группы принадлежат тому же
owner catalog. На Task допускается максимум один Label каждой группы. Set,
replace и clear одного group value атомарны, дают один Activity event и
одинаково enforced в UI, REST, Agent/MCP, bulk, import и restore. Ungrouped
Labels остаются независимым multi-select. Saved View хранит group/filter refs по
immutable ID и может группировать Tasks по значениям одной группы с явной
колонкой `No <group>`.

Точные поля и допустимые значения определены в
[доменной модели](../reference/domain-model.md).

### 5.3 Жизненный цикл

- Переход в системную категорию `started` впервые выставляет `started_at`.
- Переход в `completed` выставляет `completed_at` и очищает `canceled_at`.
- Переход в `canceled` выставляет `canceled_at` и очищает `completed_at`.
- Повторное открытие очищает terminal timestamp и добавляет ActivityEvent, не
  удаляя прежнюю историю изменений.
- Архивная задача исключена из обычных views, но доступна через архив и может
  быть восстановлена.
- Delete Task переносит её в `Recently deleted`, не меняя immutable identity,
  content, subtasks, relations, Comments, Activity или Attachments. Restore в
  пределах retention возвращает тот же record. Permanent purge удаляет
  зависимые D1 rows только после успешного удаления всех R2 originals; failed
  cleanup остаётся retryable и не оставляет live metadata, ложно объявленную
  очищенной.

### 5.4 Иерархия и отношения

- У задачи может быть не более одного parent и любое количество subtasks.
- Система запрещает прямые и косвенные циклы в иерархии.
- Parent и child всегда принадлежат одному Project. Set/change/clear parent
  выполняется одной versioned command; self-parent, cross-Project target,
  недоступный target и cycle отклоняются повторным server-side guard без
  промежуточной записи.
- Create subtask наследует Project parent, атомарно получает следующий
  project-local identifier и повышает version parent. Поэтому stale retry не
  создаёт второй Task. Editor и более сильные роли меняют hierarchy, Viewer
  только читает её.
- Перенос Task в другой Project запрещён, пока у Task есть parent или прямые
  subtasks. Archive/restore сохраняет существующие edges; archived Task нельзя
  выбрать новым parent.
- `blocks` направлено; обратная сторона показывается как `blocked_by`.
- `related` симметрично.
- `duplicate_of` направлено на каноническую задачу; self-relations и дубликаты
  одной связи запрещены. В отличие от `blocks` и `related`, `duplicate_of`
  допустимо только между Tasks одного Project.
- `blocks` и `related` могут связывать разные Projects того же Site. Автор
  mutation обязан иметь Editor или выше на обеих Tasks через ACL их собственных
  Projects. Viewer видит relation только при read access к обеим сторонам и не
  может её изменить; недоступный peer возвращает `not_found` без раскрытия
  существования Task или самого edge.
- Каждая relation имеет immutable identity, idempotency key создания и
  независимую optimistic `version`. Изменение direction/type и удаление требуют
  актуальную relation version. Изменение type повторно проверяет same-Project
  ограничение `duplicate_of`; обратные `blocks`, self-relation и semantic
  duplicate остаются запрещены.
- Detail, relation filters, Activity и sync проецируют edge только когда caller
  по-прежнему читает обе Tasks. Успешная mutation создаёт согласованный Activity
  event для каждой стороны и инвалидирует lazy details обоих peers; перенос
  Task дополнительно инвалидирует details сохранённых `blocks`/`related`, чтобы
  новый Project и identifier стали видны без полного bootstrap.
- Для одного source допускается не более одного `duplicate_of`. Создание или
  перевод в `duplicate_of` атомарно назначает source зарезервированный статус
  `Duplicate`. Изменение/удаление связи не пытается угадать и восстановить
  прежний status.
- Завершённый или отменённый blocker больше не показывается в активной группе
  `Blocked by`, а остаётся видимым как resolved relation в `Related`; повторное
  открытие blocker возвращает активное представление.
- Автоматическое распознавание Task references в description/comments и
  создание `related` не входят в первый native-write slice: связь создаётся
  только явным действием пользователя или Agent command.
- Offline Linear migration и backup/import validators применяют те же границы:
  межпроектные `blocks`/`related` допустимы, `duplicate_of` и hierarchy требуют
  один Project; недоступный или отсутствующий peer не превращается в живой edge.
- Автоматическое закрытие parent по subtasks не входит в MVP.

### 5.5 Comments и импортированная история

- Любой User с доступом к Task читает её native и historical comments. Создание, reply,
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
- Native comment может ссылаться на готовый Attachment той же Task через тот
  же executable Markdown contract, что description: raster image использует
  `![alt](attachment:v1:<public-ref> "caption"){width=480}`, где optional
  `{width=N}` принимает только `160..960` с шагом `8`, а отсутствие suffix
  означает responsive `Auto`; downloadable file —
  `[label](attachment:v1:<public-ref>)`. Inline/fenced code и escaped examples
  остаются literal. Create/edit атомарно проверяет и нормализует bounded index
  ссылок; guessed, cross-Task, deleted/pending и несовместимый image ref
  отклоняются без existence leak. Historical body immutable, но native reply
  на historical root может содержать такие ссылки.
- Browser authoring для root/reply и edit собственного native Comment
  переиспользует Task Attachment gallery/upload: paperclip, picker,
  `Cmd/Ctrl+Shift+A`, drop/paste и multi-file queue вставляют image/file token
  в позицию курсора. Per-file progress, cancel/retry/partial success и stable
  attachment idempotency не позволяют отправить Comment, пока связанный upload
  не готов либо не удалён из draft. Ready refs сохраняются в изолированном
  draft current User + Task + optional root thread; незавершённый upload после
  reload не объявляется ready.
- Browser renderer разрешает metadata только для executable refs в смонтированных
  Comment bodies текущей видимой page. Скрытая часть `Show more`, свёрнутый
  thread и tombstone не инициируют lookup. Raster использует тот же private
  preview с focus trap и `Esc`, что Task Attachment; file — ACL-scoped safe
  download. Missing, deleted, forbidden и guessed refs дают одинаковый локальный
  placeholder без filename или existence leak. Lookup делится на deterministic
  batches максимум по 100 refs с не более чем двумя одновременными запросами.
  Transient failure сохраняет успешные chunks и уже известную metadata, не
  превращает failed refs в authoritative missing и допускает один automatic и
  явный manual retry. Renderer invalidation/retry не сбрасывает
  root/reply/edit draft.
- Импортированный comment становится historical `Comment` той же Task с
  snapshot имени автора и исходных timestamps/quote. Он не получает
  `author_user_id`, не impersonates текущего User и сохраняет source identity.
- Body, source identity, historical author/timestamps/quote и исходная
  parent identity исторического comment неизменяемы. Editor+ может отвечать,
  ставить reaction и resolve/reopen thread; edit/delete historical comment
  запрещены всем ролям. Nested source replies нормализуются к одному root, но
  исходный parent ID сохраняется.
- Завершённый cutover даёт каждому source row явный outcome `migrated` или
  `exception`. Offline migration planner не дублирует Comment; runtime import
  route и provider-specific public contract отсутствуют.
- Локальный draft изолирован ключом current User + Task + optional thread.
  Mentions, отдельный binary upload без Task Attachment, notifications и
  subscriptions не входят в этот срез.

### 5.6 Task Activity

- Каждая успешная перечисленная ниже Task mutation создаёт ровно один versioned
  append-only `ActivityEvent` для каждой затронутой Task в той же D1
  transaction. Event хранит Task, server-verified
  User actor либо historical actor snapshot, timestamp, тип и минимальный
  structured before/after payload.
- Покрываются create/update, status/lifecycle, priority, assignee,
  Project/Release, due date, estimate, labels, hierarchy, relations,
  archive/restore и значимые comment events. Relation mutation сохраняет по
  одному согласованному event на каждом endpoint; `Duplicate` дополнительно
  остаётся атомарным со status source. Project move содержит old/new Project и
  old/new identifier в одной записи moving Task.
- No-op desired state, idempotent retry, stale optimistic version, failed SQL
  guard и rollback не создают ложного event. Project-code backfill не создаёт
  synthetic event на каждую историческую Task и остаётся migration provenance.
- Activity читается отдельной ACL-scoped keyset pagination с maximum 50. Ни
  event bodies, ни raw migration evidence не входят в bootstrap, compact Task
  projection или sync journal. Sync передаёт только `task_activity`
  invalidation ID; открытый consumer перечитывает свою lazy page.
- Event inherits текущий Task ACL. Viewer читает Activity, но не получает новых
  mutation прав; revoke немедленно закрывает endpoint без подтверждения
  существования Task.
- Linear `stateHistory` создаёт historical `status_changed` events с исходными
  timestamp, status names и actor display snapshot без `User` identity.
  Каждая source row получает `migrated`/`exception`; offline повторный прогон не
  дублирует events. Raw evidence остаётся только в reconciliation/backup до
  отдельно разрешённого durable-data cleanup.
- Project backup schema `15` и system backup schema `15` сохраняют events,
  attachment migration outcomes, LabelGroup topology, normalized comment
  attachment refs и reconciliation evidence вместе с recoverable deletion
  tuple. System schema `15` дополнительно сохраняет versioned profile,
  StoredFile ownership и sequence state и не принимает старые system schemas.
  Activity хранится до удаления Task; отдельного retention deletion нет.
  Полный system export использует chunked staging без пользовательского лимита
  общего числа rows или размера state.

### 5.7 Native attachments

- Binary сначала создаётся как uploader-only StoredFile с opaque `fileRef`,
  bounded staged quota и TTL. Bind создаёт один TaskAttachment, повторно
  проверяет Editor+, expiry и current Task/owner/Project quotas; v1 не допускает
  вторую Task binding.
- Agent REST публикует file-first `POST/GET/DELETE /files` и JSON bind через
  `/tasks/{ref}/attachments`; MCP публикует
  `upload_file/get_file/delete_file/attach_file_to_task`. Existing raw-body REST
  upload и `upload_task_attachment` остаются compatibility wrappers upload+bind.
  Hosted MCP payload не принимает raw local path, base64 или arbitrary URL.
  Совместимый Codex client может показывать special `file` parameter как
  user-authorized absolute path: client сначала преобразует его в native OpenAI
  file input по `_meta["openai/fileParams"]`, поэтому Worker получает только
  `file_id`/temporary `download_url`, а не path. При доступном bridge это
  connector-first route; local companion остаётся для runtime/source, которые
  не могут войти через native file parameter.
- Session-authenticated web UI использует эквивалентные `/api/files` и
  `/api/tasks/{id}/attachments` JSON bind routes. Quick composer хранит для
  recovery только `fileRef`, verified metadata, optimistic version и устойчивые
  operation keys; browser draft не хранит local path, `File`, binary или object
  URL.
- Установленный plugin может добавить отдельный local stdio companion с двумя
  tools. `upload_local_file` читает один exact host-authorized absolute path,
  безопасно snapshot-ит только regular file и вызывает тот же Agent REST
  `POST /files`. `attach_local_file_to_task` принимает полученный `fileRef` и
  связывает его с Task через Agent REST `/tasks/{ref}/attachments`; hosted MCP
  для local-file сценария не требуется. Server не получает полный path.
  Native-client OAuth использует DCR/PKCE loopback только при первой фактической
  операции; client metadata, access token и rotating refresh token живут только
  в памяти процесса. Startup/discovery не выполняют network, browser, Keychain
  или `/usr/bin/security` operations, а bundled runtime не зависит от
  случайного system Node.
- TaskAttachment принадлежит ровно одной Task и не расширяет её ACL. Viewer может
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
  только bounded metadata и bearer-protected Agent content URLs. MCP download
  является отдельным explicit read tool и возвращает resource link, а не
  unbounded base64/object bytes.
- Details показывает lazy attachment count/list, XHR upload progress,
  retry/cancel, safe download, recoverable delete/restore и Viewer read-only
  state. Raster list использует отдельный authenticated server thumbnail;
  full-size original загружается только в preview/download.
- Markdown description встраивает готовый raster Attachment той же Task через
  `![alt](attachment:v1:<public-ref> "caption"){width=480}`, а любой готовый Attachment —
  как скачиваемую ссылку `[label](attachment:v1:<public-ref>)`. Оба вида token
  хранят только непрозрачный reference и пользовательский текст, но не R2 key,
  filename, public URL или signed URL. Optional width относится только к
  конкретному embed, принимает `160..960` с шагом `8`, а отсутствие metadata
  сохраняет прежний responsive `Auto`. Editor вставляет image/file из
  picker/drop/paste в текущую позицию курсора, показывает progress/retry/cancel
  и оставляет alt/caption/label редактируемыми как текст.
- При каждом create/update description server проверяет исполняемый Markdown,
  игнорируя inline/fenced code, same-Task ownership и `state=ready`; image token
  дополнительно требует `kind=image`. Тот же repository invariant действует
  для UI, REST Agent API и MCP и повторяется в guarded write. Чужой, угаданный,
  удалённый или незавершённый Attachment отклоняется без раскрытия его
  существования. Attachment нельзя удалить, пока актуальная description или
  live native Comment ссылается на него image token/file link; delete guard
  использует normalized indexes и повторяется в атомарном write predicate.
- Read-only Markdown renderer лениво получает только ACL-scoped metadata,
  показывает responsive image/optional caption и компактную file link, строит
  private preview/download route после авторизации и при недоступности
  использует безопасный placeholder без утечки URL или чужой metadata.
- Composer загружает выбранные files как staged StoredFiles до submit, затем
  создаёт Task и bind-ит готовые `fileRef` с независимыми устойчивыми
  idempotency keys. Partial bind failure оставляет созданную Task и явно
  предлагает retry с per-file outcome. Закрытие composer сохраняет безопасное
  recovery-состояние; явный remove освобождает unbound file recoverably, а TTL
  убирает abandoned staged objects. Уже bound binary управляется только через
  lifecycle TaskAttachment.
- Attachment insert/update/delete создают ID-only `task_attachments`
  invalidation. Открытый lazy consumer перечитывает только metadata; локальный
  progress и обычный workspace snapshot не заменяются.
- Legacy `metadata_json.attachments` переносится отдельной admin-only bounded
  операцией, а не public import route. Inventory не загружает bytes и считает
  каждую source position; apply допускает только HTTPS hosts из явного
  allowlist, повторно проверяет каждый redirect, не пересылает credentials,
  ограничивает streamed body и после native create сверяет D1/R2 size и
  SHA-256. HTML фиксируется как `non_binary_mapped`, duplicate — как
  `skipped`, unavailable/malformed — как `blocked`; source URL не входит в
  report/error. Cutover допустим только при полном непрерывном inventory без
  pending/blocked rows и после backup/read-back.

## 6. Workflow

- Система поставляется со статусами `Backlog`, `Todo`, `In Progress`, `Done`,
  `Canceled` и зарезервированным `Duplicate` категории `canceled`.
- Пользователь может переименовать, перекрасить, добавить и упорядочить
  workflow statuses.
- Каждый статус принадлежит одной неизменяемой категории: `backlog`,
  `unstarted`, `started`, `completed`, `canceled`.
- В каждой категории должен оставаться хотя бы один разрешённый статус, если
  категория используется системными действиями.
- Один статус категории `backlog` или `unstarted` является default для новых
  задач.
- Используемый статус архивируется только вместе с явной миграцией Tasks и
  SavedViews на активный replacement той же категории; поэтому lifecycle
  timestamps задач не меняют смысл. Архивный статус остаётся видимым на старой
  задаче, но недоступен в create, bulk, drag-and-drop и Agent mutations.
- `Duplicate` существует ровно в одном экземпляре на каталог, не является
  default и не допускает rename или archive: его стабильная системная роль
  используется native duplicate relations.
- Workflow statuses принадлежат User. Shared Project использует каталог своего
  owner; collaborator может применять существующие statuses, но не получает
  доступ к account-wide настройке каталога только из project grant.

## 7. Проекты

- Для Project обязательны `name` и уникальный для active Projects текущего
  owner code длиной 1–12 символов. Code состоит из заглавных латинских букв,
  цифр и внутренних дефисов; первый и последний символы — буква или цифра.
  Текстовый ingress обрезает внешние пробелы и приводит code к верхнему
  регистру до проверки, а сохранённая и backup-проекция всегда канонические.
- Новый Project принадлежит создавшему его User.
- Проект поддерживает summary, Markdown description, status, lead, start date,
  target date, icon/color и timestamps.
- Create/edit выполняются versioned repository command. `Viewer` получает
  отказ, `Editor` и выше изменяют content/lifecycle; optimistic conflict или
  revoke между read и write не оставляют partial update.
- `task_code` разрешено исправить только до первого выделенного Task number.
  После `code_locked_at` UI делает control read-only, а server отклоняет обход.
- Create dialog предлагает допустимый code из имени Project, но сохраняет
  пользовательский выбор только после той же server-side проверки. Agent API,
  OpenAPI и MCP возвращают полный канонический code без сокращения.
- Lifecycle использует `planned`, `active`, `paused`, `completed`, `canceled`.
  Переход в terminal status при открытых Tasks требует явного подтверждения;
  Tasks автоматически не закрываются.
- Archive является обратимым: archived Project остаётся ACL-scoped record для
  Project index/direct URL и restore, но исключается из sidebar и create
  pickers. Delete отдельно помещает Project и shadow subtree в `Recently
  deleted`; restore не снимает собственный deletion state его children, а
  owner-only purge требует preview counts и отдельное подтверждение cascade.
- Каждая Task принадлежит ровно одному Project. Code и allocator Project
  блокируются после первой Task; перенос выдаёт следующий identifier целевого
  Project и сохраняет прежний identifier как alias.
- Экран проекта содержит overview, прогресс и views его задач.
- Базовый прогресс — доля неархивных задач проекта в категории `completed`;
  canceled-задачи не входят в знаменатель. Взвешивание по estimate отложено.
- Завершение проекта не завершает открытые задачи автоматически; интерфейс
  должен показать предупреждение и их количество.
- Lead обязан иметь доступ к Project. Task, созданная collaborator внутри
  Project, остаётся в owner scope Project. Revoke текущего lead атомарно
  очищает `lead_user_id` и повышает Project version.

### 7.1 Project backup и restore

- Только current Owner может экспортировать и восстановить Project. Project
  roles и application-admin capability сами по себе этого доступа не дают.
- Export скачивает один versioned logical JSON bundle с Project, его Tasks,
  Releases, project-scoped SavedViews, labels, внутренней hierarchy/relations,
  native/historical comments, reactions, reconciliation outcomes, provenance и dependency snapshot используемых
  каталогов.
- Bundle не содержит Users, identities, API credentials, глобальные views,
  чужие Projects или hosted configuration. Он привязан к исходным immutable
  IDs, current owner и тому же Site.
- Первая версия выполняет exact restore исходного Project: merge, copy-as-new и
  cross-Site remapping отсутствуют. Перед mutation сервер полностью проверяет
  checksum, ссылки, catalogs, collisions и domain invariants и сохраняет
  normalized rows в staging.
- Preview показывает create/update/delete, conflicts, внешние relation
  references и sharing. Для существующего Project apply требует свежий backup
  текущего состояния, точное имя Project и отдельное подтверждение того, что
  внешние edges из provenance не восстанавливаются. Sharing восстанавливается
  только после отдельного opt-in.
- Replace Project subtree выполняется одной D1 transaction. Ошибка оставляет
  live state без изменений. Descriptor внешней relation содержит только
  provenance самого edge и внутренней стороны, но не peer Task; apply не
  импортирует и не создаёт такой edge. Уже существующий live `blocks`/`related`
  через границу Project сохраняется при exact replacement, только если его
  внутренняя Task входит в incoming set, обе endpoint Tasks существуют
  (включая recoverably deleted) и type допустим; иначе stage/apply fail-closed
  до mutation. Так restore не создаёт dangling
  references и не импортирует чужой Project неявно.
- Schema `3` включает Attachment metadata и originals в bounded
  content-addressed JSON container; live R2 keys и thumbnails не входят.
  System limit — 10 MB, Project — 25 MB. Schema `2` без Attachments остаётся
  импортируемой.
- Schema `5` включает writable-relation identity/idempotency/version metadata;
  schema `6` добавляет Project task code/sequence и aliases прежних Task
  identifiers. Legacy schema `2`–`5` импортируются детерминированно, но Task без
  Project требует явного mapping.
- Schema `14` сохраняет deletion tuple Project, Releases, Tasks и scoped
  SavedViews. Отдельно удалённый child остаётся deleted после exact Project
  restore; schema `2`–`13` после проверки исходного checksum получает для всех
  четырёх типов `null` deletion tuple. Schema `13` включает
  `comment_attachment_refs`; schema `2`–`12` после
  проверки исходного checksum получает пустой index без попытки синтезировать
  historical edges из legacy comment bodies.
- Schema `15` добавляет checksum-protected `externalTaskRelations`: для каждого
  намеренно не включённого `blocks`/`related` edge сохраняются immutable
  relation metadata, внутренняя Task и сторона boundary с фиксированной
  политикой `not_restored`. Peer Task и content в bundle не входят. Legacy
  schemas `2`–`14` нормализуются с пустым provenance set и не заявляют внешние
  edges восстановленными.
- Restore materializes новые environment-scoped R2 keys до атомарного D1
  cutover, удаляет старые objects только после success и компенсирует новые при
  failure. Cross-Site Project restore по-прежнему запрещён.

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
- Первый переход в `released` при открытых Tasks показывает их count и требует
  отдельный confirm flag. Редактирование metadata уже выпущенного Release
  сохраняет исходный `released_at`; переход обратно в `planned`/`active` либо
  в `canceled` очищает timestamp, не меняя Tasks.
- Состав выпущенного release остаётся редактируемым только через явно
  подтверждённую операцию `confirmReleasedComposition`; правило действует при
  добавлении, удалении и переносе Task как в browser UI, так и в Agent API/MCP.
  Оно продолжает действовать для сохранённой membership recoverably deleted
  Release, хотя ordinary Task projection её скрывает. Rank reorder внутри той
  же видимой группы `No release` не очищает скрытый ref и подтверждения не
  требует. Изменения должны быть заметны пользователю; полный audit log отложен.
- Прогресс release считается по той же формуле, что и прогресс project, но
  только для задач release.
- Delete Release не удаляет и не архивирует Tasks. До restore их сохранённая
  membership не участвует в рабочих views/pickers; restore возвращает её без
  ручного переназначения, а owner-only permanent purge очищает `release_id` у
  Tasks до удаления Release row.
- До recoverable delete Release UI получает authoritative status и count всех
  stored Task memberships, включая archived и deleted Tasks. Delete Release со
  status `released` требует отдельный `confirmReleasedComposition=true`; preview
  version и DELETE CAS исключают подтверждение устаревшего состава.

## 9. Views и фильтры

### 9.1 Модель

- View не хранит снимок задач; при открытии он выполняет сохранённый запрос к
  текущим данным.
- Встроенные views: `All tasks`, `Active`, `Backlog`, `My tasks` и `Archived`.
- Пользователь может сохранить текущий эффективный результат под новым именем
  (`Save as`), открыть `Edit view` и атомарно заменить имя/base query/display
  исходного Saved View (`Save changes`) и отменить draft (`Cancel`). Новый
  пользовательский archive для Saved View не создаётся; legacy archived View
  исчезает из sidebar и direct route, но остаётся в `All views` только для
  совместимого restore.
- Delete SavedView отдельно переносит её в `Recently deleted` и не меняет ни
  одну Task. Restore возвращает ту же identity, base query, Display и scope;
  permanent purge удаляет только View и её direct grants. Ссылки filter AST на
  deleted, purged или недоступную сущность остаются unresolved/inert и дают
  пустое условие, а не молча удаляются и не расширяют результат. После
  доступного restore тот же immutable ref снова разрешается.
- Update существующего SavedView может сохранить или удалить уже stored missing
  Release ref только при неизменном scope, поэтому rename остаётся возможным.
  Новый missing ref и scope move с таким ref отклоняются; permanent Release
  purge никогда не удаляет и не переписывает predicate в SavedView AST.
- View может иметь global scope либо явный scope одного Project.
- Project-scoped View имеет обязательный `scope_project_id`, жёстко ограничен
  этим Project и наследует его role. Он не получает отдельный `AccessGrant`.
- View без `scope_project_id` является global, может пересекать все доступные
  Projects и их Tasks и может получить прямой `Editor`/`Viewer` grant.
  Обычный filter по `project_id` внутри global View не меняет его access scope.
- Исполнение view всегда пересекает filter с authorization scope читателя;
  shared view не раскрывает недоступные records и их aggregate counts.

### 9.2 Фильтрация

Фильтры покрывают status/category, priority, assignee, project, release,
labels, estimate, due date, parent/subtask, relation type/direction/presence,
created/updated/started/completed/canceled dates и archived state.

- Для категориальных полей доступны `is`, `is_not`, `in`, `not_in`, `is_empty`.
- Для дат и чисел доступны равенство и сравнения; даты также поддерживают
  относительные интервалы `overdue`, `next_7_days` и bounded `recent` для
  `updated_at`. Calendar dates вычисляются в timezone текущего User.
- Первый UI может соединять условия только через `AND`; формат хранения не
  должен препятствовать последующему добавлению `OR` и вложенных групп.
- Saved View хранит постоянный base query, а открытая View отдельно применяет
  временный URL/session query. Filter UI показывает оба слоя как `Saved in
  <View name>` и `Temporary filters`; Viewer читает base formula, а Editor+
  открывает её в `Edit view`.
- `Edit view` инициализирует query draft только из сохранённого base query.
  `Save changes` не сериализует временные условия; `Cancel` не меняет ни base,
  ни temporary layer. `Clear temporary` очищает только URL/session query.
- `Save as` создаёт новую identity из эффективного `base AND temporary` query и
  текущего Display, не меняя source View или его version. Совпадение field не
  заменяет base condition автоматически: каждое условие остаётся самостоятельным.
- UI, Saved View и Agent translation используют один validated server filter
  executor. Он сначала строит ACL-scoped Task set, затем применяет AST и
  возвращает только compact summary projection. List, board, counts и groups
  используют один authoritative набор Task IDs; description и другие bodies
  не входят в результат. Reference values проверяются в том же ACL scope и не
  раскрывают существование недоступной записи.
- `POST /api/tasks/query` ограничивает page до 2000 записей, применяет
  выбранный Display order ко всему ACL-scoped result до pagination и продолжает
  выдачу keyset cursor по `(sort value, manual rank, public_id)`; UI загружает
  следующие страницы явно, не выполняя unbounded full-workspace fetch.
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
- Если отдельный Saved View order не задан, list и board используют priority
  order `urgent → high → medium → low → none`; равный priority разрешается по
  manual rank, затем по immutable `public_id`. Явный Saved View order остаётся
  authoritative.
- Пользователь выбирает видимые metadata fields и показ пустых групп для
  группировок по `priority`, `assignee`, `project` и `release`. При группировке
  по `status` группы с нулевым числом задач не показываются независимо от
  сохранённой display-настройки; если результат целиком пуст, list и board
  показывают общий empty state без пустых контейнеров.
- Sub-grouping/swimlanes и независимые настройки одного view для разных
  пользователей отложены.
- `Save changes` внутри `Edit view` использует текущую optimistic `version` и
  сохраняет base query + весь Display одним repository command; конфликт второй
  сессии не даёт partial write, клиент перечитывает последнюю View и оставляет
  редактор открытым для повторной проверки. `Save as` создаёт новую identity и
  не меняет source View.

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

- Поиск находит canonical и прежний alias task identifier, а также совпадения
  в title и description. Несколько доступных exact alias matches возвращают
  ambiguity, а не произвольную Task.
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
  Label desired-state/atomic replace, versioned hierarchy и relation CRUD,
  bounded read-only Task Activity, unified native/historical comment threads и
  native Attachment metadata/binary.
- List response не содержит task description, release notes, historical или
  native comment bodies и attachment metadata/bodies. Activity, unified
  comments и native attachments читаются отдельными ACL-scoped запросами;
  provider provenance не входит в Agent API.
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
- Onboarding connector разделяет добавление marketplace, установку plugin,
  OAuth connection, возврат в `Installed` и fresh-task read smoke. На mobile
  установка сразу передаётся в Desktop/CLI. Redirect в web ChatGPT без
  установленного plugin получает bounded diagnostic path, а не повторные
  install attempts; onboarding не считается исправлением platform install-багa.

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
  workspace snapshot. Изменение label назначения передаёт authoritative
  task-scoped label context только для затронутой Task: доступные определения и
  полный набор её назначений заменяют локальное состояние этой Task, не
  выгружая весь catalog. Relations, comments и Activity передают только
  task-scoped invalidation IDs без своих records; их endpoint
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
21. В отдельном блоке `/admin` экспортировать полный потоковый `.tmbak`,
    убедиться в отсутствии Export/Import в общей полосе действий, импортировать
    его через preview и explicit `RESTORE`, затем подтвердить точное восстановление Users,
    identities, owner/ACL, catalogs, content, archived records и provenance.
    Повреждённый, несовместимый или invariant-invalid файл не меняет ни одной
    live row; обычный User не может вызвать export/import API.
22. Через agent API получить active/planned releases и compact задачи
    выбранного release: ответы содержат identifiers, titles, statuses и
    небольшие metadata, но не descriptions, comment bodies или release notes.
23. По canonical task reference загрузить одну Task с description и связями;
    comment bodies появляются только через unified comment
    endpoint. Недоступная Task возвращает тот же `not found`, что неизвестная.
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
28. Открыть account menu обычным User и увидеть identity, `Workspace` и
    `Settings`, а администратором — дополнительный `Administration`; проверить
    canonical anchors, modifier-click, Back/Forward, keyboard focus и `Esc` в
    desktop, collapsed sidebar, `390×844` и `844×390`. Убедиться, что прямых
    `My tasks`, `Codex setup`, `Workflow statuses`, `Labels`, `Label groups`,
    `Project backup` и inline `Appearance` в меню нет, а sign out остаётся
    отдельным action.
    Затем открыть `Settings → Codex setup`, сразу увидеть Desktop/CLI handoff
    без horizontal overflow и пройти отдельно
    marketplace, plugin installation, OAuth, возврат в `Installed` и новый
    task/chat. В Desktop проверить `Personal`, тот же ChatGPT account/workspace
    и success state каждого этапа; в CLI скопировать актуальные команды и
    пройти `/plugins → Task Manager → Authenticate`, затем `/new`. Первым
    выполнить read-only `Show my tasks in Task Manager.` без bulk migration или
    write. Из clean external-user profile воспроизвести redirect failure и
    убедиться, что bounded troubleshooting предлагает один restart, CLI
    fallback и безопасный diagnostic prompt без credentials, не выдавая
    platform install-баг за исправленный.
29. В Task Activity создать comment, повторить request с тем же idempotency key,
    ответить одним уровнем, поставить reaction, resolve/reopen, отредактировать
    с актуальной version и получить conflict со stale version. Viewer видит
    thread, но все mutations получают отказ. Импортированная история находится
    в той же Activity с historical badge: её source facts и body нельзя
    редактировать/удалить, но Editor+ отвечает, реагирует и resolve/reopen.
    Malformed/ambiguous source row остаётся в offline reconciliation report без
    публикации raw body в Task UI/API. Те же операции доступны через Agent REST/MCP без
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
33. Project и system backup с PDF, attached image и embedded image проходит
    полную validation/staging и exact restore byte-for-byte. Corrupted/missing
    object или D1 cutover failure не меняет live originals; system schemas
    `2`–`14` отклоняются без изменения live state.
34. Read-only reconciliation находит missing/orphan live или backup-staging
    object, size/checksum mismatch, stale lifecycle, broken description ref и
    расхождение live native Comment body/index без публикации body/filename.
    Truncated scan не публикует неточный orphan count. Admin overview содержит
    только metadata/object counts, bytes, staging/orphan/states; per-Task,
    current-owner и Project quotas
    отклоняют upload без раскрытия чужого usage.
35. В Task details найти вторую Project Task, создать `blocks`, `related` и
    `duplicate_of`, изменить direction/type и удалить relation. Проверить
    группировку `Blocked by`/`Blocking`/`Related`/`Duplicate of`, перенос
    terminal blocker в `Related`, атомарный статус `Duplicate`, Viewer без
    mutation controls, межпроектные `blocks`/`related` при Editor+ на обеих
    Tasks и отказ без existence leak, stale relation/task version и lazy sync
    invalidation обеих Tasks. Проверить, что межпроектный `duplicate_of`
    отклоняется, а move сохраняет допустимые edges. Повторить
    create/update/delete через Agent REST и MCP canonical refs; retry create с
    тем же idempotency key не создаёт вторую row.
36. Owner создаёт, переименовывает, архивирует и восстанавливает Label; active
    имя уникально в owner catalog без учёта регистра и stale catalog version
    отклоняется. Editor назначает несколько labels через composer/details и
    атомарный bulk add/remove, Viewer видит те же chips без mutation controls.
    Archived Label остаётся на прежних Tasks, снимается, но не назначается
    заново. List, board, Peek и details согласуются через bounded task-scoped
    sync. Те же desired-state add/remove повторяются через Agent REST и MCP по
    canonical refs без дублей; project/system backup schema `7` восстанавливает
    catalog и `task_labels`, а legacy schema `2`–`6` получает совместимые
    defaults.
37. Editor создаёт subtask, меняет/очищает parent и после reload видит
    согласованный edge с обеих сторон. Create наследует Project и получает
    следующий identifier; self-parent, cycle, cross-Project target, Viewer и
    stale version отклоняются без partial write. List, board, Peek и details
    показывают hierarchy context; Agent REST и MCP используют те же canonical
    refs и versioned commands, а sync инвалидирует child и old/new parent.
38. Создать Project со всеми metadata, изменить name/summary/Markdown,
    status/lead/dates/icon/color и до первой Task исправить code. После первой
    Task code остаётся locked; Viewer, stale version, invalid/revoked lead и
    terminal transition без подтверждения отклоняются. Archive приходит через
    sync как ACL-scoped upsert, исчезает из create pickers и восстанавливается
    из Project index/direct URL. Agent Project detail возвращает актуальные
    lifecycle metadata и version, но Project mutations остаются read-only.
39. Editor отдельно удаляет и восстанавливает Task, Project, Release и
    SavedView через `Recently deleted`: ordinary surfaces получают sync remove,
    immutable identity/content сохраняются, Project shadow скрывает весь
    subtree, но restore не оживляет отдельно deleted child; Release restore
    возвращает прежнюю membership, а SavedView не меняет Tasks. После cutoff
    restore запрещён. Только current Owner проходит отдельное permanent-delete
    confirmation; Task/Project purge удаляет R2 originals до финальной metadata
    cleanup и безопасно повторяется после сбоя. System и Project backup schema
    `14` сохраняют deletion tuple, а legacy `2`–`13` получает пустые поля только
    после checksum validation.

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
19. Native Task relations: application UI/API, versioned Agent REST/MCP,
    idempotency, ACL обеих сторон, межпроектные `blocks`/`related`,
    same-Project Duplicate transition, lazy sync и backup/import compatibility.
20. Append-only Task Activity: атомарные native events, Linear status-history
    migration, lazy UI/Agent/MCP reads, ACL/revoke и backup/restore schema `10`.
21. Legacy attachment reconciliation: resumable admin inventory/apply,
    allowlisted bounded download, native D1/R2 verification, explicit
    non-binary/skipped/blocked outcomes и backup/restore schema `12`.
22. Versioned Profile/Settings, User-scoped appearance/sidebar preferences и
    system backup/restore schema `12`.
23. Native Comment attachment refs: normalized bounded index, атомарные
    create/edit/delete, ACL-safe Agent/MCP projection, race-safe Attachment
    delete guard, reconciliation и backup/restore schema `13`.
24. Browser authoring Comment attachments: root/reply/edit composer,
    picker/gallery/shortcut/drop/paste, multi-file progress/cancel/retry,
    draft isolation и responsive accessibility; browser renderer входит в
    следующий UI-срез.
25. Единый recoverable deletion contract для Tasks, Projects, Releases и
    SavedViews: `Recently deleted`, 30-day cutoff, project shadow, lossless
    Release membership, owner-only R2-first purge и backup schema `14`.
