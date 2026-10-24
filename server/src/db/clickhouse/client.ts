import { createClient } from "@clickhouse/client";
import { QUERY_REQUEST_TIMEOUT_MS } from "./queryLimits.js";

export const CLICKHOUSE_REQUEST_TIMEOUT_MS = 300_000;

// The SDK lets credentials and query-string options override createClient's
// explicit settings. Keep that behavior for the main connection, but never
// inherit its identity, headers, token, profiles or limits for custom SQL.
const mainUrl = (() => {
  try {
    return new URL(process.env.CLICKHOUSE_HOST ?? "http://localhost:8123");
  } catch {
    // URL's native error can include the complete input (including passwords).
    throw new Error("ClickHouse URL is malformed");
  }
})();
// Match the installed SDK's precedence: /database in the URL overrides the
// separate database option. Provisioning and attestation must name the same
// events table that both clients actually query, not an overridden env value.
export const CLICKHOUSE_DATABASE =
  mainUrl.pathname.trim().length > 1 ? mainUrl.pathname.slice(1) : (process.env.CLICKHOUSE_DB ?? "default");
// The SDK accepts arbitrary http_header_* URL options. It supplies Basic Auth
// too, but ClickHouse/proxies can interpret the other authentication headers;
// the URL username alone cannot prove which principal will execute SQL.
const AUTH_HEADERS = new Set([
  "authorization",
  "x-clickhouse-user",
  "x-clickhouse-key",
  "x-clickhouse-ssl-certificate-auth",
]);
const hasAuthHeaderOverride = [...mainUrl.searchParams.keys()].some(
  name => name.startsWith("http_header_") && AUTH_HEADERS.has(name.slice("http_header_".length).toLowerCase())
);
export const CLICKHOUSE_MAIN_USER: string | null =
  mainUrl.searchParams.has("access_token") || hasAuthHeaderOverride
    ? null // Unknown principal: provisioning and custom SQL must fail closed.
    : mainUrl.username
      ? decodeURIComponent(mainUrl.username)
      : "default";
const queryUrl = new URL(mainUrl);
const queryPathname = mainUrl.searchParams.get("pathname") ?? undefined;
queryUrl.username = "";
queryUrl.password = "";
queryUrl.search = "";
queryUrl.hash = "";

export const clickhouse = createClient({
  url: process.env.CLICKHOUSE_HOST,
  database: process.env.CLICKHOUSE_DB,
  password: process.env.CLICKHOUSE_PASSWORD,
  request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS,
  // Gzip query results on the wire (sends enable_http_compression=1 and
  // Accept-Encoding: gzip). Dashboard results such as session lists and replay
  // events can be MBs of JSON, and ClickHouse usually runs on another host.
  // Inserts stay uncompressed: gzipping every batch would cost Node CPU on the
  // ingestion path. The main user is never readonly=1 (it inserts), so it can
  // set enable_http_compression.
  compression: { response: true, request: false },
  clickhouse_settings: {
    // Writers serialise every instant as ISO-8601 with an explicit `Z` (see
    // dateTime.ts). The default `basic` parser rejects the offset; best_effort
    // honours it, so the stored epoch no longer depends on the server timezone.
    // Only affects parsing of inserted text, not date functions in queries.
    date_time_input_format: "best_effort",
  },
});

// Least-privilege connection for user-authored SQL (custom query page and
// dashboard cards). queryUser.ts provisions `rybbit_query` at startup with
// SELECT on the events table only, a row policy limiting it to the sites in
// each request's siteScopeHeaders(), no table-function grants
// (url/s3/file/remote…), readonly=2, and its own memory/time/concurrency
// limits. The SQL validator is defense-in-depth on top of this — a validator
// bypass must still land inside these grants and the caller's sites.
export const CLICKHOUSE_QUERY_USER = process.env.CLICKHOUSE_QUERY_USER || "rybbit_query";

// No response compression here: results are capped at 1,000 rows, and a
// hand-created readonly=1 user would reject the enable_http_compression setting.
export const clickhouseQuery = createClient({
  url: queryUrl.toString(),
  // In the SDK URL.pathname selects the database; the separate pathname
  // option selects a reverse-proxy endpoint. Retain both routing meanings.
  pathname: queryPathname,
  database: process.env.CLICKHOUSE_DB,
  username: CLICKHOUSE_QUERY_USER,
  password: process.env.CLICKHOUSE_QUERY_PASSWORD || process.env.CLICKHOUSE_PASSWORD,
  request_timeout: QUERY_REQUEST_TIMEOUT_MS,
});
