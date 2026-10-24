import { useCallback, useRef } from "react";

import { useReplayStore } from "../../replayStore";
import type { ReplayPlayerAdapter } from "../ReplayPlayerAdapter";

interface SeekPreview {
  player: ReplayPlayerAdapter;
  selectionVersion: number;
  currentTime: number;
  wasPlaying: boolean;
}

function isCurrentPreview(preview: SeekPreview) {
  const state = useReplayStore.getState();
  return state.player === preview.player && state.selectionVersion === preview.selectionVersion;
}

export function useReplaySeek() {
  const previewRef = useRef<SeekPreview | null>(null);

  const seekTo = useCallback((offset: number, shouldPlay?: boolean) => {
    const state = useReplayStore.getState();
    const player = state.player;
    if (!player || !Number.isFinite(offset)) return;

    const preview = previewRef.current;
    previewRef.current = null;
    const resumePlayback = shouldPlay ?? (preview && isCurrentPreview(preview) ? preview.wasPlaying : state.isPlaying);
    const safeOffset = Math.max(0, Math.min(state.duration, offset));

    player.pause();
    state.setPlaybackState("seeking");
    player.seek(safeOffset);
    state.setCurrentTime(safeOffset);
    state.markSeek();

    if (resumePlayback) {
      player.play();
      state.setIsPlaying(true);
      state.setPlaybackState("playing");
    } else {
      state.setIsPlaying(false);
      state.setPlaybackState("paused");
    }
  }, []);

  const previewSeek = useCallback((offset: number) => {
    const state = useReplayStore.getState();
    if (!state.player || !Number.isFinite(offset)) return;

    // Late movements from a gesture on the old selection must not start a new
    // preview against its replacement player. Commit/cancel clears the gesture.
    if (previewRef.current && !isCurrentPreview(previewRef.current)) return;
    if (!previewRef.current) {
      previewRef.current = {
        player: state.player,
        selectionVersion: state.selectionVersion,
        currentTime: state.currentTime,
        wasPlaying: state.isPlaying,
      };
      state.player.pause();
      state.setIsPlaying(false);
      state.setPlaybackState("seeking");
    }

    const safeOffset = Math.max(0, Math.min(state.duration, offset));
    // rrweb.goto reconstructs the recorded DOM. Rebuilding it on every touch
    // move can overwhelm mobile Safari on large recordings. Preview only the
    // position; rebuild exactly once when the pointer/key gesture commits.
    state.setCurrentTime(safeOffset);
  }, []);

  const cancelPreviewSeek = useCallback(() => {
    const preview = previewRef.current;
    previewRef.current = null;
    if (!preview || !isCurrentPreview(preview)) return;
    const state = useReplayStore.getState();
    state.setCurrentTime(preview.currentTime);
    if (preview.wasPlaying) preview.player.play();
    state.setIsPlaying(preview.wasPlaying);
    state.setPlaybackState(preview.wasPlaying ? "playing" : "paused");
  }, []);

  const commitPreviewSeek = useCallback(
    (offset: number) => {
      if (!Number.isFinite(offset)) {
        cancelPreviewSeek();
        return;
      }
      const preview = previewRef.current;
      previewRef.current = null;
      if (preview && !isCurrentPreview(preview)) return;
      const shouldPlay = preview?.wasPlaying ?? useReplayStore.getState().isPlaying;
      seekTo(offset, shouldPlay);
    },
    [cancelPreviewSeek, seekTo]
  );

  return { cancelPreviewSeek, commitPreviewSeek, previewSeek, seekTo };
}
