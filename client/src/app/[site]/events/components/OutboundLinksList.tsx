"use client";

import NumberFlow from "@number-flow/react";
import { Info } from "lucide-react";
import { useExtracted } from "next-intl";
import { memo } from "react";
import { OutboundLink } from "../../../../api/analytics/endpoints";
import { Favicon } from "../../../../components/Favicon";
import { cn, truncateUrl } from "../../../../lib/utils";
import { ScrollArea } from "../../../../components/ui/scroll-area";

const SKELETON_BAR_WIDTHS = [100, 72, 40, 36, 33, 29, 25, 21, 18, 14];
const SKELETON_LABEL_WIDTHS = [238, 204, 172, 184, 136, 160, 112, 148, 96, 124];
const SKELETON_VALUE_WIDTHS = [52, 36, 44, 28, 60, 40, 32, 56, 48, 24];

// Skeleton component for OutboundLinksList
const OutboundLinksListSkeleton = memo(function OutboundLinksListSkeleton({
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
            <div className="flex items-center gap-1">
              <div className="h-4 w-4 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse mr-1"></div>
              <div
                className="h-4 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"
                style={{ width: `${SKELETON_LABEL_WIDTHS[index]}px` }}
              ></div>
            </div>
            <div className={cn("flex gap-2", size === "small" ? "text-xs" : "text-sm")}>
              <div
                className="h-4 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"
                style={{ width: `${SKELETON_VALUE_WIDTHS[index]}px` }}
              ></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

interface OutboundLinksListProps {
  outboundLinks: OutboundLink[];
  isLoading: boolean;
  size?: "small" | "large";
}

export function OutboundLinksList({ outboundLinks, isLoading, size = "small" }: OutboundLinksListProps) {
  const t = useExtracted();

  if (isLoading) {
    return <OutboundLinksListSkeleton size={size} />;
  }

  if (!outboundLinks || outboundLinks.length === 0) {
    return (
      <div className="text-neutral-500 dark:text-neutral-300 w-full text-center mt-6 flex flex-row gap-2 items-center justify-center">
        <Info className="w-5 h-5" />
        {t("No Data")}
      </div>
    );
  }

  // Find the total count to calculate percentages
  const totalCount = outboundLinks.reduce((sum, link) => sum + link.count, 0);
  const maxCount = Math.max(...outboundLinks.map(link => link.count));

  return (
    /* [&>div]:!block forces Radix's display:table viewport wrapper to block so url truncate is bounded */
    <ScrollArea className="h-[394px]" viewportClassName="[&>div]:!block">
      <div className="flex flex-col gap-2 pr-2 overflow-x-hidden">
        {outboundLinks.map((link, index) => {
          const percentageOfMax = (link.count / maxCount) * 100;
          const percentage = (link.count / totalCount) * 100;
          return (
            <div
              key={`${link.url}-${index}`}
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
                <div className="font-medium truncate max-w-[70%] flex items-center gap-1">
                  <Favicon domain={new URL(link.url).hostname} className="w-4 mr-1" />
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-neutral-900 dark:text-neutral-100 hover:underline truncate"
                    title={link.url}
                  >
                    {truncateUrl(link.url)}
                  </a>
                </div>
                <div className={cn("text-sm flex gap-2 items-center", size === "small" ? "text-xs" : "text-sm")}>
                  <div className="hidden group-hover:block text-neutral-600 dark:text-neutral-400 text-xs">
                    {Math.round(percentage * 10) / 10}%
                  </div>
                  {/* <div className="hidden group-hover:block text-neutral-600 dark:text-neutral-400 text-xs">
                    {lastClicked.toRelative()}
                  </div> */}
                  <NumberFlow value={link.count} format={{ notation: "compact" }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
