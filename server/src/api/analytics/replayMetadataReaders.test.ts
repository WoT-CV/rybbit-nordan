import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouse: { query: vi.fn() } }));
vi.mock("../../db/postgres/postgres.js", () => ({ db: {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("upstream session drilldowns respect the existing replay metadata rollout", () => {
  it.each(["v1", "dual", "v2"])("reads the selected table in every new session query: %s", async mode => {
    vi.stubEnv("REPLAY_METADATA_MODE", mode);
    vi.resetModules();
    const { REPLAY_LOOKUP_QUERY, buildReplaySessionsSubquery } = await import("./sessions/sessionQuery.js");
    const { buildSessionsSummaryQuery } = await import("./sessions/getSessionsSummary.js");
    const { buildJourneySessionsQuery } = await import("./getJourneySessions.js");
    const { buildFunnelStepSessionsQuery } = await import("./funnels/getFunnelStepSessions.js");
    const table = mode === "v1" ? "session_replay_metadata" : "session_replay_metadata_v2";
    const other = mode === "v1" ? "session_replay_metadata_v2" : "session_replay_metadata";
    const query = { start_date: "", end_date: "", time_zone: "UTC", filters: "" };
    const statements = [
      REPLAY_LOOKUP_QUERY,
      buildReplaySessionsSubquery(query),
      buildSessionsSummaryQuery(query, 42, { goals: [], expression: "emptyArrayUInt32()" }).query,
      buildJourneySessionsQuery(
        { ...query, path: JSON.stringify(["/", "/pricing"]) },
        42,
        { maxSteps: 3, stepFilters: {}, groupBy: "path" },
        { path: ["/", "/pricing"], replaysOnly: true, limit: 25, offset: 0 }
      ).query,
      buildFunnelStepSessionsQuery(
        { ...query, mode: "reached", page: 1, replays_only: "true" },
        42,
        [
          { type: "page", value: "/" },
          { type: "event", value: "signup" },
        ],
        2
      ),
    ];
    for (const sql of statements) {
      expect(sql).toMatch(new RegExp(`FROM ${table}\\s`));
      expect(sql).not.toMatch(new RegExp(`FROM ${other}\\s`));
      expect(sql).toContain("site_id = {siteId:Int32}");
    }
  });
});
