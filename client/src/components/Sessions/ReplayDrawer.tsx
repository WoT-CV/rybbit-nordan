"use client";

import { ListTree } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { ReplayPlayer } from "@/components/replay/player/ReplayPlayer";
import { useReplayStore } from "@/components/replay/replayStore";
import { ReplayBreadcrumbs } from "@/components/replay/ReplayBreadcrumbs";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { cn } from "@/lib/utils";

interface ReplayDrawerProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReplayDrawer({ sessionId, open, onOpenChange }: ReplayDrawerProps) {
  const t = useExtracted();
  const setSessionId = useReplayStore(s => s.setSessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineToggleRef = useRef<HTMLButtonElement>(null);
  const timelineId = useId();
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // Set sessionId in store when drawer opens
  useEffect(() => {
    if (open && sessionId) {
      setSessionId(sessionId);
    }
  }, [open, sessionId, setSessionId]);

  // No reset on close: the drawer's player unregisters itself when it unmounts,
  // handing the controls back to any player still on the page.

  // Measure container dimensions using getBoundingClientRect for more reliable sizing
  useEffect(() => {
    if (!open) return;

    const measureDimensions = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setDimensions({ width: rect.width, height: rect.height });
        }
      }
    };

    // Measure after a short delay to ensure drawer animation has completed
    const timeoutId = setTimeout(measureDimensions, 100);

    // Also set up resize observer for window resizes
    const resizeObserver = new ResizeObserver(() => {
      measureDimensions();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    window.addEventListener("resize", measureDimensions);

    return () => {
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureDimensions);
    };
  }, [open]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="h-[90vh]"
        onEscapeKeyDown={event => {
          if (timelineOpen && !window.matchMedia("(min-width: 1024px)").matches) {
            event.preventDefault();
            setTimelineOpen(false);
            timelineToggleRef.current?.focus();
          }
        }}
      >
        <VisuallyHidden>
          <DrawerTitle>Session Replay</DrawerTitle>
        </VisuallyHidden>
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="flex justify-end lg:hidden">
            <Button
              ref={timelineToggleRef}
              variant="outline"
              size="sm"
              aria-controls={timelineId}
              aria-expanded={timelineOpen}
              onClick={() => setTimelineOpen(value => !value)}
              onKeyDown={event => {
                // Native button activation must not reach the player's Space hotkey.
                if (event.key !== "Escape") event.stopPropagation();
              }}
            >
              <ListTree className="size-4" />
              {t("Timeline")}
            </Button>
          </div>
          <div className="relative flex min-h-0 flex-1 gap-2">
            {/* Keep the native player mounted and measured beneath the mobile pane. */}
            <div ref={containerRef} className={cn("relative min-w-0 flex-1", timelineOpen && "invisible lg:visible")}>
              {dimensions.width > 0 && dimensions.height > 0 && (
                <ReplayPlayer width={dimensions.width} height={dimensions.height} isDrawer={true} />
              )}
            </div>

            {/* One timeline instance: mobile overlay and desktop sidebar share state/data. */}
            <div
              id={timelineId}
              role="region"
              aria-label={t("Timeline")}
              onKeyDown={event => {
                // Timeline radios and actions own their keys; Escape still returns to replay.
                if (event.key !== "Escape") event.stopPropagation();
              }}
              className={cn(
                "absolute inset-0 min-w-0 bg-background lg:static lg:block lg:w-[300px] lg:shrink-0",
                timelineOpen ? "block" : "hidden"
              )}
            >
              <ReplayBreadcrumbs />
            </div>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
