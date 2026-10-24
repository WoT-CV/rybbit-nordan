import Fastify, { type FastifyInstance } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveUserIdentity: vi.fn(),
  command: vi.fn(),
  query: vi.fn(),
  deleteWhere: vi.fn(),
  delete: vi.fn(),
  r2Enabled: false,
  deleteBatch: vi.fn(),
}));

vi.mock("../../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: {
    command: mocks.command,
    query: mocks.query,
  },
}));

vi.mock("../../../db/postgres/postgres.js", () => ({
  db: {
    delete: mocks.delete,
  },
}));

vi.mock("../../../services/storage/r2StorageService.js", () => ({
  r2Storage: {
    isEnabled: () => mocks.r2Enabled,
    deleteBatch: mocks.deleteBatch,
  },
}));

vi.mock("../../../services/userIdentity/userIdentityService.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/userIdentity/userIdentityService.js")>()),
  resolveUserIdentity: mocks.resolveUserIdentity,
}));

import { deleteUser } from "./deleteUser.js";

let app: FastifyInstance;

function replyStub() {
  const reply: any = { statusCode: 200 };
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((body: unknown) => {
    reply.body = body;
    return reply;
  });
  return reply;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.r2Enabled = false;
  mocks.resolveUserIdentity.mockResolvedValue({
    canonicalUserId: "account-42",
    anonymousIds: ["device-a", "device-b"],
  });
  mocks.command.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ json: async () => [{ event_data_key: "42/session/batch.json.zst" }] });
  mocks.deleteBatch.mockResolvedValue(undefined);
  mocks.deleteWhere.mockResolvedValue(undefined);
  mocks.delete.mockReturnValue({ where: mocks.deleteWhere });
  app = Fastify();
  app.delete("/sites/:siteId/users/:userId", deleteUser);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("deleteUser", () => {
  it("erases the canonical account when the route contains one of its anonymous aliases", async () => {
    const reply = replyStub();
    const request = {
      params: { siteId: "42", userId: "device-a" },
      log: { error: vi.fn() },
    } as any;

    await deleteUser(request, reply);

    expect(mocks.resolveUserIdentity).toHaveBeenCalledWith(42, "device-a");
    expect(mocks.command).toHaveBeenCalledTimes(4);
    expect(mocks.command.mock.calls.map(([call]) => call.query)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DELETE FROM events"),
        expect.stringContaining("DELETE FROM session_replay_events"),
        expect.stringContaining("DELETE FROM session_replay_metadata "),
        expect.stringContaining("DELETE FROM session_replay_metadata_v2"),
      ])
    );
    for (const [call] of mocks.command.mock.calls) {
      expect(call.query_params).toEqual({
        siteId: 42,
        canonicalUserId: "account-42",
        anonymousIds: ["device-a", "device-b"],
      });
      expect(call.query).toContain("identified_user_id = {canonicalUserId:String}");
      expect(call.query).toContain("user_id IN ({anonymousIds:Array(String)})");
      expect(call.query).toContain("site_id = {siteId:UInt16}");
      expect(call.query).toContain("{canonicalUserId:String} != ''");
      expect(call.query).toContain("identified_user_id = ''\n      AND (");
    }
    expect(mocks.delete).toHaveBeenCalledTimes(2);
    for (const [condition] of mocks.deleteWhere.mock.calls) {
      expect(new PgDialect().sqlToQuery(condition).params).toEqual([42, "account-42"]);
    }
    expect(reply.body).toEqual({ success: true });
  });

  it("refuses an empty user id without touching ClickHouse", async () => {
    mocks.r2Enabled = true;
    const response = await app.inject({ method: "DELETE", url: "/sites/1/users/" });
    expect(response.statusCode).toBe(400);
    expect(mocks.resolveUserIdentity).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.deleteBatch).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("still erases a whitespace identity, which identify() accepts", async () => {
    mocks.resolveUserIdentity.mockResolvedValue({ canonicalUserId: "  ", anonymousIds: [] });
    const response = await app.inject({ method: "DELETE", url: "/sites/1/users/%20%20" });
    expect(response.statusCode).toBe(200);
    expect(mocks.resolveUserIdentity).toHaveBeenCalledWith(1, "  ");
    expect(mocks.command).toHaveBeenCalledTimes(4);
    expect(mocks.command.mock.calls[0][0].query_params).toEqual({
      siteId: 1,
      canonicalUserId: "  ",
      anonymousIds: ["  "],
    });
  });

  it.each(["00042", "65535"])("accepts the valid decimal site ID %s without widening its scope", async siteId => {
    const response = await app.inject({ method: "DELETE", url: `/sites/${siteId}/users/account-42` });

    expect(response.statusCode).toBe(200);
    expect(mocks.resolveUserIdentity).toHaveBeenCalledWith(Number(siteId), "account-42");
    expect(mocks.command.mock.calls[0][0].query_params.siteId).toBe(Number(siteId));
  });

  it("deletes only the user's rows and never matches the empty id", async () => {
    mocks.resolveUserIdentity.mockResolvedValue({
      canonicalUserId: "account-42",
      anonymousIds: ["device-a", "", "device-a", "device-b"],
    });
    const response = await app.inject({ method: "DELETE", url: "/sites/1/users/user-42" });

    expect(response.statusCode).toBe(200);
    expect(mocks.command).toHaveBeenCalledTimes(4);
    for (const [call] of mocks.command.mock.calls) {
      expect(call.query).toContain("{canonicalUserId:String} != ''");
      expect(call.query_params).toEqual({
        siteId: 1,
        canonicalUserId: "account-42",
        anonymousIds: ["user-42", "device-a", "device-b"],
      });
    }
  });

  it("refuses a corrupt alias resolving to an empty canonical identity", async () => {
    mocks.r2Enabled = true;
    mocks.resolveUserIdentity.mockResolvedValue({ canonicalUserId: "", anonymousIds: ["device-a"] });
    const response = await app.inject({ method: "DELETE", url: "/sites/42/users/device-a" });

    expect(response.statusCode).toBe(400);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.deleteBatch).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each(["not-a-site", "0", "-1", "1e1", "0x5", "5.0", "65536", "99999999999999999999"])(
    "refuses invalid site ID %s before any identity or storage access",
    async siteId => {
      const response = await app.inject({ method: "DELETE", url: `/sites/${siteId}/users/account-42` });

      expect(response.statusCode).toBe(400);
      expect(mocks.resolveUserIdentity).not.toHaveBeenCalled();
      expect(mocks.command).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
    }
  );

  it("selects R2 keys with the same canonical, site-scoped guarded condition before erasure", async () => {
    mocks.r2Enabled = true;
    const response = await app.inject({ method: "DELETE", url: "/sites/42/users/device-a" });

    expect(response.statusCode).toBe(200);
    const query = mocks.query.mock.calls[0][0];
    expect(query.query).toContain("site_id = {siteId:UInt16}");
    expect(query.query).toContain("{canonicalUserId:String} != ''");
    expect(query.query_params).toEqual(mocks.command.mock.calls[0][0].query_params);
    expect(mocks.deleteBatch).toHaveBeenCalledWith("42/session/batch.json.zst");
    expect(mocks.deleteBatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.command.mock.invocationCallOrder[0]);
    expect(mocks.command).toHaveBeenCalledTimes(4);
  });
});
