import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayPlayerAdapter } from "../ReplayPlayerAdapter";
import { useReplayStore } from "../../replayStore";
import { useReplaySeek } from "./useReplaySeek";

function mockPlayer() {
  return { pause: vi.fn(), seek: vi.fn(), play: vi.fn() };
}

describe("useReplaySeek", () => {
  let player: ReturnType<typeof mockPlayer>;
  beforeEach(() => {
    player = mockPlayer();
    useReplayStore.setState({
      ...useReplayStore.getInitialState(),
      player: player as unknown as ReplayPlayerAdapter,
      sessionId: "replay-a",
      duration: 10000,
      currentTime: 1000,
      isPlaying: true,
      playbackState: "playing",
    });
  });
  afterEach(cleanup);

  it("previews many pointer movements without rebuilding the recorded DOM, then seeks once", () => {
    const { result } = renderHook(useReplaySeek);
    act(() => {
      for (let offset = 2000; offset <= 9000; offset += 100) result.current.previewSeek(offset);
    });
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.seek).not.toHaveBeenCalled();
    expect(useReplayStore.getState().currentTime).toBe(9000);
    expect(useReplayStore.getState().playbackState).toBe("seeking");
    act(() => result.current.commitPreviewSeek(9000));
    expect(player.seek).toHaveBeenCalledExactlyOnceWith(9000);
    expect(player.play).toHaveBeenCalledOnce();
    expect(useReplayStore.getState().playbackState).toBe("playing");
  });

  it("keeps a previously paused replay paused after committing", () => {
    useReplayStore.setState({ isPlaying: false, playbackState: "paused" });
    const { result } = renderHook(useReplaySeek);
    act(() => result.current.previewSeek(5000));
    act(() => result.current.commitPreviewSeek(5000));
    expect(player.play).not.toHaveBeenCalled();
    expect(useReplayStore.getState().playbackState).toBe("paused");
  });

  it("restores the original position and playback when the touch gesture is cancelled", () => {
    const { result } = renderHook(useReplaySeek);
    act(() => result.current.previewSeek(5000));
    act(() => result.current.cancelPreviewSeek());
    expect(player.seek).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledOnce();
    expect(useReplayStore.getState().currentTime).toBe(1000);
  });

  it("does not apply a stale gesture to a replacement player or selected session", () => {
    const { result } = renderHook(useReplaySeek);
    act(() => result.current.previewSeek(5000));
    const replacement = mockPlayer();
    useReplayStore.setState({ player: replacement as unknown as ReplayPlayerAdapter, selectionVersion: 1 });
    act(() => result.current.commitPreviewSeek(5000));
    expect(replacement.seek).not.toHaveBeenCalled();
    expect(replacement.play).not.toHaveBeenCalled();
  });

  it.each(["player", "selection"] as const)("ignores late previews and commit after a %s replacement", change => {
    const { result } = renderHook(useReplaySeek);
    act(() => result.current.previewSeek(5000));
    const replacement = change === "player" ? mockPlayer() : player;
    useReplayStore.setState({
      player: replacement as unknown as ReplayPlayerAdapter,
      selectionVersion: change === "selection" ? 1 : 0,
      currentTime: 700,
      isPlaying: false,
      playbackState: "paused",
    });
    replacement.pause.mockClear();
    act(() => result.current.previewSeek(8000));
    act(() => result.current.commitPreviewSeek(8000));

    expect(replacement.pause).not.toHaveBeenCalled();
    expect(replacement.seek).not.toHaveBeenCalled();
    expect(replacement.play).not.toHaveBeenCalled();
    expect(useReplayStore.getState().currentTime).toBe(700);
    expect(useReplayStore.getState().playbackState).toBe("paused");
  });

  it("clamps offsets and rejects non-finite positions", () => {
    const { result } = renderHook(useReplaySeek);
    act(() => {
      result.current.seekTo(Number.NaN);
      result.current.previewSeek(Number.POSITIVE_INFINITY);
      result.current.commitPreviewSeek(Number.NaN);
    });
    expect(player.seek).not.toHaveBeenCalled();
    act(() => result.current.seekTo(11000, false));
    expect(player.seek).toHaveBeenLastCalledWith(10000);
    act(() => result.current.seekTo(-10, false));
    expect(player.seek).toHaveBeenLastCalledWith(0);
  });

  it("allows keyboard commits without a pointer preview", () => {
    const { result } = renderHook(useReplaySeek);
    act(() => result.current.commitPreviewSeek(2000));
    expect(player.seek).toHaveBeenCalledExactlyOnceWith(2000);
    expect(player.play).toHaveBeenCalledOnce();
  });
});
