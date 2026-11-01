import { afterEach, describe, expect, it, vi } from "vitest";
import { getReplayCorrelationProfiles, parseReplayCorrelationProfiles } from "./replayCorrelation.js";

const profile = () => ({
  siteIds: [12],
  requestOrigin: "https://api.example.com/",
  grafanaUrl: "https://grafana.example.com/grafana/",
  orgId: 1,
  lokiDatasourceUid: "loki-1",
  tempoDatasourceUid: "tempo-1",
  serviceName: "wotcv-be",
  environment: "prod",
  timePaddingMs: 30_000,
});
afterEach(() => vi.unstubAllEnvs());

describe("operator replay correlation profiles", () => {
  it("defaults off and exposes only the current site's normalized whitelist", () => {
    expect(parseReplayCorrelationProfiles(undefined)).toEqual([]);
    const input = profile();
    vi.stubEnv("WOTCV_REPLAY_CORRELATION_JSON", JSON.stringify([{ ...input, secret: "not-public" }]));
    expect(getReplayCorrelationProfiles(99)).toEqual([]);
    expect(getReplayCorrelationProfiles(12)).toEqual([
      {
        requestOrigin: "https://api.example.com",
        grafanaUrl: "https://grafana.example.com/grafana",
        orgId: 1,
        lokiDatasourceUid: "loki-1",
        tempoDatasourceUid: "tempo-1",
        serviceName: "wotcv-be",
        environment: "prod",
        timePaddingMs: 30_000,
      },
    ]);
  });
  it.each([
    { siteIds: [] },
    { siteIds: [0] },
    { siteIds: [12, 12] },
    { siteIds: Array.from({ length: 101 }, (_, i) => i + 1) },
    { requestOrigin: "https://*.example.com" },
    { requestOrigin: "https://api.example.com/path" },
    { requestOrigin: "https://user:secret@api.example.com" },
    { grafanaUrl: "http://grafana.example.com" },
    { grafanaUrl: "https://grafana.example.com/?token=secret" },
    { orgId: 0 },
    { lokiDatasourceUid: "bad\n" },
    { serviceName: 'service\"}|~"' },
    { environment: "x".repeat(129) },
    { timePaddingMs: 300001 },
  ])("rejects invalid profile %j with a generic error", patch => {
    expect(() => parseReplayCorrelationProfiles(JSON.stringify([{ ...profile(), ...patch }]))).toThrow(
      "Invalid replay correlation configuration"
    );
  });
  it("rejects malformed/oversized JSON, excessive profiles and ambiguous site+origin pairs", () => {
    for (const raw of [
      "sensitive operator input",
      "x".repeat(65537),
      JSON.stringify(Array(33).fill(profile())),
      JSON.stringify([profile(), profile()]),
    ]) {
      try {
        parseReplayCorrelationProfiles(raw);
        throw new Error("expected rejection");
      } catch (error) {
        expect((error as Error).message).toBe("Invalid replay correlation configuration");
        expect((error as { cause?: unknown }).cause).toBeUndefined();
      }
    }
  });

  it("bounds UTF-8 bytes and normalized URLs, not merely input character counts", () => {
    const unicodeJson = JSON.stringify([{ ...profile(), unused: "ą".repeat(33_000) }]);
    expect(unicodeJson.length).toBeLessThan(65_536);
    expect(() => parseReplayCorrelationProfiles(unicodeJson)).toThrow("Invalid replay correlation configuration");
    expect(() =>
      parseReplayCorrelationProfiles(
        JSON.stringify([{ ...profile(), grafanaUrl: `https://grafana.example.com/${"ą".repeat(400)}` }])
      )
    ).toThrow("Invalid replay correlation configuration");
    const idnOrigin = `https://${Array(32).fill("ą").join(".")}`;
    expect(idnOrigin.length).toBeLessThan(256);
    expect(new URL(idnOrigin).origin.length).toBeGreaterThan(256);
    expect(() => parseReplayCorrelationProfiles(JSON.stringify([{ ...profile(), requestOrigin: idnOrigin }]))).toThrow(
      "Invalid replay correlation configuration"
    );
  });
});
