import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { getRequestPrivateKey } from "@/api/requestContext";
import { authClient } from "@/lib/auth";
import { getSiteRouteContext } from "@/lib/siteRoute";
import { useGetSite } from "./useSites";
import { fetchReplayCorrelationConfig } from "../endpoints/replayCorrelation";

export function useReplayCorrelation(siteId: number, open: boolean) {
  const { data: session, isPending } = authClient.useSession();
  const { data: site, isLoading: isSiteLoading } = useGetSite(siteId);
  const pathname = usePathname();
  const permissions = [...(site?.permissions ?? [])].sort().join(",");
  const privateLink = !!getSiteRouteContext(pathname).privateKey || !!getRequestPrivateKey();
  const authorized =
    !isPending &&
    !isSiteLoading &&
    !!session?.user &&
    !!site?.permissions?.includes("replay:read") &&
    !privateLink &&
    Number.isSafeInteger(siteId) &&
    siteId > 0;

  const query = useQuery({
    queryKey: [
      "replay-correlation-config",
      siteId,
      session?.user.id ?? null,
      session?.session.id ?? null,
      session?.session.activeOrganizationId ?? null,
      session?.session.impersonatedBy ?? null,
      session?.user.role ?? null,
      permissions,
    ],
    queryFn: ({ signal }) => fetchReplayCorrelationConfig(siteId, signal),
    enabled: open && authorized,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    placeholderData: undefined,
    refetchOnMount: "always",
  });

  // A previous successful response must not survive revocation, logout or an opening revalidation.
  return {
    authorized,
    isLoading: open && authorized && (query.isPending || query.isFetching),
    isError: open && authorized && query.isError,
    config: open && authorized && !query.isFetching && !query.isError ? query.data : undefined,
    refetch: query.refetch,
  };
}
