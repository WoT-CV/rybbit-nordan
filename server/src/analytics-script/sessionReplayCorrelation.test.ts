import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptConfig } from "./types.js";
import { SessionReplayRecorder } from "./sessionReplay.js";

vi.mock("./botSignals.js", () => ({ getBotSignalMask: () => 0 }));
const config: ScriptConfig = {
  namespace: "rybbit",
  analyticsHost: "https://analytics.example.com/api",
  siteId: "12",
  visitorId: "device",
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
  requestCorrelation: { origins: ["https://api.example.com"] },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const response = () => ({
  status: 200,
  url: "https://api.example.com/players",
  headers: new Headers({ "x-correlation-id": "req123" }),
});

describe("correlation capture belongs to the native sampled recorder", () => {
  let emit: (event: unknown) => void;
  let send: ReturnType<typeof vi.fn>;
  let nativeFetch: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let recorder: SessionReplayRecorder;
  let snapshot: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    nativeFetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", nativeFetch);
    send = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    snapshot = vi.fn(() => emit({ type: 2, data: {}, timestamp: Date.now() }));
    window.rrweb = {
      record: Object.assign(
        vi.fn(options => {
          emit = options.emit;
          return stop;
        }),
        { takeFullSnapshot: snapshot }
      ),
    };
    recorder = new SessionReplayRecorder(config, "alice", send);
  });
  afterEach(() => {
    recorder.cleanup();
    delete window.rrweb;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const recordedRequests = () =>
    send.mock.calls.flatMap(([batch]) => batch.events.filter((event: any) => event.type === 5));

  it("does not observe before start, when sampled out, or after stop", async () => {
    await window.fetch("https://api.example.com/players");
    expect(window.fetch).toBe(nativeFetch);
    recorder.cleanup();
    recorder = new SessionReplayRecorder({ ...config, sessionReplaySampleRate: 0 }, "alice", send);
    await recorder.initialize();
    recorder.startRecording();
    await window.fetch("https://api.example.com/players");
    expect(recorder.isActive()).toBe(false);
    expect(recordedRequests()).toEqual([]);
    expect(window.fetch).toBe(nativeFetch);
  });

  it.each(["stopRecording", "cleanup"] as const)(
    "does not start after %s during the asynchronous rrweb load",
    async method => {
      delete window.rrweb;
      const initializing = recorder.initialize();
      recorder[method]();
      const script = document.querySelector<HTMLScriptElement>('script[src$="/replay.js"]')!;
      window.rrweb = { record: vi.fn(() => stop) };
      script.dispatchEvent(new Event("load"));
      await initializing;
      expect(window.rrweb.record).not.toHaveBeenCalled();
      expect(window.fetch).toBe(nativeFetch);
      expect(recorder.isActive()).toBe(false);
      script.remove();
    }
  );

  it("requires an actual rrweb stop function before enabling request capture", async () => {
    window.rrweb = { record: vi.fn(() => undefined) as any };
    await recorder.initialize();
    expect(recorder.isActive()).toBe(false);
    expect(window.fetch).toBe(nativeFetch);
    await window.fetch("https://api.example.com/players");
    expect(recordedRequests()).toEqual([]);
  });

  it("drops prior identity pending requests but records new requests under the current native user", async () => {
    const pending = deferred<any>();
    nativeFetch.mockReturnValueOnce(pending.promise);
    await recorder.initialize();
    const request = window.fetch("https://api.example.com/old?token=secret");
    recorder.updateUserId("bob");
    pending.resolve(response());
    await request;
    await window.fetch("https://api.example.com/players");
    recorder.onPageChange();
    expect(recordedRequests()).toHaveLength(1);
    expect(send.mock.calls[0][0].userId).toBe("bob");
  });

  it("retains same-identity pending requests across SPA navigation until their completion timestamp", async () => {
    const pending = deferred<any>();
    nativeFetch.mockReturnValueOnce(pending.promise);
    await recorder.initialize();
    const request = window.fetch("https://api.example.com/players");
    recorder.onPageChange();
    expect(send).not.toHaveBeenCalled();
    pending.resolve(response());
    await request;
    recorder.onPageChange();
    expect(recordedRequests()).toHaveLength(1);
    expect(send.mock.calls[0][0].userId).toBe("alice");
    expect(recordedRequests()[0].timestamp).toBeGreaterThan(0);
  });

  it.each(["stopRecording", "takeFullSnapshot"])("ignores late prior-identity server control %s", async signal => {
    const pending = deferred<any>();
    send.mockReturnValueOnce(pending.promise);
    await recorder.initialize();
    emit({ type: 3, data: {}, timestamp: Date.now() });
    recorder.onPageChange();
    recorder.updateUserId("bob");
    pending.resolve({ [signal]: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.isActive()).toBe(true);
    expect(snapshot).not.toHaveBeenCalled();
    await window.fetch("https://api.example.com/players");
    recorder.onPageChange();
    expect(recordedRequests()).toHaveLength(1);
    expect(send.mock.calls[send.mock.calls.length - 1][0].userId).toBe("bob");
  });

  it("ignores a stopped run's late cap response after a manual restart", async () => {
    const pending = deferred<any>();
    send.mockReturnValueOnce(pending.promise);
    await recorder.initialize();
    emit({ type: 3, data: {}, timestamp: Date.now() });
    recorder.stopRecording();
    recorder.startRecording();
    pending.resolve({ stopRecording: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.isActive()).toBe(true);
    await window.fetch("https://api.example.com/players");
    recorder.onPageChange();
    expect(recordedRequests()).toHaveLength(1);
  });

  it("invalidates requests at an actual session snapshot boundary", async () => {
    const pending = deferred<any>();
    nativeFetch.mockReturnValueOnce(pending.promise);
    send.mockResolvedValueOnce({ takeFullSnapshot: true });
    await recorder.initialize();
    const request = window.fetch("https://api.example.com/old");
    emit({ type: 3, data: {}, timestamp: Date.now() });
    recorder.onPageChange();
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledOnce();
    pending.resolve(response());
    await request;
    await window.fetch("https://api.example.com/players");
    recorder.onPageChange();
    expect(recordedRequests()).toHaveLength(1);
    expect(recordedRequests()[0].data.payload.pathname).toBe("/players");
  });

  it("stops all observation and native timers when the current session reaches its cap", async () => {
    send.mockResolvedValueOnce({ stopRecording: true });
    await recorder.initialize();
    await window.fetch("https://api.example.com/players");
    recorder.onPageChange();
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.isActive()).toBe(false);
    expect(window.fetch).toBe(nativeFetch);
    expect(stop).toHaveBeenCalledOnce();
    recorder.startRecording();
    expect(recorder.isActive()).toBe(false);
  });

  it("keeps the native batch timer if optional wrapper installation is unavailable", async () => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(window.XMLHttpRequest.prototype, "open")!;
    Object.defineProperty(window.XMLHttpRequest.prototype, "open", { ...descriptor, writable: false });
    try {
      await recorder.initialize();
      expect(recorder.isActive()).toBe(true);
      expect(window.fetch).toBe(nativeFetch);
      emit({ type: 3, data: {}, timestamp: Date.now() });
      await vi.advanceTimersByTimeAsync(5000);
      expect(send).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window.XMLHttpRequest.prototype, "open", descriptor);
    }
  });
});
