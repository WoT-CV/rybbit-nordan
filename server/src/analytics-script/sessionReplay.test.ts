import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReplayRecorder } from "./sessionReplay.js";
import type { ScriptConfig } from "./types.js";

const config: ScriptConfig = {
  namespace: "rybbit",
  analyticsHost: "https://analytics.example.com",
  siteId: "123",
  visitorId: "visitor-123",
  debounceDuration: 0,
  autoTrackPageview: true,
  autoTrackSpa: true,
  trackQuerystring: true,
  trackUrlFragments: false,
  trackOutbound: true,
  enableWebVitals: false,
  trackErrors: false,
  enableSessionReplay: true,
  sessionReplayBatchSize: 50,
  sessionReplayBatchInterval: 5000,
  sessionReplayMaskTextSelectors: [],
  skipPatterns: [],
  maskPatterns: [],
  trackButtonClicks: false,
  trackCopy: false,
  trackFormInteractions: false,
  tag: "",
  featureFlagsEnabled: false,
  featureFlags: {},
};

describe("SessionReplayRecorder identity", () => {
  let emit: (event: unknown) => void;
  let recorder: SessionReplayRecorder;
  let sendBatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    window.rrweb = {
      record: vi.fn(options => {
        emit = options.emit;
        return vi.fn();
      }),
    };

    sendBatch = vi.fn().mockResolvedValue(undefined);
    recorder = new SessionReplayRecorder(config, "employee-alice", sendBatch);
    await recorder.initialize();
  });

  afterEach(() => {
    recorder.cleanup();
    delete window.rrweb;
  });

  it("flushes buffered events before changing the identified user", async () => {
    emit({ type: 2, data: { user: "employee-alice" }, timestamp: 1_700_000_000_000 });

    recorder.updateUserId("employee-bob");

    await vi.waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(1));
    const firstBatch = sendBatch.mock.calls[0][0];
    expect(firstBatch).toMatchObject({ anonymousId: "visitor-123", userId: "employee-alice" });
    expect(firstBatch.events).toContainEqual(expect.objectContaining({ data: { user: "employee-alice" } }));

    emit({ type: 2, data: { user: "employee-bob" }, timestamp: 1_700_000_001_000 });
    recorder.stopRecording();

    await vi.waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(2));
    const secondBatch = sendBatch.mock.calls[1][0];
    expect(secondBatch).toMatchObject({ anonymousId: "visitor-123", userId: "employee-bob" });
    expect(secondBatch.events).toContainEqual(expect.objectContaining({ data: { user: "employee-bob" } }));
  });

  it("keeps the captured identity on batches queued behind an in-flight request", async () => {
    let releaseFirstBatch: (() => void) | undefined;
    sendBatch
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            releaseFirstBatch = resolve;
          })
      )
      .mockResolvedValue(undefined);

    emit({ type: 2, data: { user: "employee-alice" }, timestamp: 1_700_000_000_000 });
    recorder.updateUserId("employee-bob");
    await vi.waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(1));

    emit({ type: 2, data: { user: "employee-bob" }, timestamp: 1_700_000_001_000 });
    recorder.updateUserId("employee-carol");
    releaseFirstBatch?.();

    await vi.waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(2));
    expect(sendBatch.mock.calls[1][0]).toMatchObject({
      anonymousId: "visitor-123",
      userId: "employee-bob",
    });
  });

  it("retries a failed batch while recording is idle", async () => {
    vi.useFakeTimers();
    sendBatch.mockRejectedValueOnce(new Error("temporary network failure")).mockResolvedValue(undefined);

    emit({ type: 2, data: { user: "employee-alice" }, timestamp: 1_700_000_000_000 });
    recorder.updateUserId("employee-bob");
    await vi.advanceTimersByTimeAsync(0);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[1][0]).toMatchObject({
      anonymousId: "visitor-123",
      userId: "employee-alice",
    });
    vi.useRealTimers();
  });
});
