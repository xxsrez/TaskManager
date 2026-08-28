# Спецификация интерфейса

Статус: `Proposed`

Последнее обновление: 2026-08-19

## 1. Назначение

Документ превращает принятое в
[ADR-0002](../decisions/0002-linear-interface-parity.md) направление
«максимально близко к Linear» в проверяемый UI/UX-контракт. Он описывает только
поверхности и действия из [MVP](mvp.md); сходство с Linear не расширяет
продуктовый scope автоматически.

Точный визуальный baseline уточняется на первом UI-срезе по актуальной версии
Linear. До появления приложения все размеры и tokens ниже являются исходной
спецификацией, а не подтверждёнными runtime-характеристиками.

## 2. Определение паритета

Для каждого переносимого элемента паритет проверяется по шести измерениям:

1. **Назначение** — control решает ту же пользовательскую задачу.
2. **Композиция** — control находится в ожидаемой панели, строке или details
   surface рядом с теми же по смыслу действиями.
3. **Поведение** — click, hover, focus, keyboard, drag и dismiss соответствуют
   ментальной модели Linear.
4. **Состояния** — default, hover, active, selected, disabled, loading, error и
   conflict визуально различимы и не меняют layout неожиданно.
5. **Визуальный язык** — плотность, typography, icons, surfaces, borders,
   radii, color hierarchy и motion выглядят как единая Linear-like система.
6. **Доступность** — control сохраняет semantics, focus и contrast; сходство не
   оправдывает недоступный UI.

Функциональный паритет обязателен. Стилистическое сходство оценивается по
целостности экрана, а не по копированию отдельного цвета или иконки.

## 3. Общая структура приложения

Desktop-first shell повторяет композицию Linear:

```text
┌────────────── left sidebar ──────────────┬──────── main surface ────────┐
│ product/user switcher   search   create  │ breadcrumb / title / actions │
│ My tasks                                 ├──────────────────────────────│
│ Shared with me                           │ tabs / filters / display     │
│ Views                                    ├──────────────────────────────│
│ Projects                                 │ list | board | details       │
│ Releases                                 │                              │
│                                          │                              │
│ profile / settings / admin menu          │                              │
└──────────────────────────────────────────┴──────────────────────────────┘
```

### 3.1 Left sidebar

- Ширина desktop по умолчанию — `240px`, compact state — `48px`.
- Верхний ряд содержит product mark, search и primary create button. Пока в
  продукте существует один workspace, product mark/name является обычной
  ссылкой на workspace root без chevron или другого ложного menu affordance;
  dropdown появляется только вместе с реально реализованным workspace menu.
- Основная навигация начинается с `Workspace`, затем следуют `My tasks`,
  `Shared with me`, `Views`, `Projects`, `Releases`. `Workspace` ведёт на тот
  же canonical `/workspace`, что product mark/name, и имеет собственный active
  state. Исключённые функции Linear не показываются даже disabled.
- `Views`, `Projects` и `Releases` всегда начинаются с канонической collection
  link (`All views`, `All projects`, `All releases`), после которой показывают
  не более трёх доступных неархивных записей. Общий порядок recent —
  `updatedAt DESC, id DESC`; открытый direct-route record ставится первым, не
  увеличивая лимит. Встроенные task views остаются постоянными shortcuts и в
  лимит Saved Views не входят.
- Sections можно сворачивать; chevron и overflow появляются на hover, если
  действие относится ко всей section.
- Активный пункт использует мягкую заливку и более яркий text/icon без тяжёлой
  цветной плашки.
- Sidebar полностью сворачивается; состояние сохраняется для пользователя.
- Profile/settings находятся в нижней части или user menu и не смешиваются с
  project navigation.
- `Administration` не занимает место в основной навигации. Application
  administrator открывает его только из account menu в нижней части sidebar.

### 3.2 Верхняя панель surface

- Первая строка: breadcrumb/context, title, optional favorite, share, overflow
  и details/sidebar toggle.
- Между title context и actions расположен компактный owner workspace selector:
  `Your work`, доступные владельцы по display name и `All accessible`. Его
  option value — opaque token; email, internal User ID и другие identity hints
  не выводятся в DOM или URL. Busy state блокирует повторное переключение до
  authoritative scoped bootstrap.
- На прямой Project/Release/Task/SavedView route рядом показывается компактный
  resource-owner context. Для project child это current Project owner, а не
  исторический child owner. Контекст не заменяет breadcrumb и не определяет
  доступность actions: controls выводятся только из `accessRole`.
- Вторая строка или продолжение первой: tabs, `Filter`, layout switch,
  `Display`, save/update view и primary contextual create action.
- Порядок и группировка не меняются произвольно между list и board.
- Иконка без текста допустима только для общеизвестного действия и всегда имеет
  tooltip с названием и shortcut.
- Toolbar остаётся sticky, а содержимое surface прокручивается отдельно.

### 3.3 Navigation behavior

- Breadcrumb и back/forward сохраняют browser history и deep links.
- Breadcrumb строится из реальной route hierarchy. `Workspace`, collection и
  entity ancestors являются настоящими anchors с canonical URLs; последний
  сегмент обозначает текущую surface и не является ссылкой. Минимальные цепочки:
  `Workspace → Views → SavedView`, `Workspace → Projects → Project` и
  `Workspace → Projects → Project → Releases → Release`.
- Workspace overview имеет canonical URL `/workspace`; туда ведут product
  mark/name в sidebar и первый сегмент breadcrumb. `/` перенаправляется на
  `/workspace`, а `My tasks` остаётся отдельной task surface `/issues`.
- Открытие task/project из списка не теряет filter, scroll и selection context.
- Публичный URL использует отдельный стабильный UUID `public-id`. Внутренний
  primary key, Linear source ID и import provenance в URL не попадают. Entity
  identity и layout кодируются path segments, а не query parameters:

  | Surface | Прямой URL |
  |---|---|
  | Workspace overview | `/workspace` |
  | My tasks / board | `/issues`, `/issues/board` |
  | Built-in issue view | `/issues/{all|active|backlog|archived}` |
  | Views / Saved view | `/views`, `/views/{view-public-id}` |
  | Явный layout view | `/views/{view-public-id}/{list|board}` |
  | Projects / Project | `/projects`, `/projects/{project-id}` |
  | Project board | `/projects/{project-id}/board` |
  | Releases / Project releases | `/releases`, `/projects/{project-id}/releases` |
  | Release / board | `/projects/{project-id}/releases/{release-id}`, `…/board` |
  | Issue details | `/issues/{issue-public-id}` |
  | Shared with me | `/shared` |
  | Recently deleted | `/settings/recently-deleted` |
  | Administration | `/admin` |

- URL saved view без layout открывает сохранённый `display.layout`; суффикс
  `/list` или `/board` переопределяет layout только для текущего открытия и не
  меняет определение view.
- Переключение list/board меняет path через browser history. Back/forward
  восстанавливают entity, layout и открытую Task без повторного входа через
  sidebar.
- Owner workspace scope хранится отдельно в user-scoped browser storage и
  `history.state`: переключение не добавляет query/path segment и не меняет
  canonical public-ID URL. Back/Forward и reload восстанавливают выбор, а
  открытие доступного deep link показывает owner context самого resource. Если
  token больше не входит в server-projected options после revoke/transfer,
  client одной заменой snapshot/history/storage возвращается в `Your work`.
- Навигационные items и ссылки на records остаются настоящими anchors: их
  можно копировать, открыть в новой вкладке или активировать modifier-click.
- Collection surfaces `/views`, `/projects` и `/releases` не ограничены
  sidebar shortlist: они выполняют ACL-scoped search и догружают следующие
  deterministic keyset pages через явный `Load more`.
- Sidebar shortlist является отдельной navigation projection и не служит
  источником вариантов для Task composer, filters, Project/Release move,
  bulk actions, Saved View scope или Release create. Перед открытием такого
  picker UI лениво дочитывает все ACL-scoped keyset pages нужного каталога;
  во время загрузки преждевременно неполный control не становится активным.
  Это же правило действует для mobile `View controls` и открытия mobile search:
  панель появляется после полной Project/Release hydration, а ошибка оставляет
  trigger доступным для повторной попытки.
- Copy-link action копирует текущий абсолютный deep link.
- Legacy links `/tasks/{internal-id}`, `/releases/{internal-id}` и прежние
  `/views/{internal-id}`/`/projects/{internal-id}` разрешаются только после ACL
  lookup и перенаправляются на канонический URL с `public-id`; новые links с
  внутренними или Linear IDs не создаются.
- Синтаксически неверный URL, неизвестный либо недоступный ID возвращает
  одинаковый fail-closed `not found`, не раскрывая существование чужого record.
- `Esc` закрывает верхний dismissible layer: menu, popover, Peek, modal — ровно
  один слой за нажатие.
- Focus возвращается в control, открывший закрытый layer.

### 3.4 Фоновая синхронизация

- Application shell содержит один невидимый sync coordinator; отдельные list,
  board, details, navigation и filter surfaces не показывают собственные
  polling indicators и не расходятся по моменту обновления.
- Remote create/update/archive/delete обновляет запись на месте без full-page
  reload, потери текущего layout, scroll или несвязанной selection.
- Изменение label назначения пересылает authoritative task-scoped label context
  только затронутой Task и сразу согласует chips в list, board, Peek и details;
  полный owner catalog ради этого не загружается. Lazy relations, native
  comments и migration metadata не пересылаются в background patch.
  Invalidation активной чистой details/Peek/activity поверхности запускает
  точечный refetch; закрытая поверхность только сохраняет stale marker до
  открытия. Dirty description или estimate draft не затирается и остаётся в
  manual conflict flow.
- Если открытая Task или текущая Project/Release/SavedView удалена либо стала
  недоступна, details/Peek закрываются, stale selection очищается, а navigation
  атомарно возвращается в доступный `Workspace` вместо пустого чужого context.
- Hidden/offline состояние не показывает ошибку само по себе. После возврата
  coordinator немедленно сверяется; временные failures используют backoff и не
  создают дублирующиеся banners или requests. Зависший request прерывается через
  45 секунд и проходит тот же retry flow.
- Full reset после ACL change или cursor gap сохраняет загруженный Task body и
  более новые подтверждённые локальные mutations, но удаляет недоступные
  records из всех UI contexts.
- Sync и reset передают текущий opaque owner scope на сервер. Scope membership
  перепроверяется до incremental projection; forged/stale token требует reset,
  а bootstrap возвращает безопасный fallback и новый согласованный selector
  state без промежуточного показа records прежнего scope.

### 3.5 Workspace overview

- Overview — самостоятельная landing surface, а не переименованный task list.
  Он использует спокойную Linear-like hierarchy: compact metrics, Recent tasks
  и отдельные sections Projects, Releases, Saved views и Shared with me.
- Все links остаются настоящими anchors и ведут в существующие canonical
  surfaces. Current breadcrumb segment статичен, а product mark и ancestor
  `Workspace` ведут обратно на `/workspace`.
- Summary rows содержат только название/identifier, status, counts, progress и
  project qualification. Description, labels, relations, comment bodies и
  unified comment threads остаются lazy и не загружаются
  ради overview.
- Shared counts учитывают только top-level shared Projects и global SavedViews,
  не дублируя унаследованные project children.
- `/shared` показывает две root-коллекции: Projects с явным Project grant и
  напрямую расшаренные global SavedViews. Tasks, Releases и project-scoped
  SavedViews доступны через свой Project, но не появляются отдельными shared
  cards. Открытие этой специальной collection переключает selector на `All
  accessible` и server-side дочитывает полные Project/View catalogs, чтобы
  default `Your work` не скрывал саму поверхность shared roots.
- На mobile metrics и sections складываются в одну колонку, строки переносят
  текст, а overview не создаёт horizontal overflow. Empty sections и общий
  empty state имеют явные headings и доступные create/navigation actions.
- На viewport `390×844` selector ограничен шириной header и скрывает
  второстепенную подпись/icon; на `844×390` остаётся touch-height `40px` и
  занимает не больше `34vw`. Header/main surface используют `min-width: 0` и
  clipping, поэтому selector не создаёт горизонтальную прокрутку.

## 4. Visual system

### 4.1 Плотность и геометрия

Начальные tokens:

| Token | Значение | Назначение |
|---|---:|---|
| `space-unit` | `4px` | Базовая сетка |
| `sidebar-width` | `240px` | Раскрытый sidebar |
| `topbar-height` | `40px` | Основной toolbar row |
| `control-height-sm` | `28px` | Icon buttons, chips, compact inputs |
| `control-height-md` | `32px` | Buttons и form controls |
| `task-row-height` | `36px` minimum | Однострочная list row |
| `board-column-width` | `280px` | Допустимый диапазон `256–320px` |
| `radius-sm` | `6px` | Buttons, inputs, chips |
| `radius-md` | `8px` | Cards, popovers, dialogs |
| `icon-sm` | `14px` | Inline metadata |
| `icon-md` | `16px` | Navigation и actions |

Отступы компактны, но click target интерактивного control не меньше `28px` на
desktop и `40px` в touch layout.

### 4.2 Typography

- Основной font stack: `Inter`, `ui-sans-serif`, system sans-serif.
- Базовый текст — `13px/20px`; secondary metadata — `12px/16px`.
- Surface title — `18–20px`, task/project title в details — `22–24px`.
- Веса преимущественно `400–550`; bold используется редко.
- Task identifiers и shortcuts допускают tabular/monospace treatment, но не
  должны выглядеть как code blocks.
- Контраст строится тремя уровнями: primary text, secondary metadata, muted
  placeholder/disabled.

### 4.3 Цвет и surfaces

- Обязательны `system`, `light` и `dark` theme; default — `system`.
- Палитра нейтральная, с холодным серым оттенком и сдержанным
  violet/blue accent, близким к Linear по характеру, но заданным собственными
  semantic tokens.
- Surface hierarchy: app background, sidebar, content, raised card/popover,
  selected/hover overlay.
- Разделители — тонкие `1px` low-contrast borders. Тяжёлые тени не
  используются; elevation передаётся сочетанием border и небольшого shadow.
- Status, priority, labels и destructive actions имеют semantic color, но
  значение никогда не кодируется только цветом.
- Theme должна проходить contrast review отдельно; простая инверсия палитры не
  считается готовой light theme.

### 4.4 Icons и motion

- Один набор line icons с близкой к Linear геометрией, толщиной и optical size.
- Status использует круг/кольцо с различимой формой; priority — компактный
  bar/indicator; entity types имеют стабильные icons во всех surfaces.
- Собственные product/logo assets не копируют Linear.
- Hover/focus/press transitions — `100–160ms`; modal/popover — `140–200ms`.
- Dragged item слегка поднимается и отделяется shadow; destination подсвечен,
  но layout не прыгает.
- `prefers-reduced-motion` отключает необязательные transitions.

## 5. Общие controls

### 5.1 Buttons

- Primary button используется для единственного главного действия surface.
- Secondary и ghost buttons визуально спокойны; icon buttons квадратные.
- Destructive действие не становится primary только из-за места в dialog.
- Loading сохраняет ширину button; repeated submit блокируется.

### 5.2 Property control

Один и тот же property control используется в composer, details и inline edit:

- trigger показывает icon, текущий value и clear affordance, когда поле
  optional;
- popover содержит search input при длинном списке, keyboard navigation,
  selected mark и empty state;
- `Enter` выбирает, `Esc` закрывает, `Backspace` очищает пустой searchable
  control;
- недоступный по ACL value не показывается в picker;
- server rejection возвращает подтверждённое значение и объясняет причину.

Это применяется к status, priority, assignee, project, release, labels,
estimate, due date и relations.

### 5.3 Menus, popovers и dialogs

- Overflow `…` и right-click открывают один и тот же action model.
- Меню группирует actions по смыслу, показывает shortcuts справа и отделяет
  destructive section.
- Popover привязан к trigger и не блокирует остальной экран; dialog применяется
  для создания, sharing, подтверждений и многошаговых действий.
- Меню закрывается при выборе, outside click или `Esc`; form dialog не теряет
  dirty data без подтверждения.

### 5.4 Toasts и inline feedback

- Успех обычно подтверждается изменением объекта; toast нужен для результата,
  который иначе не виден, и для Undo, если оно поддерживается.
- Validation error показывается рядом с control и кратко в общем error region.
- Network/conflict error не маскируется optimistic state.
- Toast не является единственным носителем критической информации.

## 6. Задачи: list

List повторяет плотную grouped-list модель Linear.

### 6.1 Group header

- Слева: collapse toggle, property icon/color, group name.
- Рядом: task count; estimate total появится только после отдельного решения.
- Справа на hover: add task и overflow menu.
- Header sticky внутри длинной группы. Status group с нулевым count не
  рендерится; пустые группы других properties следуют `Display` option. После
  filter или mutation набор status groups пересчитывается сразу, а полностью
  пустой результат показывает общий empty state без group headers.

### 6.2 Task row

Порядок данных слева направо:

1. hover-revealed checkbox/selection state;
2. priority indicator;
3. current task identifier;
4. status icon, если status не выражен group;
5. title, занимающий оставшуюся ширину;
6. выбранные display properties как компактные icons/chips;
7. assignee avatar и overflow action на hover.

Дополнительные правила:

- row имеет одну основную строку; description в list не показывается;
- title обрезается ellipsis, но полностью доступен в tooltip/Peek;
- click открывает details, `Space` — Peek, double click не назначается
  отдельному скрытому действию;
- metadata, скрытые через `Display`, не резервируют место;
- subtask использует parent affordance без отдельной карточной визуальной
  системы: list, board и Peek показывают компактный hierarchy chip с parent
  identifier либо числом прямых subtasks;
- details всегда содержит Hierarchy section. Editor выбирает searchable
  same-Project parent, очищает его через `No parent` и создаёт subtask по title;
  Viewer видит те же parent/subtask links без mutation controls. На touch
  select, input и Add subtask складываются в одну колонку и не создают
  горизонтальный overflow.

### 6.3 Highlight, selection и bulk actions

- Hover либо `↑/↓`/`J/K` создаёт highlight, но не selection.
- `X` выбирает highlighted task; `Shift+click` и `Shift+X` расширяют selection;
  `Cmd/Ctrl+A` выбирает задачи текущего результата, а не всего хранилища.
- Checkbox появляется у левого края на hover и остаётся видимым у выбранной
  задачи.
- Выбранные rows имеют единую accent-tinted заливку.
- При selection появляется compact bottom action bar для status, priority,
  assignee, project/release, labels и archive/restore — только для действий,
  поддержанных выбранным набором и authorization scope.
- Для полностью архивной selection action называется `Restore` и снимает
  архивный статус со всех выбранных задач; для неархивной selection доступен
  `Archive`. Action определяется состоянием задач, а не типом текущего view.
- Batch mutation атомарна для одного действия; при отказе UI не оставляет
  смешанное неподтверждённое состояние.
- `Esc` очищает selection после закрытия более верхнего overlay.

## 7. Задачи: Kanban board

### 7.1 Board frame и columns

- Board использует ту же toolbar, query и selected task set, что list.
- Columns следуют текущему `group_by`; default — workflow status.
- Column header показывает property icon/color, name, count, add и overflow.
- Columns одинаковой ширины, прокручиваются горизонтально; vertical scroll
  остаётся внутри board surface.
- Status column с нулевым count не рендерится и не оставляет placeholder или
  hidden-groups container. Пустые columns других properties следуют `Display`;
  если результат целиком пуст, board показывает тот же empty state, что list.

### 7.2 Task card

- Card компактная: title — главный элемент, identifier и выбранные properties —
  secondary.
- Description не показывается; для неё используется `Peek` или details.
- Status не дублируется на card, если он уже выражен column, кроме случаев,
  когда это нужно для accessibility.
- Priority, labels, project/release, due date и assignee используют те же
  icons/chips, что list.
- Hover показывает selection affordance и overflow без изменения высоты card.

### 7.3 Drag-and-drop

- Drag внутри column меняет manual rank только при manual ordering.
- Drag между columns изменяет grouping property и rank одной server command.
- Placeholder показывает точное место вставки; target column имеет мягкую
  подсветку.
- Optimistic move подтверждается server response. Validation/conflict
  возвращает card на server position и показывает конкретную причину.
- Keyboard alternative позволяет изменить property через shortcut/contextual
  actions без drag.
- Если grouping не допускает изменение либо пользователь не имеет доступа,
  drag disabled и cursor/tooltip объясняют причину.

## 8. Создание и details задачи

### 8.1 Quick composer

- `C` и global create button открывают centered modal composer.
- Focus сразу в title. Для сохранения достаточно непустого title; status и
  context defaults видимы до submit.
- Верх/низ composer содержит compact property controls, а не длинную form grid.
- Description редактируется Markdown-capable editor под title.
- `Cmd/Ctrl+Enter` создаёт, `Esc` закрывает с защитой dirty draft.
- Создание из project, release, group или board column предварительно заполняет
  соответствующие properties и показывает их пользователю.
- Label control загружает active labels owner catalog выбранного Project,
  поддерживает multi-select и отправляет все назначения вместе с созданием
  Task. При смене Project несовместимые selected labels очищаются явно.
- Composer принимает несколько файлов через picker или dropzone и сразу
  загружает их как uploader-only staged StoredFiles. Submit доступен после
  `ready`; server создаёт Task и bind-ит `fileRef` с отдельными неизменяемыми
  idempotency keys. При частичном bind modal остаётся открыт, называет созданную
  Task и даёт retry/cancel по каждому файлу. Close сохраняет только безопасные
  staged refs/metadata/operation keys для повторного открытия; явный remove
  удаляет unbound file recoverably, а TTL очищает abandoned drafts. Local path,
  browser `File`, binary и object URL в draft не сохраняются.
- Полноценная система persisted content drafts и templates не входит в MVP;
  bounded recovery staged-file операций является частью attachment workflow.

### 8.2 Task details

- Task открывается в устойчивой details surface: centered overlay на широком
  desktop либо full-page route на узком viewport. URL всегда deep-linkable.
- Header: identifier/breadcrumb, copy link, share для shareable standalone task,
  overflow и close/open-full controls.
- Main column: inline-editable title, полноформатное read-only Markdown-описание,
  subtasks и relations. Description переходит в editor только по явному действию
  `Edit description`; режим чтения не обрезает длинный текст и поддерживает
  headings, lists, checklists, links, code и перенос длинных строк.
- Description editor содержит `Insert image` и `Insert file`, принимает file
  через picker, drop или paste. Upload показывает progress, cancel и retry;
  после успеха в текущую позицию курсора вставляется стабильный native image
  token с filename-derived alt либо скачиваемая Markdown link с label.
  Пользователь может редактировать alt/caption/label и перемещать или удалить
  token как обычный Markdown. Пока upload активен, сохранение description
  недоступно; удаление token не удаляет Attachment.
- Выбранный native image в description, root/reply composer и edit собственного
  Comment показывает общий resize preview. Нижний handle поддерживает pointer
  drag и клавиши-стрелки с шагом `8 px`; touch/keyboard path также предлагает
  presets `240`, `480`, `720 px` и `Auto`. Допустимый canonical диапазон —
  `160..960 px`; `Auto` удаляет width metadata. Controls существуют только в
  authoring mode, не меняют textarea selection и не запускают новый upload.
- Native image в режиме чтения занимает доступную ширину без горизонтального
  overflow, применяет optional embed width не шире контейнера, сохраняет aspect
  ratio, показывает caption и открывает тот же
  private full-preview contract, что Attachment gallery. Loading, invalid и
  недоступный reference имеют локальный placeholder без публичного URL.
- Native file link в режиме чтения остаётся компактной inline-ссылкой с
  переносимым label и keyboard focus. Она скачивает original через текущий
  ACL-scoped content route; loading/missing/forbidden/deleted ref становится
  disabled placeholder без раскрытия filename или существования чужого файла.
- Metadata располагаются компактной полосой под title и/или правой property
  column; один property не дублируется одновременно в двух местах.
- Labels используют тот же chip и searchable multi-select в composer, details,
  list, board и Peek. Editor+ идемпотентно добавляет и снимает active labels,
  Viewer видит chips без picker. Архивный label сохраняет chip на прежней Task
  и доступен для снятия, но отсутствует среди вариантов нового назначения.
- Изменение Project открывает confirmation, а не отправляет generic patch.
  Диалог показывает исходные Project/identifier, target Project и ожидаемый
  `<target-code>-<next-sequence>`, явно отмечая preview как нерезервирующий.
  Отдельные controls требуют выбрать compatible Release либо clear и сохранить
  доступного target assignee либо явно change/clear. Parent/subtasks блокируют
  submit с инструкцией detach/reparent. После commit details/list/board/search
  используют authoritative identifier из server response; stale/conflict не
  оставляет оптимистически показанный перенос.
- Timestamps muted и доступны в нижней metadata section.
- Task overflow отделяет `Archive` от destructive `Delete`. Delete требует
  короткого confirmation, после success закрывает details/Peek, удаляет Task
  из обычных surfaces и показывает bounded Undo toast, ведущий к тому же
  versioned restore. `Delete permanently` в обычном меню отсутствует и доступен
  только current Owner из `Recently deleted`.
- Relations располагаются отдельной секцией с группами `Blocked by`,
  `Blocking`, `Related`, `Duplicate of` и `Duplicates`. Terminal blocker
  остаётся видимым под `Related` как resolved blocker; после reopen возвращается
  в `Blocked by`.
- Editor+ открывает `Add relation`, выбирает relative type и ищет Task по
  identifier/title. Результаты содержат только доступные Project Tasks, для
  которых есть write access; selected target, поиск, сохранение и ошибка имеют
  явные состояния. Existing relation можно изменить или удалить по её version.
  `Duplicate of` формулируется как отдельное destructive domain outcome, а не
  как обычная cosmetic link.
- Viewer видит те же группы и deep links без add/edit/remove controls. На touch
  target actions имеют не менее 40 px, composer перестраивается в одну колонку,
  а portrait/landscape details не создаёт horizontal overflow.
- Ниже properties, hierarchy и relations располагается lazy секция
  `Attachments`: count, Add files для Editor+, picker/drop/paste, progress,
  retry/cancel, compact file cards и recoverable remove/restore. Viewer видит
  те же metadata, download и preview без mutation controls.
- Raster card использует ACL-scoped server thumbnail; ошибка thumbnail
  переключает card на original fallback. Full preview — modal dialog с focus
  trap, `Esc`, arrows, previous/next, zoom-to-fit и download original. Generic
  file всегда использует safe download.
- Gallery отмечает image, используемый в description, статусом
  `Used in description`; remove для такого image блокируется и предлагает
  сначала удалить token из description. Удаление token не удаляет Attachment.
- После секции вложений располагается единая `Activity`: append-only native и
  imported status events образуют компактную временную шкалу рядом с native/
  historical discussions. Event показывает actor snapshot, действие,
  before/after summary и время; historical status имеет badge
  `Imported history`. Activity events и comment roots загружаются отдельными
  lazy keyset pages и не блокируют друг друга при retry.
- Root composer и reply composer сохраняют local draft по
  current User + Task, поддерживают `Cmd/Ctrl+Enter`, явный submit, retry без
  дублей и кнопки базового Markdown-like форматирования.
- Root/reply composer и edit собственного native Comment используют одинаковый
  attachment authoring path: paperclip, выбор ready Task file,
  `Cmd/Ctrl+Shift+A`, multi-file picker, drop и clipboard paste. Raster image
  вставляется block token, generic file — downloadable link с filename-derived
  label в текущую позицию курсора; focus возвращается в editor.
- Upload queue показывает per-file queued/uploading/processing/ready/failed,
  progress, cancel, retry и remove-from-draft. Submit недоступен, пока любой
  связанный upload не ready и не удалён; partial success не скрывает failed
  files. Upload retry сохраняет attachment idempotency key независимо от
  comment idempotency key. Удаление ready token или abandon draft не удаляет
  Attachment из Task gallery.
- Ready refs сохраняются только в draft current User + Task + optional root
  thread; pending upload не восстанавливается как ready. Успешный submit очищает
  только отправленный draft. Viewer не получает authoring/edit controls, а
  revoked Editor получает server mutation error. На touch picker/gallery
  остаются полным путём; controls не меньше 44 px и long/Unicode filenames не
  создают horizontal overflow.
- Width resize обновляет только token выбранного embed в том же draft: duplicate
  refs одного Attachment могут иметь разные widths, reload восстанавливает
  metadata вместе с body, а version conflict/revoke обрабатывается обычным
  Comment/Task save contract.
- Root thread показывает author/avatar, timestamps, body, reactions,
  resolve/reopen и actions по permissions. Replies всегда одноуровневые;
  resolved thread свёрнут, permalink прокручивает и подсвечивает comment,
  длинный body раскрывается через `Show more`.
- Native attachment refs в видимой части comment body используют renderer Task
  Attachments: raster остаётся inline, открывает private full preview с focus
  trap/`Esc` и восстанавливает focus; generic file остаётся переносимой
  keyboard-focusable safe-download ссылкой. Metadata запрашиваются
  deterministic exact-ref batches максимум по 100 с не более чем двумя
  одновременными запросами только для смонтированных comments текущей page;
  collapsed, скрытая часть `Show more` и tombstone не загружают ref. Missing/deleted/
  forbidden/guessed ref выглядит одинаковым локальным placeholder без filename
  и existence leak. Transient chunk failure сохраняет успешные результаты,
  выполняет один bounded automatic retry и оставляет общий manual `Retry`;
  attachment invalidation/retry не сбрасывает root/reply draft.
- Historical comment имеет badge `Imported history`, snapshot исходного author,
  исходные timestamps и optional quote. Для него нет edit/delete controls;
  Editor+ по обычным правилам может reply/react/resolve. Nested imported reply
  отображается одноуровневым под root без потери source parent metadata.
- Loading, error/retry, pending и empty states являются частью Activity. Viewer
  видит threads без composer и mutation controls. На mobile controls имеют
  touch target не меньше 44px и не создают горизонтальный overflow.
- Sync invalidation сбрасывает только загруженную event page открытой Task;
  закрытая Activity не получает event bodies. Load older добавляет прежние
  events без повторов и сохраняет стабильный порядок при новых mutations.
- Provider provenance section после cutover отсутствует. Source links, legacy
  attachment links, branch metadata и reconciliation counts не показываются в
  Task details/Peek; raw evidence доступно только через защищённый backup/D1
  runbook и датированный migration report.
- Изменение title/description происходит inline, с явными saving/error states и
  version conflict handling. Focus, scroll, selection и открытие editor не
  создают dirty draft; dirty начинается только после фактического изменения
  значения и сбрасывается после успешного save или cancel.

### 8.2.1 Управление каталогом labels

- `Settings → Labels` содержит owner-only управление name, color, description,
  archive и restore. Active имя уникально в owner catalog без учёта регистра;
  edit использует current label version и показывает conflict без
  last-write-wins.
- Архивирование не снимает существующие назначения и не скрывает их chips.
  Restore возвращает label в pickers только после server confirmation.
- Bulk bar загружает совместимый catalog выбранных Tasks по требованию и даёт
  отдельные `Add label`/`Remove label`. Одна command либо применяет желаемое
  состояние ко всему набору, либо не меняет ни одну Task.
- Settings panel и picker складываются в одну колонку на mobile, сохраняют все
  actions в portrait и landscape и не создают horizontal overflow.
- `Settings → Labels` также содержит управление Label groups: name,
  description, position, archive/restore и membership Labels. Grouped Labels
  представлены single-select по каждой группе; выбор нового значения атомарно
  заменяет старое, `Clear` снимает значение. Ungrouped секция остаётся
  searchable multi-select.
- Display control при `Group by: Label group` требует конкретную группу и
  строит колонки по её Labels плюс `No <group>`. Drag меняет только group value;
  create-in-column передаёт соответствующий Label. Archived группы/Labels
  остаются видимыми для исторических Tasks, но не являются drop/create target.

### 8.3 Peek

- `Space` на highlighted task открывает non-editing preview поверх list/board;
  удерживание `Space` показывает Peek только до отпускания.
- `↑/↓` либо `J/K` меняет preview на соседнюю task, не закрывая Peek.
- Preview показывает identifier, title, description excerpt и доступные
  metadata без write controls.
- `Esc` закрывает Peek. В text input shortcut не срабатывает.

## 9. Projects и releases

### 9.1 Project list/card

- Project list использует тот же view toolbar, selection grammar и property
  visuals, где они применимы.
- Строка или compact card показывает icon/color, name, summary, status,
  progress, lead и dates.
- Create dialog предлагает code из имени и принимает 1–12 символов: заглавные
  латинские буквы, цифры и дефисы только внутри code. Подсказка объясняет
  grammar и блокировку после первой Task; edit использует тот же control и
  тот же validation contract.
- Archived cards остаются в Project index с явным `Archived` state для
  восстановления, но не показываются в основной sidebar и Task/Release
  create pickers.
- Progress имеет доступное числовое значение и tooltip с формулой подсчёта.

### 9.2 Project details

- Header содержит icon/color, name, status, share, backup и `Edit project`.
  Edit dialog управляет name, code, summary, Markdown description, status,
  lead, start/target dates, icon/color и archive/restore. Locked code остаётся
  видимым read-only с причиной.
- Project overflow содержит отдельные `Archive` и destructive `Delete`.
  Delete предупреждает, что весь Project subtree временно исчезнет из рабочих
  surfaces, но не утверждает, что children удалены независимо. Restore Project
  из `Recently deleted` снимает только этот shadow; отдельно deleted Tasks,
  Releases и Views остаются в корзине. Owner-only permanent delete показывает
  counts Tasks, Releases, Views и Attachments до отдельного cascade confirmation.
- Для current Owner overflow содержит `Export project backup`; action скачивает
  JSON bundle и не показывается Manager/Editor/Viewer. `Restore project` ведёт
  на общую import surface, чтобы deleted Project тоже можно было вернуть.
- Tabs: `Overview`, `Tasks`, `Releases` и project-scoped saved views. Пустые
  tabs для Linear features вне scope не создаются.
- Overview: summary, description, dates, lead и progress; без documents,
  resources, activity и predictive graph.
- Terminal status при открытых Tasks показывает их count и требует checkbox
  подтверждения. Ошибка version/ACL/lead возвращается в общий error region, а
  успешный response сразу обновляет sidebar, card, breadcrumbs, release names
  и открытый overview через единый snapshot/sync contract.
- На mobile overview складывает actions ниже identity, dialog поля переходят в
  одну колонку, а все footer actions имеют touch target не менее 44 px без
  horizontal overflow.
- `Tasks` использует общий list/board contract с project scope.
- Глобальный Task composer требует Project; состояния `No project` и
  сохранения Task без Project нет.
- Details sidebar повторяет compact property panel Linear и открывается
  button/`Cmd/Ctrl+I`, если shortcut не конфликтует с host.

### 9.3 Release surfaces

- Release визуально следует project entity pattern, а не имитирует CI/CD
  pipeline Linear.
- Project `Releases` tab показывает grouped list: status, name/version,
  progress, target/released date и task count.
- Release details содержит description, release notes, status/dates, progress и
  общий task list/board в release scope.
- `Edit release` использует единый create/edit dialog для name/version,
  Markdown description, status, target date и release notes. Project в edit
  read-only. Переход в `released` с открытыми Tasks показывает count и required
  checkbox; уход из `released` предупреждает об очистке server timestamp.
- Заголовок release surface и metadata используют единое полное имя
  `<project name> <release name>`; длинное имя сокращается визуально, сохраняя
  полный текст доступным и не вытесняя actions.
- Перевод в `released` и изменение выпущенного состава используют explicit
  confirmation, как требует MVP. Добавление/удаление Task через details,
  composer, drag-and-drop или Project move использует одно и то же предупреждение
  и не отправляет confirm flag до подтверждения User.
- Release overflow отделяет lifecycle edit от `Delete`. Confirmation прямо
  говорит, что Tasks не удаляются; до restore Release исчезает из обычных
  picker/filter chips, а сохранённая membership остаётся внутренней. Owner-only
  permanent delete из `Recently deleted` показывает число Tasks, у которых
  будет очищен Release.

## 10. Views, filters и display options

### 10.1 View toolbar

- `Filter` открывается по click или `F`.
- Segmented icon switch меняет list/board; `Cmd/Ctrl+B` выполняет то же действие.
- `Display` открывается по click или `Shift+V`.
- `Save as` появляется для доступного текущего результата и создаёт новую View
  из effective base + temporary filters и текущего Display. Исходная View
  обновляется только через `Edit view → Save changes`; временные filters не
  становятся её base query неявно.
- View title/overflow содержит rename, duplicate, share и delete, если action
  входит в effective role. Project-scoped View не имеет отдельного Share:
  участники и роль управляются у Project.

### 10.2 Filter builder

- Первый popover показывает searchable список properties.
- Выбранное условие отображается читаемой формулой из отдельных clickable
  tokens: property, operator, value. Поддерживаются status/category, priority,
  assignee, project, release, label, estimate, due date, parent/subtasks,
  relation type/direction, lifecycle dates и archived state.
- Изменение любого token открывает соответствующий picker; удаление условия
  доступно без открытия advanced editor. Каталожные `in`/`not_in` используют
  multi-select, date и number имеют нативный bounded input, relation разделяет
  type и direction. Пустой searchable catalog показывает явный empty state.
- MVP соединяет условия через `AND`; `OR` и nested groups не показываются как
  disabled promises.
- В Saved View Filter surface показывает два визуально различимых слоя:
  `Saved in <View name>` с полной base formula и `Temporary filters` с
  дополнительными URL/session conditions. Saved chips доступны read-only
  Viewer; Editor+ получает `Edit`, открывающий тот же `Edit view`, что action у
  названия View.
- Temporary filters отражаются в URL и видимы отдельно в toolbar. `Clear
  temporary` очищает только этот слой, не меняя saved formula; каждый temporary
  chip удаляется отдельной touch/keyboard action.
- Counts и suggestions формируются только в authorization scope пользователя.
- Loading сохраняет предыдущий результат до authoritative ответа; нулевой
  результат различает loading, error и честный empty state. Если bounded page
  имеет продолжение, list и board показывают общий `Load more` control.

### 10.3 Display popover

Порядок sections близок к Linear:

1. layout `List` / `Board`;
2. grouping;
3. ordering и direction;
4. display properties;
5. show empty groups для non-status grouping и show subtasks.

Для grouping по `status` show-empty не применяется: нулевые status groups всегда
скрыты. Остальные unavailable combinations disabled с кратким объяснением.
Изменение применяется сразу; persisted state меняется только по правилам
current/saved view.

`Edit view` содержит name, scope, полный base filter builder и Display. Его
draft query всегда начинается с сохранённого
`activeSavedView.query`, даже когда в URL активен temporary layer. При наличии
temporary filters редактор показывает их count и явно сообщает, что они не
войдут в `Save changes`; успешное сохранение и `Cancel` оставляют temporary
layer активным. `Save changes` атомарно заменяет base query/display с текущей
optimistic version, а conflict перечитывает View без partial overwrite.
`Save as` создаёт независимую View из effective query и текущего Display.
Новый пользовательский archive для Saved View недоступен. Legacy archived View
не открывается по direct URL и не остаётся в sidebar; совместимый restore
доступен в `All views`. Viewer видит saved и temporary formulas, может менять
свой temporary layer, но не получает base write controls.

`Delete` — пользовательский destructive action Saved View в overflow и не
материализует Tasks. После recoverable delete View исчезает из
sidebar/direct route и появляется в `Recently deleted`; restore возвращает ту
же base formula, temporary-independent Display и scope. Owner-only permanent
delete удаляет только View/direct grants. Deleted/missing filter reference
показывается одинаковым unresolved token без имени и existence hint; условие
даёт ноль совпадений, а не удаляется из формулы и не расширяет результат.

## 11. Search и contextual command actions

- `/` или search icon открывает global search overlay по доступным tasks,
  projects, releases и views.
- `Cmd/Ctrl+F` ищет title/identifier внутри текущего view, не подменяя global
  search.
- Results сгруппированы по entity type, показывают icon, identifier/title и
  минимальный context; keyboard arrows перемещают highlight, `Enter` открывает.
- Overlay выполняет debounced bounded запросы и догружает следующую страницу
  только по opaque cursor. `Esc` или backdrop закрывает его без изменения
  route, filter, scroll и selection и возвращает logical focus на trigger.
- Loading, empty, partial error и unavailable состояния используют одинаковую
  ACL-safe copy без counts или hints о недоступных records.
- `Cmd/Ctrl+K` открывает contextual actions menu для focused/selected entity.
  Оно содержит только уже реализованные actions из MVP и не является полной
  command palette Linear.
- Search и actions не подтверждают существование недоступного resource.

## 12. Sharing, authentication и profile

У этих surfaces нет прямого требования копировать конкретный account model
Linear, но они обязаны использовать тот же visual language.

### 12.1 Sign-in

- Минимальный centered sign-in panel без application data за ним.
- Два равноправных actions: `Continue with ChatGPT` и `Continue with Google`.
- Loading, provider error и retry показаны внутри panel; identity никогда не
  запрашивается произвольным email/password form.

### 12.2 Share dialog

- Trigger `Share` находится в header Project и global SavedView. Для Task,
  Release и project-scoped SavedView он открывает
  access surface родительского Project либо не дублируется.
- Compact dialog `Members & access` содержит verified-email input, role picker,
  Owner отдельной первой строкой и список active grants с inline role picker.
- Для Project доступны `Manager`, `Editor`, `Viewer`; для global SavedView —
  `Editor`, `Viewer`. Copy рядом с email явно говорит, что
  User должен уже войти и письмо не отправляется.
- Manager видит и изменяет только Editor/Viewer. Owner может назначать Manager,
  Editor, Viewer и получает action `Transfer ownership` только для уже
  добавленного участника. Transfer требует подтверждения последствий, но не
  подтверждения получателя; после server response роли обновляются сразу.
- Viewer не видит write/share controls. Editor видит content mutations, но не
  member management. Disabled option не используется как единственная защита:
  server повторно проверяет actor role и role ceiling.
- Project dialog объясняет inheritance к Tasks, Releases и project-scoped
  SavedViews; global SavedView dialog — что view не расширяет доступ к
  underlying data.
- Revoke требует подтверждения только когда последствия могут оборвать текущую
  работу; результат обновляется после server response.

### 12.3 Shared with me, Profile и Settings

- `Shared with me` — grouped list Projects и SavedViews с
  owner avatar/name и обычными entity controls.
- Settings — отдельная responsive surface с общей left settings navigation.
  На mobile navigation становится горизонтальной scrollable section bar без
  horizontal overflow content. Канонические разделы: `Profile`, `Appearance`,
  `Workflow statuses`, `Labels`, `Codex setup`, `Recently deleted` и `Project
  backup`.
- Каждый раздел имеет собственный `/settings/<section>` URL. Обычная ссылка,
  modifier-click, reload, back и forward сохраняют выбранный раздел.
- `Profile` использует compact form rows для versioned display name, read-only
  verified email, IANA timezone и server-projected linked providers. Invalid
  timezone, conflict и server error остаются в форме без partial save.
- `Appearance` содержит `system`/`light`/`dark` theme и expanded/collapsed
  sidebar preference. Initial server projection применяется к application
  shell без общей для accounts browser key.
- Нажатие на avatar, display name или email в нижней части sidebar открывает
  компактное account menu и не запускает sign out. Интерактивный identity block
  является canonical anchor `/settings/profile`; ниже остаются только
  `Workspace` (`/workspace`), единый `Settings` (`/settings/profile`) и
  доступный server-authorized администратору `Administration` (`/admin`).
  `My tasks`, `Codex setup`, `Workflow statuses`, `Labels`, `Label groups`,
  `Project backup` и inline `Appearance` в account menu не дублируются: их
  рабочие destinations остаются внутри Settings.
- `Workflow statuses` размещает responsive owner-каталог внутри Settings. Active rows
  дают rename, color, reorder внутри immutable category, выбор default и
  archive; используемый/default status требует replacement той же категории.
  `Duplicate` помечен как Reserved, а archived rows раскрываются отдельно и
  поддерживают restore. Ошибка optimistic version остаётся в modal и допускает
  повтор после актуального reload.
- `Labels` размещает owner-каталог внутри Settings без потери create, edit,
  archive, restore, usage counts и существующих Task assignments.
- `Codex setup` размещает flow внутри Integrations с переключаемыми режимами
  `Codex Desktop` и
  `Codex CLI`. До tabs на mobile сразу показан handoff: установка продолжается
  в ChatGPT/Codex Desktop либо CLI, а mobile ChatGPT используется после
  установки plugin на тот же account. Flow визуально разделяет пять стадий:
  `Add Srez Marketplace`, `Install Task Manager plugin`, OAuth
  `Authenticate / Connect`, возврат в Codex с проверкой `Installed` и новый
  task с read-only smoke `Show my tasks in Task Manager.` Для каждой стадии
  указаны поверхность, точные UI labels, действие и success state.
- Desktop path использует `Plugins → Add → Add a marketplace → Source`, затем
  `Personal → Srez Marketplace → Task Manager → Install`, browser consent и
  `Plugins → Installed`. Текст объясняет разницу `Personal` и `Installed`,
  требует тот же ChatGPT account/workspace и новый task/chat для свежего plugin
  snapshot. Developer mode, manual MCP URL, client ID, secret и personal API
  token для обычного подключения не требуются.
- CLI path сохраняет копируемые команды `codex plugin marketplace add
  xxsrez/marketplace`, `codex plugin add task-manager@srez-marketplace` и
  `codex`, затем ведёт через `/plugins → Task Manager → Authenticate`, `/new`
  и тот же read smoke. CLI доступен и как fallback из Desktop troubleshooting.
- Если `Install` перенаправил в web ChatGPT, но plugin не появился, bounded
  troubleshooting запрещает повторные слепые attempts, проверяет одинаковый
  account/workspace, `Personal`/`Installed`, один restart Desktop и CLI
  fallback. Копируемый diagnostic prompt собирает OS/client versions, вывод
  `codex plugin marketplace list` и `codex plugin list`, redirect domain без
  query/tokens, видимые сообщения и screenshots `Personal`/`Installed`.
  Onboarding явно не объявляет этот platform install-баг исправленным.
- Sign out запускается только отдельной icon button справа от account trigger.
  Она имеет явные tooltip и accessible name; вся строка профиля не может быть
  logout hit target.
- `Administration` не является Settings section и остаётся отдельной
  server-gated surface. Условное отображение пункта не заменяет fail-closed
  server authorization прямого `/admin` route.

### 12.4 Administration

- Surface открывается только из server-authorized snapshot; отсутствие пункта
  в sidebar не является единственной защитой.
- Под метриками находится отдельный блок «Резервное копирование и
  восстановление». Он объясняет, что полный `.tmbak` содержит данные всех
  пользователей и должен храниться как секрет; `Import` визуально отделён как
  полная destructive replacement. Эти действия отсутствуют в общей полосе
  title actions и на остальных surfaces.
- `Export` создаёт resumable durable job и после его готовности скачивает
  потоковый `.tmbak`; `Import` открывает многошаговый dialog для chunked upload,
  preview и отдельного destructive confirmation.
- Верхний ряд содержит compact metric cards: registered users, active users за
  7 дней, Tasks, SavedViews и Attachments; secondary notes показывают
  Projects/Releases и content-free bytes/pending/failed/deleted counts.
- Основная dense table содержит User, registration, last active, last content
  activity и owner-scoped counts Tasks/Projects/Releases/Views.
- Display name/email не смешиваются с resource content. Admin surface не
  показывает title, description, filename, object key, file body или query
  чужих records. Полный integrity report вызывается отдельной admin operation.
- Пояснение рядом с таблицей явно отличает latest authenticated request от
  отдельного login event, которого первый срез не записывает.
- `/admin` обычного User разрешается так же fail-closed, как неизвестная или
  недоступная entity route.
- Import dialog сначала выбирает файл и показывает verified preview: export
  time, format/schema version и сравнение текущих/imported counts. Apply
  disabled, пока администратор не скачал текущий backup и не ввёл `RESTORE`.
  Ошибка validation не закрывает dialog и явно сообщает, что live data не
  менялись. После успешного replace выполняется full-page reload `/admin`.

### 12.5 Project backup

- Utility встроена в `Settings → Project backup` и не занимает место в primary
  product navigation.
- Project backup показывает только Projects, где current User — Owner. Для
  каждого доступен download; ниже находится dropzone restore-файла.
- После выбора bundle UI сначала показывает verified preview: имя/ID Project,
  export time, counts, create/update/delete, warnings и sharing descriptors.
  Existing Project требует отдельный текущий download, checkbox восстановления
  sharing и точное имя Project. Destructive apply отделён от file selection.
- После успешного Project restore UI показывает итоговые counts и даёт
  основной action `Open Task Manager`.

### 12.6 Recently deleted

- `Settings → Recently deleted` — единая ACL-scoped surface для Tasks,
  Projects, Releases и SavedViews. Она использует tabs/entity filter, search и
  deterministic pagination; row показывает type, identifier/name, deleted by,
  deletion time и human-readable остаток до cutoff без email/internal IDs.
- Editor+ видит `Restore` пока server `purge_after` не наступил. Restore
  disabled после cutoff даже если bounded cleanup ещё не успел физически
  удалить row; UI не обещает точный wall-clock purge и обновляется по
  authoritative response/sync.
- `Delete permanently` видит только current Owner. Оно всегда открывает
  отдельный destructive dialog: Task/SavedView показывает точную identity,
  Release — число очищаемых Task memberships, Project — counts всего cascade и
  Attachments. Primary action нельзя объединять с Restore или Undo.
- Project row объясняет shadow: обычный restore возвращает Project subtree, но
  separately deleted child остаётся в `Recently deleted`. Release row поясняет,
  что Tasks сохраняются; SavedView row — что Tasks не меняются.
- Unknown, purged, revoked и чужой ref выглядят одинаково как `not found`.
  Success удаляет row из surface; transient R2 cleanup failure оставляет
  owner-visible retryable state без заявления, что permanent delete завершён.
- На mobile entity filter, search, row metadata и actions складываются в одну
  колонку, touch targets не меньше `44px`, destructive dialog не создаёт
  horizontal overflow.

## 13. Keyboard contract

Shortcuts активны только когда focus не находится в text editor/input и host
browser/Sites не перехватывает комбинацию.

| Shortcut | Действие MVP |
|---|---|
| `C` | Открыть task composer |
| `/` | Global search |
| `F` | Filter |
| `Shift+V` | Display options |
| `Cmd/Ctrl+B` | Переключить list/board |
| `↑/↓`, `J/K` | Переместить highlight |
| `X`, `Shift+X` | Выбрать task / расширить selection |
| `Space` | Peek highlighted task/project |
| `Enter` | Открыть highlighted entity / подтвердить menu item |
| `Cmd/Ctrl+K` | Contextual actions menu |
| `Cmd/Ctrl+Enter` | Сохранить composer/form |
| `Esc` | Закрыть верхний layer или очистить selection |
| `Cmd/Ctrl+I` | Toggle details sidebar, где доступно |

Tooltip и menus показывают platform-appropriate symbols (`⌘` на macOS,
`Ctrl` на остальных платформах). Все shortcuts имеют mouse-accessible action.

## 14. Responsive behavior

- Основной acceptance viewport — desktop от `1280px`; Linear-like плотность
  проектируется прежде всего для desktop web.
- Ниже `1024px` details sidebar становится drawer. При ширине `900px` и меньше
  application sidebar закрыт по умолчанию и открывается из постоянного control
  в title row как overlay drawer; это одинаково работает в portrait и
  landscape.
- Mobile drawer содержит полный разрешённый набор навигации и действий:
  `My tasks`, `Shared with me`, `Views`, `Projects`, `Releases`, search, create
  controls и отдельные account trigger/sign out. Account menu сохраняет
  identity, `Workspace`, `Settings` и условный `Administration` в portrait и
  landscape; Administration не дублируется как primary navigation item.
  Section actions не зависят от hover. Выбор route, backdrop и `Esc` закрывают
  drawer, не меняя desktop preference.
- При ширине `900px` и меньше secondary view controls объединяются в доступный
  mobile overflow: search, `Filter`, list/board switch, `Display`, clear и
  save-view action при наличии изменений. Primary contextual create остаётся
  непосредственно в toolbar; ни один in-scope control не удаляется только
  из-за ориентации.
- Ниже `768px` task/project details и composer открываются full-screen, а list
  скрывает необязательные display properties. Touch targets имеют размер не
  меньше `40px`.
- Kanban сохраняет горизонтальные columns, а не превращается автоматически в
  другую сущность; touch drag имеет альтернативу через property picker.
- Минимальная responsive-приёмка включает геометрии `390×844` и `844×390`,
  safe-area insets и повторную проверку после смены ориентации.
- `Codex setup` в обеих mobile-геометриях показывает handoff до flow, сохраняет
  пять стадий, troubleshooting и copy actions без horizontal overflow; code и
  diagnostic prompt переносятся внутри modal, touch controls не меньше `40px`.
- Отдельные native mobile applications не входят в MVP.

## 15. Accessibility и content rules

- Полная keyboard navigation, видимый focus ring и логический tab order
  обязательны до визуального sign-off.
- Dialog имеет focus trap и accessible name; popover/menu использует
  подходящую ARIA semantics.
- Status, priority, progress и validation используют text/icon в дополнение к
  color.
- Target contrast: WCAG 2.2 AA для текста и essential controls.
- Dynamic updates selection, save, error и drag result объявляются assistive
  technologies без избыточного шума.
- UI copy короткая и предметная. Не копируются фирменные тексты Linear; термины
  Task Manager (`Task`, `Release`, `Shared with me`) используются последовательно.

## 16. Parity matrix

| Surface/паттерн Linear | Task Manager | Статус MVP | Осознанное отличие |
|---|---|---|---|
| Left application sidebar | My tasks, Shared, Views, Projects, Releases | Берём | Без teams/inbox/initiatives |
| Workspace overview | User-scoped work, projects, releases, views и shared summaries | Адаптируем | Одна personal workspace без teams, initiatives и cross-user analytics |
| Dense issue list | Dense task list и grouped headers | Берём | Только наши metadata |
| Board layout | Kanban как layout того же view | Берём | Без swimlanes в первом UI |
| Filters | Searchable property formula | Берём ядро | Только `AND` |
| Display options | Layout/group/order/properties/empty non-status groups | Берём ядро | Status groups с нулевым count всегда скрыты; без per-user defaults и subgrouping |
| Issue selection | Hover checkbox, multi-select, bulk bar | Берём | Только in-scope bulk actions |
| Context/command actions | Right-click, overflow, `Cmd/Ctrl+K` | Берём ядро | Не полная command palette |
| Peek | Preview task/project по `Space` | Берём | Только comment count, без thread bodies |
| Issue composer/details | Modal composer, details, native attachments, discussions и change Activity | Берём | Без task templates и mentions; Comment authoring и renderer переиспользуют существующие Task attachments; Task-file upload после create имеет честный partial result |
| Issue relations | Grouped blocking/related/duplicate links и explicit add/edit/remove | Берём ядро | Без auto-related из description/comments в первом writable slice |
| Project overview/sidebar | Overview, tasks, releases, properties | Берём ядро | Без docs/resources/graph |
| Custom views | Saved task views | Берём ядро | Нет initiative/project-view product layers |
| Themes | System/light/dark | Берём | Собственные tokens и branding |
| Share controls | Linear-like compact members dialog | Адаптируем | Owner/Manager/Editor/Viewer и inheritance |
| Login/profile | Та же visual system | Адаптируем | ChatGPT/Google identity model |
| Administration | Compact metrics + dense user table | Адаптируем | Operational aggregates, не Linear analytics |
| Project backup utility | Compact staged wizard | Адаптируем | Только current Project Owner |
| Recently deleted | Единая корзина Tasks/Projects/Releases/Views | Адаптируем | 30-day cutoff, Project shadow и Owner-only purge без Teams/workspace entities |

## 17. Проверка и приёмка

Для каждой новой surface до sign-off должны быть:

1. Ссылка на актуальный официальный Linear reference и дата наблюдения.
2. Список перенесённых controls и задокументированных отклонений.
3. Собственные screenshots Task Manager в light/dark theme на desktop.
4. Visual regression baseline для default, hover/focus, selected, loading,
   empty, error и conflict states.
5. Interaction tests mouse + keyboard для основных действий.
6. Accessibility check focus order, semantics и contrast.
7. Проверка, что ни один видимый control не обещает функцию вне MVP.
8. Проверка, что UI не обходит server authorization/domain validation.

Критерий сходства: пользователь, знакомый с Linear, без обучения находит
основные actions в ожидаемых местах и использует знакомые interaction patterns,
при этом видит самостоятельный продукт Task Manager, а не копию бренда Linear.

## 18. Официальные референсы Linear

Проверены 2026-08-18; перед реализацией крупных surfaces требуется повторная
сверка, потому что интерфейс Linear развивается.

- [Board layout](https://linear.app/docs/board-layout)
- [Display options](https://linear.app/docs/display-options)
- [Select issues](https://linear.app/docs/select-issues)
- [Members and roles](https://linear.app/docs/members-roles)
- [Custom Views](https://linear.app/docs/custom-views)
- [Peek preview](https://linear.app/docs/peek)
- [Create issues](https://linear.app/docs/creating-issues)
- [Editor](https://linear.app/docs/editor)
- [Comment on issues](https://linear.app/docs/comment-on-issues)
- [Upload a file to Linear](https://linear.app/developers/how-to-upload-a-file-to-linear)
- [Edit issues](https://linear.app/docs/editing-issues)
- [Issue relations](https://linear.app/docs/issue-relations)
- [Configure workflows](https://linear.app/docs/configuring-workflows)
- [Filters](https://linear.app/docs/filters)
- [Custom Views](https://linear.app/docs/custom-views)
- [Search](https://linear.app/docs/search)
- [Project overview](https://linear.app/docs/project-overview)
- [Projects](https://linear.app/docs/projects)
- [Workspaces](https://linear.app/docs/workspaces)
- [Preferences](https://linear.app/docs/account-preferences)
