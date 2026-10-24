import type { ReplayObservabilityProfile } from "@rybbit/shared";

import { authedFetch } from "../../utils";

export function fetchReplayObservability(siteId: string | number, privateKey?: string | null) {
  return authedFetch<{ profiles: ReplayObservabilityProfile[] }>(
    `/sites/${encodeURIComponent(siteId)}/replay-observability`,
    undefined,
    { requestPrivateKey: privateKey }
  );
}
