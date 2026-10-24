import { getRecordNetworkPlugin, type NetworkReplayRecordPlugin } from "./networkReplay/networkPlugin.js";
import { getJsonByteSize } from "./networkReplay/utils.js";
import { getReplayBatchKey } from "./replayBatching.js";
import {
  ScriptConfig,
  SessionReplayBatch,
  SessionReplayBatchResult,
  SessionReplayEvent,
  SessionReplayTransportError,
} from "./types.js";

const SAMPLE_STORAGE_KEY = "rybbit-replay-sampled";
const ACTIVITY_CAPTURE_VERSION = 2;
const MAX_BATCH_SEND_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * Determines if this session should have replay enabled based on sample rate.
 * Uses sessionStorage to persist the decision for the entire browser session.
 */
function shouldSampleSession(sampleRate: number): boolean {
  // 100% = always record, 0% = never record
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;

  // Check if we already made a decision for this session
  try {
    const existingDecision = sessionStorage.getItem(SAMPLE_STORAGE_KEY);
    if (existingDecision !== null) {
      return existingDecision === "1";
    }

    // Make new sampling decision
    const sampled = Math.random() * 100 < sampleRate;
    sessionStorage.setItem(SAMPLE_STORAGE_KEY, sampled ? "1" : "0");

    return sampled;
  } catch {
    // sessionStorage not available, default to sampling
    return Math.random() * 100 < sampleRate;
  }
}

// rrweb types (simplified for our use case)
declare global {
  interface Window {
    rrweb?: {
      record: (options: {
        emit: (event: any) => void;
        checkoutEveryNms?: number;
        checkoutEveryNth?: number;
        blockClass?: string | RegExp;
        blockSelector?: string;
        ignoreClass?: string | RegExp;
        ignoreSelector?: string;
        maskTextClass?: string | RegExp;
        maskTextSelector?: string;
        maskAllInputs?: boolean;
        maskInputOptions?: Record<string, boolean>;
        slimDOMOptions?: Record<string, boolean> | boolean;
        sampling?: Record<string, any>;
        recordCanvas?: boolean;
        collectFonts?: boolean;
        plugins?: NetworkReplayRecordPlugin[];
      }) => () => void;
    };
  }
}

export class SessionReplayRecorder {
  private config: ScriptConfig;
  private isRecording: boolean = false;
  // Set once the server reports the session is over its size cap; recording
  // stays off for the rest of this page.
  private capped: boolean = false;
  private stopRecordingFn?: () => void;
  private userId: string;
  private eventBuffer: SessionReplayEvent[] = [];
  private eventBufferSizeBytes: number = 0;
  private nextSequenceNumber: number = 0;
  private pendingBatches: SessionReplayBatch[] = [];
  private isSendingBatches: boolean = false;
  private retryAttempts = new Map<string, number>();
  private batchTimer?: number;
  private retryTimer?: number;
  private sendBatch: (batch: SessionReplayBatch) => Promise<SessionReplayBatchResult | void>;

  constructor(
    config: ScriptConfig,
    userId: string,
    sendBatch: (batch: SessionReplayBatch) => Promise<SessionReplayBatchResult | void>
  ) {
    this.config = config;
    this.userId = userId;
    this.sendBatch = sendBatch;
  }

  async initialize(): Promise<void> {
    if (!this.config.enableSessionReplay) {
      return;
    }

    // Check sample rate if specified
    const sampleRate = this.config.sessionReplaySampleRate;
    if (sampleRate !== undefined && !shouldSampleSession(sampleRate)) {
      return;
    }

    // Load rrweb if not already loaded
    if (!window.rrweb) {
      await this.loadRrweb();
    }

    if (window.rrweb) {
      this.startRecording();
    }
  }

  private async loadRrweb(): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      // Load from same origin to avoid CDN blocking
      script.src = `${this.config.analyticsHost}/replay.js`;
      script.async = false;
      script.onload = () => {
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load rrweb"));
      document.head.appendChild(script);
    });
  }

  public startRecording(): void {
    if (this.capped || this.isRecording || !window.rrweb || !this.config.enableSessionReplay) {
      return;
    }

    try {
      // Default slimDOMOptions (can be overridden via config)
      const defaultSlimDOMOptions = {
        script: false,
        comment: true,
        headFavicon: true,
        headWhitespace: true,
        headMetaDescKeywords: true,
        headMetaSocial: true,
        headMetaRobots: true,
        headMetaHttpEquiv: true,
        headMetaAuthorship: true,
        headMetaVerification: true,
      };

      const recordingOptions: any = {
        emit: (event: any) => {
          this.addEvent({
            type: event.type,
            data: event.data,
            timestamp: event.timestamp || Date.now(),
          });
        },
        recordCanvas: false, // Always disabled to save disk space
        checkoutEveryNms: 60000, // Checkout every 60 seconds
        checkoutEveryNth: 500, // Checkout every 500 events
        // Use config values with fallbacks to defaults
        blockClass: this.config.sessionReplayBlockClass ?? "rr-block",
        blockSelector: this.config.sessionReplayBlockSelector ?? null,
        ignoreClass: this.config.sessionReplayIgnoreClass ?? "rr-ignore",
        ignoreSelector: this.config.sessionReplayIgnoreSelector ?? null,
        maskTextClass: this.config.sessionReplayMaskTextClass ?? "rr-mask",
        maskAllInputs: this.config.sessionReplayMaskAllInputs ?? true,
        maskInputOptions: this.config.sessionReplayMaskInputOptions ?? { password: true, email: true },
        collectFonts: this.config.sessionReplayCollectFonts ?? true,
        slimDOMOptions: this.config.sessionReplaySlimDOMOptions ?? defaultSlimDOMOptions,
        plugins: this.config.networkReplay?.enabled
          ? [getRecordNetworkPlugin(this.config.networkReplay, this.config.analyticsHost)]
          : [],
      };

      // Add custom text masking selectors if configured
      if (this.config.sessionReplayMaskTextSelectors && this.config.sessionReplayMaskTextSelectors.length > 0) {
        recordingOptions.maskTextSelector = this.config.sessionReplayMaskTextSelectors.join(", ");
      }

      if (this.config.sessionReplaySampling !== undefined) {
        recordingOptions.sampling = this.config.sessionReplaySampling;
      }

      this.stopRecordingFn = window.rrweb.record(recordingOptions);

      this.addEvent({
        type: 5,
        data: {
          tag: "wotcv/replay-config",
          payload: {
            activityCaptureVersion: ACTIVITY_CAPTURE_VERSION,
            sampling: this.config.sessionReplaySampling ?? null,
          },
        },
        timestamp: Date.now(),
      });

      this.isRecording = true;
      this.setupBatchTimer();
    } catch (error) {
      // Recording failed silently
    }
  }

  public stopRecording(): void {
    if (!this.isRecording) {
      return;
    }

    if (this.stopRecordingFn) {
      this.stopRecordingFn();
      this.stopRecordingFn = undefined;
    }

    this.isRecording = false;
    this.clearBatchTimer();

    // Send any remaining events
    if (this.eventBuffer.length > 0) {
      this.flushEvents();
    }
  }

  public isActive(): boolean {
    return this.isRecording;
  }

  private addEvent(event: SessionReplayEvent): void {
    if (this.capped) return;

    const sequencedEvent = {
      ...event,
      sequenceNumber: event.sequenceNumber ?? this.nextSequenceNumber++,
    };
    const eventSizeBytes = getJsonByteSize(sequencedEvent);
    const maxBatchSizeBytes = this.config.networkReplay?.maxReplayBatchSizeBytes ?? 7_000_000;

    if (this.eventBuffer.length > 0 && this.eventBufferSizeBytes + eventSizeBytes > maxBatchSizeBytes) {
      this.flushEvents();
    }

    this.eventBuffer.push(sequencedEvent);
    this.eventBufferSizeBytes += eventSizeBytes;

    if (eventSizeBytes >= maxBatchSizeBytes || this.eventBuffer.length >= this.config.sessionReplayBatchSize) {
      this.flushEvents();
    }
  }

  private setupBatchTimer(): void {
    this.clearBatchTimer();
    this.batchTimer = window.setInterval(() => {
      if (this.eventBuffer.length > 0) {
        this.flushEvents();
      } else if (this.pendingBatches.length > 0 && this.retryTimer === undefined) {
        void this.processPendingBatches();
      }
    }, this.config.sessionReplayBatchInterval);
  }

  private clearBatchTimer(): void {
    if (this.batchTimer !== undefined) {
      clearInterval(this.batchTimer);
      this.batchTimer = undefined;
    }
  }

  private flushEvents(): void {
    if (this.capped || this.eventBuffer.length === 0) {
      return;
    }

    const events = this.eventBuffer;
    this.eventBuffer = [];
    this.eventBufferSizeBytes = 0;
    this.pendingBatches.push(this.createBatch(events));
    void this.processPendingBatches();
  }

  private async processPendingBatches(): Promise<void> {
    if (this.capped || this.isSendingBatches || this.retryTimer !== undefined) {
      return;
    }

    this.isSendingBatches = true;

    try {
      while (!this.capped && this.pendingBatches.length > 0) {
        const batch = this.pendingBatches.shift();
        if (!batch) {
          continue;
        }

        const unsentEvents = await this.sendEventsWithPayloadFallback(batch);
        if (this.capped) break;

        if (unsentEvents) {
          const batchKey = getReplayBatchKey(unsentEvents);
          const attempts = (this.retryAttempts.get(batchKey) ?? 0) + 1;
          if (attempts >= MAX_BATCH_SEND_ATTEMPTS) {
            this.retryAttempts.delete(batchKey);
            console.warn(
              `[SessionReplay] Dropped ${unsentEvents.length} events after ${MAX_BATCH_SEND_ATTEMPTS} failed send attempts`
            );
            continue;
          }

          this.retryAttempts.set(batchKey, attempts);
          this.pendingBatches.unshift({ ...batch, events: unsentEvents });
          const queuedEventCount = this.pendingBatches.reduce(
            (total, queuedBatch) => total + queuedBatch.events.length,
            0
          );
          console.warn(`[SessionReplay] ${queuedEventCount} events queued for retry`);
          this.scheduleRetry(attempts);
          break;
        } else {
          this.retryAttempts.delete(getReplayBatchKey(batch.events));
        }
      }
    } finally {
      this.isSendingBatches = false;
    }
  }

  private scheduleRetry(attempt: number): void {
    if (this.capped || this.retryTimer !== undefined) {
      return;
    }

    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_DELAY_MS);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      void this.processPendingBatches();
    }, delay);
  }

  private async sendEventsWithPayloadFallback(batch: SessionReplayBatch): Promise<SessionReplayEvent[] | undefined> {
    if (this.capped) return undefined;

    const { events } = batch;
    try {
      const result = await this.sendBatch(batch);
      if (result?.stopRecording === true) this.stopForSizeCap();
      return undefined;
    } catch (error) {
      // A failing recorder cleanup must not resurrect a terminally capped batch.
      if (this.capped) return undefined;

      if (!this.isPayloadTooLargeError(error)) {
        return events;
      }

      if (events.length === 1) {
        const event = events[0];
        console.warn(
          `[SessionReplay] Dropped event type ${String(event.type)} at ${event.timestamp} after HTTP 413 (${getJsonByteSize(event)} bytes)`
        );
        return undefined;
      }

      const splitIndex = Math.ceil(events.length / 2);
      const firstBatch = events.slice(0, splitIndex);
      const secondBatch = events.slice(splitIndex);
      const unsentFirstBatch = await this.sendEventsWithPayloadFallback({ ...batch, events: firstBatch });

      if (unsentFirstBatch) {
        return [...unsentFirstBatch, ...secondBatch];
      }

      return this.sendEventsWithPayloadFallback({ ...batch, events: secondBatch });
    }
  }

  private createBatch(events: SessionReplayEvent[]): SessionReplayBatch {
    return {
      anonymousId: this.config.visitorId,
      userId: this.userId,
      events,
      metadata: {
        pageUrl: window.location.href,
        viewportWidth: screen.width,
        viewportHeight: screen.height,
        language: navigator.language,
      },
    };
  }

  private isPayloadTooLargeError(error: unknown): boolean {
    if (error instanceof SessionReplayTransportError) {
      return error.status === 413;
    }

    return typeof error === "object" && error !== null && "status" in error && error.status === 413;
  }

  // Unlike stopRecording, drops what's buffered: the server refuses it anyway.
  private stopForSizeCap(): void {
    this.capped = true;
    this.isRecording = false;
    const stopRecording = this.stopRecordingFn;
    this.stopRecordingFn = undefined;
    this.clearBatchTimer();
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.eventBuffer = [];
    this.eventBufferSizeBytes = 0;
    this.pendingBatches = [];
    this.retryAttempts.clear();
    // rrweb's plugin cleanup can emit final network events; addEvent rejects
    // those after the terminal flag above, even if cleanup itself throws.
    stopRecording?.();
  }

  // Update user ID when it changes
  public updateUserId(userId: string): void {
    if (userId === this.userId) {
      return;
    }

    // Keep events captured under the previous identity in their original batch.
    // flushEvents snapshots both the identified and anonymous IDs so queued
    // batches retain the identity that was active when they were captured.
    if (this.eventBuffer.length > 0) {
      void this.flushEvents();
    }

    this.userId = userId;
  }

  // Handle page navigation for SPAs
  public onPageChange(): void {
    if (this.isRecording) {
      // Flush current events before page change
      this.flushEvents();
    }
  }

  // Cleanup on page unload
  public cleanup(): void {
    this.stopRecording();
  }
}
