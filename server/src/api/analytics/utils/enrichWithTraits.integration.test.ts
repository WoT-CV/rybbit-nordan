import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only the connection is substituted. This executes the real Drizzle builder,
// real PostgreSQL engine and production enrichment helper; no query-chain mock.
vi.mock("../../../db/postgres/postgres.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../../../db/postgres/schema.js");
  const client = new PGlite();
  return { db: drizzle(client, { schema }), sql: client };
});

import { db, sql } from "../../../db/postgres/postgres.js";
import { userProfiles } from "../../../db/postgres/schema.js";
import { enrichWithTraits } from "./utils.js";

const database = sql as unknown as PGlite;

beforeAll(async () => {
  // Minimal synthetic fixture only: no journal, migration or native initializer.
  await database.exec(`CREATE TABLE user_profiles (
    site_id integer NOT NULL,
    user_id text NOT NULL,
    traits jsonb DEFAULT '{}',
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, user_id)
  )`);
});
beforeEach(async () => {
  await database.exec("TRUNCATE user_profiles");
});
afterAll(async () => {
  await database.close();
});

describe("native profile enrichment against in-memory PostgreSQL", () => {
  it("isolates identical opaque IDs by site and preserves leading zeros and large IDs", async () => {
    await db.insert(userProfiles).values([
      { siteId: 1, userId: "00042", traits: { username: "[ONE] Zero", avatarUrl: "https://clan.example/one.png" } },
      { siteId: 1, userId: "42", traits: { username: "Different opaque ID" } },
      { siteId: 1, userId: "120248430174340693", traits: { username: "Large opaque ID" } },
      { siteId: 2, userId: "00042", traits: { username: "[TWO] Other site" } },
    ]);
    const rows = [
      { identified_user_id: "00042", count: 2 },
      { identified_user_id: "42", count: 1 },
      { identified_user_id: "120248430174340693", count: 1 },
    ];
    const result = await enrichWithTraits(rows, 1);
    expect(result.map(row => row.identified_user_id)).toEqual(["00042", "42", "120248430174340693"]);
    expect(result.map(row => row.traits?.username)).toEqual(["[ONE] Zero", "Different opaque ID", "Large opaque ID"]);
    expect((await enrichWithTraits([{ identified_user_id: "00042" }], 2))[0].traits?.username).toBe("[TWO] Other site");
    expect((await enrichWithTraits([{ identified_user_id: "00042" }], 3))[0].traits).toBeNull();
    expect(rows[0]).not.toHaveProperty("traits");
    expect(result[0].count).toBe(2);
  });

  it("keeps missing historical/anonymous profiles null, not invented display values", async () => {
    await db.insert(userProfiles).values([{ siteId: 1, userId: "present", traits: { name: "Native profile" } }]);
    const result = await enrichWithTraits(
      [
        { identified_user_id: "" },
        { identified_user_id: "historical" },
        { identified_user_id: "present" },
        { identified_user_id: "present" },
      ],
      1
    );
    expect(result.map(row => row.traits)).toEqual([null, null, { name: "Native profile" }, { name: "Native profile" }]);
    expect(await enrichWithTraits([], 1)).toEqual([]);
  });

  it("uses current profile values while retaining group/count shape and null-versus-empty distinction", async () => {
    await db.insert(userProfiles).values([
      { siteId: 1, userId: "current", traits: { name: "[NEW] Current", logoUrl: "https://clan.example/current.png" } },
      { siteId: 1, userId: "empty", traits: {} },
      { siteId: 1, userId: "null-json", traits: null },
    ]);
    const result = await enrichWithTraits(
      [
        { identified_user_id: "current", count: 7, latitude: 52 },
        { identified_user_id: "empty", count: 1, latitude: 0 },
        { identified_user_id: "null-json", count: 1, latitude: 0 },
        { identified_user_id: "missing", count: 1, latitude: 0 },
      ],
      1
    );
    expect(result[0]).toEqual({
      identified_user_id: "current",
      count: 7,
      latitude: 52,
      traits: { name: "[NEW] Current", logoUrl: "https://clan.example/current.png" },
    });
    expect(result.slice(1).map(row => row.traits)).toEqual([{}, {}, null]);
  });

  it("reads updated native traits on subsequent enrichment and parameterizes opaque punctuation", async () => {
    const userId = "opaque' OR 1=1 --";
    await db.insert(userProfiles).values([
      { siteId: 1, userId, traits: { name: "[OLD] Before" } },
      { siteId: 2, userId, traits: { name: "Other site" } },
    ]);
    expect((await enrichWithTraits([{ identified_user_id: userId }], 1))[0].traits).toEqual({ name: "[OLD] Before" });
    await db
      .update(userProfiles)
      .set({ traits: { name: "[NEW] After", avatarUrl: "https://clan.example/new.png" } })
      .where(and(eq(userProfiles.siteId, 1), eq(userProfiles.userId, userId)));
    expect((await enrichWithTraits([{ identified_user_id: userId }], 1))[0].traits).toEqual({
      name: "[NEW] After",
      avatarUrl: "https://clan.example/new.png",
    });
    expect((await enrichWithTraits([{ identified_user_id: userId }], 2))[0].traits).toEqual({ name: "Other site" });
    expect((await enrichWithTraits([{ identified_user_id: "not inserted" }], 1))[0].traits).toBeNull();
  });
});
