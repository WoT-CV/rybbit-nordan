import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestCorrelationObserver } from "./requestCorrelation.js";

const ORIGIN = "https://api.example.com";
const response = (url = `${ORIGIN}/players?secret=redacted`, status = 200) => ({
  url,
  status,
  headers: new Headers({ "x-correlation-id": "request-123", "x-trace-id": "a".repeat(32), authorization: "secret" }),
  get body() {
    throw new Error("must not read body");
  },
  clone: vi.fn(() => {
    throw new Error("must not clone");
  }),
  json: vi.fn(() => {
    throw new Error("must not parse");
  }),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeXHR extends EventTarget {
  readyState = 1;
  status = 200;
  responseURL = `${ORIGIN}/players`;
  openArguments: unknown[] = [];
  sendArguments: unknown[] = [];
  sent = false;
  open(...args: unknown[]) {
    this.openArguments = args;
    this.sent = false;
  }
  send(...args: unknown[]) {
    if (this.sent) throw new DOMException("already sent", "InvalidStateError");
    this.sent = true;
    this.sendArguments = args;
  }
  getResponseHeader(name: string) {
    return name === "x-correlation-id" ? "xhr-123" : null;
  }
  get responseText() {
    throw new Error("must not read xhr body");
  }
}

describe("replay-owned response metadata observer", () => {
  let original: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;
  let observer: RequestCorrelationObserver;
  beforeEach(() => {
    original = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", original);
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    emit = vi.fn();
    observer = new RequestCorrelationObserver(
      [ORIGIN, "https://other.example.com"],
      "https://analytics.example.com/api",
      emit
    );
  });
  afterEach(() => {
    observer.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves arguments, this, exact response and streams; emits only sanitized metadata", async () => {
    const result = response(undefined, 500);
    original.mockResolvedValue(result);
    observer.start();
    const owner = { fetch: window.fetch };
    const init = { method: "post", body: new ReadableStream(), headers: { Authorization: "not-read" } };
    expect(await owner.fetch(`${ORIGIN}/players?token=secret#private`, init)).toBe(result);
    expect(original.mock.calls[0]).toEqual([`${ORIGIN}/players?token=secret#private`, init]);
    expect(original.mock.contexts[0]).toBe(owner);
    expect(emit).toHaveBeenCalledOnce();
    const event = emit.mock.calls[0][0];
    expect(event.data.payload).toMatchObject({
      transport: "fetch",
      method: "POST",
      origin: ORIGIN,
      pathname: "/players",
      status: 500,
      outcome: "response",
      correlationId: "request-123",
      traceId: "a".repeat(32),
    });
    expect(JSON.stringify(event)).not.toMatch(/secret|token|Authorization|headers|body/);
    expect(result.clone).not.toHaveBeenCalled();
    expect(result.json).not.toHaveBeenCalled();
  });

  it.each([new Error("network"), new DOMException("abort", "AbortError")])(
    "rethrows the original asynchronous rejection object",
    async error => {
      original.mockRejectedValue(error);
      observer.start();
      const native = original;
      const promise = window.fetch(`${ORIGIN}/players`);
      await expect(promise).rejects.toBe(error);
      expect(native).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0][0].data.payload.outcome).toBe(error.name === "AbortError" ? "abort" : "network-error");
    }
  );

  it("preserves a synchronous exception and never lets a telemetry callback throw into fetch", async () => {
    const error = new Error("sync");
    original.mockImplementationOnce(() => {
      throw error;
    });
    observer.start();
    expect(() => window.fetch(`${ORIGIN}/players`)).toThrow(error);
    emit.mockImplementation(() => {
      throw new Error("observer failure");
    });
    const result = response();
    original.mockResolvedValue(result);
    expect(await window.fetch(`${ORIGIN}/players`)).toBe(result);
  });

  it("does not evaluate a RequestInit method accessor in addition to native fetch", async () => {
    const method = vi.fn(() => "POST");
    const init = Object.defineProperty({}, "method", { get: method });
    original.mockImplementation(async (_url, options) => {
      void options.method;
      return response();
    });
    observer.start();
    await window.fetch(`${ORIGIN}/players`, init);
    expect(method).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it("preserves native URL conversion counts and skips overridden URL inputs", async () => {
    const input = new URL(`${ORIGIN}/initial`);
    const stringify = vi.fn(() => `${ORIGIN}/conversion-${stringify.mock.calls.length}`);
    input.toString = stringify;
    original.mockImplementation(async input => response(String(input)));
    const baseline = await window.fetch(input);
    expect(baseline.url).toBe(`${ORIGIN}/conversion-1`);
    stringify.mockClear();
    observer.start();
    const instrumented = await window.fetch(input);
    expect(instrumented.url).toBe(baseline.url);
    expect(stringify).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not let post-consumption init reflection change the native wire URL or method", async () => {
    const wires: Array<{ url: string; method: string }> = [];
    original.mockImplementation(async (input, init) => {
      const wire = { url: String(input), method: init.method };
      wires.push(wire);
      return response(wire.url);
    });
    const run = async () => {
      const input = new URL(`${ORIGIN}/initial`);
      const target = { method: "POST" };
      const init = new Proxy(target, {
        getOwnPropertyDescriptor(object, key) {
          target.method = "DELETE";
          input.pathname = "/mutated";
          return Reflect.getOwnPropertyDescriptor(object, key);
        },
      });
      return window.fetch(input, init);
    };
    await run();
    observer.start();
    await run();
    expect(wires).toEqual([
      { url: `${ORIGIN}/initial`, method: "POST" },
      { url: `${ORIGIN}/initial`, method: "POST" },
    ]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("skips inherited method accessors without evaluating them in addition to native fetch", async () => {
    const method = vi.fn(() => "POST");
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "method");
    Object.defineProperty(Object.prototype, "method", { configurable: true, get: method });
    original.mockImplementation(async (_input, init) => {
      void init.method;
      return response();
    });
    try {
      observer.start();
      await window.fetch(`${ORIGIN}/players`, {});
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "method", previous);
      else Reflect.deleteProperty(Object.prototype, "method");
    }
    expect(method).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it("captures an ordinary inherited data method from the native plain prototype chain", async () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "method");
    Object.defineProperty(Object.prototype, "method", { configurable: true, writable: true, value: "POST" });
    try {
      observer.start();
      await window.fetch(`${ORIGIN}/players`, {});
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "method", previous);
      else Reflect.deleteProperty(Object.prototype, "method");
    }
    expect(emit.mock.calls[0][0].data.payload.method).toBe("POST");
  });

  it("never reads an overridden URL href getter or Request fields", async () => {
    const href = vi.fn(() => `${ORIGIN}/wrong`);
    const url = vi.fn(() => `${ORIGIN}/wrong`);
    const method = vi.fn(() => "DELETE");
    const inputUrl = new URL(`${ORIGIN}/url`);
    Object.defineProperty(inputUrl, "href", { get: href });
    const inputRequest = new Request(`${ORIGIN}/request`, { method: "POST" });
    Object.defineProperties(inputRequest, { url: { get: url }, method: { get: method } });
    const nativeUrl = Object.getOwnPropertyDescriptor(Request.prototype, "url")!.get!;
    original.mockImplementation(async input =>
      response(input instanceof Request ? nativeUrl.call(input) : String(input))
    );
    observer.start();
    expect((await window.fetch(inputUrl)).url).toBe(`${ORIGIN}/url`);
    expect((await window.fetch(inputRequest)).url).toBe(`${ORIGIN}/request`);
    expect(href).not.toHaveBeenCalled();
    expect(url).not.toHaveBeenCalled();
    expect(method).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("still captures ordinary primitive, URL and Request inputs with native request methods", async () => {
    const nativeUrl = Object.getOwnPropertyDescriptor(Request.prototype, "url")!.get!;
    original.mockImplementation(async input =>
      response(input instanceof Request ? nativeUrl.call(input) : String(input))
    );
    observer.start();
    await window.fetch(`${ORIGIN}/string`);
    await window.fetch(new URL(`${ORIGIN}/url`));
    await window.fetch(new Request(`${ORIGIN}/request`, { method: "POST" }));
    expect(emit.mock.calls.map(([event]) => [event.data.payload.pathname, event.data.payload.method])).toEqual([
      ["/string", "GET"],
      ["/url", "GET"],
      ["/request", "POST"],
    ]);
  });

  it("freezes XHR URL metadata at open without another native conversion at send", () => {
    vi.spyOn(FakeXHR.prototype, "open").mockImplementation(function (this: FakeXHR, ...args: unknown[]) {
      this.openArguments = args;
      this.responseURL = new URL(String(args[1]), window.location.href).href;
      this.sent = false;
    });
    observer.start();
    const input = new URL(`${ORIGIN}/initial`);
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open("GET", input);
    input.pathname = "/mutated";
    xhr.send();
    xhr.dispatchEvent(new Event("load"));
    expect(xhr.responseURL).toBe(`${ORIGIN}/initial`);
    expect(emit.mock.calls[0][0].data.payload.pathname).toBe("/initial");
    const stringify = vi.fn(() => `${ORIGIN}/conversion-${stringify.mock.calls.length}`);
    input.toString = stringify;
    xhr.open("GET", input);
    xhr.send();
    xhr.dispatchEvent(new Event("load"));
    expect(stringify).toHaveBeenCalledOnce();
    expect(xhr.responseURL).toBe(`${ORIGIN}/conversion-1`);
    expect(emit).toHaveBeenCalledOnce();
  });

  it("resolves relative fetch and XHR inputs against the document base, freezing XHR at open", async () => {
    const base = document.createElement("base");
    base.href = `${ORIGIN}/v1/`;
    document.head.appendChild(base);
    original.mockImplementation(async input => response(new URL(String(input), document.baseURI).href));
    vi.spyOn(FakeXHR.prototype, "open").mockImplementation(function (this: FakeXHR, ...args: unknown[]) {
      this.responseURL = new URL(String(args[1]), document.baseURI).href;
      this.sent = false;
    });
    try {
      observer.start();
      await window.fetch("players");
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "players");
      base.href = `${ORIGIN}/changed/`;
      xhr.send();
      xhr.dispatchEvent(new Event("load"));
      expect(emit.mock.calls.map(([event]) => event.data.payload.pathname)).toEqual(["/v1/players", "/v1/players"]);
    } finally {
      base.remove();
    }
  });

  it("ignores unknown origins, own tracking and cross-origin redirects even when both origins are configured", async () => {
    observer.stop();
    observer = new RequestCorrelationObserver(
      [ORIGIN, "https://other.example.com", "https://analytics.example.com"],
      "https://analytics.example.com/api",
      emit
    );
    observer.start();
    await window.fetch("https://unknown.example.com/players");
    for (const path of ["track", "identify", "site/tracking-config/12", "session-replay/record/12"])
      await window.fetch(`https://analytics.example.com/api/${path}`);
    original.mockResolvedValue(response("https://other.example.com/redirected"));
    await window.fetch(`${ORIGIN}/redirect`);
    expect(emit).not.toHaveBeenCalled();
  });

  it("drops stale completions across stop/restart/reset and only one observer owns capture", async () => {
    const pending = deferred<any>();
    original.mockReturnValueOnce(pending.promise);
    observer.start();
    const request = window.fetch(`${ORIGIN}/players`);
    observer.reset();
    pending.resolve(response());
    await request;
    expect(emit).not.toHaveBeenCalled();
    const otherEmit = vi.fn();
    const other = new RequestCorrelationObserver([ORIGIN], "https://analytics.example.com/api", otherEmit);
    other.start();
    observer.stop();
    await window.fetch(`${ORIGIN}/players`);
    expect(emit).not.toHaveBeenCalled();
    expect(otherEmit).toHaveBeenCalledOnce();
    other.stop();
    expect(window.fetch).toBe(original);
  });

  it("never overwrites a later third-party wrapper or duplicates through its old observer closure", async () => {
    observer.start();
    const previous = window.fetch;
    const thirdParty: typeof fetch = function (this: unknown, ...args) {
      return previous.apply(this, args);
    };
    window.fetch = thirdParty;
    observer.stop();
    expect(window.fetch).toBe(thirdParty);
    observer.start();
    await window.fetch(`${ORIGIN}/players`);
    expect(emit).toHaveBeenCalledOnce();
    observer.stop();
    expect(window.fetch).toBe(thirdParty);
  });

  it("rolls back a partial installation on a read-only XHR method without breaking native fetch", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(FakeXHR.prototype, "open")!;
    Object.defineProperty(FakeXHR.prototype, "open", { ...descriptor, writable: false });
    try {
      expect(() => observer.start()).not.toThrow();
      expect(window.fetch).toBe(original);
      await window.fetch(`${ORIGIN}/players`);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(FakeXHR.prototype, "open", descriptor);
    }
  });

  it("bounds pending requests to 64 without blocking native traffic", async () => {
    const pending = deferred<any>();
    original.mockReturnValue(pending.promise);
    observer.start();
    const requests = Array.from({ length: 65 }, () => window.fetch(`${ORIGIN}/players`));
    pending.resolve(response());
    await Promise.all(requests);
    expect(original).toHaveBeenCalledTimes(65);
    expect(emit).toHaveBeenCalledTimes(64);
  });

  it("keeps the 2000-row budget across restart without changing native results", async () => {
    observer.start();
    for (let i = 0; i < 2001; i++) await window.fetch(`${ORIGIN}/players`);
    observer.stop();
    observer.start();
    await window.fetch(`${ORIGIN}/players`);
    expect(original).toHaveBeenCalledTimes(2002);
    expect(emit).toHaveBeenCalledTimes(2000);
    expect(new Set(emit.mock.calls.map(([event]) => event.data.payload.rowId)).size).toBe(2000);
  });

  it.each(["load", "error", "abort", "timeout"])("preserves XHR arguments and user listeners on %s", outcome => {
    observer.start();
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    const onLoad = vi.fn();
    xhr.addEventListener(outcome, onLoad);
    xhr.open("PATCH", `${ORIGIN}/players?secret=hidden`, true, "user", "password");
    const body = { secret: "not-read" };
    xhr.send(body);
    xhr.dispatchEvent(new Event(outcome));
    expect(xhr.openArguments).toEqual(["PATCH", `${ORIGIN}/players?secret=hidden`, true, "user", "password"]);
    expect(xhr.sendArguments).toEqual([body]);
    expect(onLoad).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0].data.payload).toMatchObject({
      transport: "xhr",
      method: "PATCH",
      pathname: "/players",
      outcome: outcome === "load" ? "response" : outcome === "error" ? "network-error" : outcome,
    });
    expect(JSON.stringify(emit.mock.calls[0][0])).not.toMatch(/hidden|password|not-read/);
  });

  it("cleans the old XHR observation on reuse and keeps duplicate-send native errors", () => {
    observer.start();
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open("GET", `${ORIGIN}/old`);
    xhr.send();
    expect(() => xhr.send()).toThrow("already sent");
    xhr.open("GET", `${ORIGIN}/new`);
    xhr.send();
    xhr.dispatchEvent(new Event("load"));
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0].data.payload.pathname).toBe("/new");
  });

  it("records the completed XHR before a pre-existing load handler reuses it", () => {
    observer.start();
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    let reused = false;
    xhr.addEventListener("load", () => {
      if (reused) return;
      reused = true;
      xhr.open("GET", `${ORIGIN}/second`);
      xhr.send();
    });
    xhr.open("GET", `${ORIGIN}/first`);
    xhr.send();
    xhr.dispatchEvent(new Event("load"));
    xhr.dispatchEvent(new Event("load"));
    expect(emit.mock.calls.map(([event]) => event.data.payload.pathname)).toEqual(["/first", "/second"]);
  });

  it("finishes a completed response before a readyState handler reopens XHR ahead of load dispatch", () => {
    observer.start();
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open("GET", `${ORIGIN}/first`);
    xhr.send();
    xhr.readyState = 4;
    xhr.open("GET", `${ORIGIN}/second`);
    xhr.send();
    xhr.dispatchEvent(new Event("load"));
    expect(emit.mock.calls.map(([event]) => event.data.payload.pathname)).toEqual(["/first", "/second"]);
  });
});
