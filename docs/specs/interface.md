# Спецификация интерфейса

Статус: `Proposed`

Последнее обновление: 2026-08-16

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
- Основная навигация: `My tasks`, `Shared with me`, `Views`, `Projects`,
  `Releases`. Исключённые функции Linear не показываются даже disabled.
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
- Workspace root первого среза — `/issues`; туда ведут и product mark/name в
  sidebar, и первый сегмент breadcrumb.
- Открытие task/project из списка не теряет filter, scroll и selection context.
- Публичный URL использует отдельный стабильный UUID `public-id`. Внутренний
  primary key, Linear source ID и import provenance в URL не попадают. Entity
  identity и layout кодируются path segments, а не query parameters:

  | Surface | Прямой URL |
  |---|---|
  | Issues / board | `/issues`, `/issues/board` |
  | Built-in issue view | `/issues/{active|backlog|archived}` |
  | Views / Saved view | `/views`, `/views/{view-public-id}` |
  | Явный layout view | `/views/{view-public-id}/{list|board}` |
  | Projects / Project | `/projects`, `/projects/{project-id}` |
  | Project board | `/projects/{project-id}/board` |
  | Releases / Project releases | `/releases`, `/projects/{project-id}/releases` |
  | Release / board | `/projects/{project-id}/releases/{release-id}`, `…/board` |
  | Issue details | `/issues/{issue-public-id}` |
  | Shared with me | `/shared` |
  | Administration | `/admin` |

- URL saved view без layout открывает сохранённый `display.layout`; суффикс
  `/list` или `/board` переопределяет layout только для текущего открытия и не
  меняет определение view.
- Переключение list/board меняет path через browser history. Back/forward
  восстанавливают entity, layout и открытую Task без повторного входа через
  sidebar.
- Навигационные items и ссылки на records остаются настоящими anchors: их
  можно копировать, открыть в новой вкладке или активировать modifier-click.
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
- Если открытая Task или текущая Project/Release/SavedView удалена либо стала
  недоступна, details/Peek закрываются, stale selection очищается, а navigation
  атомарно возвращается в доступный `Workspace` вместо пустого чужого context.
- Hidden/offline состояние не показывает ошибку само по себе. После возврата
  coordinator немедленно сверяется; временные failures используют backoff и не
  создают дублирующиеся banners или requests.
- Full reset после ACL change или cursor gap сохраняет загруженный Task body и
  более новые подтверждённые локальные mutations, но удаляет недоступные
  records из всех UI contexts.

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
3. immutable task identifier;
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
- subtask использует indentation и parent affordance без отдельной карточной
  визуальной системы.

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
- Полноценная система persisted drafts и templates не входит в MVP.

### 8.2 Task details

- Task открывается в устойчивой details surface: centered overlay на широком
  desktop либо full-page route на узком viewport. URL всегда deep-linkable.
- Header: identifier/breadcrumb, copy link, share для shareable standalone task,
  overflow и close/open-full controls.
- Main column: inline-editable title, description, subtasks и relations.
- Metadata располагаются компактной полосой под title и/или правой property
  column; один property не дублируется одновременно в двух местах.
- Timestamps muted и доступны в нижней metadata section.
- Ниже properties, hierarchy и relations располагается `Activity` с native
  comment threads. Root composer и reply composer сохраняют local draft по
  current User + Task, поддерживают `Cmd/Ctrl+Enter`, явный submit, retry без
  дублей и кнопки базового Markdown-like форматирования.
- Root thread показывает author/avatar, timestamps, body, reactions,
  resolve/reopen и actions по permissions. Replies всегда одноуровневые;
  resolved thread свёрнут, permalink прокручивает и подсвечивает comment,
  длинный body раскрывается через `Show more`.
- Loading, error/retry, pending и empty states являются частью Activity. Viewer
  видит threads без composer и mutation controls. На mobile controls имеют
  touch target не меньше 44px и не создают горизонтальный overflow.
- Для импортированной задачи ниже native Activity остаётся отдельная сворачиваемая
  read-only provenance section с исходными comments и attachment links без
  write controls; импортированные записи не смешиваются с native threads.
- Изменение title/description происходит inline, с явными saving/error states и
  version conflict handling.

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
- Progress имеет доступное числовое значение и tooltip с формулой подсчёта.

### 9.2 Project details

- Header содержит icon/color, inline-editable name, status, share, overflow и
  details toggle.
- Для current Owner overflow содержит `Export project backup`; action скачивает
  JSON bundle и не показывается Manager/Editor/Viewer. `Restore project` ведёт
  на общую import surface, чтобы deleted Project тоже можно было вернуть.
- Tabs: `Overview`, `Tasks`, `Releases` и project-scoped saved views. Пустые
  tabs для Linear features вне scope не создаются.
- Overview: summary, description, dates, lead и progress; без documents,
  resources, activity и predictive graph.
- `Tasks` использует общий list/board contract с project scope.
- Details sidebar повторяет compact property panel Linear и открывается
  button/`Cmd/Ctrl+I`, если shortcut не конфликтует с host.

### 9.3 Release surfaces

- Release визуально следует project entity pattern, а не имитирует CI/CD
  pipeline Linear.
- Project `Releases` tab показывает grouped list: status, name/version,
  progress, target/released date и task count.
- Release details содержит description, release notes, status/dates, progress и
  общий task list/board в release scope.
- Заголовок release surface и metadata используют единое полное имя
  `<project name> <release name>`; длинное имя сокращается визуально, сохраняя
  полный текст доступным и не вытесняя actions.
- Перевод в `released` и изменение выпущенного состава используют explicit
  confirmation, как требует MVP.

## 10. Views, filters и display options

### 10.1 View toolbar

- `Filter` открывается по click или `F`.
- Segmented icon switch меняет list/board; `Cmd/Ctrl+B` выполняет то же действие.
- `Display` открывается по click или `Shift+V`.
- Save control появляется, когда временный filter/display state отличается от
  сохранённого view. Доступны `Save as new`, `Update` и `Discard changes`
  согласно ownership/ACL.
- View title/overflow содержит rename, duplicate, share и delete, если action
  входит в effective role. Project-scoped View не имеет отдельного Share:
  участники и роль управляются у Project.

### 10.2 Filter builder

- Первый popover показывает searchable список properties.
- Выбранное условие отображается читаемой формулой из отдельных clickable
  tokens: property, operator, value.
- Изменение любого token открывает соответствующий picker; удаление условия
  доступно без открытия advanced editor.
- MVP соединяет условия через `AND`; `OR` и nested groups не показываются как
  disabled promises.
- Active filters отражаются в URL и видимы в toolbar. `Clear all` возвращает
  базовый view state.
- Counts и suggestions формируются только в authorization scope пользователя.

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

## 11. Search и contextual command actions

- `/` или search icon открывает global search overlay по доступным tasks,
  projects, releases и views.
- `Cmd/Ctrl+F` ищет title/identifier внутри текущего view, не подменяя global
  search.
- Results сгруппированы по entity type, показывают icon, identifier/title и
  минимальный context; keyboard arrows перемещают highlight, `Enter` открывает.
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

- Trigger `Share` находится в header Project, standalone Task и global
  SavedView. Для project Task, Release и project-scoped SavedView он открывает
  access surface родительского Project либо не дублируется.
- Compact dialog `Members & access` содержит verified-email input, role picker,
  Owner отдельной первой строкой и список active grants с inline role picker.
- Для Project доступны `Manager`, `Editor`, `Viewer`; для standalone Task и
  global SavedView — `Editor`, `Viewer`. Copy рядом с email явно говорит, что
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

### 12.3 Shared with me и profile

- `Shared with me` — grouped list Projects, standalone Tasks и SavedViews с
  owner avatar/name и обычными entity controls.
- Profile/settings использует left settings navigation и compact form rows.
- Доступны display name, verified email, timezone, linked providers, theme,
  sidebar preference и sign out.
- Нажатие на avatar, display name или email в нижней части sidebar открывает
  компактное account menu и не запускает sign out. Первый menu slice показывает
  verified identity, рабочие переходы в `My tasks`, `Project backup`, доступную
  администратору `Administration` и общий для всех пункт `Codex setup`, а также
  выбор `system`/`light`/`dark` theme.
- `Codex setup` открывает modal с переключаемыми режимами `Codex Desktop` и
  `Codex CLI`. Desktop flow показывает добавление `Srez Marketplace`, в котором
  сейчас опубликован `Task Manager`, его установку и OAuth `Authenticate`/`Connect`;
  CLI flow показывает копируемые команды `codex plugin marketplace add`,
  `codex plugin add` и последующий OAuth flow. Ни один режим не требует ручного
  ввода MCP URL, client ID, secret или API token; copy controls и текущая
  выбранная вкладка имеют accessible labels/states.
- Sign out запускается только отдельной icon button справа от account trigger.
  Она имеет явные tooltip и accessible name; вся строка профиля не может быть
  logout hit target.

### 12.4 Administration

- Surface открывается только из server-authorized snapshot; отсутствие пункта
  в sidebar не является единственной защитой.
- В title actions находятся `Export backup` и визуально destructive
  `Import backup`. Export сразу скачивает versioned JSON; Import открывает
  многошаговый dialog.
- Верхний ряд содержит compact metric cards: registered users, active users за
  7 дней, Tasks и SavedViews; secondary notes показывают Projects/Releases.
- Основная dense table содержит User, registration, last active, last content
  activity и owner-scoped counts Tasks/Projects/Releases/Views.
- Display name/email не смешиваются с resource content. Admin surface не
  показывает title, description или query чужих records.
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

- Отдельная utility surface открывается из account menu, а не занимает место в
  primary product navigation.
- Project backup показывает только Projects, где current User — Owner. Для
  каждого доступен download; ниже находится dropzone restore-файла.
- После выбора bundle UI сначала показывает verified preview: имя/ID Project,
  export time, counts, create/update/delete, warnings и sharing descriptors.
  Existing Project требует отдельный текущий download, checkbox восстановления
  sharing и точное имя Project. Destructive apply отделён от file selection.
- После успешного Project restore UI показывает итоговые counts и даёт
  основной action `Open Task Manager`.

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
  controls и profile/sign out. Administration остаётся в доступном из drawer
  account menu, а не дублируется как primary navigation item.
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
| Dense issue list | Dense task list и grouped headers | Берём | Только наши metadata |
| Board layout | Kanban как layout того же view | Берём | Без swimlanes в первом UI |
| Filters | Searchable property formula | Берём ядро | Только `AND` |
| Display options | Layout/group/order/properties/empty non-status groups | Берём ядро | Status groups с нулевым count всегда скрыты; без per-user defaults и subgrouping |
| Issue selection | Hover checkbox, multi-select, bulk bar | Берём | Только in-scope bulk actions |
| Context/command actions | Right-click, overflow, `Cmd/Ctrl+K` | Берём ядро | Не полная command palette |
| Peek | Preview task/project по `Space` | Берём | Только comment count, без thread bodies |
| Issue composer/details | Modal composer, details и native Activity | Берём | Без task templates, attachments и mentions; comment draft локальный |
| Project overview/sidebar | Overview, tasks, releases, properties | Берём ядро | Без docs/resources/graph |
| Custom views | Saved task views | Берём ядро | Нет initiative/project-view product layers |
| Themes | System/light/dark | Берём | Собственные tokens и branding |
| Share controls | Linear-like compact members dialog | Адаптируем | Owner/Manager/Editor/Viewer и inheritance |
| Login/profile | Та же visual system | Адаптируем | ChatGPT/Google identity model |
| Administration | Compact metrics + dense user table | Адаптируем | Operational aggregates, не Linear analytics |
| Project backup utility | Compact staged wizard | Адаптируем | Только current Project Owner |

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

Проверены 2026-08-14; перед реализацией крупных surfaces требуется повторная
сверка, потому что интерфейс Linear развивается.

- [Board layout](https://linear.app/docs/board-layout)
- [Display options](https://linear.app/docs/display-options)
- [Select issues](https://linear.app/docs/select-issues)
- [Members and roles](https://linear.app/docs/members-roles)
- [Custom Views](https://linear.app/docs/custom-views)
- [Peek preview](https://linear.app/docs/peek)
- [Create issues](https://linear.app/docs/creating-issues)
- [Edit issues](https://linear.app/docs/editing-issues)
- [Filters](https://linear.app/docs/filters)
- [Custom Views](https://linear.app/docs/custom-views)
- [Search](https://linear.app/docs/search)
- [Project overview](https://linear.app/docs/project-overview)
- [Preferences](https://linear.app/docs/account-preferences)
