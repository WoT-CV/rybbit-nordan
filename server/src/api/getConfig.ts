import { FastifyRequest, FastifyReply } from "fastify";
import { createRequire } from "module";
import { DISABLE_SIGNUP, LITE_DASHBOARD, MAPBOX_TOKEN } from "../lib/const.js";
import { getServiceConfiguration } from "../lib/serviceConfiguration.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

export async function getConfig(_: FastifyRequest, reply: FastifyReply) {
  const { emailEnabled, gscEnabled, weeklyReportsEnabled } = getServiceConfiguration();
  return reply.send({
    disableSignup: DISABLE_SIGNUP,
    mapboxToken: MAPBOX_TOKEN,
    liteDashboard: LITE_DASHBOARD,
    emailEnabled,
    gscEnabled,
    weeklyReportsEnabled,
  });
}

export async function getVersion(_: FastifyRequest, reply: FastifyReply) {
  return reply.send({ version });
}
