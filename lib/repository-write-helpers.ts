export function moveBatchAssertion(
  db: D1Database,
  assertionId: string,
  step: string,
) {
  return db
    .prepare(
      `INSERT INTO task_identifier_aliases (id, task_id, identifier)
       SELECT ?, NULL, ? WHERE changes() = 0`,
    )
    .bind(assertionId, `move-assert-${step}`);
}

export function touchProjectSyncMarker(
  db: D1Database,
  projectId: string,
  touchedAt: string,
) {
  // Scope-changing child triggers carry only the child id, so the owner's
  // journal cannot reconstruct an old Project after the row changes scope. An
  // ordinary Project UPDATE publishes the existing Project event and gives
  // that exact route a marker. Deliberately do not bump version: a
  // composition-only marker must not invalidate compatible Project edit CAS.
  // MAX preserves a Project edit that committed with a later request time;
  // SQLite still runs the Project UPDATE trigger when the value stays equal.
  return db.prepare(
    `UPDATE projects SET updated_at = MAX(updated_at, ?)
     WHERE id = ? AND deleted_at IS NULL`,
  ).bind(touchedAt, projectId);
}

export function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint|unique|not null/i.test(error.message);
}
