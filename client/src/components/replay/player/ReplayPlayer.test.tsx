import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayPlayerAdapter } from "./ReplayPlayerAdapter";
import { useReplayStore } from "../replayStore";

const mocks = vi.hoisted(() => ({ data: { events: [] }, skipInactivity: vi.fn(), keyboard: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ site: "42" }) }));
vi.mock("@/api/analytics/hooks/sessionReplay/useGetSessionReplayEvents", () => ({
  useGetSessionReplayEvents: () => ({ data: mocks.data, isLoading: false, error: null }),
}));
vi.mock("@/components/Loaders", () => ({ ThreeDotLoader: () => null }));
vi.mock("@/components/Sessions/ReplayDrawer", () => ({
  ReplayDrawer: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <button onClick={() => onOpenChange(false)}>Close fullscreen</button> : null,
}));
vi.mock("./hooks/useActivityPeriods", () => ({ useActivityPeriods: () => {} }));
vi.mock("./hooks/useSkipInactivity", () => ({ useSkipInactivity: mocks.skipInactivity }));
vi.mock("./hooks/useReplayKeyboardShortcuts", () => ({ useReplayKeyboardShortcuts: mocks.keyboard }));
vi.mock("./ReplayPlayerCore", () => ({ ReplayPlayerCore: () => <div>Active replay surface</div> }));
vi.mock("./ReplayPlayerTopbar", () => ({ ReplayPlayerTopbar: () => null }));
vi.mock("./ReplayPlayerControls", () => ({
  ReplayPlayerControls: ({ onFullscreenOpen }: { onFullscreenOpen?: () => void }) =>
    onFullscreenOpen ? <button onClick={onFullscreenOpen}>Fullscreen</button> : null,
}));

import { ReplayPlayer } from "./ReplayPlayer";

beforeEach(() => {
  vi.clearAllMocks();
  useReplayStore.setState({
    ...useReplayStore.getInitialState(),
    sessionId: "test",
    player: {} as ReplayPlayerAdapter,
  });
});
afterEach(cleanup);

describe("ReplayPlayer single active surface", () => {
  it("unmounts the page's rrweb surface and disables its playback handlers during fullscreen", () => {
    render(<ReplayPlayer width={1200} height={800} />);
    expect(screen.getByText("Active replay surface")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    expect(screen.queryByText("Active replay surface")).toBeNull();
    expect(mocks.skipInactivity).toHaveBeenLastCalledWith({ player: null });
    expect(mocks.keyboard.mock.lastCall?.[0].player).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close fullscreen" }));
    expect(screen.getByText("Active replay surface")).toBeTruthy();
  });
});
