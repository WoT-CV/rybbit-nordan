import { FilterParams } from "@rybbit/shared";
import { FastifyReply, FastifyRequest } from "fastify";
import { getTimeStatement } from "../utils/timeWindow.js";
import { buildFilteredSessionsCTE } from "../utils/sessionFilters.js";
import { analyticsRoute, runAnalyticsQuery } from "../utils/analyticsQuery.js";
import { enrichWithTraits } from "../utils/utils.js";

export type SessionLocationRow = {
  lat: number;
  lon: number;
  count: number;
  city: string;
  country: string;
  session_id: string;
  user_id: string;
  identified_user_id: string;
};

export interface GetSessionLocationsRequest {
  Params: {
    siteId: string;
  };
  Querystring: FilterParams<{}>;
}

export const buildSessionLocationsQuery = (query: GetSessionLocationsRequest["Querystring"], siteId: number) => {
  const timeStatement = getTimeStatement(query);
  const filteredSessionsCTE = buildFilteredSessionsCTE(query.filters, siteId, timeStatement);
  const filteredSessionsJoin = filteredSessionsCTE ? "INNER JOIN FilteredSessions USING (session_id)" : "";

  return `
WITH ${filteredSessionsCTE ? `${filteredSessionsCTE},` : ""}
stuff AS (
    SELECT
        session_id,
        argMax(user_id, timestamp) AS user_id,
        argMax(identified_user_id, timestamp) AS identified_user_id,
        argMax(lat, timestamp) AS lat,
        argMax(lon, timestamp) AS lon,
        argMax(city, timestamp) AS city,
        argMax(country, timestamp) AS country
    FROM
        events
    ${filteredSessionsJoin}
    WHERE
        site_id = {site:Int32}
        ${timeStatement}
    GROUP BY
        session_id
)
SELECT
    lat,
    lon,
    city,
    country,
    count() as count,
    any(session_id) AS session_id,
    any(user_id) AS user_id,
    any(identified_user_id) AS identified_user_id
from
    stuff
GROUP BY
    lat,
    lon,
    city,
    country`;
};

export const getSessionLocations = analyticsRoute<GetSessionLocationsRequest>(
  "session locations",
  async (req: FastifyRequest<GetSessionLocationsRequest>, res: FastifyReply) => {
    const { siteId } = req.params;

    const rows = await runAnalyticsQuery<SessionLocationRow>({
      query: buildSessionLocationsQuery(req.query, Number(siteId)),
      params: {
        site: siteId,
      },
    });

    // A location is an aggregate of sessions, not a person. Only a single
    // session can supply an identity; never attribute a group to its sample.
    const samples = await enrichWithTraits(rows.filter(row => row.count === 1), Number(siteId));
    const samplesBySession = new Map(samples.map(row => [row.session_id, row]));
    const data = rows.map(({ session_id, user_id, identified_user_id, ...location }) => {
      const sample = location.count === 1 ? samplesBySession.get(session_id) : undefined;
      return {
        ...location,
        sample: sample ? { session_id, user_id, identified_user_id, traits: sample.traits } : null,
      };
    });
    return res.status(200).send({ data });
  }
);
