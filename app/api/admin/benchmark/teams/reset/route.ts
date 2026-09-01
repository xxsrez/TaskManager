import {
  isBenchmarkTeamResetAuthorized,
  resetBenchmarkTeamState,
} from "@/lib/benchmark-team-reset";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!(await isBenchmarkTeamResetAuthorized(request))) {
      return Response.json(
        { error: "Not found" },
        { status: 404, headers: noStoreHeaders() },
      );
    }

    return Response.json(
      { data: await resetBenchmarkTeamState() },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    console.error(
      "Benchmark Team reset failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    return Response.json(
      { error: "Benchmark Team reset failed" },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

function noStoreHeaders() {
  return {
    "cache-control": "private, no-store, max-age=0",
  };
}
