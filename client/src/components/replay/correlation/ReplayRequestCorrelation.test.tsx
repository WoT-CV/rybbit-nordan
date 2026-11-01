import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_CORRELATION_TAG } from "@rybbit/shared";
import { ReplayRequestCorrelation } from "./ReplayRequestCorrelation";
import { useReplayStore } from "../replayStore";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useReplayCorrelation } from "@/api/admin/hooks/useReplayCorrelation";

const state = vi.hoisted(() => ({
  authorized: true,
  config: {
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
  },
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
vi.mock("@/api/admin/hooks/useReplayCorrelation", () => ({ useReplayCorrelation: vi.fn(() => state) }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
const request = {
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
};
const events = [
  { type: 4, timestamp: 1000, data: {} },
  { type: 5, timestamp: 3500, data: { tag: REQUEST_CORRELATION_TAG, payload: request } },
];
const open = () => fireEvent.click(screen.getByRole("button", { name: "Requests" }));
beforeEach(() => {
  state.authorized = true;
  state.config.enabled = true;
  state.isError = false;
  state.isLoading = false;
  useReplayStore.setState({
    sessionId: "session",
    player: { pause: vi.fn(), goto: vi.fn() },
    duration: 10000,
    currentTime: 0,
    isPlaying: true,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useReplayStore.setState({ player: null });
});

describe("native replay request correlation dialog", () => {
  it("renders safe endpoint text and configured external links, then seeks the native player to request start", () => {
    render(<ReplayRequestCorrelation siteId={7} sessionId="session" events={events} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    expect(screen.getByText(/\/players\/<img>/).querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Logs in Grafana" }).getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("link", { name: "Trace in Grafana" }).getAttribute("target")).toBe("_blank");
    expect(screen.getByText("request-123").className).toContain("select-all");
    expect(screen.getByText(request.traceId).tagName).toBe("CODE");
    const player = useReplayStore.getState().player;
    fireEvent.click(screen.getByRole("button", { name: "Go to request" }));
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.goto).toHaveBeenCalledWith(2100);
    expect(useReplayStore.getState()).toMatchObject({ currentTime: 2100, isPlaying: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("never seeks another session and does not subscribe to playback clock updates", () => {
    render(<ReplayRequestCorrelation siteId={7} sessionId="old-session" events={events} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Go to request" }));
    expect(useReplayStore.getState().player.goto).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).not.toBeNull();
    const renders = vi.mocked(useReplayCorrelation).mock.calls.length;
    act(() => useReplayStore.getState().setCurrentTime(9000));
    expect(vi.mocked(useReplayCorrelation).mock.calls).toHaveLength(renders);
  });
  it("shows honest historical/no-ID/config/error/permission states without fabricated links", () => {
    const { rerender } = render(<ReplayRequestCorrelation siteId={7} sessionId="session" events={[]} />);
    open();
    expect(screen.getByText(/Older recordings may not contain it/)).not.toBeNull();
    state.config.enabled = false;
    rerender(
      <ReplayRequestCorrelation
        siteId={7}
        sessionId="session"
        events={[
          {
            ...events[1],
            data: {
              tag: REQUEST_CORRELATION_TAG,
              payload: { ...request, correlationId: undefined, traceId: undefined },
            },
          },
        ]}
      />
    );
    expect(screen.getByText("No correlation ID available.")).not.toBeNull();
    expect(screen.getByText("Grafana correlation is not configured for this site.")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    state.isError = true;
    rerender(<ReplayRequestCorrelation siteId={7} sessionId="session" events={[...events]} />);
    expect(screen.getByRole("alert").textContent).toContain("Unable to load Grafana configuration.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalledOnce();
    state.authorized = false;
    rerender(<ReplayRequestCorrelation siteId={7} sessionId="session" events={events} />);
    expect(screen.getByText("Sign in with replay access to view correlation links.")).not.toBeNull();
  });
  it("closes only the nested dialog on Escape without replay keyboard events bubbling", async () => {
    const outerChange = vi.fn();
    const shortcuts = vi.fn();
    document.addEventListener("keydown", shortcuts);
    render(
      <Drawer open onOpenChange={outerChange}>
        <DrawerContent aria-describedby={undefined}>
          <DrawerTitle>Replay</DrawerTitle>
          <ReplayRequestCorrelation siteId={7} sessionId="session" events={events} />
        </DrawerContent>
      </Drawer>
    );
    open();
    fireEvent.keyDown(screen.getByText("Go to request"), { key: " " });
    expect(shortcuts).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByText("Go to request"), { key: "Escape" });
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(outerChange).not.toHaveBeenCalled();
    document.removeEventListener("keydown", shortcuts);
  });
});
