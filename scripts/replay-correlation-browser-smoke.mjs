import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

// Isolated synthetic HTTP only. Never uses application configuration or live APIs.
if (process.argv.length !== 3)
  throw new Error("Usage: node scripts/replay-correlation-browser-smoke.mjs <playwright-index.mjs>");
const require = createRequire(new URL("../server/package.json", import.meta.url));
const { build } = require("esbuild");
const playwright = await import(pathToFileURL(process.argv[2]).href);
let foreignOrigin;
const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Expose-Headers", "X-Correlation-Id, X-Trace-Id");
  response.setHeader("X-Correlation-Id", "browser-fixture");
  response.setHeader("X-Trace-Id", "1234567890abcdef1234567890abcdef");
  if (request.url === "/broken") return request.socket.destroy();
  if (request.url === "/slow") {
    const timer = setTimeout(() => response.end("slow"), 1000);
    response.on("close", () => clearTimeout(timer));
    return;
  }
  if (request.url === "/redirect") {
    response.writeHead(302, { Location: `${foreignOrigin}/target` });
    return response.end();
  }
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    return response.end(
      "<!doctype html><html lang=en><title>Local correlation fixture</title><body>Fixture</body></html>"
    );
  }
  response.setHeader("Content-Type", "application/json");
  response.statusCode = request.url?.startsWith("/failure") ? 500 : 200;
  response.end('{"untouched":"application body"}');
});
const foreign = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.url !== "/hidden") response.setHeader("Access-Control-Expose-Headers", "X-Correlation-Id");
  response.setHeader("X-Correlation-Id", "foreign-fixture");
  response.end("foreign");
});
const listen = instance => new Promise(resolve => instance.listen(0, "127.0.0.1", resolve));
const close = instance => new Promise(resolve => instance.close(resolve));
try {
  await listen(server);
  await listen(foreign);
  const origin = `http://127.0.0.1:${server.address().port}`;
  foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
  const bundle = await build({
    stdin: {
      contents: `import {RequestCorrelationObserver} from './requestCorrelation.ts';
        window.observations=[];
        window.observer=new RequestCorrelationObserver(${JSON.stringify([origin, foreignOrigin])},${JSON.stringify(`${origin}/tracking`)},e=>window.observations.push(e));
        window.fixtureForeignOrigin=${JSON.stringify(foreignOrigin)};
        window.originalFetch=window.fetch; window.observer.start();`,
      resolveDir: fileURLToPath(new URL("../server/src/analytics-script/", import.meta.url)),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    alias: {
      "@rybbit/shared/dist/requestCorrelation.js": fileURLToPath(
        new URL("../shared/src/requestCorrelation.ts", import.meta.url)
      ),
    },
  });
  for (const name of ["chromium", "firefox", "webkit"]) {
    const browser = await playwright[name].launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const result = await page.evaluate(async () => {
        const response = await fetch("/failure?secret=must-not-record#fragment", {
          method: "POST",
          body: "must-not-record",
        });
        const body = await response.text();
        await Promise.all([fetch("/parallel"), fetch("/parallel")]);
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", "/xhr?secret=must-not-record");
          xhr.onload = () => {
            if (xhr.responseText !== '{"untouched":"application body"}') return reject(new Error("XHR body changed"));
            resolve();
          };
          xhr.onerror = reject;
          xhr.send();
        });
        await fetch("/redirect");
        await fetch("/tracking/track");
        await fetch(`${window.fixtureForeignOrigin}/hidden`);
        const controller = new AbortController();
        const aborted = fetch("/slow", { signal: controller.signal });
        controller.abort();
        let abortName;
        try {
          await aborted;
        } catch (error) {
          abortName = error.name;
        }
        const sync = new XMLHttpRequest();
        sync.open("GET", "/sync", false);
        sync.send();
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          let first = true;
          xhr.onload = () => {
            if (!first) return resolve();
            first = false;
            xhr.open("GET", "/reuse-b");
            xhr.send();
          };
          xhr.onerror = reject;
          xhr.open("GET", "/reuse-a");
          xhr.send();
        });
        window.unhandledCount = 0;
        window.addEventListener("unhandledrejection", event => {
          window.unhandledCount++;
          event.preventDefault();
        });
        void fetch("/broken");
        await new Promise(resolve => setTimeout(resolve, 250));
        const observations = structuredClone(window.observations);
        window.observer.stop();
        await fetch("/after-stop");
        return {
          status: response.status,
          body,
          observations,
          unhandledCount: window.unhandledCount,
          stoppedCount: window.observations.length,
          restored: window.fetch === window.originalFetch,
          abortName,
          syncStatus: sync.status,
        };
      });
      assert.equal(result.status, 500);
      assert.equal(result.body, '{"untouched":"application body"}');
      assert.equal(result.unhandledCount, 1, "observer must preserve native unhandledrejection");
      const rows = result.observations.map(event => event.data.payload);
      assert.equal(rows.length, 10, JSON.stringify(rows));
      assert.equal(new Set(rows.map(row => row.rowId)).size, 10);
      assert.equal(rows.filter(row => row.pathname === "/parallel").length, 2);
      assert.equal(rows.find(row => row.pathname === "/failure").status, 500);
      assert.equal(rows.find(row => row.pathname === "/broken").outcome, "network-error");
      assert.equal(rows.find(row => row.pathname === "/xhr").transport, "xhr");
      assert.equal(JSON.stringify(rows).includes("must-not-record"), false);
      assert.equal(
        rows.some(row => row.pathname === "/redirect"),
        false,
        "foreign redirect must not misattribute IDs"
      );
      const hidden = rows.find(row => row.pathname === "/hidden");
      assert.equal(hidden.status, 200);
      assert.equal(hidden.correlationId, undefined);
      assert.equal(hidden.traceId, undefined);
      assert.equal(result.abortName, "AbortError");
      assert.equal(rows.find(row => row.pathname === "/slow").outcome, "abort");
      assert.equal(result.syncStatus, 200);
      assert.equal(rows.find(row => row.pathname === "/sync").transport, "xhr");
      assert.ok(rows.find(row => row.pathname === "/reuse-a"));
      assert.ok(rows.find(row => row.pathname === "/reuse-b"));
      assert.equal(result.stoppedCount, 10);
      assert.equal(result.restored, true);
      console.log(
        JSON.stringify({
          engine: name,
          status: "PASS",
          rows: rows.length,
          bodyUnchanged: true,
          unhandledRejectionPreserved: true,
        })
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  server.closeAllConnections();
  foreign.closeAllConnections();
  await Promise.all([close(server), close(foreign)]);
}
