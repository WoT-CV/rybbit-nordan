import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/7/main",
  params: new URLSearchParams(),
  mobileSite: false,
  hideSidebar: false,
}));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => state.params,
}));
vi.mock("@/lib/const", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/const")>()),
  DEPLOYMENT: "self-hosted",
  IS_CLOUD: false,
}));
vi.mock("@/api/admin/hooks/useSites", () => ({
  useGetSite: () => ({ data: { siteId: 7, type: state.mobileSite ? "mobile" : "web" } }),
}));
vi.mock("@/lib/subscription/useStripeSubscription", () => ({
  useStripeSubscription: () => ({ data: { planName: "self-hosted" }, isLoading: false }),
}));
vi.mock("@/hooks/useIsProduction", () => ({ useAppEnv: () => "self-hosted" }));
vi.mock("../../utils", () => ({ useEmbedPageOptions: () => ({ embed: false, hideSidebar: state.hideSidebar }) }));
vi.mock("./SiteSelector", () => ({ SiteSelector: () => <span>Site selector</span> }));
vi.mock("@/components/SiteSettings/SiteSettings", () => ({
  SiteSettings: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  state.pathname = "/7/main";
  state.params = new URLSearchParams();
  state.mobileSite = false;
  state.hideSidebar = false;
});
afterEach(cleanup);

describe("WoT-CV sidebar after upstream regrouping", () => {
  it("keeps extended analytics available without a cloud subscription", () => {
    render(<Sidebar />);
    for (const [label, path] of [
      ["Pages", "pages"],
      ["Bots", "bots"],
      ["Performance", "performance"],
      ["Query", "query"],
      ["Dashboards", "dashboards"],
      ["Retention", "retention"],
      ["Replay", "replay"],
    ]) {
      expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(`/7/${path}`);
    }
    expect(screen.getAllByRole("link", { name: "Performance" })).toHaveLength(1);
    for (const group of ["Traffic", "Behavior", "Conversion", "Health", "Explore"]) {
      expect(screen.getByText(group)).toBeTruthy();
    }
  });

  it("preserves private-link keys and active filters across sections", () => {
    state.pathname = "/7/aaaaaaaaaaaa/main";
    state.params = new URLSearchParams("timeMode=week&segment=3");
    render(<Sidebar />);
    expect(screen.getByRole("link", { name: "Retention" }).getAttribute("href")).toBe(
      "/7/aaaaaaaaaaaa/retention?timeMode=week&segment=3"
    );
    for (const label of ["API Playground", "Query", "Dashboards"]) {
      expect(screen.queryByRole("link", { name: label })).toBeNull();
    }
    expect(screen.queryByText("Explore")).toBeNull();
    expect(screen.queryByText("Site Settings")).toBeNull();
  });

  it("retains mobile-site exclusions and embed sidebar visibility", () => {
    state.mobileSite = true;
    const view = render(<Sidebar />);
    expect(screen.queryByRole("link", { name: "Performance" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Replay" })).toBeNull();
    expect(screen.getByRole("link", { name: "Query" })).toBeTruthy();
    state.hideSidebar = true;
    view.rerender(<Sidebar />);
    expect(screen.queryByRole("link", { name: "Query" })).toBeNull();
  });
});
