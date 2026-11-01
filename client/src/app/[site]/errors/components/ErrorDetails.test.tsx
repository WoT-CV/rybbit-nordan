import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ identified: true }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useParams: () => ({ site: "12", privateKey: "private-key" }) }));
vi.mock("@/lib/geo", () => ({ useGetRegionName: () => ({ getRegionName: () => "" }) }));
vi.mock("@/api/analytics/hooks/errors/useGetErrorEvents", () => ({
  useGetErrorEventsInfinite: () => ({
    data: {
      pages: [
        {
          totalCount: 1,
          data: [
            {
              timestamp: "2026-10-01 12:00:00",
              session_id: "s1",
              user_id: "device",
              identified_user_id: state.identified ? "000123" : "",
              traits: state.identified ? { username: "[TAG] nick", avatarUrl: "https://logos.example/clan.png" } : null,
            },
          ],
        },
      ],
    },
  }),
}));
vi.mock("@/components/ui/tooltip", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return { Tooltip: Wrapper, TooltipTrigger: Wrapper, TooltipContent: Wrapper };
});
import { ErrorDetails } from "./ErrorDetails";

afterEach(() => {
  cleanup();
  state.identified = true;
});

describe("error visitor identity", () => {
  it("uses the current nickname and clan logo and preserves private profile routing", () => {
    const { container } = render(<ErrorDetails errorMessage="boom" />);
    expect(screen.getByText("[TAG] nick")).toBeTruthy();
    expect(container.querySelector('img[src="https://logos.example/clan.png"]')).not.toBeNull();
    expect(container.querySelector('a[href="/12/private-key/user/000123"]')).not.toBeNull();
  });
  it("keeps anonymous visitor fallback and device routing", () => {
    state.identified = false;
    const { container } = render(<ErrorDetails errorMessage="boom" />);
    expect(container.querySelector('a[href="/12/private-key/user/device"] svg')).not.toBeNull();
    expect(container.querySelector('img[src*="logos.example"]')).toBeNull();
    expect(screen.queryByText("[TAG] nick")).toBeNull();
  });
});
