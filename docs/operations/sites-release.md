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

## UAT workflow по умолчанию

1. Убедиться, что `.openai/hosting.json` содержит UAT `project_id`, а
   production binding не менялся.
2. Выполнить полный обязательный набор проверок репозитория.
3. Закоммитить и push exact validated SHA.
4. Упаковать UAT из этого SHA стандартным Sites packaging helper либо командой
   `scripts/package-site-environment.sh uat <absolute-archive-path>`.
5. Push exact SHA в source repository UAT Site, сохранить одну Sites version и
   deploy её без дополнительного approval.
6. Дождаться terminal success, проверить UAT URL, authenticated application
   smoke, migrations и отсутствие Worker errors.
7. Повторно прочитать access policy и убедиться, что она не изменилась.

UAT test data создаются только внутри UAT identity scope. Они могут покрывать
разные статусы, Projects, Releases, Views и comments, но не копируются из
production.

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

## Восстановление и ошибки

- Failed UAT deploy не разрешает переключать binding или plugin на production.
- Если результат source push, save или deploy неизвестен, сначала перечитать
  Site/version/deployment state; не создавать дубликат вслепую.
- UAT rollback использует предыдущую сохранённую UAT version. Production
  rollback также требует прямой команды пользователя, если это не уже явно
  разрешённое восстановление текущего production incident.
- Access policy, external users, secrets и полный D1 reset не меняются как
  побочный эффект обычного release.
