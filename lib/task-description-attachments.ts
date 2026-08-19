import { getD1 } from "@/db";
import { ValidationError } from "./domain";
import {
  hasMalformedTaskAttachmentReference,
  parseTaskAttachmentReferences,
} from "./task-description-format";

type DescriptionAttachmentRequirement = {
  ref: string;
  imageRequired: boolean;
};

export async function validateTaskDescriptionAttachments(
  taskId: string | null,
  description: string,
) {
  if (hasMalformedTaskAttachmentReference(description)) {
    throw new ValidationError("Native attachment reference is malformed");
  }
  const requirements = descriptionAttachmentRequirements(description);
  if (requirements.length === 0) return requirements;
  if (!taskId) {
    throw new ValidationError("Create the Task before referencing native attachments");
  }
  const placeholders = requirements.map(() => "?").join(", ");
  const rows = await getD1()
    .prepare(
      `SELECT public_id, kind FROM attachments
       WHERE task_id = ? AND public_id IN (${placeholders})
         AND state = 'ready'`,
    )
    .bind(taskId, ...requirements.map((requirement) => requirement.ref))
    .all<{ public_id: string; kind: string }>();
  const attachments = new Map(rows.results.map((row) => [row.public_id, row]));
  if (requirements.some((requirement) => {
    const attachment = attachments.get(requirement.ref);
    return !attachment || (requirement.imageRequired && attachment.kind !== "image");
  })) {
    throw new ValidationError(
      "Every native reference must be a compatible ready attachment of this Task",
    );
  }
  return requirements;
}

export function taskDescriptionAttachmentPredicate(
  requirements: DescriptionAttachmentRequirement[],
) {
  if (requirements.length === 0) return { sql: "", bindings: [] as Array<string | number> };
  return {
    sql: requirements.map(() => `
      AND EXISTS (
        SELECT 1 FROM attachments description_attachment
        WHERE description_attachment.task_id = tasks.id
          AND description_attachment.public_id = ?
          AND (? = 0 OR description_attachment.kind = 'image')
          AND description_attachment.state = 'ready'
      )`).join(""),
    bindings: requirements.flatMap((requirement) => [
      requirement.ref,
      requirement.imageRequired ? 1 : 0,
    ]),
  };
}

function descriptionAttachmentRequirements(description: string) {
  const byRef = new Map<string, DescriptionAttachmentRequirement>();
  for (const reference of parseTaskAttachmentReferences(description)) {
    const current = byRef.get(reference.ref);
    byRef.set(reference.ref, {
      ref: reference.ref,
      imageRequired: current?.imageRequired === true || reference.kind === "image",
    });
  }
  return [...byRef.values()];
}
