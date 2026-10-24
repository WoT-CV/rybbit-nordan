import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayEventLike } from "../../network/types";
import { useReplayStore } from "../../replayStore";

const mocks = vi.hoisted(() => ({
  constructorCalls: vi.fn(),
  constructorError: null as Error | null,
  duration: 10_000,
  players: [] as Array<{
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    seek: ReturnType<typeof vi.fn>;
    playing: boolean;
    timeHandler?: (time: number) => void;
    playingHandler?: (playing: boolean) => void;
    durationHandler?: (duration: number) => void;
  }>,
}));

vi.mock("../ReplayPlayerAdapter", () => ({
  ReplayPlayerAdapter: class {
    playing = false;
    play = vi.fn(() => {
      this.playing = true;
    });
    pause = vi.fn(() => {
      this.playing = false;
    });
    destroy = vi.fn(() => {
      this.playing = false;
      this.playingHandler?.(false);
    });
    timeHandler?: (time: number) => void;
    playingHandler?: (playing: boolean) => void;
    durationHandler?: (duration: number) => void;
    constructor(options: { target: HTMLElement; events: ReplayEventLike[]; width: number; height: number }) {
      mocks.constructorCalls(options);
      if (mocks.constructorError) {
        options.target.append(document.createElement("iframe"));
        throw mocks.constructorError;
      }
      mocks.players.push(this);
    }
    getDuration() {
      return mocks.duration;
    }
    getIsPlaying() {
      return this.playing;
    }
    seek = vi.fn();
    resize() {}
    onCurrentTime(handler: (time: number) => void) {
      this.timeHandler = handler;
    }
    onPlayingChange(handler: (playing: boolean) => void) {
      this.playingHandler = handler;
    }
    onDuration(handler: (duration: number) => void) {
      this.durationHandler = handler;
    }
  },
}));

import { useReplayPlayer } from "./useReplayPlayer";

function Harness({ data }: { data?: { events: ReplayEventLike[] } }) {
  const { playerContainerRef } = useReplayPlayer({ data, width: 390, height: 700 });
  return <div ref={playerContainerRef} />;
}

describe("useReplayPlayer lifecycle", () => {
  beforeEach(() => {
    mocks.players.length = 0;
    mocks.constructorCalls.mockClear();
    mocks.constructorError = null;
    mocks.duration = 10_000;
    useReplayStore.setState({ ...useReplayStore.getInitialState(), sessionId: "test-replay" });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defers construction and initial metadata until the queued initialization runs", async () => {
    render(<Harness data={{ events: [] }} />);
    expect(mocks.players).toHaveLength(0);
    expect(useReplayStore.getState().duration).toBe(0);
    await act(async () => {});
    expect(mocks.players).toHaveLength(1);
    expect(useReplayStore.getState()).toMatchObject({ player: mocks.players[0], duration: 10_000, isPlaying: false });
    expect(mocks.players[0].play).not.toHaveBeenCalled();
  });

  it("constructs only the surviving StrictMode player after the trial cleanup", async () => {
    const view = render(
      <React.StrictMode>
        <Harness data={{ events: [] }} />
      </React.StrictMode>
    );
    expect(mocks.players).toHaveLength(0);
    await act(async () => {});
    expect(mocks.constructorCalls).toHaveBeenCalledOnce();
    expect(mocks.players).toHaveLength(1);
    expect(mocks.players[0].destroy).not.toHaveBeenCalled();
    expect(useReplayStore.getState().player).toBe(mocks.players[0]);
    view.unmount();
    expect(mocks.players[0].destroy).toHaveBeenCalledOnce();
    expect(useReplayStore.getState().player).toBeNull();
  });

  it("cancels initialization when unmounted before the queued callback runs", async () => {
    const addListener = vi.spyOn(document, "addEventListener");
    const view = render(<Harness data={{ events: [] }} />);
    view.unmount();
    await act(async () => {});
    expect(mocks.constructorCalls).not.toHaveBeenCalled();
    expect(useReplayStore.getState().player).toBeNull();
    expect(addListener).not.toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("cancels initial metadata and autoplay when unmounted after construction but before their microtask", async () => {
    useReplayStore.getState().selectSession("cached", true);
    const view = render(<Harness data={{ events: [] }} />);
    await act(async () => {
      // Initialization runs first, but its nested metadata task runs after this.
      queueMicrotask(() => view.unmount());
    });
    expect(mocks.constructorCalls).toHaveBeenCalledOnce();
    expect(mocks.players[0].destroy).toHaveBeenCalledOnce();
    expect(mocks.players[0].play).not.toHaveBeenCalled();
    expect(useReplayStore.getState()).toMatchObject({ player: null, duration: 0, isPlaying: false });
    expect(useReplayStore.getState().autoplayRequest?.sessionId).toBe("cached");
  });

  it("discards the pending recording when a newer session replaces its data", async () => {
    const previousEvents: ReplayEventLike[] = [];
    const nextEvents: ReplayEventLike[] = [];
    const view = render(<Harness data={{ events: previousEvents }} />);
    act(() => useReplayStore.getState().selectSession("new-session", true));
    view.rerender(<Harness data={{ events: nextEvents }} />);
    await act(async () => {});
    expect(mocks.constructorCalls).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ events: nextEvents }));
    expect(mocks.constructorCalls.mock.calls[0][0].events).toBe(nextEvents);
    expect(mocks.players[0].play).toHaveBeenCalledOnce();
    expect(useReplayStore.getState()).toMatchObject({ sessionId: "new-session", autoplayRequest: null });
  });

  it("initializes a newer selection of the same cached events instead of dropping its autoplay", async () => {
    const events: ReplayEventLike[] = [];
    render(<Harness data={{ events }} />);
    act(() => useReplayStore.getState().selectSession("test-replay", true));
    await act(async () => {});
    expect(mocks.constructorCalls).toHaveBeenCalledOnce();
    expect(mocks.players[0].play).toHaveBeenCalledOnce();
    expect(useReplayStore.getState()).toMatchObject({
      sessionId: "test-replay",
      selectionVersion: 1,
      autoplayRequest: null,
      player: mocks.players[0],
    });
  });

  it("does not apply a superseded session's queued metadata or playback", async () => {
    useReplayStore.getState().selectSession("previous", true);
    const view = render(<Harness data={{ events: [] }} />);
    await act(async () => {
      queueMicrotask(() => {
        useReplayStore.getState().selectSession("next", true);
        view.rerender(<Harness />);
      });
    });
    expect(mocks.constructorCalls).toHaveBeenCalledOnce();
    expect(mocks.players[0].destroy).toHaveBeenCalledOnce();
    expect(mocks.players[0].play).not.toHaveBeenCalled();
    expect(useReplayStore.getState()).toMatchObject({ sessionId: "next", player: null, duration: 0, isPlaying: false });
    expect(useReplayStore.getState().autoplayRequest?.sessionId).toBe("next");
  });

  it("uses the latest playback intent and position when queued initialization starts", async () => {
    render(<Harness data={{ events: [] }} />);
    act(() => useReplayStore.setState({ currentTime: 4200, isPlaying: true, playbackState: "playing" }));
    await act(async () => {});
    expect(mocks.players[0].seek).toHaveBeenCalledExactlyOnceWith(4200);
    expect(mocks.players[0].play).toHaveBeenCalledOnce();
    expect(useReplayStore.getState()).toMatchObject({ currentTime: 4200, isPlaying: true, duration: 10_000 });
  });

  it("does not construct a player while the selected recording is still loading", async () => {
    const view = render(<Harness />);
    await act(async () => {});
    expect(mocks.constructorCalls).not.toHaveBeenCalled();
    view.rerender(<Harness data={{ events: [] }} />);
    await act(async () => {});
    expect(mocks.constructorCalls).toHaveBeenCalledOnce();
  });

  it("clears a failed deferred constructor without publishing a partial player", async () => {
    mocks.constructorError = new Error("constructor failure");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    expect(error).toHaveBeenCalledExactlyOnceWith("Failed to initialize rrweb player:", mocks.constructorError);
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(useReplayStore.getState().player).toBeNull();
    view.unmount();
    expect(error).toHaveBeenCalledOnce();
  });

  it("waits for metadata before applying the pending autoplay once", async () => {
    mocks.duration = 0;
    useReplayStore.getState().selectSession("metadata-pending", true);
    render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    const player = mocks.players[0];
    expect(player.play).not.toHaveBeenCalled();
    expect(useReplayStore.getState().autoplayRequest).not.toBeNull();
    mocks.duration = 10_000;
    act(() => {
      player.durationHandler?.(10_000);
      player.durationHandler?.(10_000);
    });
    expect(player.play).toHaveBeenCalledOnce();
    expect(useReplayStore.getState()).toMatchObject({ duration: 10_000, autoplayRequest: null, isPlaying: true });
  });

  it("does not reconstruct the recording when only the query wrapper changes", async () => {
    const events: ReplayEventLike[] = [];
    const view = render(<Harness data={{ events }} />);
    view.rerender(<Harness data={{ events }} />);
    await act(async () => {});
    expect(mocks.players).toHaveLength(1);
    view.unmount();
    expect(mocks.players[0].destroy).toHaveBeenCalledOnce();
  });

  it("ignores playback clock updates during an unfinished seek", async () => {
    render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    act(() => {
      useReplayStore.setState({ playbackState: "seeking", currentTime: 7000 });
      mocks.players[0].timeHandler?.(1000);
    });
    expect(useReplayStore.getState().currentTime).toBe(7000);
  });

  it("pauses background playback and resumes only a previously playing recording", async () => {
    render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    const player = mocks.players[0];
    player.playing = true;
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(player.pause).toHaveBeenCalledOnce();
    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(player.play).toHaveBeenCalledOnce();
    player.playing = false;
    hidden.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(player.play).toHaveBeenCalledOnce();
  });

  it("releases a partially initialized player if observer setup fails", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor() {
          throw new Error("observer failure");
        }
      }
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const removeListener = vi.spyOn(document, "removeEventListener");
    const view = render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    expect(error).toHaveBeenCalled();
    expect(mocks.players[0].destroy).toHaveBeenCalledOnce();
    expect(useReplayStore.getState().player).toBeNull();
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    view.unmount();
    expect(mocks.players[0].destroy).toHaveBeenCalledOnce();
  });

  it("ignores stale callbacks and cleanup after another surface owns the controls", async () => {
    const page = render(<Harness data={{ events: [] }} />);
    const drawer = render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    const oldPlayer = mocks.players[0];
    const currentPlayer = mocks.players[1];
    act(() => {
      useReplayStore.setState({ currentTime: 7000, duration: 10_000, isPlaying: true });
      oldPlayer.timeHandler?.(100);
      oldPlayer.playingHandler?.(false);
      oldPlayer.durationHandler?.(200);
    });
    expect(useReplayStore.getState()).toMatchObject({
      player: currentPlayer,
      currentTime: 7000,
      duration: 10_000,
      isPlaying: true,
    });
    page.unmount();
    expect(oldPlayer.destroy).toHaveBeenCalledOnce();
    expect(useReplayStore.getState()).toMatchObject({ player: currentPlayer, currentTime: 7000, isPlaying: true });
    drawer.unmount();
    expect(useReplayStore.getState().player).toBeNull();
  });

  it("detaches callbacks before destroy and resumes the saved state on a new surface", async () => {
    const page = render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    act(() => useReplayStore.setState({ currentTime: 4200, isPlaying: true, playbackState: "playing" }));
    page.unmount();
    expect(useReplayStore.getState()).toMatchObject({ player: null, currentTime: 4200, isPlaying: true });
    render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    expect(mocks.players[1].play).toHaveBeenCalledOnce();
    expect(mocks.players[1].seek).toHaveBeenCalledExactlyOnceWith(4200);
    expect(useReplayStore.getState()).toMatchObject({ currentTime: 4200, isPlaying: true, duration: 10_000 });
  });

  it("starts a selected cached recording once without a later parent reset", async () => {
    useReplayStore.getState().selectSession("cached", true);
    render(<Harness data={{ events: [] }} />);
    await act(async () => {});
    expect(mocks.players[0].play).toHaveBeenCalledOnce();
    expect(useReplayStore.getState()).toMatchObject({
      player: mocks.players[0],
      isPlaying: true,
      autoplayRequest: null,
    });
  });
});
