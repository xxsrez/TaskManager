# ADR-0014: private UAT и on-demand local ingress

Статус: `Superseded`

Дата решения: 2026-08-21

Operational acceptance path этого ADR заменён
[ADR-0015](0015-production-file-first-release-canary.md). Документ сохранён как
история отклонённого private-UAT ingress: реализовывать, запускать или требовать
этот контур для текущего release gate больше не следует.

Этот ADR заменяет прежнюю connector-часть пункта 6 ADR-0010 и прежнюю редакцию
ADR-0014 с hosted machine-only edge. Разделение production/UAT, owner-only
audience UAT и production approval boundary сохраняются.

## Контекст

Sites применяет audience policy до вызова application Worker. Поэтому обычный
machine client не может выполнить DCR, token exchange или Agent REST request на
owner-only `task-manager-uat` без отдельного Sites credential. При этом browser
владельца нормально проходит Sites authentication и не требует ослабления
audience.

Первая попытка объединить remote MCP proxy, local filesystem ingress и
получение Sites credential через macOS `security` создала постоянный локальный
data plane и многократные Keychain prompts при reconnect/retry MCP host.
Следующая идея вынести обход в публичный hosted machine-only edge добавляла
лишний internet-facing security boundary и зависимость от hosted Codex, хотя
проверяемый сценарий целиком выполняется на Mac владельца.

Целевой сценарий требует только: безопасно прочитать разрешённый local file,
загрузить его как `StoredFile`, связать полученный `fileRef` с Task и проверить
download/cleanup в private UAT.

## Решение

1. `task-manager-uat` остаётся обычным owner-only Site с отдельными D1/R2.
   UI, assets и application routes не становятся public.
2. Operator-only UAT plugin не объявляет hosted MCP. Один local stdio companion
   публикует два tools:
   `upload_local_file` и `attach_local_file_to_task`.
3. Первый tool читает один exact host-authorized absolute path, проверяет
   regular-file snapshot и вызывает Agent REST `POST /files`. Второй принимает
   verified `fileRef`, Task ref и независимый idempotency key, вызывает Agent
   REST `POST /tasks/{ref}/attachments` и возвращает `attachmentRef`. Hosted MCP
   и hosted Codex в этой цепочке не участвуют.
4. Startup, `initialize`, `ping` и `tools/list` не выполняют network, browser,
   Keychain или `/usr/bin/security` operations. Native-client DCR + Authorization
   Code/PKCE начинается только при первой фактической операции. Client metadata,
   access и rotating refresh token живут только в памяти stdio process.
5. Для machine requests оператор вручную запускает второй режим того же bundled
   binary: bounded private-UAT ingress на exact `127.0.0.1:47821`. Он не
   стартует автоматически, не устанавливается как daemon и не слушает внешний
   interface.
6. Ingress принимает raw Sites bypass token ровно один раз через stdin, хранит
   только в памяти процесса и добавляет его к exact UAT upstream. Token запрещён
   в chat, command arguments, exported environment, plugin config, repository,
   logs, Task evidence, Keychain и `/usr/bin/security`.
7. Browser authorization не проходит через ingress: owner открывает обычный
   UAT URL и проходит Sites authentication. Redirect URI остаётся PKCE loopback
   callback local companion.
8. Production plugin, production Site, изменение access policy, публичный edge
   и hosted secret store не используются как замена UAT gate.

```text
Codex on Mac ─stdio─> local upload_local_file ───────┐
             └─────> local attach_local_file_to_task ├─> 127.0.0.1 ingress
Owner browser ───────────────────────────────────────┘      │
                                                            └─> private UAT
                                                                Agent REST/OAuth
```

## Обязательные свойства local ingress

- exact listen `127.0.0.1:47821`; wildcard, LAN и public bind запрещены;
- fixed upstream `https://task-manager-uat.example.invalid` без
  environment override, redirects и proxy environment;
- allowlist методов и routes только для DCR/token/revoke, staged files,
  TaskAttachment metadata/bind/content и cleanup;
- MCP, UI/assets, browser authorization и arbitrary URL/path запрещены;
- body/response size и timeout ограничены; content query допускает только
  `variant=original|thumbnail`;
- request/response header allowlists; Cookie, Origin, Referer, upstream
  `Set-Cookie`, Sites credential и произвольные diagnostic headers не пересекают
  ingress boundary;
- inbound `OAI-Sites-Authorization` всегда игнорируется и заменяется значением
  из памяти ingress process;
- остановка `Ctrl-C` завершает listener; process не сохраняет token или OAuth
  state на диск.

Рекомендуемый ручной запуск из установленного UAT plugin:

```zsh
read -rs 'TM_UAT_SITES_TOKEN?UAT Sites token: '
printf '\n'
exec {TM_UAT_TOKEN_FD}< <(printf '%s' "$TM_UAT_SITES_TOKEN")
unset TM_UAT_SITES_TOKEN
./bin/task-manager-local-launcher --serve-private-uat-ingress <&$TM_UAT_TOKEN_FD
exec {TM_UAT_TOKEN_FD}<&-
unset TM_UAT_TOKEN_FD
```

Оператор не передаёт token агенту. Команда не использует clipboard automation,
Keychain или shell history для значения secret.

## Verification gate

Source/package проверки обязаны подтвердить side-effect-free discovery, два
local tools, loopback-only listener, route/header/size/redirect boundaries и
отсутствие `/usr/bin/security`/Keychain dependency в shipped binary. Они не
доказывают runtime tuple.

Done для file-first runtime требует установленный свежий UAT plugin и цепочку:

```text
exact local path → fileRef → attachmentRef → authenticated download → cleanup
```

Evidence фиксирует plugin version, deployed UAT exact SHA, tool inventory,
refs/metadata и результат cleanup, но не local path, file contents, OAuth token
или Sites credential.

## Последствия

- Обычная remote работа production plugin не зависит от Mac ingress.
- UAT ingress существует только во время явно запущенного smoke; private UAT не
  становится public и не получает новый hosted perimeter.
- Новый stdio process требует повторного browser consent, потому что OAuth state
  намеренно volatile.
- Если ingress не запущен, фактическая local operation возвращает понятную
  retryable ошибку; discovery остаётся рабочим и не вызывает prompts.

## Отклонённые варианты

- Сделать весь UAT Site public — расширяет audience UI и данных без
  необходимости.
- Hosted machine-only connector edge — добавляет public ingress, hosted secret,
  отдельный deployment/security boundary и ненужную зависимость от hosted Codex.
- Вернуть Sites bypass в Keychain или автоматически запускать local bridge —
  повторяет incident class с системными prompts и постоянным proxy process.
- Передать secret через argv, env, config или chat — делает его наблюдаемым за
  пределами короткоживущей памяти ingress.
- Проверять в production — смешивает release boundaries и требует недопустимых
  synthetic production mutations.
- Считать source tests runtime proof — не проверяет installed plugin, UAT
  deployment, browser OAuth и durable attachment lifecycle вместе.
