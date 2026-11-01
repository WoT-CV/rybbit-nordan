import type { ReplayCorrelationProfile } from "@rybbit/shared";
import { z } from "zod";
import { getRequestPrivateKey } from "../../requestContext";
import { ApiError, authedFetch } from "../../utils";

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const label = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const replayCorrelationProfileSchema = z.object({
  requestOrigin: z
    .string()
    .max(256)
    .refine(value => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && value === url.origin;
      } catch {
        return false;
      }
    }),
  grafanaUrl: z
    .string()
    .max(2048)
    .refine(value => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
      } catch {
        return false;
      }
    }),
  orgId: z.number().int().positive().safe(),
  lokiDatasourceUid: identifier,
  tempoDatasourceUid: identifier.optional(),
  serviceName: label,
  environment: label,
  timePaddingMs: z.number().int().min(0).max(300_000),
});

export interface ReplayCorrelationConfig {
  enabled: boolean;
  profiles: ReplayCorrelationProfile[];
}

const configSchema = z.object({ enabled: z.boolean(), profiles: z.array(replayCorrelationProfileSchema).max(32) });

export async function fetchReplayCorrelationConfig(
  siteId: number,
  signal?: AbortSignal
): Promise<ReplayCorrelationConfig> {
  if (!Number.isSafeInteger(siteId) || siteId <= 0) throw new Error("Invalid site ID");
  if (getRequestPrivateKey())
    throw new ApiError("Correlation configuration requires a signed-in site member", 403, undefined);
  const response = await authedFetch<unknown>(`/sites/${siteId}/session-replay/correlation-config`, undefined, {
    signal,
    headers: { "Cache-Control": "no-cache" },
  });
  const config = configSchema.parse(response);
  return { enabled: config.enabled, profiles: config.enabled ? config.profiles : [] };
}
