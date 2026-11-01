import type { ReplayCorrelationProfile } from "@rybbit/shared";

type ScopedProfile = ReplayCorrelationProfile & { siteIds: number[] };
const invalid = () => new Error("Invalid replay correlation configuration");
const label = (value: unknown, max = 128): value is string =>
  typeof value === "string" && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value) && !/\s/.test(value);

function url(value: unknown, originOnly: boolean): string {
  if (typeof value !== "string" || value.length > (originOnly ? 256 : 2048)) throw invalid();
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.hostname.includes("*"))
      throw invalid();
    if (originOnly) {
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/") throw invalid();
      if (parsed.origin.length > 256) throw invalid();
      return parsed.origin;
    }
    if (parsed.protocol !== "https:") throw invalid();
    const normalized = parsed.href.replace(/\/+$/, "");
    if (normalized.length > 2048) throw invalid();
    return normalized;
  } catch {
    throw invalid();
  }
}

export function parseReplayCorrelationProfiles(raw: string | undefined): ScopedProfile[] {
  if (!raw?.trim()) return [];
  try {
    if (raw.length > 65_536 || Buffer.byteLength(raw, "utf8") > 65_536) throw invalid();
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > 32) throw invalid();
    const seen = new Set<string>();
    let pairs = 0;
    return entries.map(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
      const {
        siteIds,
        requestOrigin,
        grafanaUrl,
        orgId,
        lokiDatasourceUid,
        tempoDatasourceUid,
        serviceName,
        environment,
        timePaddingMs,
      } = entry;
      if (
        !Array.isArray(siteIds) ||
        siteIds.length === 0 ||
        siteIds.length > 100 ||
        siteIds.some(site => !Number.isSafeInteger(site) || site <= 0)
      )
        throw invalid();
      if (!Number.isSafeInteger(orgId) || orgId <= 0) throw invalid();
      if (
        !label(lokiDatasourceUid, 64) ||
        (tempoDatasourceUid !== undefined && !label(tempoDatasourceUid, 64)) ||
        !label(serviceName) ||
        !label(environment)
      )
        throw invalid();
      if (!Number.isInteger(timePaddingMs) || timePaddingMs < 0 || timePaddingMs > 300_000) throw invalid();
      const origin = url(requestOrigin, true);
      for (const site of siteIds) {
        const key = `${site}:${origin}`;
        if (seen.has(key) || ++pairs > 512) throw invalid();
        seen.add(key);
      }
      return {
        siteIds: [...siteIds],
        requestOrigin: origin,
        grafanaUrl: url(grafanaUrl, false),
        orgId,
        lokiDatasourceUid,
        ...(tempoDatasourceUid !== undefined ? { tempoDatasourceUid } : {}),
        serviceName,
        environment,
        timePaddingMs,
      };
    });
  } catch {
    throw invalid();
  }
}

export function getReplayCorrelationProfiles(siteId: number): ReplayCorrelationProfile[] {
  return parseReplayCorrelationProfiles(process.env.WOTCV_REPLAY_CORRELATION_JSON)
    .filter(profile => profile.siteIds.includes(siteId))
    .map(({ siteIds: _siteIds, ...profile }) => profile);
}
