import { DateTime } from "luxon";
import { clickhouse } from "../../db/clickhouse/clickhouse.js";
import { createServiceLogger } from "../../lib/logger/logger.js";

interface EventCountResult {
  site_id: string | number;
  events_24h: string | number;
  events_30d: string | number;
}

export interface SiteEventCountMaps {
  last24Hours: Map<number, number>;
  last30Days: Map<number, number>;
}

const logger = createServiceLogger("admin-site-event-counts");

function toEventCountMaps(rows: EventCountResult[]): SiteEventCountMaps {
  const last24Hours = new Map<number, number>();
  const last30Days = new Map<number, number>();

  for (const row of rows) {
    const siteId = Number(row.site_id);
    last24Hours.set(siteId, Number(row.events_24h));
    last30Days.set(siteId, Number(row.events_30d));
  }

  return { last24Hours, last30Days };
}

async function queryEventCounts(query: string, queryParams: Record<string, string>): Promise<SiteEventCountMaps> {
  const result = await clickhouse.query({
    query,
    query_params: queryParams,
    format: "JSONEachRow",
  });

  return toEventCountMaps(await result.json<EventCountResult>());
}

/**
 * Reads both admin time ranges in one ClickHouse query. The raw-events fallback
 * keeps the admin API available if the rollup is removed or damaged at runtime.
 */
export async function getSiteEventCounts(now: DateTime = DateTime.utc()): Promise<SiteEventCountMaps> {
  now = now.toUTC();
  const queryParams = {
    from24h: now.minus({ hours: 24 }).toFormat("yyyy-MM-dd HH:mm:ss"),
    from30d: now.minus({ days: 30 }).toFormat("yyyy-MM-dd HH:mm:ss"),
    to: now.toFormat("yyyy-MM-dd HH:mm:ss"),
  };

  try {
    return await queryEventCounts(
      `
        SELECT
          site_id,
          sumIf(event_count, event_hour >= toDateTime({from24h:String}, 'UTC')) AS events_24h,
          sum(event_count) AS events_30d
        FROM hourly_events_by_site_mv_target
        WHERE event_hour >= toDateTime({from30d:String}, 'UTC')
          AND event_hour <= toDateTime({to:String}, 'UTC')
        GROUP BY site_id
      `,
      queryParams
    );
  } catch (error) {
    logger.warn({ err: error }, "Admin event rollup query failed; falling back to raw events");

    return queryEventCounts(
      `
        SELECT
          site_id,
          countIf(timestamp >= toDateTime({from24h:String}, 'UTC')) AS events_24h,
          count() AS events_30d
        FROM events
        WHERE timestamp >= toDateTime({from30d:String}, 'UTC')
          AND timestamp <= toDateTime({to:String}, 'UTC')
        GROUP BY site_id
      `,
      queryParams
    );
  }
}
