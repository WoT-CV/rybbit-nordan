export const REQUEST_CORRELATION_TAG = "wotcv/request-correlation@1";

export interface RequestCorrelationPayload {
  rowId: string;
  transport: "fetch" | "xhr";
  method: string;
  origin: string;
  pathname: string;
  status: number;
  outcome: "response" | "network-error" | "abort" | "timeout";
  durationMs: number;
  correlationId?: string;
  traceId?: string;
}

export interface RequestCorrelationEvent {
  timestamp: number;
  request: RequestCorrelationPayload;
}

export interface ReplayCorrelationProfile {
  requestOrigin: string;
  grafanaUrl: string;
  orgId: number;
  lokiDatasourceUid: string;
  tempoDatasourceUid?: string;
  serviceName: string;
  environment: string;
  timePaddingMs: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isCorrelationId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !/\s/.test(value);

export const isCorrelationTraceId = (value: unknown): value is string =>
  typeof value === "string" && value.length === 32 && /^[a-fA-F0-9]{32}$/.test(value) && !/^0{32}$/.test(value);

export function parseRequestCorrelationEvent(value: unknown): RequestCorrelationEvent | undefined {
  if (
    !object(value) ||
    (value.type !== 5 && value.type !== "5") ||
    !object(value.data) ||
    value.data.tag !== REQUEST_CORRELATION_TAG
  )
    return;
  const timestamp = value.timestamp;
  const payload = value.data.payload;
  if (
    !Number.isSafeInteger(timestamp) ||
    (timestamp as number) <= 0 ||
    (timestamp as number) > 8.64e15 ||
    !object(payload)
  )
    return;
  const { rowId, transport, method, origin, pathname, status, outcome, durationMs, correlationId, traceId } = payload;
  if (typeof rowId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(rowId) || /\s/.test(rowId)) return;
  if (transport !== "fetch" && transport !== "xhr") return;
  if (typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method) || /\s/.test(method)) return;
  if (typeof origin !== "string" || origin.length > 256) return;
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || origin !== url.origin) return;
  } catch {
    return;
  }
  if (
    typeof pathname !== "string" ||
    pathname.length > 2048 ||
    !pathname.startsWith("/") ||
    /[?#\u0000-\u001f\u007f]/.test(pathname)
  )
    return;
  if (!Number.isInteger(status) || (status as number) < 0 || (status as number) > 599) return;
  if (!["response", "network-error", "abort", "timeout"].includes(outcome as string)) return;
  if (outcome === "response" ? (status as number) < 100 : status !== 0) return;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 3_600_000)
    return;
  if (correlationId !== undefined && !isCorrelationId(correlationId)) return;
  if (traceId !== undefined && !isCorrelationTraceId(traceId)) return;
  return {
    timestamp: timestamp as number,
    request: {
      rowId,
      transport,
      method,
      origin,
      pathname,
      status: status as number,
      outcome: outcome as RequestCorrelationPayload["outcome"],
      durationMs,
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(traceId !== undefined ? { traceId: traceId.toLowerCase() } : {}),
    },
  };
}
