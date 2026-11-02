import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Real built Next + native rrweb. No backend, credentials, production traffic,
// dependency installation or app modifications. All API I/O is synthetic GET.
assert.equal(
  process.argv.length,
  4,
  "Usage: node scripts/minimal-ui-smoke.mjs <loopback-app-origin> <playwright-index.mjs>"
);
const appUrl = new URL(process.argv[2]);
assert(
  appUrl.protocol === "http:" &&
    appUrl.hostname === "127.0.0.1" &&
    appUrl.port &&
    appUrl.pathname === "/" &&
    !appUrl.username &&
    !appUrl.password &&
    !appUrl.search &&
    !appUrl.hash,
  "An explicit http://127.0.0.1:<port> origin is required"
);
const app = appUrl.origin;
const api = "http://127.0.0.1:13001"; // Origin baked into the reviewed local production build.
assert.notEqual(app, api);
const { chromium, firefox, webkit, devices } = await import(pathToFileURL(resolve(process.argv[3])).href);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const directory of [root, join(root, "client")]) {
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    const exists = await access(join(directory, name)).then(
      () => true,
      error => {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    );
    assert(!exists, "Synthetic UI smoke refuses local or production environment files");
  }
}
const output = await mkdtemp(join(tmpdir(), "rybbit-minimal-ui-"));
console.log(`Synthetic UI evidence: ${output}`);
const start = Date.parse("2026-10-24T10:00:00Z");
const traceId = "1234567890abcdef1234567890abcdef";
const correlationId = "qa-request-123";
const permissions = ["analytics:read", "replay:read", "sites:read", "sessions:read", "users:read", "events:read"];
const site = {
  siteId: 2,
  id: "qa-site",
  name: "Synthetic QA",
  domain: "example.test",
  type: "web",
  organizationId: "qa-org",
  public: false,
  sessionReplay: true,
  isOwner: true,
  role: "owner",
  permissions,
  createdAt: "2026-10-01T00:00:00Z",
  trackErrors: true,
  webVitals: true,
};
const organization = {
  id: "qa-org",
  name: "Synthetic QA",
  slug: "qa",
  createdAt: "2026-10-01T00:00:00Z",
  role: "owner",
  permissions,
  members: [],
  invitations: [],
  teams: [],
  assignableRoles: [],
};
const user = { id: "qa-user", email: "qa@example.test", name: "Synthetic QA", emailVerified: true, role: "user" };
const authSession = {
  session: {
    id: "qa-auth",
    userId: user.id,
    activeOrganizationId: organization.id,
    token: "synthetic-only",
    expiresAt: "2030-01-01T00:00:00Z",
  },
  user,
};
const subscription = {
  planName: "self-hosted",
  status: "active",
  eventLimit: null,
  monthlyEventCount: null,
  overMonthlyLimit: false,
};
const metadata = {
  session_id: "qa-replay",
  user_id: "qa-browser",
  identified_user_id: "000123",
  traits: {
    username: "[QA] Synthetic player",
    clanTag: "QA",
    customerId: "000123",
    customerName: "Synthetic player",
    avatarUrl: `${app}/fixture-clan.svg`,
    language: "en",
    browserLanguage: "en-US",
    theme: "dark",
  },
  start_time: "2026-10-24 10:00:00",
  end_time: "2026-10-24 10:01:00",
  duration_ms: 60000,
  page_url: "https://example.test/synthetic",
  event_count: 63,
  compressed_size_bytes: 20000,
  screen_width: 390,
  screen_height: 844,
  country: "PL",
  region: "PL-MZ",
  city: "Synthetic",
  browser: "Safari",
  browser_version: "18",
  operating_system: "iOS",
  operating_system_version: "18",
  device_type: "mobile",
  user_agent: "Synthetic fixture",
  language: "en",
  has_replay_data: true,
};
const snapshot = {
  type: 0,
  id: 1,
  childNodes: [
    { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
    {
      type: 2,
      id: 3,
      tagName: "html",
      attributes: {},
      childNodes: [
        { type: 2, id: 4, tagName: "head", attributes: {}, childNodes: [] },
        {
          type: 2,
          id: 5,
          tagName: "body",
          attributes: { style: "background:#141414;color:#fafafa;padding:20px;font:16px sans-serif" },
          childNodes: [
            {
              type: 2,
              id: 6,
              tagName: "h1",
              attributes: {},
              childNodes: [{ type: 3, id: 7, textContent: "Synthetic playback 0" }],
            },
          ],
        },
      ],
    },
  ],
};
const events = [
  { type: 4, timestamp: start, data: { href: metadata.page_url, width: 390, height: 844 } },
  { type: 2, timestamp: start + 1, data: { node: snapshot, initialOffset: { left: 0, top: 0 } } },
  ...Array.from({ length: 60 }, (_, i) => ({
    type: 3,
    timestamp: start + (i + 1) * 1000,
    data: {
      source: 0,
      texts: [{ id: 7, value: `Synthetic playback ${i + 1}` }],
      attributes: [],
      removes: [],
      adds: [],
    },
  })),
  {
    type: 5,
    timestamp: start + 20400,
    data: {
      tag: "wotcv/request-correlation@1",
      payload: {
        rowId: "request1",
        transport: "fetch",
        method: "GET",
        origin: "https://api.example.test",
        pathname: "/players/000123",
        status: 200,
        outcome: "response",
        durationMs: 400,
        correlationId,
        traceId,
      },
    },
  },
].sort((a, b) => a.timestamp - b.timestamp);
const profile = {
  requestOrigin: "https://api.example.test",
  grafanaUrl: "https://grafana.example.test/observability/",
  orgId: 7,
  lokiDatasourceUid: "qa-loki",
  tempoDatasourceUid: "qa-tempo",
  serviceName: "qa-api",
  environment: "synthetic",
  timePaddingMs: 1000,
};
const configs = {
  disableSignup: true,
  liteDashboard: false,
  mapboxToken: "",
  emailEnabled: false,
  gscEnabled: false,
  weeklyReportsEnabled: false,
  sourceCodeUrl: "",
};
const apiFixtures = new Map([
  ["/api/auth/get-session", authSession],
  ["/api/auth/organization/get-full-organization", organization],
  ["/api/auth/organization/list", [organization]],
  ["/api/user/organizations", [organization]],
  ["/api/auth/organization/list-teams", []],
  ["/api/auth/organization/list-user-teams", []],
  ["/api/config", configs],
  ["/api/version", { version: "2.9.1" }],
  ["/api/sites/2/is-public", { isPublic: false }],
  ["/api/sites/2/has-data", { hasData: true }],
  ["/api/sites/2/live-user-count", { count: 0 }],
  ["/api/sites/2/private-link-config", { success: true, data: { privateLinkKey: null } }],
  ["/api/favicon", null],
  ["/api/organizations/qa-org/sites", { organization, role: "owner", permissions, sites: [site], subscription }],
  ["/api/sites/2", site],
  ["/api/site/2", site],
  ["/api/sites/2/session-replay/list", { data: [metadata], totalCount: 1 }],
  ["/api/sites/2/session-replay/qa-replay", { events, metadata }],
  ["/api/sites/2/session-replay/correlation-config", { enabled: true, profiles: [profile] }],
]);
const fixtureHeaders = {
  "access-control-allow-origin": app,
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "Content-Type,Authorization,Cache-Control",
  "access-control-allow-methods": "GET,OPTIONS",
  "cache-control": "no-store",
};
function apiFixture(method, path) {
  if (!["GET", "OPTIONS"].includes(method) || !apiFixtures.has(path)) return undefined;
  const body = apiFixtures.get(path);
  return {
    status: method === "OPTIONS" || body === null ? 204 : 200,
    contentType: "application/json",
    headers: fixtureHeaders,
    body: method === "OPTIONS" || body === null ? "" : JSON.stringify(body),
  };
}

// Refuse to adopt or kill another process. Only the child created below is stopped.
const probe = createServer();
await new Promise((resolveProbe, reject) => {
  probe.once("error", reject);
  probe.listen(Number(appUrl.port), appUrl.hostname, resolveProbe);
});
await new Promise(resolveProbe => probe.close(resolveProbe));
const serverApiCalls = [],
  serverUnexpected = [];
let serverCaptureOverflow = false;
const recordServer = (collection, value) => {
  if (collection.length >= 256) {
    serverCaptureOverflow = true;
    return;
  }
  collection.push(value);
};
// Native userStore initializes its session at module scope during SSR too.
// This is an isolated fixture listener, not the application backend.
const apiServer = createHttpServer({ maxHeaderSize: 8192, requestTimeout: 2000 }, (request, response) => {
  const path = new URL(request.url, api).pathname;
  recordServer(serverApiCalls, { method: request.method, path });
  const fixture =
    request.headers.host === new URL(api).host && request.url.startsWith("/") && apiFixture(request.method, path);
  if (!fixture) {
    recordServer(serverUnexpected, { method: request.method, path });
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"No synthetic fixture"}');
    return;
  }
  response.writeHead(fixture.status, { ...fixture.headers, "content-type": fixture.contentType });
  response.end(fixture.body);
});
apiServer.keepAliveTimeout = 1000;
await new Promise((resolveApi, reject) => {
  apiServer.once("error", reject);
  apiServer.listen(13001, "127.0.0.1", resolveApi);
});
apiServer.on("error", error => recordServer(serverUnexpected, { error: error.message.slice(0, 4096) }));
const next = spawn(
  process.execPath,
  [join(root, "client/node_modules/next/dist/bin/next"), "start", "--hostname", appUrl.hostname, "--port", appUrl.port],
  {
    cwd: join(root, "client"),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Do not pass inherited service credentials, NODE_OPTIONS, or deployment URLs.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"].includes(name.toUpperCase())
        )
      ),
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      BASE_URL: app,
      SERVER_URL: api,
      NEXT_PUBLIC_BACKEND_URL: api,
      NEXT_PUBLIC_CLOUD: "false",
    },
  }
);
let serverLog = Buffer.alloc(0);
let serverLogTruncated = false;
for (const stream of [next.stdout, next.stderr])
  stream.on("data", data => {
    if (serverLog.length + data.length > 1024 * 1024) serverLogTruncated = true;
    serverLog = Buffer.concat([serverLog, data]).subarray(0, 1024 * 1024);
  });
let spawnError;
next.on("error", error => {
  spawnError = error;
});
const report = {
  app,
  api,
  output,
  browserPlugin: "Browser plugin not available",
  syntheticOnly: true,
  nativePlayer: true,
  serverApiCalls,
  serverUnexpected,
  cases: [],
};

function waitForOwnedExit(timeoutMs) {
  if (next.exitCode !== null || next.signalCode !== null || !next.pid) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const done = value => {
      clearTimeout(timer);
      next.removeListener("exit", exited);
      resolveExit(value);
    };
    const exited = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    next.once("exit", exited);
  });
}

function checkLink(href, kind) {
  const url = new URL(href);
  assert.equal(url.origin, "https://grafana.example.test");
  assert.equal(url.pathname, "/observability/explore");
  assert.equal(url.searchParams.get("orgId"), "7");
  assert.equal(url.searchParams.get("schemaVersion"), "1");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["orgId", "panes", "schemaVersion"]);
  const uid = kind === "logs" ? "qa-loki" : "qa-tempo";
  const type = kind === "logs" ? "loki" : "tempo";
  const query =
    kind === "logs"
      ? {
          expr: `{service_name="qa-api", deployment_environment="synthetic"} | http_correlation_id="${correlationId}"`,
          queryType: "range",
        }
      : { query: traceId, queryType: "traceId" };
  assert.deepEqual(JSON.parse(url.searchParams.get("panes")), {
    [kind]: {
      datasource: uid,
      queries: [{ refId: "A", datasource: { type, uid }, ...query }],
      range: { from: String(start + 19000), to: String(start + 21400) },
    },
  });
}

try {
  const deadline = Date.now() + 30000;
  while (true) {
    if (spawnError) throw spawnError;
    assert(next.exitCode === null, `Owned Next child exited: ${serverLog}`);
    try {
      if ((await fetch(`${app}/favicon.ico`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {
      /* startup only */
    }
    assert(Date.now() < deadline, `Next startup timed out: ${serverLog}`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
  }
  for (const [name, engine, mobile] of [
    ["chromium-desktop", chromium, false],
    ["chromium-mobile", chromium, true],
    ["firefox-desktop", firefox, false],
    ["webkit-mobile", webkit, true],
  ]) {
    const browser = await engine.launch({ headless: true });
    const result = {
      name,
      browser: browser.version(),
      mobileEmulation: mobile,
      errors: [],
      warnings: [],
      apiCalls: [],
      unexpected: [],
      blockedExternal: [],
      syntheticExternalFixtures: [],
      operations: [],
    };
    report.cases.push(result);
    let page;
    try {
      const context = await browser.newContext({
        ...(mobile ? devices["iPhone 13"] : { viewport: { width: 1440, height: 1000 } }),
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "dark",
        serviceWorkers: "block",
      });
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      const record = (key, value) => {
        if (result[key].length >= 256) {
          result.captureOverflow = true;
          return;
        }
        result[key].push(typeof value === "string" ? value.slice(0, 4096) : value);
      };
      page.on("pageerror", error => record("errors", error.message));
      page.on("console", message => {
        if (message.type() === "error") record("errors", message.text());
        if (message.type() === "warning") record("warnings", message.text());
      });
      await context.route("**/*", async route => {
        const request = route.request(),
          url = new URL(request.url());
        // Native optional update check: explicitly synthetic, never sent to SaaS.
        if (request.method() === "GET" && url.href === "https://app.rybbit.io/api/version") {
          record("syntheticExternalFixtures", { method: "GET", url: url.href });
          await route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": app },
            body: JSON.stringify({ version: "2.9.1" }),
          });
          return;
        }
        if (url.origin === app && url.pathname === "/fixture-clan.svg") {
          await route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#10b981"/><text x="8" y="43" font-size="30">QA</text></svg>',
          });
          return;
        }
        if (url.origin === api || (url.origin === app && url.pathname.startsWith("/api/"))) {
          record("apiCalls", { method: request.method(), path: url.pathname });
          const fixture = apiFixture(request.method(), url.pathname);
          if (!fixture) {
            record("unexpected", `${request.method()} ${url.pathname}`);
            await route.abort("blockedbyclient");
            return;
          }
          await route.fulfill(fixture);
        } else if (url.origin === app) await route.continue();
        else {
          record("blockedExternal", { method: request.method(), origin: url.origin, path: url.pathname });
          await route.fulfill({ status: 204 });
        }
      });
      result.documentStatus = (
        await page.goto(`${app}/2/replay`, { waitUntil: "networkidle", timeout: 60000 })
      ).status();
      assert.equal(page.url().split("?")[0], `${app}/2/replay`);
      result.title = await page.title();
      assert(result.title.length > 0);
      const cards = page.locator('[role="button"][aria-pressed]');
      await cards.first().waitFor({ state: "visible" });
      assert.match(await cards.first().innerText(), /\[QA\] Synthetic player/);
      const logo = cards.first().locator(`img[src="${app}/fixture-clan.svg"]`);
      await logo.waitFor({ state: "visible" });
      assert(await logo.evaluate(img => img.complete && img.naturalWidth === 64));
      assert.equal(await logo.getAttribute("referrerpolicy"), "no-referrer");
      await page.screenshot({ path: join(output, `${name}-list.png`), animations: "disabled" });
      const activate = locator => (mobile ? locator.tap() : locator.click());
      await activate(cards.first());
      const outer = page.getByRole("dialog", { name: "Session Replay", exact: true });
      if (mobile) await outer.waitFor({ state: "visible" });
      await page.locator(".rr-player iframe").waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector(".rr-player iframe")?.contentDocument?.body?.textContent?.includes("Synthetic playback")
      );
      const player = page.locator(".rr-player").locator("xpath=ancestor::div[contains(@class,'justify-between')][1]");
      const originalPlayer = await page.locator(".rr-player").elementHandle();
      const originalIframe = await page.locator(".rr-player iframe").elementHandle();
      const retained = async () => {
        assert.equal(await page.locator(".rr-player").count(), 1);
        assert(await originalPlayer.evaluate(el => el.isConnected && el === document.querySelector(".rr-player")));
        assert(
          await originalIframe.evaluate(el => el.isConnected && el === document.querySelector(".rr-player iframe"))
        );
        if (mobile) assert(await outer.isVisible(), "Nested action must retain outer mobile drawer");
      };
      const requests = page.getByRole("dialog", { name: "Requests", exact: true });
      await activate(player.getByRole("button", { name: "Requests", exact: true }));
      await requests.getByRole("link", { name: "Logs in Grafana" }).waitFor();
      assert.match(await requests.innerText(), /0:20/);
      assert.match(await requests.innerText(), /400 ms/);
      for (const [kind, label] of [
        ["logs", "Logs in Grafana"],
        ["trace", "Trace in Grafana"],
      ]) {
        const link = requests.getByRole("link", { name: label });
        checkLink(await link.getAttribute("href"), kind);
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
      }
      if (mobile) {
        await requests.evaluate(el =>
          Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})))
        );
        const dialogBox = await requests.boundingBox();
        const viewport = page.viewportSize();
        assert(dialogBox && viewport);
        const endpoint = await requests.locator("tbody tr td").nth(1).boundingBox();
        assert(endpoint && endpoint.width >= 250, "Mobile endpoint must remain a readable full-width cell");
        const actions = [
          requests.getByRole("button", { name: "Go to request" }),
          requests.getByRole("link", { name: "Logs in Grafana" }),
          requests.getByRole("link", { name: "Trace in Grafana" }),
        ];
        const actionBoxes = [];
        for (const action of actions) {
          const box = await action.boundingBox();
          assert(box && box.width > 0 && box.height > 0);
          assert(
            box.x >= Math.max(0, dialogBox.x) - 1 &&
              box.x + box.width <= Math.min(viewport.width, dialogBox.x + dialogBox.width) + 1,
            "Every mobile action must fit the dialog/viewport without horizontal scrolling"
          );
          assert(
            box.y >= Math.max(0, dialogBox.y) - 1 &&
              box.y + box.height <= Math.min(viewport.height, dialogBox.y + dialogBox.height) + 1,
            "Every mobile action must be visible inside the dialog/viewport"
          );
          actionBoxes.push(box);
        }
        const overflow = await requests.evaluate(el => ({
          dialog: el.scrollWidth - el.clientWidth,
          table:
            el.querySelector("table").parentElement.scrollWidth - el.querySelector("table").parentElement.clientWidth,
        }));
        assert(overflow.dialog <= 1 && overflow.table <= 1, "Mobile Requests must not require horizontal scrolling");
        result.mobileRequestsLayout = { viewport, dialog: dialogBox, endpoint, actions: actionBoxes, overflow };
        result.operations.push("mobile-fullwidth-endpoint-and-all-actions-without-horizontal-scroll");
      }
      await page.screenshot({ path: join(output, `${name}-requests.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await requests.waitFor({ state: "hidden" });
      await retained();
      result.operations.push(
        "clan-logo-loaded",
        "exact-grafana-profile-id-range-basepath",
        "nested-Escape-retains-player"
      );
      await activate(player.getByRole("button", { name: "Requests", exact: true }));
      await activate(requests.getByRole("button", { name: "Go to request" }));
      await requests.waitFor({ state: "hidden" });
      await retained();
      const slider = player.getByRole("slider");
      await page.waitForFunction(
        () => Math.abs(Number(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")) - 100 / 3) < 0.2
      );
      // rrweb's paused seek applies mutations strictly before the target clock;
      // an event exactly at 20,000ms can remain at 19 until playback resumes.
      await page.waitForFunction(() =>
        /Synthetic playback 19\b/.test(
          document.querySelector(".rr-player iframe")?.contentDocument?.body?.textContent ?? ""
        )
      );
      assert.match(await player.innerText(), /0:20 \/ 1:00/);
      result.operations.push("go-to-request-native-20s-iframe-content");
      const speed = player.getByRole("combobox");
      for (const value of ["0.25x", "0.5x", "2x", "4x", "1x"]) {
        await activate(speed);
        await activate(page.getByRole("option", { name: value, exact: true }));
        assert.equal(await speed.innerText(), value);
        await retained();
      }
      const rail = slider.locator("xpath=ancestor::*[@data-orientation][1]");
      const box = await rail.boundingBox();
      assert(box && box.width > 0);
      for (const fraction of [0.5, 0.75, 0.25]) {
        if (mobile) await page.touchscreen.tap(box.x + box.width * fraction, box.y + box.height / 2);
        else await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
        await page.waitForFunction(
          expected =>
            Math.abs(Number(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")) - expected) < 2,
          fraction * 100
        );
        await retained();
      }
      await activate(speed);
      await activate(page.getByRole("option", { name: "4x", exact: true }));
      const before = Number(await slider.getAttribute("aria-valuenow"));
      await activate(player.locator("button").filter({ has: page.locator("svg.lucide-play") }));
      await page.waitForFunction(
        value => Number(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")) > value + 5,
        before
      );
      await activate(player.locator("button").filter({ has: page.locator("svg.lucide-pause") }));
      await retained();
      result.operations.push(
        "all-native-speeds",
        "native-touch-or-pointer-seek",
        "4x-real-playback-progress",
        "same-player-and-iframe-retained"
      );
      assert.equal(await page.locator("nextjs-portal").filter({ hasText: /error/i }).count(), 0);
      assert.equal(result.documentStatus, 200, "The real replay document must not rely on client recovery from SSR500");
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.unexpected, []);
      assert.deepEqual(
        result.blockedExternal,
        [],
        "Unknown external requests must fail, not silently pass after stubbing"
      );
      assert(!result.captureOverflow, "Evidence capture must not overflow its bounded arrays");
      await page.screenshot({ path: join(output, `${name}-playback.png`), animations: "disabled" });
      result.result = "PASS";
      console.log(
        JSON.stringify({ name, result: "PASS", operations: result.operations, blockedExternal: result.blockedExternal })
      );
      await context.close();
    } catch (error) {
      result.result = "FAIL";
      result.failure = error.stack;
      if (page) {
        await page.screenshot({ path: join(output, `${name}-failure.png`), animations: "disabled" }).catch(() => {});
        await writeFile(
          join(output, `${name}-failure.txt`),
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        );
        await writeFile(
          join(output, `${name}-frames.json`),
          JSON.stringify(
            await page
              .locator("iframe")
              .evaluateAll(frames =>
                frames.map(frame => ({ html: frame.contentDocument?.documentElement?.outerHTML, src: frame.src }))
              ),
            null,
            2
          )
        );
      }
      console.error(JSON.stringify({ name, result: "FAIL", errors: result.errors, failure: error.message }));
    } finally {
      await browser.close();
    }
  }
  assert.deepEqual(serverUnexpected, []);
  assert(!serverCaptureOverflow, "Server fixture evidence must not overflow");
  assert(!serverLogTruncated, "Server logs must remain complete within the evidence cap");
  assert(
    !/unhandledRejection|ECONNREFUSED|uncaughtException/i.test(serverLog.toString()),
    "Server-side native initialization must also be clean"
  );
  report.result = report.cases.every(result => result.result === "PASS") ? "PASS" : "FAIL";
  assert.equal(
    report.result,
    "PASS",
    "One or more real UI cases failed; see the saved report (errors are not suppressed)"
  );
} catch (error) {
  report.result = "FAIL";
  report.failure = error.stack?.slice(0, 4096);
  throw error;
} finally {
  if (next.pid && next.exitCode === null && next.signalCode === null) {
    next.kill();
    if (!(await waitForOwnedExit(10000))) {
      next.kill("SIGKILL");
      report.cleanupTimedOut = !(await waitForOwnedExit(5000));
    }
  }
  report.ownedNextStopped = !next.pid || next.exitCode !== null || next.signalCode !== null;
  report.ownedApiStopped = await new Promise(resolveApi => {
    const timer = setTimeout(() => {
      apiServer.closeAllConnections();
      resolveApi(false);
    }, 5000);
    apiServer.close(() => {
      clearTimeout(timer);
      resolveApi(true);
    });
  });
  if (!report.ownedNextStopped || !report.ownedApiStopped || report.cleanupTimedOut) report.result = "FAIL";
  report.serverLogTruncated = serverLogTruncated;
  await writeFile(join(output, "next.log"), serverLog);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence report: ${join(output, "report.json")}`);
  assert(
    !report.cleanupTimedOut && report.ownedNextStopped && report.ownedApiStopped,
    "Owned Next process or API fixture listener did not stop within the bounded cleanup deadline"
  );
}
