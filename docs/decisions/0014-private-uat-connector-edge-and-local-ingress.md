# ADR-0014: private UAT, hosted connector edge и локальный file ingress

Статус: `Accepted`

Дата решения: 2026-08-21

Этот ADR заменяет только connector-часть пункта 6 ADR-0010. Разделение
production/UAT, owner-only audience UAT и production approval boundary
сохраняются.

## Контекст

Sites применяет audience policy до вызова application Worker. Поэтому обычный
remote MCP client не может выполнить DCR, OAuth discovery или `tools/list`
на owner-only `task-manager-uat`: Task Manager OAuth начинается позже и не
заменяет внешний Sites gate.

Попытка решить это одним локальным stdio bridge объединила remote MCP proxy,
local filesystem ingress и Sites bypass credential. Bridge вызывал macOS
`security` для сетевых запросов, а reconnect/retry loop MCP host превратил это
в многократные Keychain prompts. Кроме operational дефекта, такая схема делала
Mac постоянной частью hosted UAT data plane.

## Решение

1. `task-manager-uat` остаётся обычным owner-only Site с отдельными D1/R2.
   Его UI, assets и browser-authenticated control plane не становятся public.
2. Hosted MCP и локальный filesystem ingress снова являются разными
   соединениями. Local stdio companion публикует только `upload_local_file` и
   никогда не проксирует remote JSON-RPC.
3. Запуск companion, `initialize`, `ping` и `tools/list` не выполняют network,
   browser, Keychain или `/usr/bin/security` operations. Первый фактический
   `upload_local_file` запускает native-client DCR + Authorization Code/PKCE;
   OAuth metadata и tokens хранятся только в памяти процесса. Новый процесс
   авторизуется заново.
4. Companion не знает Sites bypass token и не добавляет
   `OAI-Sites-Authorization`. Local path, OAuth token и hosting credential не
   попадают в tool arguments, plugin configuration или repository.
5. Для полного remote UAT connector E2E нужен отдельный hosted machine-only
   connector edge. Он предоставляет только bounded MCP/OAuth/file routes,
   проходит внешний UAT gate server-to-server и после него сохраняет обычные
   Task Manager OAuth, scopes и ACL. UI и arbitrary proxy routes запрещены.
6. Connector edge является отдельной security и deployment boundary. Его
   provisioning, public ingress, hosted secret и включение в UAT plugin требуют
   отдельного явного решения. До этого `task-manager-uat` не считается
   install-ready, а fresh-runtime UAT connector E2E честно остаётся blocked.
7. Production plugin и production Site не используются как замена UAT gate.
   Проверка в production по-прежнему требует отдельной прямой команды.

```text
Codex hosted MCP ──> machine-only connector edge ──> private UAT Site
                                                └──> Task Manager OAuth/ACL

Codex host path ──> local upload_local_file ───────> тот же connector origin
```

## Обязательные свойства connector edge

- exact upstream host и allowlist методов/routes; arbitrary URL запрещён;
- отсутствие UI/assets и default-deny для неизвестного path;
- bounded request/response size, timeout, redirect policy и rate limit;
- hosted secret не возвращается client и не попадает в logs;
- browser authorization остаётся owner-authenticated и не подменяется edge;
- OAuth issuer/resource metadata, token audience и MCP URL образуют один
  согласованный connector origin;
- synthetic-only UAT data и cleanup после smoke;
- post-deploy read-back owner-only UAT audience и полный fresh-runtime tool
  inventory до запуска длинной acceptance matrix.

## Последствия

- Отключённый или простаивающий local companion больше не вызывает системные
  credential prompts и не участвует в обычной remote работе.
- Первый local upload в новом процессе требует browser consent; это осознанная
  цена отсутствия долговременного client-side secret store.
- Source/package tests companion не доказывают hosted UAT reachability. Done
  для file-first runtime требует отдельно подтверждённый connector edge и
  `local path → fileRef → attachmentRef → download → cleanup` в fresh runtime.

## Отклонённые варианты

- Сделать весь UAT Site public — открывает UI audience шире необходимого.
- Вернуть Sites bypass в local bridge или plugin config — снова создаёт
  secret-bearing workstation proxy и повторяет incident class.
- Считать production smoke достаточным UAT — смешивает release boundaries и
  требует недопустимых synthetic production mutations.
- Считать source tests доказательством runtime tuple — не проверяет installed
  plugin, hosted endpoint, OAuth и durable attachment lifecycle вместе.
