import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, HTTPRequest, Page } from "puppeteer";

const mocks = vi.hoisted(() => ({ readFile: vi.fn(async () => "window.rrweb = { Replayer: class {} };") }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

import { createReplayExportPage, installOfflineReplayPolicy, isOfflineReplayResource } from "./replayExportPage.js";

function fakePage() {
  const calls: string[] = [];
  let requestHandler: (request: HTTPRequest) => Promise<void>;
  const record = (name: string) => vi.fn(async (..._args: unknown[]) => void calls.push(name));
  const page = {
    on: vi.fn((name: string, handler: typeof requestHandler) => {
      expect(name).toBe("request");
      calls.push("request-handler");
      requestHandler = handler;
    }),
    setBypassCSP: record("setBypassCSP"),
    setBypassServiceWorker: record("setBypassServiceWorker"),
    setOfflineMode: record("setOfflineMode"),
    setRequestInterception: record("setRequestInterception"),
    setViewport: record("setViewport"),
    setContent: record("setContent"),
    evaluate: record("evaluate"),
  };
  return { page, calls, dispatch: (request: HTTPRequest) => requestHandler(request) };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("offline replay export resources", () => {
  it.each([
    "data:image/png;base64,iVBORw0KGgo=",
    "data:text/css,body%7Bcolor:red%7D",
    "blob:null/01234567-89ab-cdef-0123-456789abcdef",
    "blob:https://recorded.example/01234567-89ab-cdef-0123-456789abcdef",
    "about:blank",
    "about:blank#replay",
    "about:srcdoc",
  ])("permits only locally resolved resources: %s", value => {
    expect(isOfflineReplayResource(value)).toBe(true);
  });

  it.each([
    "http://127.0.0.1:8123/",
    "https://169.254.169.254/latest/meta-data/",
    "http://clickhouse:8123/",
    "https://public.example/assets.css",
    "ws://127.0.0.1:8080/",
    "wss://public.example/",
    "file:///etc/passwd",
    "ftp://127.0.0.1/file",
    "filesystem:http://127.0.0.1/temporary/file",
    "javascript:fetch('http://127.0.0.1/')",
    "chrome://settings",
    "about:config",
    "/relative.png",
    "not a url",
    "",
  ])("rejects network, local files and unknown protocols: %s", value => {
    expect(isOfflineReplayResource(value)).toBe(false);
  });
});

describe("offline replay export page policy", () => {
  it("installs interception and transport protection before any page content", async () => {
    const { page, calls } = fakePage();
    const policy = await installOfflineReplayPolicy(page as unknown as Page);

    expect(calls).toEqual([
      "request-handler",
      "setBypassCSP",
      "setBypassServiceWorker",
      "setOfflineMode",
      "setRequestInterception",
    ]);
    expect(page.setBypassCSP).toHaveBeenCalledExactlyOnceWith(false);
    expect(page.setBypassServiceWorker).toHaveBeenCalledExactlyOnceWith(true);
    expect(page.setOfflineMode).toHaveBeenCalledExactlyOnceWith(true);
    expect(page.setRequestInterception).toHaveBeenCalledExactlyOnceWith(true);
    expect(page.setContent).not.toHaveBeenCalled();
    expect(policy.contentSecurityPolicy).toContain(`script-src 'nonce-${policy.scriptNonce}'`);
    expect(policy.contentSecurityPolicy).toContain("connect-src 'none'");
    expect(policy.contentSecurityPolicy).toContain("worker-src 'none'");
    expect(policy.contentSecurityPolicy).toContain("object-src 'none'");
    expect(policy.contentSecurityPolicy).toContain("form-action 'none'");
    expect(policy.contentSecurityPolicy).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|https?:|data:|blob:)/);
    const second = await installOfflineReplayPolicy(fakePage().page as unknown as Page);
    expect(second.scriptNonce).not.toBe(policy.scriptNonce);
  });

  it("aborts every external request/redirect but continues embedded resources", async () => {
    const { page, dispatch } = fakePage();
    await installOfflineReplayPolicy(page as unknown as Page);

    for (const [url, allowed] of [
      ["data:image/png;base64,abc", true],
      ["blob:null/local-image", true],
      ["about:blank", true],
      ["https://assets.example/a.png", false],
      ["http://127.0.0.1/redirect-target", false],
      ["file:///etc/passwd", false],
      ["ftp://127.0.0.1/file", false],
    ] as const) {
      const request = { url: () => url, continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
      await dispatch(request as unknown as HTTPRequest);
      expect(request.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(request.abort).toHaveBeenCalledTimes(allowed ? 0 : 1);
      if (!allowed) expect(request.abort).toHaveBeenCalledWith("blockedbyclient");
    }
  });

  it("handles a disposed intercepted request without an unhandled rejection", async () => {
    const { page, dispatch } = fakePage();
    await installOfflineReplayPolicy(page as unknown as Page);
    await expect(
      dispatch({
        url: () => "http://127.0.0.1/",
        abort: vi.fn(async () => {
          throw new Error("Target closed");
        }),
      } as unknown as HTTPRequest)
    ).resolves.toBeUndefined();
  });

  it.each(["setBypassCSP", "setBypassServiceWorker", "setOfflineMode", "setRequestInterception"] as const)(
    "fails closed before content when %s fails",
    async method => {
      const { page } = fakePage();
      page[method].mockRejectedValueOnce(new Error("policy setup failed"));
      const browser = { newPage: async () => page };
      await expect(createReplayExportPage(browser as unknown as Browser, [])).rejects.toThrow("policy setup failed");
      expect(page.setContent).not.toHaveBeenCalled();
      expect(page.evaluate).not.toHaveBeenCalled();
    }
  );

  it("embeds CSP before replay DOM and nonces only the trusted local bootstrap", async () => {
    const { page, calls } = fakePage();
    const browser = { newPage: async () => page };
    const events = [{ type: 2, timestamp: 1000, data: { node: { type: 0, childNodes: [] } } }];
    expect(await createReplayExportPage(browser as unknown as Browser, events)).toBe(page);

    expect(calls.indexOf("setRequestInterception")).toBeLessThan(calls.indexOf("setContent"));
    const html = page.setContent.mock.calls[0][0] as string;
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf('<div id="replay">'));
    expect(html).not.toContain("<script");
    const [bootstrap, payload] = page.evaluate.mock.calls[0] as [
      (payload: { source: string; nonce: string }) => void,
      { source: string; nonce: string },
    ];
    expect(mocks.readFile).toHaveBeenCalledWith(expect.stringMatching(/public[/\\]rrweb\.min\.js$/), "utf8");
    expect(payload.source).toBe(await mocks.readFile());
    expect(html).toContain(`script-src 'nonce-${payload.nonce}'`);
    const script: Record<string, unknown> = {};
    const appendChild = vi.fn();
    vi.stubGlobal("document", { createElement: () => script, head: { appendChild } });
    bootstrap(payload);
    expect(script).toEqual({ nonce: payload.nonce, textContent: payload.source });
    expect(appendChild).toHaveBeenCalledWith(script);
    expect(page.evaluate.mock.calls[1][1]).toBe(events);
  });
});
