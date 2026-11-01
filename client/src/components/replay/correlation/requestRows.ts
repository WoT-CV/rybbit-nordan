import { parseRequestCorrelationEvent, type RequestCorrelationEvent } from "@rybbit/shared";

export function getRequestCorrelationRows(events: readonly unknown[]): RequestCorrelationEvent[] {
  const rows: RequestCorrelationEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const row = parseRequestCorrelationEvent(event);
    if (!row || seen.has(row.request.rowId)) continue;
    seen.add(row.request.rowId);
    rows.push(row);
    if (rows.length === 2000) break;
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

export function requestStartTime(event: RequestCorrelationEvent): number {
  return event.timestamp - event.request.durationMs;
}
