// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivitySlider } from "@/components/ui/activity-slider";
import { createInitialExportRange } from "../export/ReplayExportRangeSlider";
import { useReplayStore } from "../replayStore";
import type { ReplayPlayerAdapter } from "./ReplayPlayerAdapter";
import { ReplayPlayerControls } from "./ReplayPlayerControls";

const mocks = vi.hoisted(() => ({
  canExport: true,
  timeline: vi.fn((props: ComponentProps<typeof ActivitySlider>) => (
    <div data-testid="timeline" data-time={props.currentTime} data-position={props.value?.[0]} />
  )),
  exportButton: vi.fn(() => null),
  exportRange: vi.fn(() => null),
}));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/hooks/usePermissions", () => ({ useCanOnSite: () => mocks.canExport }));
vi.mock("@/components/ui/activity-slider", () => ({ ActivitySlider: mocks.timeline }));
vi.mock("../export/ReplayExportButton", () => ({ ReplayExportButton: mocks.exportButton }));
vi.mock("../export/ReplayExportRangeSlider", async importOriginal => ({
  ...(await importOriginal<typeof import("../export/ReplayExportRangeSlider")>()),
  ReplayExportRangeSlider: mocks.exportRange,
}));

function props(): ComponentProps<typeof ReplayPlayerControls> {
  return {
    events: [],
    onPlayPause: vi.fn(),
    onSliderChange: vi.fn(),
    onSliderCommit: vi.fn(),
    onSliderCancel: vi.fn(),
    onSpeedChange: vi.fn(),
  };
}

beforeEach(() => {
  mocks.canExport = true;
  vi.clearAllMocks();
  useReplayStore.setState({
    ...useReplayStore.getInitialState(),
    player: { pause: vi.fn(), seek: vi.fn(), play: vi.fn() } as unknown as ReplayPlayerAdapter,
    duration: 120_000,
    activityPeriods: [{ start: 0, end: 120_000 }],
    replaySegments: [{ start: 0, end: 120_000, duration: 120_000, isActive: true, kind: "active", eventCount: 2 }],
    exportRange: [0, 60_000],
  });
});
afterEach(cleanup);

describe("ReplayPlayerControls clock isolation", () => {
  it("does not offer export or initialize its range for read-only viewers", () => {
    mocks.canExport = false;
    useReplayStore.setState({ exportRange: null });
    render(<ReplayPlayerControls {...props()} />);
    expect(mocks.exportButton).not.toHaveBeenCalled();
    expect(mocks.exportRange).not.toHaveBeenCalled();
    expect(useReplayStore.getState().exportRange).toBeNull();
    expect(mocks.timeline.mock.lastCall![0].exportRange).toBeNull();
  });
  it("keeps the precise slider and displayed time live without re-rendering the toolbar", () => {
    const controls = props();
    const view = render(<ReplayPlayerControls {...controls} />);
    const speed = screen.getByRole("combobox", { name: "Playback speed" });
    mocks.exportButton.mockClear();
    mocks.exportRange.mockClear();
    for (let frame = 1; frame <= 120; frame++) {
      act(() => useReplayStore.getState().setCurrentTime(frame * 16));
      view.rerender(<ReplayPlayerControls {...controls} />);
    }
    expect(mocks.exportButton).not.toHaveBeenCalled();
    expect(mocks.exportRange).not.toHaveBeenCalled();
    expect(screen.getByTestId("timeline").getAttribute("data-time")).toBe("1920");
    expect(screen.getByTestId("timeline").getAttribute("data-position")).toBe("1.6");
    expect(screen.getByText("0:01 / 2:00")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Playback speed" })).toBe(speed);

    act(() => useReplayStore.setState({ currentTime: 65_001, playbackSpeed: "4", isPlaying: true }));
    expect(screen.getByText("1:05 / 2:00")).toBeTruthy();
    expect(speed.textContent).toBe("4x");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(controls.onPlayPause).toHaveBeenCalledOnce();
    act(() => useReplayStore.getState().setCurrentTime(999));
    expect(screen.getByText("0:00 / 2:00")).toBeTruthy();
  });

  it("forwards preview, commit and cancellation handlers without wrapping or dropping them", () => {
    const controls = props();
    render(<ReplayPlayerControls {...controls} />);
    const timeline = mocks.timeline.mock.lastCall![0];
    expect(timeline.onValueChange).toBe(controls.onSliderChange);
    expect(timeline.onValueCommit).toBe(controls.onSliderCommit);
    expect(timeline.onPointerCancel).toBe(controls.onSliderCancel);
    expect(timeline.onLostPointerCapture).toBe(controls.onSliderCancel);
    act(() => timeline.onNetworkSeek?.(25_123));
    expect(useReplayStore.getState().player?.seek).toHaveBeenCalledExactlyOnceWith(25_123);
    expect(useReplayStore.getState().currentTime).toBe(25_123);
  });

  it("initializes the export range from the current position once the recording is ready", () => {
    useReplayStore.setState({ exportRange: null, replaySegments: [] });
    render(<ReplayPlayerControls {...props()} />);
    act(() => useReplayStore.getState().setCurrentTime(30_000));
    expect(useReplayStore.getState().exportRange).toBeNull();
    act(() =>
      useReplayStore.setState({
        replaySegments: [{ start: 0, end: 120_000, duration: 120_000, isActive: true, kind: "active", eventCount: 2 }],
      })
    );
    const range = useReplayStore.getState().exportRange;
    expect(range).toEqual(createInitialExportRange(30_000, 120_000, useReplayStore.getState().activityPeriods));
    act(() => useReplayStore.getState().setCurrentTime(60_000));
    expect(useReplayStore.getState().exportRange).toBe(range);
  });
});
