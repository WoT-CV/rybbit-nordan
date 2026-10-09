import { Maximize2, Pause, Play, SkipForward } from "lucide-react";
import { useExtracted } from "next-intl";
import { memo, useCallback, useEffect, useMemo, type ComponentProps } from "react";
import { useShallow } from "zustand/react/shallow";
import { getReplayActivityDuration } from "@rybbit/shared";
import { useCanOnSite } from "@/hooks/usePermissions";

import { ActivitySlider } from "@/components/ui/activity-slider";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { ReplayExportButton } from "../export/ReplayExportButton";
import { createInitialExportRange, ReplayExportRangeSlider } from "../export/ReplayExportRangeSlider";
import { parseNetworkEvents } from "../network/parseNetworkEvents";
import type { ReplayEventLike } from "../network/types";
import { useReplayStore } from "../replayStore";
import { INACTIVITY_FAST_FORWARD_SPEEDS, isInactivityFastForwardSpeed } from "./hooks/inactivityFastForward";
import { useReplaySeek } from "./hooks/useReplaySeek";
import { formatTime, PLAYBACK_SPEEDS } from "./utils/replayUtils";

interface ReplayPlayerControlsProps {
  events: ReplayEventLike[];
  onPlayPause: () => void;
  onSliderChange: (value: number[]) => void;
  onSliderCommit: (value: number[]) => void;
  onSliderCancel: () => void;
  onSpeedChange: (speed: string) => void;
  onFullscreenOpen?: () => void;
  isDrawer?: boolean;
}

// Only the timeline needs the precise per-frame clock. Keeping this subscription
// below the toolbar avoids rebuilding the menus and export controls every frame.
const ReplayTimeline = memo(function ReplayTimeline({
  duration = 0,
  ...props
}: Omit<ComponentProps<typeof ActivitySlider>, "currentTime" | "value">) {
  const currentTime = useReplayStore(s => s.currentTime);
  return (
    <ActivitySlider
      {...props}
      duration={duration}
      currentTime={currentTime}
      value={[duration > 0 ? (currentTime / duration) * 100 : 0]}
    />
  );
});

const ReplayTime = memo(function ReplayTime({ duration }: { duration: number }) {
  const time = useReplayStore(s => formatTime(s.currentTime));
  return (
    <div className="ml-auto whitespace-nowrap text-center text-xs text-neutral-700 dark:text-neutral-300">
      {time} / {formatTime(duration)}
    </div>
  );
});

export const ReplayPlayerControls = memo(function ReplayPlayerControls({
  events,
  onPlayPause,
  onSliderChange,
  onSliderCommit,
  onSliderCancel,
  onSpeedChange,
  onFullscreenOpen,
  isDrawer,
}: ReplayPlayerControlsProps) {
  const t = useExtracted();
  const canExport = useCanOnSite("replay:export");
  const {
    activityPeriods,
    duration,
    exportRange,
    isPlaying,
    playbackSpeed,
    player,
    replaySegments,
    sessionId,
    setExportRange,
    setSkipInactivityEnabled,
    setSkipInactivitySpeed,
    skipInactivityEnabled,
    skipInactivitySpeed,
  } = useReplayStore(
    useShallow(s => ({
      activityPeriods: s.activityPeriods,
      duration: s.duration,
      exportRange: s.exportRange,
      isPlaying: s.isPlaying,
      playbackSpeed: s.playbackSpeed,
      player: s.player,
      replaySegments: s.replaySegments,
      sessionId: s.sessionId,
      setExportRange: s.setExportRange,
      setSkipInactivityEnabled: s.setSkipInactivityEnabled,
      setSkipInactivitySpeed: s.setSkipInactivitySpeed,
      skipInactivityEnabled: s.skipInactivityEnabled,
      skipInactivitySpeed: s.skipInactivitySpeed,
    }))
  );
  const networkRequests = useMemo(() => parseNetworkEvents(events), [events]);
  const { seekTo } = useReplaySeek();

  useEffect(() => {
    if (!canExport || duration <= 0 || exportRange || replaySegments.length === 0) return;
    setExportRange(createInitialExportRange(useReplayStore.getState().currentTime, duration, activityPeriods));
  }, [activityPeriods, canExport, duration, exportRange, replaySegments.length, setExportRange]);

  const exportDuration = exportRange ? getReplayActivityDuration(activityPeriods, exportRange[0], exportRange[1]) : 0;

  const handleSkipInactivityToggle = useCallback(() => {
    setSkipInactivityEnabled(!skipInactivityEnabled);
  }, [setSkipInactivityEnabled, skipInactivityEnabled]);

  const handleSkipInactivitySpeedChange = useCallback(
    (speed: string) => {
      const parsedSpeed = Number.parseInt(speed, 10);
      if (isInactivityFastForwardSpeed(parsedSpeed)) setSkipInactivitySpeed(parsedSpeed);
    },
    [setSkipInactivitySpeed]
  );

  const handleNetworkSeek = useCallback(
    (offset: number) => {
      seekTo(offset);
    },
    [seekTo]
  );

  return (
    <div className="border border-neutral-100 dark:border-neutral-800 bg-white p-2 pb-3 dark:bg-neutral-900 rounded-b-lg">
      <div>
        <ReplayTimeline
          onValueChange={onSliderChange}
          onValueCommit={onSliderCommit}
          onPointerCancel={onSliderCancel}
          onLostPointerCapture={onSliderCancel}
          max={100}
          step={0.1}
          activityPeriods={activityPeriods}
          replaySegments={replaySegments}
          duration={duration}
          events={events}
          networkRequests={networkRequests}
          exportRange={canExport ? exportRange : null}
          onNetworkSeek={handleNetworkSeek}
          className="w-full"
        />
        {canExport && exportRange && (
          <ReplayExportRangeSlider
            duration={duration}
            range={exportRange}
            activityPeriods={activityPeriods}
            onRangeChange={setExportRange}
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="smIcon"
          aria-label={isPlaying ? t("Pause") : t("Play")}
          onClick={onPlayPause}
          disabled={!player}
        >
          {isPlaying ? (
            <Pause className="w-4 h-4" fill="currentColor" />
          ) : (
            <Play className="w-4 h-4" fill="currentColor" />
          )}
        </Button>
        <ReplayTime duration={duration} />
        <div className="flex min-w-0 items-center gap-1.5">
          {canExport && (
            <ReplayExportButton
              disabled={!player || duration <= 0 || exportDuration <= 0}
              range={exportRange}
              sessionId={sessionId}
            />
          )}
          <Button
            type="button"
            variant={skipInactivityEnabled ? "secondary" : "outline"}
            size="xs"
            aria-pressed={skipInactivityEnabled}
            onClick={handleSkipInactivityToggle}
            title={t("Skip inactivity")}
          >
            <SkipForward className="h-3 w-3" aria-hidden="true" />
            <span className="hidden xl:inline">{t("Skip inactivity")}</span>
          </Button>
          <Select value={skipInactivitySpeed.toString()} onValueChange={handleSkipInactivitySpeedChange}>
            <SelectTrigger
              size="sm"
              className="w-14 shrink-0"
              aria-label={`${t("Skip inactivity")}: ${skipInactivitySpeed}x`}
              title={`${t("Skip inactivity")}: ${skipInactivitySpeed}x`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent size="sm">
              <SelectGroup>
                {INACTIVITY_FAST_FORWARD_SPEEDS.map(speed => (
                  <SelectItem key={speed} value={speed.toString()} size="sm">
                    {speed}x
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <Select value={playbackSpeed} onValueChange={onSpeedChange}>
          <SelectTrigger size="sm" className="w-14 shrink-0" aria-label={t("Playback speed")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent size="sm">
            <SelectGroup>
              {PLAYBACK_SPEEDS.map(speed => (
                <SelectItem key={speed.value} value={speed.value} size="sm">
                  {speed.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {!isDrawer && onFullscreenOpen && (
          <Button variant="ghost" size="smIcon" onClick={onFullscreenOpen}>
            <Maximize2 className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  );
});
