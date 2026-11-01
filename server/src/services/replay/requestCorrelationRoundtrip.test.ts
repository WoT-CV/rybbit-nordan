import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRequestCorrelationEvent, REQUEST_CORRELATION_TAG } from "@rybbit/shared";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  query: vi.fn(),
  storeBatch: vi.fn(),
  getBatch: vi.fn(),
  r2Enabled: false,
}));
vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouse: { insert: mocks.insert, query: mocks.query } }));
// Keep the real processResults used by the native query service; never connect to PG.
vi.mock("../../db/postgres/postgres.js", () => ({ db: {} }));
vi.mock("../sessions/sessionsService.js", () => ({
  sessionsService: {
    resolveReplaySession: vi.fn().mockResolvedValue({ sessionId: "session-fixture" }),
  },
}));
vi.mock("../userId/userIdService.js", () => ({
  userIdService: {
    generateUserId: vi.fn().mockResolvedValue("device-fixture"),
  },
}));
vi.mock("../storage/r2StorageService.js", () => ({
  r2Storage: {
    isEnabled: () => mocks.r2Enabled,
    storeBatch: mocks.storeBatch,
    getBatch: mocks.getBatch,
  },
}));
vi.mock("./replaySessionBudget.js", () => ({
  chargeReplaySessionBudget: vi.fn().mockResolvedValue({ accepted: true }),
}));
vi.mock("../../lib/siteConfig.js", () => ({ siteConfig: {} }));

import { SessionReplayIngestService } from "./sessionReplayIngestService.js";
import { SessionReplayQueryService } from "./sessionReplayQueryService.js";

describe("correlation through native replay serialization and clock correction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    mocks.r2Enabled = false;
    mocks.insert.mockResolvedValue(undefined);
    mocks.storeBatch.mockResolvedValue("fixture-batch");
  });
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("preserves IDs/duration through real ingest and query (R2=%s)", async useR2 => {
    mocks.r2Enabled = useR2;
    const timestamp = Date.now() + 365 * 86_400_000;
    const request = {
      rowId: "parallel-request-1",
      transport: "fetch",
      method: "POST",
      origin: "https://api.example.invalid",
      pathname: "/customers/register",
      status: 201,
      outcome: "response",
      durationMs: 123,
      correlationId: "correlation-fixture",
      traceId: "1234567890abcdef1234567890abcdef",
    };
    const data = { tag: REQUEST_CORRELATION_TAG, payload: request };
    await new SessionReplayIngestService().recordEvents(
      17,
      {
        userId: "000123",
        events: [{ type: 5, timestamp, data }],
      },
      { ipAddress: "192.0.2.1", userAgent: "fixture", origin: "https://frontend.example.invalid", referrer: "" }
    );

    const rows = mocks.insert.mock.calls.find(([call]) => call.table === "session_replay_events")![0].values;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site_id: 17, session_id: "session-fixture", identified_user_id: "000123" });
    expect(rows[0].event_size_bytes).toBe(JSON.stringify(data).length);
    const storedData = useR2 ? mocks.storeBatch.mock.calls[0][2][0] : rows[0].event_data;
    expect(JSON.parse(storedData)).toEqual(data);
    // Simulate the real CH wire representation, not the recorder's numeric type.
    mocks.query.mockResolvedValueOnce({ json: async () => [{ site_id: 17, session_id: "session-fixture" }] });
    mocks.query.mockResolvedValueOnce({
      json: async () => [
        {
          timestamp: Date.parse(rows[0].timestamp),
          type: String(rows[0].event_type),
          data: rows[0].event_data,
          event_data_key: rows[0].event_data_key,
          batch_index: rows[0].batch_index,
        },
      ],
    });
    mocks.getBatch.mockResolvedValue([JSON.parse(storedData)]);

    const result = await new SessionReplayQueryService().getSessionReplayEvents(17, "session-fixture");
    expect(result.events).toHaveLength(1);
    const parsed = parseRequestCorrelationEvent(result.events[0]);
    expect(parsed?.request).toEqual(request);
    expect(parsed?.timestamp).toBe(Date.now());
    expect(parsed!.timestamp - parsed!.request.durationMs).toBe(Date.now() - 123);
    expect(mocks.query.mock.calls.every(([call]) => call.query_params.siteId === 17)).toBe(true);
    expect(mocks.query.mock.calls.every(([call]) => call.query_params.sessionId === "session-fixture")).toBe(true);
  });
});
