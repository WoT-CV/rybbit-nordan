import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tracker } from "./tracking.js";
import { ScriptConfig } from "./types.js";
import { resetBotScoreCacheForTests } from "./botSignals.js";

// Mock fetch globally
global.fetch = vi.fn();

describe("Tracker", () => {
  let tracker: Tracker;
  let config: ScriptConfig;
  let mockLocation: any;

  beforeEach(() => {
    resetBotScoreCacheForTests();

    // Reset fetch mock
    vi.mocked(global.fetch).mockReset();
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response);

    // Mock localStorage
    const localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      writable: true,
    });

    // Mock window properties
    mockLocation = {
      href: "https://example.com/page?query=test",
      hostname: "example.com",
      pathname: "/page",
      search: "?query=test",
      hash: "",
    };

    Object.defineProperty(window, "location", {
      value: mockLocation,
      configurable: true,
      writable: true,
    });

    // Mock URL constructor to use our mockLocation
    global.URL = vi.fn().mockImplementation(() => ({
      hostname: mockLocation.hostname,
      pathname: mockLocation.pathname,
      search: mockLocation.search,
      hash: mockLocation.hash,
      searchParams: { entries: () => [["query", "test"]] },
    })) as any;

    Object.defineProperty(screen, "width", {
      value: 1920,
      writable: true,
    });

    Object.defineProperty(screen, "height", {
      value: 1080,
      writable: true,
    });

    Object.defineProperty(navigator, "language", {
      value: "en-US",
      writable: true,
    });

    Object.defineProperty(document, "title", {
      value: "Test Page",
      writable: true,
    });

    Object.defineProperty(document, "referrer", {
      value: "https://google.com",
      writable: true,
    });

    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      value: vi.fn(() => null),
      configurable: true,
    });

    config = {
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
      trackErrors: false,
      enableWebVitals: false,
      enableSessionReplay: false,
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

    tracker = new Tracker(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createBasePayload", () => {
    it("should create base payload with all required fields", () => {
      const payload = tracker.createBasePayload();

      expect(payload).toEqual({
        site_id: "123",
        anonymous_id: "visitor-123",
        hostname: "example.com",
        pathname: "/page",
        querystring: "?query=test",
        screenWidth: 1920,
        screenHeight: 1080,
        language: "en-US",
        page_title: "Test Page",
        referrer: "https://google.com",
        _bs: expect.any(Number),
        _bsm: expect.any(Number),
      });
    });

    it("should handle hash-based routing", () => {
      mockLocation.hash = "#/dashboard/users";
      const payload = tracker.createBasePayload();
      expect(payload?.pathname).toBe("/dashboard/users");
    });

    it("handles hashbang routes without changing slash-prefixed hash routes", () => {
      mockLocation.hash = "#!/shipping";
      expect(tracker.createBasePayload()?.pathname).toBe("/shipping");
    });

    it("ignores ordinary fragments by default", () => {
      mockLocation.pathname = "/checkout/";
      mockLocation.hash = "#shipping";
      expect(tracker.createBasePayload()?.pathname).toBe("/checkout/");
    });

    it("preserves checkout stages when URL fragment tracking is enabled", () => {
      config.trackUrlFragments = true;
      tracker = new Tracker(config);
      mockLocation.pathname = "/checkout/";
      mockLocation.hash = "#shipping";
      expect(tracker.createBasePayload()?.pathname).toBe("/checkout/#shipping");
      mockLocation.hash = "#payment";
      expect(tracker.createBasePayload()?.pathname).toBe("/checkout/#payment");
    });

    it("should skip tracking for matching skip patterns", () => {
      config.skipPatterns = ["/admin/**", "/api/**"];
      tracker = new Tracker(config);

      mockLocation.pathname = "/admin/settings";
      const payload = tracker.createBasePayload();
      expect(payload).toBeNull();
    });

    it("should apply mask patterns", () => {
      config.maskPatterns = ["/user/*/profile"];
      tracker = new Tracker(config);

      mockLocation.pathname = "/user/123/profile";
      const payload = tracker.createBasePayload();
      expect(payload?.pathname).toBe("/user/*/profile");
    });

    it("should support regex skip and mask patterns", () => {
      config.skipPatterns = ["re:^/private/.*$"];
      config.maskPatterns = ["re:^/user/\\d+/profile$"];
      tracker = new Tracker(config);

      mockLocation.pathname = "/private/settings";
      expect(tracker.createBasePayload()).toBeNull();

      mockLocation.pathname = "/user/123/profile";
      const payload = tracker.createBasePayload();
      expect(payload?.pathname).toBe("re:^/user/\\d+/profile$");
    });

    it("should exclude querystring when disabled", () => {
      config.trackQuerystring = false;
      tracker = new Tracker(config);

      const payload = tracker.createBasePayload();
      expect(payload?.querystring).toBe("");
    });

    it("should include user ID when set", () => {
      vi.mocked(window.localStorage.getItem).mockReturnValue("user-123");
      tracker = new Tracker(config);

      const payload = tracker.createBasePayload();
      expect(payload?.user_id).toBe("user-123");
    });

    it("should include evaluated feature flags in payloads", () => {
      config.featureFlags = {
        new_checkout: {
          key: "new_checkout",
          value: true,
          flagType: "boolean",
          payload: { copy: "Try it now" },
          version: 1,
          reason: "rollout",
          matched: true,
          rolloutPercentage: 100,
        },
      };
      tracker = new Tracker(config);

      const payload = tracker.createBasePayload();
      expect(payload?.feature_flags).toEqual({ new_checkout: "true" });
      expect(tracker.getFeatureFlagPayload("new_checkout")).toEqual({ copy: "Try it now" });
    });
  });

  describe("tracking methods", () => {
    it("propagates a replay stop signal through its uploader to the recorder", async () => {
      const stopRecording = vi.fn();
      let emit: ((event: unknown) => void) | undefined;
      window.rrweb = {
        record: vi.fn(options => {
          emit = options.emit;
          return stopRecording;
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ success: true, stopRecording: true }),
      } as unknown as Response);
      tracker = new Tracker({ ...config, enableSessionReplay: true, sessionReplayBatchSize: 2 });
      try {
        emit?.({ type: 2, timestamp: 123, data: { text: "Zażółć 🐸" } });
        await vi.waitFor(() => expect(tracker.isSessionReplayActive()).toBe(false));

        expect(global.fetch).toHaveBeenCalledOnce();
        expect(global.fetch).toHaveBeenCalledWith(
          "https://analytics.example.com/session-replay/record/123",
          expect.objectContaining({
            body: expect.stringContaining('"anonymousId":"visitor-123"'),
            keepalive: false,
          })
        );
        expect(stopRecording).toHaveBeenCalledOnce();
        tracker.startSessionReplay();
        tracker.stopSessionReplay();
        expect(tracker.isSessionReplayActive()).toBe(false);
        expect(global.fetch).toHaveBeenCalledOnce();
      } finally {
        tracker.cleanup();
        delete window.rrweb;
      }
    });

    it("should track pageview", async () => {
      tracker.trackPageview();

      expect(global.fetch).toHaveBeenCalledWith(
        "https://analytics.example.com/track",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining('"type":"pageview"'),
          mode: "cors",
          keepalive: true,
        })
      );
    });

    it("should track custom event", async () => {
      tracker.trackEvent("button_click", { button: "submit" });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://analytics.example.com/track",
        expect.objectContaining({
          body: expect.stringContaining('"type":"custom_event"'),
        })
      );

      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.event_name).toBe("button_click");
      expect(body.properties).toBe(JSON.stringify({ button: "submit" }));
    });

    it("should track feature flag exposure once when a flag is read", () => {
      config.featureFlags = {
        new_checkout: {
          key: "new_checkout",
          value: true,
          flagType: "boolean",
          version: 1,
          reason: "rollout",
          matched: true,
          rolloutPercentage: 100,
        },
      };
      tracker = new Tracker(config);
      vi.mocked(global.fetch).mockClear();

      expect(tracker.getFeatureFlag("new_checkout", false)).toBe(true);
      expect(tracker.getFeatureFlag("new_checkout", false)).toBe(true);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.type).toBe("custom_event");
      expect(body.event_name).toBe("feature_flag_exposure");
      expect(JSON.parse(body.properties)).toMatchObject({
        key: "new_checkout",
        value: "true",
        version: 1,
        reason: "rollout",
      });
    });

    it("should validate custom event name", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      tracker.trackEvent("", {});
      expect(global.fetch).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("Event name is required and must be a string for custom events");

      consoleSpy.mockRestore();
    });

    it("should track outbound link", async () => {
      tracker.trackOutbound("https://external.com", "External Link", "_blank");

      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.type).toBe("outbound");
      expect(body.properties).toBe(
        JSON.stringify({
          url: "https://external.com",
          text: "External Link",
          target: "_blank",
        })
      );
    });

    it("should track web vitals", async () => {
      const vitals = {
        lcp: 2500,
        cls: 0.1,
        inp: 200,
        fcp: 1800,
        ttfb: 800,
      };

      tracker.trackWebVitals(vitals);

      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.type).toBe("performance");
      expect(body.event_name).toBe("web-vitals");
      expect(body.lcp).toBe(2500);
      expect(body.cls).toBe(0.1);
    });

    it("should handle fetch errors gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(global.fetch).mockRejectedValue(new Error("Network error"));

      tracker.trackPageview();

      // Wait for async operation
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(consoleSpy).toHaveBeenCalledWith("Failed to send tracking data:", expect.any(Error));

      consoleSpy.mockRestore();
    });

    describe("error tracking", () => {
      it("should track first-party errors", () => {
        // Enable error tracking for this test
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at https://example.com/app.js:10:5";

        tracker.trackError(error, {
          filename: "https://example.com/app.js",
          lineno: 10,
          colno: 5,
        });

        expect(sendSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            event_name: "Error",
            properties: expect.stringContaining("Test error"),
          })
        );
      });

      it("should filter out third-party errors by filename", () => {
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        // Mock window.location.origin to ensure we have a proper origin for comparison
        Object.defineProperty(window, "location", {
          value: {
            ...mockLocation,
            origin: "https://example.com",
          },
          configurable: true,
          writable: true,
        });

        const error = new Error("Third party error");
        // Clear the stack to avoid test environment paths interfering
        error.stack = undefined;

        tracker.trackError(error, {
          filename: "https://ads.google.com/script.js",
          lineno: 1,
          colno: 1,
        });

        expect(sendSpy).not.toHaveBeenCalled();
      });

      it("should filter out third-party errors by stack trace", () => {
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        const error = new Error("Third party error");
        error.stack = "Error: Third party error\n    at https://ads.google.com/script.js:1:1";

        tracker.trackError(error, {
          lineno: 1,
          colno: 1,
        });

        expect(sendSpy).not.toHaveBeenCalled();
      });

      it("should track errors with unknown origin (e.g., NetworkError)", () => {
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        const error = new Error("NetworkError when attempting to fetch resource");
        error.name = "TypeError";
        // Clear stack to avoid test environment paths
        error.stack = undefined;

        tracker.trackError(error, {
          type: "unhandledrejection",
        });

        expect(sendSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            event_name: "TypeError",
            properties: expect.stringContaining("NetworkError"),
          })
        );
      });

      it("should handle invalid filename URLs gracefully", () => {
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at https://example.com/app.js:10:5";

        tracker.trackError(error, {
          filename: "invalid-url",
          lineno: 10,
          colno: 5,
        });

        // Should fall back to stack trace check and track the error
        expect(sendSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            event_name: "Error",
            properties: expect.stringContaining("Test error"),
          })
        );
      });
    });
  });

  describe("user identification", () => {
    it("should identify user", () => {
      tracker.identify("user-456");

      expect(window.localStorage.setItem).toHaveBeenCalledWith(`${config.namespace}-user-id`, "user-456");
      expect(tracker.getUserId()).toBe("user-456");

      const identifyCall = vi.mocked(global.fetch).mock.calls.find(([url]) => String(url).endsWith("/identify"));
      expect(JSON.parse(identifyCall?.[1]?.body as string)).toMatchObject({
        anonymous_id: "visitor-123",
        user_id: "user-456",
      });
    });

    it("should validate user ID", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      tracker.identify("");
      expect(window.localStorage.setItem).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("User ID must be a non-empty string");

      consoleSpy.mockRestore();
    });

    it("rotates the anonymous identity when switching directly between accounts", () => {
      tracker.identify("user-alice");
      const firstIdentifyCall = vi.mocked(global.fetch).mock.calls.find(([url]) => String(url).endsWith("/identify"));
      const firstAnonymousId = JSON.parse(firstIdentifyCall?.[1]?.body as string).anonymous_id;

      tracker.identify("user-bob");
      const identifyCalls = vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).endsWith("/identify"));
      const secondAnonymousId = JSON.parse(identifyCalls[1][1]?.body as string).anonymous_id;

      expect(firstAnonymousId).toBe("visitor-123");
      expect(secondAnonymousId).not.toBe(firstAnonymousId);
      expect(window.localStorage.setItem).toHaveBeenCalledWith(`${config.namespace}-visitor-id`, secondAnonymousId);
    });

    it("rotates a conflicting anonymous ID and retries identify once", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: vi.fn().mockResolvedValue({
            code: "ANONYMOUS_ID_ALREADY_LINKED",
            rotateAnonymousId: true,
          }),
        } as unknown as Response)
        .mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) } as unknown as Response);

      tracker.identify("user-bob");

      await vi.waitFor(() => {
        const identifyCalls = vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).endsWith("/identify"));
        expect(identifyCalls).toHaveLength(2);
      });
      const identifyCalls = vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).endsWith("/identify"));
      const firstAnonymousId = JSON.parse(identifyCalls[0][1]?.body as string).anonymous_id;
      const secondAnonymousId = JSON.parse(identifyCalls[1][1]?.body as string).anonymous_id;

      expect(firstAnonymousId).toBe("visitor-123");
      expect(secondAnonymousId).not.toBe(firstAnonymousId);
      expect(config.visitorId).toBe(secondAnonymousId);
    });

    it("retries identify after a transient server error", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
        .mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) } as unknown as Response);

      tracker.identify("user-retry");
      await vi.advanceTimersByTimeAsync(250);

      const identifyCalls = vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).endsWith("/identify"));
      expect(identifyCalls).toHaveLength(2);
      vi.useRealTimers();
    });

    it.each(["logout", "account-switch"])("does not retry an old identified user after %s", async boundary => {
      vi.useFakeTimers();
      try {
        vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
        tracker.identify("user-alice");
        await vi.advanceTimersByTimeAsync(0);

        if (boundary === "logout") tracker.clearUserId();
        tracker.identify("user-bob");
        const currentAnonymousId = config.visitorId;
        await vi.advanceTimersByTimeAsync(10_000);

        const identifyBodies = vi
          .mocked(global.fetch)
          .mock.calls.filter(([url]) => String(url).endsWith("/identify"))
          .map(([, options]) => JSON.parse(options?.body as string));
        expect(identifyBodies.map(body => body.user_id)).toEqual(["user-alice", "user-bob"]);
        expect(identifyBodies[0].anonymous_id).toBe("visitor-123");
        expect(identifyBodies[1].anonymous_id).toBe(currentAnonymousId);
        expect(currentAnonymousId).not.toBe("visitor-123");
        expect(config.visitorId).toBe(currentAnonymousId);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores a late 409 from the previous account instead of rotating the current anonymous ID", async () => {
      vi.useFakeTimers();
      try {
        let respond!: (response: Response) => void;
        vi.mocked(global.fetch).mockImplementationOnce(() => new Promise<Response>(resolve => (respond = resolve)));
        tracker.identify("user-alice");
        tracker.identify("user-bob");
        const currentAnonymousId = config.visitorId;

        respond({
          ok: false,
          status: 409,
          json: async () => ({ code: "ANONYMOUS_ID_ALREADY_LINKED", rotateAnonymousId: true }),
        } as Response);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(config.visitorId).toBe(currentAnonymousId);
        const identifyBodies = vi
          .mocked(global.fetch)
          .mock.calls.filter(([url]) => String(url).endsWith("/identify"))
          .map(([, options]) => JSON.parse(options?.body as string));
        expect(identifyBodies.map(body => body.user_id)).toEqual(["user-alice", "user-bob"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rechecks identity after asynchronously reading a 409 response body", async () => {
      vi.useFakeTimers();
      try {
        let readConflict!: (body: unknown) => void;
        vi.mocked(global.fetch).mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: () => new Promise(resolve => (readConflict = resolve)),
        } as Response);
        tracker.identify("user-alice");
        await vi.advanceTimersByTimeAsync(0);
        tracker.identify("user-bob");
        const currentAnonymousId = config.visitorId;

        readConflict({ code: "ANONYMOUS_ID_ALREADY_LINKED", rotateAnonymousId: true });
        await vi.advanceTimersByTimeAsync(10_000);

        expect(config.visitorId).toBe(currentAnonymousId);
        const identifyCalls = vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).endsWith("/identify"));
        expect(identifyCalls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes captured replay identity before rotating after a current-account 409", async () => {
      vi.useFakeTimers();
      let emit!: (event: unknown) => void;
      window.rrweb = { record: vi.fn(options => ((emit = options.emit), vi.fn())) };
      config.enableSessionReplay = true;
      tracker = new Tracker(config);
      try {
        tracker.onPageChange();
        await vi.advanceTimersByTimeAsync(0);
        vi.mocked(global.fetch).mockClear();
        let respond!: (response: Response) => void;
        vi.mocked(global.fetch).mockImplementationOnce(() => new Promise<Response>(resolve => (respond = resolve)));
        tracker.identify("user-bob");
        emit({ type: 3, data: { captured: "before-rotation" }, timestamp: 1_700_000_000_000 });

        respond({
          ok: false,
          status: 409,
          json: async () => ({ code: "ANONYMOUS_ID_ALREADY_LINKED", rotateAnonymousId: true }),
        } as Response);
        await vi.advanceTimersByTimeAsync(0);
        const rotatedId = config.visitorId;
        emit({ type: 3, data: { captured: "after-rotation" }, timestamp: 1_700_000_001_000 });
        tracker.onPageChange();
        await vi.advanceTimersByTimeAsync(0);

        const replayBodies = vi
          .mocked(global.fetch)
          .mock.calls.filter(([url]) => String(url).includes("/session-replay/record/"))
          .map(([, options]) => JSON.parse(options?.body as string));
        expect(replayBodies).toHaveLength(2);
        expect(replayBodies[0]).toMatchObject({ anonymousId: "visitor-123", userId: "user-bob" });
        expect(replayBodies[0].events[0].data).toEqual({ captured: "before-rotation" });
        expect(replayBodies[1]).toMatchObject({ anonymousId: rotatedId, userId: "user-bob" });
        expect(replayBodies[1].events[0].data).toEqual({ captured: "after-rotation" });
        expect(rotatedId).not.toBe("visitor-123");
      } finally {
        tracker.cleanup();
        delete window.rrweb;
        vi.useRealTimers();
      }
    });

    it("should clear user ID", () => {
      const previousVisitorId = config.visitorId;
      const updateReplayUserId = vi.fn();
      (
        tracker as unknown as { sessionReplayRecorder: { updateUserId: (userId: string) => void } }
      ).sessionReplayRecorder = {
        updateUserId: updateReplayUserId,
      };

      tracker.identify("user-789");
      tracker.clearUserId();

      expect(window.localStorage.removeItem).toHaveBeenCalledWith(`${config.namespace}-user-id`);
      expect(tracker.getUserId()).toBeNull();
      expect(updateReplayUserId).toHaveBeenLastCalledWith("");
      expect(window.localStorage.setItem).toHaveBeenCalledWith(`${config.namespace}-visitor-id`, expect.any(String));
      expect(tracker.createBasePayload()?.anonymous_id).not.toBe(previousVisitorId);
    });

    it("should handle localStorage errors", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(window.localStorage.setItem).mockImplementation(() => {
        throw new Error("Storage full");
      });

      tracker.identify("user-123");
      expect(consoleSpy).toHaveBeenCalledWith("Could not persist user ID to localStorage");

      consoleSpy.mockRestore();
    });
  });

  describe("feature flag refresh", () => {
    it("does not evaluate flags on page changes when the site has no flags", () => {
      tracker.onPageChange();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("evaluates flags on page changes when feature flags are enabled", () => {
      config.featureFlagsEnabled = true;
      tracker = new Tracker(config);

      tracker.onPageChange();

      expect(global.fetch).toHaveBeenCalledWith(
        "https://analytics.example.com/site/123/feature-flags/evaluate",
        expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })
      );
    });
  });
});
