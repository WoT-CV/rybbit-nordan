import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ isAdmin: true, role: "admin" }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("next/navigation", () => ({ usePathname: () => "/12/main" }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/lib/const", async original => ({ ...(await original<object>()), IS_CLOUD: false, DEPLOYMENT: undefined }));
vi.mock("@/lib/auth", () => ({
  authClient: { useSession: () => ({ data: { user: { role: state.role, name: "Ada" } } }) },
}));
vi.mock("@/app/admin/hooks/useAdminPermission", () => ({ useAdminPermission: () => ({ isAdmin: state.isAdmin }) }));
vi.mock("@/api/admin/hooks/useSites", () => ({ useGetSite: () => ({ data: { siteId: 12, organizationId: "org1" } }) }));
vi.mock("@/lib/subscription/useStripeSubscription", () => ({ useStripeSubscription: () => ({ data: undefined }) }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ site: 12 }) }));
vi.mock("@/hooks/useSignout", () => ({ useSignout: () => vi.fn() }));
vi.mock("@/app/[site]/utils", () => ({ useEmbedablePage: () => false }));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("./RybbitLogo", () => ({ RybbitLogo: () => null }));
import { AppSidebar } from "./AppSidebar";
afterEach(() => {
  cleanup();
  state.isAdmin = true;
  state.role = "admin";
});
describe("self-hosted admin navigation", () => {
  it("allows an existing system admin without a cloud/deployment flag", () => {
    render(<AppSidebar />);
    expect(screen.getByRole("link", { name: "Admin" }).getAttribute("href")).toBe("/admin");
  });
  it.each(["permission", "role"])("retains the native %s check", check => {
    if (check === "permission") state.isAdmin = false;
    else state.role = "user";
    render(<AppSidebar />);
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });
});
