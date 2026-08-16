# AGENTS.md

Эти инструкции действуют для всего репозитория.

## Состояние проекта

Проект имеет первый рабочий вертикальный срез на React/Vinext, Sites Worker и
D1. Реализованы ChatGPT identity boundary, owner/ACL-scoped repository,
задачи, проекты, релизы, views, sharing, list/board, details и native task
comments; точное состояние
подтверждайте кодом и проверками. Google sign-in, labels UI, hierarchy,
relations, настройка workflow и полный filter contract пока не реализованы.
Не описывайте весь MVP как завершённый.
Application-level admin overview реализован отдельно от resource permissions:
он показывает регистрации, activity timestamps и агрегаты owned records, но не
даёт администратору читать содержимое чужих Tasks/Projects/Views.

## Источники истины

Перед изменением продукта прочитайте документы в следующем порядке:

1. актуальный запрос пользователя;
2. `docs/specs/mvp.md` — границы и проверяемое поведение MVP;
3. `docs/specs/interface.md` — UI composition, controls, interactions и
   визуальная приёмка;
4. `docs/reference/domain-model.md` — сущности, поля и инварианты;
5. `docs/decisions/0001-identity-sharing-and-sites-hosting.md` — принятые
   решения об identity, authorization, sharing и hosting;
6. `docs/decisions/0002-linear-interface-parity.md` — принятое направление
   сходства с Linear и его границы;
7. `docs/decisions/0003-implementation-stack-and-auth-delivery.md` — выбранный
   Sites runtime, D1/migrations и текущая граница Google auth;
8. `docs/architecture.md` — логические границы и открытые технические решения;
9. `docs/reports/2026-08-13-linear-product-study.md` — исследовательский
   контекст, но не самостоятельная спецификация продукта.

При противоречии остановитесь, явно опишите его и обновите канонический
документ вместе с кодом. Не сглаживайте расхождения догадками.

## Границы продукта

- Основные сущности: `User`, `Task`, `Project`, `Release`, `SavedView`.
- Вспомогательные сущности: `UserIdentity`, `AccessGrant`, `WorkflowStatus`,
  `Label`, `TaskRelation`, `Comment`, `CommentReaction`.
- Основные поверхности: список задач, Kanban-доска, карточка задачи, список и
  карточка проекта, управление релизами, сохранённые представления, вход и
  `Shared with me`; отдельная server-gated поверхность — `Administration`.
- Для функций в scope повторяйте актуальные Linear patterns по composition,
  controls, keyboard, selection, menus, drag-and-drop, density и visual states,
  как определено в `docs/specs/interface.md`.
- Целевая среда: authentication-enabled ChatGPT Site с durable structured data;
  не добавляйте альтернативный production hosting без нового принятого ADR.
- Не добавляйте teams, initiatives, cycles/sprints, roadmap/timeline,
  документы, inbox/triage, уведомления, mentions, comment attachments,
  product analytics сверх принятого admin overview, AI-функции или
  CI/CD-интеграции без явного расширения спецификации.

## Обязательные доменные инварианты

- Каждая задача имеет неизменяемый человекочитаемый идентификатор, заголовок и
  статус; остальные пользовательские поля опциональны.
- Каждый Project имеет ровно одного current owner. Project роли — `owner`,
  `manager`, `editor`, `viewer`; higher role включает полномочия lower role.
  Owner implicit, остальные роли хранятся в действующем `AccessGrant`.
- Ресурс приватен по умолчанию. Project grant распространяется на его tasks,
  releases и SavedViews с явным `scope_project_id`; для этих child records
  access определяется только через current Project owner/grant, а их
  исторический `owner_user_id` не даёт implicit access.
- Owner может назначать вплоть до manager и атомарно передать ownership уже
  добавленному участнику; прежний owner становится manager. Manager управляет
  только editor/viewer. Standalone Task и global SavedView поддерживают только
  editor/viewer. Release отдельно не шарится.
- Project-scoped SavedView жёстко ограничен своим Project. Global SavedView без
  `scope_project_id` выполняется над ACL-пересечением всех доступных данных и не
  становится project-scoped из-за обычного filter по Project.
- Задача относится максимум к одному проекту и одному релизу.
- Релиз всегда принадлежит проекту; релиз задачи обязан принадлежать тому же
  проекту, что и задача.
- `completed_at` и `canceled_at` следуют категории статуса и меняются на
  сервере атомарно со статусом.
- Viewer не может выполнять mutation; Editor может изменять content и
  архивировать/восстанавливать; необратимый purge требует owner и отдельного
  подтверждения.
- Иерархия parent/subtask не может содержать циклы. Задача не может иметь
  отношение сама с собой.
- Представление хранит запрос и параметры отображения, но не владеет задачами и
  не копирует их.
- Перетаскивание между группами меняет соответствующее поле задачи только
  после серверной валидации тех же инвариантов.

## Правила работы

- Не переоткрывайте решения ADR-0001 без нового запроса пользователя. Выбор
  framework, Google OAuth/OIDC boundary и migrations зафиксирован в ADR-0003;
  не переоткрывайте его без нового запроса.
- Не переоткрывайте ADR-0002 и не заменяйте Linear-like controls произвольным
  UI без нового запроса. Перед реализацией крупной surface повторно сверяйте
  датированные официальные Linear references и фиксируйте отклонения.
- Не копируйте Linear logo, trademark, фирменные тексты, illustrations,
  закрытые assets или исходный код. Не показывайте controls функций вне MVP.
- Один и тот же property control должен сохранять semantics и interaction
  model в list, board, details, composer, filters и bulk actions.
- Доверяйте identity только на серверной границе: ChatGPT Sites authentication
  headers и проверенный Google provider response нельзя заменять client claims.
- Каждый repository query, lookup и mutation должен применять ownership/ACL
  scope до загрузки или изменения пользовательских данных.
- Развивайте продукт вертикальными срезами из `docs/specs/mvp.md`; не создавайте
  широкую инфраструктуру для возможностей вне текущего среза.
- Любое изменение схемы данных сопровождайте миграцией, проверкой обратной
  совместимости и обновлением доменной модели.
- Бизнес-правила должны проверяться на серверной границе независимо от
  клиентской валидации.
- Для исправления дефекта сначала добавляйте воспроизводящий тест. Для новой
  функции покрывайте основной сценарий, отказ по инварианту и изменение данных.
- Не коммитьте секреты, токены, локальные базы данных и `.env`-файлы.
- Не создавайте `.openai/hosting.json` вручную до provisioning Sites и не
  помещайте в него secrets; hosted secrets задаются через Sites settings.

### UAT-релиз и подтверждение

- Текущий UAT Task Manager — существующий ChatGPT Site из
  `.openai/hosting.json`, а не отдельная среда и не будущий production.
- Явный запрос пользователя реализовать, исправить, доставить или «сделать
  остальные» задачи включает обычный релиз результата в этот UAT. Это заранее
  данное явное разрешение на сохранение и публикацию проверенной Sites-версии;
  не запрашивайте повторное подтверждение перед deploy, в том числе если
  текущая политика доступа Site имеет режим `public`.
- Такой релиз не разрешает создавать новый Site, менять access policy,
  добавлять внешних пользователей или публиковать в отдельный production. Для
  этих действий требуется отдельный явный запрос пользователя.
- Перед UAT-релизом по-прежнему проверьте точный SHA, обязательные проверки и
  соответствие собранного архива этому SHA; после релиза дождитесь успешного
  статуса, выполните live smoke и повторно убедитесь, что access policy не
  изменилась.
- Если пользователь явно ограничил работу анализом, локальными изменениями или
  сохранённой версией без deploy, это ограничение имеет приоритет и релиз не
  выполняется.

- Сохраняйте `README.md` кратким, а `docs/README.md` — полным индексом. Новый
  документ должен быть достижим из индекса.
- Документацию ведите по-русски, если пользователь не попросил иначе;
  идентификаторы кода, API и схемы именуйте по-английски.
- В смешанном worktree добавляйте в Git только точные пути текущей задачи и не
  перезаписывайте посторонние изменения.

## Проверка

Обязательный минимум перед коммитом:

```bash
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
ruby /Users/andrey/.codex/skills/project-docs/scripts/validate_docs.rb . \
  --strict-navigation
```

При изменении `db/schema.ts` также запустите `npm run db:generate` и проверьте
сгенерированную SQL migration. Не заявляйте о проверке, которую не запускали.
