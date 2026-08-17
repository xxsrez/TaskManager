# Эксплуатация нативных вложений

Решение и security boundary описаны в
[ADR-0011](../decisions/0011-native-attachments-and-r2.md).

## Bindings и конфигурация

- Logical R2 binding: `ATTACHMENTS`.
- Raster thumbnails используют обязательный Worker binding `IMAGES`; source
  остаётся в private R2 и не получает public URL.
- UAT и production используют разные private buckets. Bucket нельзя делать
  public, повторно использовать между Sites или копировать вместе с test data.
- `TASK_MANAGER_ATTACHMENT_SCOPE` различается по средам (`uat`, `production`);
  если переменная не задана, runtime выводит scope из canonical public origin.
- Безопасные defaults: 25 MiB/file, 50 active attachments/Task, 40M pixels,
  upload timeout 15 минут, delete grace 7 дней, failed retention 24 часа.
  Имена non-secret overrides перечислены в `.env.example`.

Binding создаётся/меняется через Sites storage provisioning; `.openai` binding
metadata не редактируется вручную. Любое provision/migration production требует
прямой production-команды пользователя.

## Release preflight и smoke

1. Проверить, что target hosting binding соответствует среде, `r2` равен
   `ATTACHMENTS`, Worker имеет `IMAGES`, а D1 содержит migrations `0014` и
   `0015`.
2. Через Task details и composer загрузить небольшой PDF и несколько PNG от
   Owner/Editor; проверить progress/retry, metadata, SHA-256, `ready`, thumbnail
   WebP и отсутствие filename в object key.
3. Viewer читает список, full download и Range. Outsider и revoked Viewer
   получают `404` без подтверждения существования Attachment.
4. Проверить `Content-Disposition`, `private, no-store`, `nosniff`; PDF не
   становится inline. HTML/SVG, MIME mismatch, oversized/corrupted image
   получают bounded `400` без R2 orphan.
5. Delete сохраняет object до grace; restore возвращает `ready`. Cleanup после
   cutoff удаляет object и metadata. В UAT используются только synthetic files.
6. Открыть ту же Task во второй сессии: `task_attachments` invalidation должна
   обновить только attachment list, не полный bootstrap и не текущий local
   upload progress.
7. После deploy повторно проверить access policy Site. R2 bucket policy не
   должна становиться public.

## Recovery

- `uploading` после `upload_expires_at` cleanup переводит в `failed` и удаляет
  object; повторный запуск безопасен.
- Ошибка удаления object оставляет metadata для следующего cleanup, а не
  удаляет DB row первой.
- Missing object для `ready` — integrity incident: route отвечает `404`, restore
  запрещён. Не создавайте replacement по старому key; повторите upload с новым
  idempotency key после расследования.
- До attachment-aware backup/restore system/project export и destructive
  restore fail-closed, если затронутые Tasks имеют native Attachment. Не
  обходите guard ручным D1 export: metadata и R2 bodies ещё не являются
  переносимым комплектом.
