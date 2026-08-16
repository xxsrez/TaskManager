# ADR-0002: интерфейсный паритет с Linear

Статус: `Accepted`

Дата решения: 2026-08-14

Дополнение 2026-08-16: native task comments добавлены в MVP; для их Activity
surface действуют те же Linear-like composition и interaction rules. Mentions,
attachments, notifications и общий activity feed остаются исключены.

## Контекст

Task Manager переносит из Linear ограниченный набор продуктовых возможностей:
задачи, проекты, релизы, list/Kanban, saved views, фильтры и связанные с ними
metadata controls. Пользователь проекта уточнил, что интерфейс этих
возможностей должен быть функционально и стилистически максимально близок к
Linear, а не только использовать похожую доменную модель.

Фраза «как в Linear» сама по себе недостаточна для реализации и приёмки:
интерфейс Linear меняется, некоторые его controls относятся к функциям вне
нашего MVP, а буквальное копирование бренда и assets не требуется. Поэтому
направление фиксируется как правило выбора паттернов, а подробный контракт — в
[спецификации интерфейса](../specs/interface.md).

## Решение

1. Для каждой функции, входящей в scope Task Manager, актуальный интерфейс
   Linear является основным референсом. По умолчанию переносим:
   - информационную иерархию и расположение controls;
   - форму control, плотность, визуальные состояния и motion;
   - способ открытия и редактирования данных;
   - mouse, keyboard, selection, context menu и drag-and-drop поведение;
   - loading, empty, error, disabled, optimistic и conflict states.
2. Функциональный паритет важнее пиксельного. Control, похожий на Linear,
   обязан выполнять ожидаемое действие; декоративные неработающие копии не
   допускаются.
3. Внешний вид должен быть узнаваемо Linear-like: компактный application shell,
   спокойные нейтральные surfaces, тонкие borders, небольшие radii, плотные
   строки и карточки, muted metadata, единый line-icon language и короткие
   переходы.
4. Это не полный клон Linear. Переносятся только controls для функций,
   перечисленных в `docs/specs/mvp.md`. Teams, cycles, initiatives, inbox,
   documents, analytics и другие исключённые возможности не должны появляться
   в UI как неработающие пункты.
5. Task Manager использует собственные название, логотип, тексты, illustration
   assets и product identity. Не копируются Linear trademark, logo, фирменные
   иллюстрации, исходный код или закрытые assets. Разрешено использовать
   собственные либо открыто лицензированные icons и fonts с близкой геометрией.
6. При конфликте приоритет имеют доменные инварианты, authorization,
   accessibility, ограничения ChatGPT Sites и явные границы MVP. Каждое
   заметное отклонение от Linear фиксируется в UI parity matrix с причиной.
7. Референс Linear датируется. Перед реализацией крупной поверхности команда
   повторно сверяет актуальные официальные screenshots/docs и сохраняет
   собственный acceptance baseline, не добавляя чужие изображения в продукт.

## Минимальный обязательный набор паттернов

- collapsible left sidebar и компактная верхняя панель view;
- одинаковая toolbar-модель для list и board;
- `Filter`, `Display`, layout switch и save-view control;
- dense task rows, Kanban columns/cards и inline property chips;
- hover focus, checkbox reveal, single/multi-select и contextual bulk bar;
- right-click/overflow menus и ограниченное ported actions command menu;
- modal composer для быстрого создания и отдельная details surface;
- task Activity с native root/reply threads, reactions и resolution;
- inline editing title/description и popover property pickers;
- keyboard-first навигация и shortcuts для доступных действий;
- `Peek` для task/project из list и board;
- optimistic drag с server validation и явным rollback;
- светлая, тёмная и system theme в общей Linear-like visual system.

## Последствия

- UI primitives и screens нельзя проектировать независимо друг от друга: одна
  property должна выглядеть и вести себя одинаково в row, card, details,
  filter и composer.
- Scope реализации немного расширяется за счёт interaction layer: нужны
  selection, context menus, limited command actions, keyboard navigation и
  Peek, даже если основной CRUD уже работает мышью.
- Полная workspace-wide command palette остаётся вне MVP. `Cmd/Ctrl+K`
  используется как contextual actions menu только для действий, уже входящих
  в продукт.
- Визуальная проверка становится частью приёмки наряду с domain/UI tests.
- Обновления Linear не применяются автоматически: новая версия референса
  требует осознанного сравнения и не может молча менять уже принятый UX.

## Отложено

- собственная уникальная visual identity поверх базовой Linear-like системы;
- публичный design system package и Storybook-подобный каталог;
- точные mobile-native adaptations;
- полная command palette, global navigation grammar и shortcuts для функций
  вне MVP;
- pixel-perfect matching конкретной версии Linear.

## Источники

Актуальные официальные материалы Linear, проверенные 2026-08-14:

- [Board layout](https://linear.app/docs/board-layout)
- [Display options](https://linear.app/docs/display-options)
- [Select issues](https://linear.app/docs/select-issues)
- [Peek preview](https://linear.app/docs/peek)
- [Create issues](https://linear.app/docs/creating-issues)
- [Edit issues](https://linear.app/docs/editing-issues)
- [Filters](https://linear.app/docs/filters)
- [Custom Views](https://linear.app/docs/custom-views)
- [Search](https://linear.app/docs/search)
- [Preferences](https://linear.app/docs/account-preferences)
