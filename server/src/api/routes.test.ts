import Fastify, { type RouteOptions } from "fastify";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

// Cloud-only SDK clients are constructed at import time; they need a key to
// construct, never to register a route.
vi.hoisted(() => {
  process.env.RESEND_API_KEY ||= "re_test";
  process.env.STRIPE_SECRET_KEY ||= "sk_test";
});
// Load the real route table with the infrastructure clients stubbed: no
// database, cache or auth provider is contacted — the test only registers
// routes and reads what each one declares.
vi.mock("../db/postgres/postgres.js", () => ({ db: {}, sql: {} }));
vi.mock("../db/redis/redis.js", () => ({
  dashboardCacheRedis: { status: "end", eval: vi.fn() },
  apiRateLimitRedis: { status: "end", eval: vi.fn() },
}));
vi.mock("../lib/auth.js", () => ({ auth: { api: {} } }));
vi.mock("./sessionReplay/index.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./sessionReplay/index.js")>()),
  // Exercise the real route/decoder, but stop before database ingestion.
  recordSessionReplay: async (request: { body: unknown }) => request.body,
}));

vi.mock("../lib/const.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../lib/const.js")>()),
  // Register the cloud-only billing routes too.
  IS_CLOUD: true,
}));

import { PERMISSIONS } from "@rybbit/shared";
import type { RouteAccess } from "../lib/auth-middleware.js";
import { apiRoutes } from "./routes.js";
import { getBuildMetadata } from "../lib/buildMetadata.js";

async function collectRoutes() {
  const routes: { method: string; url: string; access: RouteAccess | undefined }[] = [];
  const app = Fastify();
  app.addHook("onRoute", (route: RouteOptions) => {
    for (const method of [route.method].flat()) {
      if (method === "HEAD") continue;
      routes.push({ method, url: route.url, access: route.config?.access });
    }
  });
  await app.register(apiRoutes, { prefix: "/api" });
  await app.ready();
  await app.close();
  return routes;
}

const describeAccess = (access: RouteAccess | undefined) => {
  if (!access) return "UNDECLARED";
  if (typeof access === "string") return access;
  const minRole = PERMISSIONS[access.permission].minRole;
  if (access.level === "site") {
    return `site ${access.permission} [${minRole}+]${access.allowPublic ? " (or public)" : ""}`;
  }
  return `org ${access.permission} [${minRole}+]`;
};

describe("API route table", () => {
  it("declares who may call every route", async () => {
    const routes = await collectRoutes();

    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter(route => !route.access)).toEqual([]);
  });

  // The whole access matrix in one reviewable place: any change to who may
  // call an endpoint shows up as a diff here.
  it("pins the access each route requires", async () => {
    const routes = await collectRoutes();
    const table = routes
      .map(route => `${route.method.padEnd(6)} ${route.url} → ${describeAccess(route.access)}`)
      .sort();

    expect(table).toMatchSnapshot();
  });

  it("keeps bounded gzip attached to the real replay route, not to other public endpoints", async () => {
    const app = Fastify({ bodyLimit: 1024 });
    await app.register(apiRoutes, { prefix: "/api" });
    try {
      const payload = { events: [{ type: 6, data: { plugin: "old", body: "Zażółć 🐸" } }] };
      const headers = { "content-type": "application/json", "content-encoding": "gzip" };
      const response = await app.inject({
        method: "POST",
        url: "/api/session-replay/record/site-42",
        headers,
        payload: gzipSync(JSON.stringify(payload)),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(payload);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/session-replay/record/site-42",
            headers,
            payload: gzipSync(JSON.stringify({ body: "x".repeat(1024) })),
          })
        ).statusCode
      ).toBe(413);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/track",
            headers,
            payload: gzipSync("{}"),
          })
        ).statusCode
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("keeps build provenance on the public health route", async () => {
    const app = Fastify();
    await app.register(apiRoutes, { prefix: "/api" });
    try {
      const response = await app.inject({ url: "/api/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(getBuildMetadata());
      expect(response.json()).toHaveProperty("gitSha");
      expect(response.json()).toHaveProperty("sourceCodeUrl");
    } finally {
      await app.close();
    }
  });
});
