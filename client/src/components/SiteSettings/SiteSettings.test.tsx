import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ready: true, canWrite: true }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("@/lib/configs", () => ({ useConfigs: () => ({ configs: { gscEnabled: state.ready } }) }));
vi.mock("@/hooks/usePermissions", () => ({ useSitePermissions: () => ({ can: () => state.canWrite }) }));
vi.mock("@/api/admin/endpoints", () => ({ updateSiteConfig: vi.fn() }));
vi.mock("@/api/admin/hooks/useSites", () => ({
  useGetSite: () => ({ data: { siteId: 12, type: "web", organizationId: "org1" } }),
  useGetSitesFromOrg: () => ({ refetch: vi.fn() }),
}));
vi.mock("./GeneralTab", () => ({ GeneralTab: () => null }));
vi.mock("./TrackingTab", () => ({ TrackingTab: () => null }));
vi.mock("./ExclusionsTab", () => ({ ExclusionsTab: () => null }));
vi.mock("./ScriptBuilder", () => ({ ScriptBuilder: () => null }));
vi.mock("./ImportManager", () => ({ ImportManager: () => null }));
vi.mock("./EmbedTab", () => ({ EmbedTab: () => null }));
vi.mock("./DashboardEmbedTab", () => ({ DashboardEmbedTab: () => null }));
vi.mock("./UsageTab", () => ({ UsageTab: () => null }));
vi.mock("./IntegrationsTab", () => ({
  IntegrationsTab: ({ disabled }: { disabled: boolean }) => <button disabled={disabled}>Connect GSC</button>,
}));
import { SiteSettings } from "./SiteSettings";

function openSettings() {
  render(<SiteSettings siteId={12} trigger={<button>Open settings</button>} />);
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
}
afterEach(() => {
  cleanup();
  state.ready = true;
  state.canWrite = true;
});
describe("configured native GSC", () => {
  it("offers integrations on self-hosted when OAuth is ready", () => {
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect((screen.getByRole("button", { name: "Connect GSC" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("keeps write access denied even when integration is available", () => {
    state.canWrite = false;
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect((screen.getByRole("button", { name: "Connect GSC" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("hides unavailable OAuth rather than offering a broken connect action", () => {
    state.ready = false;
    openSettings();
    expect(screen.queryByRole("button", { name: "Integrations" })).toBeNull();
  });
});
