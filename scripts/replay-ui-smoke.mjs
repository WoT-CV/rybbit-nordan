import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Actual local Next frontend and rrweb player; every API response is synthetic.
// No production requests, credentials, writes or recordings are used.
if (process.argv.length !== 5)
  throw new Error(
    "Usage: node scripts/replay-ui-smoke.mjs <playwright-index.mjs> <local-app-origin> <local-api-origin>"
  );
const [playwrightPath, appArg, apiArg] = process.argv.slice(2);
function localOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Synthetic UI smoke accepts only a local HTTP origin");
  return url.origin;
}
const app = localOrigin(appArg);
const api = localOrigin(apiArg);
const { chromium, webkit, devices } = await import(pathToFileURL(playwrightPath).href);
const output = await mkdtemp(join(tmpdir(), "rybbit-replay-ui-"));
console.log("Synthetic UI evidence: " + output);
const start = Date.parse("2026-10-24T10:00:00Z");
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
const subscription = {
  planName: "self-hosted",
  status: "active",
  eventLimit: 100000000,
  monthlyEventCount: 1,
  overMonthlyLimit: false,
};
const user = { id: "qa-user", email: "qa@example.test", name: "Synthetic QA", emailVerified: true, role: "user" };
const session = {
  session: {
    id: "qa-auth",
    userId: user.id,
    activeOrganizationId: organization.id,
    token: "synthetic-only",
    expiresAt: "2030-01-01T00:00:00Z",
  },
  user,
};
const metadata = {
  session_id: "qa-replay",
  user_id: "qa-browser",
  identified_user_id: "",
  traits: { name: "Synthetic replay" },
  start_time: "2026-10-24 10:00:00",
  end_time: "2026-10-24 10:05:00",
  duration_ms: 300000,
  page_url: "https://example.test/synthetic",
  event_count: 303,
  compressed_size_bytes: 200000,
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
              childNodes: [{ type: 3, id: 7, textContent: "Synthetic replay fixture" }],
            },
            ...Array.from({ length: 750 }, (_, i) => ({
              type: 2,
              id: 10 + i * 2,
              tagName: "div",
              attributes: {},
              childNodes: [{ type: 3, id: 11 + i * 2, textContent: `Synthetic row ${i}: Zażółć gęślą jaźń` }],
            })),
          ],
        },
      ],
    },
  ],
};
const events = [
  { type: 4, timestamp: start, data: { href: metadata.page_url, width: 390, height: 844 } },
  { type: 2, timestamp: start + 1, data: { node: snapshot, initialOffset: { left: 0, top: 0 } } },
  ...Array.from({ length: 300 }, (_, i) => ({
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
];
const configs = {
  disableSignup: true,
  liteDashboard: false,
  mapboxToken: "",
  capabilities: {
    googleSearchConsole: false,
    objectStorage: false,
    socialProviders: { github: false, google: false },
    transactionalEmail: false,
    turnstile: false,
    weeklyReports: false,
    unclaimedSites: false,
  },
};
const report = [];
for (const [name, engine, mobile] of [
  ["webkit-mobile", webkit, true],
  ["chromium-mobile", chromium, true],
  ["chromium-desktop", chromium, false],
]) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({
      ...(mobile ? devices["iPhone 13"] : { viewport: { width: 1440, height: 1000 } }),
      locale: "en-US",
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const errors = [],
      warnings = [],
      apiCalls = [],
      unexpected = [],
      externalStubs = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.route("**/*", async route => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === api || (url.origin === app && url.pathname.startsWith("/api/"))) {
        assert(["GET", "OPTIONS"].includes(request.method()), "UI smoke must not issue an API mutation");
        apiCalls.push({ method: request.method(), path: url.pathname });
        const path = url.pathname;
        let body;
        if (request.method() === "OPTIONS") body = {};
        else if (path.endsWith("/get-session")) body = session;
        else if (path.includes("get-full-organization")) body = organization;
        else if (path.endsWith("/organization/list") || path.endsWith("/user/organizations")) body = [organization];
        else if (path.endsWith("/organization/list-teams") || path.endsWith("/organization/list-user-teams")) body = [];
        else if (path.endsWith("/config")) body = configs;
        else if (path.endsWith("/version")) body = { version: "2.9.1" };
        else if (path.endsWith("/is-public")) body = { isPublic: false };
        else if (path.endsWith("/has-data")) body = { hasData: true };
        else if (path.endsWith("/live-user-count")) body = { count: 0 };
        else if (path.endsWith("/private-link-config")) body = { success: true, data: { privateLinkKey: null } };
        else if (path.endsWith("/favicon")) {
          await route.fulfill({ status: 204, body: "" });
          return;
        } else if (path.endsWith("/organizations/qa-org/sites"))
          body = { organization, role: "owner", permissions, sites: [site], subscription };
        else if (path.endsWith("/sites/2")) body = site;
        else if (path.endsWith("/session-replay/list")) body = { data: [metadata], totalCount: 1 };
        else if (path.endsWith("/session-replay/qa-replay")) body = { events, metadata };
        else if (path.includes("observability")) body = { profiles: [] };
        else if (path.endsWith("/site/2")) body = site;
        else if (path.includes("/live-users") || path.includes("/active-sessions"))
          body = { data: [], count: 0, total: 0 };
        else {
          unexpected.push(path);
          body = { data: [], count: 0, total: 0 };
        }
        await route.fulfill({
          status: request.method() === "OPTIONS" ? 204 : 200,
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": app,
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": "Content-Type,Authorization",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "cache-control": "no-store",
          },
          body: request.method() === "OPTIONS" ? "" : JSON.stringify(body),
        });
      } else if (url.origin === app) await route.continue();
      else {
        externalStubs.push({ origin: url.origin, path: url.pathname, type: request.resourceType() });
        await route.fulfill({ status: 204, body: "" });
      }
    });
    await page.goto(`${app}/2/replay`, { waitUntil: "networkidle", timeout: 120000 });
    await page.screenshot({ path: `${output}/rybbit-${name}-initial.png`, fullPage: false });
    const cards = page.locator('[role="button"][aria-pressed]');
    await cards.first().waitFor({ state: "visible", timeout: 15000 });
    if (mobile) await cards.first().tap();
    else await cards.first().click();
    const dialog = page.getByRole("dialog", { name: "Session Replay" });
    await page.locator(".rr-player").first().waitFor({ state: "visible", timeout: 20000 });
    const speeds = page.getByRole("combobox");
    const beforeControls = await speeds.allTextContents();
    console.log(JSON.stringify({ name, url: page.url(), title: await page.title(), beforeControls, errors }));
    assert.equal(page.url().split("?")[0], `${app}/2/replay`);
    assert.equal(await page.locator("nextjs-portal").filter({ hasText: /error/i }).count(), 0);
    assert.equal(errors.length, 0, `${name}: console/page errors`);
    // Hide only Next's development badge, which otherwise covers the mobile
    // play button. Console/page/hydration errors remain fatal assertions.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    assert.equal(await page.locator(".rr-player").count(), 1, `${name}: one active player`);
    const activate = locator => (mobile ? locator.tap() : locator.click());
    const operations = [];
    await page.screenshot({ path: `${output}/rybbit-${name}-before-controls.png`, fullPage: false });
    for (const speed of ["2x", "4x", "0.5x", "1x", "4x", "1x"]) {
      await activate(page.getByRole("combobox", { name: "Playback speed", exact: true }));
      await activate(page.getByRole("option", { name: speed, exact: true }));
      assert.equal(await page.getByRole("combobox", { name: "Playback speed", exact: true }).innerText(), speed);
      assert.equal(await page.locator(".rr-player").count(), 1);
      if (mobile) assert.equal(await dialog.count(), 1);
      operations.push(`speed:${speed}`);
    }
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    if (await pause.count()) await activate(pause);
    const thumb = page.getByRole("slider", { name: "Replay position", exact: true });
    const rail = thumb.locator("xpath=ancestor::*[@dir and @data-orientation][1]");
    const railBox = await rail.boundingBox();
    assert(railBox && railBox.width > 0 && railBox.height >= 16, "slider root must cover the visible thumb touch area");
    for (const fraction of [0.2, 0.8, 0.4, 0.65]) {
      if (mobile) await page.touchscreen.tap(railBox.x + railBox.width * fraction, railBox.y + railBox.height / 2);
      else await page.mouse.click(railBox.x + railBox.width * fraction, railBox.y + railBox.height / 2);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: `${output}/rybbit-${name}-seek.png` });
      await page.waitForFunction(
        ({ fraction }) =>
          Math.abs(
            Number(
              document.querySelector('[role="slider"][aria-label="Replay position"]')?.getAttribute("aria-valuenow")
            ) -
              fraction * 100
          ) < 3,
        { fraction },
        { timeout: 5000 }
      );
      assert.equal(await page.locator(".rr-player").count(), 1);
      operations.push(`seek:${fraction}`);
    }
    const thumbBox = await thumb.boundingBox();
    await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(railBox.x + railBox.width * 0.35, railBox.y + railBox.height / 2, { steps: 40 });
    await page.mouse.up();
    assert.equal(await page.locator(".rr-player").count(), 1);
    operations.push("pointer-drag:40-moves");
    if (mobile) {
      await page.touchscreen.tap(5, 5);
      assert.equal(await dialog.count(), 1, "backdrop must not close replay");
      operations.push("outside-tap:retained");
      const beforeRotate = Number(await thumb.getAttribute("aria-valuenow"));
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => window.matchMedia("(min-width: 768px)").matches);
      await dialog.waitFor({ state: "detached" });
      await page.locator(".rr-player").waitFor({ state: "visible" });
      await page.waitForFunction(
        value =>
          Math.abs(
            Number(
              document.querySelector('[role="slider"][aria-label="Replay position"]')?.getAttribute("aria-valuenow")
            ) - value
          ) < 2,
        beforeRotate
      );
      assert.equal(await page.locator(".rr-player").count(), 1);
      await page.setViewportSize({ width: 390, height: 844 });
      await dialog.waitFor({ state: "visible" });
      await page.locator(".rr-player").waitFor({ state: "visible" });
      await page.waitForFunction(
        value =>
          Math.abs(
            Number(
              document.querySelector('[role="slider"][aria-label="Replay position"]')?.getAttribute("aria-valuenow")
            ) - value
          ) < 2,
        beforeRotate
      );
      assert.equal(await page.locator(".rr-player").count(), 1);
      assert.equal(await dialog.evaluate(el => el.scrollTop), 0, "focus must not scroll the clipped replay panel");
      operations.push("portrait-landscape-portrait:retained");
    }
    await activate(page.getByRole("button", { name: "Play", exact: true }));
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.screenshot({ path: `${output}/rybbit-${name}-opened.png`, fullPage: false });
    if (mobile) {
      await activate(dialog.getByRole("button", { name: "Close", exact: true }));
      await dialog.waitFor({ state: "hidden" });
      await page.locator(".rr-player").waitFor({ state: "detached" });
      await activate(cards.first());
      await page.locator(".rr-player").waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector(".rr-player iframe")?.contentDocument?.body?.textContent?.includes("Synthetic")
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      operations.push("close-X-reopen-Escape:passed");
    }
    assert.equal(page.url().split("?")[0], `${app}/2/replay`);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(unexpected.length, 0, JSON.stringify(unexpected));
    report.push({
      name,
      title: await page.title(),
      url: page.url(),
      browser: browser.version(),
      operations,
      errors,
      warnings,
      unexpected,
      externalStubs,
      apiCalls,
    });
    console.log(JSON.stringify({ name, result: "PASS", operations, warnings }));
    await context.close();
  } finally {
    await browser.close();
  }
}
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log("BROWSER REPLAY QA PASS");
