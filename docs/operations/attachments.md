# Эксплуатация нативных вложений

Решение и security boundary описаны в
[ADR-0011](../decisions/0011-native-attachments-and-r2.md).
File-first lifecycle принят в
[ADR-0013](../decisions/0013-stored-file-and-task-attachment.md).

## Bindings и конфигурация

- Logical R2 binding: `ATTACHMENTS`.
- Raster thumbnails используют обязательный Worker binding `IMAGES`; source
  остаётся в private R2 и не получает public URL.
- UAT и production используют разные private buckets. Bucket нельзя делать
  public, повторно использовать между Sites или копировать вместе с test data.
- `TASK_MANAGER_ATTACHMENT_SCOPE` различается по средам (`uat`, `production`);
  если переменная не задана, runtime выводит scope из canonical public origin.
- Безопасные defaults: 25 MiB/file, 50 active attachments/Task, 40M pixels,
  2 GiB/current owner, 1 GiB/Project, upload timeout 15 минут, delete grace
  7 дней, failed retention 24 часа; unbound StoredFile — 20 staged files,
  250 MiB и ready TTL 24 часа.
  Имена non-secret overrides перечислены в `.env.example`.

Binding создаётся/меняется через Sites storage provisioning; `.openai` binding
metadata не редактируется вручную. Любое provision/migration production требует
прямой production-команды пользователя.

## Release preflight и smoke

1. Проверить, что target hosting binding соответствует среде, `r2` равен
   `ATTACHMENTS`, Worker имеет `IMAGES`, а D1 содержит migrations `0014` и
   `0015` для native storage/sync, `0029` для `comment_attachment_refs` и
   `0030` для StoredFile foundation/backfill.
2. Через Task details и composer загрузить небольшой PDF и несколько PNG от
   Owner/Editor; проверить progress/retry, metadata, SHA-256, `ready`, thumbnail
   WebP и отсутствие filename в object key.
3. Viewer читает список, full download и Range. Outsider и revoked Viewer
   получают `404` без подтверждения существования Attachment.
4. Проверить `Content-Disposition`, `private, no-store`, `nosniff`; PDF не
   становится inline. HTML/SVG, MIME mismatch, oversized/corrupted image
   получают bounded `400` без R2 orphan.
5. Вставить PDF как `[label](attachment:v1:<public-ref>)` в середину Task
   description: Viewer после reload видит compact link и скачивает byte-identical
   original. Image embed остаётся preview; literal refs в inline/fenced code не
   валидируются как edges. Referenced file/image delete отклоняется.
   Для raster проверить `{width=480}` в description и Comment после reload,
   затем Reset to `Auto`: suffix исчезает, binary/Attachment record не меняются.
6. Delete сохраняет object до grace; restore возвращает `ready`. Cleanup после
   cutoff удаляет object и metadata. В UAT используются только synthetic files.
7. Открыть ту же Task во второй сессии: `task_attachments` invalidation должна
   обновить только attachment list, не полный bootstrap и не текущий local
   upload progress.
8. После deploy повторно проверить access policy Site. R2 bucket policy не
   должна становиться public.
9. Через UAT personal bearer credential сначала вызвать `POST /files`, сверить
   verified metadata/SHA-256, создать Task и выполнить JSON bind через
   `/tasks/{ref}/attachments`. Затем проверить compatibility raw upload, list с
   двумя страницами, original Range, thumbnail и versioned delete/restore.
   В JSON не должно быть internal IDs/object key; после bind `GET /files/{ref}`
   и после ACL revoke Task metadata должны немедленно вернуть одинаковый `404`.
10. `tools/list` должен объявлять `upload_file`, `get_file`, `delete_file`,
   `attach_file_to_task`, `list_task_attachments`, `get_task_attachment`,
   `download_task_attachment`, `upload_task_attachment` и `delete_task_attachment`,
   `api:read`/`api:write` security schemes и
   `_meta["openai/fileParams"]=["file"]` для обоих upload tools. Полный MCP upload smoke
   выполнять только клиентом, который передаёт нативный OpenAI file object;
   base64, local path и произвольный URL не являются fallback transport.
11. Через Agent REST и fresh MCP client загрузить небольшой PNG и PDF, получить
    opaque refs и создать root Comment с image token и reply с file link.
    Read-back обязан вернуть только body + `attachmentRefs`; edit заменяет ref,
    затем удаляет token без удаления gallery Attachment. Отдельный
    `download_task_attachment` возвращает bearer-protected `resource_link`, не
    base64. Во второй открытой сессии должны обновиться mounted comments,
    Activity и только необходимая attachment metadata, а local draft/upload
    progress остаются неизменными.
12. Повторить negative cases: Viewer/read-only token, revoke, guessed и
    cross-Task ref, malformed token, stale Comment version и oversized upload.
    Guessed/foreign/deleted refs должны выглядеть одинаково и не раскрывать
    filename, object key или сам факт существования.

Fresh-chat production smoke обычного marketplace plugin направлен в production
и выполняется только после отдельно разрешённого production Site/plugin
release. До него file-first connector gate выполняется отдельным
`task-manager-uat@srez-marketplace`. Он должен объявлять два независимых
servers: hosted remote MCP с полным deployed inventory и local stdio с одним
`upload_local_file`. Local startup/initialize/list не открывает browser, не
делает network I/O и не обращается к Keychain; Task Manager DCR/PKCE начинается
только при фактическом upload и хранит credentials в памяти процесса.

Owner-only UAT Sites gate применяется до Worker. Поэтому матрицу нельзя
запускать, пока отдельно разрешённый machine-only connector edge не опубликован
и fresh runtime не подтвердил общий connector origin для hosted MCP и local
upload. Edge должен иметь exact route/upstream allowlist, bounded body/timeout,
не публиковать UI и сохранять обычные Task Manager OAuth/scopes/ACL после
внешнего gate. Sites bypass запрещено переносить на Mac, в plugin config,
command line или Task evidence. До edge результат строки UAT connector —
`blocked`, а не `verified`; production не используется как fallback.

### Machine-only UAT connector edge

Edge — отдельный standalone Cloudflare Worker без D1/R2/assets, а не второй
ChatGPT Site. Не редактируйте текущий `.openai/hosting.json`: он принадлежит
обычному owner-only UAT Site. Source entry и обязательный RateLimit binding
описаны в `wrangler.connector-edge.jsonc`; source build выполняется вместе с
обычным `npm run build`, но public deploy остаётся отдельным явным действием.

Полный hosted набор edge:

- `TASK_MANAGER_CONNECTOR_EDGE_UPSTREAM_ORIGIN` = exact private UAT origin;
- `TASK_MANAGER_CONNECTOR_EDGE_PUBLIC_ORIGIN` = exact connector edge origin;
- `TASK_MANAGER_CONNECTOR_EDGE_SITES_BYPASS_TOKEN` = hosted secret, никогда не
  local env, command argument, plugin config или Task evidence;
- `TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER` = provisioned Cloudflare
  `RateLimit` binding.

Config намеренно не содержит public origin и hosted secret, поэтому случайный
deploy отвечает `503`. После отдельно разрешённого provisioning сначала
зафиксировать точный Worker origin как non-secret var, затем передать bypass
только через provider secret store. Не помещать secret в `wrangler` config,
shell argument, output или evidence.

Private UAT одновременно получает `TASK_MANAGER_PUBLIC_ORIGIN` с тем же edge
origin. Сначала проверить anonymous discovery: edge обязан вернуть metadata с
edge issuer/resource; mismatch даёт `502`, а не переписанный JSON. Затем
проверить, что `/`, `/workspace`, `/_vinext/image` и неизвестные paths дают
`404`; direct UAT UI остаётся owner-only. `GET /oauth/authorize` должен одним
redirect перевести owner browser на private UAT, где consent использует обычную
Sites identity. DCR/token/MCP/file routes не передают client Cookie/Origin/
Referer и не возвращают upstream `Set-Cookie`.

Source tests проверяют disabled default, partial-config `503`, production/
foreign-upstream rejection, exact route/method/origin allowlist, rate-limit
fail-closed, bounded bodies/responses, manual redirect policy, metadata-origin
consistency и отсутствие secret в client response. Они не заменяют provisioning,
hosted secret, access-policy read-back или fresh connector E2E.

## Recovery

- `uploading` после `upload_expires_at` cleanup переводит в `failed` и удаляет
  object; повторный запуск безопасен.
- Unbound `ready` после `ready_expires_at` переходит в `expired`, object
  удаляется, а retained metadata очищается следующим bounded pass. Bound file
  исключён из staged cleanup даже если старый expiry остался после interruption.
- Ошибка удаления object оставляет metadata для следующего cleanup, а не
  удаляет DB row первой.
- Missing object для `ready` — integrity incident: route отвечает `404`, restore
  запрещён. Не создавайте replacement по старому key; повторите upload с новым
  idempotency key после расследования.
- System backup schema `3` впервые добавила общий 10 MB bounded JSON container,
  Project schema `3` — 25 MB. Каждый original представлен один раз по
  `sha256:<digest>` внутри package; row не раскрывает live object key. Schema
  `2` импортируется только как legacy no-attachment state. Current schema `13`
  дополнительно переносит writable relations, comments/activity, attachment
  migration outcomes и exact `comment_attachment_refs`; schema `2`–`12`
  импортируется с пустым comment ref index. Это не меняет R2 object contract.
- Validate проверяет package checksum, object size/SHA-256, Attachment↔Task и
  description/comment body↔index refs до staging. Restore пишет
  `backup-staging`, копирует в новые
  environment-scoped keys, выполняет D1 cutover и затем удаляет прежние/staged
  objects. До commit failure удаляет новые keys; после commit cleanup failure
  считается orphan incident и обнаруживается reconciliation.
- `POST /api/admin/attachments/reconcile` с action header
  `attachment-reconciliation` — read-only admin report. Default не читает body;
  `verifyChecksums=true` boundedly читает objects для digest. Report содержит
  только counts, opaque refs и owner/Project usage. Scan отдельно сопоставляет
  live object namespace с Attachment rows, а `backup-staging` — с активными
  system/Project import descriptors; поэтому брошенный staging object тоже
  считается orphan. При превышении bounded scan limit orphan count становится
  unknown, а report помечается `truncated`, чтобы не выдавать partial scan за
  точный. Purge/repair остаются
  отдельными explicit actions; production deletion требует отдельной команды.
- Reconciliation отдельно перечисляет body/index mismatch, missing object и
  missing/cross-Task/deleted/incompatible Comment ref только по opaque refs.
  Cleanup/purge не удаляет binary, пока live description либо Comment edge
  продолжает на него ссылаться.
- Не пытайтесь обходить package limit ручным D1 export. State больше лимита
  требует новой chunked/streaming schema; unbounded base64 запрещён.
