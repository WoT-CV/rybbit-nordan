import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ unavailable: false }));
const site = {
  siteId: 12,
  name: "Example",
  domain: "example.com",
  type: "web",
  organizationId: "org1",
  createdAt: "2026-11-01",
};
vi.mock("../../lib/const.js", async original => ({ ...(await original<object>()), IS_CLOUD: false }));
vi.mock("../../db/postgres/postgres.js", () => ({
  db: {
    query: {
      sites: { findMany: async () => [site] },
      organization: {
        findMany: async () => [{ id: "org1", name: "Example", monthlyEventCount: 0, stripeCustomerId: "legacy" }],
      },
    },
    select: (fields: Record<string, unknown>) => {
      const rows = "domain" in fields ? [site] : [];
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
    query: async () => {
      if (state.unavailable) throw new Error("synthetic database unavailable");
      return { json: async () => [{ site_id: "12", total_events: "0" }] };
    },
  },
}));
vi.mock("../../services/admin/subscriptionService.js", () => ({
  getOrganizationSubscriptions: async () =>
    new Map([
      [
        "org1",
        { source: "self-hosted", planName: "self-hosted", status: "active", eventLimit: null, currentPeriodEnd: null },
      ],
    ]),
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
});
describe.each([
  { name: "sites", handler: getAdminSites, observation: (data: any) => data[0] },
  { name: "organizations", handler: getAdminOrganizations, observation: (data: any) => data[0].sites[0] },
])("admin $name", ({ handler, observation }) => {
  it("does not disguise a failed count query as zero", async () => {
    state.unavailable = true;
    const data = await responseFrom(handler);
    expect(observation(data)).toMatchObject({ eventsLast24Hours: null, eventsLast30Days: null });
    expect(data[0].eventCountCoverage).toBe("UNAVAILABLE");
  });
  it("keeps measured zero but never claims verified historical coverage", async () => {
    const data = await responseFrom(handler);
    expect(observation(data)).toMatchObject({ eventsLast24Hours: 0, eventsLast30Days: 0 });
    expect(data[0].eventCountCoverage).toBe("NOT_VERIFIED");
  });
});
it("does not expose stale SaaS usage or billing customer links on self-hosted organizations", async () => {
  const data = await responseFrom(getAdminOrganizations);
  expect(data[0]).toMatchObject({
    monthlyEventCount: null,
    stripeCustomerId: null,
    stripeDashboardUrl: null,
    overMonthlyLimit: false,
  });
});
