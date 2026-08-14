# ADR-0003: стек первой реализации и поставка authentication

Статус: `Accepted`

Дата решения: 2026-08-14

## Контекст

После documentation-first стадии пользователь поручил начать реализацию и
довести Task Manager до рабочего deployment на ChatGPT Sites. До кода требовалось
выбрать Sites-compatible framework, D1 access/migrations, API style и реальный
authentication path.

Актуальный Sites starter и hosting workflow поддерживают React 19, TypeScript,
Vinext/Vite, Cloudflare Worker-compatible output, D1 bindings, Drizzle
migrations и dispatch-owned `Sign in with ChatGPT`. Официальная документация
Sites называет external identity provider вариантом authentication-enabled
Site, но доступный starter и runtime contract не предоставляют проверенного
Google OAuth/OIDC adapter или callback API. Придумывать app-owned auth поверх
неподтверждённого contract небезопасно.

## Решение

1. Первая реализация использует TypeScript, React 19 и Vinext App Router из
   официального Sites starter, сборка выполняется Vite в Cloudflare
   Worker-compatible ESM.
2. Structured data хранится в Sites D1 через logical binding `DB`.
   `db/schema.ts` является schema source, Drizzle Kit генерирует versioned SQL
   migrations. Runtime queries используют prepared D1 statements за узким
   repository boundary.
3. UI обращается к server route handlers по JSON HTTP API. Domain validation,
   ownership/ACL scope, timestamps и version conflicts проверяются сервером.
4. Первая рабочая hosted версия использует dispatch-owned Sign in with ChatGPT
   и trusted Sites identity headers. Локальная development identity разрешена
   только при `NODE_ENV=development` и не является production fallback.
5. Google sign-in остаётся принятым обязательным требованием ADR-0001, но не
   объявляется реализованным до появления и проверки Sites-compatible external
   provider contract. Нельзя показывать неработающую Google button или доверять
   client-supplied Google claims.
6. Session lifetime и sign-out принадлежат Sites dispatch. Task Manager не
   хранит собственные passwords или provider tokens.
7. Для первой версии достаточно refresh/version-conflict model; realtime
   collaboration откладывается согласно MVP.

## Последствия

- Сайт можно развернуть с реальными изолированными пользовательскими records и
  Sign in with ChatGPT без внешних secrets.
- Database schema и migrations входят в тот же Git commit, что использующий их
  код.
- Google auth — явно видимый delivery gap, а не скрытое отклонение. Для его
  реализации потребуется подтверждённая platform capability либо новый ADR,
  если пользователь разрешит app-owned alternative.
- Vinext находится в beta-линейке вместе с Sites; точные версии зависимостей
  фиксируются lockfile.

## Отклонённые варианты

- Browser storage для Tasks — не даёт durable, multi-device и user-scoped data.
- Отдельный внешний hosting/database — противоречит ADR-0001.
- Client-only Google OAuth и доверие email из browser — нарушает server identity
  boundary.
- GraphQL для первого среза — добавляет слой без подтверждённой пользы для
  компактного modular monolith.

## Источники

- [Sites — официальная документация ChatGPT](https://learn.chatgpt.com/docs/sites)
- Bundled Sites `sites-building` starter и authentication/storage references,
  версия plugin `0.1.34`, проверены 2026-08-14.
