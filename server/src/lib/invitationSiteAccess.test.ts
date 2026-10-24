import type { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { Kysely, PostgresDialect, type PostgresPoolClient } from "kysely";
import { DateTime } from "luxon";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/postgres/postgres.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../db/postgres/schema.js");
  const sql = new PGlite();
  return { db: drizzle(sql, { schema }), sql };
});
vi.mock("./logger/logger.js", () => ({
  createServiceLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

import { db, sql } from "../db/postgres/postgres.js";
import * as access from "./access.js";
import {
  applyInvitationSiteAccess,
  invitationSiteAccessHooks,
  restrictedMemberSiteAccessField,
} from "./invitationSiteAccess.js";

const database = sql as unknown as PGlite;
const secret = "invitation-test-only-secret-at-least-32-characters";
const queries: { sql: string; parameters: unknown[] }[] = [];
const invalidate = vi.fn();
// Exactly the production PostgreSQL adapter path, pointed at disposable local
// PostgreSQL. The SQL member default deliberately remains FALSE, as deployed.
const kysely = new Kysely({
  dialect: new PostgresDialect({
    pool: {
      connect: async () => ({
        query: (async (statement: string, parameters: unknown[]) => {
          queries.push({ sql: statement, parameters });
          const result = await database.query(
            statement,
            parameters.map(value => (value instanceof Date ? DateTime.fromJSDate(value).toISO() : value))
          );
          return {
            rows: result.rows,
            rowCount: result.affectedRows ?? result.rows.length,
            command: statement.trim().split(/\s/)[0].toUpperCase() as "SELECT" | "INSERT" | "UPDATE" | "DELETE",
          };
        }) as PostgresPoolClient["query"],
        release() {},
      }),
      async end() {},
    },
  }),
});

const auth = betterAuth({
  baseURL: "http://localhost:3002",
  secret,
  database: { db: kysely, type: "postgres", transaction: true },
  plugins: [
    organization({
      organizationHooks: invitationSiteAccessHooks(invalidate),
      schema: {
        member: { additionalFields: { hasRestrictedSiteAccess: restrictedMemberSiteAccessField } },
        invitation: {
          additionalFields: {
            hasRestrictedSiteAccess: {
              type: "boolean",
              required: false,
              defaultValue: false,
              fieldName: "has_restricted_site_access",
            },
            siteIds: { type: "number[]", required: false, defaultValue: [], fieldName: "site_ids" },
            siteRole: { type: "string", required: false, fieldName: "site_role" },
          },
        },
      },
    }),
  ],
});

const DDL = `
CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL,
  "emailVerified" boolean NOT NULL, image text, "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL);
CREATE TABLE account (id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL, "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamp, "refreshTokenExpiresAt" timestamp, scope text, password text,
  "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL);
CREATE TABLE verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
  "expiresAt" timestamp NOT NULL, "createdAt" timestamp, "updatedAt" timestamp);
CREATE TABLE organization (id text PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL,
  logo text, metadata text, "createdAt" timestamp NOT NULL);
CREATE TABLE member (id text PRIMARY KEY, "organizationId" text NOT NULL, "userId" text NOT NULL,
  role text NOT NULL, "createdAt" timestamp NOT NULL, has_restricted_site_access boolean NOT NULL DEFAULT false);
CREATE TABLE invitation (id text PRIMARY KEY, "organizationId" text NOT NULL, email text NOT NULL,
  role text NOT NULL, status text NOT NULL, "expiresAt" timestamp NOT NULL, "createdAt" timestamp NOT NULL,
  "inviterId" text NOT NULL, has_restricted_site_access boolean NOT NULL DEFAULT false,
  site_ids jsonb DEFAULT '[]', site_role text);
CREATE TABLE session (id text PRIMARY KEY, "userId" text NOT NULL, token text NOT NULL,
  "expiresAt" timestamp NOT NULL, "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL,
  "ipAddress" text, "userAgent" text, "activeOrganizationId" text);
CREATE TABLE sites (site_id integer PRIMARY KEY, organization_id text NOT NULL);
CREATE TABLE member_site_access (id serial PRIMARY KEY, member_id text NOT NULL, site_id integer NOT NULL,
  role text, created_at timestamp NOT NULL DEFAULT now(), created_by text);
`;

beforeAll(async () => {
  await database.exec(DDL);
  await auth.$context;
}, 30_000);

beforeEach(async () => {
  await database.exec(`
    TRUNCATE member_site_access, member, invitation, session, sites, organization, "user";
    INSERT INTO "user" VALUES
      ('owner', 'Owner', 'owner@example.com', true, null, now(), now()),
      ('recipient', 'Recipient', 'recipient@example.com', true, null, now(), now());
    INSERT INTO organization VALUES ('org', 'Organization', 'org', null, null, now());
    INSERT INTO session VALUES ('session', 'recipient', 'recipient-token', now() + interval '1 day', now(), now(), null, null, null);
    INSERT INTO sites VALUES (1, 'org'), (2, 'moved-org');
  `);
  queries.length = 0;
  invalidate.mockClear();
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await kysely.destroy();
  await database.close();
});

async function accept(restricted: boolean, siteIds = [1], siteRole: string | null = "editor") {
  await database.query(
    `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId", has_restricted_site_access, site_ids, site_role)
    VALUES ('invite', 'org', 'recipient@example.com', 'member', 'pending', now() + interval '1 day', now(), 'owner', $1, $2, $3)`,
    [restricted, JSON.stringify(siteIds), siteRole]
  );
  return auth.api.acceptInvitation({ body: { invitationId: "invite" }, headers: recipientHeaders() });
}

function recipientHeaders() {
  const token = "recipient-token";
  const signed = `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;
  return new Headers({ cookie: `better-auth.session_token=${encodeURIComponent(signed)}` });
}

async function persistedMember() {
  const { rows } = await database.query<{ has_restricted_site_access: boolean; role: string }>(
    `SELECT has_restricted_site_access, role FROM member WHERE "userId" = 'recipient'`
  );
  return rows[0];
}

describe("Better Auth restricted-invitation default and hooks", () => {
  it("is wired into production, including the server-only member field", async () => {
    const source = await readFile(new URL("./auth.ts", import.meta.url), "utf8");
    expect(source).toContain("...invitationSiteAccessHooks(invalidateSitesAccessCache)");
    expect(source).toContain("additionalFields: { hasRestrictedSiteAccess: restrictedMemberSiteAccessField }");
    expect(restrictedMemberSiteAccessField).toMatchObject({
      input: false,
      defaultValue: true,
      fieldName: "has_restricted_site_access",
    });
  });

  it("creates the organization's owner unrestricted through the real SDK hook", async () => {
    const created = await auth.api.createOrganization({ body: { name: "New", slug: "new", userId: "owner" } });
    expect(created).toMatchObject({ members: [{ role: "owner", hasRestrictedSiteAccess: false }] });
    const { rows } = await database.query(`SELECT has_restricted_site_access FROM member WHERE "organizationId" = $1`, [
      created!.id,
    ]);
    expect(rows).toEqual([{ has_restricted_site_access: false }]);
  });

  it("keeps authorized server-side direct addMember unrestricted", async () => {
    const added = await auth.api.addMember({ body: { organizationId: "org", userId: "recipient", role: "member" } });
    expect(added.hasRestrictedSiteAccess).toBe(false);
    expect(await persistedMember()).toMatchObject({ has_restricted_site_access: false, role: "member" });
  });

  it("injects TRUE into the real SQL INSERT before a failed ownership lookup", async () => {
    vi.spyOn(access, "siteIdsInOrganization").mockRejectedValueOnce(new Error("lookup unavailable"));
    await accept(true);

    const insert = queries.find(query => query.sql.startsWith('insert into "member"'));
    expect(insert?.sql).toContain('"has_restricted_site_access"');
    expect(insert?.parameters).toContain(true);
    const memberInsertIndex = queries.indexOf(insert!);
    expect(queries.findIndex((query, index) => index > memberInsertIndex && query.sql === "commit")).toBeGreaterThan(
      memberInsertIndex
    );
    expect(await persistedMember()).toMatchObject({ has_restricted_site_access: true });
    expect((await database.query(`SELECT * FROM member_site_access`)).rows).toEqual([]);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("recipient");
  });

  it("keeps a failed grant INSERT restricted and invalidates cached access", async () => {
    vi.spyOn(db, "insert").mockImplementationOnce(() => {
      throw new Error("grant insert unavailable");
    });
    await accept(true);

    expect(await persistedMember()).toMatchObject({ has_restricted_site_access: true });
    expect((await database.query(`SELECT * FROM member_site_access`)).rows).toEqual([]);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("recipient");
  });

  it("rechecks ownership from the accepted payload and only grants still-owned sites", async () => {
    const select = vi.spyOn(db, "select");
    await accept(true, [1, 1, 2]);

    expect(await persistedMember()).toMatchObject({ has_restricted_site_access: true });
    expect((await database.query(`SELECT member_id, site_id, role FROM member_site_access`)).rows).toEqual([
      { member_id: expect.any(String), site_id: 1, role: "editor" },
    ]);
    // Only site ownership uses Drizzle SELECT: finalization never re-reads the invitation.
    expect(select).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("recipient");
  });

  it("lifts the restriction only for an explicitly unrestricted accepted invitation", async () => {
    const select = vi.spyOn(db, "select");
    await accept(false);

    expect(await persistedMember()).toMatchObject({ has_restricted_site_access: false });
    expect(select).not.toHaveBeenCalled();
    expect((await database.query(`SELECT * FROM member_site_access`)).rows).toEqual([]);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("recipient");
  });

  it("keeps an unrestricted invite locked when lifting its flag fails", async () => {
    vi.spyOn(db, "update").mockImplementationOnce(() => {
      throw new Error("member update unavailable");
    });
    await accept(false);

    expect(await persistedMember()).toMatchObject({ has_restricted_site_access: true });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("recipient");
  });

  it("never finalizes or invalidates a rejected/replayed accept", async () => {
    await accept(true);
    invalidate.mockClear();
    await expect(
      auth.api.acceptInvitation({ body: { invitationId: "invite" }, headers: recipientHeaders() })
    ).rejects.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("fails closed on missing restrictions or invalid grant roles instead of inheriting full access", async () => {
    await expect(applyInvitationSiteAccess({ organizationId: "org" }, "member")).rejects.toThrow("missing");
    await accept(true, [1], "owner");

    expect(await persistedMember()).toMatchObject({ has_restricted_site_access: true });
    expect((await database.query(`SELECT * FROM member_site_access`)).rows).toEqual([]);
  });

  it("does not allow a request body to choose the server-owned member flag", () => {
    const plugin = auth.options.plugins![0];
    const body = plugin.endpoints.addMember.options.body.parse({
      organizationId: "org",
      userId: "recipient",
      role: "member",
      hasRestrictedSiteAccess: false,
    });
    expect(body).not.toHaveProperty("hasRestrictedSiteAccess");
  });

  it("does not backfill or change previously unrestricted memberships", async () => {
    await database.exec(`INSERT INTO member VALUES ('legacy', 'org', 'owner', 'member', now(), false)`);
    await accept(true);

    expect((await database.query(`SELECT has_restricted_site_access FROM member WHERE id = 'legacy'`)).rows).toEqual([
      { has_restricted_site_access: false },
    ]);
    expect(access.effectiveOrgRole({ role: "owner", hasRestrictedSiteAccess: true })).toBe("owner");
    expect(access.effectiveOrgRole({ role: "admin", hasRestrictedSiteAccess: true })).toBe("admin");
  });

  it("rejects malformed grant values before database writes", async () => {
    const update = vi.spyOn(db, "update");
    const insert = vi.spyOn(db, "insert");
    await expect(
      applyInvitationSiteAccess(
        { organizationId: "org", hasRestrictedSiteAccess: true, siteRole: "editor'; DROP TABLE member; --" },
        "member"
      )
    ).rejects.toThrow("invalid site grant role");
    await expect(
      applyInvitationSiteAccess({ organizationId: "org", hasRestrictedSiteAccess: true, siteIds: [NaN] }, "member")
    ).rejects.toThrow("invalid site ids");

    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
