import { useStore } from "../../../lib/store";
import { GrowthAccountingResponse, RetentionMode } from "../endpoints";
import { useAnalyticsQuery } from "../useAnalyticsQuery";

export function useGetGrowthAccounting(mode: RetentionMode = "day", range: number = 90) {
  return useAnalyticsQuery<GrowthAccountingResponse>({
    key: "growth-accounting",
    path: "growth-accounting",
    params: { mode, range },
    unwrap: false,
    useTime: false,
    useFilters: false,
    placeholder: false,
  });
}

export function useDashboardGrowthAccounting(siteId: string | number | undefined, cardId: string, enabled = true) {
  const bucket = useStore(state => state.bucket);
  const mode: RetentionMode = bucket === "week" || bucket === "month" || bucket === "year" ? "week" : "day";

  return useAnalyticsQuery<GrowthAccountingResponse>({
    key: ["dashboard-growth-accounting", cardId],
    path: "growth-accounting",
    site: siteId,
    params: { mode, range: 365 },
    unwrap: false,
    useFilters: false,
    enabled: enabled && !!siteId,
    props: { retry: false },
  });
}
