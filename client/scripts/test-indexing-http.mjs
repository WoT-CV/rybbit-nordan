// Checks the built client on a temporary loopback server, with no browser or backend calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = createServer();
await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
const origin = `http://127.0.0.1:${address.port}`;
const child = spawn(
  process.execPath,
  [
    join(clientRoot, "node_modules/next/dist/bin/next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(address.port),
  ],
  { cwd: clientRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] }
);
let output = "";
child.stdout.on("data", chunk => (output += chunk));
child.stderr.on("data", chunk => (output += chunk));

const expectedHeader = "noindex, nofollow, nosnippet, noimageindex";
let checked = 0;
async function request(path, method = "GET", expectedStatus = 200) {
  const response = await fetch(`${origin}${path}`, { method, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, expectedStatus, `${method} ${path}: status`);
  assert.equal(response.headers.get("x-robots-tag"), expectedHeader, `${method} ${path}: noindex header`);
  checked++;
  return response;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/icon.svg`, { signal: AbortSignal.timeout(1_000) });
      await response.arrayBuffer();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Next production server did not become ready");

  for (const path of [
    "/",
    "/login",
    "/signup",
    "/try",
    "/7/aaaaaaaaaaaa/main",
    "/7/main?embed=true",
    "/unknown.html",
  ]) {
    const html = await (await request(path)).text();
    assert.match(html, /<meta name="robots" content="noindex, nofollow, nosnippet, noimageindex"\s*\/?\s*>/);
    assert.doesNotMatch(
      html,
      /<link[^>]+rel="canonical"|<meta[^>]+(?:property="og:|name="twitter:)|application\/ld\+json/
    );
  }
  await (await request("/icon.svg")).arrayBuffer();
  const widget = await (await request("/widget/abcdef123456")).text();
  assert.match(widget, /<!doctype html>/i);
  await (await request("/widget/%21", "GET", 400)).text();
  await (await request("/unknown/noindex/missing", "GET", 404)).text();

  for (const path of ["/robots.txt", "/sitemap.xml"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(path, method, 410);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "");
    }
  }
  assert.equal(await (await request("/login", "HEAD")).text(), "");
  for (const [path, destination] of [
    ["/7?session_id=cs_test", "/7/main?session_id=cs_test"],
    ["/7/aaaaaaaaaaaa?claim=1", "/7/aaaaaaaaaaaa/main?claim=1"],
    ["/auth/callback/google?code=test", "/api/auth/callback/google?code=test"],
  ]) {
    const response = await request(path, "GET", 307);
    const location = response.headers.get("location");
    assert.ok(location);
    assert.equal(new URL(location, origin).href, `${origin}${destination}`);
    await response.arrayBuffer();
  }
  console.log(`Client indexing HTTP checks passed (${checked} responses).`);
} catch (error) {
  if (output) console.error(output);
  throw error;
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
