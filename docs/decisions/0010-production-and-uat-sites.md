# ADR-0010: раздельные production и UAT Sites

Статус: `Accepted`

Дата решения: 2026-08-16

Этот ADR заменяет прежнюю operational трактовку единственного Site как UAT.
Решения ADR-0001 о ChatGPT Sites, D1, authentication и server-side
authorization сохраняются.

## Контекст

Первый рабочий Site одновременно служил живым приложением и средой проверки.
Такой режим делал обычный релиз задачи потенциальным production deployment и
смешивал реальные и тестовые данные. Пользователь объявил существующий Site
production, потребовал отдельный UAT и сохранил production endpoint для
Task Manager plugin.

## Решение

1. Site со slug `task-manager` является production. Любой push в его Sites
   source repository, save version или deploy выполняется только после прямой
   текущей команды пользователя, явно разрешающей production release.
2. Site со slug `task-manager-uat` является единственной обычной non-production
   средой. Он использует отдельный Sites project и отдельную D1; его records,
   identities, OAuth grants и deployment history не переносятся в production.
3. Default `.openai/hosting.json` указывает на UAT, чтобы стандартный build и
   package path был fail-safe. Production binding хранится отдельно в
   `.openai/hosting.production.json` и используется только явным production
   workflow.
4. Обычный запрос реализовать, исправить, доставить или проверить изменение
   заранее разрешает publish проверенного exact SHA в UAT, live smoke и
   необходимые тестовые mutations. Дополнительное подтверждение UAT deploy не
   требуется.
5. В UAT разрешены синтетические Projects, Releases, Tasks, Views и comments.
   Production data и secrets туда не копируются. Полный destructive reset
   остаётся отдельной операцией и не выводится из разрешения создавать test
   data.
6. Marketplace plugin, OAuth resource и MCP endpoint остаются направлены на
   production `https://task-manager.example.invalid/api/mcp`.
   UAT используется для web/API smoke напрямую и не становится endpoint
   установленного plugin.
7. Обе среды разворачивают одну codebase и одинаковые versioned migrations.
   Каждый релиз связывает validated commit, Site binding, archive, saved
   version, deployment и post-deploy evidence именно одной среды.
8. Access policy каждой среды меняется только отдельной явной командой.
   Обычный UAT-релиз сохраняет её текущую policy.

```text
Git exact SHA
├── routine delivery ──> task-manager-uat ──> UAT D1 / synthetic data
└── explicit approval ─> task-manager     ──> production D1 / real data

Task Manager plugin ───────────────────────> task-manager /api/mcp
```

## Последствия

- Обычная product delivery больше не может случайно обновить production через
  default hosting binding.
- UAT identities и project-scoped IDs отличаются от production; same-Site
  backup contracts не используются для promotion данных между средами.
- Production может отставать от `main` и UAT намеренно. Истиной production
  остаётся реально deployed saved version, а не последний Git commit.
- Проверка UAT обязана явно называть UAT URL и не считается доказательством
  production deployment.

## Отклонённые варианты

- Оставить один Site и считать каждый deploy безопасным UAT — нарушает новую
  production boundary.
- Переключить plugin на UAT — отправляет обычную работу и OAuth grants в
  тестовую среду.
- Копировать production D1 в UAT по умолчанию — увеличивает privacy и
  destructive-operation risk без необходимости для функционального smoke.
