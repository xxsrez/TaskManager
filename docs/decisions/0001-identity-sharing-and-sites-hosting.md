# ADR-0001: identity, sharing и hosting на ChatGPT Sites

Статус: `Accepted`

Дата решения: 2026-08-13

Часть решения об application administrator уточнена в
[ADR-0004](0004-system-backup-and-restore.md): обычный admin overview остаётся
content-free, но тот же server-gated administrator получает отдельные явные
операции полного системного backup и restore.

Решения 6–8 о единственном `full_access`, inheritance и неизменяемом owner
заменены [ADR-0005](0005-project-roles-and-ownership-transfer.md).

Дополнение 2026-09-01: ADR-0017 расширяет sharing отдельным Team-принципалом.
Verified email остаётся обязательным для direct User grant и добавления
зарегистрированного User в Team, но сам Team grant не материализует User grants.

## Контекст

Продукту нужны реальные пользователи, раздельные данные и простая совместная
работа. Пользователь проекта задал два способа входа — ChatGPT и Google — и
выбрал ChatGPT Sites как production hosting. На первом этапе роли не нужны:
если владелец делится resource, collaborator всегда получает полный доступ.

Официальная документация Sites подтверждает managed hosting, durable D1
storage, authentication-enabled Sites и platform-provided `Sign in with
ChatGPT`. Она также подчёркивает, что audience Site и authorization внутри
приложения — разные контуры. Sites находится в public beta, поэтому
доступность и ограничения зависят от plan, region и workspace settings.

## Решение

1. Production target — ChatGPT Sites. Приложение использует поддерживаемую
   Sites web shape и D1 binding для durable structured data.
2. Для доступа к данным пользователь обязан войти через ChatGPT либо Google.
   Публично достижимым может быть только sign-in shell; анонимный пользователь
   не получает доступ к данным Task Manager.
3. `Sign in with ChatGPT` использует platform-provided Sites routes и trusted
   server request headers. Google является вторым обязательным external
   identity provider; точный OAuth/OIDC adapter подтверждается на совместимость
   с Sites до реализации.
4. Доменный `User` не равен provider account. `UserIdentity` связывает одного
   внутреннего пользователя с одним или несколькими login providers.
   Совпадение email само по себе не объединяет аккаунты: linking требует явно
   аутентифицированного flow.
5. Каждый user-owned resource или catalog record имеет одного владельца и
   приватен по умолчанию. Authorization выполняется server-side на каждом query
   и mutation.
6. Единственная permission collaborator в MVP — `full_access`. Она позволяет
   читать и менять resource, создавать дочерние записи, архивировать,
   восстанавливать и управлять sharing в пределах resource subtree. Владелец
   остаётся владельцем и не может потерять implicit access.
7. Shareable roots в MVP: `Project`, standalone `Task` и `SavedView`.
   Project grant распространяется на его tasks и releases. Release отдельно не
   шарится; task внутри project доступен через project grant. SharedView не
   предоставляет доступ к попавшим в него данным сам по себе.
8. Sharing выполняется только с уже зарегистрированным пользователем по его
   verified email. Email invitations и granular roles откладываются.
9. `.openai/hosting.json` создаётся или обновляется Sites при provisioning и
   хранит только project/binding metadata. Provider secrets задаются через
   hosted environment settings и не коммитятся.
10. Application administrator задаётся отдельным hosted verified-email
    allowlist. Он видит только registration/activity metadata и owner-scoped
    aggregate counts; capability не является `AccessGrant`, не даёт доступа к
    содержимому чужих resources и не вводит granular collaborator roles.

## Последствия

- Любая таблица пользовательских данных и любой query path требуют явного
  owner/ACL scope; это нельзя добавить постфактум только в UI.
- Child records shared project наследуют owner проекта даже при создании
  collaborator. Перемещение записи через owner boundary не является обычной
  edit-операцией и не входит в MVP.
- Standalone Task с direct grants нельзя добавить в Project, пока grants не
  отозваны; это сохраняет единственную понятную модель inheritance.
- `full_access` намеренно прост, но разрешение re-share повышает риск; revoke,
  provenance grant и аудит security-сценариев обязательны.
- Sites D1 становится исходной relational storage target, но schema и
  migration tool всё ещё должны быть выбраны и проверены в runtime.
- Sites public beta, отсутствие data residency at launch и plan/workspace
  limits являются deployment risks, а не неподтверждёнными возможностями
  приложения.

## Отложено

- роли viewer/editor/resource-admin и resource-specific permissions;
- приглашения незарегистрированных пользователей;
- ownership transfer и перенос records между владельцами;
- public share links и anonymous access к данным;
- automatic account merge по совпадающему email;
- alternative hosting и external database.

## Источник по Sites

- [Sites — официальная документация ChatGPT](https://learn.chatgpt.com/docs/sites)
