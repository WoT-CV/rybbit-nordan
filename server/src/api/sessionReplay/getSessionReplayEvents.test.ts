import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionReplayEvents: vi.fn(),
  enrichWithTraits: vi.fn(),
}));

vi.mock("../../services/replay/sessionReplayQueryService.js", () => ({
  SessionReplayQueryService: class {
    getSessionReplayEvents = mocks.getSessionReplayEvents;
  },
}));
vi.mock("../analytics/utils/utils.js", () => ({ enrichWithTraits: mocks.enrichWithTraits }));

import { SessionReplayNotFoundError } from "../../services/replay/sessionReplayNotFoundError.js";
import { getSessionReplayEvents } from "./getSessionReplayEvents.js";

function appWithRoute() {
  const app = Fastify();
  app.get<{ Params: { siteId: string; sessionId: string } }>("/:siteId/:sessionId", getSessionReplayEvents);
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getSessionReplayEvents error contract", () => {
  it("returns 404 when replay metadata has expired or the replay was deleted", async () => {
    mocks.getSessionReplayEvents.mockRejectedValue(new SessionReplayNotFoundError("missing-session"));
    const app = appWithRoute();
    try {
      const response = await app.inject("/42/missing-session");

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Session replay not found" });
      expect(mocks.enrichWithTraits).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["Database unavailable", "Session replay not found", "Session replay not found for session broken-query"])(
    "does not mask an untyped backend failure as 404: %s",
    async message => {
      mocks.getSessionReplayEvents.mockRejectedValue(new Error(message));
      const app = appWithRoute();
      try {
        const response = await app.inject("/42/session");

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: "Internal server error" });
      } finally {
        await app.close();
      }
    }
  );
});
