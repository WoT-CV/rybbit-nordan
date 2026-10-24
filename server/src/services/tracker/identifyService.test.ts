import type { FastifyReply, FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  profileValues: vi.fn(),
  profileOnConflictDoNothing: vi.fn(),
  getConfig: vi.fn(),
  generateUserIdFromClientId: vi.fn(),
  generateLegacyUserIdFromClientId: vi.fn(),
  generateUserId: vi.fn(),
  claimTrackerAlias: vi.fn(),
  claimLegacyClientAlias: vi.fn(),
  isSiteWithoutPlan: vi.fn(),
  isTrustedServerSideIngestion: vi.fn(),
  resolveClientIp: vi.fn(),
}));

vi.mock("../usageService.js", () => ({
  usageService: { isSiteWithoutPlan: mocks.isSiteWithoutPlan },
}));

vi.mock("../../db/postgres/postgres.js", () => ({
  db: { insert: mocks.insert },
}));

vi.mock("../../lib/siteConfig.js", () => ({
  siteConfig: { getConfig: mocks.getConfig },
}));

vi.mock("../userId/userIdService.js", () => ({
  userIdService: {
    generateUserIdFromClientId: mocks.generateUserIdFromClientId,
    generateLegacyUserIdFromClientId: mocks.generateLegacyUserIdFromClientId,
    generateUserId: mocks.generateUserId,
  },
}));

vi.mock("../userIdentity/userIdentityService.js", () => ({
  claimTrackerAlias: mocks.claimTrackerAlias,
  claimLegacyClientAlias: mocks.claimLegacyClientAlias,
}));
vi.mock("./trackingRequest.js", () => ({ isTrustedServerSideIngestion: mocks.isTrustedServerSideIngestion }));
vi.mock("./resolveClientIp.js", () => ({ resolveClientIp: mocks.resolveClientIp }));
vi.mock("../../lib/logger/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger, createServiceLogger: () => logger };
});

import { handleIdentify } from "./identifyService.js";

function createReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as FastifyReply;
}

function createRequest(userId = "account-13") {
  return {
    body: {
      site_id: "public-site-id",
      anonymous_id: "browser-123",
      user_id: userId,
      is_new_identify: true,
    },
    headers: {},
    ip: "198.51.100.10",
  } as unknown as FastifyRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSiteWithoutPlan.mockReturnValue(false);
  mocks.getConfig.mockResolvedValue({ siteId: 42 });
  mocks.generateUserIdFromClientId.mockResolvedValue("hashed-browser-id");
  mocks.generateLegacyUserIdFromClientId.mockResolvedValue("legacy-client-id");
  mocks.generateUserId.mockResolvedValue("legacy-ip-ua-id");
  mocks.claimTrackerAlias.mockResolvedValue({ status: "created" });
  mocks.claimLegacyClientAlias.mockResolvedValue({ status: "created" });
  mocks.profileValues.mockReturnValue({ onConflictDoNothing: mocks.profileOnConflictDoNothing });
  mocks.profileOnConflictDoNothing.mockResolvedValue(undefined);
  mocks.insert.mockReturnValue({ values: mocks.profileValues });
  mocks.isTrustedServerSideIngestion.mockResolvedValue(false);
  mocks.resolveClientIp.mockReturnValue("198.51.100.10");
});

describe("handleIdentify identity correlation", () => {
  it("claims the stable browser alias without mutating ClickHouse history", async () => {
    const reply = createReply();

    await handleIdentify(createRequest(), reply);

    expect(mocks.generateUserIdFromClientId).toHaveBeenCalledWith("browser-123", 42);
    expect(mocks.generateUserId).not.toHaveBeenCalled();
    expect(mocks.claimTrackerAlias).toHaveBeenCalledWith(42, "hashed-browser-id", "account-13");
    expect(mocks.claimLegacyClientAlias).toHaveBeenCalledWith(42, "legacy-client-id", "account-13");
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("rejects reassignment so one browser alias cannot steal another account's history", async () => {
    mocks.claimTrackerAlias.mockResolvedValue({ status: "conflict", existingUserId: "account-alice" });
    const reply = createReply();

    await handleIdentify(createRequest("account-bob"), reply);

    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.claimLegacyClientAlias).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      code: "ANONYMOUS_ID_ALREADY_LINKED",
      rotateAnonymousId: true,
    });
  });

  it("keeps a new browser identity when the legacy alias already belongs to another account", async () => {
    mocks.claimLegacyClientAlias.mockResolvedValue({ status: "conflict", existingUserId: "other-account" });
    const reply = createReply();

    await handleIdentify(createRequest(), reply);

    expect(mocks.claimTrackerAlias).toHaveBeenCalledWith(42, "hashed-browser-id", "account-13");
    expect(mocks.claimLegacyClientAlias).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("keeps trait-only updates independent from alias ownership", async () => {
    const request = createRequest();
    request.body = {
      site_id: "public-site-id",
      user_id: "account-13",
      traits: { plan: "pro" },
      is_new_identify: false,
    };
    const traitConflictUpdate = vi.fn().mockResolvedValue(undefined);
    const traitValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: traitConflictUpdate,
    });
    mocks.insert.mockReturnValue({ values: traitValues });

    await handleIdentify(request, createReply());

    expect(mocks.claimTrackerAlias).not.toHaveBeenCalled();
    expect(mocks.generateUserId).toHaveBeenCalled();
    expect(traitValues).toHaveBeenCalled();
    expect(traitConflictUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not store profiles or claim aliases for a site with no plan", async () => {
    mocks.isSiteWithoutPlan.mockReturnValue(true);
    const reply = createReply();

    await handleIdentify(createRequest(), reply);

    expect(mocks.isSiteWithoutPlan).toHaveBeenCalledWith(42);
    expect(mocks.generateUserIdFromClientId).not.toHaveBeenCalled();
    expect(mocks.claimTrackerAlias).not.toHaveBeenCalled();
    expect(mocks.claimLegacyClientAlias).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.isTrustedServerSideIngestion).not.toHaveBeenCalled();
    expect(mocks.resolveClientIp).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith("Site has no plan, identify not stored");
  });
});

describe("handleIdentify — ip_address / user_agent overrides", () => {
  beforeEach(() => {
    mocks.getConfig.mockResolvedValue({ siteId: 7, firstPartyProxy: true });
    mocks.resolveClientIp.mockReturnValue("198.51.100.7");
  });
  const body = {
    site_id: "7",
    user_id: "attacker_pick",
    ip_address: "203.0.113.50",
    user_agent: "Victim UA",
    is_new_identify: false,
  };

  it("ignores them without a trusted ingest:write bearer and fingerprints the caller instead", async () => {
    mocks.isTrustedServerSideIngestion.mockResolvedValue(false);

    const request = { body, headers: { "user-agent": "Caller UA" } } as unknown as FastifyRequest;
    const reply = createReply();
    await handleIdentify(request, reply);

    expect(mocks.isTrustedServerSideIngestion).toHaveBeenCalledWith(request, 7);
    expect(mocks.resolveClientIp).toHaveBeenCalledWith(request, { firstPartyProxy: true });
    expect(mocks.generateUserId).toHaveBeenCalledWith("198.51.100.7", "Caller UA", 7);
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("uses them when the request carries a trusted ingest:write bearer", async () => {
    mocks.isTrustedServerSideIngestion.mockResolvedValue(true);

    await handleIdentify({ body, headers: { "user-agent": "Server UA" } } as any, createReply());

    expect(mocks.generateUserId).toHaveBeenCalledWith("203.0.113.50", "Victim UA", 7);
    expect(mocks.resolveClientIp).not.toHaveBeenCalled();
  });

  it("skips the bearer check when no override is sent", async () => {
    await handleIdentify(
      { body: { site_id: "7", user_id: "u", is_new_identify: false }, headers: { "user-agent": "Caller UA" } } as any,
      createReply()
    );

    expect(mocks.isTrustedServerSideIngestion).not.toHaveBeenCalled();
    expect(mocks.generateUserId).toHaveBeenCalledWith("198.51.100.7", "Caller UA", 7);
  });

  it.each([
    { override: { ip_address: "203.0.113.50" }, expectedIp: "203.0.113.50", expectedUserAgent: "Caller UA" },
    { override: { user_agent: "Victim UA" }, expectedIp: "198.51.100.7", expectedUserAgent: "Victim UA" },
  ])(
    "keeps the caller fallback for the missing override $override",
    async ({ override, expectedIp, expectedUserAgent }) => {
      mocks.isTrustedServerSideIngestion.mockResolvedValue(true);
      await handleIdentify(
        {
          body: { site_id: "7", user_id: "u", is_new_identify: false, ...override },
          headers: { "user-agent": "Caller UA" },
        } as any,
        createReply()
      );

      expect(mocks.generateUserId).toHaveBeenCalledWith(expectedIp, expectedUserAgent, 7);
    }
  );

  it("cannot claim a victim fingerprint through untrusted overrides", async () => {
    mocks.generateUserId.mockResolvedValue("caller-fingerprint");
    await handleIdentify(
      { body: { ...body, is_new_identify: true }, headers: { "user-agent": "Caller UA" } } as any,
      createReply()
    );

    expect(mocks.generateUserId).toHaveBeenCalledWith("198.51.100.7", "Caller UA", 7);
    expect(mocks.claimTrackerAlias).toHaveBeenCalledWith(7, "caller-fingerprint", "attacker_pick");
    expect(mocks.claimLegacyClientAlias).not.toHaveBeenCalled();
  });
});
