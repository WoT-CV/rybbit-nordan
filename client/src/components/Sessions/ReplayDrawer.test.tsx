import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplayStore } from "@/components/replay/replayStore";
import type { ReplayPlayerAdapter } from "@/components/replay/player/ReplayPlayerAdapter";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const mocks = vi.hoisted(() => ({
  translateHook: vi.fn(() => (text: string) => text),
  wide: false,
  observe: vi.fn(),
  resize: () => {},
}));
vi.mock("next-intl", () => ({ useExtracted: mocks.translateHook }));
vi.mock("@/components/replay/player/ReplayPlayer", () => ({
  ReplayPlayer: ({ width }: { width: number }) => {
    const [speed, setSpeed] = React.useState("1");
    return (
      <div data-width={width}>
        Replay player
        <Select value={speed} onValueChange={setSpeed}>
          <SelectTrigger aria-label="Playback speed">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="1">1x</SelectItem>
              <SelectItem value="2">2x</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    );
  },
}));
vi.mock("@/components/replay/ReplayBreadcrumbs", () => ({ ReplayBreadcrumbs: () => <div>Replay timeline</div> }));

import { ReplayDrawer } from "./ReplayDrawer";

describe("ReplayDrawer mobile and store isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.wide = false;
    mocks.translateHook.mockClear();
    mocks.observe.mockClear();
    useReplayStore.setState(useReplayStore.getInitialState());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          mocks.resize = callback;
        }
        observe = mocks.observe;
        disconnect() {}
      }
    );
    vi.stubGlobal("matchMedia", () => ({ matches: mocks.wide, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 0));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 390, height: 700 } as DOMRect);
  });

  it("observes the mounted player container and remeasures after the desktop sidebar takes space", () => {
    mocks.wide = true;
    render(<ReplayDrawer open sessionId="test" onOpenChange={() => {}} />);
    const container = screen.getByText("Replay player").parentElement;
    expect(mocks.observe).toHaveBeenCalledWith(container);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 1064, height: 859 } as DOMRect);
    act(() => mocks.resize());
    expect(screen.getByText("Replay player").getAttribute("data-width")).toBe("1064");
    expect(screen.getByText("Replay timeline")).toBeTruthy();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not mount a CSS-hidden timeline on phones and protects interactive content from drawer dragging", () => {
    render(<ReplayDrawer open sessionId="test" onOpenChange={() => {}} />);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText("Replay timeline")).toBeNull();
    expect(screen.getByText("Replay player").closest("[data-vaul-no-drag]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    mocks.wide = true;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.getByText("Replay timeline")).toBeTruthy();
    mocks.wide = false;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.queryByText("Replay timeline")).toBeNull();
  });

  it("keeps real Vaul outside touches and content pointer capture from dismissing the replay", () => {
    const onOpenChange = vi.fn();
    render(<ReplayDrawer open sessionId="test" onOpenChange={onOpenChange} />);
    act(() => vi.advanceTimersByTime(0));
    const player = screen.getByText("Replay player");
    fireEvent.pointerDown(player, { pointerId: 1, pointerType: "touch", clientY: 100 });
    fireEvent.pointerMove(player, { pointerId: 1, pointerType: "touch", clientY: 400 });
    fireEvent.pointerUp(player, { pointerId: 1, pointerType: "touch", clientY: 400 });
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();

    const overlay = document.querySelector('[data-slot="drawer-overlay"]')!;
    fireEvent.pointerDown(overlay, { pointerId: 2, pointerType: "touch" });
    fireEvent.click(overlay);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Session Replay" })).toBeTruthy();
  });

  it("changes speed through the real portalled Select without closing the drawer", () => {
    const onOpenChange = vi.fn();
    render(<ReplayDrawer open sessionId="test" onOpenChange={onOpenChange} />);
    act(() => vi.advanceTimersByTime(0));
    const trigger = screen.getByRole("combobox", { name: "Playback speed" });
    fireEvent.click(trigger);
    const option = screen.getByRole("option", { name: "2x" });
    expect(screen.getByRole("dialog", { hidden: true }).contains(option)).toBe(false);
    fireEvent.pointerDown(option, { pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(option, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(option);
    expect(trigger.textContent).toBe("2x");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Session Replay" })).toBeTruthy();
  });

  it.each(["Close", "Escape"])("preserves the explicit %s exit", exit => {
    const onOpenChange = vi.fn();
    render(<ReplayDrawer open sessionId="test" onOpenChange={onOpenChange} />);
    act(() => vi.advanceTimersByTime(0));
    if (exit === "Close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
    else fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clips the fixed replay surface without making it a focus-scroll container", () => {
    render(<ReplayDrawer open sessionId="test" onOpenChange={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Session Replay" });
    expect(dialog.classList.contains("overflow-clip")).toBe(true);
    expect(dialog.classList.contains("overflow-hidden")).toBe(false);
  });

  it("does not reset a replacement page player's state when its drawer closes", () => {
    const view = render(<ReplayDrawer open sessionId="test" onOpenChange={() => {}} />);
    const replacement = { pause: vi.fn() } as unknown as ReplayPlayerAdapter;
    act(() => useReplayStore.setState({ player: replacement, currentTime: 5000, duration: 10_000, isPlaying: true }));
    view.rerender(<ReplayDrawer open={false} sessionId="test" onOpenChange={() => {}} />);
    expect(screen.queryByText("Replay player")).toBeNull();
    expect(useReplayStore.getState()).toMatchObject({
      player: replacement,
      currentTime: 5000,
      duration: 10_000,
      isPlaying: true,
    });
  });

  it("does not reselect or rewind a session during an orientation/fullscreen surface handoff", () => {
    useReplayStore.getState().selectSession("test", true);
    useReplayStore.setState({ currentTime: 4200, duration: 10_000, isPlaying: true });
    const selectionVersion = useReplayStore.getState().selectionVersion;
    render(<ReplayDrawer open sessionId="test" onOpenChange={() => {}} preservePlaybackState />);
    expect(useReplayStore.getState()).toMatchObject({ selectionVersion, currentTime: 4200, isPlaying: true });
  });

  it("does not re-render every closed session drawer on playback clock ticks", () => {
    render(
      <>
        {Array.from({ length: 100 }, (_, index) => (
          <ReplayDrawer key={index} open={false} sessionId={String(index)} onOpenChange={() => {}} />
        ))}
      </>
    );
    expect(mocks.translateHook).toHaveBeenCalledTimes(100);
    act(() => {
      for (let currentTime = 0; currentTime < 1000; currentTime += 16) useReplayStore.setState({ currentTime });
    });
    expect(mocks.translateHook).toHaveBeenCalledTimes(100);
  });
});
