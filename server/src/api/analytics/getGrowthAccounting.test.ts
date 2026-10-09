import { DateTime } from "luxon";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouse: { query: mocks.query } }));

import { getGrowthAccounting, mapGrowthAccountingRows } from "./getGrowthAccounting.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ json: async () => [] });
});
afterEach(() => vi.useRealTimers());

async function request(query: Record<string, string | undefined>) {
  const app = Fastify();
  app.get("/sites/:siteId/growth-accounting", getGrowthAccounting);
  try {
    const params = Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined);
    return await app.inject({ url: `/sites/42/growth-accounting?${new URLSearchParams(params)}` });
  } finally {
    await app.close();
  }
}

describe("growth accounting analytics wire compatibility", () => {
  it.each([
    { start_date: "2026-10-24", end_date: "2026-10-25", time_zone: "Europe/Warsaw" },
    { startDate: "2026-10-24", endDate: "2026-10-25", timeZone: "Europe/Warsaw" },
  ])("keeps camel-case and unified analytics dates equivalent across DST: %j", async dates => {
    const response = await request({ ...dates, mode: "day" });
    expect(response.statusCode).toBe(200);
    expect(response.json().range).toBe(2);
    expect(mocks.query.mock.calls[0][0].query_params).toMatchObject({
      siteId: 42,
      timeZone: "Europe/Warsaw",
      activityStart: "2026-10-22 22:00:00",
      activityEnd: "2026-10-25 23:00:00",
      displayStart: "2026-10-24 00:00:00",
      displayEnd: "2026-10-25 00:00:00",
    });
  });

  it("treats the empty all-time wire dates as the bounded default, not invalid dates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T12:00:00Z"));
    try {
      const response = await request({ start_date: "", end_date: "", time_zone: "UTC", range: "90" });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(90);
      expect(response.json().range).toBe(90);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    { time_zone: "invalid/timezone" },
    { start_date: "2026-10-24" },
    { start_date: "2026-10-25", end_date: "2026-10-24" },
    { range: "366" },
  ])("rejects invalid windows without hitting ClickHouse: %j", async query => {
    expect((await request(query)).statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("mapGrowthAccountingRows", () => {
  it("fills missing daily periods with zero values", () => {
    const result = mapGrowthAccountingRows(
      [{ period: "2026-07-10", new_users: 2, returning_users: 3, resurrecting_users: 1, dormant_users: 4 }],
      DateTime.fromISO("2026-07-10", { zone: "Europe/Warsaw" }),
      DateTime.fromISO("2026-07-11", { zone: "Europe/Warsaw" }),
      "day"
    );

    expect(result).toEqual([
      { period: "2026-07-10", newUsers: 2, returningUsers: 3, resurrectingUsers: 1, dormantUsers: 4 },
      { period: "2026-07-11", newUsers: 0, returningUsers: 0, resurrectingUsers: 0, dormantUsers: 0 },
    ]);
  });

  it("advances weekly without creating daily points", () => {
    const result = mapGrowthAccountingRows(
      [],
      DateTime.fromISO("2026-07-06", { zone: "Europe/Warsaw" }),
      DateTime.fromISO("2026-07-20", { zone: "Europe/Warsaw" }),
      "week"
    );
    expect(result.map(point => point.period)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
  });
});
