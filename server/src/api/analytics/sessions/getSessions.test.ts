import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const mocks = vi.hoisted(() => ({
  resolveUserIdentity: vi.fn(),
  query: vi.fn(),
  enrichWithTraits: vi.fn(),
}));

vi.mock("../../../db/clickhouse/clickhouse.js", () => ({ clickhouse: { query: mocks.query } }));
vi.mock("../utils/utils.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../utils/utils.js")>()),
  enrichWithTraits: mocks.enrichWithTraits,
}));

vi.mock("../../../services/userIdentity/userIdentityService.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/userIdentity/userIdentityService.js")>()),
  resolveUserIdentity: mocks.resolveUserIdentity,
}));

import { buildSessionsQuery, getSessions } from "./getSessions.js";
import { REPLAY_LOOKUP_QUERY } from "./sessionQuery.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveUserIdentity.mockResolvedValue({
    canonicalUserId: "account-42",
    anonymousIds: ["device-a", "device-b"],
  });
  mocks.enrichWithTraits.mockImplementation(async rows => rows);
});

describe("buildSessionsQuery", () => {
  it("combines resolved identity, event membership, and projected feature flag filters", async () => {
    const querySpec = await buildSessionsQuery(
      {
        start_date: "",
        end_date: "",
        time_zone: "UTC",
        filters: JSON.stringify([
          { parameter: "user_id", type: "equals", value: ["account-42"] },
          { parameter: "pathname", type: "equals", value: ["/history"] },
          { parameter: "feature_flag:checkout", type: "equals", value: ["variant-a"] },
        ]),
        page: 1,
        limit: 25,
      },
      42
    );

    expect(querySpec.query).toContain("dictGetOrDefault('user_identity_dict'");
    expect(querySpec.query).toContain("toUInt64(events.site_id)");
    expect(querySpec.query).toContain("argMax(feature_flags, timestamp_ms) AS feature_flags");
    const outerFilter = querySpec.query.slice(querySpec.query.lastIndexOf("WHERE 1 = 1"));
    expect(outerFilter).toContain("if(identified_user_id != '', identified_user_id, user_id) = 'account-42'");
    expect(outerFilter).toContain("AND pathname = '/history'");
    expect(outerFilter).toContain("feature_flags['checkout'] = 'variant-a'");
    expect(outerFilter).not.toContain("dictGet");
    expect(querySpec.query).toContain("argMinIf(pathname, timestamp_ms, type = 'pageview')");
    expect(querySpec.query).not.toContain("session_replay_metadata");
    expect(REPLAY_LOOKUP_QUERY).toContain("FROM session_replay_metadata\n");
    expect(REPLAY_LOOKUP_QUERY).not.toContain("session_replay_metadata_v2");
  });

  it("immediately returns linked anonymous sessions as the canonical user", async () => {
    const querySpec = await buildSessionsQuery(
      {
        user_id: "device-a",
        start_date: "",
        end_date: "",
        time_zone: "UTC",
        filters: "",
        page: 1,
        limit: 25,
      },
      42,
      undefined,
      { canonicalUserId: "account-42", anonymousIds: ["device-a", "device-b"] }
    );

    expect(querySpec.query).toContain("events.identified_user_id = {canonicalUserId:String}");
    expect(querySpec.query).toContain("events.user_id IN ({anonymousIds:Array(String)})");
    expect(querySpec.query).toContain(
      "if(has({anonymousIds:Array(String)}, events.user_id), {canonicalUserId:String}, '')"
    );
    expect(querySpec.query).not.toContain("dictGetOrDefault");
    expect(querySpec.params).toMatchObject({
      siteId: 42,
      canonicalUserId: "account-42",
      anonymousIds: ["device-a", "device-b"],
    });
  });

  it("keeps dictionary-based resolution for the unfiltered sessions list", async () => {
    const querySpec = await buildSessionsQuery(
      {
        start_date: "",
        end_date: "",
        time_zone: "UTC",
        filters: "",
        page: 1,
        limit: 25,
      },
      42
    );

    expect(mocks.resolveUserIdentity).not.toHaveBeenCalled();
    expect(querySpec.query).toContain("dictGetOrDefault('user_identity_dict'");
    expect(querySpec.params).not.toHaveProperty("canonicalUserId");
    expect(querySpec.params).not.toHaveProperty("anonymousIds");
  });

  it("resolves the requested alias before querying and preserves v1 replay and feature flags in the response", async () => {
    const row = {
      session_id: "old-session",
      user_id: "device-b",
      identified_user_id: "account-42",
      feature_flags: { checkout: "variant-a" },
      converted_goal_ids: [],
      last_goal_ids: [],
    };
    mocks.query
      .mockResolvedValueOnce({ json: async () => [row] })
      .mockResolvedValueOnce({ json: async () => [{ session_id: "old-session" }] });
    const app = Fastify();
    app.get("/sites/:siteId/sessions", getSessions);
    try {
      const response = await app.inject({
        url: "/sites/42/sessions?user_id=device-a&start_date=&end_date=&time_zone=UTC",
      });

      expect(response.statusCode).toBe(200);
      expect(mocks.resolveUserIdentity).toHaveBeenCalledExactlyOnceWith(42, "device-a");
      const [dataQuery, replayQuery] = mocks.query.mock.calls.map(([spec]) => spec);
      expect(dataQuery.query_params).toMatchObject({
        siteId: 42,
        canonicalUserId: "account-42",
        anonymousIds: ["device-a", "device-b"],
      });
      expect(dataQuery.query).not.toContain("dictGetOrDefault");
      expect(replayQuery.query).toContain("FROM session_replay_metadata\n");
      expect(replayQuery.query_params).toEqual({ siteId: 42, sessionIds: ["old-session"] });
      expect(response.json().data).toEqual([
        {
          session_id: "old-session",
          user_id: "device-b",
          identified_user_id: "account-42",
          feature_flags: { checkout: "variant-a" },
          has_replay: 1,
        },
      ]);
      expect(mocks.enrichWithTraits).toHaveBeenCalledWith(response.json().data, 42);
    } finally {
      await app.close();
    }
  });
});
