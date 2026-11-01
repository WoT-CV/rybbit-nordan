import { describe, expect, it } from "vitest";
import { parseRequestCorrelationEvent, REQUEST_CORRELATION_TAG } from "./requestCorrelation";

const event = () => ({
  type: 5 as string | number,
  timestamp: 1_800_000_000_000,
  data: {
    tag: REQUEST_CORRELATION_TAG,
    payload: {
      rowId: "request_1",
      transport: "fetch",
      method: "POST",
      origin: "https://api.example.com",
      pathname: "/players/123",
      status: 500,
      outcome: "response",
      durationMs: 1.5,
      correlationId: "abc-123",
      traceId: "ABCDEF1234567890ABCDEF1234567890",
    } as Record<string, unknown>,
  },
});

describe("request correlation rrweb contract", () => {
  it.each([5, "5"])("accepts native live/read CustomEvent type %s and copies only the metadata whitelist", type => {
    const input = event();
    input.type = type;
    Object.assign(input.data.payload, {
      body: "secret",
      headers: { Authorization: "secret" },
      query: "token=secret",
      stack: "secret",
    });
    expect(parseRequestCorrelationEvent(input)).toEqual({
      timestamp: input.timestamp,
      request: {
        rowId: "request_1",
        transport: "fetch",
        method: "POST",
        origin: "https://api.example.com",
        pathname: "/players/123",
        status: 500,
        outcome: "response",
        durationMs: 1.5,
        correlationId: "abc-123",
        traceId: "abcdef1234567890abcdef1234567890",
      },
    });
  });
  it.each([
    null,
    {},
    { type: 3 },
    { ...event(), type: "05" },
    { ...event(), timestamp: Infinity },
    { ...event(), timestamp: 0 },
    { ...event(), data: { tag: "other", payload: {} } },
  ])("rejects an invalid native event %#", input => {
    expect(parseRequestCorrelationEvent(input)).toBeUndefined();
  });
  it.each([
    ["rowId", "bad\n"],
    ["rowId", "a".repeat(81)],
    ["method", "get"],
    ["method", "GET\n"],
    ["method", "X".repeat(17)],
    ["origin", "https://user:password@api.example.com"],
    ["origin", "https://api.example.com/path"],
    ["origin", "javascript:bad"],
    ["pathname", "/a?token=secret"],
    ["pathname", "/a#secret"],
    ["pathname", "relative"],
    ["pathname", "/".repeat(2049)],
    ["status", -1],
    ["status", 600],
    ["status", "200"],
    ["outcome", "unknown"],
    ["durationMs", Infinity],
    ["durationMs", -1],
    ["durationMs", 3_600_001],
    ["correlationId", 'a" | logfmt'],
    ["correlationId", "abc\n"],
    ["correlationId", "x".repeat(129)],
    ["traceId", "0".repeat(32)],
    ["traceId", "a".repeat(32) + "\n"],
  ])("rejects invalid %s=%s", (key, value) => {
    const input = event();
    input.data.payload[key as string] = value;
    expect(parseRequestCorrelationEvent(input)).toBeUndefined();
  });
  it.each(["network-error", "abort", "timeout"])(
    "retains a real no-response %s without inventing IDs/status",
    outcome => {
      const input = event();
      Object.assign(input.data.payload, { status: 0, outcome });
      delete input.data.payload.correlationId;
      delete input.data.payload.traceId;
      expect(parseRequestCorrelationEvent(input)?.request).toMatchObject({ status: 0, outcome });
      input.data.payload.status = 200;
      expect(parseRequestCorrelationEvent(input)).toBeUndefined();
    }
  );
});
