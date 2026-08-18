import type {
  AdminOverview,
  AdminUserActivityRecord,
  UserRecord,
} from "./types";

const activeWindowMs = 7 * 24 * 60 * 60 * 1000;

export type AdminUserAggregate = {
  id: string;
  displayName: string;
  email: string;
  registeredAt: string;
  lastSeenAt: string;
  taskCount: number;
  recentTaskCount: number;
  projectCount: number;
  releaseCount: number;
  viewCount: number;
  lastTaskActivityAt: string | null;
  lastProjectActivityAt: string | null;
  lastReleaseActivityAt: string | null;
  lastViewActivityAt: string | null;
  attachmentCount: number;
  attachmentBytes: number;
  pendingAttachmentCount: number;
  failedAttachmentCount: number;
  deletedAttachmentCount: number;
};

export class AdminAccessError extends Error {
  readonly status = 403;

  constructor() {
    super("Administrator access required");
  }
}

export function isAdminEmail(
  email: string,
  configuredEmails = process.env.TASK_MANAGER_ADMIN_EMAILS,
): boolean {
  const normalized = normalizeEmail(email);
  return parseAdminEmails(configuredEmails).has(normalized);
}

export function assertAdmin(
  user: UserRecord,
  configuredEmails = process.env.TASK_MANAGER_ADMIN_EMAILS,
): void {
  if (!isAdminEmail(user.email, configuredEmails)) {
    throw new AdminAccessError();
  }
}

export function buildAdminOverview(
  rows: AdminUserAggregate[],
  configuredEmails = process.env.TASK_MANAGER_ADMIN_EMAILS,
  now = Date.now(),
  storage: {
    objectCount: number;
    objectBytes: number;
    stagingObjectCount: number;
    orphanObjectCount: number | null;
    truncated: boolean;
  } = {
    objectCount: rows.reduce((total, row) => total + row.attachmentCount, 0),
    objectBytes: rows.reduce((total, row) => total + row.attachmentBytes, 0),
    stagingObjectCount: 0,
    orphanObjectCount: null,
    truncated: true,
  },
): AdminOverview {
  const users = rows.map((row): AdminUserActivityRecord => ({
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    isAdmin: isAdminEmail(row.email, configuredEmails),
    registeredAt: normalizeTimestamp(row.registeredAt),
    lastSeenAt: normalizeTimestamp(row.lastSeenAt),
    lastContentActivityAt: latestTimestamp([
      row.lastTaskActivityAt,
      row.lastProjectActivityAt,
      row.lastReleaseActivityAt,
      row.lastViewActivityAt,
    ]),
    taskCount: row.taskCount,
    recentTaskCount: row.recentTaskCount,
    projectCount: row.projectCount,
    releaseCount: row.releaseCount,
    viewCount: row.viewCount,
  }));

  return {
    registeredUserCount: users.length,
    activeUserCount: users.filter(
      (user) => now - new Date(user.lastSeenAt).getTime() <= activeWindowMs,
    ).length,
    taskCount: sum(users, "taskCount"),
    projectCount: sum(users, "projectCount"),
    releaseCount: sum(users, "releaseCount"),
    viewCount: sum(users, "viewCount"),
    attachmentCount: rows.reduce((total, row) => total + row.attachmentCount, 0),
    attachmentBytes: rows.reduce((total, row) => total + row.attachmentBytes, 0),
    attachmentObjectCount: storage.objectCount,
    attachmentObjectBytes: storage.objectBytes,
    stagingAttachmentObjectCount: storage.stagingObjectCount,
    orphanAttachmentObjectCount: storage.orphanObjectCount,
    attachmentStorageTruncated: storage.truncated,
    pendingAttachmentCount: rows.reduce(
      (total, row) => total + row.pendingAttachmentCount,
      0,
    ),
    failedAttachmentCount: rows.reduce(
      (total, row) => total + row.failedAttachmentCount,
      0,
    ),
    deletedAttachmentCount: rows.reduce(
      (total, row) => total + row.deletedAttachmentCount,
      0,
    ),
    users,
  };
}

function parseAdminEmails(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value.replace(" ", "T")}Z`;
  }
  return value;
}

function latestTimestamp(values: Array<string | null>): string | null {
  const normalized = values.filter((value): value is string => Boolean(value)).map(
    normalizeTimestamp,
  );
  if (!normalized.length) return null;
  return normalized.reduce((latest, value) =>
    new Date(value).getTime() > new Date(latest).getTime() ? value : latest,
  );
}

function sum(
  users: AdminUserActivityRecord[],
  field: "taskCount" | "projectCount" | "releaseCount" | "viewCount",
): number {
  return users.reduce((total, user) => total + user[field], 0);
}
