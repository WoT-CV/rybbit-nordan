import { createElement, type PropsWithChildren } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/hooks/useIsProduction", () => ({ useAppEnv: () => "self-hosted" }));
vi.mock("@/hooks/useSetPageTitle", () => ({ useSetPageTitle: () => {} }));
vi.mock("@/api/analytics/hooks/sessionReplay/useGetSessionReplays", () => ({
  useGetSessionReplays: () => ({ data: { pages: [{ data: [{ session_id: "ssr" }] }] }, isLoading: false }),
}));
vi.mock("@/components/DisabledOverlay", () => ({ DisabledOverlay: ({ children }: PropsWithChildren) => children }));
vi.mock("@/components/NothingFound", () => ({ NothingFound: () => null }));
vi.mock("@/components/replay/ReplayBreadcrumbs", () => ({ ReplayBreadcrumbs: () => null }));
vi.mock("@/components/replay/player/ReplayPlayer", () => ({ ReplayPlayer: () => null }));
vi.mock("@/components/Sessions/ReplayDrawer", () => ({ ReplayDrawer: () => null }));
vi.mock("../components/SubHeader/SubHeader", () => ({ SubHeader: () => null }));
vi.mock("./components/EnableSessionReplay", () => ({ EnableSessionReplay: () => null }));
vi.mock("./components/ReplayList", () => ({ ReplayList: () => createElement("div", null, "Replay list") }));

import SessionReplayPage from "./page";

describe("replay page SSR", () => {
  it("renders the replay page without window or a client-only media-query snapshot", () => {
    expect(typeof window).toBe("undefined");
    expect(renderToString(createElement(SessionReplayPage))).toContain("Replay list");
  });
});
