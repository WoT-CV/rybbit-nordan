import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { calculateReplayActivityWindows, REPLAY_EXPORT_NETWORK_HOST } from "@rybbit/shared";
import JSZip from "jszip";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createServiceLogger } from "../../../lib/logger/logger.js";
import { SessionReplayQueryService } from "../sessionReplayQueryService.js";
import { createReplayExportPage } from "./replayExportPage.js";
import type { ReplayExportJobData, ReplayExportResult } from "./replayExportTypes.js";
import { validateReplayExportActivityDuration } from "./replayExportTiming.js";

const SENSITIVE_NAME_PATTERN = /(authorization|cookie|token|secret|password|api[-_]?key|credential)/i;
const NETWORK_PLUGIN_NAME = "rrweb/network@1";
const EXPORT_FILE_NAMES = {
  video: "powtorka.webm",
  metadata: "metadane.json",
  networkLog: "logi-sieciowe-api.wot-cv.com.txt",
} as const;

interface ExportNetworkRequest {
  requestId: string;
  currentUrl: string;
  url: string;
  method: string;
  initiatorType: string;
  startedAt: number;
  completedAt?: number;
  durationMs: number;
  status?: number;
  statusText?: string;
  outcome: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: Record<string, unknown>;
  responseBody?: Record<string, unknown>;
  sizes?: Record<string, number>;
  startOffset: number;
  endOffset: number;
}

interface PlaybackWindow {
  start: number;
  end: number;
}

export class ReplayExportRenderer {
  private logger = createServiceLogger("replay-export-renderer");

  async render(
    jobData: ReplayExportJobData,
    outputDirectory: string,
    onProgress: (progress: number) => Promise<void>,
    isCancelled: () => Promise<boolean>
  ): Promise<ReplayExportResult> {
    const workDirectory = await mkdtemp(join(tmpdir(), "rybbit-replay-export-"));
    let browser: Browser | null = null;

    try {
      await onProgress(5);
      const { events, metadata } = await new SessionReplayQueryService().getSessionReplayEvents(
        jobData.siteId,
        jobData.sessionId
      );
      const firstTimestamp = events[0]?.timestamp ?? 0;
      const totalDuration = Math.max(0, (events[events.length - 1]?.timestamp ?? firstTimestamp) - firstTimestamp);
      const options = normalizeOptions(jobData.options, totalDuration);
      const playbackWindows = getActivePlaybackWindows(events, options.startMs, options.endMs);
      const outputDurationMs = validateReplayExportActivityDuration(playbackWindows);
      const requests = parseNetworkRequests(events, firstTimestamp)
        .filter(request => request.startOffset <= options.endMs && request.endOffset >= options.startMs)
        .filter(request => isTargetNetworkHost(request.url))
        .map(sanitizeNetworkRequest);

      if (await isCancelled()) throw new ReplayExportCancelledError();

      browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        headless: true,
        protocolTimeout: 120_000,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });

      const replayPage = await createReplayExportPage(browser, events);
      await onProgress(15);

      const videoPath = join(workDirectory, EXPORT_FILE_NAMES.video);
      await recordReplayRange(replayPage, playbackWindows, options, videoPath, isCancelled);
      await onProgress(80);

      if (await isCancelled()) throw new ReplayExportCancelledError();

      const generatedAt = new Date().toISOString();
      const zip = new JSZip();
      zip.file(EXPORT_FILE_NAMES.video, await readFile(videoPath));
      zip.file(
        EXPORT_FILE_NAMES.metadata,
        JSON.stringify(
          {
            schemaVersion: 3,
            generatedAt,
            siteId: jobData.siteId,
            sessionId: jobData.sessionId,
            range: {
              ...options,
              sourceDurationMs: options.endMs - options.startMs,
              exportedActiveDurationMs: outputDurationMs,
            },
            session: getExportMetadata(metadata),
            rendering: {
              offline: true,
              externalAssets: "blocked",
              assetFidelity: "External images, styles and fonts are omitted unless embedded as data/blob resources.",
            },
            network: {
              host: REPLAY_EXPORT_NETWORK_HOST,
              requestCount: requests.length,
            },
          },
          null,
          2
        )
      );
      zip.file(EXPORT_FILE_NAMES.networkLog, buildNetworkTextLog(requests));

      const filename = `rybbit-export-${safeFilename(jobData.sessionId)}-${Math.floor(options.startMs)}-${Math.floor(options.endMs)}.zip`;
      const filePath = join(outputDirectory, `${Date.now()}-${filename}`);
      await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
      const fileStats = await stat(filePath);
      await onProgress(100);

      return {
        filePath,
        filename,
        sizeBytes: fileStats.size,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
    } catch (error) {
      if (!(error instanceof ReplayExportCancelledError)) {
        this.logger.error({ error, sessionId: jobData.sessionId }, "Replay export rendering failed");
      }
      throw error;
    } finally {
      await browser?.close().catch(() => undefined);
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}

export class ReplayExportCancelledError extends Error {
  constructor() {
    super("Replay export cancelled");
    this.name = "ReplayExportCancelledError";
  }
}

async function pauseReplayAt(page: Page, offset: number) {
  await page.evaluate(replayOffset => (window as any).__replayer.pause(replayOffset), offset);
  await new Promise(resolve => setTimeout(resolve, 250));
}

async function recordReplayRange(
  page: Page,
  playbackWindows: PlaybackWindow[],
  options: ReturnType<typeof normalizeOptions>,
  videoPath: string,
  isCancelled: () => Promise<boolean>
) {
  await pauseReplayAt(page, options.startMs);
  const recorder = await page.screencast({
    path: videoPath as `${string}.webm`,
    fps: 24,
    quality: 34,
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  });

  try {
    for (const playbackWindow of playbackWindows) {
      if (await isCancelled()) throw new ReplayExportCancelledError();

      await page.evaluate(
        ({ offset, speed }) => {
          const replayer = (window as any).__replayer;
          replayer.setConfig({ speed });
          replayer.play(offset);
        },
        { offset: playbackWindow.start, speed: 1 }
      );
      await new Promise(resolve => setTimeout(resolve, Math.max(50, playbackWindow.end - playbackWindow.start)));
      await page.evaluate(offset => (window as any).__replayer.pause(offset), playbackWindow.end);
    }
  } finally {
    await recorder.stop();
  }
}

function getActivePlaybackWindows(events: any[], startMs: number, endMs: number): PlaybackWindow[] {
  const firstTimestamp = Number(events[0]?.timestamp);
  const lastTimestamp = Number(events[events.length - 1]?.timestamp);
  if (!Number.isFinite(firstTimestamp) || !Number.isFinite(lastTimestamp)) return [];
  const totalDuration = Math.max(endMs, lastTimestamp - firstTimestamp);
  return calculateReplayActivityWindows(events, totalDuration, startMs, endMs).map(({ start, end }) => ({
    start,
    end,
  }));
}

function normalizeOptions(options: ReplayExportJobData["options"], totalDuration: number) {
  const startMs = Math.max(0, Math.min(totalDuration, options.startMs));
  const endMs = Math.max(startMs + 1, Math.min(totalDuration, options.endMs));
  return { ...options, startMs, endMs };
}

function parseNetworkRequests(events: any[], firstTimestamp: number): ExportNetworkRequest[] {
  const seen = new Set<string>();
  const requests: ExportNetworkRequest[] = [];

  events.forEach(event => {
    if (Number(event?.type) !== 6 || event?.data?.plugin !== NETWORK_PLUGIN_NAME) return;
    const payloadRequests = event?.data?.payload?.requests;
    if (!Array.isArray(payloadRequests)) return;

    payloadRequests.forEach((request: any, index: number) => {
      const startedAt = finiteNumber(request?.startedAt) ?? event.timestamp;
      const requestId = stringValue(request?.requestId) || `${event.timestamp}-${index}`;
      if (seen.has(requestId)) return;
      seen.add(requestId);
      const completedAt = finiteNumber(request?.completedAt);
      const startOffset = Math.max(0, startedAt - firstTimestamp);
      const endOffset = Math.max(startOffset, (completedAt ?? startedAt) - firstTimestamp);
      requests.push({
        requestId,
        currentUrl: stringValue(request?.currentUrl),
        url: stringValue(request?.url),
        method: stringValue(request?.method, "GET").toUpperCase(),
        initiatorType: stringValue(request?.initiatorType, "other"),
        startedAt,
        completedAt,
        durationMs: finiteNumber(request?.durationMs) ?? Math.max(0, (completedAt ?? startedAt) - startedAt),
        status: finiteNumber(request?.status),
        statusText: optionalString(request?.statusText),
        outcome: stringValue(request?.outcome, "success"),
        requestHeaders: stringRecord(request?.requestHeaders),
        responseHeaders: stringRecord(request?.responseHeaders),
        requestBody: recordValue(request?.requestBody),
        responseBody: recordValue(request?.responseBody),
        sizes: numberRecord(request?.sizes),
        startOffset,
        endOffset,
      });
    });
  });

  return requests.sort((first, second) => first.startedAt - second.startedAt);
}

function isTargetNetworkHost(value: string) {
  try {
    return new URL(value).hostname.toLowerCase() === REPLAY_EXPORT_NETWORK_HOST;
  } catch {
    return false;
  }
}

function sanitizeNetworkRequest(request: ExportNetworkRequest): ExportNetworkRequest {
  return {
    ...request,
    currentUrl: redactUrl(request.currentUrl),
    url: redactUrl(request.url),
    requestHeaders: redactHeaders(request.requestHeaders),
    responseHeaders: redactHeaders(request.responseHeaders),
    requestBody: sanitizeBody(request.requestBody),
    responseBody: sanitizeBody(request.responseBody),
  };
}

function getExportMetadata(metadata: any) {
  const allowedFields = [
    "session_id",
    "user_id",
    "identified_user_id",
    "start_time",
    "end_time",
    "duration_ms",
    "page_url",
    "browser",
    "browser_version",
    "operating_system",
    "operating_system_version",
    "device_type",
    "screen_width",
    "screen_height",
    "country",
    "region",
    "city",
  ];
  return Object.fromEntries(
    allowedFields.flatMap(field => (metadata?.[field] === undefined ? [] : [[field, metadata[field]]]))
  );
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_NAME_PATTERN.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function redactHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SENSITIVE_NAME_PATTERN.test(key) ? "[redacted]" : value])
  );
}

function sanitizeBody(body?: Record<string, unknown>) {
  if (!body) return undefined;
  const { value, ...metadata } = body;
  return {
    ...metadata,
    value: sanitizeBodyValue(value, String(body.contentType ?? "")),
  };
}

function sanitizeBodyValue(value: unknown, contentType: string): unknown {
  if (typeof value !== "string") return redactSensitiveFields(value);

  if (contentType.includes("json") || /^\s*[\[{]/.test(value)) {
    try {
      return JSON.stringify(redactSensitiveFields(JSON.parse(value)), null, 2);
    } catch {
      return redactSensitiveText(value);
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(value);
    for (const key of params.keys()) {
      if (SENSITIVE_NAME_PATTERN.test(key)) params.set(key, "[redacted]");
    }
    return params.toString();
  }

  return redactSensitiveText(value);
}

function redactSensitiveFields(value: unknown, key = ""): unknown {
  if (key && SENSITIVE_NAME_PATTERN.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map(entry => redactSensitiveFields(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSensitiveFields(entryValue, entryKey)])
  );
}

function redactSensitiveText(value: string) {
  return value.replace(
    /((?:authorization|cookie|token|secret|password|api[-_]?key|credential)\s*[=:]\s*)([^&\s,;]+)/gi,
    "$1[redacted]"
  );
}

function buildNetworkTextLog(requests: ExportNetworkRequest[]) {
  if (requests.length === 0) {
    return `Brak żądań sieciowych dla hosta ${REPLAY_EXPORT_NETWORK_HOST} w wybranym zakresie.\n`;
  }

  return requests
    .map((request, index) => {
      const correlationId = findHeader(request.responseHeaders, "x-correlation-id") || "—";
      return `${"=".repeat(100)}
ŻĄDANIE ${index + 1} Z ${requests.length}
${"=".repeat(100)}
Czas: ${formatOffset(request.startOffset)}
Metoda: ${request.method}
URL: ${request.url}
Strona źródłowa: ${request.currentUrl || "—"}
Status: ${request.status ?? "—"} ${request.statusText ?? ""}
Wynik: ${request.outcome}
Czas trwania: ${Math.round(request.durationMs)} ms
Transfer: ${formatBytes(request.sizes?.transferSize)}
Correlation ID: ${correlationId}
ID żądania: ${request.requestId}
Inicjator: ${request.initiatorType}

NAGŁÓWKI ŻĄDANIA
${formatHeadersForText(request.requestHeaders)}

TREŚĆ ŻĄDANIA
${formatBodyForText(request.requestBody)}

NAGŁÓWKI ODPOWIEDZI
${formatHeadersForText(request.responseHeaders)}

TREŚĆ ODPOWIEDZI
${formatBodyForText(request.responseBody)}
`;
    })
    .join("\n");
}

function formatHeadersForText(headers: Record<string, string>) {
  const entries = Object.entries(headers).sort(([first], [second]) => first.localeCompare(second));
  if (entries.length === 0) return "(brak)";
  return entries.map(([name, value]) => `${name}: ${value}`).join("\n");
}

function formatBodyForText(body?: Record<string, unknown>) {
  if (!body) return "(brak)";
  const { value, ...metadata } = body;
  const metadataText = Object.entries(metadata)
    .map(([name, entryValue]) => `${name}: ${String(entryValue ?? "")}`)
    .join("\n");
  const bodyText = typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2);
  return `${metadataText || "metadane: brak"}\n\n${truncateText(bodyText, 100_000)}`;
}

function findHeader(headers: Record<string, string>, target: string) {
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === target.toLowerCase());
  return match?.[1] ?? "";
}

function formatOffset(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}.${String(
    Math.floor(milliseconds % 1000)
  ).padStart(3, "0")}`;
}

function formatBytes(value?: number) {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function truncateText(value: string, maxLength: number) {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[skrócono ${value.length - maxLength} znaków]`;
}

function safeFilename(value: string) {
  return basename(value)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = recordValue(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, String(entry)]));
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(
    (entry): entry is [string, number] => finiteNumber(entry[1]) !== undefined
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
