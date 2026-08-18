# Миграция обязательных Project и identifiers Tasks

Дата: 2026-08-18
Статус: `Implemented` в UAT

## Scope

Отчёт фиксирует migration `0018_tearful_black_panther.sql`, которая делает
`Task.project_id` обязательным, переносит нумерацию Tasks в Project, добавляет
Project code/sequence/lock и сохраняет прежние identifiers в
`task_identifier_aliases`.

Миграция выпущена только в UAT Site `task-manager-uat`. Production Site
`task-manager` и его D1 не изменялись.

## Release evidence

- Implementation SHA: `e0e0ac35e5c9c31febd4820d9469d2194d6c5d57`.
- UAT Sites version: `11`.
- Deployment: `succeeded` на
  `https://task-manager-uat.example.invalid`.
- До cutover live-версией была UAT version `10` на SHA
  `be6289968790e20b6b509842b9de3bb143f9b41e`.
- Обязательные проверки implementation SHA: typecheck, lint, build,
  `238/238` tests, `git diff --check` и strict docs validation.
- После deploy access policy повторно проверена: `custom`, один owner, без
  groups и external visitors.

## Backup до cutover

Перед deploy через Administration сохранён system backup
`task-manager-backup-2026-08-18 (2).json` вне репозитория.

- file SHA-256:
  `09fa9196f572e935459a378c0c95d4ed1f1c5cdfaaf511f35b33ed09d0cac370`;
- logical backup checksum:
  `80aa5f64b25ca2d291014ffdd9f24c8957858735ada869e5159d7caa1f070e50`;
- source schema: `5`, environment: `uat`;
- rows: 1 user, 1 identity, 7 workflow statuses, 1 Project, 1 Release,
  6 Tasks, 1 comment и 1 Attachment;
- backup содержит 1 R2 object; declared и фактические counts совпали.

После deploy этот schema-5 backup успешно прошёл новый restore validation.
Validation не меняла live database; destructive `RESTORE` не выполнялся.

## Mapping и reconciliation

Project `UAT Sandbox` получил code `ZAA`, sequence `6` и lock timestamp первой
Task. Все шесть старых Tasks сохранили `public_id`, Project, Release, status,
version и timestamps:

| Старый identifier | Текущий identifier | Alias сохранён |
| --- | --- | --- |
| `TM-1` | `ZAA-1` | да |
| `TM-2` | `ZAA-2` | да |
| `TM-3` | `ZAA-3` | да |
| `TM-4` | `ZAA-4` | да |
| `TM-5` | `ZAA-5` | да |
| `TM-6` | `ZAA-6` | да |

Post-migration database read-back подтвердил:

- 6/6 исходных Tasks имеют non-null Project и identifier `ZAA-<sequence>`;
- 6/6 прежних `TM-*` записаны в `task_identifier_aliases` и ссылаются на
  исходные Task IDs;
- comment `1 -> 1`, Attachment `1 -> 1`, reactions `0 -> 0`, relations
  `0 -> 0`;
- Attachment сохранил object key, byte size `927528` и checksum
  `d87f39ae791d68195c991c409ddc93a2c8dddbe07015751bb814c80ddd500706`;
- authenticated detail smoke загрузил description image, Attachment и native
  comment после миграции.

## Post-deploy smoke

- UI создал Project `TM-246 Code Smoke` с code `UC`.
- Global Task composer оставил Create disabled при заполненном title без
  Project.
- После выбора `UC · TM-246 Code Smoke` первая Task создана как `UC-1`; Project
  sequence стал `1`, code lock установлен.
- Поиск в живом task list по старому alias `TM-1` вернул текущую Task `ZAA-1`.
- Local API отдельно отклонил create без Project с `400 Project is required`,
  а последовательные create получили `BC-1`, `BC-2` и browser-created `BC-3`.

## Rollback и recovery boundary

- Migration выполняется одной D1 deployment transaction. Автотест проверяет,
  что при unmapped legacy Task она завершается ошибкой и оставляет прежние
  schema/data без частичного cutover.
- System restore остаётся атомарным: validated backup либо заменяет весь
  logical state, включая Attachment objects, либо не меняет live state.
  Pre-cutover schema-5 backup подтверждён как допустимый input новой версии и
  служит для roll-forward восстановления содержимого.
- UAT version `10` сохранена как code rollback point, но её deploy сам по себе
  не откатывает уже применённую D1 schema. Полный post-success schema rollback
  потребовал бы provider-level D1 point-in-time restore вместе с version `10`;
  такой destructive rollback не выполнялся и не считается проверенным.

## Итог

UAT reconciliation завершилась без потери исходных records. Новая обязательная
Project boundary, Project-local allocation, code lock, aliases, UI create и
backup validation подтверждены. Production migration остаётся отдельным
явно авторизуемым релизом.
