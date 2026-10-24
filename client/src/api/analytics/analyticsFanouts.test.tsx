import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FilterValueSitesContext,
  useFilterValueOptions,
} from "../../app/[site]/components/SubHeader/Filters/useFilterValueOptions";
import { useTimelineSessions } from "../../app/[site]/globe/3d/hooks/timelineLayer/useTimelineSessions";
import { useTimelineStore } from "../../app/[site]/globe/timelineStore";
import { useRollupBucketed } from "../../app/rollup/hooks/useRollupBucketed";
import { useRollupMetric } from "../../app/rollup/hooks/useRollupMetric";
import { useRollupOverview } from "../../app/rollup/hooks/useRollupOverview";
import { useStore } from "../../lib/store";
import { setPrivateKeyResolver } from "../requestContext";
import type { AnalyticsRequest } from "./analyticsRequest";
import { useAutocaptureValuesByType } from "./hooks/events/useAutocaptureValues";
import { useNewEventsPoll } from "./hooks/events/useGetEvents";

const mocks = vi.hoisted(() => ({ fetchAnalytics: vi.fn() }));
vi.mock("./analyticsRequest", async importOriginal => ({
  ...(await importOriginal<typeof import("./analyticsRequest")>()),
  fetchAnalytics: mocks.fetchAnalytics,
}));

let queryClient: QueryClient;
const wrapper = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>
    <FilterValueSitesContext.Provider value={[1]}>{children}</FilterValueSitesContext.Provider>
  </QueryClientProvider>
);

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useStore.setState({ ...useStore.getInitialState(), site: "1", privateKey: "valid-secret", timezone: "UTC" });
  useTimelineStore.getState().reset();
  setPrivateKeyResolver(() => useStore.getState().privateKey);
  mocks.fetchAnalytics.mockReset().mockImplementation((_site, request: AnalyticsRequest) => {
    if (request.privateKey !== "valid-secret") return new Promise(() => {});
    switch (request.path) {
      case "events/autocapture-values":
        return Promise.resolve([{ value: "private-button", count: 1 }]);
      case "events":
        return Promise.resolve({ data: [{ pathname: "/private" }] });
      case "metric":
        return Promise.resolve({ data: [{ value: "/private", count: 1, percentage: 100 }], totalCount: 1 });
      case "overview":
        return Promise.resolve({ sessions: 1, users: 1, pageviews: 1 });
      case "overview/time-series":
        return Promise.resolve([{ time: "2026-10-24", sessions: 1 }]);
      case "sessions":
        return Promise.resolve([
          {
            session_id: "private-session",
            session_start: "2026-10-24 10:00:00",
            session_end: "2026-10-24 10:01:00",
          },
        ]);
      default:
        throw new Error(`Unexpected analytics path: ${request.path}`);
    }
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  setPrivateKeyResolver(() => null);
  useTimelineStore.getState().reset();
});

describe("manual analytics query consumers", () => {
  it("partitions fan-outs, event polling, timeline state and settled rollups by credential context", async () => {
    const { result } = renderHook(
      () => {
        useTimelineSessions();
        return {
          autocapture: useAutocaptureValuesByType(new Set(["button_click"])),
          events: useNewEventsPoll({ getSinceTimestamp: () => "2026-10-24 10:00:00", enabled: true }),
          filters: useFilterValueOptions("pathname"),
          overview: useRollupOverview({ siteIds: [1] }),
          metric: useRollupMetric({ siteIds: [1], parameter: "pathname" }),
          bucketed: useRollupBucketed({ siteIds: [1], bucket: "hour" }),
        };
      },
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.autocapture.button_click).toHaveLength(1);
      expect(result.current.events.data?.data).toHaveLength(1);
      expect(result.current.filters.data?.data).toHaveLength(1);
      expect(result.current.overview.overviews).toHaveLength(1);
      expect(result.current.metric.data).toHaveLength(1);
      expect(result.current.bucketed.series).toHaveLength(1);
      expect(useTimelineStore.getState().allSessions).toHaveLength(1);
    });

    act(() => useStore.getState().setPrivateKey("invalid-secret"));
    expect(result.current.autocapture.button_click).toBeUndefined();
    expect(result.current.events.data).toBeUndefined();
    expect(result.current.filters.data?.data).toEqual([]);
    expect(result.current.overview.overviews).toEqual([]);
    expect(result.current.metric.data).toEqual([]);
    expect(result.current.bucketed.series).toEqual([]);
    expect(useTimelineStore.getState().allSessions).toEqual([]);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map(query => query.queryKey)
      )
    ).not.toContain("secret");
  });
});
