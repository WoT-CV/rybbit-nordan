import React, { Profiler, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestCorrelationEvent } from "@rybbit/shared";
import type { useReplayCorrelation } from "@/api/admin/hooks/useReplayCorrelation";
import { useReplayStore } from "../replayStore";
import { ReplayRequestCorrelation } from "./ReplayRequestCorrelation";

vi.mock("next-intl", () => ({
  useExtracted: () => {
    throw new Error("Technical request labels must remain English without translation");
  },
}));

const event: RequestCorrelationEvent = {
  timestamp: 3500,
  request: {
    rowId: "request1",
    transport: "fetch",
    method: "GET",
    origin: "https://api.example.com",
    pathname: "/players/<img>",
    status: 200,
    outcome: "response",
    durationMs: 400,
    correlationId: "request-123",
    traceId: "1234567890abcdef1234567890abcdef",
  },
};
const config = {
  enabled: true,
  profiles: [
    {
      requestOrigin: "https://api.example.com",
      grafanaUrl: "https://grafana.example.com",
      orgId: 1,
      lokiDatasourceUid: "logs",
      tempoDatasourceUid: "traces",
      serviceName: "api",
      environment: "prod",
      timePaddingMs: 1000,
    },
  ],
};
const refetch = vi.fn();
const correlation = { authorized: true, config, isLoading: false, isError: false, refetch } as unknown as ReturnType<
  typeof useReplayCorrelation
>;
const baseProps = {
  siteId: 7,
  sessionId: "session",
  event,
  firstTimestamp: 1000,
  expanded: true,
  onExpandedChange: vi.fn(),
  correlation,
};

beforeEach(() =>
  useReplayStore.setState({
    sessionId: "session",
    player: { pause: vi.fn(), goto: vi.fn() },
    duration: 10000,
    currentTime: 0,
    isPlaying: true,
  })
);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useReplayStore.setState({ player: null });
});

describe("inline replay request correlation row", () => {
  it("shows method and endpoint once in a compact English header without duplicating the URL in details", () => {
    function TimelineRow() {
      const [expanded, setExpanded] = useState(false);
      return (
        <ReplayRequestCorrelation {...baseProps} expanded={expanded} onExpandedChange={() => setExpanded(!expanded)} />
      );
    }
    const { container } = render(
      <div style={{ width: 300 }}>
        <TimelineRow />
      </div>
    );
    const header = screen.getByRole("button", { name: "Requests: GET /players/<img>" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.className).toContain("min-h-11");
    expect(screen.getByText("0:02")).not.toBeNull();
    expect(screen.queryByText("request-123")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    const endpoint = screen.getByText(event.request.pathname);
    expect(endpoint.className).toContain("truncate");
    expect(endpoint.getAttribute("title")).toBe(`${event.request.origin}${event.request.pathname}`);
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(header.getAttribute("aria-controls")!)).not.toBeNull();
    expect(screen.getAllByText(event.request.pathname)).toHaveLength(1);
    expect(screen.queryByText("Endpoint")).toBeNull();
    expect(screen.queryByText("https://api.example.com/players/<img>")).toBeNull();
    expect(screen.getByText("correlationId")).not.toBeNull();
    expect(screen.getByText("traceId")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Go to request" }).textContent).toBe("Seek");
    expect(screen.getByRole("link", { name: "Logs in Grafana" }).textContent).toBe("Logs");
    expect(screen.getByRole("link", { name: "Trace in Grafana" }).textContent).toBe("Trace");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("request-123").parentElement!.className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByText(event.request.traceId!).tagName).toBe("CODE");
    expect(screen.getByText(event.request.traceId!).className).toContain("select-all");
    fireEvent.click(header);
    expect(screen.queryByText("request-123")).toBeNull();
  });

  it("renders safe external links and keeps details open after native-player seek", () => {
    render(<ReplayRequestCorrelation {...baseProps} />);
    const logs = screen.getByRole("link", { name: "Logs in Grafana" });
    expect(logs.getAttribute("rel")).toBe("noopener noreferrer");
    expect(logs.getAttribute("target")).toBe("_blank");
    const trace = screen.getByRole("link", { name: "Trace in Grafana" });
    expect(new URL(trace.getAttribute("href")!).hostname).toBe("grafana.example.com");
    expect(screen.getByText("Recording time; verify Grafana range.").title).toContain("recording clock");
    const player = useReplayStore.getState().player;
    fireEvent.click(screen.getByRole("button", { name: "Go to request" }));
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.goto).toHaveBeenCalledWith(2100);
    expect(useReplayStore.getState()).toMatchObject({ player, currentTime: 2100, isPlaying: false });
    expect(baseProps.onExpandedChange).not.toHaveBeenCalled();
    expect(screen.getByText("request-123")).not.toBeNull();
  });

  it("reads the fresh player at action time and clamps to the replay duration", () => {
    render(<ReplayRequestCorrelation {...baseProps} />);
    const previous = useReplayStore.getState().player;
    const current = { pause: vi.fn(), goto: vi.fn() };
    act(() => useReplayStore.setState({ player: current, duration: 1000 }));
    fireEvent.click(screen.getByRole("button", { name: "Go to request" }));
    expect(previous.goto).not.toHaveBeenCalled();
    expect(current.goto).toHaveBeenCalledWith(1000);
    expect(useReplayStore.getState().currentTime).toBe(1000);
  });

  it("clamps pre-recording requests to zero and rejects invalid playback duration", () => {
    render(<ReplayRequestCorrelation {...baseProps} firstTimestamp={5000} />);
    expect(screen.getByText("0:00")).not.toBeNull();
    const player = useReplayStore.getState().player;
    fireEvent.click(screen.getByRole("button", { name: "Go to request" }));
    expect(player.goto).toHaveBeenCalledWith(0);
    player.goto.mockClear();
    act(() => useReplayStore.setState({ duration: NaN }));
    fireEvent.click(screen.getByRole("button", { name: "Go to request" }));
    expect(player.goto).not.toHaveBeenCalled();
  });

  it("never seeks another session or a missing player, and does not redraw for clock changes", () => {
    const commits = vi.fn();
    const { rerender } = render(
      <Profiler id="request" onRender={commits}>
        <ReplayRequestCorrelation {...baseProps} />
      </Profiler>
    );
    const count = commits.mock.calls.length;
    act(() => useReplayStore.getState().setCurrentTime(9000));
    expect(commits).toHaveBeenCalledTimes(count);
    const player = useReplayStore.getState().player;
    act(() => useReplayStore.setState({ sessionId: "other-session" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to request" }));
    expect(player.goto).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Go to request" }).hasAttribute("disabled")).toBe(true);
    act(() => useReplayStore.setState({ player: null }));
    rerender(<ReplayRequestCorrelation {...baseProps} />);
    expect(screen.getByRole("button", { name: "Go to request" }).hasAttribute("disabled")).toBe(true);
  });

  it("rejects an invalid recording clock without changing player state", () => {
    render(<ReplayRequestCorrelation {...baseProps} firstTimestamp={Infinity} />);
    const player = useReplayStore.getState().player;
    fireEvent.click(screen.getByRole("button", { name: "Go to request" }));
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.goto).not.toHaveBeenCalled();
    expect(useReplayStore.getState()).toMatchObject({ isPlaying: true, currentTime: 0 });
  });

  it("hides all links during loading/revalidation, errors and authorization revocation", () => {
    const { rerender } = render(<ReplayRequestCorrelation {...baseProps} />);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    rerender(<ReplayRequestCorrelation {...baseProps} correlation={{ ...correlation, isLoading: true }} />);
    expect(screen.getByRole("status").textContent).toBe("Loading...");
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<ReplayRequestCorrelation {...baseProps} correlation={{ ...correlation, isError: true }} />);
    expect(screen.getByRole("alert").textContent).toContain("Unable to load Grafana configuration.");
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
    rerender(<ReplayRequestCorrelation {...baseProps} correlation={{ ...correlation, authorized: false }} />);
    expect(screen.getByText("Sign in with replay access to view correlation links.")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows honest no-ID, disabled configuration and unmatched-profile states", () => {
    const { rerender } = render(
      <ReplayRequestCorrelation
        {...baseProps}
        event={{ ...event, request: { ...event.request, correlationId: undefined, traceId: undefined } }}
        correlation={{ ...correlation, config: { ...config, enabled: false } }}
      />
    );
    expect(screen.getByText("No correlation ID available.")).not.toBeNull();
    expect(screen.getByText("Grafana correlation is not configured for this site.")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    rerender(
      <ReplayRequestCorrelation {...baseProps} correlation={{ ...correlation, config: { ...config, profiles: [] } }} />
    );
    expect(screen.getByText("No matching origin configuration.")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([
    ["abort", "Aborted"],
    ["timeout", "Timed out"],
    ["network-error", "Network error"],
  ] as const)("shows an explicit %s outcome", (outcome, label) => {
    render(
      <ReplayRequestCorrelation
        {...baseProps}
        event={{ ...event, request: { ...event.request, outcome, status: 0 } }}
      />
    );
    expect(screen.getByText(label)).not.toBeNull();
  });

  it("contains replay shortcuts inside row controls while allowing drawer Escape", () => {
    const shortcuts = vi.fn();
    document.addEventListener("keydown", shortcuts);
    render(<ReplayRequestCorrelation {...baseProps} />);
    const seek = screen.getByRole("button", { name: "Go to request" });
    fireEvent.keyDown(seek, { key: " " });
    expect(shortcuts).not.toHaveBeenCalled();
    fireEvent.keyDown(seek, { key: "Escape" });
    expect(shortcuts).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", shortcuts);
  });
});
