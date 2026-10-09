import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), key: vi.fn(), session: vi.fn() }));
vi.mock("../../lib/auth-utils.js", () => ({
  getUserSiteRole: mocks.access,
  checkApiKey: mocks.key,
  getSessionFromReq: mocks.session,
}));
vi.mock("../../lib/access.js", () => ({}));
vi.mock("../../lib/siteConfig.js", () => ({ siteConfig: {} }));
import { requireSitePermission } from "../../lib/auth-middleware.js";
import { getReplayObservability } from "./getReplayObservability.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("authenticated replay observability configuration", () => {
  it.each([false, true])("requires real site access (%s), not a private/public replay link", async access => {
    mocks.access.mockResolvedValue(access ? "viewer" : null);
    mocks.key.mockResolvedValue({ valid: false });
    mocks.session.mockResolvedValue(access ? { user: { id: "user-1" } } : null);
    vi.stubEnv("WOTCV_REPLAY_OBSERVABILITY_PROFILES", "");
    const app = Fastify();
    app.get<{ Params: { siteId: string } }>(
      "/sites/:siteId/replay-observability",
      { preHandler: requireSitePermission("replay:read") },
      getReplayObservability
    );
    try {
      const response = await app.inject({
        url: "/sites/2/replay-observability",
        headers: { "x-private-key": "public-replay-key" },
      });
      expect(response.statusCode).toBe(access ? 200 : 403);
      if (access) {
        const { profiles } = response.json();
        expect(profiles).toHaveLength(1);
        expect(profiles[0]).toMatchObject({
          requestOrigin: "https://api.wot-cv.com",
          grafanaUrl: "https://dashboard.wot-cv.com",
          orgId: 1,
          lokiDatasourceUid: "bet3mn133whkwd",
          tempoDatasourceUid: "df0rqhtz9e3uoa",
        });
        expect(profiles[0]).not.toHaveProperty("siteIds");
        expect(response.headers["cache-control"]).toBe("private, no-store");
      } else {
        expect(response.body).not.toContain("dashboard.wot-cv.com");
        expect(response.body).not.toContain("bet3mn133whkwd");
      }
    } finally {
      await app.close();
    }
  });
  it.each([
    { siteId: 2, config: "[]" },
    { siteId: 3, config: "" },
  ])("returns no profiles when disabled or outside the default site (%j)", async ({ siteId, config }) => {
    mocks.access.mockResolvedValue("viewer");
    mocks.key.mockResolvedValue({ valid: false });
    mocks.session.mockResolvedValue({ user: { id: "user-1" } });
    vi.stubEnv("WOTCV_REPLAY_OBSERVABILITY_PROFILES", config);
    const app = Fastify();
    app.get<{ Params: { siteId: string } }>(
      "/sites/:siteId/replay-observability",
      { preHandler: requireSitePermission("replay:read") },
      getReplayObservability
    );
    try {
      const response = await app.inject(`/sites/${siteId}/replay-observability`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ profiles: [] });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      await app.close();
    }
  });
  it("registers the production route with the authenticated replay chain", () => {
    const source = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");
    expect(source).toContain(
      'fastify.get("/sites/:siteId/replay-observability", site("replay:read"), getReplayObservability)'
    );
  });
  it("fails closed on invalid config without disclosing its contents", async () => {
    vi.stubEnv("WOTCV_REPLAY_OBSERVABILITY_PROFILES", "secret-invalid-config");
    const app = Fastify();
    app.get("/sites/:siteId/replay-observability", getReplayObservability);
    try {
      const response = await app.inject("/sites/2/replay-observability");
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("secret-invalid-config");
    } finally {
      await app.close();
    }
  });
});
