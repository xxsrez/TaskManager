# ADR-0009: централизованная синхронизация workspace

Статус: `Accepted`

Дата решения: 2026-08-16

## Контекст

После первого рабочего среза каждая mutation сразу обновляла только текущую
browser session. Изменения из другой вкладки, другого устройства или agent API
становились видны после ручного refresh. Независимые polling loops внутри list,
board, details и навигации создавали бы разные checkpoints, лишние D1 reads и
риск несовместимого состояния между surfaces.

Нужна одна application-level синхронизация для `Task`, `Project`, `Release`,
`SavedView` и membership/permissions. Она обязана сохранить server-side ACL,
optimistic versions и возможность безопасно восстановиться после пропущенных
events, но для текущего масштаба не требует WebSocket infrastructure.

## Решение

1. В hydrated UI работает ровно один coordinator на уровне application shell.
   List, board, details, sidebar, filters, breadcrumbs и selection получают
   изменения через общий `AppSnapshot`; самостоятельные entity polling loops не
   создаются.
2. D1 хранит монотонную sequence и компактный change journal отдельно для
   каждого authenticated principal. Domain-table triggers в той же D1
   transaction создают audience events для текущего owner и active grants.
   Журнал содержит только entity type, internal ID, operation, sequence и
   timestamp, но не пользовательский content.
3. `/api/bootstrap` возвращает opaque principal-scoped cursor. Клиент хранит его
   только рядом с текущим hydrated snapshot в памяти. `/api/sync?cursor=…`
   возвращает упорядоченную bounded page и следующий cursor.
4. Для incremental response сервер строит актуальный ACL-scoped projection
   только по IDs bounded journal page. Доступная touched entity передаётся как
   compact upsert, отсутствующая или ставшая недоступной — как remove. Решение
   не зависит от bounded bootstrap window, поэтому доступная старая Task за его
   пределами не может быть ошибочно удалена. Изменение grant/ownership выдаёт
   principal-scoped reset event, чтобы целиком пересчитать наследуемый scope и
   collaborators без утечки существования чужих records.
5. Клиент применяет страницы по cursor, coalesces повторные изменения одной
   entity и сравнивает `version`/`updated_at`. Повторная доставка идемпотентна;
   загруженный Task body сохраняется поверх более нового summary. Изменения
   labels, relations, comments и imported external context передают только
   task-scoped invalidation IDs: detail/comments/external payload в sync не
   вкладывается. Смонтированный чистый consumer перечитывает свой lazy endpoint,
   закрытый consumer лишь помечает cache stale, а несохранённый draft не
   затирается автоматическим refetch.
6. Некорректный, опережающий, устаревший после pruning или разорванный cursor,
   неизвестный event и ACL reset приводят к полному `/api/bootstrap`. Full reset
   удаляет недоступные records, но не затирает более новые локально
   подтверждённые mutations, завершившиеся после начала запроса.
7. Journal хранится 30 дней и не чаще раза в сутки очищается одним
   throttled maintenance claim. Cursor до retention boundary детерминированно
   получает full reset; sequence не переиспользуется.
8. В видимой online-вкладке coordinator проверяет изменения раз в 60 секунд,
   держит не больше одного request, последовательно вычитывает `hasMore` и после
   ошибки или 45-секундного request timeout использует bounded exponential
   backoff до 5 минут. Hidden/offline вкладка не опрашивает сервер;
   `visibilitychange` или `online` запускает немедленную сверку.
9. Optimistic version conflict остаётся обязательным для всех mutations.
   Polling повышает свежесть read model, но не становится основанием для
   last-write-wins.

Это решение заменяет refresh-only часть пункта 7 ADR-0003. Остальные решения
ADR-0003, включая JSON HTTP, D1 migrations и authentication boundary, не
меняются.

## Последствия

- Изменение из другой session появляется во всех hydrated surfaces не позднее
  одного polling interval, если вкладка видима и сеть доступна.
- ACL всегда проверяется до формирования patch; journal нельзя использовать как
  unscoped read model.
- Create/update/archive/delete и потеря доступа имеют один механизм доставки,
  а invalid cursor имеет детерминированный recovery path.
- Lazy collections не дублируются в incremental payload и загружаются только
  своим активным consumer после ID-only invalidation.
- Operational retention ограничивает рост journal; удаление старых events
  сохраняет gap detection, поэтому клиент со старым cursor получает full reset.
- WebSocket/SSE можно добавить позднее как способ разбудить тот же coordinator,
  не меняя cursor и reconciliation contract.

## Отклонённые варианты

- Polling отдельно в каждой surface — дублирует requests и создаёт несколько
  несовместимых checkpoints.
- Полный bootstrap каждую минуту — пересылает весь ACL workspace даже без
  изменений.
- Хранить один global cursor — раскрывает activity между principals и не
  выражает потерю доступа.
- Доверять payload, записанному в event journal, — может вернуть устаревший или
  уже недоступный content; актуальный projection строится после ACL query.
- WebSocket как обязательная первая поставка — увеличивает runtime и
  operational сложность без требования sub-second collaboration.
