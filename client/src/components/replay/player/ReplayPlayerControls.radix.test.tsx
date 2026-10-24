import * as SliderPrimitive from "@radix-ui/react-slider";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReplayStore } from "../replayStore";
import { useReplaySeek } from "./hooks/useReplaySeek";
import type { ReplayPlayerAdapter } from "./ReplayPlayerAdapter";
import { ReplayPlayerControls } from "./ReplayPlayerControls";

vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/hooks/usePermissions", () => ({ useCanOnSite: () => false }));
vi.mock("../export/ReplayExportButton", () => ({ ReplayExportButton: () => null }));
vi.mock("../export/ReplayExportRangeSlider", () => ({
  createInitialExportRange: vi.fn(),
  ReplayExportRangeSlider: () => null,
}));

function mockPlayer() {
  return { pause: vi.fn(), seek: vi.fn(), play: vi.fn() };
}

function Controls() {
  const { previewSeek, commitPreviewSeek, cancelPreviewSeek } = useReplaySeek();
  return (
    <ReplayPlayerControls
      events={[]}
      onPlayPause={() => undefined}
      onSpeedChange={() => undefined}
      onSliderChange={value => previewSeek((value[0] / 100) * useReplayStore.getState().duration)}
      onSliderCommit={value => commitPreviewSeek((value[0] / 100) * useReplayStore.getState().duration)}
      onSliderCancel={cancelPreviewSeek}
    />
  );
}

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
    this.pointerType = init.pointerType ?? "touch";
  }
}

const captureMethods = ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"] as const;
const originalCaptureMethods = captureMethods.map(
  name => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const
);
const pointer = (clientX: number) => ({ clientX, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 });
let player: ReturnType<typeof mockPlayer>;

beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const captures = new Map<number, Element>();
  Object.defineProperties(Element.prototype, {
    setPointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) {
        captures.set(pointerId, this);
      },
    },
    hasPointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) {
        return captures.get(pointerId) === this;
      },
    },
    releasePointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) {
        if (captures.get(pointerId) === this) captures.delete(pointerId);
      },
    },
  });
  player = mockPlayer();
  useReplayStore.setState({
    ...useReplayStore.getInitialState(),
    player: player as unknown as ReplayPlayerAdapter,
    sessionId: "replay-a",
    duration: 10_000,
    currentTime: 2400,
    isPlaying: true,
    playbackState: "playing",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of originalCaptureMethods) {
    if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
    else Reflect.deleteProperty(Element.prototype, name);
  }
});

function timeline() {
  render(<Controls />);
  const thumb = screen.getByRole("slider", { name: "Replay position" });
  const root = thumb.closest<HTMLElement>("[dir][data-orientation]")!;
  const rect = vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 8));
  return { thumb, root, rect };
}

describe("ReplayTimeline with the installed Radix Slider", () => {
  it("documents the real controlled keyboard COMMIT then CHANGE callback order", () => {
    const calls: string[] = [];
    function Slider() {
      const [value, setValue] = useState([24]);
      return (
        <SliderPrimitive.Root
          value={value}
          onValueCommit={() => calls.push("commit")}
          onValueChange={value => {
            calls.push("change");
            setValue(value);
          }}
        >
          <SliderPrimitive.Thumb aria-label="Test position" />
        </SliderPrimitive.Root>
      );
    }
    render(<Slider />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(calls).toEqual(["commit", "change"]);
  });

  it.each([true, false])("commits keyboard seeking without reopening preview, playing=%s", wasPlaying => {
    useReplayStore.setState({ isPlaying: wasPlaying, playbackState: wasPlaying ? "playing" : "paused" });
    const { thumb } = timeline();
    fireEvent.keyDown(thumb, { key: "ArrowRight" });

    expect(player.seek).toHaveBeenCalledExactlyOnceWith(2410);
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.play).toHaveBeenCalledTimes(wasPlaying ? 1 : 0);
    expect(useReplayStore.getState().currentTime).toBe(2410);
    expect(useReplayStore.getState().playbackState).toBe(wasPlaying ? "playing" : "paused");
  });

  it("previews a rail tap and drag, commits once, and ignores the subsequent capture loss", () => {
    const { root } = timeline();
    expect(root.className).toContain("[&>*]:pointer-events-none");
    // This root is the actual browser hit target after the local pointer-events
    // rule. JSDOM has no layout hit testing; capture and Radix handlers are real.
    fireEvent.pointerDown(root, pointer(20));
    for (let x = 21; x <= 60; x++) fireEvent.pointerMove(root, pointer(x));
    expect(player.seek).not.toHaveBeenCalled();
    expect(player.pause).toHaveBeenCalledOnce();
    expect(useReplayStore.getState().currentTime).toBe(6000);
    fireEvent.pointerUp(root, pointer(60));
    fireEvent.lostPointerCapture(root, pointer(60));

    expect(player.seek).toHaveBeenCalledExactlyOnceWith(6000);
    expect(player.play).toHaveBeenCalledOnce();
    expect(useReplayStore.getState().currentTime).toBe(6000);
    expect(useReplayStore.getState().playbackState).toBe("playing");
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "cancels %s without seeking or accepting late moves",
    event => {
      const { root } = timeline();
      fireEvent.pointerDown(root, pointer(60));
      fireEvent[event](root, pointer(60));
      fireEvent.pointerMove(root, pointer(80));

      expect(player.seek).not.toHaveBeenCalled();
      expect(player.play).toHaveBeenCalledOnce();
      expect(useReplayStore.getState().currentTime).toBe(2400);
      expect(useReplayStore.getState().playbackState).toBe("playing");
    }
  );

  it("does not preview or commit late movement against a replacement player", () => {
    const { root } = timeline();
    fireEvent.pointerDown(root, pointer(60));
    const replacement = mockPlayer();
    act(() =>
      useReplayStore.setState({
        player: replacement as unknown as ReplayPlayerAdapter,
        selectionVersion: 1,
        currentTime: 700,
        isPlaying: false,
        playbackState: "paused",
      })
    );
    fireEvent.pointerMove(root, pointer(80));
    fireEvent.pointerUp(root, pointer(80));
    fireEvent.lostPointerCapture(root, pointer(80));

    expect(replacement.pause).not.toHaveBeenCalled();
    expect(replacement.seek).not.toHaveBeenCalled();
    expect(replacement.play).not.toHaveBeenCalled();
    expect(useReplayStore.getState().currentTime).toBe(700);
  });

  it("retains Radix pointer-up cleanup so a resized rail uses fresh geometry", () => {
    const { root, rect } = timeline();
    fireEvent.pointerDown(root, pointer(20));
    fireEvent.pointerUp(root, pointer(20));
    rect.mockReturnValue(new DOMRect(0, 0, 200, 8));
    fireEvent.pointerDown(root, pointer(150));
    fireEvent.pointerUp(root, pointer(150));

    expect(player.seek.mock.calls).toEqual([[2000], [7500]]);
  });
});
