import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  hasFeatureFlagsForRuntime: vi.fn(),
  isSiteWithoutReplay: vi.fn(),
}));

vi.mock("../../lib/siteConfig.js", () => ({
  siteConfig: { getConfig: mocks.getConfig },
}));

vi.mock("../../services/featureFlags/definitions.js", () => ({
  hasFeatureFlagsForRuntime: mocks.hasFeatureFlagsForRuntime,
}));

vi.mock("../../services/usageService.js", () => ({
  usageService: { isSiteWithoutReplay: mocks.isSiteWithoutReplay },
}));

import { getTrackingConfig } from "./getTrackingConfig.js";

describe("getTrackingConfig", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue({
      siteId: 123,
      type: "web",
      sessionReplay: false,
      webVitals: false,
      trackErrors: false,
      trackOutbound: true,
      trackUrlParams: true,
      trackUrlFragments: false,
      trackInitialPageView: true,
      trackSpaNavigation: true,
      trackButtonClicks: false,
      trackCopy: false,
      trackFormInteractions: false,
    });
    mocks.hasFeatureFlagsForRuntime.mockResolvedValue(false);
    mocks.isSiteWithoutReplay.mockReturnValue(false);
  });

  it("tells the tracking script to skip evaluation when a site has no flags", async () => {
    const request = { params: { siteId: "123" }, log: { error: vi.fn() } } as any;
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getTrackingConfig(request, reply);

    expect(mocks.hasFeatureFlagsForRuntime).toHaveBeenCalledWith(123, "client");
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ featureFlagsEnabled: false }));
  });

  it.each([false, true])("publishes only origin allowlists when replay is active=%s", async active => {
    mocks.getConfig.mockResolvedValue({ ...(await mocks.getConfig()), sessionReplay: active });
    vi.stubEnv("WOTCV_REPLAY_CORRELATION_JSON", JSON.stringify([{ siteIds: [123], requestOrigin: "https://api.example.com", grafanaUrl: "https://private-grafana.example.com", orgId: 1, lokiDatasourceUid: "private-loki", serviceName: "secret-service", environment: "prod", timePaddingMs: 1000 }]));
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;
    await getTrackingConfig({ params: { siteId: "123" }, log: { error: vi.fn() } } as any, reply);
    const body = reply.send.mock.calls[0][0];
    expect(body.requestCorrelation).toEqual(active ? { origins: ["https://api.example.com"] } : undefined);
    expect(JSON.stringify(body)).not.toMatch(/grafana|private-loki|secret-service/);
  });

  it("fails correlation closed without breaking native tracking when its operator config is invalid", async () => {
    mocks.getConfig.mockResolvedValue({ ...(await mocks.getConfig()), sessionReplay: true });
    vi.stubEnv("WOTCV_REPLAY_CORRELATION_JSON", "sensitive invalid config");
    const log = { error: vi.fn() }; const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;
    await getTrackingConfig({ params: { siteId: "123" }, log } as any, reply);
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send.mock.calls[0][0]).toMatchObject({ sessionReplay: true, requestCorrelation: { origins: [] } });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("sensitive");
  });

  it.each([true, false])("returns URL fragment tracking set to %s", async enabled => {
    mocks.getConfig.mockResolvedValue({
      ...(await mocks.getConfig()),
      trackUrlFragments: enabled,
    });
    const request = { params: { siteId: "123" }, log: { error: vi.fn() } } as any;
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getTrackingConfig(request, reply);

    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ trackUrlFragments: enabled }));
  });
});
