import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_CORRELATION_TAG } from "@rybbit/shared";
import { ReplayBreadcrumbs } from "./ReplayBreadcrumbs";
import { useReplayStore } from "./replayStore";
import { useReplayCorrelation } from "@/api/admin/hooks/useReplayCorrelation";

const fixture = vi.hoisted(() => ({ site: "1", sessionId: "session", polish: false }));
vi.mock("next/navigation", () => ({ useParams: () => ({ site: fixture.site }) }));
vi.mock("next-intl", () => ({
  useExtracted: () => (message: string, values?: Record<string, string>) => {
    const translations: Record<string, string> = { Key: "Klucz", All: "Wszystko", Requests: "Żądania" };
    const label = fixture.polish ? (translations[message] ?? message) : message;
    return label.replace(/\{(\w+)\}/g, (_match, key) => values?.[key] ?? key);
  },
}));
vi.mock("@/components/Avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/IdentifiedBadge", () => ({ IdentifiedBadge: () => null }));
vi.mock("@/components/interior/segmented-control", () => ({
  SegmentedControl: ({ options, value, onValueChange }: any) => (
    <div role="radiogroup" aria-label="Event detail level">
      {options.map((option: any) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: any) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 44 })),
    measureElement: () => undefined,
  }),
}));
vi.mock("@/api/admin/hooks/useReplayCorrelation", () => ({
  useReplayCorrelation: vi.fn(() => ({
    authorized: true,
    isLoading: false,
    isError: false,
    config: undefined,
    refetch: vi.fn(),
  })),
}));
vi.mock("@/api/analytics/hooks/sessionReplay/useGetSessionReplayEvents", () => ({
  useGetSessionReplayEvents: () => ({
    isLoading: false,
    error: null,
    data: {
      metadata: { user_id: "visitor", identified_user_id: "", traits: {}, page_url: "https://example.test/" },
      events: [
        { type: "4", timestamp: 1000, data: { href: "https://example.test/" } },
        {
          type: "5",
          timestamp: 3500,
          data: {
            tag: REQUEST_CORRELATION_TAG,
            payload: {
              rowId: "request1",
              transport: "fetch",
              method: "GET",
              origin: "https://api.example.test",
              pathname: "/players/123",
              status: 200,
              outcome: "response",
              durationMs: 400,
              correlationId: "qa-123",
            },
          },
        },
      ],
    },
  }),
}));

beforeEach(() => {
  fixture.site = "1";
  fixture.polish = false;
  useReplayStore.setState({ sessionId: "session", player: null, duration: 10000, currentTime: 0 });
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("separate replay request tab", () => {
  it("keeps the technical Requests tab English without changing native translated labels", () => {
    fixture.polish = true;
    render(<ReplayBreadcrumbs />);
    expect(screen.getAllByRole("radio").map(radio => radio.textContent)).toEqual(["Klucz", "Requests", "Wszystko"]);
    fireEvent.click(screen.getByRole("radio", { name: "Requests" }));
    expect(screen.getByText("Requests (1)")).toBeTruthy();
    expect(screen.queryByText("Żądania")).toBeNull();
    expect(screen.getByRole("button", { name: "Requests: GET /players/123" })).toBeTruthy();
  });

  it("keeps Key native and places Requests between Key and All, loading Grafana config only when expanded", () => {
    render(<ReplayBreadcrumbs />);
    expect(screen.getByText("Session started")).toBeTruthy();
    expect(screen.getByText("1 key events")).toBeTruthy();
    expect(screen.getAllByRole("radio").map(radio => radio.textContent)).toEqual(["Key", "Requests", "All"]);
    expect(screen.queryByRole("button", { name: "Requests: GET /players/123" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Requests" }));
    expect(screen.queryByText("Session started")).toBeNull();
    expect(screen.getByText("Requests (1)")).toBeTruthy();
    const request = screen.getByRole("button", { name: "Requests: GET /players/123" });
    expect(request.getAttribute("aria-expanded")).toBe("false");
    expect(vi.mocked(useReplayCorrelation).mock.lastCall).toEqual([1, false]);
    fireEvent.click(request);
    expect(request.getAttribute("aria-expanded")).toBe("true");
    expect(vi.mocked(useReplayCorrelation).mock.lastCall).toEqual([1, true]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps All technical and clears request expansion on tab changes", () => {
    render(<ReplayBreadcrumbs />);
    fireEvent.click(screen.getByRole("radio", { name: "Requests" }));
    fireEvent.click(screen.getByRole("button", { name: "Requests: GET /players/123" }));
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.queryByRole("button", { name: "Requests: GET /players/123" })).toBeNull();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(vi.mocked(useReplayCorrelation).mock.lastCall).toEqual([1, false]);
    fireEvent.click(screen.getByRole("radio", { name: "Key" }));
    expect(screen.getByText("Session started")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Requests: GET /players/123" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Requests" }));
    expect(screen.getByRole("button", { name: "Requests: GET /players/123" }).getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("does not carry expanded request state into another site or session", () => {
    const { rerender } = render(<ReplayBreadcrumbs />);
    fireEvent.click(screen.getByRole("radio", { name: "Requests" }));
    fireEvent.click(screen.getByRole("button", { name: "Requests: GET /players/123" }));
    fixture.site = "2";
    rerender(<ReplayBreadcrumbs />);
    expect(vi.mocked(useReplayCorrelation).mock.lastCall).toEqual([2, false]);
    expect(screen.getByRole("button", { name: "Requests: GET /players/123" }).getAttribute("aria-expanded")).toBe(
      "false"
    );
    useReplayStore.setState({ sessionId: "other-session" });
    rerender(<ReplayBreadcrumbs />);
    expect(vi.mocked(useReplayCorrelation).mock.lastCall).toEqual([2, false]);
  });
});
