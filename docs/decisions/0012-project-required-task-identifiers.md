# ADR-0012: обязательный Project и project-scoped identifiers Tasks

Статус: `Accepted`

Дата решения: 2026-08-18

## Контекст

Первый вертикальный срез допускал standalone Tasks и выдавал identifier из
owner-scoped sequence. Это расходится с выбранной рабочей моделью: Task должна
иметь явный Project, а её короткий identifier обязан отражать Project и
оставаться безопасно разрешимым после миграции или переноса.

## Решение

1. Каждая Task принадлежит ровно одному Project. Create, import, restore и
   generic update не могут записать `project_id = NULL`; legacy payload требует
   явный Project mapping.
2. Project получает обязательный `task_code` длиной 1–12 символов: `A–Z`,
   `0–9` и дефисы только внутри code, с буквенно-цифровыми краями. Text ingress
   обрезает внешние пробелы и приводит значение к верхнему регистру. Code
   уникален среди active Projects current owner; ownership transfer заранее
   проверяет конфликт у нового owner.
3. Project хранит монотонный `task_sequence`. Следующий номер резервируется
   атомарно и не переиспользуется после archive, purge или переноса.
4. Текущий identifier равен `<task_code>-<task_sequence>`. `public_id` остаётся
   immutable identity и основой canonical web URL.
5. После первого выделенного номера code и allocator history блокируются.
   Явный перенос Task атомарно выдаёт следующий identifier целевого Project, а
   прежний identifier сохраняет как alias.
6. Exact lookup выполняется после ACL по canonical identifier и aliases.
   Несколько доступных alias matches возвращают ambiguity с canonical refs, а
   не произвольную Task.
7. Миграция сохраняет числовые части текущих identifiers, `public_id`, content,
   relations, comments и timestamps; Project sequence инициализируется
   максимальным занятым номером. Backfill mapping и reconciliation являются
   частью versioned migration evidence.

Это решение заменяет standalone Task и optional Project clauses в ADR-0001 и
ADR-0005. Их остальные identity, ACL, ownership-transfer и hosting решения
остаются действующими.

## Последствия

- Task sharing существует только через Project; global SavedView остаётся
  самостоятельным share target.
- Global composer обязан выбрать Project, а Project/Release surfaces могут
  предварительно заполнить его.
- Backup schema переносит Project code/sequence/lock и Task aliases; старые
  bundles без Project требуют явного mapping.
- Generic Task patch не служит move operation. Перенос имеет отдельный
  optimistic, атомарный contract для Project, release и identifier.
- Старый human identifier остаётся совместимой ссылкой, но не identity; при
  ambiguity клиент обязан использовать canonical `public_id`/ref.

## Отклонённые варианты

- Молчаливый общий fallback Project скрывает ошибки импорта и создаёт
  неконтролируемую свалку Tasks.
- Изменяемый Project code после выдачи identifiers ломает ссылки массово.
- Глобальный owner-scoped sequence не выражает Project и не гарантирует
  локальную монотонность.
- Выбор первой Task при неоднозначном alias нарушает ACL-safe deterministic
  lookup.
