# ADR-0015: production canary для file-first release gate

Статус: `Accepted`

Дата решения: 2026-08-21

Этот ADR заменяет operational acceptance path из
[ADR-0014](0014-private-uat-connector-edge-and-local-ingress.md). Разделение
production/UAT и production approval boundary из
[ADR-0010](0010-production-and-uat-sites.md), а также file-first domain contract
из [ADR-0013](0013-stored-file-and-task-attachment.md) сохраняются.

## Контекст

Local filesystem acceptance должна доказать один фактический runtime tuple:
установленный local companion читает разрешённый файл, загружает его через
Agent REST, связывает `fileRef` с Task, скачивает original и очищает результат.
Source/package tests этого не доказывают.

Owner-only UAT применяет Sites audience policy до application Worker. Пять
попыток построить автоматический machine ingress для такого UAT не дали
приемлемого контура: варианты требовали Sites bypass, ручного жизненного цикла
короткоживущего proxy либо создавали повторные Keychain/reconnect effects.
Public machine edge и hosted Codex также добавляли ненужную security boundary.

Обычный production Site уже является целевым runtime marketplace plugin.
Его application API остаётся OAuth-protected независимо от public Sites
audience. Пользователь отдельно разрешил production release и ограниченную
file-first mutation для текущего release 0.2.

## Решение

1. UAT остаётся обычной средой для build, browser/API checks и synthetic data.
   Его audience не меняется, а local machine ingress больше не является
   обязательной частью release gate.
2. Fresh-runtime local-path acceptance текущего file-first release выполняется
   после exact-SHA production deploy через обычный production plugin и его
   local companion.
3. Canary использует существующую Task, один маленький non-sensitive fixture и
   независимые stable upload/bind keys. Создавать synthetic production Project,
   Release или Task запрещено.
4. Обязательная цепочка:
   `local path → verified fileRef → attachmentRef → authenticated original →
   byte-size/SHA-256 equality → recoverable cleanup`.
5. Cleanup обязан оставить ноль active canary attachments и unbound files.
   Recoverable soft-delete/audit history не выдаётся за физическое отсутствие
   исторического следа.
6. Первый фактический local call может потребовать один browser DCR/PKCE consent.
   Client metadata, access и rotating refresh token остаются только в памяти
   companion process. Keychain, `/usr/bin/security`, persistent credential,
   daemon и background auth retries запрещены.
7. Production access policy, hosted secrets и OAuth policy не меняются в рамках
   canary. Local path, fixture bytes и credentials не входят в Task evidence,
   server metadata или logs.
8. Native OpenAI-file MCP smoke является отдельной transport row. Он требует
   message-supplied native file object; source/handler tests не подменяют live
   smoke, а отсутствие такого runtime input не аннулирует local-path result.
9. При code regression выполняется rollback на предыдущую сохранённую
   production version. Migration `0030` additive и backward-compatible;
   destructive schema rollback не выполняется.

```text
Ordinary validation ──> private UAT ──> browser/API/contracts

Explicit production release:
Codex on Mac ─stdio─> production local companion ─OAuth/Agent REST─> production
                     upload_local_file
                     attach_local_file_to_task
```

## Verification gate

- exact Git SHA совпадает с source push, Site version и deployment;
- полный repository gate и migration inspection проходят до production save;
- после deploy подтверждены terminal deployment status, production URL,
  OAuth boundary и неизменная Sites access policy;
- local companion inventory содержит оба local tools без startup network,
  browser или credential-store effects;
- canary metadata совпадает с заранее вычисленными byte size и SHA-256;
- original download byte-identical fixture, cleanup перечитан и active residue
  отсутствует;
- native-file row и любые unavailable checks записаны отдельно без подмены
  статуса `verified`.

## Последствия

- Release acceptance проверяет тот runtime, которым реально пользуется
  marketplace plugin, и больше не зависит от Sites bypass или UAT proxy.
- Production canary требует отдельной прямой команды для exact scope; обычная
  delivery по-прежнему не получает production authority автоматически.
- Fully unattended recurring production acceptance не заявляется. Для неё
  потребуется отдельный ADR о persistent least-privilege credential и его
  rotation/revocation; текущий release не создаёт такую capability.
- Private UAT остаётся полезным, но отсутствие безопасного machine ingress не
  блокирует release, если production authority дана и bounded canary проходит.

## Отклонённые варианты

- Возобновить Keychain-backed Sites bypass или автоматический local proxy —
  повторяет incident class с системными prompts и скрытым persistent state.
- Сделать UAT public либо развернуть public machine edge — расширяет perimeter
  ради одной release-проверки.
- Считать source/package tests runtime acceptance — не проверяет production
  OAuth, packaged companion, durable R2/D1 binding и cleanup вместе.
- Создать постоянный production test Project/Task — загрязняет реальные данные
  и расширяет canary blast radius без необходимости.
