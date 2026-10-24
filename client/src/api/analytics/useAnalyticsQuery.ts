import { Filter } from "@rybbit/shared";
import {
  InfiniteData,
  useInfiniteQuery,
  UseInfiniteQueryResult,
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { Time } from "../../components/DateSelector/types";
import { useStore, useTimezone } from "../../lib/store";
import { getRequestPrivateKey } from "../requestContext";
import {
  AnalyticsContext,
  AnalyticsDescriptor,
  buildAnalyticsQueryKey,
  buildAnalyticsRequest,
  fetchAnalytics,
} from "./analyticsRequest";

type PeriodTime = "current" | "previous";

export interface AnalyticsContextOptions {
  // Override the store's current site (e.g. multi-site overview cards).
  site?: number | string;
  periodTime?: PeriodTime;
  // Query a specific time range instead of the store's; ignored when
  // periodTime is "previous" (the store's comparison period wins).
  overrideTime?: Time;
  // Previous period in past-minutes mode means [2x .. 1x] minutes ago.
  doublePastMinutesForPrevious?: boolean;
  // Endpoints that are not scoped to the selected period (trait keys, saved
  // funnels) send no window and do not refetch when the date selector moves.
  useTime?: boolean;
  useFilters?: boolean;
  // Appended to the store filters.
  additionalFilters?: Filter[];
  // Replace the store filters entirely (when non-empty).
  customFilters?: Filter[];
}

/**
 * Resolves the analytics request context (site, time period, filters) from the
 * store once and derives the request from it — path plus the exact params that
 * go on the wire. The queryKey is built from that same request, so it is in
 * sync with what is sent by construction: a hook can no longer forget to list
 * an input and silently serve stale data.
 *
 * The store is read through selectors so a `selectedStat` or `bucket` change
 * does not re-render every analytics hook on the page.
 */
export function useAnalyticsContext(options: AnalyticsContextOptions = {}): {
  site: number | string;
  context: AnalyticsContext;
  /** False when the request has no window to ask for — comparison turned off. */
  hasPeriod: boolean;
} {
  const storeSite = useStore(state => state.site);
  const time = useStore(state => state.time);
  const previousTime = useStore(state => state.previousTime);
  const filters = useStore(state => state.filters);
  // The URL resolver is authoritative, including the render before the layout
  // syncs its store. Subscribe to that sync so same-site link changes refetch.
  useStore(state => state.privateKey);
  const privateKey = getRequestPrivateKey();
  const timeZone = useTimezone();

  const site = options.site ?? storeSite;

  const baseTime = options.overrideTime ?? time;
  // A comparison of "none" leaves previousTime null: there is no window to ask
  // about, so the query is disabled rather than falling through to all-time.
  let timeToUse = options.periodTime === "previous" ? previousTime : baseTime;

  if (options.doublePastMinutesForPrevious && options.periodTime === "previous" && timeToUse?.mode === "past-minutes") {
    timeToUse = {
      ...timeToUse,
      pastMinutesStart: timeToUse.pastMinutesStart * 2,
      pastMinutesEnd: timeToUse.pastMinutesStart,
    };
  }

  const useFilters = options.useFilters ?? true;
  const combinedFilters = !useFilters
    ? undefined
    : options.customFilters?.length
      ? options.customFilters
      : options.additionalFilters?.length
        ? [...filters, ...options.additionalFilters]
        : filters;

  return {
    site,
    hasPeriod: timeToUse !== null,
    context: {
      time: (options.useTime ?? true) && timeToUse ? timeToUse : null,
      timeZone,
      filters: combinedFilters,
      privateKey,
    },
  };
}

function useAnalyticsRequest(options: AnalyticsContextOptions & AnalyticsDescriptor) {
  const { site, context, hasPeriod } = useAnalyticsContext(options);
  const request = buildAnalyticsRequest(options, context);
  const scope = request.organizationId === undefined ? site : `organization:${request.organizationId}`;
  const hasScope = request.organizationId === undefined ? !!site : !!request.organizationId;
  return { site, scope, hasScope, hasPeriod, request };
}

export interface AnalyticsQueryOptions<TData> extends AnalyticsContextOptions, AnalyticsDescriptor {
  // First element(s) of the queryKey. Keep the historical name — mutations
  // invalidate by this prefix (e.g. ["users"], ["user-info", userId]).
  key: string | readonly unknown[];
  staleTime?: number;
  refetchInterval?: number;
  enabled?: boolean;
  // Same-site placeholder policy: keep showing the previous result while a
  // changed key (time/filter tweak) refetches. Site changes still hard-reset.
  placeholder?: boolean;
  props?: Partial<UseQueryOptions<TData, Error>>;
}

export function useAnalyticsQuery<TData>(options: AnalyticsQueryOptions<TData>): UseQueryResult<TData> {
  const { site, scope, hasScope, request, hasPeriod } = useAnalyticsRequest(options);
  const { placeholderData: callerPlaceholder, ...props } = options.props ?? {};

  return useQuery<TData, Error>({
    queryKey: buildAnalyticsQueryKey(options.key, scope, request),
    queryFn: () => fetchAnalytics<TData>(site!, request),
    staleTime: options.staleTime ?? 60_000,
    refetchInterval: options.refetchInterval,
    enabled: (options.enabled ?? true) && hasScope && hasPeriod,
    ...props,
    // A caller may narrow the same-context policy (e.g. to the same user),
    // but it must never bypass site or private-link credential isolation.
    placeholderData:
      callerPlaceholder !== undefined || (options.placeholder ?? true)
        ? (previousData, previousQuery) => {
            if (
              scope === undefined ||
              previousQuery?.queryKey.at(-4) !== scope ||
              (previousQuery.queryKey.at(-2) as { accessScope?: string } | undefined)?.accessScope !==
                request.accessScope
            )
              return undefined;

            if (typeof callerPlaceholder === "function") {
              const placeholder = callerPlaceholder as (
                data: typeof previousData,
                query: typeof previousQuery
              ) => typeof previousData;
              return placeholder(previousData, previousQuery);
            }
            return callerPlaceholder === undefined ? previousData : (callerPlaceholder as typeof previousData);
          }
        : undefined,
  });
}

export interface AnalyticsInfiniteQueryOptions<TPage, TCursor> extends AnalyticsContextOptions, AnalyticsDescriptor {
  key: string | readonly unknown[];
  initialPageParam: TCursor;
  // Params that position the request at `cursor` (a page number, an offset, a
  // timestamp) — merged into the descriptor params for that page.
  pageParams: (cursor: TCursor) => Record<string, unknown>;
  getNextPageParam: (lastPage: TPage, allPages: TPage[]) => TCursor | undefined;
  staleTime?: number;
  refetchInterval?: number;
  enabled?: boolean;
  refetchOnWindowFocus?: boolean;
  // Hand the query's abort signal to the request. Cancelling the query (or unmounting its last
  // observer) then aborts the request and stops a refetch before it walks the remaining pages.
  abortable?: boolean;
}

export function useAnalyticsInfiniteQuery<TPage, TCursor = number>(
  options: AnalyticsInfiniteQueryOptions<TPage, TCursor>
): UseInfiniteQueryResult<InfiniteData<TPage>> {
  const { site, scope, hasScope, request, hasPeriod } = useAnalyticsRequest(options);

  return useInfiniteQuery<TPage, Error, InfiniteData<TPage>, readonly unknown[], TCursor>({
    queryKey: [...buildAnalyticsQueryKey(options.key, scope, request), "infinite"],
    // `signal` is read only when abortable: reading it is what opts a query into cancellation.
    queryFn: context =>
      fetchAnalytics<TPage>(
        site!,
        { ...request, params: { ...request.params, ...options.pageParams(context.pageParam as TCursor) } },
        options.abortable ? context.signal : undefined
      ),
    initialPageParam: options.initialPageParam,
    getNextPageParam: options.getNextPageParam,
    staleTime: options.staleTime ?? 60_000,
    refetchInterval: options.refetchInterval,
    refetchOnWindowFocus: options.refetchOnWindowFocus,
    enabled: (options.enabled ?? true) && hasScope && hasPeriod,
  });
}

/** Page-numbered pagination over an endpoint that reports a `totalCount`. */
export const nextPageByTotalCount = <TPage extends { data: unknown[]; totalCount: number }>(
  lastPage: TPage,
  allPages: TPage[]
): number | undefined => {
  const fetched = allPages.reduce((total, page) => total + page.data.length, 0);
  return fetched >= lastPage.totalCount ? undefined : allPages.length + 1;
};
