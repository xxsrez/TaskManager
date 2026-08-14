import { env } from "cloudflare:workers";

import { getD1 } from "@/db";
import { ensureDatabase } from "@/lib/repository";

export const dynamic = "force-dynamic";

const sourceUserId = "usr_d35655db-69d4-46a7-8f89-9552e2856a60";
const targetUserId = "usr_c805e9e2-f792-4c9a-b483-2e4ce3292bb6";
const expectedEmail = "owner@example.invalid";

type UserRow = { id: string; email: string };
type IdentityRow = {
  provider: string;
  provider_account_key: string;
  verified_email: string;
};
type RepairPreflight = {
  source_identity_count: number;
  source_status_count: number;
  source_task_refs: number;
  source_project_refs: number;
  source_release_refs: number;
  source_view_refs: number;
  source_label_refs: number;
  source_external_refs: number;
  source_grant_refs: number;
  source_relation_refs: number;
  target_task_count: number;
};

export async function POST(request: Request) {
  const expectedToken = (
    env as unknown as { TASK_MANAGER_IDENTITY_REPAIR_TOKEN?: string }
  ).TASK_MANAGER_IDENTITY_REPAIR_TOKEN;
  const suppliedToken = request.headers.get("x-task-manager-repair-token");
  if (!(await tokensEqual(suppliedToken, expectedToken))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await ensureDatabase();
    const db = getD1();
    const [sourceUser, targetUser, sourceIdentities, preflight] =
      await Promise.all([
        db
          .prepare("SELECT id, email FROM users WHERE id = ?")
          .bind(sourceUserId)
          .first<UserRow>(),
        db
          .prepare("SELECT id, email FROM users WHERE id = ?")
          .bind(targetUserId)
          .first<UserRow>(),
        db
          .prepare(
            `SELECT provider, provider_account_key, verified_email
             FROM user_identities WHERE user_id = ?`,
          )
          .bind(sourceUserId)
          .all<IdentityRow>(),
        db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM user_identities WHERE user_id = ?) AS source_identity_count,
              (SELECT COUNT(*) FROM workflow_statuses WHERE owner_user_id = ?) AS source_status_count,
              (SELECT COUNT(*) FROM tasks
                WHERE owner_user_id = ? OR creator_user_id = ? OR assignee_user_id = ?) AS source_task_refs,
              (SELECT COUNT(*) FROM projects
                WHERE owner_user_id = ? OR creator_user_id = ? OR lead_user_id = ?) AS source_project_refs,
              (SELECT COUNT(*) FROM releases
                WHERE owner_user_id = ? OR creator_user_id = ?) AS source_release_refs,
              (SELECT COUNT(*) FROM saved_views WHERE owner_user_id = ?) AS source_view_refs,
              (SELECT COUNT(*) FROM labels WHERE owner_user_id = ?) AS source_label_refs,
              (SELECT COUNT(*) FROM external_records WHERE owner_user_id = ?) AS source_external_refs,
              (SELECT COUNT(*) FROM access_grants
                WHERE owner_user_id = ? OR grantee_user_id = ? OR granted_by_user_id = ?) AS source_grant_refs,
              (SELECT COUNT(*) FROM task_relations WHERE creator_user_id = ?) AS source_relation_refs,
              (SELECT COUNT(*) FROM tasks WHERE owner_user_id = ?) AS target_task_count`,
          )
          .bind(
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            sourceUserId,
            targetUserId,
          )
          .first<RepairPreflight>(),
      ]);

    assertExpectedState(
      sourceUser,
      targetUser,
      sourceIdentities.results,
      preflight,
    );

    const identity = sourceIdentities.results[0];
    await db.batch([
      db
        .prepare(
          `UPDATE user_identities SET user_id = ?
           WHERE provider = ? AND provider_account_key = ? AND user_id = ?`,
        )
        .bind(
          targetUserId,
          identity.provider,
          identity.provider_account_key,
          sourceUserId,
        ),
      db
        .prepare("DELETE FROM workflow_statuses WHERE owner_user_id = ?")
        .bind(sourceUserId),
      db.prepare("DELETE FROM users WHERE id = ?").bind(sourceUserId),
    ]);

    const [sourceAfter, linkedIdentity, targetTaskCount] = await Promise.all([
      db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?")
        .bind(sourceUserId)
        .first<{ count: number }>(),
      db
        .prepare(
          `SELECT user_id FROM user_identities
           WHERE provider = ? AND provider_account_key = ?`,
        )
        .bind(identity.provider, identity.provider_account_key)
        .first<{ user_id: string }>(),
      db
        .prepare("SELECT COUNT(*) AS count FROM tasks WHERE owner_user_id = ?")
        .bind(targetUserId)
        .first<{ count: number }>(),
    ]);

    if (
      Number(sourceAfter?.count ?? 0) !== 0 ||
      linkedIdentity?.user_id !== targetUserId ||
      Number(targetTaskCount?.count ?? 0) !== 204
    ) {
      throw new Error("Identity repair verification failed");
    }

    await db.prepare("PRAGMA optimize").run();
    return Response.json({
      repaired: true,
      removedDuplicateUsers: 1,
      removedDuplicateStatuses: preflight?.source_status_count,
      ownerTaskCount: Number(targetTaskCount?.count ?? 0),
    });
  } catch (error) {
    console.error(error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Identity repair failed",
      },
      { status: 409 },
    );
  }
}

function assertExpectedState(
  sourceUser: UserRow | null,
  targetUser: UserRow | null,
  sourceIdentities: IdentityRow[],
  preflight: RepairPreflight | null,
) {
  if (
    !sourceUser ||
    !targetUser ||
    sourceUser.email.toLowerCase() !== expectedEmail ||
    targetUser.email.toLowerCase() !== expectedEmail ||
    sourceIdentities.length !== 1 ||
    sourceIdentities[0].provider !== "chatgpt" ||
    sourceIdentities[0].verified_email.toLowerCase() !== expectedEmail ||
    !preflight ||
    Number(preflight.source_identity_count) !== 1 ||
    Number(preflight.source_status_count) !== 5 ||
    Number(preflight.source_task_refs) !== 0 ||
    Number(preflight.source_project_refs) !== 0 ||
    Number(preflight.source_release_refs) !== 0 ||
    Number(preflight.source_view_refs) !== 0 ||
    Number(preflight.source_label_refs) !== 0 ||
    Number(preflight.source_external_refs) !== 0 ||
    Number(preflight.source_grant_refs) !== 0 ||
    Number(preflight.source_relation_refs) !== 0 ||
    Number(preflight.target_task_count) !== 204
  ) {
    throw new Error("Identity repair preflight did not match the expected state");
  }
}

async function tokensEqual(
  supplied: string | null,
  expected: string | undefined,
): Promise<boolean> {
  if (!supplied || !expected) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}
