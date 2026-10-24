import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReplayRecorder } from "./sessionReplay.js";
import { SessionReplayTransportError, type ScriptConfig, type SessionReplayBatchResult } from "./types.js";

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

describe("SessionReplayRecorder size cap", () => {
  let emit: (event: unknown) => void;
  let stopRrweb: ReturnType<typeof vi.fn>;
  let recorder: SessionReplayRecorder;
  let sendBatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    stopRrweb = vi.fn();
    window.rrweb = {
      record: vi.fn(options => {
        emit = options.emit;
        return stopRrweb;
      }),
    };

    sendBatch = vi.fn().mockResolvedValue({ success: true, stopRecording: true });
    recorder = new SessionReplayRecorder(config, "visitor", sendBatch);
    await recorder.initialize();
  });

  afterEach(() => {
    recorder.cleanup();
    delete window.rrweb;
    vi.useRealTimers();
  });

  it("stops recording for the page when the server reports the cap", async () => {
    emit({ type: 2, data: {}, timestamp: 1_700_000_000_000 });
    recorder.onPageChange();

    await vi.waitFor(() => expect(recorder.isActive()).toBe(false));
    expect(stopRrweb).toHaveBeenCalledOnce();

    // Neither a later restart nor cleanup sends anything more.
    recorder.startRecording();
    expect(recorder.isActive()).toBe(false);
    recorder.cleanup();
    expect(sendBatch).toHaveBeenCalledOnce();
  });

  it("discards queued and buffered events and ignores final rrweb emissions", async () => {
    vi.useFakeTimers();
    let complete: (result: SessionReplayBatchResult) => void = () => {};
    sendBatch.mockImplementationOnce(() => new Promise<SessionReplayBatchResult>(resolve => (complete = resolve)));

    emit({ type: 2, data: { index: 1 }, timestamp: 10 });
    recorder.onPageChange();
    emit({ type: 3, data: { index: 2 }, timestamp: 20 });
    recorder.onPageChange();
    emit({ type: 3, data: { index: 3 }, timestamp: 30 });
    stopRrweb.mockImplementation(() => emit({ type: 6, data: { pendingOnUnload: true }, timestamp: 40 }));

    complete({ stopRecording: true });
    await vi.advanceTimersByTimeAsync(0);

    const state = recorder as unknown as {
      eventBuffer: unknown[];
      eventBufferSizeBytes: number;
      pendingBatches: unknown[];
      retryAttempts: Map<string, number>;
      retryTimer?: number;
      batchTimer?: number;
    };
    expect(state.eventBuffer).toEqual([]);
    expect(state.eventBufferSizeBytes).toBe(0);
    expect(state.pendingBatches).toEqual([]);
    expect(state.retryAttempts.size).toBe(0);
    expect(state.retryTimer).toBeUndefined();
    expect(state.batchTimer).toBeUndefined();
    expect(stopRrweb).toHaveBeenCalledOnce();

    emit({ type: 3, data: { late: true }, timestamp: 50 });
    recorder.updateUserId("another-account");
    recorder.startRecording();
    recorder.onPageChange();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(state.eventBuffer).toEqual([]);
  });

  it("stops a retried batch without recreating retry state or sending queued batches", async () => {
    vi.useFakeTimers();
    sendBatch.mockRejectedValueOnce(new Error("temporary network error"));
    recorder.onPageChange();
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: 3, data: { queued: true }, timestamp: 20 });
    recorder.onPageChange();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(recorder.isActive()).toBe(false);
    expect((recorder as unknown as { retryAttempts: Map<string, number> }).retryAttempts.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendBatch).toHaveBeenCalledTimes(2);
  });

  it("does not send the second half of a 413 split once the first half is capped", async () => {
    vi.useFakeTimers();
    sendBatch.mockRejectedValueOnce(new SessionReplayTransportError(413, "Too large"));
    emit({ type: 2, data: { index: 1 }, timestamp: 10 });
    emit({ type: 3, data: { index: 2 }, timestamp: 20 });
    emit({ type: 3, data: { index: 3 }, timestamp: 30 });
    recorder.onPageChange();

    await vi.advanceTimersByTimeAsync(0);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[1][0].events).toHaveLength(2);
    expect(sendBatch.mock.calls[1][0]).toMatchObject({ anonymousId: "visitor-123", userId: "visitor" });
    expect(recorder.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendBatch).toHaveBeenCalledTimes(2);
  });

  it("remains terminal even if rrweb cleanup throws", async () => {
    vi.useFakeTimers();
    stopRrweb.mockImplementation(() => {
      throw new Error("plugin cleanup failed");
    });
    recorder.onPageChange();
    emit({ type: 3, data: { queued: true }, timestamp: 20 });
    recorder.onPageChange();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(recorder.isActive()).toBe(false);
    expect(stopRrweb).toHaveBeenCalledOnce();
    expect(sendBatch).toHaveBeenCalledOnce();
    expect((recorder as unknown as { pendingBatches: unknown[] }).pendingBatches).toEqual([]);
  });

  it("does not invoke an already stopped rrweb recorder twice when the in-flight upload is capped", async () => {
    emit({ type: 2, data: {}, timestamp: 10 });
    recorder.stopRecording();
    await vi.waitFor(() => expect(recorder.isActive()).toBe(false));
    await vi.waitFor(() => expect(sendBatch).toHaveBeenCalledOnce());
    expect(stopRrweb).toHaveBeenCalledOnce();
  });

  it("preserves ordered 413 splitting and the captured identity when only the unsent half needs retry", async () => {
    sendBatch
      .mockRejectedValueOnce(new SessionReplayTransportError(413, "Too large"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SessionReplayTransportError(503, "Unavailable"))
      .mockResolvedValue(undefined);
    for (let index = 1; index <= 3; index++) {
      emit({ type: 3, data: { index }, timestamp: 10 });
    }
    recorder.onPageChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendBatch).toHaveBeenCalledTimes(3);
    recorder.updateUserId("next-user");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendBatch).toHaveBeenCalledTimes(4);
    const acceptedEvents = [...sendBatch.mock.calls[1][0].events, ...sendBatch.mock.calls[3][0].events];
    expect(acceptedEvents.map(event => event.sequenceNumber)).toEqual([0, 1, 2, 3]);
    expect(acceptedEvents.slice(1).map(event => event.data.index)).toEqual([1, 2, 3]);
    expect(sendBatch.mock.calls[3][0]).toMatchObject({ anonymousId: "visitor-123", userId: "visitor" });
    expect(recorder.isActive()).toBe(true);
  });

  it("keeps the existing three-attempt retry budget when the server is unavailable", async () => {
    sendBatch.mockRejectedValue(new SessionReplayTransportError(503, "Unavailable"));
    recorder.onPageChange();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendBatch).toHaveBeenCalledTimes(3);
    expect((recorder as unknown as { pendingBatches: unknown[] }).pendingBatches).toEqual([]);
    expect((recorder as unknown as { retryAttempts: Map<string, number> }).retryAttempts.size).toBe(0);
    expect(recorder.isActive()).toBe(true);
  });
});
