import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSessionsResponse } from "@/api/analytics/endpoints";
import { SessionInfoTab } from "./SessionInfoTab";

vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("@/hooks/useDateTimeFormat", () => ({ useDateTimeFormat: () => ({ formatRelative: () => "now" }) }));
vi.mock("@/lib/geo", () => ({ useGetRegionName: () => ({ getRegionName: () => "Region" }) }));
vi.mock("@/lib/store", () => ({ getTimezone: () => "UTC" }));
vi.mock("@/components/IdentifiedBadge", () => ({ IdentifiedBadge: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
afterEach(cleanup);

const baseSession: GetSessionsResponse[number] = {
  session_id: "test-session",
  user_id: "000123",
  identified_user_id: "",
  traits: null,
  country: "",
  region: "",
  city: "",
  language: "",
  device_type: "Desktop",
  browser: "Firefox",
  browser_version: "",
  operating_system: "",
  operating_system_version: "",
  screen_width: 1280,
  screen_height: 720,
  referrer: "",
  channel: "Direct",
  hostname: "example.test",
  page_title: "Test",
  querystring: "",
  utm_source: "",
  utm_medium: "",
  utm_campaign: "",
  utm_term: "",
  utm_content: "",
  session_start: "2026-11-01 10:00:00",
  session_end: "2026-11-01 10:01:00",
  session_duration: 60,
  entry_page: "/",
  exit_page: "/",
  pageviews: 1,
  events: 1,
  errors: 0,
  outbound: 0,
  button_clicks: 0,
  copies: 0,
  form_submits: 0,
  input_changes: 0,
  ip: "",
  lat: 0,
  lon: 0,
  has_replay: 0,
};

describe("session user profile presentation", () => {
  it("uses the native name precedence and renders the clan logo", () => {
    const session = {
      ...baseSession,
      user_id: "000123",
      identified_user_id: "player/42",
      traits: { username: "[WOT] Player", name: "Older name", avatarUrl: "https://cdn.example.com/clan.png" },
    };
    const { container } = render(<SessionInfoTab session={session} sessionDetails={{ user_id: "000123" }} />);
    expect(screen.getByText("[WOT] Player")).toBeTruthy();
    expect(screen.queryByText("Older name")).toBeNull();
    expect(container.querySelector("img")?.src).toBe("https://cdn.example.com/clan.png");
    expect(screen.getByText("player/42")).toBeTruthy();
  });

  it("renders an anonymous visitor without inventing clan identity", () => {
    const { container } = render(<SessionInfoTab session={baseSession} sessionDetails={{ user_id: "000123" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg[viewBox='0 0 100 100']")).not.toBeNull();
    expect(screen.getByText("000123")).toBeTruthy();
  });
});
