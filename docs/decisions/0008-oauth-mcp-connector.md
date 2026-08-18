# ADR-0008: OAuth-first MCP connector для Codex и ChatGPT

Статус: `Accepted`

Дата решения: 2026-08-14

Дополнено 2026-08-15: Git marketplace обобщён до `Srez Marketplace`; Task
Manager остаётся его первым plugin, а каталог может расширяться независимо от
этого продукта. Для текущего ChatGPT app connector выбран DCR: production
проверка CIMD завершалась `invalid_client` при проверке metadata document,
тогда как DCR через тот же authorization server прошёл полный Connect flow.

## Контекст

REST API из ADR-0006 покрывает task-oriented data plane, но personal token
делает установку неудобной: пользователь должен открыть settings, создать
secret и вручную перенести его в client. Для друга с Codex Desktop целевой
flow должен выглядеть как установка одного plugin и обычная кнопка Connect.

Агенту нужны workspace orientation, поиск всех доступных Tasks, фильтры по
Project/Release, compact selection, отдельный полный Task detail и безопасные
task commands. UI snapshot и административные capabilities для этого не нужны.

## Решение

1. Task Manager публикует remote Streamable HTTP MCP endpoint
   `https://<site>/api/mcp`. REST `/api/agent/v1` остаётся стабильным
   программным контрактом и использует тот же query/command service.
2. Sites application одновременно является OAuth 2.1 Authorization Server и
   MCP Resource Server. Authorization endpoint использует существующую
   trusted `Sign in with ChatGPT` identity и явный экран согласия.
3. Public clients используют Authorization Code + PKCE S256. Поддерживаются
   два безопасных способа получить `client_id`: Client ID Metadata Document
   (CIMD) и Dynamic Client Registration (DCR) через `/oauth/register` для
   Codex Desktop/native clients. `redirect_uri` совпадает буквально,
   `resource` обязателен, resource audience — `https://<site>/api/mcp`.
   Client secrets и implicit flow не поддерживаются.
4. Access token непрозрачный, живёт 15 минут и хранится только как SHA-256 hash.
   Refresh token живёт до 30 дней, ротируется при каждом использовании;
   повторное использование старого refresh token отзывает всю family и grant.
5. Scopes остаются `api:read` и `api:write`. MCP request всегда требует read;
   write tools дополнительно проверяют write scope и возвращают OAuth challenge
   при недостаточном scope. Scope не заменяет owner/ACL role.
6. Authorization requests, grants, codes, access/refresh tokens и lifecycle
   metadata сохраняются в D1. OAuth grants/tokens, как и personal tokens, не
   входят в logical backup; full restore отзывает все authentication
   capabilities.
7. CIMD загружается только с HTTPS origins из server allowlist; по умолчанию
   разрешён `https://chatgpt.com`. Redirects при загрузке metadata запрещены,
   размер документа ограничен. DCR принимает только public clients с
   `token_endpoint_auth_method=none`, authorization-code/refresh grants и
   разрешёнными HTTPS либо loopback redirect URI. Зарегистрированный client
   сам по себе не даёт доступа к данным: нужны user consent, grant и token.
8. Personal `tm_pat_` остаётся переходным способом для scripts, local smoke и
   REST clients. Он не является основным onboarding flow connector.
9. MCP exposes отдельные tools: workspace, list/get Projects, list/get
   Releases, list/filter/get Tasks, imported context, create/update Task,
   versioned create/update/delete Task relation.
   Collections compact и paginated; детали и большой archive загружаются
   только после выбора.
10. Распространение выполняется через общий Git repository `Srez Marketplace`.
    Сейчас в нём опубликован один Task Manager plugin: `.app.json`, `.mcp.json`,
    manifest, визуальные assets и skill; позднее тот же marketplace может
    содержать другие независимые plugins. Task Manager зарегистрирован как
    непубличный app connector; его `asdk_app_*` identifier хранится в
    `.app.json`, поэтому
    Codex Desktop показывает штатные Install/Authenticate/Reconnect controls,
    а пользователю не нужно вручную вводить имя или URL MCP server. `.mcp.json`
    сохраняет transport metadata и fallback для MCP-aware clients. Connector
    не публикуется в глобальном каталоге: discoverability даёт только явно
    добавленный Git marketplace. Product source и marketplace lifecycle не
    смешиваются, а добавление других plugins не меняет Task Manager contract.

## Последствия

- Пользователь Codex Desktop один раз добавляет `Srez Marketplace`, устанавливает
  Task Manager из Plugins, нажимает Authenticate, входит через ChatGPT,
  подтверждает scopes и сразу получает tools; ручные MCP/OAuth поля и secret
  не нужны.
- Текущий Task Manager app connector использует выбранный builder DCR через
  `/oauth/register`. CIMD остаётся поддерживаемым protocol path для совместимых
  MCP clients, но не используется этой connector instance после production
  ошибки проверки metadata document.
- `initialize`, `notifications/initialized`, `ping` и `tools/list` доступны без
  bearer token, чтобы новый app connector мог обнаружить schemas. Это не
  расширяет data plane: любой `tools/call` по-прежнему проходит OAuth, scopes и
  owner/ACL checks до repository query.
- OAuth subject сопоставляется тому же внутреннему User, что Sites UI, поэтому
  существующие ownership/grants начинают действовать без отдельного account
  linking.
- Свой authorization server минимизирует onboarding dependencies, но добавляет
  security-critical protocol surface. До публичного каталога нужно отдельно
  решить rate limits, audit/incident response, key/token operational controls
  и повторно оценить managed IdP: официальные рекомендации OpenAI предпочитают
  established identity provider для production OAuth.
- DCR закрывает текущий ChatGPT app onboarding и сохраняет native-client path.
  Он добавляет таблицу зарегистрированных clients и lifecycle cleanup, но не
  создаёт shared secret или новую пользовательскую identity. CIMD остаётся
  доступной альтернативой после отдельного исправления production verification.

## Отклонённые варианты

- Только personal token — технически работает, но ломает целевой one-click
  onboarding и переносит secret management на пользователя.
- Skill с прямыми REST вызовами без MCP — хуже обнаруживается, не даёт native
  Connect/OAuth lifecycle и связывает prompt с transport деталями.
- Отдельный Auth0/Clerk tenant в первом срезе — даёт зрелый OAuth слой, но
  добавляет второй user account/linking boundary и configuration burden для
  простого подключения друга.
- Доверять client-provided ChatGPT email/user ID — нарушает server identity
  boundary и позволяет подменить subject.
