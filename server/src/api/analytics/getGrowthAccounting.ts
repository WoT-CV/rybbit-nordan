import { DateTime } from "luxon";
import { FastifyReply, FastifyRequest } from "fastify";
import type { GrowthAccountingMode, GrowthAccountingPoint } from "@rybbit/shared";
import { z } from "zod";

import { clickhouse } from "../../db/clickhouse/clickhouse.js";
import { processResults } from "./utils/utils.js";
import { clickhouseEffectiveUserId } from "../../services/userIdentity/userIdentityService.js";

export interface GrowthAccountingRow {
  period: string;
  new_users: number;
  returning_users: number;
  resurrecting_users: number;
  dormant_users: number;
}

const querySchema = z.object({
  mode: z.enum(["day", "week"]).default("day"),
  range: z.coerce.number().int().min(7).max(365).default(90),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
  pastMinutesStart: z.coerce.number().nonnegative().optional(),
  pastMinutesEnd: z.coerce.number().nonnegative().optional(),
  timeZone: z
    .string()
    .default("UTC")
    .refine(value => {
      try {
        Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    }, "Invalid timeZone"),
});

type GrowthAccountingQuery = z.infer<typeof querySchema>;

function resolveRequestedRange(query: GrowthAccountingQuery) {
  const now = DateTime.now().setZone(query.timeZone);
  let start: DateTime;
  let end: DateTime;

  if (query.startDateTime !== undefined || query.endDateTime !== undefined) {
    if (!query.startDateTime || !query.endDateTime) {
      throw new Error("startDateTime and endDateTime must be provided together");
    }
    start = DateTime.fromSQL(query.startDateTime, { zone: "utc" }).setZone(query.timeZone);
    end = DateTime.fromSQL(query.endDateTime, { zone: "utc" }).setZone(query.timeZone);
  } else if (query.pastMinutesStart !== undefined || query.pastMinutesEnd !== undefined) {
    if (query.pastMinutesStart === undefined || query.pastMinutesEnd === undefined) {
      throw new Error("pastMinutesStart and pastMinutesEnd must be provided together");
    }
    start = now.minus({ minutes: query.pastMinutesStart });
    end = now.minus({ minutes: query.pastMinutesEnd });
  } else if (query.startDate !== undefined || query.endDate !== undefined) {
    if (!query.startDate || !query.endDate) {
      throw new Error("startDate and endDate must be provided together");
    }
    start = DateTime.fromISO(query.startDate, { zone: query.timeZone }).startOf("day");
    end = DateTime.fromISO(query.endDate, { zone: query.timeZone }).endOf("day");
  } else {
    start = now.startOf("day").minus({ days: query.range - 1 });
    end = now;
  }

  if (!start.isValid || !end.isValid || start > end) {
    throw new Error("Invalid growth accounting time range");
  }

  const earliestAllowed = end.startOf("day").minus({ days: 364 });
  const limitedStart = start < earliestAllowed ? earliestAllowed : start;
  const range = Math.floor(end.startOf("day").diff(limitedStart.startOf("day"), "days").days) + 1;

  return { start: limitedStart, end, range };
}

export const getGrowthAccounting = async (
  request: FastifyRequest<{
    Params: { siteId: string };
    Querystring: {
      mode?: string;
      range?: string;
      timeZone?: string;
      startDate?: string;
      endDate?: string;
      startDateTime?: string;
      endDateTime?: string;
      pastMinutesStart?: string;
      pastMinutesEnd?: string;
    };
  }>,
  reply: FastifyReply
) => {
  const siteId = Number(request.params.siteId);
  if (!Number.isInteger(siteId) || siteId <= 0 || siteId > 65535) {
    return reply.status(400).send({ error: "Invalid site ID" });
  }

  // Accept the unified analytics wire format without breaking existing callers.
  const wire = request.query as Record<string, unknown>;
  const parsedQuery = querySchema.safeParse({
    ...wire,
    timeZone: wire.time_zone ?? wire.timeZone,
    startDate: wire.start_date || wire.startDate || undefined,
    endDate: wire.end_date || wire.endDate || undefined,
    startDateTime: wire.start_date_time ?? wire.startDateTime,
    endDateTime: wire.end_date_time ?? wire.endDateTime,
    pastMinutesStart: wire.past_minutes_start ?? wire.pastMinutesStart,
    pastMinutesEnd: wire.past_minutes_end ?? wire.pastMinutesEnd,
  });
  if (!parsedQuery.success) {
    return reply.status(400).send({ error: parsedQuery.error.errors[0]?.message ?? "Invalid query" });
  }

  const { mode, timeZone } = parsedQuery.data;
  let requestedRange: ReturnType<typeof resolveRequestedRange>;
  try {
    requestedRange = resolveRequestedRange(parsedQuery.data);
  } catch (error) {
    return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid time range" });
  }

  const { start: requestedStart, end: requestedEnd, range } = requestedRange;
  const periodUnit = mode === "day" ? "day" : "week";
  const displayStart = mode === "day" ? requestedStart.startOf("day") : requestedStart.startOf("week");
  const displayEnd = mode === "day" ? requestedEnd.startOf("day") : requestedEnd.startOf("week");
  const activityStart = displayStart.minus({ [periodUnit]: 1 });
  const activityEnd = displayEnd.plus({ [periodUnit]: 1 });

  const periodExpression =
    mode === "day"
      ? "toStartOfDay(toTimeZone(timestamp, {timeZone:String}))"
      : "toStartOfWeek(toTimeZone(timestamp, {timeZone:String}), 1)";
  const firstPeriodExpression =
    mode === "day"
      ? "toStartOfDay(toTimeZone(min(timestamp), {timeZone:String}))"
      : "toStartOfWeek(toTimeZone(min(timestamp), {timeZone:String}), 1)";
  const previousPeriodExpression =
    mode === "day" ? "addDays(current_activity.activity_period, -1)" : "addWeeks(current_activity.activity_period, -1)";
  const nextPeriodExpression =
    mode === "day" ? "addDays(previous_activity.activity_period, 1)" : "addWeeks(previous_activity.activity_period, 1)";
  const effectiveUserId = clickhouseEffectiveUserId("events");

  const result = await clickhouse.query({
    query: `
WITH
FirstActivity AS (
    SELECT
        ${effectiveUserId} AS effective_user_id,
        toDateTime(${firstPeriodExpression}) AS first_period
    FROM events
    PREWHERE site_id = {siteId:UInt16}
    WHERE ${effectiveUserId} != ''
    GROUP BY effective_user_id
),
PeriodActivity AS (
    SELECT
        ${effectiveUserId} AS effective_user_id,
        toDateTime(${periodExpression}) AS activity_period,
        toUInt8(1) AS active
    FROM events
    PREWHERE site_id = {siteId:UInt16}
    WHERE timestamp >= {activityStart:DateTime}
      AND timestamp < {activityEnd:DateTime}
      AND ${effectiveUserId} != ''
    GROUP BY effective_user_id, activity_period
),
ActiveAccounting AS (
    SELECT
        current_activity.activity_period AS period,
        countIf(first.first_period = current_activity.activity_period) AS new_users,
        countIf(previous_activity.active = 1) AS returning_users,
        countIf(first.first_period < current_activity.activity_period AND previous_activity.active = 0) AS resurrecting_users
    FROM PeriodActivity current_activity
    INNER JOIN FirstActivity first ON first.effective_user_id = current_activity.effective_user_id
    LEFT JOIN PeriodActivity previous_activity
      ON previous_activity.effective_user_id = current_activity.effective_user_id
     AND previous_activity.activity_period = ${previousPeriodExpression}
    WHERE current_activity.activity_period >= toDateTime({displayStart:String}, {timeZone:String})
      AND current_activity.activity_period <= toDateTime({displayEnd:String}, {timeZone:String})
    GROUP BY period
),
DormantAccounting AS (
    SELECT
        ${nextPeriodExpression} AS period,
        countIf(current_activity.active = 0) AS dormant_users
    FROM PeriodActivity previous_activity
    LEFT JOIN PeriodActivity current_activity
      ON current_activity.effective_user_id = previous_activity.effective_user_id
     AND current_activity.activity_period = ${nextPeriodExpression}
    WHERE previous_activity.activity_period >= toDateTime({activityDisplayStart:String}, {timeZone:String})
      AND ${nextPeriodExpression} <= toDateTime({displayEnd:String}, {timeZone:String})
    GROUP BY period
)
SELECT
    formatDateTime(period, '%F') AS period,
    sum(new_users) AS new_users,
    sum(returning_users) AS returning_users,
    sum(resurrecting_users) AS resurrecting_users,
    sum(dormant_users) AS dormant_users
FROM (
    SELECT
        period,
        new_users,
        returning_users,
        resurrecting_users,
        toUInt64(0) AS dormant_users
    FROM ActiveAccounting
    UNION ALL
    SELECT
        period,
        toUInt64(0) AS new_users,
        toUInt64(0) AS returning_users,
        toUInt64(0) AS resurrecting_users,
        dormant_users
    FROM DormantAccounting
)
GROUP BY period
ORDER BY period ASC
    `,
    format: "JSONEachRow",
    query_params: {
      siteId,
      timeZone,
      activityStart: activityStart.toUTC().toFormat("yyyy-MM-dd HH:mm:ss"),
      activityEnd: activityEnd.toUTC().toFormat("yyyy-MM-dd HH:mm:ss"),
      activityDisplayStart: activityStart.toFormat("yyyy-MM-dd HH:mm:ss"),
      displayStart: displayStart.toFormat("yyyy-MM-dd HH:mm:ss"),
      displayEnd: displayEnd.toFormat("yyyy-MM-dd HH:mm:ss"),
    },
    clickhouse_settings: {
      max_execution_time: 10,
      readonly: "2",
    },
  });

  const rows = await processResults<GrowthAccountingRow>(result);
  const data = mapGrowthAccountingRows(rows, displayStart, displayEnd, mode);

  return reply.send({ data, mode, range });
};

export function mapGrowthAccountingRows(
  rows: GrowthAccountingRow[],
  displayStart: DateTime,
  displayEnd: DateTime,
  mode: GrowthAccountingMode
): GrowthAccountingPoint[] {
  const rowsByPeriod = new Map(rows.map(row => [row.period, row]));
  const periodUnit = mode === "day" ? "day" : "week";
  const data: GrowthAccountingPoint[] = [];

  for (let period = displayStart; period <= displayEnd; period = period.plus({ [periodUnit]: 1 })) {
    const periodKey = period.toISODate() ?? period.toFormat("yyyy-MM-dd");
    const row = rowsByPeriod.get(periodKey);
    data.push({
      period: periodKey,
      newUsers: row?.new_users ?? 0,
      returningUsers: row?.returning_users ?? 0,
      resurrectingUsers: row?.resurrecting_users ?? 0,
      dormantUsers: row?.dormant_users ?? 0,
    });
  }
  return data;
}
