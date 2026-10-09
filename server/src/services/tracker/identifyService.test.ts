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

describe("handleIdentify identity correlation", () => {
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
  });

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
      onConflictDoUpdate: vi.fn().mockReturnValue(traitConflictUpdate()),
    });
    mocks.insert.mockReturnValue({ values: traitValues });

    await handleIdentify(request, createReply());

    expect(mocks.claimTrackerAlias).not.toHaveBeenCalled();
    expect(mocks.generateUserId).toHaveBeenCalled();
    expect(traitValues).toHaveBeenCalled();
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
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith("Site has no plan, identify not stored");
  });
});
