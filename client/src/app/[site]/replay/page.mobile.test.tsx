import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplayStore } from "@/components/replay/replayStore";

const mocks = vi.hoisted(() => ({ width: 390 }));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@uidotdev/usehooks", () => ({ useMeasure: () => [() => {}, { width: 1200, height: 800 }] }));
vi.mock("@/hooks/useIsProduction", () => ({ useAppEnv: () => "self-hosted" }));
vi.mock("@/hooks/useSetPageTitle", () => ({ useSetPageTitle: () => {} }));
vi.mock("@/api/analytics/hooks/sessionReplay/useGetSessionReplays", () => ({
  useGetSessionReplays: () => ({ data: { pages: [{ data: [{ session_id: "mobile" }] }] }, isLoading: false }),
}));
vi.mock("@/components/DisabledOverlay", () => ({ DisabledOverlay: ({ children }: PropsWithChildren) => children }));
vi.mock("@/components/NothingFound", () => ({ NothingFound: () => null }));
vi.mock("@/components/replay/ReplayBreadcrumbs", () => ({ ReplayBreadcrumbs: () => <div>Replay timeline</div> }));
vi.mock("@/components/replay/player/ReplayPlayer", () => ({ ReplayPlayer: () => <div>Desktop replay</div> }));
vi.mock("@/components/Sessions/ReplayDrawer", () => ({
  ReplayDrawer: ({ open, preservePlaybackState }: { open: boolean; preservePlaybackState?: boolean }) =>
    open ? <div data-preserve={String(preservePlaybackState)}>Mobile replay</div> : null,
}));
vi.mock("../components/SubHeader/SubHeader", () => ({ SubHeader: () => null }));
vi.mock("./components/EnableSessionReplay", () => ({ EnableSessionReplay: () => null }));
vi.mock("./components/ReplayList", () => ({
  ReplayList: ({ onSelect }: { onSelect?: () => void }) => <button onClick={onSelect}>Open replay</button>,
}));

import SessionReplayPage from "./page";

beforeEach(() => {
  mocks.width = 390;
  useReplayStore.setState(useReplayStore.getInitialState(), true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener() {},
    removeEventListener() {},
    get matches() {
      return query.includes("1280") ? mocks.width >= 1280 : mocks.width <= 767;
    },
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("replay page mobile lifecycle", () => {
  it("opens the mobile replay without mounting a CSS-hidden heavy timeline", () => {
    render(<SessionReplayPage />);
    expect(screen.queryByText("Replay timeline")).toBeNull();
    expect(screen.queryByText("Desktop replay")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open replay" }));
    expect(screen.getByText("Mobile replay").getAttribute("data-preserve")).toBe("true");
    act(() => {
      mocks.width = 1440;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByText("Replay timeline")).toBeTruthy();
    expect(screen.getByText("Desktop replay")).toBeTruthy();
    expect(screen.queryByText("Mobile replay")).toBeNull();
    act(() => {
      mocks.width = 390;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByText("Replay timeline")).toBeNull();
    expect(screen.queryByText("Desktop replay")).toBeNull();
    expect(screen.getByText("Mobile replay")).toBeTruthy();
  });
});
