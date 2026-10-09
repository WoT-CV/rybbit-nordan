import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

type TableSnapshot = { columns: Record<string, unknown>; [key: string]: unknown };
type Snapshot = { id: string; prevId: string; tables: Record<string, TableSnapshot> };
const snapshot = (index: number): Snapshot =>
  JSON.parse(
    readFileSync(
      new URL(`../../../drizzle/meta/${String(index).padStart(4, "0")}_snapshot.json`, import.meta.url),
      "utf8"
    )
  );

describe("WoT-CV migration lineage (no database connection)", () => {
  it("continues the fork snapshot rather than upstream's divergent 0014", () => {
    for (const index of [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]) {
      expect(snapshot(index).prevId).toBe(snapshot(index - 1).id);
    }
    expect(snapshot(15).prevId).toBe("e38adbc1-bf05-486f-9a30-25d6043da90c");
  });

  it("preserves every legacy table definition and only adds detected_platform to sites", () => {
    const original = snapshot(14);
    for (const index of [15, 16, 17]) {
      const current = snapshot(index);
      for (const [name, table] of Object.entries(original.tables)) {
        const actual = structuredClone(current.tables[name]);
        if (name === "public.sites") {
          expect(actual.columns.detected_platform).toBeDefined();
          delete actual.columns.detected_platform;
        }
        expect(actual, `${index}: ${name}`).toEqual(table);
      }
    }
  });

  it("matches runtime table and column names, including Uptime, Network Replay and identity", () => {
    const latest = snapshot(24);
    const tables = Object.values(schema)
      .filter(value => is(value, PgTable))
      .map(table => getTableConfig(table));
    expect(Object.keys(latest.tables).sort()).toEqual(tables.map(table => `public.${table.name}`).sort());
    for (const table of tables) {
      expect(Object.keys(latest.tables[`public.${table.name}`].columns).sort(), table.name).toEqual(
        table.columns.map(column => column.name).sort()
      );
    }
  });

  it("preserves all fork definitions while adding auth and onboarding metadata", () => {
    const original = snapshot(17);
    for (const index of [18, 19, 20]) {
      const current = snapshot(index);
      expect(Object.keys(current.tables)).toHaveLength(46);
      for (const [name, table] of Object.entries(original.tables)) {
        const actual = structuredClone(current.tables[name]);
        if (name === "public.team") delete actual.columns.memberCount;
        if (name === "public.teamMember") {
          delete actual.columns.membershipKey;
          delete (actual.uniqueConstraints as Record<string, unknown>).teamMember_membershipKey_unique;
        }
        if (index >= 20 && name === "public.sites") delete actual.columns.claim_expires_at;
        expect(actual, `${index}: ${name}`).toEqual(table);
      }
    }
  });

  it("retains the fork journal and appends the reviewed upstream migrations", () => {
    const journal = JSON.parse(readFileSync(new URL("../../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    const tail = journal.entries.slice(10).map((entry: { tag: string }) => entry.tag);
    expect(tail).toEqual([
      "0010_uneven_juggernaut",
      "0011_tiny_diamondback",
      "0012_identity_resolution_v2",
      "0013_upstream_api_keys_first_party_proxy",
      "0014_upstream_site_exclusions",
      "0015_round_trish_tilby",
      "0016_shocking_vance_astro",
      "0017_burly_nick_fury",
      "0018_better_auth_173",
      "0019_invitation_created_at",
      "0020_unclaimed_sites",
      "0021_site_grant_roles",
      "0022_site_transfers",
      "0023_track_url_fragments",
      "0024_sites_id_index",
    ]);
    for (const entry of journal.entries.slice(15, 18)) {
      const sql = readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
      expect(sql).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/im);
      expect(sql).not.toMatch(/ALTER TABLE[^;]*\bDROP\b/i);
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
    }
    for (const entry of journal.entries.slice(18)) {
      const sql = readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
      expect(sql).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE)\b/im);
      expect(sql).not.toMatch(/ALTER TABLE[^;]*\bDROP\b/i);
    }
  });

  it("preserves the fork tables while applying only the four reviewed upstream schema changes", () => {
    const original = snapshot(20);
    for (const index of [21, 22, 23, 24]) {
      const current = snapshot(index);
      for (const [name, table] of Object.entries(original.tables)) {
        const actual = structuredClone(current.tables[name]);
        if (name === "public.member_site_access" || name === "public.team_site_access") {
          expect(actual.columns.role).toBeDefined();
          delete actual.columns.role;
        }
        if (name === "public.invitation") {
          expect(actual.columns.site_role).toBeDefined();
          delete actual.columns.site_role;
        }
        if (index >= 23 && name === "public.sites") delete actual.columns.trackUrlFragments;
        if (index >= 24 && name === "public.sites") delete (actual.indexes as Record<string, unknown>).sites_id_idx;
        expect(actual, `${index}: ${name}`).toEqual(table);
      }
      expect(Object.keys(current.tables)).toHaveLength(index === 21 ? 46 : 47);
    }
  });
});
