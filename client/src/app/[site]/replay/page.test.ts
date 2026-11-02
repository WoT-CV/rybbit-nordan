import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import SessionReplayPage from "./page";

const fixture = vi.hoisted(() => ({ demo: false, query: vi.fn() }));
vi.mock("@/hooks/useIsProduction", () => ({ useAppEnv: () => (fixture.demo ? "demo" : null) }));
afterEach(() => {
  fixture.demo = false;
  vi.clearAllMocks();
});

// Keep the real @uidotdev hooks: the former useMediaQuery throws in this Node SSR render.
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/api/analytics/hooks/sessionReplay/useGetSessionReplays", () => ({
  useGetSessionReplays: () => {
    fixture.query();
    return { data: { pages: [{ data: [] }] }, isLoading: false, error: null };
  },
}));
vi.mock("@/components/DisabledOverlay", () => ({
  DisabledOverlay: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/NothingFound", () => ({
  NothingFound: ({ title }: { title: string }) => createElement("p", null, title),
}));
vi.mock("@/components/replay/ReplayBreadcrumbs", () => ({ ReplayBreadcrumbs: () => null }));
vi.mock("@/components/replay/player/ReplayPlayer", () => ({ ReplayPlayer: () => null }));
vi.mock("@/components/Sessions/ReplayDrawer", () => ({
  ReplayDrawer: () => createElement("div", null, "Mobile drawer"),
}));
vi.mock("../components/SubHeader/SubHeader", () => ({ SubHeader: () => null }));
vi.mock("./components/EnableSessionReplay", () => ({ EnableSessionReplay: () => null }));
vi.mock("./components/ReplayList", () => ({
  ReplayList: ({ onSelect }: { onSelect?: () => void }) =>
    createElement("div", { "data-compact": !!onSelect }, "Replay list"),
}));

it("server-renders the actual replay page with native window-size hooks and no browser globals", () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
  const html = renderToString(createElement(SessionReplayPage));
  expect(html).toContain("Replay list");
  expect(html).toContain("No session replays found");
  expect(html).toContain('data-compact="false"');
  expect(html).not.toContain("Mobile drawer");
  expect(html).toContain("h-dvh w-full");
  expect(html).not.toContain("max-w-[2000px]");
  expect(html).not.toContain("mx-auto");
});

it("keeps demo empty without mounting query/player hooks", () => {
  fixture.demo = true;
  expect(renderToString(createElement(SessionReplayPage))).toBe("");
  expect(fixture.query).not.toHaveBeenCalled();
});
