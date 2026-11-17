import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ isAdmin: true, role: "admin", signedIn: true, sourceCodeUrl: undefined as unknown }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("next/navigation", () => ({ usePathname: () => "/12/main" }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/lib/const", async original => ({ ...(await original<object>()), IS_CLOUD: false, DEPLOYMENT: undefined }));
vi.mock("@/lib/auth", () => ({
  authClient: {
    useSession: () => ({ data: state.signedIn ? { user: { role: state.role, name: "Ada" } } : undefined }),
  },
}));
vi.mock("@/app/admin/hooks/useAdminPermission", () => ({ useAdminPermission: () => ({ isAdmin: state.isAdmin }) }));
vi.mock("@/api/admin/hooks/useSites", () => ({ useGetSite: () => ({ data: { siteId: 12, organizationId: "org1" } }) }));
vi.mock("@/lib/subscription/useStripeSubscription", () => ({ useStripeSubscription: () => ({ data: undefined }) }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ site: 12 }) }));
vi.mock("@/lib/configs", async original => ({
  ...(await original<object>()),
  useConfigs: () => ({ configs: { sourceCodeUrl: state.sourceCodeUrl } }),
}));
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
  state.signedIn = true;
  state.sourceCodeUrl = undefined;
});

describe("configured fork source link", () => {
  it("shows the canonical public source URL without authentication or admin requirements", () => {
    state.role = "user";
    state.isAdmin = false;
    state.signedIn = false;
    state.sourceCodeUrl = "HTTPS://CODE.EXAMPLE.COM:443/team/fork/tree/release";
    render(<AppSidebar />);
    const link = screen.getByRole("link", { name: "Source code" });
    expect(link.getAttribute("href")).toBe("https://code.example.com/team/fork/tree/release");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("link", { name: "Documentation" }).getAttribute("rel")).toBe("noopener noreferrer");
  });
  it.each([
    undefined,
    null,
    1,
    {},
    "",
    "http://code.example.com/fork",
    "javascript:alert(1)",
    "https://user:secret@code.example.com/fork",
    "https://code.example.com/fork?token=secret",
    "https://code.example.com/fork#license",
    "https://code.example.com/fork?",
    "https://code.example.com/fork#",
    "https://code.example.com/\nsecret",
    "https://code.example.com/" + "x".repeat(2048),
    "https://code.example.com/" + "é".repeat(400),
  ])("omits missing or malformed public payload %j", value => {
    state.sourceCodeUrl = value;
    render(<AppSidebar />);
    expect(screen.queryByRole("link", { name: "Source code" })).toBeNull();
  });
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
