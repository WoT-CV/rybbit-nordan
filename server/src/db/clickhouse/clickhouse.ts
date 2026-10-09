import { IDENTITY_RESOLUTION_V2, IS_CLOUD, LITE_DASHBOARD } from "../../lib/const.js";
import { initializeAdminEventRollup } from "./adminEventRollup.js";
import { clickhouse } from "./client.js";
import { USER_IDENTITY_DICTIONARY } from "./identityDictionary.js";
import { clickhouseInitLogger, ensureUtcTimeColumns } from "./initUtils.js";
import { UTC_TIME_COLUMNS } from "./timeColumns.js";
import { initializeCloudTables } from "./schema/cloud.js";
import { initializeCoreTables } from "./schema/core.js";
import { initializeLiteDashboardMVs } from "./schema/liteDashboard.js";
import { provisionQueryUser } from "./queryUser.js";

export { clickhouse, clickhouseQuery } from "./client.js";

export const initializeClickhouse = async () => {
  // Every column is declared in UTC and every writer sends explicit-UTC
  // instants, so the server timezone no longer changes what is stored. It
  // still shows up in ad-hoc SQL, and installs upgraded from a non-UTC server
  // have month partitions to rebuild, so say so once at boot.
  const result = await clickhouse.query({ query: "SELECT timezone() AS timezone", format: "JSONEachRow" });
  const timezone = (await result.json<{ timezone: string }>())[0]?.timezone ?? "UTC";
  if (timezone !== "UTC") {
    clickhouseInitLogger.warn(
      { timezone },
      "ClickHouse server timezone is not UTC; Rybbit stores and queries UTC explicitly, but set <timezone>UTC</timezone> " +
        "to keep ad-hoc SQL unambiguous. If this install ran before its columns were pinned to UTC, see docs: self-hosting-advanced → ClickHouse timezone"
    );
  }

  await initializeCoreTables();
  await initializeAdminEventRollup(clickhouse);
  await ensureUtcTimeColumns("hourly_events_by_site_mv_target", UTC_TIME_COLUMNS.hourly_events_by_site_mv_target);

  if (IS_CLOUD) {
    await initializeCloudTables();
  }

  if (IDENTITY_RESOLUTION_V2) {
    const dictionaryCheck = await clickhouse.query({
      query: `SELECT dictGetOrDefault('${USER_IDENTITY_DICTIONARY}', 'user_id', tuple(toUInt64(0), ''), '') AS user_id`,
      format: "JSONEachRow",
    });
    await dictionaryCheck.json();
    clickhouseInitLogger.info({ dictionary: USER_IDENTITY_DICTIONARY }, "Identity dictionary is available");
  }

  if (LITE_DASHBOARD) {
    await initializeLiteDashboardMVs();
  }

  await provisionQueryUser();
};
