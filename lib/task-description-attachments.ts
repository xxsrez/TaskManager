import { getD1 } from "@/db";
import { ValidationError } from "./domain";
import {
  hasMalformedTaskImageReference,
  parseTaskImageReferences,
} from "./task-description-format";

export async function validateTaskDescriptionAttachments(
  taskId: string | null,
  description: string,
) {
  if (hasMalformedTaskImageReference(description)) {
    throw new ValidationError("Native image reference is malformed");
  }
  const references = parseTaskImageReferences(description);
  const refs = [...new Set(references.map((reference) => reference.ref))];
  if (refs.length === 0) return refs;
  if (!taskId) {
    throw new ValidationError("Create the Task before embedding native images");
  }
  const placeholders = refs.map(() => "?").join(", ");
  const rows = await getD1()
    .prepare(
      `SELECT public_id FROM attachments
       WHERE task_id = ? AND public_id IN (${placeholders})
         AND kind = 'image' AND state = 'ready'`,
    )
    .bind(taskId, ...refs)
    .all<{ public_id: string }>();
  if (rows.results.length !== refs.length) {
    throw new ValidationError(
      "Every native image must be a ready attachment of this Task",
    );
  }
  return refs;
}

export function taskDescriptionAttachmentPredicate(refs: string[]) {
  if (refs.length === 0) return { sql: "", bindings: [] as string[] };
  return {
    sql: refs.map(() => `
      AND EXISTS (
        SELECT 1 FROM attachments description_attachment
        WHERE description_attachment.task_id = tasks.id
          AND description_attachment.public_id = ?
          AND description_attachment.kind = 'image'
          AND description_attachment.state = 'ready'
      )`).join(""),
    bindings: refs,
  };
}
