import {
  isCorrelationId,
  isCorrelationTraceId,
  parseRequestCorrelationEvent,
  REQUEST_CORRELATION_TAG,
  type ReplayCorrelationProfile,
  type RequestCorrelationEvent,
} from "@rybbit/shared";
import { replayCorrelationProfileSchema } from "@/api/admin/endpoints/replayCorrelation";
import { requestStartTime } from "./requestRows";

export function getRequestObservabilityLinks(
  event: RequestCorrelationEvent,
  profiles: readonly ReplayCorrelationProfile[]
) {
  const parsed = parseRequestCorrelationEvent({
    type: 5,
    timestamp: event.timestamp,
    data: { tag: REQUEST_CORRELATION_TAG, payload: event.request },
  });
  if (!parsed) return undefined;
  const matches = profiles.filter(profile => profile.requestOrigin === parsed.request.origin);
  if (matches.length !== 1) return undefined;
  const result = replayCorrelationProfileSchema.safeParse(matches[0]);
  if (!result.success) return undefined;
  const profile = result.data;
  const target = new URL(profile.grafanaUrl);
  target.pathname = `${target.pathname.replace(/\/$/, "")}/explore`;
  const range = {
    from: String(Math.max(0, Math.floor(requestStartTime(parsed) - profile.timePaddingMs))),
    to: String(Math.min(8.64e15, Math.ceil(parsed.timestamp + profile.timePaddingMs))),
  };
  const explore = (pane: string, type: string, uid: string, query: Record<string, string>) => {
    const url = new URL(target);
    url.search = new URLSearchParams({
      schemaVersion: "1",
      orgId: String(profile.orgId),
      panes: JSON.stringify({
        [pane]: { datasource: uid, queries: [{ refId: "A", datasource: { type, uid }, ...query }], range },
      }),
    }).toString();
    return url.href;
  };
  return {
    logs: isCorrelationId(parsed.request.correlationId)
      ? explore("logs", "loki", profile.lokiDatasourceUid, {
          expr: `{service_name=${JSON.stringify(profile.serviceName)}, deployment_environment=${JSON.stringify(profile.environment)}} | http_correlation_id=${JSON.stringify(parsed.request.correlationId)}`,
          queryType: "range",
        })
      : undefined,
    trace:
      isCorrelationTraceId(parsed.request.traceId) && profile.tempoDatasourceUid
        ? explore("trace", "tempo", profile.tempoDatasourceUid, {
            query: parsed.request.traceId,
            queryType: "traceId",
          })
        : undefined,
  };
}
