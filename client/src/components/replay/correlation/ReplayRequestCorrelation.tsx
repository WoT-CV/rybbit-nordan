"use client";

import type { RequestCorrelationEvent } from "@rybbit/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { memo, useId } from "react";
import type { useReplayCorrelation } from "@/api/admin/hooks/useReplayCorrelation";
import { Button } from "@/components/ui/button";
import { formatTime } from "../player/utils/replayUtils";
import { useReplayStore } from "../replayStore";
import { getRequestObservabilityLinks } from "./observabilityLinks";
import { requestStartTime } from "./requestRows";

interface Props {
  siteId: number;
  sessionId: string;
  event: RequestCorrelationEvent;
  firstTimestamp: number;
  expanded: boolean;
  onExpandedChange: () => void;
  correlation: ReturnType<typeof useReplayCorrelation>;
}

// The timeline fetches configuration once, only while a request is expanded.
// Read the live player on seek without subscribing every row to the playback clock.
export const ReplayRequestCorrelation = memo(function ReplayRequestCorrelation({
  siteId,
  sessionId,
  event,
  firstTimestamp,
  expanded,
  onExpandedChange,
  correlation,
}: Props) {
  const detailsId = useId();
  const canSeek = useReplayStore(state => state.sessionId === sessionId && !!state.player);
  const { authorized, config, isLoading, isError, refetch } = correlation;
  const { request } = event;
  const offset = Math.max(0, requestStartTime(event) - firstTimestamp);
  const links =
    expanded && authorized && !isLoading && !isError && config?.enabled && Number.isSafeInteger(siteId) && siteId > 0
      ? getRequestObservabilityLinks(event, config.profiles)
      : undefined;
  const status =
    request.outcome === "response"
      ? request.status
      : request.outcome === "abort"
        ? "Aborted"
        : request.outcome === "timeout"
          ? "Timed out"
          : "Network error";
  const failed = request.outcome !== "response" || request.status >= 400;

  const seek = () => {
    const state = useReplayStore.getState();
    if (
      state.sessionId !== sessionId ||
      !state.player ||
      !Number.isFinite(firstTimestamp) ||
      !Number.isFinite(offset) ||
      !Number.isFinite(state.duration)
    )
      return;
    const position = Math.max(0, Math.min(state.duration, offset));
    state.player.pause();
    state.setIsPlaying(false);
    state.player.goto(position);
    state.setCurrentTime(position);
  };

  return (
    <div
      className="min-w-0 border-b border-neutral-100 dark:border-neutral-800"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        // Escape belongs to the containing replay drawer.
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <button
        type="button"
        aria-label={`Requests: ${request.method} ${request.pathname}`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={onExpandedChange}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-950 dark:hover:bg-neutral-850 dark:focus-visible:ring-neutral-300"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
            <span className="shrink-0 font-medium">{request.method}</span>
            <span className="min-w-0 truncate" title={`${request.origin}${request.pathname}`}>
              {request.pathname}
            </span>
          </span>
          <span className="flex gap-x-2 text-[11px] leading-4 text-muted-foreground">
            <span className={failed ? "text-red-600 dark:text-red-400" : undefined}>
              <span className="sr-only">Status: </span>
              {status}
            </span>
            <span>
              <span className="sr-only">Duration: </span>
              {Math.round(request.durationMs)} ms
            </span>
          </span>
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatTime(offset)}</span>
        {expanded ? (
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded ? (
        <div id={detailsId} className="min-w-0 space-y-1.5 px-2.5 pb-2 text-xs">
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
            {request.correlationId ? (
              <>
                <dt className="text-muted-foreground">correlationId</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]">
                  <code className="select-all font-sans">{request.correlationId}</code>
                </dd>
              </>
            ) : null}
            {request.traceId ? (
              <>
                <dt className="text-muted-foreground">traceId</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]">
                  <code className="select-all font-sans">{request.traceId}</code>
                </dd>
              </>
            ) : null}
          </dl>
          {!authorized ? (
            <p className="text-muted-foreground">Sign in with replay access to view correlation links.</p>
          ) : isLoading ? (
            <p role="status" className="text-muted-foreground">
              Loading...
            </p>
          ) : isError ? (
            <div className="space-y-2" role="alert">
              <p>Unable to load Grafana configuration.</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          ) : !config?.enabled ? (
            <p className="text-muted-foreground">Grafana correlation is not configured for this site.</p>
          ) : !links && (request.correlationId || request.traceId) ? (
            <p className="text-muted-foreground">No matching origin configuration.</p>
          ) : null}
          {!request.correlationId && !request.traceId ? (
            <p className="text-muted-foreground">No correlation ID available.</p>
          ) : null}
          <div className="flex min-w-0 flex-wrap gap-1">
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-label="Go to request"
              title="Go to request"
              disabled={!canSeek}
              onClick={seek}
            >
              Seek
            </Button>
            {links?.logs ? (
              <Button asChild size="xs" variant="outline">
                <a
                  href={links.logs}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Logs in Grafana"
                  title="Logs in Grafana"
                >
                  Logs
                </a>
              </Button>
            ) : null}
            {links?.trace ? (
              <Button asChild size="xs" variant="outline">
                <a
                  href={links.trace}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Trace in Grafana"
                  title="Trace in Grafana"
                >
                  Trace
                </a>
              </Button>
            ) : null}
          </div>
          {links?.logs || links?.trace ? (
            <p
              className="text-[11px] leading-4 text-muted-foreground"
              title="Grafana links use the recording clock. If results are missing, verify the time range in Grafana."
            >
              Recording time; verify Grafana range.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
