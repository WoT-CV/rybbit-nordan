import {
  REQUEST_CORRELATION_TAG,
  isCorrelationId,
  isCorrelationTraceId,
  parseRequestCorrelationEvent,
  type RequestCorrelationPayload,
} from "@rybbit/shared/dist/requestCorrelation.js";
import type { SessionReplayEvent } from "./types.js";

const MAX_PENDING = 64;
const MAX_ROWS = 2000;
const OWNER = Symbol.for("wotcv/request-correlation-owner");
type Pending = { url: URL; method: string; started: number; epoch: number; cancel?: () => void };

/** Read-only response metadata observer, owned by one active replay recorder. */
export class RequestCorrelationObserver {
  private epoch = 0;
  private running = false;
  private rows = 0;
  private sequence = 0;
  private readonly prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private pending = new Set<Pending>();
  private restore?: () => void;
  private readonly origins: Set<string>;
  private readonly analyticsUrl: URL | undefined;

  constructor(
    origins: string[],
    analyticsHost: string,
    private emit: (event: SessionReplayEvent) => void
  ) {
    this.origins = new Set(
      origins.slice(0, 32).flatMap(value => {
        try {
          const url = new URL(value);
          return value === url.origin && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
            ? [value]
            : [];
        } catch {
          return [];
        }
      })
    );
    try {
      this.analyticsUrl = new URL(analyticsHost, window.location.href);
    } catch {
      /* No valid transport URL. */
    }
  }

  private ownTransport(url: URL): boolean {
    const host = this.analyticsUrl;
    if (!host || host.origin !== url.origin) return false;
    const prefix = host.pathname.replace(/\/$/, "");
    return ["/track", "/identify", "/session-replay/", "/site/"].some(path =>
      path.endsWith("/") ? url.pathname.startsWith(`${prefix}${path}`) : url.pathname === `${prefix}${path}`
    );
  }

  private begin(input: unknown, method: unknown, epoch: number): Pending | undefined {
    if (!this.running || epoch !== this.epoch || this.pending.size >= MAX_PENDING || this.rows >= MAX_ROWS) return;
    try {
      if (typeof input !== "string" && !(input instanceof URL)) return;
      const url = new URL(input, window.location.href);
      if (!this.origins.has(url.origin) || url.username || url.password || this.ownTransport(url)) return;
      if (typeof method !== "string") return;
      const normalizedMethod = method.toUpperCase();
      if (!/^[A-Z]{1,16}$/.test(normalizedMethod) || /\s/.test(normalizedMethod)) return;
      if (url.pathname.length > 2048) return;
      url.search = "";
      url.hash = "";
      const request = { url, method: normalizedMethod, started: performance.now(), epoch };
      this.pending.add(request);
      return request;
    } catch {
      return;
    }
  }

  private finish(
    request: Pending,
    transport: "fetch" | "xhr",
    outcome: RequestCorrelationPayload["outcome"],
    status = 0,
    finalUrl?: string,
    header?: (name: string) => string | null
  ): void {
    if (!this.pending.delete(request)) return;
    try {
      request.cancel?.();
    } catch {
      /* Best-effort listener cleanup. */
    }
    if (!this.running || request.epoch !== this.epoch || this.rows >= MAX_ROWS) return;
    try {
      if (finalUrl) {
        const final = new URL(finalUrl);
        if (
          !this.origins.has(final.origin) ||
          final.origin !== request.url.origin ||
          final.username ||
          final.password ||
          this.ownTransport(final)
        )
          return;
      } else if (outcome === "response") return;
      const correlationId = header?.("x-correlation-id");
      const traceId = header?.("x-trace-id");
      const event: SessionReplayEvent = {
        type: 5,
        timestamp: Date.now(),
        data: {
          tag: REQUEST_CORRELATION_TAG,
          payload: {
            rowId: `${this.prefix}-${++this.sequence}`,
            transport,
            method: request.method,
            origin: request.url.origin,
            pathname: request.url.pathname,
            status,
            outcome,
            durationMs: Math.max(0, performance.now() - request.started),
            ...(isCorrelationId(correlationId) ? { correlationId } : {}),
            ...(isCorrelationTraceId(traceId) ? { traceId: traceId.toLowerCase() } : {}),
          },
        },
      };
      if (!parseRequestCorrelationEvent(event)) return;
      this.rows++;
      this.emit(event);
    } catch {
      /* Observation must never change the application's request. */
    }
  }

  public start(): void {
    if (this.running || this.origins.size === 0 || this.rows >= MAX_ROWS) return;
    const owners = window as unknown as Record<symbol, RequestCorrelationObserver | undefined>;
    try {
      owners[OWNER]?.stop();
    } catch {
      /* A different bundle may own an older observer. */
    }
    owners[OWNER] = this;
    this.running = true;
    const epoch = ++this.epoch;
    const originalFetch = window.fetch;
    const prototype = window.XMLHttpRequest?.prototype;
    const originalOpen = prototype?.open;
    const originalSend = prototype?.send;
    const observer = this;
    const wrappedFetch: typeof fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      let pending: Pending | undefined;
      try {
        const input = args[0];
        const isRequest = typeof Request !== "undefined" && input instanceof Request;
        const init = args[1];
        // Reading an accessor twice could change the native request. Only
        // observe a plain init's data property; never inspect headers/body.
        const descriptor = init && Object.getOwnPropertyDescriptor(init, "method");
        const plain = !init || Object.getPrototypeOf(init) === Object.prototype || Object.getPrototypeOf(init) === null;
        if (plain && (!descriptor || "value" in descriptor)) {
          pending = observer.begin(
            isRequest ? input.url : input,
            descriptor?.value === undefined ? (isRequest ? input.method : "GET") : descriptor.value,
            epoch
          );
        }
      } catch {
        /* Ignore unusual request descriptors. */
      }
      let promise: ReturnType<typeof fetch>;
      try {
        promise = Reflect.apply(originalFetch, this, args);
      } catch (error) {
        if (pending) observer.finish(pending, "fetch", "network-error");
        throw error;
      }
      if (pending) {
        const request = pending;
        try {
          return promise.then(
            response => {
              try {
                observer.finish(request, "fetch", "response", response.status, response.url, name =>
                  response.headers.get(name)
                );
              } catch {
                /* Metadata is best effort. */
              }
              return response;
            },
            error => {
              try {
                observer.finish(request, "fetch", error?.name === "AbortError" ? "abort" : "network-error");
              } catch {
                /* Preserve the original error. */
              }
              throw error;
            }
          );
        } catch {
          observer.pending.delete(request);
        }
      }
      return promise;
    };
    type XhrState = { input: unknown; method: unknown; request?: Pending };
    const states = new WeakMap<XMLHttpRequest, XhrState>();
    const wrappedOpen = function (this: XMLHttpRequest, ...args: unknown[]) {
      const previous = states.get(this)?.request;
      if (previous) {
        try {
          // A pre-existing onload/readystatechange handler may reopen this
          // XHR before our completion listener runs. Read the finished old
          // response now, before native open clears it; never infer an error.
          if (this.readyState === 4 && this.status >= 100) {
            observer.finish(previous, "xhr", "response", this.status, this.responseURL, name =>
              this.getResponseHeader(name)
            );
          }
        } catch {
          /* Completion metadata is best effort. */
        }
        observer.pending.delete(previous);
        try {
          previous.cancel?.();
        } catch {
          /* Do not interrupt native open. */
        }
      }
      states.delete(this);
      const result = Reflect.apply(originalOpen!, this, args);
      if (observer.running && epoch === observer.epoch) states.set(this, { method: args[0], input: args[1] });
      return result;
    } as XMLHttpRequest["open"];
    const wrappedSend = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
      const state = states.get(this);
      if (state?.request && observer.pending.has(state.request)) return Reflect.apply(originalSend!, this, args);
      const request = state && observer.begin(state.input, state.method, epoch);
      if (request && state) {
        state.request = request;
        const xhr = this;
        const listeners = (["load", "error", "abort", "timeout"] as const).map(type => {
          const listener = () => {
            try {
              observer.finish(
                request,
                "xhr",
                type === "load" ? "response" : type === "error" ? "network-error" : type,
                type === "load" ? xhr.status : 0,
                xhr.responseURL,
                name => xhr.getResponseHeader(name)
              );
            } catch {
              observer.pending.delete(request);
              try {
                request.cancel?.();
              } catch {
                /* Best-effort listener cleanup. */
              }
            }
          };
          xhr.addEventListener(type, listener, true);
          return { type, listener };
        });
        request.cancel = () => listeners.forEach(({ type, listener }) => xhr.removeEventListener(type, listener, true));
      }
      try {
        return Reflect.apply(originalSend!, this, args);
      } catch (error) {
        if (request) {
          observer.pending.delete(request);
          try {
            request.cancel?.();
          } catch {
            /* Preserve native send errors. */
          }
        }
        throw error;
      }
    } as XMLHttpRequest["send"];
    this.restore = () => {
      try {
        if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      } catch {
        /* Read-only global. */
      }
      try {
        if (prototype?.open === wrappedOpen) prototype.open = originalOpen!;
      } catch {
        /* Read-only prototype. */
      }
      try {
        if (prototype?.send === wrappedSend) prototype.send = originalSend!;
      } catch {
        /* Read-only prototype. */
      }
    };
    try {
      if (typeof originalFetch === "function") window.fetch = wrappedFetch;
      if (prototype && typeof originalOpen === "function" && typeof originalSend === "function") {
        prototype.open = wrappedOpen;
        prototype.send = wrappedSend;
      }
    } catch {
      this.stop();
    }
  }

  public stop(): void {
    this.running = false;
    this.epoch++;
    this.pending.forEach(request => {
      try {
        request.cancel?.();
      } catch {
        /* Best-effort listener cleanup. */
      }
    });
    this.pending.clear();
    this.restore?.();
    this.restore = undefined;
    const owners = window as unknown as Record<symbol, RequestCorrelationObserver | undefined>;
    try {
      if (owners[OWNER] === this) delete owners[OWNER];
    } catch {
      /* A third-party owner slot can be read-only. */
    }
  }

  public reset(): void {
    const active = this.running;
    this.stop();
    if (active) this.start();
  }
}
