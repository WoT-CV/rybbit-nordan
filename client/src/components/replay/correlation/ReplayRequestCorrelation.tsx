"use client";

import { ListFilter } from "lucide-react";
import { useExtracted } from "next-intl";
import { memo, useMemo, useState } from "react";
import type { RequestCorrelationEvent } from "@rybbit/shared";
import { useReplayCorrelation } from "@/api/admin/hooks/useReplayCorrelation";
import type { SessionReplayEvent } from "@/api/analytics/endpoints/sessionReplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useReplayStore } from "../replayStore";
import { getRequestObservabilityLinks } from "./observabilityLinks";
import { getRequestCorrelationRows, requestStartTime } from "./requestRows";

interface Props {
  siteId: number;
  sessionId: string;
  events: readonly SessionReplayEvent[];
}

// Only event/configuration changes render this panel; playback's clock stays in the native player.
export const ReplayRequestCorrelation = memo(function ReplayRequestCorrelation({ siteId, sessionId, events }: Props) {
  const t = useExtracted();
  const [open, setOpen] = useState(false);
  const { authorized, config, isLoading, isError, refetch } = useReplayCorrelation(siteId, open);
  const player = useReplayStore(state => state.player);
  const rows = useMemo(() => getRequestCorrelationRows(events), [events]);
  const firstTimestamp = events[0]?.timestamp ?? 0;

  const seek = (row: RequestCorrelationEvent) => {
    const state = useReplayStore.getState();
    if (state.sessionId !== sessionId || !state.player || !Number.isFinite(firstTimestamp)) return;
    const offset = Math.max(0, Math.min(state.duration, requestStartTime(row) - firstTimestamp));
    state.player.pause();
    state.setIsPlaying(false);
    state.player.goto(offset);
    state.setCurrentTime(offset);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("Requests")}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <ListFilter data-icon="inline-start" />
          <span className="hidden sm:inline">{t("Requests")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[85dvh] max-w-5xl overflow-y-auto"
        data-vaul-no-drag
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
        onEscapeKeyDown={e => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{t("Requests")}</DialogTitle>
          <DialogDescription>
            {t(
              "Only allowed API requests captured in this recording are listed. No request bodies or header maps are stored. Grafana retention and trace sampling are independent."
            )}
          </DialogDescription>
        </DialogHeader>
        {!authorized ? (
          <p className="text-sm text-muted-foreground">{t("Sign in with replay access to view correlation links.")}</p>
        ) : isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("Loading...")}
          </p>
        ) : isError ? (
          <div className="flex items-center gap-2" role="alert">
            <p className="text-sm">{t("Unable to load Grafana configuration.")}</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t("Retry")}
            </Button>
          </div>
        ) : !config?.enabled ? (
          <p className="text-sm text-muted-foreground">{t("Grafana correlation is not configured for this site.")}</p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("No request correlation data in this recording. Older recordings may not contain it.")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Start")}</TableHead>
                <TableHead>{t("Endpoint")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead>{t("Duration")}</TableHead>
                <TableHead>{t("Actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => {
                const { request } = row;
                const offset = Math.max(0, requestStartTime(row) - firstTimestamp);
                const links =
                  authorized && config?.enabled ? getRequestObservabilityLinks(row, config.profiles) : undefined;
                return (
                  <TableRow key={request.rowId}>
                    <TableCell className="whitespace-nowrap">
                      {Math.floor(offset / 60000)}:{String(Math.floor(offset / 1000) % 60).padStart(2, "0")}
                    </TableCell>
                    <TableCell className="max-w-sm break-all">
                      <span className="font-medium">{request.method}</span> {request.origin}
                      {request.pathname}
                      {request.correlationId && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t("Correlation ID")}: <code className="select-all">{request.correlationId}</code>
                        </div>
                      )}
                      {request.traceId && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t("Trace ID")}: <code className="select-all">{request.traceId}</code>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {request.outcome === "response"
                        ? request.status
                        : request.outcome === "abort"
                          ? t("Aborted")
                          : request.outcome === "timeout"
                            ? t("Timed out")
                            : t("Network error")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{Math.round(request.durationMs)} ms</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" disabled={!player} onClick={() => seek(row)}>
                          {t("Go to request")}
                        </Button>
                        {links?.logs && (
                          <Button asChild size="sm" variant="outline">
                            <a href={links.logs} target="_blank" rel="noopener noreferrer">
                              {t("Logs in Grafana")}
                            </a>
                          </Button>
                        )}
                        {links?.trace && (
                          <Button asChild size="sm" variant="outline">
                            <a href={links.trace} target="_blank" rel="noopener noreferrer">
                              {t("Trace in Grafana")}
                            </a>
                          </Button>
                        )}
                        {!request.correlationId && !request.traceId ? (
                          <span className="text-xs text-muted-foreground">{t("No correlation ID available.")}</span>
                        ) : config?.enabled && !links ? (
                          <span className="text-xs text-muted-foreground">
                            {t("No matching origin configuration.")}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
});
