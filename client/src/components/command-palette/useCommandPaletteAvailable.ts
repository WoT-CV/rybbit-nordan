import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth";
import { useHydrated } from "@/hooks/useHydrated";
import { getSiteRouteContext } from "@/lib/siteRoute";

/**
 * The palette and the "?" sheet exist for signed-in users. Public dashboards,
 * the claim flow and shared private links are for visitors, so they get
 * neither. (Embeds are checked when a key arrives: see isEmbedView.)
 */
export function useCommandPaletteAvailable(): boolean {
  const { data: session } = authClient.useSession();
  const hydrated = useHydrated();
  const pathname = usePathname();
  return hydrated && !!session?.user && !getSiteRouteContext(pathname).privateKey;
}
