import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayPlayerAdapter } from "./player/ReplayPlayerAdapter";
import { useReplayStore } from "./replayStore";

function fakePlayer() {
  return { pause: vi.fn(), play: vi.fn(), seek: vi.fn() } as unknown as ReplayPlayerAdapter;
}

beforeEach(() => {
  useReplayStore.setState(useReplayStore.getInitialState(), true);
});

describe("single active replay player ownership", () => {
  it("pauses the replaced adapter instead of retaining a second active player", () => {
    const previous = fakePlayer();
    const replacement = fakePlayer();
    useReplayStore.getState().setPlayer(previous);
    useReplayStore.getState().setPlayer(replacement);
    expect(previous.pause).toHaveBeenCalledOnce();
    expect(useReplayStore.getState().player).toBe(replacement);
  });

  it("ignores a stale owner's teardown without clearing the replacement or its clock", () => {
    const previous = fakePlayer();
    const replacement = fakePlayer();
    const store = useReplayStore.getState();
    store.setPlayer(previous);
    store.setPlayer(replacement);
    store.setCurrentTime(4200);
    store.setDuration(10_000);
    store.releasePlayer(previous);
    expect(useReplayStore.getState()).toMatchObject({ player: replacement, currentTime: 4200, duration: 10_000 });
  });

  it("preserves playback intent and position for a fullscreen surface handoff", () => {
    const player = fakePlayer();
    const store = useReplayStore.getState();
    store.setPlayer(player);
    store.setCurrentTime(4200);
    store.setDuration(10_000);
    store.setIsPlaying(true);
    store.setPlaybackSpeed("2");
    store.releasePlayer(player);
    expect(useReplayStore.getState()).toMatchObject({
      player: null,
      currentTime: 4200,
      duration: 10_000,
      isPlaying: true,
      playbackSpeed: "2",
    });
    store.releasePlayer(player);
    expect(useReplayStore.getState().player).toBeNull();
  });

  it("resets session-specific state atomically before installing a cached recording's adapter", () => {
    const player = fakePlayer();
    const store = useReplayStore.getState();
    store.setPlayer(player);
    store.setCurrentTime(4200);
    store.setDuration(10_000);
    store.setPlaybackSpeed("2");
    store.setActivityPeriods([{ start: 0, end: 1000 }]);
    store.selectSession("next-session", true);
    const selection = useReplayStore.getState();
    expect(player.pause).toHaveBeenCalledOnce();
    expect(selection).toMatchObject({
      sessionId: "next-session",
      player: null,
      currentTime: 0,
      duration: 0,
      activityPeriods: [],
      autoplayRequest: { sessionId: "next-session", selectionVersion: selection.selectionVersion },
    });
    const replacement = fakePlayer();
    selection.setPlayer(replacement);
    expect(useReplayStore.getState().player).toBe(replacement);
    expect(useReplayStore.getState().autoplayRequest).toEqual(selection.autoplayRequest);
  });

  it("clears a deleted selection and pauses only its active player", () => {
    const player = fakePlayer();
    const store = useReplayStore.getState();
    store.selectSession("deleted", true);
    store.setPlayer(player);
    store.selectSession("", false);
    expect(player.pause).toHaveBeenCalledOnce();
    expect(useReplayStore.getState()).toMatchObject({
      sessionId: "",
      player: null,
      currentTime: 0,
      duration: 0,
      autoplayRequest: null,
    });
  });

  it("does not consume a newer session's autoplay request from an old callback", () => {
    const store = useReplayStore.getState();
    store.selectSession("first", true);
    const oldRequest = useReplayStore.getState().autoplayRequest!;
    store.selectSession("next", true);
    const nextRequest = useReplayStore.getState().autoplayRequest;
    store.consumeAutoplay(oldRequest);
    expect(useReplayStore.getState().autoplayRequest).toBe(nextRequest);
  });
});
