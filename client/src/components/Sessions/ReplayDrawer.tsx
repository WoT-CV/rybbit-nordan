"use client";

import { useEffect, useState } from "react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { X } from "lucide-react";
import { useExtracted } from "next-intl";

import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { ReplayPlayer } from "@/components/replay/player/ReplayPlayer";
import { ReplayBreadcrumbs } from "@/components/replay/ReplayBreadcrumbs";
import { useReplayStore } from "@/components/replay/replayStore";

interface ReplayDrawerProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preservePlaybackState?: boolean;
}

export function ReplayDrawer({ sessionId, open, onOpenChange, preservePlaybackState = false }: ReplayDrawerProps) {
  const t = useExtracted();
  // Closed drawers are also mounted in every session card. Do not subscribe
  // all of them to the playback clock (potentially 60 updates per second).
  const selectSession = useReplayStore(state => state.selectSession);
  // Vaul mounts its portal after the open-state effect. Observe the actual
  // mounted node, including the width change when the desktop timeline appears.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0, showTimeline: false });

  useEffect(() => {
    if (open && sessionId && !preservePlaybackState) {
      selectSession(sessionId, true);
    }
  }, [open, preservePlaybackState, selectSession, sessionId]);

  // The mounted player's cleanup releases only its own adapter. A reset on
  // close would erase the page player created during a fullscreen handoff.

  // Measure container dimensions using getBoundingClientRect for more reliable sizing
  useEffect(() => {
    if (!open || !container) return;

    const measureDimensions = () => {
      if (container) {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const showTimeline = window.matchMedia("(min-width: 1024px)").matches;
          setDimensions(previous =>
            previous.width === rect.width && previous.height === rect.height && previous.showTimeline === showTimeline
              ? previous
              : { width: rect.width, height: rect.height, showTimeline }
          );
        }
      }
    };

    // The observer also catches layout changes that do not resize the window.
    const resizeObserver = new ResizeObserver(() => {
      measureDimensions();
    });

    resizeObserver.observe(container);
    measureDimensions();

    window.addEventListener("resize", measureDimensions);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureDimensions);
    };
  }, [container, open]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} handleOnly>
      <DrawerContent
        // `hidden` is still programmatically scrollable. Select/slider focus
        // on mobile Safari could scroll the player out of this fixed panel.
        className="h-[90dvh] overflow-clip"
        aria-describedby={undefined}
        onPointerDownOutside={event => event.preventDefault()}
      >
        <VisuallyHidden>
          <DrawerTitle>{t("Session Replay")}</DrawerTitle>
        </VisuallyHidden>
        <DrawerClose asChild>
          <Button className="absolute right-2 top-1" size="smIcon" variant="ghost" aria-label={t("Close")}>
            <X className="size-4" aria-hidden="true" />
          </Button>
        </DrawerClose>
        <div className="flex min-h-0 flex-1 gap-2 p-2" data-vaul-no-drag>
          {/* Player */}
          <div ref={setContainer} className="relative min-h-0 min-w-0 flex-1">
            {open && dimensions.width > 0 && dimensions.height > 0 && (
              <ReplayPlayer width={dimensions.width} height={dimensions.height} isDrawer={true} />
            )}
          </div>

          {/* Timeline sidebar */}
          {open && dimensions.showTimeline && (
            <div className="hidden h-full min-h-0 w-[clamp(360px,22vw,460px)] shrink-0 lg:block">
              <ReplayBreadcrumbs />
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
