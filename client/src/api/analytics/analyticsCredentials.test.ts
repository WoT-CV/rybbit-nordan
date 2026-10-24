import axios, { type AxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getRequestCacheScope, setPrivateKeyResolver } from "../requestContext";
import { buildAnalyticsQueryKey, buildAnalyticsRequest, fetchAnalytics } from "./analyticsRequest";

vi.mock("axios", () => ({ default: vi.fn() }));
const axiosMock = vi.mocked(axios);
const lastRequest = () => axiosMock.mock.calls.at(-1)?.[0] as AxiosRequestConfig;
const context = { time: null, timeZone: "UTC" };

afterEach(() => {
  axiosMock.mockReset();
  setPrivateKeyResolver(() => null);
});

describe("analytics immutable credential context", () => {
  it("binds a delayed request to the private key used to build its cache identity", async () => {
    axiosMock.mockResolvedValue({ data: { data: ["original"] } });
    setPrivateKeyResolver(() => "original-secret");
    const request = buildAnalyticsRequest({ path: "sessions" }, context);
    setPrivateKeyResolver(() => "replacement-secret");
    await expect(fetchAnalytics("1", request)).resolves.toEqual(["original"]);
    expect(lastRequest().headers).toEqual({ "x-private-key": "original-secret" });
    expect(lastRequest()).not.toHaveProperty("requestPrivateKey");
    const key = buildAnalyticsQueryKey(["sessions", "user"], "1", request);
    expect(JSON.stringify(key)).not.toContain("original-secret");
    expect(key.slice(-4)).toEqual([
      "1",
      "sessions",
      { params: { time_zone: "UTC" }, accessScope: request.accessScope },
      undefined,
    ]);
  });

  it("does not attach a later private key to a previously built public POST", async () => {
    axiosMock.mockResolvedValue({ data: { data: [] } });
    const request = buildAnalyticsRequest({ path: "funnels/analyze", body: () => ({ steps: [] }) }, context);
    setPrivateKeyResolver(() => "later-secret");
    await fetchAnalytics("1", request);
    expect(lastRequest().headers).toEqual({});
    expect(lastRequest()).toMatchObject({ method: "POST", data: { steps: [] } });
  });

  it("gives replaced credentials different opaque scopes and preserves an active link's identity", () => {
    const original = getRequestCacheScope("original-secret");
    expect(getRequestCacheScope("original-secret")).toBe(original);
    expect(getRequestCacheScope("replacement-secret")).not.toBe(original);
    expect(getRequestCacheScope(null)).not.toBe(original);
  });

  it("evicts old bearer keys without reusing any previous cache identity", () => {
    const first = getRequestCacheScope("evicted-secret");
    const issued = new Set([first]);
    for (let index = 0; index < 129; index++) {
      const scope = getRequestCacheScope(`subsequent-secret-${index}`);
      expect(issued.has(scope)).toBe(false);
      issued.add(scope);
    }
    const reopened = getRequestCacheScope("evicted-secret");
    expect(issued.has(reopened)).toBe(false);
  });

  it("does not reuse a previous runtime's scopes when the context module reloads", async () => {
    const original = getRequestCacheScope("module-reload-secret");
    vi.resetModules();
    const reloaded = await import("../requestContext");
    expect(reloaded.getRequestCacheScope("module-reload-secret")).not.toBe(original);
  });
});
