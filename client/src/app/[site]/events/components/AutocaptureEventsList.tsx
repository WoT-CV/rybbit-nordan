"use client";

import NumberFlow from "@number-flow/react";
import { Info } from "lucide-react";
import { useExtracted } from "next-intl";
import { memo } from "react";
import { AutocaptureEvent } from "../../../../api/analytics/endpoints";
import { ScrollArea } from "../../../../components/ui/scroll-area";
import { cn, truncateString } from "../../../../lib/utils";

const SKELETON_BAR_WIDTHS = [100, 72, 40, 36, 33, 29, 25, 21, 18, 14];
const SKELETON_LABEL_WIDTHS = [238, 204, 172, 184, 136, 160, 112, 148, 96, 124];
const SKELETON_VALUE_WIDTHS = [52, 36, 44, 28, 60, 40, 32, 56, 48, 24];

// Skeleton component for AutocaptureEventsList
const AutocaptureEventsListSkeleton = memo(function AutocaptureEventsListSkeleton({
  size = "small",
}: {
  size?: "small" | "large";
}) {
  return (
    <div className="flex flex-col gap-2 pr-2">
      {Array.from({ length: 10 }).map((_, index) => (
        <div key={index} className={cn("relative flex items-center", size === "small" ? "h-6" : "h-9")}>
          <div
            className="absolute inset-0 bg-neutral-150/50 dark:bg-neutral-800 py-2 rounded-md animate-pulse"
            style={{ width: `${SKELETON_BAR_WIDTHS[index]}%` }}
          ></div>
          <div
            className={cn(
              "z-5 mx-2 flex justify-between items-center w-full",
              size === "small" ? "text-xs" : "text-sm"
            )}
          >
            <div
              className="h-4 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"
              style={{ width: `${SKELETON_LABEL_WIDTHS[index]}px` }}
            ></div>
            <div
              className="h-4 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"
              style={{ width: `${SKELETON_VALUE_WIDTHS[index]}px` }}
            ></div>
          </div>
        </div>
      ))}
    </div>
  );
});

interface AutocaptureEventsListProps {
  events: AutocaptureEvent[];
  isLoading: boolean;
  size?: "small" | "large";
}

export function AutocaptureEventsList({ events, isLoading, size = "small" }: AutocaptureEventsListProps) {
  const t = useExtracted();

  if (isLoading) {
    return <AutocaptureEventsListSkeleton size={size} />;
  }

  if (!events || events.length === 0) {
    return (
      <div className="text-neutral-500 dark:text-neutral-300 w-full text-center mt-6 flex flex-row gap-2 items-center justify-center">
        <Info className="w-5 h-5" />
        {t("No Data")}
      </div>
    );
  }

  const totalCount = events.reduce((sum, event) => sum + event.count, 0);
  const maxCount = Math.max(...events.map(event => event.count));

  return (
    /* [&>div]:!block forces Radix's display:table viewport wrapper to block so value truncate is bounded */
    <ScrollArea className="h-[394px]" viewportClassName="[&>div]:!block">
      <div className="flex flex-col gap-2 pr-2 overflow-x-hidden">
        {events.map((event, index) => {
          const percentageOfMax = (event.count / maxCount) * 100;
          const percentage = (event.count / totalCount) * 100;

          return (
            <div
              key={`${event.value}-${index}`}
              className={cn(
                "relative flex items-center hover:bg-neutral-100 dark:hover:bg-neutral-850 group px-2 rounded-md",
                size === "small" ? "h-6" : "h-9"
              )}
            >
              <div
                className="absolute inset-0 bg-dataviz py-2 opacity-25 rounded-md"
                style={{ width: `${percentageOfMax}%` }}
              ></div>
              <div
                className={cn(
                  "z-10 flex justify-between items-center w-full",
                  size === "small" ? "text-xs" : "text-sm"
                )}
              >
                <div
                  className="font-medium truncate max-w-[70%] text-neutral-900 dark:text-neutral-100"
                  title={event.value}
                >
                  {truncateString(event.value, 100)}
                </div>
                <div className={cn("text-sm flex gap-2 items-center", size === "small" ? "text-xs" : "text-sm")}>
                  <div className="hidden group-hover:block text-neutral-600 dark:text-neutral-400 text-xs">
                    {Math.round(percentage * 10) / 10}%
                  </div>
                  <NumberFlow value={event.count} format={{ notation: "compact" }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
