import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import { ValidationError } from "./domain";
import { ensureDatabase } from "./repository";
import type { UserRecord } from "./types";

type JsonObject = Record<string, unknown>;

export type LinearInventory = {
  sessionId: string;
  organization: { id: string; name: string; urlKey: string };
  viewer: { id: string; name: string; email: string };
  users: Array<{ id: string; name: string; email: string; active: boolean }>;
  projects: Array<{ id: string; name: string; archivedAt: string | null }>;
  counts: Record<string, number>;
  warnings: string[];
  expiresAt: string;
};

type LinearSnapshot = {
  organization: JsonObject;
  viewer: JsonObject;
  users: JsonObject[];
  projects: JsonObject[];
  statuses: JsonObject[];
  labels: JsonObject[];
  views: JsonObject[];
  issues: JsonObject[];
  warnings: string[];
};

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const maxLinearSnapshotRows = 5_000;
const maxLinearSnapshotBytes = 25_000_000;

export function linearOAuthConfigured() {
  return Boolean(linearConfig().clientId);
}

export async function beginLinearOAuth(currentUser: UserRecord, origin: string) {
  const config = linearConfig();
  if (!config.clientId) throw new ValidationError("Linear OAuth is not configured for this Site");
  await ensureDatabase();
  const verifier = randomBase64Url(48);
  const state = randomBase64Url(32);
  const challenge = await sha256Base64Url(verifier);
  const stateHash = await sha256Hex(state);
  const redirectUri = `${new URL(origin).origin}/api/import/linear/callback`;
  const importId = `linear-import:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const db = getD1();
  await db.batch([
    db.prepare("DELETE FROM user_import_rows WHERE import_id IN (SELECT id FROM user_import_sessions WHERE expires_at < CURRENT_TIMESTAMP)"),
    db.prepare("UPDATE user_import_sessions SET status = 'expired', secret_json = '{}' WHERE status NOT IN ('applied', 'expired') AND expires_at < CURRENT_TIMESTAMP"),
    db.prepare(`INSERT INTO user_import_sessions
      (id, created_by_user_id, kind, status, state_hash, source_json,
       scope_json, preview_json, secret_json, expires_at)
      VALUES (?, ?, 'linear', 'oauth_pending', ?, '{}', '{}', '{}', ?, ?)`)
      .bind(importId, currentUser.id, stateHash, JSON.stringify({ verifier, redirectUri }), expiresAt),
  ]);
  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function completeLinearOAuth(
  currentUser: UserRecord,
  callbackUrl: string,
): Promise<string> {
  const url = new URL(callbackUrl);
  const providerError = url.searchParams.get("error");
  if (providerError) throw new ValidationError(`Linear authorization failed: ${providerError}`);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code) throw new ValidationError("Linear callback is missing code or state");
  await ensureDatabase();
  const db = getD1();
  const stateHash = await sha256Hex(state);
  const session = await db.prepare(`SELECT id, secret_json FROM user_import_sessions
    WHERE created_by_user_id = ? AND kind = 'linear' AND status = 'oauth_pending'
      AND state_hash = ? AND expires_at >= CURRENT_TIMESTAMP`)
    .bind(currentUser.id, stateHash)
    .first<{ id: string; secret_json: string }>();
  if (!session) throw new ValidationError("Linear authorization state is invalid or expired");
  const secret = JSON.parse(session.secret_json) as { verifier?: string; redirectUri?: string };
  if (!secret.verifier || !secret.redirectUri) throw new ValidationError("Linear PKCE session is invalid");
  const transition = await db.prepare(`UPDATE user_import_sessions SET status = 'oauth_exchanging', state_hash = NULL
    WHERE id = ? AND created_by_user_id = ? AND kind = 'linear' AND status = 'oauth_pending' AND state_hash = ?`)
    .bind(session.id, currentUser.id, stateHash).run();
  if (transition.meta.changes !== 1) throw new ValidationError("Linear authorization state was already used");
  let token: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    token = await exchangeCode(code, secret.verifier, secret.redirectUri);
  } catch (error) {
    await db.prepare("UPDATE user_import_sessions SET status = 'failed', secret_json = '{}' WHERE id = ? AND status = 'oauth_exchanging'")
      .bind(session.id).run();
    throw error;
  }
  let snapshot: LinearSnapshot;
  try {
    snapshot = await fetchLinearSnapshot(token.accessToken);
  } catch (error) {
    await db.prepare("UPDATE user_import_sessions SET status = 'failed', secret_json = '{}', preview_json = ? WHERE id = ?")
      .bind(JSON.stringify({ error: error instanceof Error ? error.message : "Linear snapshot failed" }), session.id).run();
    throw error;
  } finally {
    await Promise.allSettled([
      revokeToken(token.accessToken, "access_token"),
      token.refreshToken ? revokeToken(token.refreshToken, "refresh_token") : Promise.resolve(),
    ]);
  }
  const rows = snapshotRows(snapshot);
  const encodedBytes = rows.reduce((total, row) => total + new TextEncoder().encode(row.json).byteLength, 0);
  if (rows.length > maxLinearSnapshotRows || encodedBytes > maxLinearSnapshotBytes) {
    await db.prepare("UPDATE user_import_sessions SET status = 'failed', secret_json = '{}', preview_json = ? WHERE id = ?")
      .bind(JSON.stringify({ error: "Linear workspace exceeds the staged migration limit" }), session.id).run();
    throw new ValidationError("Linear workspace is too large for the current staged migration limit");
  }
  const inventory = inventoryFromSnapshot(session.id, snapshot);
  await db.prepare("UPDATE user_import_sessions SET status = 'snapshot_uploading', secret_json = '{}' WHERE id = ? AND status = 'oauth_exchanging'")
    .bind(session.id).run();
  try {
    for (let offset = 0; offset < rows.length; offset += 500) {
      const statements: D1PreparedStatement[] = [];
      const portion = rows.slice(offset, offset + 500);
      for (let rowOffset = 0; rowOffset < portion.length; rowOffset += 25) {
        const group = portion.slice(rowOffset, rowOffset + 25);
        statements.push(
          db.prepare(`INSERT INTO user_import_rows (import_id, row_type, ordinal, row_json) VALUES ${group.map(() => "(?, ?, ?, ?)").join(", ")}`)
            .bind(...group.flatMap((row) => [session.id, row.type, row.ordinal, row.json])),
        );
      }
      await db.batch(statements);
    }
    const checksum = await sha256Hex(rows.map((row) => `${row.type}:${row.ordinal}:${row.json}`).join("\n"));
    await db.prepare(`UPDATE user_import_sessions SET
      status = 'snapshot', source_json = ?, preview_json = ?, payload_sha256 = ?,
      source_exported_at = ?, expires_at = ? WHERE id = ? AND status = 'snapshot_uploading'`)
      .bind(
        JSON.stringify(inventory),
        JSON.stringify({ counts: inventory.counts, warnings: inventory.warnings }),
        checksum,
        new Date().toISOString(),
        inventory.expiresAt,
        session.id,
      ).run();
  } catch (error) {
    await db.batch([
      db.prepare("DELETE FROM user_import_rows WHERE import_id = ?").bind(session.id),
      db.prepare("UPDATE user_import_sessions SET status = 'failed', preview_json = ? WHERE id = ? AND status = 'snapshot_uploading'")
        .bind(JSON.stringify({ error: "Linear snapshot staging failed" }), session.id),
    ]);
    throw error;
  }
  return session.id;
}

export async function loadLinearInventory(currentUser: UserRecord, sessionId: string) {
  await ensureDatabase();
  const session = await getD1().prepare(`SELECT source_json, status, preview_json FROM user_import_sessions
    WHERE id = ? AND created_by_user_id = ? AND kind = 'linear'
      AND status IN ('snapshot', 'staged', 'applied') AND expires_at >= CURRENT_TIMESTAMP`)
    .bind(sessionId, currentUser.id).first<{ source_json: string; status: string; preview_json: string }>();
  if (!session) throw new ValidationError("Linear migration session is missing or expired");
  return {
    ...(JSON.parse(session.source_json) as LinearInventory),
    status: session.status,
    preview: session.status === "staged" ? JSON.parse(session.preview_json) : null,
  };
}

export async function loadLinearSnapshotRows(currentUser: UserRecord, sessionId: string) {
  await ensureDatabase();
  const session = await getD1().prepare(`SELECT source_json FROM user_import_sessions
    WHERE id = ? AND created_by_user_id = ? AND kind = 'linear'
      AND status IN ('snapshot', 'staged') AND expires_at >= CURRENT_TIMESTAMP`)
    .bind(sessionId, currentUser.id).first<{ source_json: string }>();
  if (!session) throw new ValidationError("Linear migration snapshot is missing or expired");
  const rows = await getD1().prepare(`SELECT row_type, ordinal, row_json FROM user_import_rows
    WHERE import_id = ? AND row_type LIKE 'linear_%' ORDER BY row_type, ordinal`)
    .bind(sessionId).all<{ row_type: string; ordinal: number; row_json: string }>();
  const grouped = new Map<string, JsonObject[]>();
  for (const row of rows.results) {
    const values = grouped.get(row.row_type) ?? [];
    values.push(JSON.parse(row.row_json) as JsonObject);
    grouped.set(row.row_type, values);
  }
  return {
    inventory: JSON.parse(session.source_json) as LinearInventory,
    users: grouped.get("linear_users") ?? [],
    projects: grouped.get("linear_projects") ?? [],
    statuses: grouped.get("linear_statuses") ?? [],
    labels: grouped.get("linear_labels") ?? [],
    views: grouped.get("linear_views") ?? [],
    issues: grouped.get("linear_issues") ?? [],
  };
}

export type LoadedLinearSnapshot = Awaited<ReturnType<typeof loadLinearSnapshotRows>>;

function snapshotRows(snapshot: LinearSnapshot) {
  const groups: Array<[string, JsonObject[]]> = [
    ["linear_users", snapshot.users], ["linear_projects", snapshot.projects],
    ["linear_statuses", snapshot.statuses], ["linear_labels", snapshot.labels],
    ["linear_views", snapshot.views], ["linear_issues", snapshot.issues],
  ];
  return groups.flatMap(([type, values]) => values.map((value, ordinal) => ({ type, ordinal, json: JSON.stringify(value) })));
}

function inventoryFromSnapshot(sessionId: string, snapshot: LinearSnapshot): LinearInventory {
  const organization = summary(snapshot.organization, ["id", "name", "urlKey"]);
  const viewer = summary(snapshot.viewer, ["id", "name", "email"]);
  return {
    sessionId,
    organization: organization as LinearInventory["organization"],
    viewer: viewer as LinearInventory["viewer"],
    users: snapshot.users.map((user) => ({
      id: String(user.id), name: String(user.name), email: String(user.email ?? ""), active: user.active !== false,
    })),
    projects: snapshot.projects.map((project) => ({
      id: String(project.id), name: String(project.name), archivedAt: typeof project.archivedAt === "string" ? project.archivedAt : null,
    })),
    counts: {
      users: snapshot.users.length, projects: snapshot.projects.length,
      statuses: snapshot.statuses.length, labels: snapshot.labels.length,
      views: snapshot.views.length, issues: snapshot.issues.length,
    },
    warnings: snapshot.warnings,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function fetchLinearSnapshot(accessToken: string): Promise<LinearSnapshot> {
  const identity = await linearGraphql<{ organization: JsonObject; viewer: JsonObject }>(accessToken, `query Identity {
    organization { id name urlKey }
    viewer { id name email }
  }`);
  const users = await paginateLinear(accessToken, "users", `query Users($after: String) {
    users(first: 100, after: $after, includeDisabled: true) {
      nodes { id name displayName email active archivedAt url }
      pageInfo { hasNextPage endCursor }
    }
  }`);
  const projects = await paginateLinear(accessToken, "projects", `query Projects($after: String) {
    projects(first: 50, after: $after, includeArchived: true, orderBy: updatedAt) {
      nodes {
        id name description icon color url createdAt updatedAt archivedAt
        startDate targetDate startedAt completedAt canceledAt
        status { id name type color }
        lead { id name email }
        teams(first: 20) { nodes { id name key } pageInfo { hasNextPage } }
        members(first: 50) { nodes { id name email } pageInfo { hasNextPage } }
        projectMilestones(first: 50, includeArchived: true) {
          nodes { id name description targetDate createdAt updatedAt archivedAt status progress }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`);
  const statuses = await paginateLinear(accessToken, "workflowStates", `query Statuses($after: String) {
    workflowStates(first: 100, after: $after, includeArchived: true) {
      nodes { id name type color position archivedAt team { id name key } }
      pageInfo { hasNextPage endCursor }
    }
  }`);
  const labels = await paginateLinear(accessToken, "issueLabels", `query Labels($after: String) {
    issueLabels(first: 100, after: $after, includeArchived: true) {
      nodes { id name description color archivedAt team { id name key } }
      pageInfo { hasNextPage endCursor }
    }
  }`);
  const views = await paginateLinear(accessToken, "customViews", `query Views($after: String) {
    customViews(first: 50, after: $after, includeArchived: true) {
      nodes {
        id name description icon color shared slugId modelName filterData projectFilterData archivedAt
        creator { id name email } owner { id name email } team { id name key }
        projects(first: 50) { nodes { id name } pageInfo { hasNextPage } }
        userViewPreferences {
          preferences { layout viewOrdering viewOrderingDirection issueGrouping showEmptyGroupsBoard showEmptyGroupsList fieldPriority fieldProject fieldMilestone fieldDueDate fieldAssignee fieldLabels }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`);
  const issues = await paginateLinear(accessToken, "issues", `query Issues($after: String) {
    issues(first: 10, after: $after, includeArchived: true, orderBy: updatedAt) {
      nodes {
        id identifier title description priority priorityLabel estimate sortOrder url branchName
        createdAt updatedAt archivedAt startedAt completedAt canceledAt dueDate
        state { id name type color position team { id } }
        assignee { id name email } creator { id name email }
        project { id name } projectMilestone { id name } parent { id identifier }
        labels(first: 50) { nodes { id name color } pageInfo { hasNextPage } }
        relations(first: 50) { nodes { id type issue { id identifier } relatedIssue { id identifier title } } pageInfo { hasNextPage } }
        inverseRelations(first: 50) { nodes { id type issue { id identifier title } relatedIssue { id identifier } } pageInfo { hasNextPage } }
        attachments(first: 50) { nodes { id title subtitle url sourceType metadata } pageInfo { hasNextPage } }
        comments(first: 50) { nodes { id body createdAt updatedAt archivedAt parentId quotedText url user { id name email } } pageInfo { hasNextPage } }
        stateHistory(first: 50) { nodes { id stateId startedAt endedAt state { id name type } } pageInfo { hasNextPage } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`);
  const warnings = collectTruncationWarnings(projects, views, issues);
  return { organization: identity.organization, viewer: identity.viewer, users, projects, statuses, labels, views, issues, warnings };
}

async function paginateLinear(
  accessToken: string,
  root: string,
  query: string,
): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  let after: string | null = null;
  do {
    const data: JsonObject = await linearGraphql<JsonObject>(accessToken, query, { after });
    const connection = data[root] as JsonObject | undefined;
    if (!connection || !Array.isArray(connection.nodes)) throw new ValidationError(`Linear ${root} response is invalid`);
    result.push(...connection.nodes.map((node) => node as JsonObject));
    const pageInfo = connection.pageInfo as JsonObject | undefined;
    after = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
  } while (after);
  return result;
}

async function linearGraphql<T>(accessToken: string, query: string, variables: JsonObject = {}): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => null) as { data?: T; errors?: Array<{ message?: string }> } | null;
  if (!response.ok || !payload?.data || payload.errors?.length) {
    const message = payload?.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new ValidationError(message || `Linear API request failed (${response.status})`);
  }
  return payload.data;
}

function collectTruncationWarnings(...collections: JsonObject[][]) {
  const warnings: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    const row = value as JsonObject;
    if (row.pageInfo && typeof row.pageInfo === "object" && (row.pageInfo as JsonObject).hasNextPage === true) {
      warnings.push(`${path} exceeded the per-record provider page and was truncated.`);
    }
    for (const [key, nested] of Object.entries(row)) if (key !== "pageInfo") visit(nested, `${path}.${key}`);
  };
  collections.forEach((collection, index) => visit(collection, `collection${index + 1}`));
  return warnings;
}

async function exchangeCode(code: string, verifier: string, redirectUri: string) {
  const config = linearConfig();
  const form = new URLSearchParams({
    code, redirect_uri: redirectUri, client_id: config.clientId,
    code_verifier: verifier, grant_type: "authorization_code",
  });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const payload = await response.json().catch(() => null) as JsonObject | null;
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new ValidationError(typeof payload?.error_description === "string" ? payload.error_description : "Linear token exchange failed");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
  };
}

async function revokeToken(token: string, hint: "access_token" | "refresh_token") {
  const config = linearConfig();
  const form = new URLSearchParams({ token, token_type_hint: hint, client_id: config.clientId });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  await fetch(LINEAR_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function linearConfig() {
  const values = env as unknown as { LINEAR_CLIENT_ID?: string; LINEAR_CLIENT_SECRET?: string };
  return {
    clientId: values.LINEAR_CLIENT_ID?.trim() ?? "",
    clientSecret: values.LINEAR_CLIENT_SECRET?.trim() ?? "",
  };
}

function summary(value: JsonObject, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, String(value[key] ?? "")]));
}

function randomBase64Url(bytes: number) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(data);
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
