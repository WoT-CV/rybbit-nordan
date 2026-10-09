import { DateTime } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: { query: mocks.query },
}));

vi.mock("../../lib/logger/logger.js", () => ({
  createServiceLogger: () => ({ warn: mocks.warn }),
}));

import { getSiteEventCounts } from "./siteEventCountsService.js";

function queryResult(rows: unknown[]) {
  return {
    json: vi.fn().mockResolvedValue(rows),
  };
}

describe("getSiteEventCounts", () => {
  const now = DateTime.fromISO("2026-07-16T12:00:00Z", { zone: "utc" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads both time ranges from the rollup in one query", async () => {
    mocks.query.mockResolvedValueOnce(
      queryResult([
        { site_id: 7, events_24h: 12, events_30d: 345 },
        { site_id: "9", events_24h: "4", events_30d: "56" },
      ])
    );

    const result = await getSiteEventCounts(now);

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0].query).toContain("FROM hourly_events_by_site_mv_target");
    expect(mocks.query.mock.calls[0][0].query_params).toEqual({
      from24h: "2026-07-15 12:00:00",
      from30d: "2026-06-16 12:00:00",
      to: "2026-07-16 12:00:00",
    });
    expect(result.last24Hours.get(7)).toBe(12);
    expect(result.last30Days.get(9)).toBe(56);
  });

  it("falls back to raw events when the rollup query fails", async () => {
    mocks.query
      .mockRejectedValueOnce(new Error("UNKNOWN_TABLE"))
      .mockResolvedValueOnce(queryResult([{ site_id: 7, events_24h: 10, events_30d: 300 }]));

    const result = await getSiteEventCounts(now);

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1][0].query).toContain("FROM events");
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(result.last24Hours.get(7)).toBe(10);
    expect(result.last30Days.get(7)).toBe(300);
  });

  it("propagates the error when both the rollup and raw events fail", async () => {
    mocks.query.mockRejectedValueOnce(new Error("UNKNOWN_TABLE")).mockRejectedValueOnce(new Error("CLICKHOUSE_DOWN"));

    await expect(getSiteEventCounts(now)).rejects.toThrow("CLICKHOUSE_DOWN");
  });

  it("uses UTC instants across DST in both the rollup and fallback, regardless of the caller zone", async () => {
    const localNow = DateTime.fromISO("2026-10-25T12:00:00", { zone: "Europe/Warsaw" });
    mocks.query.mockRejectedValueOnce(new Error("UNKNOWN_TABLE")).mockResolvedValueOnce(queryResult([]));

    await getSiteEventCounts(localNow);

    for (const [query] of mocks.query.mock.calls) {
      expect(query.query_params).toEqual({
        from24h: "2026-10-24 11:00:00",
        from30d: "2026-09-25 11:00:00",
        to: "2026-10-25 11:00:00",
      });
      for (const parameter of ["from24h", "from30d", "to"]) {
        expect(query.query).toContain(`toDateTime({${parameter}:String}, 'UTC')`);
      }
    }
  });
});
