import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkApiKey: vi.fn(),
  getSessionFromReq: vi.fn(),
  getUserSiteRole: vi.fn(),
  getSiteIsPubliclyReadable: vi.fn(),
  getIsUserAdmin: vi.fn(),
  getUserOrgRole: vi.fn(),
}));
vi.mock("../../lib/auth-utils.js", () => mocks);
vi.mock("../../db/postgres/postgres.js", () => ({ db: { query: { member: { findFirst: vi.fn(async () => null) } } } }));
vi.mock("../../lib/siteConfig.js", () => ({ siteConfig: { resolveSiteId: vi.fn(async () => null) } }));
import { requireSitePermission, resolveSiteId } from "../../lib/auth-middleware.js";
import { getReplayCorrelationConfig } from "./getReplayCorrelationConfig.js";

const profile = {
  siteIds: [12],
  requestOrigin: "https://api.example.com",
  grafanaUrl: "https://grafana.example.com",
  orgId: 1,
  lokiDatasourceUid: "loki",
  serviceName: "wotcv-be",
  environment: "prod",
  timePaddingMs: 30_000,
};
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("WOTCV_REPLAY_CORRELATION_JSON", JSON.stringify([profile]));
  mocks.getSessionFromReq.mockResolvedValue(null);
  mocks.getUserSiteRole.mockResolvedValue(null);
  mocks.getSiteIsPubliclyReadable.mockResolvedValue(true);
  mocks.getIsUserAdmin.mockResolvedValue(false);
  mocks.checkApiKey.mockResolvedValue({ valid: false, role: null, statements: null });
  app = Fastify();
  app.get(
    "/sites/:siteId/session-replay/correlation-config",
    { preHandler: [resolveSiteId, requireSitePermission("replay:read")] as any },
    getReplayCorrelationConfig
  );
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

describe("private correlation configuration route", () => {
  it.each([{}, { "x-private-key": "private-public-replay-key" }])(
    "never grants profiles through public replay access or a private link %#",
    async headers => {
      const response = await app.inject({ url: "/sites/12/session-replay/correlation-config", headers });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("grafana.example.com");
      expect(mocks.getSiteIsPubliclyReadable).not.toHaveBeenCalled();
    }
  );
  it("requires the real site role and returns only site-scoped no-store profiles", async () => {
    mocks.getSessionFromReq.mockResolvedValue({ user: { id: "user1" } });
    mocks.getUserSiteRole.mockResolvedValue("viewer");
    const response = await app.inject({ url: "/sites/12/session-replay/correlation-config" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      enabled: true,
      profiles: [Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "siteIds"))],
    });
    const other = await app.inject({ url: "/sites/99/session-replay/correlation-config" });
    expect(other.json()).toEqual({ enabled: false, profiles: [] });
    mocks.getUserSiteRole.mockResolvedValue(null);
    const denied = await app.inject({ url: "/sites/12/session-replay/correlation-config" });
    expect(denied.statusCode).toBe(403);
  });
  it("honors scoped credentials rather than treating analytics:read as replay access", async () => {
    mocks.checkApiKey.mockResolvedValue({
      valid: true,
      role: "viewer",
      userId: "user1",
      statements: { analytics: ["read"] },
    });
    const denied = await app.inject({
      url: "/sites/12/session-replay/correlation-config",
      headers: { authorization: "Bearer key" },
    });
    expect(denied.statusCode).toBe(403);
    mocks.checkApiKey.mockResolvedValue({
      valid: true,
      role: "viewer",
      userId: "user1",
      statements: { replay: ["read"] },
    });
    const allowed = await app.inject({
      url: "/sites/12/session-replay/correlation-config",
      headers: { authorization: "Bearer key" },
    });
    expect(allowed.statusCode).toBe(200);
  });
  it("does not return or log raw malformed operator configuration", async () => {
    mocks.getSessionFromReq.mockResolvedValue({ user: { id: "user1" } });
    mocks.getUserSiteRole.mockResolvedValue("viewer");
    vi.stubEnv("WOTCV_REPLAY_CORRELATION_JSON", "sensitive operator input");
    const response = await app.inject({ url: "/sites/12/session-replay/correlation-config" });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("sensitive");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
});
