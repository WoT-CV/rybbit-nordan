"use client";

import { useMeasure } from "@uidotdev/usehooks";
import { Video } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useGetSessionReplays } from "../../../api/analytics/hooks/sessionReplay/useGetSessionReplays";
import { DisabledOverlay } from "../../../components/DisabledOverlay";
import { NothingFound } from "../../../components/NothingFound";
import { ReplayBreadcrumbs } from "@/components/replay/ReplayBreadcrumbs";
import useMediaQuery from "@/components/ui/hooks/useMediaQuery";
import { ReplayPlayer } from "@/components/replay/player/ReplayPlayer";
import { ReplayDrawer } from "@/components/Sessions/ReplayDrawer";
import { useReplayStore } from "@/components/replay/replayStore";
import { useSetPageTitle } from "../../../hooks/useSetPageTitle";
import { SESSION_REPLAY_PAGE_FILTERS } from "../../../lib/filterGroups";
import { SubHeader } from "../components/SubHeader/SubHeader";
import { EnableSessionReplay } from "./components/EnableSessionReplay";
import { ReplayList } from "./components/ReplayList";
import { useAppEnv } from "../../../hooks/useIsProduction";

export default function SessionReplayPage() {
  const appEnv = useAppEnv();

  if (appEnv === "demo") return null;

  return <SessionReplayContent />;
}

function SessionReplayContent() {
  const t = useExtracted();
  useSetPageTitle(t("Session Replay"));

  const { minDuration, sessionId } = useReplayStore(
    useShallow(s => ({ minDuration: s.minDuration, sessionId: s.sessionId }))
  );

  const { data, isLoading } = useGetSessionReplays({ minDuration });
  const hasNoReplays = !isLoading && !data?.pages[0].data?.length;

  // On narrow screens the player can't sit beside the list, so selecting a
  // replay opens the fullscreen drawer (player + timeline) instead.
  const isCompact = useMediaQuery("(max-width: 767px)");
  const showTimeline = useMediaQuery("(min-width: 1280px)");
  const [mobileOpen, setMobileOpen] = useState(false);

  const [playerRef, { width: playerWidth, height: playerHeight }] = useMeasure();

  return (
    <DisabledOverlay message={t("Replay")} featurePath="replay" requiredPlan="pro">
      <div className="flex h-dvh w-full max-w-none flex-col gap-3 overflow-hidden p-2 md:p-4">
        <div className="shrink-0">
          <SubHeader availableFilters={SESSION_REPLAY_PAGE_FILTERS} />
        </div>
        {/* Renders null in the common case, so it adds no flex gap. */}
        <EnableSessionReplay />

        {hasNoReplays ? (
          <div className="flex flex-1 items-center justify-center">
            <NothingFound
              icon={<Video className="w-10 h-10" />}
              title={t("No session replays found")}
              description={t("Replays will appear here once session replay is enabled.")}
            />
          </div>
        ) : (
          <div className="flex gap-3 flex-1 min-h-0">
            {/* List */}
            <div className="min-h-0 w-full shrink-0 md:w-[clamp(240px,15vw,320px)]">
              <ReplayList onSelect={isCompact ? () => setMobileOpen(true) : undefined} />
            </div>

            {/* Player */}
            <div ref={playerRef} className="hidden md:block flex-1 min-w-0 overflow-hidden">
              {!isCompact && playerWidth && playerHeight ? (
                <ReplayPlayer width={playerWidth} height={playerHeight} />
              ) : null}
            </div>

            {/* Timeline */}
            {showTimeline && (
              <div className="hidden min-h-0 w-[clamp(360px,21vw,460px)] shrink-0 xl:block">
                <ReplayBreadcrumbs />
              </div>
            )}
          </div>
        )}

        {isCompact && (
          <ReplayDrawer sessionId={sessionId} open={mobileOpen} onOpenChange={setMobileOpen} preservePlaybackState />
        )}
      </div>
    </DisabledOverlay>
  );
}
