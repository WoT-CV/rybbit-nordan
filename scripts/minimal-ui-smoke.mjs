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
// This origin must match NEXT_PUBLIC_BACKEND_URL baked into the reviewed client build.
const apiUrl = new URL(process.env.WOTCV_UI_SMOKE_API_ORIGIN ?? "http://127.0.0.1:13001");
assert(
  apiUrl.protocol === "http:" &&
    apiUrl.hostname === "127.0.0.1" &&
    apiUrl.port &&
    apiUrl.pathname === "/" &&
    !apiUrl.username &&
    !apiUrl.password &&
    !apiUrl.search &&
    !apiUrl.hash,
  "WOTCV_UI_SMOKE_API_ORIGIN must be an explicit http://127.0.0.1:<port> origin"
);
const api = apiUrl.origin;
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
const requestPath = `/players/000123/${"synthetic-responsive-endpoint-".repeat(4)}`;
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
  permissions: [...permissions, "members:manage"],
  members: [],
  invitations: [],
  teams: [],
  assignableRoles: ["admin", "member", "viewer"],
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
        pathname: requestPath,
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
  emailEnabled: true,
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
  ["/api/auth/organization/list-invitations", []],
  ["/api/organizations/qa-org/members", { data: [] }],
  ["/api/organizations/qa-org/teams", { teams: [] }],
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
// Negative SSR sentinel: never serve session/config fixtures to the Next
// process. Browser API reads are intercepted below. Any server-side API call
// is a failure, even if the browser would subsequently recover from it.
const apiServer = createHttpServer({ maxHeaderSize: 8192, requestTimeout: 2000 }, (request, response) => {
  const path = new URL(request.url, api).pathname;
  recordServer(serverApiCalls, { method: request.method, path });
  recordServer(serverUnexpected, { method: request.method, path });
  request.resume();
  response.writeHead(503, { "content-type": "application/json" });
  response.end('{"error":"SSR API is intentionally unavailable"}');
});
apiServer.keepAliveTimeout = 1000;
await new Promise((resolveApi, reject) => {
  apiServer.once("error", reject);
  apiServer.listen(Number(apiUrl.port), apiUrl.hostname, resolveApi);
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
  ssrApiUnavailable: true,
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
  for (const [name, engine, mobile, viewport] of [
    ["chromium-desktop", chromium, false],
    ["chromium-mobile", chromium, true],
    ["chromium-tablet-touch", chromium, true, { width: 1000, height: 1000 }],
    ["firefox-desktop", firefox, false],
    ["firefox-mobile", firefox, true],
    ["webkit-desktop", webkit, false],
    ["webkit-mobile", webkit, true],
  ]) {
    const browser = await engine.launch({ headless: true });
    const result = {
      name,
      browser: browser.version(),
      mobileEmulation: mobile && engine !== firefox,
      compactTouchLayout: mobile,
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
      // Firefox supports touch + a compact viewport, but not isMobile emulation.
      const { isMobile, ...phone } = devices["iPhone 13"];
      const context = await browser.newContext({
        ...(mobile
          ? { ...phone, ...(engine === firefox ? {} : { isMobile }) }
          : { viewport: { width: 1440, height: 1000 } }),
        ...(viewport ? { viewport } : {}),
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "dark",
        serviceWorkers: "block",
      });
      page = await context.newPage();
      result.viewport = page.viewportSize();
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
      assert.equal(await player.getByRole("button", { name: "Requests", exact: true }).count(), 0);
      assert.equal(await page.getByRole("dialog", { name: "Requests", exact: true }).count(), 0);
      const timelineToggle = outer.getByRole("button", { name: "Timeline", exact: true });
      if (mobile) {
        await activate(timelineToggle);
        await outer.getByRole("region", { name: "Timeline", exact: true }).waitFor({ state: "visible" });
        assert.equal(await timelineToggle.getAttribute("aria-expanded"), "true");
        await retained();
      }
      const detailLevel = page.getByRole("radiogroup", { name: "Event detail level", exact: true });
      const keyOption = detailLevel.getByRole("radio", { name: "Key", exact: true });
      const requestsOption = detailLevel.getByRole("radio", { name: "Requests", exact: true });
      const allOption = detailLevel.getByRole("radio", { name: "All", exact: true });
      assert.deepEqual(await detailLevel.getByRole("radio").allTextContents(), ["Key", "Requests", "All"]);
      const timeline = mobile
        ? outer.getByRole("region", { name: "Timeline", exact: true })
        : detailLevel.locator("xpath=../..");
      const nativeSessionStart = timeline.getByText("Session started", { exact: true });
      const nativeFullSnapshot = timeline.getByText("Full Snapshot", { exact: true });
      assert.equal(await keyOption.getAttribute("aria-checked"), "true");
      const requestRow = page.getByRole("button", { name: `Requests: GET ${requestPath}`, exact: true });
      await nativeSessionStart.waitFor({ state: "visible" });
      assert.equal(await requestRow.count(), 0, "Native Key must not mix in request correlation rows");
      await activate(allOption);
      await nativeFullSnapshot.waitFor({ state: "visible" });
      await requestRow.waitFor({ state: "hidden" });
      assert.equal(await allOption.getAttribute("aria-checked"), "true");
      await activate(requestsOption);
      await requestRow.waitFor({ state: "visible" });
      assert.equal(await requestsOption.getAttribute("aria-checked"), "true");
      assert.equal(await nativeSessionStart.count(), 0, "Requests must be separate from native Key interactions");
      assert.equal(await requestRow.getAttribute("aria-expanded"), "false");
      assert.match(await requestRow.innerText(), /0:20/);
      assert.match(await requestRow.innerText(), /400 ms/);
      const collapsedRequest = await requestRow.boundingBox();
      assert(collapsedRequest && collapsedRequest.height <= 48, "Long request must remain a compact two-line row");
      const endpointLabel = requestRow.locator("span[title]").filter({ hasText: requestPath });
      assert.equal(await endpointLabel.getAttribute("title"), `https://api.example.test${requestPath}`);
      const endpointStyle = await endpointLabel.evaluate(element => {
        const style = getComputedStyle(element);
        return {
          whiteSpace: style.whiteSpace,
          overflowX: style.overflowX,
          textOverflow: style.textOverflow,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      });
      assert.equal(endpointStyle.whiteSpace, "nowrap");
      assert.equal(endpointStyle.overflowX, "hidden");
      assert.equal(endpointStyle.textOverflow, "ellipsis");
      assert(endpointStyle.height <= endpointStyle.lineHeight + 1, "Request method/path must stay on one line");
      if (endpointStyle.clientWidth < 600) {
        assert(endpointStyle.scrollWidth > endpointStyle.clientWidth, "Long fixture must exercise endpoint truncation");
      }
      if (mobile) await activate(requestRow);
      else await requestRow.press("Enter");
      // Keep this relative to the live virtual row. Hiding the mobile pane can
      // legitimately unmount/recreate a virtual item and therefore its useId.
      const requests = requestRow.locator("xpath=following-sibling::div[@id][1]");
      await requests.getByRole("link", { name: "Logs in Grafana" }).waitFor({ state: "visible" });
      assert.equal(await requestRow.getAttribute("aria-expanded"), "true");
      assert.equal(await requests.getAttribute("id"), await requestRow.getAttribute("aria-controls"));
      assert.match(await requests.innerText(), new RegExp(correlationId));
      assert.match(await requests.innerText(), new RegExp(traceId));
      assert.equal(await requests.getByText("Endpoint", { exact: true }).count(), 0);
      assert(!(await requests.innerText()).includes(requestPath), "Expanded details must not duplicate the endpoint");
      assert(
        !(await requests.innerText()).includes("https://api.example.test"),
        "Full URL belongs only in the header title"
      );
      assert.deepEqual(await requests.locator("dt").allTextContents(), ["correlationId", "traceId"]);
      for (const [kind, label] of [
        ["logs", "Logs in Grafana"],
        ["trace", "Trace in Grafana"],
      ]) {
        const link = requests.getByRole("link", { name: label });
        checkLink(await link.getAttribute("href"), kind);
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
      }
      {
        const paneBox = await timeline.boundingBox();
        const viewport = page.viewportSize();
        assert(paneBox && viewport);
        const endpoint = await endpointLabel.boundingBox();
        const expandedRequest = await requestRow.locator("xpath=..").boundingBox();
        assert(endpoint && expandedRequest);
        assert(expandedRequest.height <= 240, "Expanded request must remain compact");
        const actions = [
          requests.getByRole("button", { name: "Go to request" }),
          requests.getByRole("link", { name: "Logs in Grafana" }),
          requests.getByRole("link", { name: "Trace in Grafana" }),
        ];
        assert.deepEqual(await Promise.all(actions.map(action => action.innerText())), ["Seek", "Logs", "Trace"]);
        const actionBoxes = [];
        for (const action of actions) {
          const box = await action.boundingBox();
          assert(box && box.width > 0 && box.height > 0);
          assert(
            box.x >= Math.max(0, paneBox.x) - 1 &&
              box.x + box.width <= Math.min(viewport.width, paneBox.x + paneBox.width) + 1,
            "Every request action must fit the timeline/viewport without horizontal scrolling"
          );
          assert(
            box.y >= Math.max(0, paneBox.y) - 1 &&
              box.y + box.height <= Math.min(viewport.height, paneBox.y + paneBox.height) + 1,
            "Every request action must be visible inside the timeline/viewport"
          );
          actionBoxes.push(box);
        }
        const overflow = {
          pane: await timeline.evaluate(el => el.scrollWidth - el.clientWidth),
          details: await requests.evaluate(el => el.scrollWidth - el.clientWidth),
          page: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        };
        assert(
          Object.values(overflow).every(value => value <= 1),
          "Inline requests must not cause horizontal scrolling"
        );
        result.inlineRequestsLayout = {
          viewport,
          pane: paneBox,
          collapsedRequest,
          expandedRequest,
          endpoint,
          endpointStyle,
          actions: actionBoxes,
          overflow,
        };
        result.operations.push(
          "compact-request-truncated-endpoint-no-duplicate-url-and-actions-without-horizontal-scroll"
        );
      }
      await page.screenshot({ path: join(output, `${name}-requests.png`), animations: "disabled" });
      if (name === "chromium-desktop") {
        await requestRow.locator("xpath=..").screenshot({
          path: join(output, "chromium-desktop-request-row.png"),
          animations: "disabled",
        });
      }
      if (mobile) await activate(requestRow);
      else await requestRow.press("Space");
      await requests.waitFor({ state: "detached" });
      assert.equal(await requestRow.getAttribute("aria-expanded"), "false");
      await retained();
      result.operations.push(
        "clan-logo-loaded",
        "exact-grafana-profile-id-range-basepath",
        "no-header-requests-button-or-dialog",
        "native-key-requests-all-radio-order-and-separated-content",
        "inline-expansion-collapse-retains-player"
      );
      await activate(requestRow);
      await requests.getByRole("button", { name: "Go to request" }).waitFor({ state: "visible" });
      // Leaving Requests must reset expansion, without changing native Key/All.
      await activate(keyOption);
      await nativeSessionStart.waitFor({ state: "visible" });
      assert.equal(await requestRow.count(), 0);
      await activate(allOption);
      await nativeFullSnapshot.waitFor({ state: "visible" });
      assert.equal(await requestRow.count(), 0);
      await activate(requestsOption);
      await requestRow.waitFor({ state: "visible" });
      assert.equal(await requestRow.getAttribute("aria-expanded"), "false");
      await retained();
      result.operations.push("requests-tab-roundtrip-resets-expansion-preserves-native-key-and-all");
      await activate(requestRow);
      await requests.getByRole("button", { name: "Go to request" }).waitFor({ state: "visible" });
      assert.equal(await requests.getAttribute("id"), await requestRow.getAttribute("aria-controls"));
      await activate(requests.getByRole("button", { name: "Go to request" }));
      assert.equal(await requestRow.getAttribute("aria-expanded"), "true");
      await retained();
      if (mobile) {
        await page.keyboard.press("Escape");
        await page.locator(".rr-player iframe").waitFor({ state: "visible" });
        assert.equal(await timelineToggle.getAttribute("aria-expanded"), "false");
        await retained();
        await activate(timelineToggle);
        await requests.waitFor({ state: "visible" });
        assert.equal(await requests.getAttribute("id"), await requestRow.getAttribute("aria-controls"));
        await activate(timelineToggle);
        await page.locator(".rr-player iframe").waitFor({ state: "visible" });
        await retained();
        result.operations.push("mobile-timeline-access-escape-and-toggle-return-retain-player");
      }
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
      await page.screenshot({ path: join(output, `${name}-playback.png`), animations: "disabled" });
      const peopleResponse = await page.goto(`${app}/settings/organization`, { waitUntil: "networkidle" });
      assert.equal(peopleResponse.status(), 200);
      const people = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "People", exact: true }) });
      const createUser = people.getByRole("button", { name: "Create User", exact: true });
      const invite = people.getByRole("button", { name: "Invite people", exact: true });
      await createUser.waitFor({ state: "visible" });
      await invite.waitFor({ state: "visible" });
      await createUser.scrollIntoViewIfNeeded();
      for (const control of [people.getByRole("searchbox", { name: "Search people" }), createUser, invite]) {
        const bounds = await control.boundingBox();
        assert(
          bounds && bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1,
          "People toolbar controls must fit the viewport with closed signup and mail enabled"
        );
      }
      await page.screenshot({ path: join(output, `${name}-people.png`), animations: "disabled" });
      for (const [button, title] of [
        [createUser, "Create a new user"],
        [invite, "Invite a new member"],
      ]) {
        await activate(button);
        const dialog = page.getByRole("dialog", { name: title, exact: true });
        await dialog.waitFor({ state: "visible" });
        await activate(dialog.getByRole("button", { name: "Cancel", exact: true }));
        await dialog.waitFor({ state: "hidden" });
      }
      result.operations.push("closed-signup-mail-ready-both-native-people-dialogs", "people-toolbar-fits-viewport");
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
  assert.deepEqual(serverApiCalls, [], "SSR must not depend on the browser API origin");
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
