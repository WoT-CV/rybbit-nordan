import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), bucket: "day" }));
vi.mock("../useAnalyticsQuery", () => ({ useAnalyticsQuery: mocks.query }));
vi.mock("../../../lib/store", () => ({
  useStore: (select: (state: { bucket: string }) => unknown) => select({ bucket: mocks.bucket }),
}));

import { useDashboardGrowthAccounting, useGetGrowthAccounting } from "./useGetGrowthAccounting";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bucket = "day";
});

describe("growth accounting preserves its scope in the unified analytics hooks", () => {
  it("keeps the historical 90-day card site-wide without stale placeholders", () => {
    useGetGrowthAccounting();
    expect(mocks.query).toHaveBeenCalledWith({
      key: "growth-accounting",
      path: "growth-accounting",
      params: { mode: "day", range: 90 },
      unwrap: false,
      useTime: false,
      useFilters: false,
      placeholder: false,
    });
  });

  it("keeps dashboard cards site-specific, time-scoped, and independent of filters", () => {
    mocks.bucket = "month";
    useDashboardGrowthAccounting(42, "card-7");
    expect(mocks.query).toHaveBeenCalledWith({
      key: ["dashboard-growth-accounting", "card-7"],
      path: "growth-accounting",
      site: 42,
      params: { mode: "week", range: 365 },
      unwrap: false,
      useFilters: false,
      enabled: true,
      props: { retry: false },
    });
  });

  it("disables a hidden card or a card without a site", () => {
    useDashboardGrowthAccounting(undefined, "card-7");
    useDashboardGrowthAccounting(42, "card-7", false);
    for (const [options] of mocks.query.mock.calls) expect(options.enabled).toBe(false);
  });
});
