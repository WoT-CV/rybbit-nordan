import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  storageEnabled: vi.fn(),
  getBatch: vi.fn(),
}));

vi.mock("../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: {
    query: mocks.query,
  },
}));

vi.mock("../storage/r2StorageService.js", () => ({
  r2Storage: {
    isEnabled: mocks.storageEnabled,
    getBatch: mocks.getBatch,
  },
}));

vi.mock("../userIdentity/userIdentityService.js", () => ({
  clickhouseEffectiveUserId: () => "user_id",
  clickhouseResolvedIdentifiedUserId: () => "identified_user_id",
  resolveUserIdentity: vi.fn(),
}));

import { SessionReplayQueryService } from "./sessionReplayQueryService.js";

function resultSet(rows: unknown[]) {
  return {
    json: vi.fn().mockResolvedValue(rows),
  };
}

function clickhouseEvent({
  timestamp,
  type,
  sequenceNumber,
  data,
  userId = "browser-fingerprint",
  identifiedUserId = "",
}: {
  timestamp: number;
  type: number;
  sequenceNumber: number;
  data: unknown;
  userId?: string;
  identifiedUserId?: string;
}) {
  return {
    timestamp,
    type: String(type),
    data: JSON.stringify(data),
    event_data_key: null,
    batch_index: null,
    sequence_number: sequenceNumber,
    user_id: userId,
    identified_user_id: identifiedUserId,
  };
}

describe("SessionReplayQueryService continued recordings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockReset();
    mocks.storageEnabled.mockReturnValue(false);
    mocks.getBatch.mockReset();
  });

  it("orders two document recordings chronologically even when rrweb sequence numbers restart", async () => {
    mocks.query
      .mockResolvedValueOnce(
        resultSet([
          {
            session_id: "continued-session",
            user_id: "browser-fingerprint",
            identified_user_id: "employee-alice",
          },
        ])
      )
      .mockResolvedValueOnce(
        resultSet([
          clickhouseEvent({
            timestamp: 6_001,
            type: 2,
            sequenceNumber: 1,
            data: { fragment: "identified-snapshot" },
          }),
          clickhouseEvent({
            timestamp: 1_001,
            type: 2,
            sequenceNumber: 1,
            data: { fragment: "anonymous-snapshot" },
          }),
          clickhouseEvent({
            timestamp: 6_000,
            type: 4,
            sequenceNumber: 0,
            data: { href: "https://wot-cv.com/players-to-check" },
          }),
          clickhouseEvent({
            timestamp: 1_000,
            type: 4,
            sequenceNumber: 0,
            data: { href: "https://wot-cv.com/login" },
          }),
        ])
      );

    const response = await new SessionReplayQueryService().getSessionReplayEvents(42, "continued-session");

    expect(response.metadata).toMatchObject({
      session_id: "continued-session",
      identified_user_id: "employee-alice",
    });
    expect(response.events).toEqual([
      {
        timestamp: 1_000,
        type: 4,
        data: { href: "https://wot-cv.com/login" },
      },
      {
        timestamp: 1_001,
        type: 2,
        data: { fragment: "anonymous-snapshot" },
      },
      {
        timestamp: 6_000,
        type: 4,
        data: { href: "https://wot-cv.com/players-to-check" },
      },
      {
        timestamp: 6_001,
        type: 2,
        data: { fragment: "identified-snapshot" },
      },
    ]);
  });

  it.each(["r2", "mixed"])("deduplicates an exact retried event across %s storage batches", async storage => {
    mocks.storageEnabled.mockReturnValue(true);
    const data = { source: 0, texts: [{ id: 1, value: "once" }] };
    const event = clickhouseEvent({ timestamp: 1_000, type: 3, sequenceNumber: 7, data });
    const first = { ...event, data: "", event_data_key: "first-attempt.json.zst", batch_index: 0 };
    const retry = storage === "r2" ? { ...event, data: "", event_data_key: "retry.json.zst", batch_index: 0 } : event;
    mocks.getBatch.mockResolvedValue([data]);
    mocks.query
      .mockResolvedValueOnce(resultSet([{ session_id: "session" }]))
      .mockResolvedValueOnce(resultSet([first, retry]));

    const response = await new SessionReplayQueryService().getSessionReplayEvents(42, "session");

    expect(response.events).toEqual([{ timestamp: 1_000, type: 3, data }]);
    expect(mocks.getBatch).toHaveBeenCalledTimes(storage === "r2" ? 2 : 1);
  });

  it.each([false, true])("keeps distinct sequence, timestamp, type, payload and identity with R2=%s", async r2 => {
    const data = { source: 0, texts: [] };
    const event = clickhouseEvent({ timestamp: 1_000, type: 3, sequenceNumber: 7, data });
    const events = [
      event,
      { ...event, sequence_number: 8 },
      { ...event, timestamp: 1_001 },
      { ...event, type: "6" },
      { ...event, data: JSON.stringify({ source: 0, texts: [{ id: 1, value: "other" }] }) },
      { ...event, user_id: "another-browser" },
      { ...event, identified_user_id: "another-account" },
    ];
    const rows = r2
      ? events.map((event, index) => ({ ...event, data: "", event_data_key: "distinct.json.zst", batch_index: index }))
      : events;
    mocks.storageEnabled.mockReturnValue(r2);
    mocks.getBatch.mockResolvedValue(events.map(event => JSON.parse(event.data)));
    mocks.query.mockResolvedValueOnce(resultSet([{ session_id: "session" }])).mockResolvedValueOnce(resultSet(rows));

    const response = await new SessionReplayQueryService().getSessionReplayEvents(42, "session");

    expect(response.events).toHaveLength(events.length);
    expect(mocks.query.mock.calls[1][0].query).toMatch(/user_id,\s+identified_user_id/);
  });

  it("retrieves falsey JSON event data from historical R2 batches", async () => {
    mocks.storageEnabled.mockReturnValue(true);
    const values = [null, false, 0, ""];
    const events = values.map((data, index) => ({
      ...clickhouseEvent({ timestamp: 1_000, type: 6, sequenceNumber: index, data }),
      data: "",
      event_data_key: "historical.json.zst",
      batch_index: index,
    }));
    mocks.getBatch.mockResolvedValue(values);
    mocks.query.mockResolvedValueOnce(resultSet([{ session_id: "session" }])).mockResolvedValueOnce(resultSet(events));

    const response = await new SessionReplayQueryService().getSessionReplayEvents(42, "session");

    expect(response.events.map(event => event.data)).toEqual(values);
  });

  it("reports missing metadata with a typed not-found error", async () => {
    mocks.query.mockResolvedValueOnce(resultSet([]));

    await expect(new SessionReplayQueryService().getSessionReplayEvents(42, "missing-session")).rejects.toMatchObject({
      name: "SessionReplayNotFoundError",
      message: "Session replay not found for session missing-session",
    });
    expect(mocks.query).toHaveBeenCalledOnce();
  });
});
