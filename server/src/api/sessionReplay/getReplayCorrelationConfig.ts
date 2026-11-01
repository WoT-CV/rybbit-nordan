import type { FastifyReply, FastifyRequest } from "fastify";
import { getReplayCorrelationProfiles } from "../../lib/replayCorrelation.js";

export async function getReplayCorrelationConfig(
  request: FastifyRequest<{ Params: { siteId: string } }>,
  reply: FastifyReply
) {
  reply.header("Cache-Control", "private, no-store");
  try {
    const profiles = getReplayCorrelationProfiles(Number(request.params.siteId));
    return reply.send({ enabled: profiles.length > 0, profiles });
  } catch {
    request.log.error("Invalid replay correlation configuration");
    return reply.status(503).send({ error: "Replay correlation configuration is unavailable" });
  }
}
