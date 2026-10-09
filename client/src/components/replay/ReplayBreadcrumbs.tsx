import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowRight,
  Brush,
  Camera,
  Eye,
  FileCode,
  FileEdit,
  FileText,
  Flag,
  Globe,
  Keyboard,
  Maximize2,
  Mouse,
  MousePointer,
  MousePointer2,
  MousePointerClick,
  Move,
  PaintBucket,
  Palette,
  Play,
  Puzzle,
  ScrollText,
  Smartphone,
  Sparkles,
  Terminal,
  TextSelect,
  Type,
} from "lucide-react";
import { DateTime, Duration } from "luxon";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { useParams } from "next/navigation";
import { createElement, type UIEvent, useCallback, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useGetSessionReplayEvents } from "@/api/analytics/hooks/sessionReplay/useGetSessionReplayEvents";
import { Avatar } from "@/components/Avatar";
import { IdentifiedBadge } from "@/components/IdentifiedBadge";
import { SegmentedControl } from "@/components/interior/segmented-control";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ThreeDotLoader } from "@/components/Loaders";
import { getTimezone } from "@/lib/store";
import { getUserAvatarUrl, getUserDisplayName } from "@/lib/userIdentity";
import { cn } from "@/lib/utils";
import { NetworkTimeline } from "./network/NetworkTimeline";
import { NetworkRequestDetails } from "./network/NetworkRequestDetails";
import { NetworkRequestRow } from "./network/NetworkRequestRow";
import { parseNetworkReplayEvents } from "./network/parseNetworkEvents";
import type { ParsedNetworkRequest } from "./network/types";
import {
  getMeaningfulEvents,
  getTechnicalGroups,
  type EventSeverity,
  type MeaningfulEvent,
  type MeaningfulKind,
  type TechnicalGroup,
} from "./replayEvents";
import { useReplayStore } from "./replayStore";
import { useReplaySeek } from "./player/hooks/useReplaySeek";
import { CurrentTimeMarker, CurrentTimeMarkerRow } from "./timeline/CurrentTimeMarker";
import {
  buildAllTimelineRows,
  buildMeaningfulTimelineRows,
  compareTimelineRows,
  insertCurrentTimeMarker,
  type ReplayTimelineDataRow,
} from "./timeline/replayTimeline";
import { TimelineFollowButton } from "./timeline/TimelineFollowButton";
import { useFollowTimelineMarker } from "./timeline/useFollowTimelineMarker";
import { useReplayTimelineHighlights } from "./timeline/useReplayTimelineHighlights";

type TimelineView = "key" | "network" | "all";

interface SelectedNetworkRequest {
  sessionId: string;
  requestId: string;
}

interface TimelineScrollPositions {
  resetKey: string;
  values: Record<TimelineView, number>;
}

const SEVERITY_COLOR: Record<EventSeverity, string> = {
  default: "text-neutral-500 dark:text-neutral-400",
  info: "text-blue-500 dark:text-blue-400",
  warn: "text-yellow-600 dark:text-yellow-400",
  error: "text-red-500 dark:text-red-400",
};

// Distinct color per event kind so the timeline is scannable at a glance.
const KIND_COLOR: Record<MeaningfulKind, string> = {
  "session-start": "text-emerald-500 dark:text-emerald-400",
  navigation: "text-blue-500 dark:text-blue-400",
  click: "text-violet-500 dark:text-violet-400",
  dblclick: "text-violet-500 dark:text-violet-400",
  rightclick: "text-fuchsia-500 dark:text-fuchsia-400",
  rageclick: "text-red-500 dark:text-red-400",
  input: "text-amber-500 dark:text-amber-400",
  resize: "text-cyan-500 dark:text-cyan-400",
  console: "text-blue-500 dark:text-blue-400",
};

function meaningfulColor(event: MeaningfulEvent): string {
  // Console color follows severity (error/warn/log); everything else by kind.
  return event.kind === "console" ? SEVERITY_COLOR[event.severity] : KIND_COLOR[event.kind];
}

// Technical (raw rrweb) colors. The noisy majority (mutations, mouse moves) stay
// muted; the events a developer actually scans for get color.
const TECH_SOURCE_COLOR: Record<number, string> = {
  0: "text-neutral-500 dark:text-neutral-400", // Mutation
  1: "text-neutral-500 dark:text-neutral-400", // Mouse Move
  2: "text-violet-500 dark:text-violet-400", // Mouse Interaction
  3: "text-sky-500 dark:text-sky-400", // Scroll
  4: "text-cyan-500 dark:text-cyan-400", // Viewport Resize
  5: "text-amber-500 dark:text-amber-400", // Input
  11: "text-blue-500 dark:text-blue-400", // Log
};
const TECH_TYPE_COLOR: Record<number, string> = {
  0: "text-blue-500 dark:text-blue-400", // DOMContentLoaded
  1: "text-emerald-500 dark:text-emerald-400", // Load
  2: "text-fuchsia-500 dark:text-fuchsia-400", // Full Snapshot
  4: "text-cyan-500 dark:text-cyan-400", // Meta
  5: "text-pink-500 dark:text-pink-400", // Custom
  6: "text-indigo-500 dark:text-indigo-400", // Plugin
};

function technicalColor(group: TechnicalGroup): string {
  if (group.type === 3 && group.source !== undefined) {
    return TECH_SOURCE_COLOR[group.source] ?? "text-neutral-500 dark:text-neutral-400";
  }
  return TECH_TYPE_COLOR[group.type] ?? "text-neutral-500 dark:text-neutral-400";
}

function meaningfulIcon(kind: MeaningfulKind, severity: EventSeverity) {
  switch (kind) {
    case "session-start":
      return Flag;
    case "navigation":
      return ArrowRight;
    case "click":
      return MousePointerClick;
    case "dblclick":
      return MousePointerClick;
    case "rightclick":
      return MousePointer2;
    case "rageclick":
      return MousePointerClick;
    case "input":
      return Keyboard;
    case "resize":
      return Maximize2;
    case "console":
      return severity === "error" ? AlertTriangle : Terminal;
    default:
      return Globe;
  }
}

// Technical (raw rrweb) icon selection, keyed by incremental source / event type.
const INCREMENTAL_ICONS: Record<number, typeof Globe> = {
  0: FileEdit,
  1: Mouse,
  2: MousePointerClick,
  3: ScrollText,
  4: Maximize2,
  5: Keyboard,
  6: Smartphone,
  7: Play,
  8: Palette,
  9: Brush,
  10: Type,
  11: Terminal,
  12: Move,
  13: PaintBucket,
  14: TextSelect,
  15: FileCode,
};
const TYPE_ICONS: Record<number, typeof Globe> = {
  0: FileText,
  2: Camera,
  4: Eye,
  5: Sparkles,
  6: Puzzle,
};

function technicalIcon(group: TechnicalGroup) {
  if (group.type === 3 && group.source !== undefined) return INCREMENTAL_ICONS[group.source] ?? MousePointer;
  return TYPE_ICONS[group.type] ?? Globe;
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 h-full min-h-0">{children}</div>;
}

export function ReplayBreadcrumbs() {
  const t = useExtracted();
  const params = useParams();
  const siteId = Number(params.site);
  const [timelineView, setTimelineView] = useState<TimelineView>("network");
  const [followCurrentTime, setFollowCurrentTime] = useState(true);
  const [selectedNetworkRequest, setSelectedNetworkRequest] = useState<SelectedNetworkRequest | null>(null);
  const { sessionId, selectionVersion } = useReplayStore(
    useShallow(s => ({
      sessionId: s.sessionId,
      selectionVersion: s.selectionVersion,
    }))
  );
  const { seekTo } = useReplaySeek();

  const { data, isLoading, error } = useGetSessionReplayEvents(siteId, sessionId);

  const meaningful = useMemo(() => getMeaningfulEvents(data?.events), [data?.events]);
  const technical = useMemo(() => getTechnicalGroups(data?.events), [data?.events]);
  const parsedNetworkEvents = useMemo(() => parseNetworkReplayEvents(data?.events), [data?.events]);
  const networkRequests = parsedNetworkEvents.requests;
  const meaningfulRows = useMemo(() => buildMeaningfulTimelineRows(meaningful), [meaningful]);
  const allRows = useMemo(
    () => buildAllTimelineRows(technical, networkRequests, parsedNetworkEvents.expandedEventIndexes),
    [networkRequests, parsedNetworkEvents.expandedEventIndexes, technical]
  );
  const highlightRows = useMemo(() => {
    const rowsByKey = new Map<string, ReplayTimelineDataRow>();
    for (const row of [...meaningfulRows, ...allRows]) rowsByKey.set(row.key, row);
    return [...rowsByKey.values()].sort(compareTimelineRows);
  }, [allRows, meaningfulRows]);
  const timelineResetKey = `${sessionId}:${selectionVersion}`;
  const { currentTime, highlightedKeys } = useReplayTimelineHighlights(highlightRows, timelineResetKey);
  const scrollPositionsRef = useRef<TimelineScrollPositions>({
    resetKey: timelineResetKey,
    values: { all: 0, key: 0, network: 0 },
  });

  const handleSeek = useCallback(
    (offset: number) => {
      seekTo(offset);
    },
    [seekTo]
  );
  const handleFollowCurrentTimeToggle = useCallback(() => setFollowCurrentTime(value => !value), []);
  const handleTimelineViewChange = useCallback((view: TimelineView) => {
    setTimelineView(view);
    setSelectedNetworkRequest(null);
  }, []);
  const handleNetworkRequestSelect = useCallback(
    (request: ParsedNetworkRequest) => {
      handleSeek(request.startOffset);
      setSelectedNetworkRequest({ sessionId, requestId: request.requestId });
    },
    [handleSeek, sessionId]
  );
  const handleNetworkDetailsBack = useCallback(() => setSelectedNetworkRequest(null), []);
  const selectedRequest = useMemo(
    () =>
      selectedNetworkRequest?.sessionId === sessionId
        ? networkRequests.find(request => request.requestId === selectedNetworkRequest.requestId)
        : undefined,
    [networkRequests, selectedNetworkRequest, sessionId]
  );
  const getScrollOffset = useCallback(
    (view: TimelineView) =>
      scrollPositionsRef.current.resetKey === timelineResetKey ? scrollPositionsRef.current.values[view] : 0,
    [timelineResetKey]
  );
  const saveScrollOffset = useCallback(
    (view: TimelineView, offset: number) => {
      if (scrollPositionsRef.current.resetKey !== timelineResetKey) {
        scrollPositionsRef.current = {
          resetKey: timelineResetKey,
          values: { all: 0, key: 0, network: 0 },
        };
      }
      scrollPositionsRef.current.values[view] = offset;
    },
    [timelineResetKey]
  );
  const handleNetworkScrollOffsetChange = useCallback(
    (offset: number) => saveScrollOffset("network", offset),
    [saveScrollOffset]
  );

  // Resolve labels here, where `t` is the real useExtracted() binding, so the
  // strings are picked up by the message extractor (a `t` passed as a prop is not).
  const labelFor = (event: MeaningfulEvent): string => {
    switch (event.kind) {
      case "session-start":
        return t("Session started");
      case "navigation":
        return t("Navigated");
      case "click":
        return t("Clicked");
      case "dblclick":
        return t("Double-clicked");
      case "rightclick":
        return t("Right-clicked");
      case "rageclick":
        return t("Rage click");
      case "input":
        return t("Typed in a field");
      case "resize":
        return t("Resized window");
      case "console":
        return event.severity === "error"
          ? t("Console error")
          : event.severity === "warn"
            ? t("Console warning")
            : t("Console log");
      default:
        return t("Event");
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleRows = useMemo<ReplayTimelineDataRow[]>(
    () => (timelineView === "all" ? allRows : timelineView === "key" ? meaningfulRows : []),
    [allRows, meaningfulRows, timelineView]
  );
  const timeline = useMemo(() => insertCurrentTimeMarker(visibleRows, currentTime), [currentTime, visibleRows]);
  const virtualizer = useVirtualizer({
    count: timeline.rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: index => timeline.rows[index]?.key ?? index,
    estimateSize: index => {
      const row = timeline.rows[index];
      if (row?.kind === "current-time-marker") return 29;
      if (row?.kind === "network") return 52;
      return 44;
    },
    overscan: 16,
  });
  const scrollToMarker = useCallback(
    () => virtualizer.scrollToIndex(timeline.markerIndex, { align: "center" }),
    [timeline.markerIndex, virtualizer]
  );
  const initialSimpleScrollOffset = getScrollOffset(timelineView);
  const setSimpleScrollElement = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (node) node.scrollTop = initialSimpleScrollOffset;
    },
    [initialSimpleScrollOffset]
  );
  const handleSimpleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => saveScrollOffset(timelineView, event.currentTarget.scrollTop),
    [saveScrollOffset, timelineView]
  );
  useFollowTimelineMarker({
    enabled: followCurrentTime && timelineView !== "network" && !selectedRequest && visibleRows.length > 0,
    markerIndex: timeline.markerIndex,
    resetKey: `${timelineResetKey}:${timelineView}`,
    scrollToMarker,
  });
  const currentTimeLabel = t("Current time {time}", {
    time: Duration.fromMillis(currentTime).toFormat("mm:ss.SSS"),
  });

  if (error) {
    return (
      <PanelShell>
        <div className="flex flex-1 items-center justify-center rounded-lg border border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 text-center text-xs text-red-500">
          {t("Couldn't load this session's events.")}
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      {/* User header */}
      <div className="rounded-lg border border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex items-center justify-between gap-2 p-2 text-xs text-neutral-900 dark:text-neutral-200 shrink-0">
        {isLoading || !data ? (
          <>
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-6 rounded-full" />
              <Skeleton className="h-3.5 w-24" />
            </div>
            <Skeleton className="h-7 w-20" />
          </>
        ) : (
          <UserHeader data={data} siteId={siteId} />
        )}
      </div>

      {/* Timeline */}
      <div className="rounded-lg border border-neutral-100 dark:border-neutral-800 flex flex-col flex-1 min-h-0 bg-white dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-2 p-2 border-b border-neutral-100 dark:border-neutral-800 shrink-0">
          <div className="text-xs text-neutral-600 dark:text-neutral-400 truncate">
            {isLoading || !data
              ? t("Timeline")
              : timelineView === "all"
                ? t("{count} events", { count: String(allRows.length) })
                : timelineView === "network"
                  ? t("{count} network requests", { count: String(networkRequests.length) })
                  : t("{count} key events", { count: String(meaningful.length) })}
          </div>
          <SegmentedControl
            aria-label={t("Event detail level")}
            size="sm"
            className="shrink-0"
            options={[
              { value: "network", label: t("Network") },
              { value: "key", label: t("Key") },
              { value: "all", label: t("All") },
            ]}
            value={timelineView}
            onValueChange={handleTimelineViewChange}
          />
        </div>

        {isLoading || !data ? (
          <div className="flex flex-1 items-center justify-center">
            <ThreeDotLoader />
          </div>
        ) : timelineView === "network" ? (
          <NetworkTimeline
            key={sessionId}
            requests={networkRequests}
            currentTime={currentTime}
            followCurrentTime={followCurrentTime}
            highlightedKeys={highlightedKeys}
            initialScrollOffset={getScrollOffset("network")}
            resetKey={timelineResetKey}
            selectedRequest={selectedRequest}
            onDetailsBack={handleNetworkDetailsBack}
            onFollowCurrentTimeToggle={handleFollowCurrentTimeToggle}
            onRequestSelect={handleNetworkRequestSelect}
            onScrollOffsetChange={handleNetworkScrollOffsetChange}
          />
        ) : selectedRequest ? (
          <NetworkRequestDetails request={selectedRequest} onBack={handleNetworkDetailsBack} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 justify-end border-b border-neutral-100 p-2 dark:border-neutral-800">
              <TimelineFollowButton enabled={followCurrentTime} onToggle={handleFollowCurrentTimeToggle} />
            </div>
            {visibleRows.length === 0 ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <CurrentTimeMarker label={currentTimeLabel} />
                <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-neutral-500">
                  {timelineView === "all" ? t("No events recorded.") : t("No key interactions in this session.")}
                </div>
              </div>
            ) : (
              <div
                ref={setSimpleScrollElement}
                className="flex-1 overflow-auto rounded-b-lg"
                onScroll={handleSimpleScroll}
              >
                <div className="relative" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                  {virtualizer.getVirtualItems().map(virtualRow => {
                    const row = timeline.rows[virtualRow.index];
                    if (row.kind === "current-time-marker") {
                      return (
                        <CurrentTimeMarkerRow
                          key={row.key}
                          virtualRow={virtualRow}
                          measure={virtualizer.measureElement}
                          label={currentTimeLabel}
                        />
                      );
                    }

                    if (row.kind === "technical") {
                      return (
                        <TechnicalRow
                          key={row.key}
                          group={row.group}
                          isHighlighted={highlightedKeys.has(row.key)}
                          virtualRow={virtualRow}
                          measure={virtualizer.measureElement}
                          onSeek={handleSeek}
                        />
                      );
                    }

                    if (row.kind === "network") {
                      return (
                        <NetworkRequestRow
                          key={row.key}
                          request={row.request}
                          isHighlighted={highlightedKeys.has(row.key)}
                          virtualRow={virtualRow}
                          measure={virtualizer.measureElement}
                          onSelect={handleNetworkRequestSelect}
                        />
                      );
                    }

                    return (
                      <MeaningfulRow
                        key={row.key}
                        event={row.event}
                        label={labelFor(row.event)}
                        isHighlighted={highlightedKeys.has(row.key)}
                        virtualRow={virtualRow}
                        measure={virtualizer.measureElement}
                        onSeek={handleSeek}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </PanelShell>
  );
}

function UserHeader({ data, siteId }: { data: any; siteId: number }) {
  const t = useExtracted();
  const isIdentified = !!data.metadata.identified_user_id;
  const userLink = isIdentified
    ? `/${siteId}/user/${encodeURIComponent(data.metadata.identified_user_id)}`
    : `/${siteId}/user/${encodeURIComponent(data.metadata.user_id)}`;

  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <Avatar
          id={data.metadata.user_id}
          size={24}
          imageUrl={getUserAvatarUrl(data.metadata)}
          alt={getUserDisplayName(data.metadata)}
          lastActiveTime={
            data.metadata.end_time
              ? DateTime.fromSQL(data.metadata.end_time, { zone: "utc" }).setZone(getTimezone())
              : undefined
          }
        />
        <span className="truncate">{getUserDisplayName(data.metadata)}</span>
        {isIdentified && <IdentifiedBadge traits={data.metadata.traits} userId={data.metadata.identified_user_id} />}
      </div>
      <Link href={userLink} className="shrink-0">
        <Button size="sm">{t("View User")}</Button>
      </Link>
    </>
  );
}

function rowClass(isHighlighted: boolean, extra?: string) {
  return cn(
    "absolute left-0 right-0 flex w-full items-center gap-2.5 border-b border-neutral-100 px-2.5 text-left dark:border-neutral-800",
    "cursor-pointer transition-colors hover:bg-neutral-50 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-950 dark:hover:bg-neutral-800/60 dark:focus-visible:ring-neutral-300",
    isHighlighted &&
      "bg-accent-500/10 ring-1 ring-inset ring-accent-500/40 dark:bg-accent-500/10 dark:ring-accent-400/40",
    extra
  );
}

function MeaningfulRow({
  event,
  label,
  isHighlighted,
  virtualRow,
  measure,
  onSeek,
}: {
  event: MeaningfulEvent;
  label: string;
  isHighlighted: boolean;
  virtualRow: VirtualItem;
  measure: (node: Element | null) => void;
  onSeek: (offset: number) => void;
}) {
  const Icon = meaningfulIcon(event.kind, event.severity);
  const color = meaningfulColor(event);

  return (
    <button
      type="button"
      data-index={virtualRow.index}
      ref={measure}
      className={rowClass(isHighlighted, "py-2")}
      style={{ top: `${virtualRow.start}px` }}
      onClick={() => onSeek(event.offset)}
      aria-current={isHighlighted ? "time" : undefined}
    >
      <span className="w-9 shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
        {Duration.fromMillis(event.offset).toFormat("mm:ss")}
      </span>
      {createElement(Icon, { className: cn("h-4 w-4 shrink-0", color) })}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-neutral-900 dark:text-neutral-200">{label}</span>
          {event.count > 1 && (
            <span className="shrink-0 text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
              ×{event.count}
            </span>
          )}
        </div>
        {event.detail && (
          <div className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">{event.detail}</div>
        )}
      </div>
    </button>
  );
}

function TechnicalRow({
  group,
  isHighlighted,
  virtualRow,
  measure,
  onSeek,
}: {
  group: TechnicalGroup;
  isHighlighted: boolean;
  virtualRow: VirtualItem;
  measure: (node: Element | null) => void;
  onSeek: (offset: number) => void;
}) {
  const Icon = technicalIcon(group);
  const color = technicalColor(group);
  const durationMs = group.endOffset - group.offset;

  return (
    <button
      type="button"
      data-index={virtualRow.index}
      ref={measure}
      className={rowClass(isHighlighted, "py-2")}
      style={{ top: `${virtualRow.start}px` }}
      onClick={() => onSeek(group.offset)}
      aria-current={isHighlighted ? "time" : undefined}
    >
      <span className="w-9 shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
        {Duration.fromMillis(group.offset).toFormat("mm:ss")}
      </span>
      {createElement(Icon, { className: cn("h-4 w-4 shrink-0", color) })}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-neutral-900 dark:text-neutral-200">{group.label}</div>
        {group.count > 1 && durationMs > 0 && (
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {Duration.fromMillis(durationMs).toFormat("s.SSS")}s
          </div>
        )}
      </div>
      {group.count > 1 && (
        <span className="shrink-0 rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-600 dark:text-neutral-400">
          {group.count}
        </span>
      )}
    </button>
  );
}
