import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  paginated: vi.fn(),
  enrich: vi.fn(),
  goal: vi.fn(),
}));

vi.mock("./utils/analyticsQuery.js", () => ({
  analyticsRoute: (_name: string, handler: unknown) => handler,
  runAnalyticsQuery: mocks.query,
  runPaginatedQuery: mocks.paginated,
  getPaginationStatements: () => ({ limitStatement: "LIMIT 20", offsetStatement: "" }),
}));
vi.mock("./utils/utils.js", () => ({ enrichWithTraits: mocks.enrich }));
vi.mock("../../db/postgres/postgres.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.goal }) }) }) },
}));

import { getErrorEvents, buildErrorEventsQuery } from "./getErrorEvents.js";
import { getGoalSessions, buildGoalSessionsQuery } from "./goals/getGoalSessions.js";
import { getSessionLocations } from "./sessions/getSessionLocations.js";

const period = { start_date: "2026-10-01", end_date: "2026-10-31", time_zone: "UTC", filters: "" };
const request = (site: number, query = {}, params = {}) =>
  ({ params: { siteId: String(site), ...params }, query: { ...period, ...query } }) as any;
const reply = () => {
  const response: any = {};
  response.status = vi.fn(() => response);
  response.send = vi.fn((body: unknown) => body);
  return response;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.goal.mockResolvedValue([{ goalId: 8, siteId: 12, goalType: "event", config: { eventName: "done" } }]);
  mocks.enrich.mockImplementation(async (rows: any[], siteId: number) =>
    rows.map(row => ({
      ...row,
      traits:
        row.identified_user_id === "000123"
          ? { username: `[SITE${siteId}] nick`, avatarUrl: `https://logos.example/${siteId}.png` }
          : null,
    }))
  );
});

describe("native current-profile enrichment", () => {
  it("adds identity only to single-session locations and never leaks technical group IDs", async () => {
    mocks.query.mockResolvedValue([
      {
        lat: 1,
        lon: 2,
        city: "A",
        country: "PL",
        count: 1,
        session_id: "s1",
        user_id: "000001",
        identified_user_id: "000123",
      },
      {
        lat: 3,
        lon: 4,
        city: "B",
        country: "PL",
        count: 2,
        session_id: "s2",
        user_id: "000002",
        identified_user_id: "000123",
      },
      { lat: 5, lon: 6, city: "C", country: "PL", count: 1, session_id: "s3", user_id: "anon", identified_user_id: "" },
    ]);
    const res = reply();
    await getSessionLocations(request(12), res);
    expect(mocks.enrich).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ session_id: "s1" }),
        expect.objectContaining({ session_id: "s3" }),
      ]),
      12
    );
    expect(mocks.enrich.mock.calls[0][0]).toHaveLength(2);
    const data = res.send.mock.calls[0][0].data;
    expect(data[0].sample).toEqual({
      session_id: "s1",
      user_id: "000001",
      identified_user_id: "000123",
      traits: { username: "[SITE12] nick", avatarUrl: "https://logos.example/12.png" },
    });
    expect(data[1]).toEqual({ lat: 3, lon: 4, city: "B", country: "PL", count: 2, sample: null });
    expect(data[2].sample.traits).toBeNull();
    expect(data.every((row: any) => !("user_id" in row) && !("identified_user_id" in row))).toBe(true);
    expect(mocks.query.mock.calls[0][0].params.site).toBe("12");
  });

  it.each([undefined, 1])(
    "enriches error events with the site scope and keeps the original envelope (page=%s)",
    async page => {
      const rows = [
        { session_id: "s2", user_id: "device", identified_user_id: "000123" },
        { session_id: "s1", user_id: "anon", identified_user_id: "" },
      ];
      mocks.query.mockResolvedValue(rows);
      mocks.paginated.mockResolvedValue({ data: rows, totalCount: 42 });
      const res = reply();
      await getErrorEvents(request(13, { errorMessage: "boom", ...(page ? { page } : {}) }), res);
      const body = res.send.mock.calls[0][0];
      const data = page ? body.data.data : body.data;
      expect(data.map((row: any) => row.session_id)).toEqual(["s2", "s1"]);
      expect(data[0].traits.username).toBe("[SITE13] nick");
      expect(data[1].traits).toBeNull();
      if (page) expect(body.data.totalCount).toBe(42);
      expect(mocks.enrich).toHaveBeenCalledWith(rows, 13);
    }
  );

  it("enriches goal sessions only after validating goal ownership", async () => {
    const rows = [{ user_id: "device", identified_user_id: "000123", session_id: "s1" }];
    mocks.query.mockResolvedValue(rows);
    const res = reply();
    await getGoalSessions(request(12, { page: 1 }, { goalId: "8" }), res);
    expect(res.send.mock.calls[0][0].data[0].traits.username).toBe("[SITE12] nick");
    expect(mocks.enrich).toHaveBeenCalledWith(rows, 12);
    const denied = reply();
    await getGoalSessions(request(99, { page: 1 }, { goalId: "8" }), denied);
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(mocks.enrich).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0].params.siteId).toBe(12);
  });

  it("selects native IDs without adding identity lookup joins or changing filtering", () => {
    const errors = buildErrorEventsQuery({ ...period, errorMessage: "boom" }, 12);
    const goals = buildGoalSessionsQuery({ ...period, page: 1 }, 12, "type = 'pageview'");
    expect(errors).toContain("user_id,\n        identified_user_id,");
    expect(goals).toContain("argMax(e.identified_user_id, e.timestamp) AS identified_user_id");
    for (const sql of [errors, goals]) {
      expect(sql).toContain("{siteId:Int32}");
      expect(sql).toContain("2026-10-01");
      expect(sql).not.toMatch(/user_profiles|dictGet/);
    }
  });
});
