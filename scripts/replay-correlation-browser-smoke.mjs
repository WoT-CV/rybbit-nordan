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
  response.setHeader("X-Fixture-Method", request.method);
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
      const compatibility = await page.evaluate(async () => {
        const cases = [
          "string",
          "url",
          "url-stringifier",
          "url-href-getter",
          "url-primitive",
          "url-subclass",
          "request",
          "request-fields",
          "request-subclass",
          "foreign-url",
          "foreign-request",
          "proxy-url",
          "proxy-request",
          "init-method-getter",
          "init-inherited-getter",
          "init-inherited-data",
          "init-proxy",
          "relative-base",
        ];
        const runFetch = async (kind, observed) => {
          window.observer.stop();
          const counters = { stringifier: 0, href: 0, url: 0, method: 0, proxy: 0, reflectionBeforeNative: 0 };
          let input = `${location.origin}/input-${kind}`,
            init,
            frame,
            base,
            restoreMethod;
          if (kind === "relative-base") {
            base = document.createElement("base");
            base.href = `${location.origin}/input-base/`;
            document.head.appendChild(base);
            input = "relative-request";
          }
          if (kind.startsWith("url") || kind === "proxy-url") {
            input = new URL(input);
            if (kind === "url-stringifier")
              input.toString = () => `${location.origin}/input-conversion-${++counters.stringifier}`;
            if (kind === "url-href-getter")
              Object.defineProperty(input, "href", {
                get() {
                  counters.href++;
                  return `${location.origin}/wrong`;
                },
              });
            if (kind === "url-primitive")
              Object.defineProperty(input, Symbol.toPrimitive, {
                get() {
                  counters.stringifier++;
                  return () => `${location.origin}/input-primitive`;
                },
              });
            if (kind === "url-subclass") input = new (class extends URL {})(input.href);
            if (kind === "proxy-url")
              input = new Proxy(input, {
                get(target, key, receiver) {
                  counters.proxy++;
                  return Reflect.get(target, key, receiver);
                },
              });
          }
          if (kind.startsWith("request") || kind === "proxy-request") {
            input = new Request(input, { method: "POST" });
            if (kind === "request-fields")
              Object.defineProperties(input, {
                url: {
                  get() {
                    counters.url++;
                    return `${location.origin}/wrong`;
                  },
                },
                method: {
                  get() {
                    counters.method++;
                    return "DELETE";
                  },
                },
              });
            if (kind === "request-subclass")
              input = new (class extends Request {
                get url() {
                  counters.url++;
                  return `${location.origin}/wrong`;
                }
              })(input);
            if (kind === "proxy-request")
              input = new Proxy(input, {
                get(target, key, receiver) {
                  counters.proxy++;
                  return Reflect.get(target, key, receiver);
                },
              });
          }
          if (kind.startsWith("foreign-")) {
            frame = document.createElement("iframe");
            document.body.appendChild(frame);
            input =
              kind === "foreign-url"
                ? new frame.contentWindow.URL(input)
                : new frame.contentWindow.Request(input, { method: "POST" });
          }
          if (kind === "init-method-getter")
            init = {
              get method() {
                counters.method++;
                return "POST";
              },
            };
          if (kind === "init-inherited-getter" || kind === "init-inherited-data") {
            const previous = Object.getOwnPropertyDescriptor(Object.prototype, "method");
            restoreMethod = () =>
              previous
                ? Object.defineProperty(Object.prototype, "method", previous)
                : Reflect.deleteProperty(Object.prototype, "method");
            Object.defineProperty(
              Object.prototype,
              "method",
              kind === "init-inherited-getter"
                ? {
                    configurable: true,
                    get() {
                      counters.method++;
                      return "POST";
                    },
                  }
                : { configurable: true, writable: true, value: "POST" }
            );
            init = {};
          }
          if (kind === "init-proxy") {
            input = new URL(input);
            let consumed = false;
            init = new Proxy(
              { method: "POST" },
              {
                get(target, key, receiver) {
                  if (key === "method") {
                    counters.method++;
                    consumed = true;
                  }
                  return Reflect.get(target, key, receiver);
                },
                getOwnPropertyDescriptor(target, key) {
                  counters.proxy++;
                  if (!consumed) counters.reflectionBeforeNative++;
                  target.method = "DELETE";
                  input.pathname = "/input-mutated-by-init-trap";
                  return Reflect.getOwnPropertyDescriptor(target, key);
                },
              }
            );
          }
          const before = window.observations.length;
          if (observed) window.observer.start();
          let wireUrl, wireMethod, error;
          try {
            const response = await fetch(input, init);
            wireUrl = response.url;
            wireMethod = response.headers.get("X-Fixture-Method");
          } catch (caught) {
            error = caught.name;
          }
          window.observer.stop();
          frame?.remove();
          base?.remove();
          restoreMethod?.();
          return { counters, wireUrl, wireMethod, error, rows: structuredClone(window.observations.slice(before)) };
        };
        const fetchComparisons = [];
        for (const kind of cases)
          fetchComparisons.push({ kind, baseline: await runFetch(kind, false), observed: await runFetch(kind, true) });
        const runXhr = async (kind, observed) => {
          window.observer.stop();
          let conversions = 0;
          const input = new URL(`${location.origin}/input-xhr-${kind}`);
          if (kind === "stringifier") input.toString = () => `${location.origin}/input-xhr-conversion-${++conversions}`;
          const before = window.observations.length;
          if (observed) window.observer.start();
          const xhr = new XMLHttpRequest();
          const synchronous = kind === "sync";
          let base;
          if (kind === "relative-base") {
            base = document.createElement("base");
            base.href = `${location.origin}/input-xhr-base/`;
            document.head.appendChild(base);
          }
          xhr.open("GET", kind === "relative-base" ? "relative-request" : input, !synchronous);
          input.pathname = "/input-mutated-after-open";
          if (base) base.href = `${location.origin}/input-mutated-base/`;
          if (synchronous) xhr.send();
          else {
            await new Promise((resolve, reject) => {
              xhr.onload = resolve;
              xhr.onerror = reject;
              xhr.send();
            });
            // Native event dispatch can checkpoint microtasks before our later listener.
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          window.observer.stop();
          base?.remove();
          return { conversions, wireUrl: xhr.responseURL, rows: structuredClone(window.observations.slice(before)) };
        };
        const xhrComparisons = [];
        for (const kind of ["mutable", "sync", "stringifier", "relative-base"])
          xhrComparisons.push({ kind, baseline: await runXhr(kind, false), observed: await runXhr(kind, true) });
        return { fetchComparisons, xhrComparisons, restored: window.fetch === window.originalFetch };
      });
      for (const { kind, baseline, observed } of compatibility.fetchComparisons) {
        if (kind === "init-proxy") {
          assert.equal(observed.counters.proxy, 1, "Unsupported init proxy may reflect only after native consumption");
          assert.equal(observed.counters.reflectionBeforeNative, 0);
          assert.deepEqual({ ...observed.counters, proxy: 0 }, baseline.counters);
        } else
          assert.deepEqual(observed.counters, baseline.counters, `${name}/${kind}: no extra user getters/conversions`);
        assert.equal(observed.wireUrl, baseline.wireUrl, `${name}/${kind}: native wire URL preserved`);
        assert.equal(observed.wireMethod, baseline.wireMethod, `${name}/${kind}: native wire method preserved`);
        assert.equal(observed.error, baseline.error, `${name}/${kind}: native error preserved`);
        const ordinary = ["string", "url", "request", "relative-base", "init-inherited-data"].includes(kind);
        assert.equal(observed.rows.length, ordinary ? 1 : 0, `${name}/${kind}: capture only known-safe input`);
        if (ordinary) {
          assert.equal(observed.rows[0].data.payload.pathname, new URL(observed.wireUrl).pathname);
          assert.equal(observed.rows[0].data.payload.method, observed.wireMethod);
        }
      }
      for (const { kind, baseline, observed } of compatibility.xhrComparisons) {
        assert.equal(observed.conversions, baseline.conversions, `${name}/XHR ${kind}: native conversion count`);
        assert.equal(observed.wireUrl, baseline.wireUrl, `${name}/XHR ${kind}: native wire URL`);
        assert.equal(observed.rows.length, kind === "stringifier" ? 0 : 1);
        if (kind !== "stringifier")
          assert.equal(observed.rows[0].data.payload.pathname, new URL(observed.wireUrl).pathname);
      }
      assert.equal(compatibility.restored, true);
      console.log(
        JSON.stringify({
          engine: name,
          status: "PASS",
          rows: rows.length,
          bodyUnchanged: true,
          unhandledRejectionPreserved: true,
          nativeInputCompatibilityCases: compatibility.fetchComparisons.length + compatibility.xhrComparisons.length,
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
