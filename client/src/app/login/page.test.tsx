import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ emailEnabled: true }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/const", async original => ({ ...(await original<object>()), IS_CLOUD: false }));
vi.mock("@/lib/configs", () => ({
  useConfigs: () => ({ configs: { emailEnabled: state.emailEnabled }, isLoading: false }),
}));
vi.mock("@/lib/auth", () => ({ authClient: { signIn: { email: vi.fn() } } }));
vi.mock("@/hooks/useSetPageTitle", () => ({ useSetPageTitle: () => {} }));
vi.mock("@/components/RybbitLogo", () => ({ RybbitTextLogo: () => null }));
vi.mock("@/components/SpinningGlobe", () => ({ SpinningGlobe: () => null }));
vi.mock("@/components/auth/SocialButtons", () => ({ SocialButtons: () => null }));
vi.mock("@/components/auth/Turnstile", () => ({ Turnstile: () => null }));
import Page from "./page";
vi.mock("@/lib/userStore", () => ({ userStore: { setState: vi.fn() } }));
afterEach(() => {
  cleanup();
  state.emailEnabled = true;
});
describe("native self-hosted password recovery", () => {
  it("offers recovery when transactional mail is ready", () => {
    render(<Page />);
    expect(screen.getByRole("link", { name: "Forgot password?" }).getAttribute("href")).toBe("/reset-password");
  });
  it("does not offer a recovery email without configured delivery", () => {
    state.emailEnabled = false;
    render(<Page />);
    expect(screen.queryByRole("link", { name: "Forgot password?" })).toBeNull();
  });
});
