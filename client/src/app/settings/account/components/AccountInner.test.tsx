import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ready: true, mutate: vi.fn() }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("@/lib/configs", () => ({ useConfigs: () => ({ configs: { weeklyReportsEnabled: state.ready } }) }));
vi.mock("@/lib/auth", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "u1", name: "Ada", email: "ada@example.com", sendAutoEmailReports: true } },
      refetch: vi.fn(),
    }),
  },
}));
vi.mock("@/api/admin/hooks/useAccountSettings", () => ({
  useUpdateAccountSettings: () => ({ mutateAsync: state.mutate, isPending: false }),
}));
vi.mock("@/hooks/useActiveOrgName", () => ({ useActiveOrgName: () => "Example" }));
vi.mock("@/components/LanguageSwitcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("./ApiKeyManager", () => ({ ApiKeyManager: () => null }));
vi.mock("./ChangePassword", () => ({ ChangePassword: () => null }));
vi.mock("./DeleteAccount", () => ({ DeleteAccount: () => null, useHasActiveSubscription: () => false }));
import { AccountInner } from "./AccountInner";

afterEach(() => {
  cleanup();
  state.ready = true;
  vi.clearAllMocks();
});
describe("configured weekly report preferences", () => {
  it("allows a self-hosted user to opt out", () => {
    render(<AccountInner />);
    fireEvent.click(screen.getByRole("switch", { name: "Weekly email reports" }));
    expect(state.mutate).toHaveBeenCalledWith({ sendAutoEmailReports: false });
  });
  it("does not offer reports without a usable transport and base URL", () => {
    state.ready = false;
    render(<AccountInner />);
    expect(screen.queryByRole("switch", { name: "Weekly email reports" })).toBeNull();
  });
});
