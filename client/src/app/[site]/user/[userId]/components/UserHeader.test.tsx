import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserInfo } from "@/api/analytics/endpoints";
import { UserHeader } from "./UserHeader";

const mocks = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("next-intl", () => ({
  useLocale: () => "en-US",
  useExtracted: () => (message: string, values?: Record<string, string>) =>
    message.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? ""),
}));
vi.mock("@/lib/userStore", () => ({ userStore: () => ({ user: null }) }));
vi.mock("@/lib/store", () => ({ getTimezone: () => "UTC" }));
vi.mock("@/hooks/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ formatRelative: () => "now", formatDateTime: () => "date", hour12: true }),
}));
vi.mock("@/hooks/useReplayAvailable", () => ({ useReplayAvailable: () => false }));
vi.mock("@/components/Avatar", () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock("@/components/IdentifiedBadge", () => ({ IdentifiedBadge: () => <span>Identified user</span> }));
vi.mock("./UserActions", () => ({ UserActions: () => null }));
vi.mock("@/components/interior/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ copy: mocks.copy, status: "idle" }),
}));
vi.mock("@/components/interior/copy-button", () => ({ CopyAnnouncement: () => null, CopyStatusIcon: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const profile = (email: unknown) =>
  ({
    user_id: "device",
    identified_user_id: "000123",
    traits: { username: "[TAG] Nick", email },
  }) as unknown as UserInfo;

describe("profile header email traits", () => {
  it.each([
    {},
    { address: "person@example.test" },
    [],
    ["person@example.test"],
    42,
    0,
    true,
    false,
    null,
    undefined,
    "",
    "   ",
  ])("renders malformed or empty email %j without crashing or coercing it", email => {
    const { container } = render(
      <UserHeader userId="000123" displayName="[TAG] Nick" data={profile(email)} isLoading={false} />
    );
    expect(screen.getByRole("heading", { name: "[TAG] Nick" })).not.toBeNull();
    expect(container.querySelector("span[title]")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy user ID 000123" })).not.toBeNull();
  });
  it("retains a valid email exactly and copies the opaque ID without numeric conversion", () => {
    const email = "Person+tag@example.test";
    render(<UserHeader userId="000123" displayName="[TAG] Nick" data={profile(email)} isLoading={false} />);
    expect(screen.getByText(email).getAttribute("title")).toBe(email);
    fireEvent.click(screen.getByRole("button", { name: "Copy user ID 000123" }));
    expect(mocks.copy).toHaveBeenCalledWith("000123");
  });
});
