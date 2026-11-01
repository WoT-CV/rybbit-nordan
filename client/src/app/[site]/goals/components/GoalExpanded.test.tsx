import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ identified: true }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text, useLocale: () => "en" }));
vi.mock("@/api/analytics/hooks/goals/useGetGoalSessions", () => ({
  useGetGoalSessions: () => ({
    data: [
      {
        session_id: "s1",
        user_id: "device",
        identified_user_id: state.identified ? "000123" : "",
        traits: state.identified ? { username: "[TAG] nick", avatarUrl: "https://logos.example/clan.png" } : null,
        session_start: "2026-10-01 12:00:00",
        session_end: "2026-10-01 12:00:05",
        pageviews: 1,
      },
    ],
  }),
}));
vi.mock("@/api/analytics/hooks/goals/useGetGoalTimeSeries", () => ({ useGetGoalTimeSeries: () => ({ data: [] }) }));
vi.mock("@/api/analytics/hooks/events/useGetEventNames", () => ({ useGetEventNames: () => ({ data: [] }) }));
vi.mock("@/api/analytics/hooks/funnels/useGetFunnels", () => ({ useGetFunnels: () => ({ data: [] }) }));
vi.mock("@/hooks/usePivotHref", () => ({ usePivotHref: () => () => "/12/private-key/sessions" }));
vi.mock("@/lib/store", () => ({
  getTimezone: () => "UTC",
  useTimezone: () => "UTC",
  useStore: (selector: (value: unknown) => unknown) =>
    selector({ site: 12, privateKey: "private-key", time: {}, previousTime: null }),
}));
vi.mock("@/components/DateSelector/rangeFields", () => ({ describeComparisonWindow: () => null }));
vi.mock("@/components/site/PivotActions", () => ({ PivotActions: () => null }));
vi.mock("./GoalConversionsChart", () => ({ GoalConversionsChart: () => null }));
vi.mock("@/components/Sessions/ReplayDrawer", () => ({ ReplayDrawer: () => null }));
vi.mock("@/components/ui/tooltip", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return { Tooltip: Wrapper, TooltipTrigger: Wrapper, TooltipContent: Wrapper };
});

import { buildLedgerRows } from "../utils/goalLedger";
import { GoalExpanded } from "./GoalExpanded";

const row = buildLedgerRows(
  [
    {
      goalId: 1,
      name: "Signup",
      goalType: "path",
      config: { pathPattern: "/done" },
      createdAt: "",
      total_conversions: 1,
      total_sessions: 1,
      conversion_rate: 1,
    },
  ],
  undefined
)[0];
afterEach(() => {
  cleanup();
  state.identified = true;
});

describe("converted-session visitor identity", () => {
  it("shows a native current profile and preserves the private-key profile link", () => {
    const { container } = render(
      <GoalExpanded row={row} siteId={12} isLoadingTimeSeries={false} chartTitle="Conversions" />
    );
    expect(screen.getByRole("link", { name: "[TAG] nick" }).getAttribute("href")).toBe("/12/private-key/user/000123");
    expect(container.querySelector('img[src="https://logos.example/clan.png"]')).not.toBeNull();
  });
  it("leaves anonymous converted sessions on native frog/device identity", () => {
    state.identified = false;
    const { container } = render(
      <GoalExpanded row={row} siteId={12} isLoadingTimeSeries={false} chartTitle="Conversions" />
    );
    expect(container.querySelector('a[href="/12/private-key/user/device"]')).not.toBeNull();
    expect(container.querySelector('img[src*="logos.example"]')).toBeNull();
    expect(screen.queryByText("[TAG] nick")).toBeNull();
  });
});
