# Релизы Task Manager в Sites

Документ задаёт operational workflow двух изолированных Sites. Архитектурное
решение принято в [ADR-0010](../decisions/0010-production-and-uat-sites.md).

## Карта сред

| Среда | Sites slug | Binding | Данные | Разрешение |
|---|---|---|---|---|
| UAT | `task-manager-uat` | `.openai/hosting.json` | синтетические и тестовые | обычная delivery-команда |
| Production | `task-manager` | `.openai/hosting.production.json` | реальные | только прямая production-команда пользователя |

Marketplace plugin всегда использует production endpoint
`https://task-manager.example.invalid/api/mcp`.
Обычный lifecycle одной явно указанной Task через этот plugin (status и native
report comment) не является Sites release и не требует production-deploy
approval. Он не разрешает менять другие production records или создавать там
synthetic test data.

## UAT workflow по умолчанию

1. Убедиться, что `.openai/hosting.json` содержит UAT `project_id`, а
   production binding не менялся.
2. Выполнить обязательный набор проверок из `AGENTS.md` и точечные acceptance
   tests изменённого поведения. Backup/restore tests без отдельной прямой
   команды не запускать.
3. Закоммитить и push exact validated SHA.
4. Упаковать UAT из этого SHA стандартным Sites packaging helper либо командой
   `scripts/package-site-environment.sh uat <absolute-archive-path>`.
5. Push exact SHA в source repository UAT Site, сохранить одну Sites version и
   deploy её без дополнительного approval.
6. Дождаться terminal success, проверить UAT URL, authenticated application
   smoke, migrations и отсутствие Worker errors.
   Для release с native attachments дополнительно выполнить
   [R2 smoke](attachments.md#release-preflight-и-smoke).
7. Повторно прочитать access policy и убедиться, что она не изменилась.

UAT test data создаются только внутри UAT identity scope. Они могут покрывать
разные статусы, Projects, Releases, Views и comments, но не копируются из
production.

### Проверка полного backup в UAT

Этот сценарий не является частью обычного release guardrail или acceptance и
не запускается автоматически даже для изменения backup-кода. Выполняйте его
только по отдельной прямой команде пользователя.

После такого разрешения для изменения system backup создайте в UAT минимум двух
Users и данные во всех exact-классах registry, включая unbound/bound
`StoredFile`, Attachment original, ACL, SavedView, provenance и sequence state.
Export обязан зафиксировать counts, per-chunk и общий digest; import принимается
только для schema `15` и того же Site/environment. Перед destructive apply
сохраните отдельный rollback backup.

D1-состояние фиксируется одним D1 batch в начале export job. Обычные записи после
завершения этого batch не входят в уже начатый snapshot и не должны прерывать
его; целостность проверяется по immutable frozen rows. R2 inventory и bytes дополнительно
перепроверяются перед готовностью package, поэтому изменение или исчезновение
файла во время упаковки по-прежнему отклоняет export.

После replace сравните registry-driven D1 counts/digests и R2 manifest/bytes,
перестроенный `task_label_group_values`, сброшенный sync/purge state и отсутствие
старых API/OAuth capabilities. Отдельно проверьте отказ schema `2`–`14`,
повреждённого chunk/object и неизвестного R2 namespace без изменения live state.
Эта процедура разрешена только для UAT synthetic data. Production export,
import, restore и любые backup acceptance tests требуют отдельной прямой
команды пользователя.

## Production workflow

Production workflow начинается только с прямой текущей команды пользователя,
которая явно разрешает production release и называет scope. До неё запрещены
push в production Sites source repository, save version и deploy.

После разрешения выполняется тот же exact-SHA proof, но архив создаётся через:

```bash
scripts/package-site-environment.sh production \
  <absolute-archive-path> --production-approved
```

Флаг является локальным guardrail, а не заменой пользовательского разрешения.
После deploy обязательны terminal status, production smoke, проверка access
policy и подтверждение, что plugin endpoint продолжает отвечать с этого Site.

Для file-first release дополнительно выполнить bounded canary из
[ADR-0015](../decisions/0015-production-file-first-release-canary.md): exact
production plugin/local companion, один маленький non-sensitive файл и
существующая Task; `upload_local_file → fileRef →
attach_local_file_to_task → attachmentRef → original download` с проверкой
byte size/SHA-256 и recoverable cleanup. Не создавать synthetic production
Project/Release/Task, не менять access policy и не использовать Keychain,
Sites bypass или persistent credential. Native OpenAI-file MCP smoke фиксируется
отдельной строкой и не подменяет local-path canary.

## Восстановление и ошибки

- Failed UAT deploy не разрешает переключать binding или plugin на production.
- Если результат source push, save или deploy неизвестен, сначала перечитать
  Site/version/deployment state; не создавать дубликат вслепую.
- UAT rollback использует предыдущую сохранённую UAT version. Production
  rollback также требует прямой команды пользователя, если это не уже явно
  разрешённое восстановление текущего production incident.
- Access policy, external users, secrets и полный D1 reset не меняются как
  побочный эффект обычного release.
