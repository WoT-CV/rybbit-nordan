import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/12/main", type: "web" }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname, useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/const", async original => ({ ...(await original<object>()), IS_CLOUD: false, DEPLOYMENT: undefined }));
vi.mock("@/api/admin/hooks/useSites", () => ({ useGetSite: () => ({ data: { siteId: 12, type: state.type } }) }));
vi.mock("@/lib/subscription/useStripeSubscription", () => ({
  useStripeSubscription: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@/hooks/useIsProduction", () => ({ useAppEnv: () => "prod" }));
vi.mock("@/app/[site]/utils", () => ({ useEmbedPageOptions: () => ({ embed: false, hideSidebar: false }) }));
vi.mock("./SiteSelector", () => ({ SiteSelector: () => null }));
vi.mock("@/components/SiteSettings/SiteSettings", () => ({ SiteSettings: () => null }));
vi.mock("@/components/command-palette/CommandPaletteTrigger", () => ({ CommandPaletteTrigger: () => null }));
vi.mock("@/components/sidebar/Sidebar", () => ({
  Sidebar: {
    Item: ({ label, href }: { label: string; href: string }) => <a href={href}>{label}</a>,
    SectionHeader: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  },
}));
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  state.pathname = "/12/main";
  state.type = "web";
});
afterEach(cleanup);
describe("native self-hosted navigation", () => {
  it("links every shipped analytics surface without cloud or deployment flags", () => {
    render(<Sidebar />);
    for (const label of ["Pages", "Bots", "Performance", "Query", "Dashboards"])
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
  });
  it("preserves private-link restrictions while making Query available", () => {
    state.pathname = "/12/aabbccddeeff/main";
    render(<Sidebar />);
    expect(screen.getByRole("link", { name: "Query" }).getAttribute("href")).toBe("/12/aabbccddeeff/query");
    for (const label of ["Dashboards", "API Playground", "Feature Flags", "Experiments"])
      expect(screen.queryByRole("link", { name: label })).toBeNull();
  });
  it("does not offer web-only Performance for mobile apps", () => {
    state.type = "mobile";
    render(<Sidebar />);
    expect(screen.queryByRole("link", { name: "Performance" })).toBeNull();
  });
});
