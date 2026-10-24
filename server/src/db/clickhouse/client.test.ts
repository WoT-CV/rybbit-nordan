import type { ClickHouseAuth, ClickHouseClientConfigOptions, ClickHouseSettings } from "@clickhouse/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUERY_REQUEST_TIMEOUT_MS } from "./queryLimits.js";

const mocks = vi.hoisted(() => ({ createClient: vi.fn((_options: ClickHouseClientConfigOptions) => ({})) }));

vi.mock("@clickhouse/client", () => ({ createClient: mocks.createClient }));

beforeEach(() => {
  vi.resetModules();
  mocks.createClient.mockClear();
  vi.stubEnv("CLICKHOUSE_HOST", "http://localhost:8123");
  vi.stubEnv("CLICKHOUSE_DB", "env_db");
  vi.stubEnv("CLICKHOUSE_USER", "nominal_but_unused");
  vi.stubEnv("CLICKHOUSE_PASSWORD", "main-env-secret");
  vi.stubEnv("CLICKHOUSE_QUERY_USER", "rybbit_query");
  vi.stubEnv("CLICKHOUSE_QUERY_PASSWORD", "query-env-secret");
});

afterEach(() => vi.unstubAllEnvs());

// Exercise the installed SDK's actual URL precedence, without opening a socket.
// Inspect its resolved connection rather than merely the options we passed in.
async function resolveWithSdk(options: ClickHouseClientConfigOptions) {
  const { createClient } = await vi.importActual<typeof import("@clickhouse/client")>("@clickhouse/client");
  const client = createClient({
    ...options,
    log: {
      LoggerClass: class {
        trace() {}
        debug() {}
        info() {}
        warn() {}
        error() {}
      },
    },
  });
  const params = (
    client as unknown as {
      connectionParams: {
        auth: ClickHouseAuth;
        url: URL;
        database: string;
        request_timeout: number;
        clickhouse_settings: ClickHouseSettings;
        http_headers: Record<string, string>;
      };
    }
  ).connectionParams;
  await client.close();
  return params;
}

// Writers serialise instants as ISO-8601 with an explicit `Z` (dateTime.ts).
// ClickHouse's default `basic` parser rejects the offset, so the write client
// has to ask for best_effort or every insert fails with CANNOT_PARSE_INPUT.
describe("clickhouse write client", () => {
  it("parses inserted timestamps with best_effort", async () => {
    await import("./client.js");

    const writeClientOptions = mocks.createClient.mock.calls[0][0] as {
      clickhouse_settings?: Record<string, unknown>;
    };
    expect(writeClientOptions.clickhouse_settings).toMatchObject({ date_time_input_format: "best_effort" });
  });

  // Results are gzipped on the wire; inserts stay uncompressed so batches don't
  // cost gzip CPU on the ingestion path. The query user may be readonly=1 when
  // created by hand, which rejects enable_http_compression, so it stays off.
  it("compresses query responses but not inserts or user-authored SQL", async () => {
    await import("./client.js");

    const [writeClientOptions, queryClientOptions] = mocks.createClient.mock.calls.map(
      call => call[0] as { compression?: { request?: boolean; response?: boolean } }
    );
    expect(writeClientOptions.compression).toEqual({ response: true, request: false });
    expect(queryClientOptions.compression).toBeUndefined();
  });
});

describe("isolated ClickHouse query URL", () => {
  it("removes URL credentials before the SDK can override the query identity", async () => {
    vi.stubEnv("CLICKHOUSE_HOST", "https://url%5Fmain:url%3Asecret@clickhouse.example:8443/url_db");
    const { CLICKHOUSE_MAIN_USER, CLICKHOUSE_DATABASE } = await import("./client.js");
    const [mainOptions, queryOptions] = mocks.createClient.mock.calls.map(([options]) => options);
    const main = await resolveWithSdk(mainOptions);
    const query = await resolveWithSdk(queryOptions);

    expect(CLICKHOUSE_MAIN_USER).toBe("url_main");
    expect(main.auth).toEqual({ type: "Credentials", username: "url_main", password: "url:secret" });
    expect(query.auth).toEqual({ type: "Credentials", username: "rybbit_query", password: "query-env-secret" });
    expect(query.database).toBe("url_db");
    expect(CLICKHOUSE_DATABASE).toBe(query.database);
    expect(query.url.origin).toBe("https://clickhouse.example:8443");
    expect(queryOptions.url).not.toContain("secret");
  });

  it.each([
    ["http://localhost:8123", "env_db", "env_db"],
    ["http://localhost:8123/", undefined, "default"],
    ["http://localhost:8123", "", ""],
    ["http://localhost:8123/   ", "env_db", "env_db"],
    ["http://localhost:8123/%20", "env_db", "%20"],
    ["http://localhost:8123/%2Fencoded", "env_db", "%2Fencoded"],
    ["http://localhost:8123/nested/db", "env_db", "nested/db"],
    ["http://localhost:8123/url_db", undefined, "url_db"],
    ["http://localhost:8123/url_db?pathname=%2Fproxy", "env_db", "url_db"],
  ])("resolves the same database as the SDK for %s", async (host, database, expected) => {
    vi.stubEnv("CLICKHOUSE_HOST", host);
    vi.stubEnv("CLICKHOUSE_DB", database);
    const { CLICKHOUSE_DATABASE } = await import("./client.js");
    const main = await resolveWithSdk(mocks.createClient.mock.calls[0][0]);
    const query = await resolveWithSdk(mocks.createClient.mock.calls[1][0]);

    expect(main.database).toBe(expected);
    expect(query.database).toBe(expected);
    expect(CLICKHOUSE_DATABASE).toBe(expected);
  });

  it("drops every setting/header override while retaining database and proxy endpoint paths", async () => {
    const host = new URL("https://url_main:url_secret@clickhouse.example/url_db");
    for (const [name, value] of Object.entries({
      ch_readonly: "0",
      clickhouse_setting_profile: "main_profile",
      "http_header_X-ClickHouse-User": "url_main",
      http_header_Authorization: "main-authorization",
      request_timeout: "900000",
      max_open_connections: "99",
      session_id: "main-session",
      compression_response: "1",
      pathname: "/clickhouse/proxy/",
    }))
      host.searchParams.set(name, value);
    vi.stubEnv("CLICKHOUSE_HOST", host.toString());
    await import("./client.js");
    const [mainOptions, queryOptions] = mocks.createClient.mock.calls.map(([options]) => options);
    const main = await resolveWithSdk(mainOptions);
    const query = await resolveWithSdk(queryOptions);

    expect(mainOptions.url).toBe(host.toString());
    expect(main.clickhouse_settings).toMatchObject({ readonly: "0", profile: "main_profile" });
    expect(query.clickhouse_settings).toEqual({});
    expect(query.http_headers).toEqual({});
    expect(query.request_timeout).toBe(QUERY_REQUEST_TIMEOUT_MS);
    expect(query.database).toBe("url_db");
    expect(query.url.pathname).toBe("/clickhouse/proxy/");
    expect(new URL(String(queryOptions.url)).search).toBe("");
    expect(queryOptions).not.toHaveProperty("session_id");
  });

  it("uses the SDK's real default principal rather than the unused CLICKHOUSE_USER env", async () => {
    const { CLICKHOUSE_MAIN_USER } = await import("./client.js");
    const main = await resolveWithSdk(mocks.createClient.mock.calls[0][0]);

    expect(main.auth).toMatchObject({ type: "Credentials", username: "default" });
    expect(CLICKHOUSE_MAIN_USER).toBe("default");
  });

  it("marks a token-authenticated main principal unknown and never passes the token to query SQL", async () => {
    vi.stubEnv("CLICKHOUSE_HOST", "https://clickhouse.example/db?access_token=main-token&pathname=%2Fproxy");
    vi.stubEnv("CLICKHOUSE_PASSWORD", undefined);
    const { CLICKHOUSE_MAIN_USER } = await import("./client.js");
    const [mainOptions, queryOptions] = mocks.createClient.mock.calls.map(([options]) => options);
    const main = await resolveWithSdk(mainOptions);
    const query = await resolveWithSdk(queryOptions);

    expect(main.auth).toEqual({ type: "JWT", access_token: "main-token" });
    expect(CLICKHOUSE_MAIN_USER).toBeNull();
    expect(query.auth).toEqual({ type: "Credentials", username: "rybbit_query", password: "query-env-secret" });
    expect(query.url.pathname).toBe("/proxy");
    expect(queryOptions.url).not.toContain("main-token");
  });

  it.each([
    "Authorization",
    "aUtHoRiZaTiOn",
    "X-ClickHouse-User",
    "x-clickhouse-user",
    "X-ClickHouse-Key",
    "x-clickhouse-key",
    "X-ClickHouse-SSL-Certificate-Auth",
    "x-clickhouse-ssl-certificate-auth",
  ])("fails closed for an SDK authentication-header override named %s", async header => {
    const host = new URL("https://url_main:url_secret@clickhouse.example/db");
    host.searchParams.set(`http_header_${header}`, "auth-override");
    vi.stubEnv("CLICKHOUSE_HOST", host.toString());
    const { CLICKHOUSE_MAIN_USER } = await import("./client.js");
    const [mainOptions, queryOptions] = mocks.createClient.mock.calls.map(([options]) => options);
    const main = await resolveWithSdk(mainOptions);
    const query = await resolveWithSdk(queryOptions);

    expect(CLICKHOUSE_MAIN_USER).toBeNull();
    // Preserve the write client's existing URL/config rather than silently
    // changing its authentication. Only our custom-SQL safety gate closes.
    expect(mainOptions.url).toBe(host.toString());
    expect(main.http_headers).toEqual({ [header]: "auth-override" });
    expect(query.http_headers).toEqual({});
    expect(query.auth).toMatchObject({ type: "Credentials", username: "rybbit_query" });
    expect(new URL(String(queryOptions.url)).search).toBe("");
  });

  it("keeps a provable URL principal when its custom header is not authentication", async () => {
    const host = new URL("https://url_main:url_secret@clickhouse.example/db");
    host.searchParams.set("http_header_X-Request-Id", "trace-only");
    vi.stubEnv("CLICKHOUSE_HOST", host.toString());
    const { CLICKHOUSE_MAIN_USER } = await import("./client.js");
    const [mainOptions, queryOptions] = mocks.createClient.mock.calls.map(([options]) => options);
    const main = await resolveWithSdk(mainOptions);
    const query = await resolveWithSdk(queryOptions);

    expect(CLICKHOUSE_MAIN_USER).toBe("url_main");
    expect(main.http_headers).toEqual({ "X-Request-Id": "trace-only" });
    expect(query.http_headers).toEqual({});
  });

  it("retains the existing main-password fallback without inheriting a URL password", async () => {
    vi.stubEnv("CLICKHOUSE_HOST", "https://url_main:url_secret@clickhouse.example");
    vi.stubEnv("CLICKHOUSE_QUERY_PASSWORD", undefined);
    await import("./client.js");
    const query = await resolveWithSdk(mocks.createClient.mock.calls[1][0]);

    expect(query.auth).toEqual({ type: "Credentials", username: "rybbit_query", password: "main-env-secret" });
  });

  it("does not include malformed URL credentials in its validation error", async () => {
    vi.stubEnv("CLICKHOUSE_HOST", "https://main:do-not-log-this-password@[");
    await expect(import("./client.js")).rejects.toThrow(/^ClickHouse URL is malformed$/);
  });
});
