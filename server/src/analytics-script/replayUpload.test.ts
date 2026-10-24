// @vitest-environment node
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptsReplayGzip, createReplayUploader } from "./replayUpload.js";
import type { SessionReplayBatch } from "./types.js";

const capability = { version: 1, gzip: true };
const batch = (): SessionReplayBatch => ({
  anonymousId: "a",
  userId: "u",
  events: [
    { type: 6, timestamp: 123, sequenceNumber: 0, data: { plugin: "unknown", value: "Zażółć 🐸".repeat(1000) } },
    { type: 3, timestamp: 123, sequenceNumber: 1, data: { source: 2, positions: [1, 2, 3] } },
  ],
});
const sent = () => {
  const calls = vi.mocked(fetch).mock.calls;
  return calls[calls.length - 1][1]!;
};
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("negotiated lossless replay uploader", () => {
  it.each([false, true])("returns the server stop signal with gzip=%s", async gzip => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ success: true, stopRecording: true })));

    await expect(createReplayUploader("https://example.test/record", { version: 1, gzip })(batch())).resolves.toEqual({
      stopRecording: true,
    });
    expect(sent().headers).toEqual(
      gzip ? { "Content-Type": "application/json", "Content-Encoding": "gzip" } : { "Content-Type": "application/json" }
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["Site over monthly limit", "", "invalid-json"])(
    "accepts a legacy non-JSON success without retrying: %j",
    async body => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(body));
      await expect(createReplayUploader("https://example.test/record", undefined)(batch())).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledOnce();
    }
  );
  it.each([{}, null, [], true, { stopRecording: false }, { stopRecording: "true" }, { stopRecording: 1 }])(
    "does not turn an unrelated success payload into a stop signal: %j",
    async body => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body)));
      await expect(createReplayUploader("https://example.test/record", undefined)(batch())).resolves.toBeUndefined();
    }
  );
  it.each([400, 413, 415, 429, 500])(
    "keeps HTTP %s a failure even if the body contains a stop signal",
    async status => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ stopRecording: true }), { status }));
      await expect(createReplayUploader("https://example.test/record", capability)(batch())).rejects.toMatchObject({
        status,
      });
      expect(fetch).toHaveBeenCalledOnce();
    }
  );

  it("does not send a larger gzip representation", async () => {
    vi.stubGlobal(
      "CompressionStream",
      class {
        constructor() {
          return new TransformStream();
        }
      }
    );
    const value = batch();
    await createReplayUploader("https://example.test/record", capability)(value);
    expect(sent().body).toBe(JSON.stringify(value));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([null, undefined, {}, { version: 2, gzip: true }, { version: 1, gzip: "true" }, { version: 1, gzip: false }])(
    "keeps identity without exact capability %j",
    async config => {
      expect(acceptsReplayGzip(config)).toBe(false);
      const value = batch();
      await createReplayUploader("https://example.test/record", config)(value);
      expect(sent().body).toBe(JSON.stringify(value));
      expect(sent().headers).not.toHaveProperty("Content-Encoding");
    }
  );
  it("uses native gzip preserving exact JSON bytes with no mutation", async () => {
    const value = batch(),
      json = JSON.stringify(value);
    await createReplayUploader("https://example.test/record", capability)(value);
    expect(sent().headers).toHaveProperty("Content-Encoding", "gzip");
    expect(gunzipSync(Buffer.from(sent().body as ArrayBuffer)).toString()).toBe(json);
    expect(JSON.stringify(value)).toBe(json);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("freezes identity before await", async () => {
    const value = batch();
    const pending = createReplayUploader("https://example.test/record", capability)(value);
    value.userId = "later";
    await pending;
    expect(JSON.parse(gunzipSync(Buffer.from(sent().body as ArrayBuffer)).toString()).userId).toBe("u");
  });
  it.each(["unsupported", "hidden", "small", "local-error"])(
    "falls back without any extra fetch: %s",
    async condition => {
      const value = batch();
      if (condition === "unsupported") vi.stubGlobal("CompressionStream", undefined);
      if (condition === "hidden") vi.stubGlobal("document", { visibilityState: "hidden" });
      if (condition === "small") value.events = [];
      if (condition === "local-error")
        vi.stubGlobal(
          "CompressionStream",
          class {
            constructor() {
              throw new Error("unavailable");
            }
          }
        );
      await createReplayUploader("https://example.test/record", capability)(value);
      expect(sent().body).toBe(JSON.stringify(value));
      expect(fetch).toHaveBeenCalledOnce();
    }
  );
  it.each(["415", "network"])("downgrades only on recorder-owned next retry: %s", async failure => {
    if (failure === "415") vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 415 }));
    else vi.mocked(fetch).mockRejectedValueOnce(new TypeError("CORS"));
    const value = batch(),
      send = createReplayUploader("https://example.test/record", capability);
    await expect(send(value)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    await send(value);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent().body).toBe(JSON.stringify(value));
  });
  it("preserves 413 for existing recorder split handling, with no automatic resend", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 413 }));
    await expect(createReplayUploader("https://example.test/record", capability)(batch())).rejects.toMatchObject({
      status: 413,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
