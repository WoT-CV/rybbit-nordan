import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ReplayEventLike } from "../../network/types";
import { useReplayStore } from "../../replayStore";
import { ReplayPlayerAdapter } from "../ReplayPlayerAdapter";

interface UseReplayPlayerProps {
  data: { events: ReplayEventLike[] } | undefined;
  width: number;
  height: number;
}

export const useReplayPlayer = ({ data, width, height }: UseReplayPlayerProps) => {
  const events = data?.events;
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ReplayPlayerAdapter | null>(null);
  const { sessionId, selectionVersion, setPlayer, releasePlayer, setCurrentTime, setIsPlaying, setDuration } =
    useReplayStore(
      useShallow(state => ({
        sessionId: state.sessionId,
        selectionVersion: state.selectionVersion,
        setPlayer: state.setPlayer,
        releasePlayer: state.releasePlayer,
        setCurrentTime: state.setCurrentTime,
        setIsPlaying: state.setIsPlaying,
        setDuration: state.setDuration,
      }))
    );

  const widthRef = useRef(width);
  const heightRef = useRef(height);

  useEffect(() => {
    widthRef.current = width;
    heightRef.current = height;
  }, [height, width]);

  useEffect(() => {
    const target = playerContainerRef.current;
    if (!events || !target) return;

    let cancelled = false;
    let handleVisibilityChange: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let adapter: ReplayPlayerAdapter;
    let cleanupPlayer = () => target.replaceChildren();
    const cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      if (handleVisibilityChange) document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver?.disconnect();
      cleanupPlayer();
    };

    // StrictMode's trial setup is cleaned up before this microtask. Avoid
    // constructing a throwaway rrweb instance with an uncancellable poster timer.
    queueMicrotask(() => {
      if (cancelled) return;
      const initializedState = useReplayStore.getState();
      if (initializedState.sessionId !== sessionId || initializedState.selectionVersion !== selectionVersion) return;
      const initializedSessionId = sessionId;
      const initializedSelectionVersion = selectionVersion;
      const initializedCurrentTime = initializedState.currentTime;
      const initializedWasPlaying = initializedState.isPlaying;
      let initialPlaybackApplied = false;

      target.replaceChildren();

      try {
        const initialRect = target.getBoundingClientRect();
        adapter = new ReplayPlayerAdapter({
          target,
          events,
          width: initialRect.width || widthRef.current,
          height: initialRect.height || heightRef.current,
        });

        playerRef.current = adapter;
        cleanupPlayer = () => {
          releasePlayer(adapter);
          adapter.destroy();
          if (playerRef.current === adapter) playerRef.current = null;
        };
        setPlayer(adapter);

        adapter.onCurrentTime(currentTime => {
          const state = useReplayStore.getState();
          if (state.player !== adapter || state.playbackState === "seeking") return;
          const playerDuration = adapter.getDuration();
          if (playerDuration && currentTime > playerDuration) {
            adapter.pause();
            setCurrentTime(playerDuration);
            setIsPlaying(false);
          } else {
            setCurrentTime(currentTime);
          }
        });

        adapter.onPlayingChange(isNowPlaying => {
          if (useReplayStore.getState().player !== adapter) return;
          setIsPlaying(isNowPlaying);
          if (!isNowPlaying) return;

          const state = useReplayStore.getState();
          if (
            state.sessionId === initializedSessionId &&
            state.autoplayRequest?.sessionId === initializedSessionId &&
            state.autoplayRequest.selectionVersion === initializedSelectionVersion &&
            state.player === adapter
          ) {
            state.setPlaybackState("playing");
            state.consumeAutoplay(state.autoplayRequest);
          }
        });

        const syncDurationAndPlayback = () => {
          const state = useReplayStore.getState();
          if (
            cancelled ||
            state.player !== adapter ||
            state.sessionId !== initializedSessionId ||
            state.selectionVersion !== initializedSelectionVersion
          ) {
            return;
          }

          const playerDuration = adapter.getDuration();
          if (playerDuration) setDuration(playerDuration);
          if (!playerDuration || initialPlaybackApplied) return;
          initialPlaybackApplied = true;

          const resumeAt = Math.max(0, Math.min(playerDuration, initializedCurrentTime));
          if (resumeAt > 0) {
            adapter.seek(resumeAt);
            setCurrentTime(resumeAt);
          }

          const autoplayRequest = state.autoplayRequest;
          const shouldAutoplay =
            autoplayRequest?.sessionId === initializedSessionId &&
            autoplayRequest.selectionVersion === initializedSelectionVersion;
          if (shouldAutoplay || initializedWasPlaying) {
            adapter.play();
            state.setIsPlaying(true);
            state.setPlaybackState("playing");
          }
          if (shouldAutoplay && autoplayRequest) {
            state.consumeAutoplay(autoplayRequest);
          }
        };

        adapter.onDuration(playerDuration => {
          if (useReplayStore.getState().player !== adapter) return;
          setDuration(playerDuration);
          syncDurationAndPlayback();
        });
        queueMicrotask(syncDurationAndPlayback);

        let wasPlayingBeforeHidden = false;
        handleVisibilityChange = () => {
          if (useReplayStore.getState().player !== adapter) return;
          if (document.hidden) {
            wasPlayingBeforeHidden = adapter.getIsPlaying();
            if (wasPlayingBeforeHidden) {
              adapter.pause();
              setIsPlaying(false);
            }
            return;
          }

          if (wasPlayingBeforeHidden) {
            const playerDuration = adapter.getDuration();
            if (playerDuration) setDuration(playerDuration);
            adapter.play();
            setIsPlaying(true);
            wasPlayingBeforeHidden = false;
          }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);

        resizeObserver = new ResizeObserver(entries => {
          const entry = entries[0];
          if (cancelled || !entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
          adapter.resize(entry.contentRect.width, entry.contentRect.height);
        });
        resizeObserver.observe(target);
      } catch (error) {
        cleanup();
        console.error("Failed to initialize rrweb player:", error);
        return;
      }
    });

    return cleanup;
  }, [events, releasePlayer, selectionVersion, sessionId, setCurrentTime, setDuration, setIsPlaying, setPlayer]);

  useEffect(() => {
    const target = playerContainerRef.current;
    const rect = target?.getBoundingClientRect();
    playerRef.current?.resize(rect?.width || width, rect?.height || height);
  }, [height, width]);

  return { playerContainerRef };
};
