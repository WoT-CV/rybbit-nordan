import { create } from "zustand";

import {
  DEFAULT_INACTIVITY_FAST_FORWARD_SPEED,
  type InactivityFastForwardSpeed,
} from "./player/hooks/inactivityFastForward";
import type { ActivityPeriod, ReplayCaptureProfile, ReplaySegment } from "./player/utils/replayUtils";
import type { ReplayPlayerAdapter } from "./player/ReplayPlayerAdapter";

type ReplayPlaybackState = "paused" | "playing" | "skipping-inactivity" | "seeking" | "buffering" | "ended";
interface ReplayAutoplayRequest {
  sessionId: string;
  selectionVersion: number;
}

export const useReplayStore = create<{
  minDuration: number;
  setMinDuration: (minDuration: number) => void;

  // Session selection
  sessionId: string;
  setSessionId: (sessionId: string) => void;
  selectionVersion: number;
  autoplayRequest: ReplayAutoplayRequest | null;
  selectSession: (sessionId: string, autoplay: boolean) => void;
  consumeAutoplay: (request: ReplayAutoplayRequest) => void;

  // Player state
  player: ReplayPlayerAdapter | null;
  setPlayer: (player: ReplayPlayerAdapter | null) => void;
  releasePlayer: (player: ReplayPlayerAdapter) => void;

  // Playback state
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;

  currentTime: number;
  setCurrentTime: (currentTime: number) => void;
  seekRevision: number;
  markSeek: () => void;

  duration: number;
  setDuration: (duration: number) => void;

  playbackSpeed: string;
  setPlaybackSpeed: (speed: string) => void;

  effectivePlaybackSpeed: number;
  setEffectivePlaybackSpeed: (speed: number) => void;

  playbackState: ReplayPlaybackState;
  setPlaybackState: (state: ReplayPlaybackState) => void;

  isSkippingInactivity: boolean;
  setIsSkippingInactivity: (isSkipping: boolean) => void;

  activityPeriods: ActivityPeriod[];
  setActivityPeriods: (periods: ActivityPeriod[]) => void;

  replaySegments: ReplaySegment[];
  setReplaySegments: (segments: ReplaySegment[]) => void;

  replayCaptureProfile: ReplayCaptureProfile;
  setReplayCaptureProfile: (profile: ReplayCaptureProfile) => void;

  skipInactivityEnabled: boolean;
  setSkipInactivityEnabled: (enabled: boolean) => void;

  skipInactivitySpeed: InactivityFastForwardSpeed;
  setSkipInactivitySpeed: (speed: InactivityFastForwardSpeed) => void;

  exportRange: [number, number] | null;
  setExportRange: (range: [number, number] | null) => void;

  // Reset all player state when session changes
  resetPlayerState: () => void;
}>(set => ({
  minDuration: 5,
  setMinDuration: minDuration => set({ minDuration }),

  // Session selection
  sessionId: "",
  setSessionId: sessionId => set({ sessionId }),
  selectionVersion: 0,
  autoplayRequest: null,
  selectSession: (sessionId, autoplay) =>
    set(state => {
      if (state.sessionId === sessionId && state.player) {
        if (autoplay) {
          if (state.duration > 0 && state.currentTime >= state.duration) {
            state.player.seek(0);
          }
          state.player.play();
        }
        const restartedFromEnd = autoplay && state.duration > 0 && state.currentTime >= state.duration;
        return {
          autoplayRequest: null,
          currentTime: restartedFromEnd ? 0 : state.currentTime,
          seekRevision: restartedFromEnd ? state.seekRevision + 1 : state.seekRevision,
          isPlaying: autoplay ? true : state.isPlaying,
          playbackState: autoplay ? "playing" : state.playbackState,
        };
      }

      state.player?.pause();
      const selectionVersion = state.selectionVersion + 1;
      return {
        sessionId,
        selectionVersion,
        autoplayRequest: autoplay ? { sessionId, selectionVersion } : null,
        player: null,
        isPlaying: false,
        currentTime: 0,
        seekRevision: state.seekRevision + 1,
        duration: 0,
        effectivePlaybackSpeed: 1,
        playbackState: "paused",
        isSkippingInactivity: false,
        activityPeriods: [],
        replaySegments: [],
        replayCaptureProfile: "legacy",
        exportRange: null,
      };
    }),
  consumeAutoplay: request =>
    set(state => ({
      autoplayRequest:
        state.autoplayRequest?.sessionId === request.sessionId &&
        state.autoplayRequest.selectionVersion === request.selectionVersion
          ? null
          : state.autoplayRequest,
    })),

  // Player state
  player: null,
  setPlayer: player =>
    set(state => {
      if (state.player && state.player !== player) state.player.pause();
      return { player };
    }),
  // Keep the clock and playback intent for the single active surface's handoff.
  // A delayed cleanup must never detach the replacement adapter.
  releasePlayer: player => set(state => (state.player === player ? { player: null } : state)),

  // Playback state
  isPlaying: false,
  setIsPlaying: isPlaying => set({ isPlaying }),

  currentTime: 0,
  setCurrentTime: currentTime => set({ currentTime }),
  seekRevision: 0,
  markSeek: () => set(state => ({ seekRevision: state.seekRevision + 1 })),

  duration: 0,
  setDuration: duration => set({ duration }),

  playbackSpeed: "1",
  setPlaybackSpeed: playbackSpeed => set({ playbackSpeed }),

  effectivePlaybackSpeed: 1,
  setEffectivePlaybackSpeed: effectivePlaybackSpeed => set({ effectivePlaybackSpeed }),

  playbackState: "paused",
  setPlaybackState: playbackState => set({ playbackState }),

  isSkippingInactivity: false,
  setIsSkippingInactivity: isSkippingInactivity => set({ isSkippingInactivity }),

  activityPeriods: [],
  setActivityPeriods: activityPeriods => set({ activityPeriods }),

  replaySegments: [],
  setReplaySegments: replaySegments => set({ replaySegments }),

  replayCaptureProfile: "legacy",
  setReplayCaptureProfile: replayCaptureProfile => set({ replayCaptureProfile }),

  skipInactivityEnabled: true,
  setSkipInactivityEnabled: skipInactivityEnabled => set({ skipInactivityEnabled }),

  skipInactivitySpeed: DEFAULT_INACTIVITY_FAST_FORWARD_SPEED,
  setSkipInactivitySpeed: skipInactivitySpeed => set({ skipInactivitySpeed }),

  exportRange: null,
  setExportRange: exportRange => set({ exportRange }),

  // Reset all player state when session changes
  resetPlayerState: () =>
    set(state => ({
      player: null,
      isPlaying: false,
      currentTime: 0,
      seekRevision: state.seekRevision + 1,
      duration: 0,
      playbackSpeed: "1",
      effectivePlaybackSpeed: 1,
      playbackState: "paused",
      isSkippingInactivity: false,
      activityPeriods: [],
      replaySegments: [],
      replayCaptureProfile: "legacy",
      autoplayRequest: null,
      exportRange: null,
    })),
}));
