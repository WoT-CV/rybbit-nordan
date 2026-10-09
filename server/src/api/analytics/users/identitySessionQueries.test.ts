import { describe, expect, it } from "vitest";
import { buildUsersQuery } from "./getUsers.js";
import { buildUserSessionCountQuery } from "./getUserSessionCount.js";

const filters = JSON.stringify([
  { parameter: "user_id", type: "equals", value: ["account-42"] },
  { parameter: "pathname", type: "equals", value: ["/history"] },
]);

describe("identity v2 with upstream session-scoped queries", () => {
  it.each([false, true])("keeps the user list and count on resolved, site-scoped identities (count=%s)", isCount => {
    const sql = buildUsersQuery(
      { start_date: "", end_date: "", filters, time_zone: "UTC", identified_only: "true" },
      42,
      { matchingUserIds: ["account-42"] },
      isCount
    );

    expect(sql).toContain("FilteredSessions AS");
    expect(sql).toContain("WHERE site_id = 42");
    expect(sql).toContain("INNER JOIN FilteredSessions USING (session_id)");
    expect(sql).toContain("site_id = {siteId:Int32}");
    expect(sql).toContain("dictGetOrDefault('user_identity_dict'");
    expect(sql).toContain("toUInt64(events.site_id)");
    expect(sql).toContain("IN ({matchingUserIds:Array(String)})");
    if (isCount) {
      expect(sql).toContain("SELECT DISTINCT");
      expect(sql).toContain("AS resolved_identified_user_id");
    } else {
      expect(sql).toContain("effective_user_id");
      expect(sql).toContain("AND identified_user_id != ''");
    }
  });

  it("assigns a cross-midnight session to its start day without imposing a recent-history cutoff", () => {
    const sql = buildUserSessionCountQuery({ filters, time_zone: "Europe/Warsaw" }, 42);

    expect(sql).toContain("WHERE site_id = 42");
    expect(sql).toContain("site_id = {siteId:Int32}");
    expect(sql).toContain("min(timestamp) AS session_start");
    expect(sql).toContain("toDate(session_start, 'Europe/Warsaw') as date");
    expect(sql).toContain("identified_user_id = {canonicalUserId:String}");
    expect(sql).toContain("identified_user_id = ''");
    expect(sql).toContain("user_id IN ({anonymousIds:Array(String)})");
    expect(sql).not.toContain("INTERVAL");
    expect(sql).not.toContain("timestamp >=");
  });
});
