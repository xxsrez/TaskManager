import { getD1 } from "@/db";
import { apiTokenFromAuthorization, hashApiToken } from "./api-credential-crypto";
import { getRuntimeEnvironment } from "./runtime-environment";

const UAT_SCOPE = "uat";
const ENABLED_VALUE = "true";

export type BenchmarkTeamResetResult = {
  deleted: {
    teamGrants: number;
    teamMemberships: number;
    teams: number;
  };
  remaining: {
    teamGrants: 0;
    teamMemberships: 0;
    teams: 0;
  };
};

export async function isBenchmarkTeamResetAuthorized(
  request: Request,
): Promise<boolean> {
  const environment = getRuntimeEnvironment();
  if (
    environment.TASK_MANAGER_ATTACHMENT_SCOPE?.trim() !== UAT_SCOPE ||
    environment.TASK_MANAGER_BENCHMARK_TEAM_RESET_ENABLED?.trim() !== ENABLED_VALUE
  ) {
    return false;
  }

  const configuredToken =
    environment.TASK_MANAGER_BENCHMARK_TEAM_RESET_TOKEN?.trim();
  const providedToken = apiTokenFromAuthorization(
    request.headers.get("authorization"),
  );
  if (!configuredToken || !providedToken) return false;

  const [configuredDigest, providedDigest] = await Promise.all([
    hashApiToken(configuredToken),
    hashApiToken(providedToken),
  ]);
  return equalDigestStrings(configuredDigest, providedDigest);
}

export async function resetBenchmarkTeamState(): Promise<BenchmarkTeamResetResult> {
  const database = getD1();
  const deleteResults = await database.batch([
    database.prepare("DELETE FROM team_grants"),
    database.prepare("DELETE FROM team_memberships"),
    database.prepare("DELETE FROM teams"),
  ]);
  const remainingResults = await database.batch([
    database.prepare("SELECT COUNT(*) AS count FROM team_grants"),
    database.prepare("SELECT COUNT(*) AS count FROM team_memberships"),
    database.prepare("SELECT COUNT(*) AS count FROM teams"),
  ]);

  const remaining = {
    teamGrants: resultCount(remainingResults[0]),
    teamMemberships: resultCount(remainingResults[1]),
    teams: resultCount(remainingResults[2]),
  };
  if (
    remaining.teamGrants !== 0 ||
    remaining.teamMemberships !== 0 ||
    remaining.teams !== 0
  ) {
    throw new Error("Benchmark Team reset did not reach an empty post-state");
  }

  return {
    deleted: {
      teamGrants: deleteResults[0]?.meta.changes ?? 0,
      teamMemberships: deleteResults[1]?.meta.changes ?? 0,
      teams: deleteResults[2]?.meta.changes ?? 0,
    },
    remaining: {
      teamGrants: 0,
      teamMemberships: 0,
      teams: 0,
    },
  };
}

function resultCount(result: D1Result<unknown> | undefined): number {
  const row = result?.results[0];
  if (!row || typeof row !== "object" || !("count" in row)) {
    throw new Error("Benchmark Team reset could not verify its post-state");
  }
  const count = Number((row as { count: unknown }).count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Benchmark Team reset returned an invalid post-state count");
  }
  return count;
}

function equalDigestStrings(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
