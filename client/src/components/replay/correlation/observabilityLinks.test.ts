import { describe, expect, it } from "vitest";
import { REQUEST_CORRELATION_TAG, type ReplayCorrelationProfile, type RequestCorrelationEvent } from "@rybbit/shared";
import { getRequestObservabilityLinks } from "./observabilityLinks";
import { getRequestCorrelationRows, requestStartTime } from "./requestRows";

const event: RequestCorrelationEvent = {
  timestamp: 1_800_000,
  request: {
    rowId: "r1",
    transport: "fetch",
    method: "GET",
    origin: "https://api.example.com",
    pathname: "/players",
    status: 200,
    outcome: "response",
    durationMs: 1200,
    correlationId: "req:123-abc",
    traceId: "1234567890abcdef1234567890abcdef",
  },
};
const profile: ReplayCorrelationProfile = {
  requestOrigin: event.request.origin,
  grafanaUrl: "https://grafana.example.com/observability/",
  orgId: 2,
  lokiDatasourceUid: "logs-1",
  tempoDatasourceUid: "traces-1",
  serviceName: "backend",
  environment: "production",
  timePaddingMs: 5000,
};
const native = (value = event) => ({
  type: 5,
  timestamp: value.timestamp,
  data: { tag: REQUEST_CORRELATION_TAG, payload: value.request },
});

describe("request correlation rows", () => {
  it("accepts native custom events, preserves parallel shared IDs, and deduplicates only row ID", () => {
    const second = { ...event, timestamp: event.timestamp + 1, request: { ...event.request, rowId: "r2" } };
    expect(
      getRequestCorrelationRows([
        {},
        native(second),
        native(event),
        native(event),
        { ...native(), data: { tag: "other", payload: event.request } },
      ])
    ).toEqual([event, second]);
    expect(requestStartTime(event)).toBe(1_798_800);
  });
  it("caps valid unique rows without altering historical recordings", () => {
    expect(getRequestCorrelationRows([])).toEqual([]);
    expect(
      getRequestCorrelationRows(
        Array.from({ length: 2005 }, (_, i) => native({ ...event, request: { ...event.request, rowId: `r${i}` } }))
      )
    ).toHaveLength(2000);
  });
});

describe("direct Grafana Explore links", () => {
  it("uses configured base path/org/datasource and the corrected completion minus duration window", () => {
    const links = getRequestObservabilityLinks(event, [profile])!;
    const url = new URL(links.logs!);
    expect(url.origin + url.pathname).toBe("https://grafana.example.com/observability/explore");
    expect(url.searchParams.get("orgId")).toBe("2");
    const pane = JSON.parse(url.searchParams.get("panes")!).logs;
    expect(pane.range).toEqual({ from: "1793800", to: "1805000" });
    expect(pane.queries).toEqual([
      {
        refId: "A",
        datasource: { type: "loki", uid: "logs-1" },
        queryType: "range",
        expr: '{service_name="backend", deployment_environment="production"} | http_correlation_id="req:123-abc"',
      },
    ]);
    const trace = JSON.parse(new URL(links.trace!).searchParams.get("panes")!).trace;
    expect(trace.queries[0]).toMatchObject({
      query: event.request.traceId,
      queryType: "traceId",
      datasource: { type: "tempo", uid: "traces-1" },
    });
  });
  it.each([
    "http://grafana.example.com",
    "javascript:alert(1)",
    "https://name:secret@grafana.example.com",
    "https://grafana.example.com?redirect=evil",
    "https://grafana.example.com/#fragment",
  ])("rejects unsafe Grafana URL %s", grafanaUrl => {
    expect(getRequestObservabilityLinks(event, [{ ...profile, grafanaUrl }])).toBeUndefined();
  });
  it("requires one exact origin profile and valid IDs, never inventing correlation", () => {
    expect(getRequestObservabilityLinks(event, [])).toBeUndefined();
    expect(getRequestObservabilityLinks(event, [profile, profile])).toBeUndefined();
    expect(
      getRequestObservabilityLinks(event, [{ ...profile, requestOrigin: "https://other.example.com" }])
    ).toBeUndefined();
    expect(
      getRequestObservabilityLinks(
        { ...event, request: { ...event.request, correlationId: undefined, traceId: undefined } },
        [profile]
      )
    ).toEqual({ logs: undefined, trace: undefined });
    expect(
      getRequestObservabilityLinks({ ...event, request: { ...event.request, correlationId: 'x"} | json' } }, [profile])
    ).toBeUndefined();
    expect(getRequestObservabilityLinks(event, [{ ...profile, environment: 'prod"}' }])).toBeUndefined();
    expect(getRequestObservabilityLinks(event, [{ ...profile, timePaddingMs: 300001 }])).toBeUndefined();
  });
  it("bounds dates at the supported date range and permits logs without Tempo", () => {
    const start = getRequestObservabilityLinks({ ...event, timestamp: 1 }, [
      { ...profile, tempoDatasourceUid: undefined },
    ])!;
    expect(JSON.parse(new URL(start.logs!).searchParams.get("panes")!).logs.range.from).toBe("0");
    expect(start.trace).toBeUndefined();
    const end = getRequestObservabilityLinks({ ...event, timestamp: 8.64e15 }, [profile])!;
    expect(JSON.parse(new URL(end.logs!).searchParams.get("panes")!).logs.range.to).toBe("8640000000000000");
  });
});
