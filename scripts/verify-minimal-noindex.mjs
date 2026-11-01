import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_MISSING_PATH = "/api/__wotcv_minimal_noindex_missing_3c72f1";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export function parseBaseOrigin(value) {
  if (typeof value !== "string" || !/^https?:\/\/[^@/?#\\\s\u0000-\u001f\u007f]+\/?$/i.test(value))
    throw new Error("invalid-base-origin");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid-base-origin");
  }
  if (url.username || url.password || url.pathname !== "/") throw new Error("invalid-base-origin");
  const loopback =
    url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("https-or-loopback-required");
  return url.origin;
}

function missingPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 512 ||
    /[?#\\\s\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("invalid-missing-path");
  return value;
}

function values(rawHeaders, name) {
  const result = [];
  for (let i = 0; i < rawHeaders.length; i += 2)
    if (rawHeaders[i].toLowerCase() === name) result.push(rawHeaders[i + 1]);
  return result;
}

function readResponse(url, method, timeoutMs, maxBodyBytes) {
  return new Promise((resolveResponse, reject) => {
    let finished = false;
    const settle = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(new Error(error)) : resolveResponse(value);
    };
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method,
        agent: false,
        maxHeaderSize: 32 * 1024,
        headers: { "accept-encoding": "identity", "user-agent": "wotcv-minimal-noindex-verifier/1" },
      },
      response => {
        const chunks = [];
        let bytes = 0;
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > maxBodyBytes) {
            settle("body-limit");
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          settle(null, {
            status: response.statusCode ?? 0,
            rawHeaders: response.rawHeaders,
            body: Buffer.concat(chunks),
            bytes,
          })
        );
        response.on("aborted", () => settle("response-aborted"));
        response.on("error", () => settle("transport-error"));
      }
    );
    const timer = setTimeout(() => {
      settle("timeout");
      request.destroy();
    }, timeoutMs);
    request.on("error", () => settle("transport-error"));
    request.end();
  });
}

function inspect(response, probe, method) {
  const issues = [];
  const robots = values(response.rawHeaders, "x-robots-tag");
  if (robots.length !== 1) issues.push("noindex-header-count");
  const tokens = (robots[0] ?? "")
    .toLowerCase()
    .split(",")
    .map(token => token.trim());
  if (!tokens.includes("noindex") || /(?:^|[\s,:])(?:index|all)(?=$|[\s,])/.test((robots[0] ?? "").toLowerCase()))
    issues.push("noindex-policy");
  if (response.status >= 300 && response.status <= 399) issues.push("redirect-not-followed");
  if (!probe.statuses.includes(response.status)) issues.push("unexpected-status");
  const types = values(response.rawHeaders, "content-type");
  const type = (types[0] ?? "").split(";")[0].trim().toLowerCase();
  if (types.length !== 1) issues.push("content-type-header-count");
  if (probe.kind === "html" && type !== "text/html") issues.push("expected-html");
  if (probe.kind === "health") {
    if (type !== "text/plain") issues.push("expected-native-health-type");
    if (method === "GET" && response.body.toString("utf8") !== "OK") issues.push("expected-native-health-ok");
  }
  if (probe.kind === "script") {
    if (!["application/javascript", "text/javascript", "application/x-javascript"].includes(type))
      issues.push("expected-javascript-type");
    if (
      method === "GET" &&
      (!response.bytes || /^\s*(?:\uFEFF)?\s*<(?:!doctype|html|head|body|!--)/i.test(response.body.toString("utf8")))
    )
      issues.push("expected-javascript-body");
  }
  if (probe.kind === "manifest") {
    const lengths = values(response.rawHeaders, "content-length");
    const cache = values(response.rawHeaders, "cache-control");
    const cacheTokens = (cache[0] ?? "")
      .toLowerCase()
      .split(",")
      .map(token => token.trim());
    if (lengths.length !== 1 || lengths[0] !== "0") issues.push("manifest-content-length-not-zero");
    if (response.bytes !== 0) issues.push("manifest-body-not-empty");
    if (values(response.rawHeaders, "transfer-encoding").length) issues.push("manifest-transfer-encoding");
    if (type !== "text/plain") issues.push("manifest-content-type");
    if (
      cache.length !== 1 ||
      !cacheTokens.includes("no-store") ||
      cacheTokens.some(token => token === "public" || token === "immutable" || /^(?:s-maxage|max-age)\s*=/.test(token))
    )
      issues.push("manifest-cache-policy");
  }
  return issues;
}

export async function verifyMinimalNoindex(baseUrl, options = {}) {
  const base = parseBaseOrigin(baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const target = options.target ?? "unspecified";
  if (!["origin", "public", "unspecified"].includes(target)) throw new Error("invalid-target");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("invalid-timeout");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 4 * 1024 * 1024)
    throw new Error("invalid-body-limit");
  const missing = missingPath(options.missingPath ?? DEFAULT_MISSING_PATH);
  const probes = [
    { name: "home", path: "/", kind: "html", statuses: [200] },
    { name: "login", path: "/login", kind: "html", statuses: [200] },
    { name: "health", path: "/api/health", kind: "health", statuses: [200] },
    { name: "script", path: "/api/script.js", kind: "script", statuses: [200] },
    { name: "missing", path: missing, kind: "missing", statuses: [404, 410] },
    { name: "robots", path: "/robots.txt", kind: "manifest", statuses: [410] },
    { name: "sitemap", path: "/sitemap.xml", kind: "manifest", statuses: [410] },
  ];
  const results = [];
  for (const probe of probes) {
    for (const method of ["GET", "HEAD"]) {
      try {
        const response = await readResponse(new URL(probe.path, `${base}/`), method, timeoutMs, maxBodyBytes);
        const issues = inspect(response, probe, method);
        results.push({
          name: probe.name,
          method,
          status: response.status,
          bytes: response.bytes,
          ok: issues.length === 0,
          issues,
        });
      } catch (error) {
        const code = ["timeout", "body-limit", "response-aborted", "transport-error"].includes(error?.message)
          ? error.message
          : "request-failed";
        results.push({ name: probe.name, method, status: null, bytes: null, ok: false, issues: [code] });
      }
    }
  }
  return { target, ok: results.every(result => result.ok), results };
}

export function formatNoindexReport(report) {
  return [
    ...report.results.map(
      result =>
        `${result.ok ? "PASS" : "FAIL"} ${report.target} ${result.method} ${result.name} status=${result.status ?? "unavailable"} bytes=${result.bytes ?? "unknown"}${result.issues.length ? ` issues=${result.issues.join(",")}` : ""}`
    ),
    `${report.ok ? "PASS" : "FAIL"} ${report.target} ${report.results.length} read-only probes; redirects were not followed; bodies and header values are not printed.`,
  ].join("\n");
}

export async function main(args, output = text => process.stdout.write(`${text}\n`)) {
  const usage =
    "Usage: node scripts/verify-minimal-noindex.mjs --target origin|public --base-url https://candidate.example.com [--timeout-ms 5000] [--max-body-bytes 1048576] [--missing-path /api/__known_missing]";
  if (args.length === 1 && args[0] === "--help") {
    output(usage);
    return 0;
  }
  try {
    const parsed = {};
    const allowed = new Set(["--target", "--base-url", "--timeout-ms", "--max-body-bytes", "--missing-path"]);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      if (!allowed.has(key) || parsed[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("invalid-arguments");
      parsed[key] = args[i + 1];
    }
    if (!parsed["--base-url"] || !["origin", "public"].includes(parsed["--target"]))
      throw new Error("explicit-base-and-target-required");
    const report = await verifyMinimalNoindex(parsed["--base-url"], {
      target: parsed["--target"],
      ...(parsed["--timeout-ms"] ? { timeoutMs: Number(parsed["--timeout-ms"]) } : {}),
      ...(parsed["--max-body-bytes"] ? { maxBodyBytes: Number(parsed["--max-body-bytes"]) } : {}),
      ...(parsed["--missing-path"] ? { missingPath: parsed["--missing-path"] } : {}),
    });
    output(formatNoindexReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    const codes = [
      "invalid-base-origin",
      "https-or-loopback-required",
      "invalid-missing-path",
      "invalid-target",
      "invalid-timeout",
      "invalid-body-limit",
      "invalid-arguments",
      "explicit-base-and-target-required",
    ];
    output(`FAIL configuration: ${codes.includes(error?.message) ? error.message : "invalid-configuration"}`);
    output(usage);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await main(process.argv.slice(2));
