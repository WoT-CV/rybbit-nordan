import type { ClickHouseClient } from "@clickhouse/client";
import { createServiceLogger } from "../../lib/logger/logger.js";

const TARGET_TABLE = "hourly_events_by_site_mv_target";
const MATERIALIZED_VIEW = "hourly_events_by_site_mv";
const RETENTION_DAYS = 60;

const logger = createServiceLogger("admin-event-rollup");

export interface AdminEventRollupStatus {
  targetExists: boolean;
  viewExists: boolean;
}

export async function getAdminEventRollupStatus(client: ClickHouseClient): Promise<AdminEventRollupStatus> {
  const result = await client.query({
    query: `
      SELECT name
      FROM system.tables
      WHERE database = currentDatabase()
        AND name IN ({target:String}, {view:String})
    `,
    query_params: {
      target: TARGET_TABLE,
      view: MATERIALIZED_VIEW,
    },
    format: "JSONEachRow",
  });

  const rows = await result.json<{ name: string }>();
  const existingObjects = new Set(rows.map(row => row.name));

  return {
    targetExists: existingObjects.has(TARGET_TABLE),
    viewExists: existingObjects.has(MATERIALIZED_VIEW),
  };
}

/**
 * Ensures that the rollup used by the admin endpoints exists on every
 * deployment, not only in Rybbit Cloud.
 *
 * A missing view means the target cannot be trusted to contain a continuous
 * history. In that case the target is rebuilt from the retained raw events
 * before the streaming materialized view is created. The operation is
 * restart-safe: a failed backfill leaves the view absent, so the next startup
 * truncates the partial target and retries.
 */
export async function initializeAdminEventRollup(client: ClickHouseClient): Promise<void> {
  const initialStatus = await getAdminEventRollupStatus(client);

  if (!initialStatus.targetExists && initialStatus.viewExists) {
    logger.warn("Admin event rollup target is missing; recreating the orphaned materialized view");
    await client.exec({ query: `DROP TABLE IF EXISTS ${MATERIALIZED_VIEW}` });
  }

  await client.exec({
    query: `
      CREATE TABLE IF NOT EXISTS ${TARGET_TABLE} (
        event_hour DateTime('UTC'),
        site_id UInt16,
        event_count UInt64
      )
      ENGINE = SummingMergeTree()
      PARTITION BY toYYYYMM(event_hour)
      ORDER BY (event_hour, site_id)
      TTL event_hour + INTERVAL ${RETENTION_DAYS} DAY
    `,
  });

  const needsRebuild = !initialStatus.targetExists || !initialStatus.viewExists;
  if (!needsRebuild) {
    return;
  }

  logger.info({ retentionDays: RETENTION_DAYS }, "Backfilling admin event rollup from raw events");

  await client.exec({ query: `TRUNCATE TABLE ${TARGET_TABLE}` });
  await client.exec({
    query: `
      INSERT INTO ${TARGET_TABLE} (event_hour, site_id, event_count)
      SELECT
        toStartOfHour(timestamp) AS event_hour,
        site_id,
        count() AS event_count
      FROM events
      WHERE timestamp >= now() - INTERVAL ${RETENTION_DAYS} DAY
        AND timestamp <= now()
      GROUP BY event_hour, site_id
    `,
  });

  await client.exec({
    query: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${MATERIALIZED_VIEW}
      TO ${TARGET_TABLE}
      AS SELECT
        toStartOfHour(timestamp) AS event_hour,
        site_id,
        count() AS event_count
      FROM events
      GROUP BY event_hour, site_id
    `,
  });
}
