import { TimeBucket } from "@rybbit/shared";
import { useQueries } from "@tanstack/react-query";
import { buildAnalyticsQueryKey, buildAnalyticsRequest, fetchAnalytics } from "@/api/analytics/analyticsRequest";
import { GetOverviewBucketedResponse } from "@/api/analytics/endpoints";
import { useRollupQueryContext, useSettledSnapshot } from "./useRollupQueryContext";

export type RollupSeries = {
  siteId: number;
  data: GetOverviewBucketedResponse;
};

export type UseRollupBucketedResult = {
  series: RollupSeries[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
};

export function useRollupBucketed({
  siteIds,
  bucket,
  lite = false,
}: {
  siteIds: number[];
  bucket: TimeBucket;
  lite?: boolean;
}): UseRollupBucketedResult {
  const context = useRollupQueryContext(lite);
  const request = buildAnalyticsRequest(
    { path: lite ? "overview-bucketed-lite" : "overview/time-series", params: { bucket } },
    context
  );

  const { queries, series } = useQueries({
    queries: siteIds.map(siteId => ({
      queryKey: buildAnalyticsQueryKey("rollup-overview-bucketed", siteId, request),
      queryFn: () => fetchAnalytics<GetOverviewBucketedResponse>(siteId, request),
      staleTime: 60_000,
    })),
    combine: queries => ({
      queries,
      series: queries
        .map((q, i) => ({ siteId: siteIds[i], data: q.data }))
        .filter((s): s is RollupSeries => Array.isArray(s.data)),
    }),
  });
  const settled = useSettledSnapshot(series, queries, request.accessScope);

  return {
    series: settled.data ?? [],
    isLoading: settled.isLoading,
    isFetching: queries.some(q => q.isFetching),
    error: (queries.find(q => q.error)?.error as Error) ?? null,
  };
}
