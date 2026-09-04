import type { Actor } from "./auth";
import { ConflictError, NotFoundError, ValidationError } from "./domain";
import { mapUser, mapUserIdentity, type DbRow } from "./repository-mappers";
import type {
  SidebarPreference,
  StatusCategory,
  ThemePreference,
  UserProfile,
  UserRecord,
} from "./types";
import { getD1 } from "@/db";

const defaultStatuses: Array<[
  string,
  StatusCategory,
  string,
  number,
  number,
  "duplicate" | null,
]> = [
  ["Backlog", "backlog", "#6b7280", 0, 0, null],
  ["Todo", "unstarted", "#94a3b8", 1, 1, null],
  ["In Progress", "started", "#f59e0b", 2, 0, null],
  ["Done", "completed", "#22c55e", 3, 0, null],
  ["Canceled", "canceled", "#ef4444", 4, 0, null],
  ["Duplicate", "canceled", "#9ca3af", 5, 0, "duplicate"],
];

export async function getOrCreateUser(actor: Actor): Promise<UserRecord> {
  const db = getD1();
  const existing = await db
    .prepare(
      `UPDATE users
       SET email = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT user_id FROM user_identities
         WHERE provider = ? AND provider_account_key = ?
       )
       RETURNING id, display_name, email, timezone, theme,
                 sidebar_preference, version`,
    )
    .bind(
      actor.email,
      actor.provider,
      actor.providerAccountKey,
    )
    .first<DbRow>();

  if (existing) {
    await db
      .prepare(
        `UPDATE user_identities SET verified_email = ?
         WHERE provider = ? AND provider_account_key = ?`,
      )
      .bind(actor.email, actor.provider, actor.providerAccountKey)
      .run();
    return mapUser(existing);
  }

  const userId = `usr_${crypto.randomUUID()}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, display_name, email)
         VALUES (?, ?, ?)`,
      )
      .bind(userId, actor.displayName, actor.email),
    db
      .prepare(
        `INSERT INTO user_identities
          (user_id, provider, provider_account_key, verified_email)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(userId, actor.provider, actor.providerAccountKey, actor.email),
    ...defaultStatuses.map(([name, category, color, position, isDefault, systemRole]) =>
      db
        .prepare(
          `INSERT INTO workflow_statuses
            (id, owner_user_id, name, category, color, position, is_default, system_role)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `status:${userId}:${systemRole ?? category}`,
          userId,
          name,
          category,
          color,
          position,
          isDefault,
          systemRole,
        ),
    ),
  ]);
  return {
    id: userId,
    displayName: actor.displayName,
    email: actor.email,
    timezone: "UTC",
    theme: "system",
    sidebarPreference: "expanded",
    version: 1,
  };
}
export async function getUserProfile(currentUser: UserRecord): Promise<UserProfile> {
  const db = getD1();
  const [user, identities] = await Promise.all([
    db.prepare(
      `SELECT id, display_name, email, timezone, theme,
              sidebar_preference, version
       FROM users WHERE id = ?`,
    ).bind(currentUser.id).first<DbRow>(),
    db.prepare(
      `SELECT provider, verified_email
       FROM user_identities WHERE user_id = ?
       ORDER BY provider, provider_account_key`,
    ).bind(currentUser.id).all<DbRow>(),
  ]);
  if (!user) throw new NotFoundError("User profile was not found");
  return {
    user: mapUser(user),
    identities: identities.results.map(mapUserIdentity),
  };
}
export async function updateUserProfile(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<UserProfile> {
  const allowed = new Set([
    "version",
    "displayName",
    "timezone",
    "theme",
    "sidebarPreference",
  ]);
  const unsupported = Object.keys(input).find((key) => !allowed.has(key));
  if (unsupported) throw new ValidationError(`Profile field ${unsupported} cannot be changed`);
  if (!Number.isInteger(input.version) || Number(input.version) < 1) {
    throw new ValidationError("Profile version is required");
  }

  const current = await getUserProfile(currentUser);
  const displayName = input.displayName === undefined
    ? current.user.displayName
    : validateDisplayName(input.displayName);
  const timezone = input.timezone === undefined
    ? current.user.timezone
    : validateTimeZone(input.timezone);
  const theme = input.theme === undefined
    ? current.user.theme
    : validateTheme(input.theme);
  const sidebarPreference = input.sidebarPreference === undefined
    ? current.user.sidebarPreference
    : validateSidebarPreference(input.sidebarPreference);

  const updated = await getD1().prepare(
    `UPDATE users
     SET display_name = ?, timezone = ?, theme = ?, sidebar_preference = ?,
         version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND version = ?
     RETURNING id, display_name, email, timezone, theme,
               sidebar_preference, version`,
  ).bind(
    displayName,
    timezone,
    theme,
    sidebarPreference,
    currentUser.id,
    input.version,
  ).first<DbRow>();
  if (!updated) throw new ConflictError("Profile changed in another session; reload and try again");
  return {
    user: mapUser(updated),
    identities: current.identities,
  };
}

function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Display name is required");
  const normalized = value.trim();
  if (!normalized) throw new ValidationError("Display name is required");
  if (normalized.length > 120) throw new ValidationError("Display name must be 120 characters or fewer");
  return normalized;
}

function validateTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 100) {
    throw new ValidationError("Timezone must be a valid IANA identifier");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw new ValidationError("Timezone must be a valid IANA identifier");
  }
  if (value !== "UTC" && !value.includes("/")) {
    throw new ValidationError("Timezone must be a valid IANA identifier");
  }
  return value;
}

function validateTheme(value: unknown): ThemePreference {
  if (value !== "system" && value !== "light" && value !== "dark") {
    throw new ValidationError("Theme must be system, light, or dark");
  }
  return value;
}

function validateSidebarPreference(value: unknown): SidebarPreference {
  if (value !== "expanded" && value !== "collapsed") {
    throw new ValidationError("Sidebar preference must be expanded or collapsed");
  }
  return value;
}
