import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCorsOptionsDelegate, createRejectUntrustedOriginHook } from "./cors.js";
import { registerIndexingProtection } from "./indexingProtection.js";

const expectedRobotsTag = "noindex, nofollow, nosnippet, noimageindex";

describe("indexing protection", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    registerIndexingProtection(app);

    const env = { NODE_ENV: "production", BASE_URL: "https://tracking.wot-cv.com" };
    await app.register(cors, { delegator: createCorsOptionsDelegate(env) });
    app.addHook("onRequest", createRejectUntrustedOriginHook(env));
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL("../../public/", import.meta.url)),
      prefix: "/static/",
      maxAge: "1h",
    });

    app.get("/api/health", async () => ({ healthy: true }));
    app.post("/api/track", async () => ({ success: true }));
    app.delete("/api/sites/:siteId", async () => ({ success: true }));
    app.get("/redirect", async (_request, reply) => reply.redirect("/login"));
    app.get("/error", async () => {
      throw new Error("Test error");
    });

    await app.register(async fastify => {
      fastify.get("/api/auth/raw", async (_request, reply) => {
        reply.header("Set-Cookie", "session=test; HttpOnly; Secure");
        const headers = new Map<string, string | number | readonly string[]>();
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value != null) headers.set(name, value);
        }
        reply.raw.setHeaders(headers);
        reply.raw.writeHead(302, { Location: "/login" });
        reply.raw.end();
      });

      fastify.post("/api/mcp", async (_request, reply) => {
        reply.hijack();
        reply.raw.setHeader("Cache-Control", "no-store");
        reply.raw.writeHead(200, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", result: {}, id: 1 }));
      });
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("keeps successful health responses unchanged", async () => {
    const response = await app.inject({ url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ healthy: true });
    expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
  });

  it("covers redirects without changing their destination", async () => {
    const response = await app.inject({ url: "/redirect" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/login");
    expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
  });

  it.each([
    ["/error", 500],
    ["/missing", 404],
  ])("covers %s error responses", async (url, statusCode) => {
    const response = await app.inject({ url: String(url) });

    expect(response.statusCode).toBe(statusCode);
    expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
  });

  it("covers static scripts and cache revalidation without changing caching", async () => {
    const response = await app.inject({ url: "/static/web-vitals.iife.js" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers.etag).toBeDefined();

    const cached = await app.inject({
      url: "/static/web-vitals.iife.js",
      headers: { "if-none-match": String(response.headers.etag) },
    });

    expect(cached.statusCode).toBe(304);
    expect(cached.headers["x-robots-tag"]).toBe(expectedRobotsTag);
    expect(cached.body).toBe("");
  });

  it("covers HEAD requests without adding a response body", async () => {
    const response = await app.inject({ method: "HEAD", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
    expect(response.body).toBe("");
  });

  it("preserves public tracking CORS on preflight and POST requests", async () => {
    const origin = "https://customer.example";
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/track",
      headers: { origin, "access-control-request-method": "POST" },
    });
    const tracked = await app.inject({ method: "POST", url: "/api/track", headers: { origin } });

    expect(preflight.statusCode).toBe(204);
    expect(tracked.statusCode).toBe(200);
    expect(tracked.json()).toEqual({ success: true });
    for (const response of [preflight, tracked]) {
      expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    }
  });

  it("covers early CORS rejection without allowing untrusted management origins", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/sites/1",
      headers: { origin: "https://untrusted.example" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preserves headers copied into raw auth responses", async () => {
    const response = await app.inject({ url: "/api/auth/raw" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/login");
    expect(response.headers["set-cookie"]).toEqual(["session=test; HttpOnly; Secure"]);
    expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
  });

  it("covers hijacked MCP responses that bypass Fastify header copying", async () => {
    const response = await app.inject({ method: "POST", url: "/api/mcp" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jsonrpc: "2.0", result: {}, id: 1 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe(expectedRobotsTag);
  });
});
