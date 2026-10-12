import type { FastifyInstance } from "fastify";

const ROBOTS_TAG = "noindex, nofollow, nosnippet, noimageindex";

export function registerIndexingProtection(server: FastifyInstance): void {
  server.addHook("onRequest", (_request, reply, done) => {
    // Auth and MCP can write directly to the raw response, bypassing onSend.
    reply.raw.setHeader("X-Robots-Tag", ROBOTS_TAG);
    done();
  });
}
