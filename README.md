# Task Manager

Task Manager — компактная система управления работой, вдохновлённая Linear.
Продукт сосредоточен на задачах, проектах, релизах, сохранённых представлениях
и Kanban-досках без организационной сложности полноценного трекера. Данные
каждого пользователя изолированы, а выбранные ресурсы можно открыть другому
пользователю с ролью Viewer или Editor; для проектов также доступны Manager и
передача ownership. Интерфейс функций в scope проектируется
функционально и стилистически максимально близко к Linear, но с собственным
брендингом.

В репозитории уже есть первый рабочий вертикальный срез для ChatGPT Sites:
React/Vinext UI, server routes, D1 schema и migrations, вход через ChatGPT,
изолированные owner scopes и ролевой sharing (`owner`, `manager`, `editor`,
`viewer`). Google sign-in остаётся
обязательным, но ещё не реализован: доступный Sites contract пока не даёт
подтверждённого external-provider adapter.

## Локальный запуск

```bash
npm install
npm run dev
```

Основные проверки: `npm run typecheck`, `npm run lint`, `npm test` и
`npm run build`.

## Документация

- [Обзор документации](docs/README.md)
- [Границы и цели продукта](docs/overview.md)
- [Спецификация MVP](docs/specs/mvp.md)
- [Спецификация интерфейса](docs/specs/interface.md)
- [Доменная модель](docs/reference/domain-model.md)
- [Начальная архитектура](docs/architecture.md)
- [Решение об identity, sharing и Sites](docs/decisions/0001-identity-sharing-and-sites-hosting.md)
- [Решение об интерфейсном паритете с Linear](docs/decisions/0002-linear-interface-parity.md)
- [Решение о Project backup](docs/decisions/0007-project-backup.md)
- [Решение о стеке и authentication delivery](docs/decisions/0003-implementation-stack-and-auth-delivery.md)
- [Исследование Linear](docs/reports/2026-08-13-linear-product-study.md)
