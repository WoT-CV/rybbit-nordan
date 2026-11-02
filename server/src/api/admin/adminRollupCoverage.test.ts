import { beforeEach, describe, expect, it, vi } from "vitest";

type SiteFixture = {
  siteId: number;
  name: string;
  domain: string;
  type: "web";
  organizationId: string;
  createdAt: string;
};
type RollupRow = { site_id: string; total_events: string };
const state = vi.hoisted(() => ({
  unavailable: false,
  cloud: false,
  sites: [] as SiteFixture[],
  rows24h: [] as RollupRow[],
  rows30d: [] as RollupRow[],
  rawHistoricalEvents: [] as { site_id: number }[],
  queries: [] as string[],
}));
const site: SiteFixture = {
  siteId: 12,
  name: "Example",
  domain: "example.com",
  type: "web",
  organizationId: "org1",
  createdAt: "2026-11-01",
};
vi.mock("../../lib/const.js", () => ({
  get IS_CLOUD() {
    return state.cloud;
  },
}));
vi.mock("../../db/postgres/postgres.js", () => ({
  db: {
    query: {
      sites: { findMany: async () => state.sites },
      organization: {
        findMany: async () =>
          [...new Set(state.sites.map(row => row.organizationId))].map(id => ({
            id,
            name: id,
            monthlyEventCount: 0,
            stripeCustomerId: "legacy",
          })),
      },
    },
    select: (fields: Record<string, unknown>) => {
      const rows = "domain" in fields ? state.sites : [];
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        groupBy: () => chain,
        then: (resolve: any) => Promise.resolve(rows).then(resolve),
      };
      return chain;
    },
  },
}));
vi.mock("../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: {
    query: async ({ query }: { query: string }) => {
      state.queries.push(query);
      if (state.unavailable) throw new Error("synthetic database unavailable");
      if (!query.includes("hourly_events_by_site_mv_target"))
        throw new Error("Raw-event scans are not authorized for these admin observations");
      const rows = state.queries.length % 2 === 1 ? state.rows24h : state.rows30d;
      return { json: async () => rows };
    },
  },
}));
vi.mock("../../services/admin/subscriptionService.js", () => ({
  getOrganizationSubscriptions: async (organizations: { id: string }[]) =>
    new Map(
      organizations.map(({ id }) => [
        id,
        {
          source: state.cloud ? "free" : "self-hosted",
          planName: state.cloud ? "free" : "self-hosted",
          status: "active",
          eventLimit: null,
          currentPeriodEnd: null,
        },
      ])
    ),
}));
import { getAdminOrganizations } from "./getAdminOrganizations.js";
import { getAdminSites } from "./getAdminSites.js";

async function responseFrom(handler: typeof getAdminSites | typeof getAdminOrganizations) {
  let data: any;
  const reply: any = {
    status: () => reply,
    send: (body: unknown) => {
      data = body;
      return body;
    },
  };
  await handler({ log: { warn: vi.fn(), error: vi.fn() } } as any, reply);
  return data;
}
beforeEach(() => {
  state.unavailable = false;
  state.cloud = false;
  state.sites = [site];
  state.queries = [];
  state.rawHistoricalEvents = [];
  state.rows24h = [{ site_id: "12", total_events: "0" }];
  state.rows30d = [{ site_id: "12", total_events: "0" }];
});

describe.each([false, true])("admin observations cloud=%s", cloud => {
  beforeEach(() => {
    state.cloud = cloud;
  });
  describe.each([
    { name: "sites", handler: getAdminSites, observations: (data: any) => data },
    {
      name: "organizations",
      handler: getAdminOrganizations,
      observations: (data: any) => data.flatMap((org: any) => org.sites),
    },
  ])("$name", ({ handler, observations }) => {
    it("does not disguise a failed count query as zero", async () => {
      state.unavailable = true;
      const data = await responseFrom(handler);
      expect(observations(data)[0]).toMatchObject({ eventsLast24Hours: null, eventsLast30Days: null });
      expect(data[0].eventCountCoverage).toBe("UNAVAILABLE");
    });
    it("keeps an explicit measured zero without claiming verified historical coverage", async () => {
      const data = await responseFrom(handler);
      expect(observations(data)[0]).toMatchObject({ eventsLast24Hours: 0, eventsLast30Days: 0 });
      expect(data[0].eventCountCoverage).toBe("NOT_VERIFIED");
      if (handler === getAdminOrganizations) expect(data[0].monthlyEventCount).toBe(cloud ? 0 : null);
    });
    it("keeps empty rollup unknown when raw historical events exist, without scanning them", async () => {
      // Models an existing site immediately after the view was introduced.
      // The raw history exists but was never populated into the aggregate.
      state.rawHistoricalEvents = [{ site_id: 12 }, { site_id: 12 }];
      state.rows24h = [];
      state.rows30d = [];
      const data = await responseFrom(handler);
      expect(state.rawHistoricalEvents).toHaveLength(2);
      expect(observations(data)[0]).toMatchObject({ eventsLast24Hours: null, eventsLast30Days: null });
      expect(data[0].eventCountCoverage).toBe("UNAVAILABLE");
      expect(state.queries).toHaveLength(2);
      expect(state.queries.every(query => query.includes("hourly_events_by_site_mv_target"))).toBe(true);
    });
    it("preserves known counts alongside missing sites/windows without inventing a complete total", async () => {
      state.sites = [site, { ...site, siteId: 13 }, { ...site, siteId: 14, organizationId: "org2" }];
      state.rows24h = [
        { site_id: "12", total_events: "9" },
        { site_id: "14", total_events: "4" },
      ];
      state.rows30d = [
        { site_id: "12", total_events: "22" },
        { site_id: "13", total_events: "7" },
        { site_id: "14", total_events: "11" },
      ];
      const data = await responseFrom(handler);
      expect(observations(data).map((row: any) => [row.eventsLast24Hours, row.eventsLast30Days])).toEqual([
        [9, 22],
        [null, 7],
        [4, 11],
      ]);
      if (handler === getAdminSites)
        expect(data.map((row: any) => row.eventCountCoverage)).toEqual(["NOT_VERIFIED", "UNAVAILABLE", "NOT_VERIFIED"]);
      else expect(data.map((row: any) => row.eventCountCoverage)).toEqual(["UNAVAILABLE", "NOT_VERIFIED"]);
    });
  });
});
