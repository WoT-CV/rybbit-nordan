import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Browser, HTTPRequest, Page } from "puppeteer";

const REPLAY_WIDTH = 1280;
const REPLAY_HEIGHT = 720;

export function isOfflineReplayResource(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "data:" ||
      parsed.protocol === "blob:" ||
      (parsed.protocol === "about:" && (parsed.pathname === "blank" || parsed.pathname === "srcdoc"))
    );
  } catch {
    return false;
  }
}

/** Install before any recorded DOM: replay exports never fetch external assets. */
export async function installOfflineReplayPolicy(page: Page) {
  const scriptNonce = randomBytes(24).toString("base64");
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${scriptNonce}'`,
    "style-src 'unsafe-inline' data: blob:",
    "img-src data: blob:",
    "font-src data: blob:",
    "media-src data: blob:",
    "frame-src about: data: blob:",
    "connect-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  // Interception covers every request and redirect, not a DNS/host allowlist.
  // Offline mode is an additional transport backstop; bypassing service workers
  // prevents an existing worker from satisfying or forwarding a request first.
  page.on("request", async (request: HTTPRequest) => {
    try {
      if (isOfflineReplayResource(request.url())) {
        await request.continue();
      } else {
        await request.abort("blockedbyclient");
      }
    } catch {
      // Closing the export/browser can dispose an already-paused request.
    }
  });
  await page.setBypassCSP(false);
  await page.setBypassServiceWorker(true);
  await page.setOfflineMode(true);
  await page.setRequestInterception(true);

  return { contentSecurityPolicy, scriptNonce };
}

export async function createReplayExportPage(browser: Browser, events: any[]): Promise<Page> {
  const page = await browser.newPage();
  const { contentSecurityPolicy, scriptNonce } = await installOfflineReplayPolicy(page);
  await page.setViewport({ width: REPLAY_WIDTH, height: REPLAY_HEIGHT, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><head><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><style>html,body,#replay{width:100%;height:100%;margin:0;overflow:hidden;background:#000}iframe{border:0}</style></head><body><div id="replay"></div></body></html>`
  );
  // Only our local bundle receives the nonce. Recorded scripts/event handlers,
  // popup openers and worker/WebSocket bootstraps cannot execute under this CSP.
  const source = await readFile(join(process.cwd(), "public", "rrweb.min.js"), "utf8");
  await page.evaluate(
    ({ source, nonce }) => {
      const script = document.createElement("script");
      script.nonce = nonce;
      script.textContent = source;
      document.head.appendChild(script);
    },
    { source, nonce: scriptNonce }
  );
  await page.evaluate(replayEvents => {
    const replayWindow = window as any;
    if (typeof replayWindow.rrweb?.Replayer !== "function") {
      throw new Error("rrweb Replayer is unavailable in the export renderer");
    }
    replayWindow.__replayer = new replayWindow.rrweb.Replayer(replayEvents, {
      root: document.getElementById("replay"),
      mouseTail: false,
      showWarning: false,
      showDebug: false,
    });
  }, events);
  await new Promise(resolve => setTimeout(resolve, 250));
  return page;
}
