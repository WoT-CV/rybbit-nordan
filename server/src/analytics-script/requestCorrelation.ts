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
type InputMetadata = { input: string; method: string };

const urlPrototype = URL.prototype;
const urlHref = Object.getOwnPropertyDescriptor(urlPrototype, "href")?.get;
const urlToString = Object.getOwnPropertyDescriptor(urlPrototype, "toString")?.value;
const requestPrototype = typeof Request === "undefined" ? undefined : Request.prototype;
const requestUrl = requestPrototype && Object.getOwnPropertyDescriptor(requestPrototype, "url")?.get;
const requestMethod = requestPrototype && Object.getOwnPropertyDescriptor(requestPrototype, "method")?.get;

// Never stringify an object in addition to native fetch/open. Brand getters
// reject proxies without invoking their property traps; exact prototypes and
// own descriptors conservatively exclude overridden/subclass/cross-realm inputs.
function safeUrl(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  try {
    const href = urlHref?.call(input);
    if (
      typeof href !== "string" ||
      Object.getPrototypeOf(input) !== urlPrototype ||
      Object.getPrototypeOf(urlPrototype) !== Object.prototype ||
      Object.getOwnPropertyDescriptor(urlPrototype, "href")?.get !== urlHref ||
      Object.getOwnPropertyDescriptor(urlPrototype, "toString")?.value !== urlToString ||
      ["href", "toString", "valueOf", Symbol.toPrimitive].some(key => Object.getOwnPropertyDescriptor(input, key)) ||
      Object.getOwnPropertyDescriptor(urlPrototype, Symbol.toPrimitive) ||
      Object.getOwnPropertyDescriptor(Object.prototype, Symbol.toPrimitive)
    )
      return;
    return href;
  } catch {
    return;
  }
}

function safeInput(input: unknown): InputMetadata | undefined {
  const url = safeUrl(input);
  if (url !== undefined) return { input: url, method: "GET" };
  try {
    const url = requestUrl?.call(input);
    const method = requestMethod?.call(input);
    if (
      typeof url !== "string" ||
      typeof method !== "string" ||
      Object.getPrototypeOf(input) !== requestPrototype ||
      Object.getOwnPropertyDescriptor(requestPrototype!, "url")?.get !== requestUrl ||
      Object.getOwnPropertyDescriptor(requestPrototype!, "method")?.get !== requestMethod ||
      ["url", "method", "toString", Symbol.toPrimitive].some(key => Object.getOwnPropertyDescriptor(input, key))
    )
      return;
    return { input: url, method };
  } catch {
    return;
  }
}

// Best effort for ordinary plain data init objects only. A dynamic proxy can
// forge post-consumption descriptors, so this is not authoritative wire metadata.
function initMethod(init: RequestInit | undefined, fallback: string): string | undefined {
  if (init == null) return fallback;
  const prototype = Object.getPrototypeOf(init);
  if (prototype !== Object.prototype && prototype !== null) return;
  const own = Object.getOwnPropertyDescriptor(init, "method");
  const descriptor =
    own ?? (prototype === Object.prototype ? Object.getOwnPropertyDescriptor(Object.prototype, "method") : undefined);
  if (descriptor && !("value" in descriptor)) return;
  const method = descriptor?.value;
  return method === undefined ? fallback : typeof method === "string" ? method : undefined;
}

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
      this.analyticsUrl = new URL(analyticsHost, document.baseURI);
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

  private begin(input: unknown, method: unknown, epoch: number, started = performance.now()): Pending | undefined {
    if (!this.running || epoch !== this.epoch || this.pending.size >= MAX_PENDING || this.rows >= MAX_ROWS) return;
    try {
      if (typeof input !== "string") return;
      const url = new URL(input, document.baseURI);
      if (!this.origins.has(url.origin) || url.username || url.password || this.ownTransport(url)) return;
      if (typeof method !== "string") return;
      const normalizedMethod = method.toUpperCase();
      if (!/^[A-Z]{1,16}$/.test(normalizedMethod) || /\s/.test(normalizedMethod)) return;
      if (url.pathname.length > 2048) return;
      url.search = "";
      url.hash = "";
      const request = { url, method: normalizedMethod, started, epoch };
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
      if (
        !observer.running ||
        epoch !== observer.epoch ||
        observer.rows >= MAX_ROWS ||
        observer.pending.size >= MAX_PENDING
      )
        return Reflect.apply(originalFetch, this, args);
      const started = performance.now();
      let input: InputMetadata | undefined;
      try {
        const metadata = safeInput(args[0]);
        if (metadata) input = { ...metadata, input: new URL(metadata.input, document.baseURI).href };
      } catch {
        /* Only trusted intrinsic input metadata is read before native fetch. */
      }
      // RequestInit reflection can execute proxy traps. It must happen only
      // AFTER native fetch has consumed the original URL/init, never before.
      const promise: ReturnType<typeof fetch> = Reflect.apply(originalFetch, this, args);
      let pending: Pending | undefined;
      try {
        if (input) {
          const method = initMethod(args[1], input.method);
          const current = safeInput(args[0]);
          if (
            method !== undefined &&
            current &&
            current.method === input.method &&
            new URL(current.input, document.baseURI).href === input.input
          )
            pending = observer.begin(input.input, method, epoch, started);
        }
      } catch {
        /* Dynamic/proxy init metadata is unsupported and never authoritative.
           Skip accessors, foreign prototype chains and visibly mutated inputs;
           post-consumption descriptors cannot prove arbitrary proxy behavior. */
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
      let metadata: InputMetadata | undefined;
      try {
        const input = safeUrl(args[1]);
        if (input !== undefined && typeof args[0] === "string") {
          const url = new URL(input, document.baseURI);
          url.search = "";
          url.hash = "";
          metadata = { method: args[0], input: url.href };
        }
      } catch {
        /* Optional metadata must not change native open errors. */
      }
      const result = Reflect.apply(originalOpen!, this, args);
      // Freeze safe URL metadata at open rather than retaining a mutable URL
      // until send. The native call above still receives the original arguments.
      if (observer.running && epoch === observer.epoch && metadata) states.set(this, metadata);
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
