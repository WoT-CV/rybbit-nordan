import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { toClickHouseDateTime } from "../../db/clickhouse/dateTime.js";
import { REPLAY_BUDGET_LUA } from "../../db/redis/replayBudgetLua.js";
import type { RecordSessionReplayRequest } from "../../types/sessionReplay.js";

const mocks = vi.hoisted(() => ({
  generateUserId: vi.fn(),
  generateUserIdFromClientId: vi.fn(),
  insert: vi.fn(),
  query: vi.fn(),
  updateSession: vi.fn(),
  chargeReplaySessionBudget: vi.fn(),
  replayBudgetCharge: vi.fn(),
  storeBatch: vi.fn(),
  r2Enabled: false,
}));

vi.mock("../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: {
    insert: mocks.insert,
    query: mocks.query,
  },
}));

vi.mock("../sessions/sessionsService.js", () => ({
  sessionsService: {
    updateSession: mocks.updateSession,
  },
}));

vi.mock("../userId/userIdService.js", () => ({
  userIdService: {
    generateUserId: mocks.generateUserId,
    generateUserIdFromClientId: mocks.generateUserIdFromClientId,
  },
}));

vi.mock("../storage/r2StorageService.js", () => ({
  r2Storage: {
    isEnabled: () => mocks.r2Enabled,
    storeBatch: mocks.storeBatch,
  },
}));

vi.mock("./replaySessionBudget.js", () => ({
  chargeReplaySessionBudget: mocks.chargeReplaySessionBudget,
}));

vi.mock("../../db/redis/redis.js", () => ({
  replayBudgetRedis: { status: "ready" },
  replayBudgetCharge: mocks.replayBudgetCharge,
}));

vi.mock("../../lib/siteConfig.js", () => ({
  siteConfig: {},
}));

import { SessionReplayIngestService } from "./sessionReplayIngestService.js";

const requestMeta = {
  ipAddress: "198.51.100.10",
  userAgent: "Standardized Corporate Browser/1.0",
  origin: "https://internal.example",
  referrer: "",
};

function replayRequest(identifiedUserId: string, anonymousId?: string): RecordSessionReplayRequest {
  return {
    anonymousId,
    userId: identifiedUserId,
    events: [{ type: 2, data: { user: identifiedUserId }, timestamp: 1_700_000_000_000 }],
  };
}

describe("SessionReplayIngestService identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUserId.mockResolvedValue("shared-fingerprint");
    mocks.generateUserIdFromClientId.mockImplementation(async anonymousId => `fingerprint-${anonymousId}`);
    mocks.updateSession.mockImplementation(
      async ({ userId, identifiedUserId }: { userId: string; identifiedUserId?: string }) => ({
        sessionId: `session-${userId}-${identifiedUserId || "anonymous"}`,
      })
    );
    mocks.insert.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({
      json: async () => [
        {
          start_time: "2026-08-23 10:00:00",
          end_time: "2026-08-23 10:00:01",
          event_count: "1",
          compressed_size_bytes: "20",
          screen_width: "1920",
          screen_height: "1080",
        },
      ],
    });
    mocks.chargeReplaySessionBudget.mockResolvedValue({ accepted: true, usedBytes: 0 });
    mocks.r2Enabled = false;
  });

  it("separates identified replay users behind a shared proxy", async () => {
    const service = new SessionReplayIngestService();

    await service.recordEvents(42, replayRequest("employee-alice", "browser-alice"), requestMeta);
    await service.recordEvents(42, replayRequest("employee-bob", "browser-bob"), requestMeta);

    expect(mocks.updateSession).toHaveBeenNthCalledWith(1, {
      userId: "fingerprint-browser-alice",
      identifiedUserId: "employee-alice",
      siteId: 42,
    });
    expect(mocks.updateSession).toHaveBeenNthCalledWith(2, {
      userId: "fingerprint-browser-bob",
      identifiedUserId: "employee-bob",
      siteId: 42,
    });

    const insertedRows = mocks.insert.mock.calls.flatMap(call => call[0].values);
    expect(new Set(insertedRows.map(row => row.user_id))).toEqual(
      new Set(["fingerprint-browser-alice", "fingerprint-browser-bob"])
    );
    expect(new Set(insertedRows.map(row => row.identified_user_id))).toEqual(
      new Set(["employee-alice", "employee-bob"])
    );
    expect(new Set(insertedRows.map(row => row.session_id)).size).toBe(2);
    expect(mocks.generateUserId).not.toHaveBeenCalled();
    expect(mocks.generateUserIdFromClientId).toHaveBeenNthCalledWith(1, "browser-alice", 42);
    expect(mocks.generateUserIdFromClientId).toHaveBeenNthCalledWith(2, "browser-bob", 42);
  });

  it("retains the existing anonymous replay session key", async () => {
    const service = new SessionReplayIngestService();

    await service.recordEvents(42, replayRequest(""), requestMeta);

    expect(mocks.generateUserId).toHaveBeenCalledWith(requestMeta.ipAddress, requestMeta.userAgent, 42);
    expect(mocks.updateSession).toHaveBeenCalledWith({
      userId: "shared-fingerprint",
      identifiedUserId: "",
      siteId: 42,
    });
  });

  it.each([
    ["v1", ["session_replay_events", "session_replay_metadata"], 1],
    ["dual", ["session_replay_events", "session_replay_metadata", "session_replay_metadata_v2"], 1],
    ["v2", ["session_replay_events", "session_replay_metadata_v2"], 0],
  ] as const)("writes the expected metadata tables in %s mode", async (mode, expectedTables, expectedReads) => {
    const service = new SessionReplayIngestService(mode);
    const request = replayRequest("employee-alice", "browser-alice");
    request.metadata = {
      pageUrl: "https://example.test/dashboard",
      viewportWidth: 1920,
      viewportHeight: 1080,
      language: "pl",
    };

    await service.recordEvents(42, request);

    expect(mocks.insert.mock.calls.map(call => call[0].table)).toEqual(expectedTables);
    expect(mocks.query).toHaveBeenCalledTimes(expectedReads);
    const rowsByTable = new Map(mocks.insert.mock.calls.map(call => [call[0].table, call[0].values[0]]));
    if (mode !== "v2") {
      expect(rowsByTable.get("session_replay_metadata")).toMatchObject({
        start_time: "2026-08-23 10:00:00",
        end_time: "2026-08-23 10:00:01",
        event_count: 1,
        compressed_size_bytes: 20,
      });
    }
    if (mode !== "v1") {
      expect(rowsByTable.get("session_replay_metadata_v2")).toMatchObject({
        event_count: request.events.length,
        compressed_size_bytes: Buffer.byteLength(JSON.stringify(request.events[0].data), "utf8"),
      });
    }
  });
});

describe("SessionReplayIngestService size cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUserId.mockResolvedValue("fingerprint");
    mocks.updateSession.mockResolvedValue({ sessionId: "session-1" });
    mocks.insert.mockResolvedValue(undefined);
    mocks.storeBatch.mockResolvedValue("r2-key");
    mocks.r2Enabled = true;
  });

  it("charges the serialized size of the batch against its session", async () => {
    mocks.chargeReplaySessionBudget.mockResolvedValue({ accepted: true, usedBytes: 100 });
    const service = new SessionReplayIngestService();
    const request: RecordSessionReplayRequest = {
      userId: "",
      events: [
        { type: 2, data: { a: 1 }, timestamp: 1_700_000_000_000 },
        { type: 3, data: { bb: "xy" }, timestamp: 1_700_000_000_100 },
      ],
    };

    const result = await service.recordEvents(42, request, requestMeta);

    const expectedBytes = Buffer.byteLength(JSON.stringify({ a: 1 })) + Buffer.byteLength(JSON.stringify({ bb: "xy" }));
    expect(mocks.chargeReplaySessionBudget).toHaveBeenCalledWith(
      42,
      "session-1",
      expectedBytes,
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    expect(result).toEqual({ capped: false });
    expect(mocks.storeBatch).toHaveBeenCalledOnce();
    expect(
      mocks.insert.mock.calls[0][0].values.map((row: { event_size_bytes: number }) => row.event_size_bytes)
    ).toEqual([Buffer.byteLength(JSON.stringify({ a: 1 })), Buffer.byteLength(JSON.stringify({ bb: "xy" }))]);
  });

  it.each([false, true])("charges UTF-8 bytes and preserves sequence order with R2=%s", async r2Enabled => {
    mocks.r2Enabled = r2Enabled;
    mocks.chargeReplaySessionBudget.mockResolvedValue({ accepted: true, usedBytes: 100 });
    const service = new SessionReplayIngestService("v2");
    const data = [{ text: "Zażółć 🐸 東京" }, { responseBody: { value: "historical ł" } }];
    const timestamp = Date.now() - 100;
    const request: RecordSessionReplayRequest = {
      anonymousId: "browser-unicode",
      userId: "identified-user",
      events: data.map((value, index) => ({ type: 6, data: value, timestamp, sequenceNumber: 50 + index })),
      metadata: { pageUrl: "https://example.com/" },
    };

    await service.recordEvents(42, request);

    const encoded = data.map(value => JSON.stringify(value));
    const sizes = encoded.map(value => Buffer.byteLength(value, "utf8"));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    expect(total).toBeGreaterThan(encoded.reduce((sum, value) => sum + value.length, 0));
    expect(mocks.chargeReplaySessionBudget).toHaveBeenCalledWith(
      42,
      "session-1",
      total,
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    const rows = mocks.insert.mock.calls[0][0].values;
    expect(rows.map((row: { sequence_number: number }) => row.sequence_number)).toEqual([50, 51]);
    expect(rows.map((row: { event_size_bytes: number }) => row.event_size_bytes)).toEqual(sizes);
    expect(rows.map((row: { event_data: string }) => row.event_data)).toEqual(r2Enabled ? ["", ""] : encoded);
    expect(mocks.insert.mock.calls[1][0].values[0].compressed_size_bytes).toBe(total);
    if (r2Enabled) expect(mocks.storeBatch).toHaveBeenCalledWith(42, "session-1", encoded);
    else expect(mocks.storeBatch).not.toHaveBeenCalled();
  });

  it.each(["v1", "dual", "v2"] as const)("stores nothing in any metadata table when %s mode is capped", async mode => {
    mocks.chargeReplaySessionBudget.mockResolvedValue({ accepted: false, usedBytes: 60_000_000 });
    const service = new SessionReplayIngestService(mode);

    await expect(
      service.recordEvents(42, {
        userId: "",
        events: [{ type: 2, data: { a: 1 }, timestamp: Date.now() }],
        metadata: { pageUrl: "https://example.com/" },
      })
    ).resolves.toEqual({ capped: true });

    expect(mocks.storeBatch).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("stores nothing once the session is over its cap", async () => {
    mocks.chargeReplaySessionBudget.mockResolvedValue({ accepted: false, usedBytes: 60_000_000 });
    const service = new SessionReplayIngestService();

    const result = await service.recordEvents(
      42,
      {
        userId: "",
        events: [{ type: 2, data: { a: 1 }, timestamp: 1_700_000_000_000 }],
        metadata: { pageUrl: "https://example.com/" },
      },
      requestMeta
    );

    expect(result).toEqual({ capped: true });
    expect(mocks.storeBatch).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe("SessionReplayIngestService batch serialization", () => {
  // Inside the clock-skew window, so the batch is stored as sent.
  const base = Date.now() - 60_000;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUserId.mockResolvedValue("fingerprint");
    mocks.updateSession.mockResolvedValue({ sessionId: "session-1" });
    mocks.insert.mockResolvedValue(undefined);
    mocks.chargeReplaySessionBudget.mockResolvedValue({ accepted: true, usedBytes: 0 });
    mocks.storeBatch.mockResolvedValue("r2-key");
    mocks.r2Enabled = true;
  });

  it("hands R2 the per-event strings, which join to the serialized data array", async () => {
    const service = new SessionReplayIngestService();
    const events = [
      { type: 2, data: { node: { id: 1, textContent: 'quote " and é' } }, timestamp: base },
      { type: 3, data: { source: 1, positions: [{ x: 1, y: 2 }] }, timestamp: base + 10 },
      { type: 4, data: null, timestamp: base + 20 },
    ];

    await service.recordEvents(42, { userId: "", events }, requestMeta);

    const serialized: string[] = mocks.storeBatch.mock.calls[0][2];
    expect(serialized).toEqual(events.map(event => JSON.stringify(event.data)));
    expect(`[${serialized.join(",")}]`).toBe(JSON.stringify(events.map(event => event.data)));
    expect(mocks.insert.mock.calls[0][0].values.map((row: { event_data_key: string }) => row.event_data_key)).toEqual([
      "r2-key",
      "r2-key",
      "r2-key",
    ]);
  });

  it("bounds the metadata row by the earliest and latest event, whatever their order", async () => {
    const service = new SessionReplayIngestService("v2");
    const events = [
      { type: 3, data: {}, timestamp: base + 500 },
      { type: 3, data: {}, timestamp: base },
      { type: 3, data: {}, timestamp: base + 900 },
      { type: 3, data: {}, timestamp: base + 100 },
    ];

    await service.recordEvents(42, { userId: "", events, metadata: { pageUrl: "https://example.com/" } }, requestMeta);

    const metadataRow = mocks.insert.mock.calls[1][0].values[0];
    expect(metadataRow.start_time).toBe(toClickHouseDateTime(new Date(base)));
    expect(metadataRow.end_time).toBe(toClickHouseDateTime(new Date(base + 900)));
    expect(metadataRow.event_count).toBe(4);
  });

  it("records a batch too large to spread into Math.min", async () => {
    // Math.min(...timestamps) overflows the call stack somewhere past ~120k
    // arguments; a small-event batch that size still fits the body limit.
    const service = new SessionReplayIngestService("v2");
    const events = Array.from({ length: 200_000 }, (_, index) => ({ type: 3, data: {}, timestamp: base + index }));

    await service.recordEvents(42, { userId: "", events, metadata: { pageUrl: "https://example.com/" } }, requestMeta);

    const metadataRow = mocks.insert.mock.calls[1][0].values[0];
    expect(metadataRow.start_time).toBe(toClickHouseDateTime(new Date(base)));
    expect(metadataRow.end_time).toBe(toClickHouseDateTime(new Date(base + 199_999)));
  });

  it("serializes each event payload exactly once even when writing R2 and metadata", async () => {
    const toJSON = vi.fn(() => ({ text: "exact bytes 🐸" }));
    const service = new SessionReplayIngestService("v2");

    await service.recordEvents(42, {
      userId: "",
      events: [{ type: 6, data: { toJSON }, timestamp: base, sequenceNumber: 42 }],
      metadata: { pageUrl: "https://example.com/" },
    });

    expect(toJSON).toHaveBeenCalledOnce();
    expect(mocks.storeBatch).toHaveBeenCalledWith(42, "session-1", [JSON.stringify({ text: "exact bytes 🐸" })]);
    expect(mocks.insert.mock.calls[0][0].values[0]).toMatchObject({ sequence_number: 42 });
  });

  it("keeps a retry fingerprint stable when clock correction shifts the stored timestamps", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(base);
    const service = new SessionReplayIngestService("v2");
    const request: RecordSessionReplayRequest = {
      anonymousId: "browser-a",
      userId: "account-a",
      events: [
        { type: 6, data: { text: "same payload" }, timestamp: base + 90 * 24 * 60 * 60 * 1000, sequenceNumber: 1 },
      ],
    };
    try {
      await service.recordEvents(42, request);
      now.mockReturnValue(base + 30_000);
      await service.recordEvents(42, request);
      expect(mocks.chargeReplaySessionBudget.mock.calls[0][3]).toBe(mocks.chargeReplaySessionBudget.mock.calls[1][3]);
      expect(mocks.insert.mock.calls[0][0].values[0].timestamp).not.toBe(
        mocks.insert.mock.calls[1][0].values[0].timestamp
      );
    } finally {
      now.mockRestore();
    }
  });

  it("uses a bounded-budget fingerprint even for a zero-byte batch without metadata", async () => {
    const service = new SessionReplayIngestService("v2");
    await service.recordEvents(42, { userId: "", events: [] });
    await service.recordEvents(42, { userId: "", events: [] });

    expect(mocks.chargeReplaySessionBudget.mock.calls[0][2]).toBe(0);
    expect(mocks.chargeReplaySessionBudget.mock.calls[0][3]).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.chargeReplaySessionBudget.mock.calls[0][3]).toBe(mocks.chargeReplaySessionBudget.mock.calls[1][3]);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("keeps the same serialized payload when R2 fails and ClickHouse is the fallback", async () => {
    mocks.storeBatch.mockRejectedValueOnce(new Error("R2 unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const toJSON = vi.fn(() => ({ text: "history ł" }));
    const service = new SessionReplayIngestService("v2");
    try {
      await service.recordEvents(42, { userId: "", events: [{ type: 6, data: { toJSON }, timestamp: base }] });
      expect(toJSON).toHaveBeenCalledOnce();
      expect(mocks.insert.mock.calls[0][0].values[0]).toMatchObject({
        event_data: JSON.stringify({ text: "history ł" }),
        event_data_key: null,
        event_size_bytes: Buffer.byteLength(JSON.stringify({ text: "history ł" }), "utf8"),
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("SessionReplayIngestService retry reservations with real budget Lua", () => {
  let redis: InstanceType<typeof RedisMock>;
  let budget: typeof import("./replaySessionBudget.js");
  const cap = 1000;
  const request = (): RecordSessionReplayRequest => ({
    anonymousId: "browser-a",
    userId: "account-a",
    events: [{ type: 6, data: { text: "x".repeat(140) }, timestamp: 1_700_000_000_000, sequenceNumber: 1 }],
    metadata: { pageUrl: "https://example.com/" },
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    redis = new RedisMock();
    await redis.flushall();
    redis.defineCommand("replayBudgetCharge", { numberOfKeys: 2, lua: REPLAY_BUDGET_LUA });
    mocks.replayBudgetCharge.mockImplementation(async (key, fingerprint, bytes, capBytes, ttl, max, maxAttempts) => {
      const [outcome, usedBytes] = await (
        redis as unknown as {
          replayBudgetCharge(...args: (string | number)[]): Promise<[number, number]>;
        }
      ).replayBudgetCharge(key, `${key}:batches`, fingerprint, bytes, capBytes, ttl, max, maxAttempts);
      return { accepted: outcome > 0, usedBytes, reused: outcome === 2, unavailable: outcome === -1 };
    });
    budget = await vi.importActual<typeof import("./replaySessionBudget.js")>("./replaySessionBudget.js");
    budget.resetReplayBudgetFallback();
    mocks.chargeReplaySessionBudget.mockImplementation((siteId, sessionId, bytes, fingerprint) =>
      budget.chargeReplaySessionBudget(siteId, sessionId, bytes, fingerprint, cap)
    );
    mocks.generateUserId.mockResolvedValue("fingerprint");
    mocks.generateUserIdFromClientId.mockResolvedValue("fingerprint");
    mocks.updateSession.mockResolvedValue({ sessionId: "session-1" });
    mocks.insert.mockResolvedValue(undefined);
    mocks.storeBatch.mockResolvedValue("r2-key");
    mocks.r2Enabled = false;
    await budget.chargeReplaySessionBudget(42, "session-1", 900, "earlier", cap);
  });

  afterEach(() => {
    redis.disconnect();
  });

  it.each([false, true])(
    "retries a cap-crossing batch after CH fails with R2=%s, without a refund or double charge",
    async r2Enabled => {
      mocks.r2Enabled = r2Enabled;
      mocks.insert.mockRejectedValueOnce(new Error("insert failed"));
      const service = new SessionReplayIngestService("v2");
      const batch = request();
      const used = 900 + Buffer.byteLength(JSON.stringify(batch.events[0].data), "utf8");

      await expect(service.recordEvents(42, batch)).rejects.toThrow("insert failed");
      expect(await redis.get("replay:budget:42:session-1")).toBe(String(used));
      if (r2Enabled) expect(mocks.storeBatch).toHaveBeenCalledOnce();
      await expect(service.recordEvents(42, batch)).resolves.toEqual({ capped: false });
      expect(await redis.get("replay:budget:42:session-1")).toBe(String(used));
      expect(mocks.insert.mock.calls.filter(([call]) => call.table === "session_replay_events")).toHaveLength(2);
      if (r2Enabled) expect(mocks.storeBatch).toHaveBeenCalledTimes(2);

      const modified = request();
      modified.events[0].data = { text: "y".repeat(140) };
      await expect(service.recordEvents(42, modified)).resolves.toEqual({ capped: true });
      expect(mocks.insert.mock.calls.filter(([call]) => call.table === "session_replay_events")).toHaveLength(2);
    }
  );

  it("keeps the same reservation after metadata fails following a successful event insert", async () => {
    mocks.insert.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("metadata failed"));
    const service = new SessionReplayIngestService("v2");
    const batch = request();

    await expect(service.recordEvents(42, batch)).rejects.toThrow("metadata failed");
    const used = await redis.get("replay:budget:42:session-1");
    await expect(service.recordEvents(42, batch)).resolves.toEqual({ capped: false });
    expect(await redis.get("replay:budget:42:session-1")).toBe(used);
    expect(mocks.insert).toHaveBeenCalledTimes(4);
  });

  it("does not refund or terminally cap an insert whose acknowledgement was lost", async () => {
    let storageMayHaveWritten = false;
    mocks.insert.mockImplementationOnce(async () => {
      storageMayHaveWritten = true;
      throw new Error("acknowledgement lost");
    });
    const service = new SessionReplayIngestService("v2");
    const batch = request();

    await expect(service.recordEvents(42, batch)).rejects.toThrow("acknowledgement lost");
    expect(storageMayHaveWritten).toBe(true);
    const used = await redis.get("replay:budget:42:session-1");
    await expect(service.recordEvents(42, batch)).resolves.toEqual({ capped: false });
    expect(await redis.get("replay:budget:42:session-1")).toBe(used);
    // At-least-once storage, not exactly-once: an uncertain insert may repeat.
    expect(mocks.insert.mock.calls.filter(([call]) => call.table === "session_replay_events")).toHaveLength(2);
  });

  it("does not allow endless uncharged storage of an identical batch", async () => {
    const service = new SessionReplayIngestService("v2");
    const batch = request();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(service.recordEvents(42, batch)).resolves.toEqual({ capped: false });
    }
    await expect(service.recordEvents(42, batch)).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.insert.mock.calls.filter(([call]) => call.table === "session_replay_events")).toHaveLength(3);
  });

  it.each([
    {
      field: "type",
      change: (batch: RecordSessionReplayRequest) => {
        batch.events[0].type = "6";
      },
    },
    {
      field: "raw timestamp",
      change: (batch: RecordSessionReplayRequest) => {
        batch.events[0].timestamp++;
      },
    },
    {
      field: "sequence",
      change: (batch: RecordSessionReplayRequest) => {
        batch.events[0].sequenceNumber = 2;
      },
    },
    {
      field: "identity",
      change: (batch: RecordSessionReplayRequest) => {
        batch.userId = "account-b";
      },
    },
    {
      field: "metadata",
      change: (batch: RecordSessionReplayRequest) => {
        batch.metadata!.pageUrl = "https://other.example/";
      },
    },
  ])("does not let modified $field reuse a reservation beyond the cap", async ({ change }) => {
    const service = new SessionReplayIngestService("v2");
    await service.recordEvents(42, request());
    const modified = request();
    change(modified);
    await expect(service.recordEvents(42, modified)).resolves.toEqual({ capped: true });
  });
});
