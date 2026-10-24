import { useQuery } from "@tanstack/react-query";

import { useStore } from "@/lib/store";
import { userStore } from "@/lib/userStore";
import { getRequestCacheScope, getRequestPrivateKey } from "../../requestContext";

import { fetchReplayObservability } from "../endpoints/replayObservability";

export function useReplayObservability() {
  const siteId = useStore(state => state.site);
  useStore(state => state.privateKey);
  const privateKey = getRequestPrivateKey();
  const userId = userStore(state => state.user?.id);
  const query = useQuery({
    queryKey: ["replay-observability", siteId, userId, getRequestCacheScope(privateKey)],
    queryFn: () => fetchReplayObservability(siteId!, privateKey),
    enabled: !!siteId && !!userId,
    staleTime: 60_000,
    retry: false,
  });
  return userId && siteId ? query.data?.profiles : undefined;
}
