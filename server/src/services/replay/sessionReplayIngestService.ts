import { clickhouse } from "../../db/clickhouse/clickhouse.js";
import { DateTime } from "luxon";
import { processResults } from "../../api/analytics/utils/utils.js";
import { toClickHouseDateTime } from "../../db/clickhouse/dateTime.js";
import { RecordSessionReplayRequest } from "../../types/sessionReplay.js";
import { createServiceLogger } from "../../lib/logger/logger.js";
import { correctReplayClockSkew } from "./replayClockSkew.js";
import { parseTrackingData } from "./trackingUtils.js";
import { sessionsService } from "../sessions/sessionsService.js";
import { userIdService } from "../userId/userIdService.js";
import { r2Storage } from "../storage/r2StorageService.js";
import { siteConfig } from "../../lib/siteConfig.js";
import {
  REPLAY_METADATA_MODE,
  type ReplayMetadataMode,
  shouldWriteReplayMetadataV1,
  shouldWriteReplayMetadataV2,
} from "./replayMetadataMode.js";

const logger = createServiceLogger("session-replay-ingest");

/** What a single batch observed about its session — no history involved. */
type BatchStats = {
  startTime: Date;
  endTime: Date;
  eventCount: number;
  compressedSizeBytes: number;
  screenWidth: number;
  screenHeight: number;
};

export interface RequestMetadata {
  userAgent: string;
  ipAddress: string;
  origin: string;
  referrer: string;
}

/**
 * Service responsible for ingesting session replay data
 * Handles recording events and updating metadata
 */
export class SessionReplayIngestService {
  constructor(private readonly replayMetadataMode: ReplayMetadataMode = REPLAY_METADATA_MODE) {}

  async recordEvents(
    siteId: number,
    request: RecordSessionReplayRequest,
    requestMeta?: RequestMetadata
  ): Promise<void> {
    const { anonymousId, userId: clientUserId, events: rawEvents, metadata } = request;

    // Device clocks, not ours. Correct the whole batch onto server time before
    // anything downstream partitions or TTLs on these values.
    const { events, skewMs } = correctReplayClockSkew(rawEvents, Date.now());
    if (skewMs !== 0) {
      logger.warn({ siteId, skewMs, eventCount: events.length }, "Corrected replay clock skew");
    }

    // New trackers provide a stable browser-scoped anonymous ID. Keep the
    // server-derived fingerprint as a compatibility fallback for older scripts.
    const deviceFingerprint = anonymousId
      ? await userIdService.generateUserIdFromClientId(anonymousId, siteId)
      : await userIdService.generateUserId(requestMeta?.ipAddress || "", requestMeta?.userAgent || "", siteId);

    // Check if client provided an identified user ID (different from device fingerprint)
    const trimmedClientUserId = clientUserId?.trim() || "";
    const identifiedUserId =
      trimmedClientUserId && trimmedClientUserId !== deviceFingerprint ? trimmedClientUserId : "";

    // Keep the device fingerprint as the stored user_id. The identified ID only
    // scopes session assignment so stored user identity semantics stay unchanged.
    const userId = deviceFingerprint;

    // Get or create a session ID from the sessions service
    const { sessionId } = await sessionsService.updateSession({
      userId,
      identifiedUserId,
      siteId,
    });

    // Check if R2 storage is enabled for cloud deployments
    let r2BatchKey: string | null = null;
    let eventDataArray: any[] = [];

    if (r2Storage.isEnabled()) {
      // Extract event data for R2 storage
      eventDataArray = events.map(event => event.data);

      try {
        // Store event data batch in R2
        r2BatchKey = await r2Storage.storeBatch(siteId, sessionId, eventDataArray);
      } catch (error) {
        console.error("Failed to store in R2, falling back to ClickHouse:", error);
        r2BatchKey = null;
      }
    }

    // Prepare events for batch insert
    const eventsToInsert = events.map((event, index) => {
      const serializedData = JSON.stringify(event.data);

      if (r2BatchKey) {
        // R2 storage: store metadata only in ClickHouse
        return {
          site_id: siteId,
          session_id: sessionId,
          user_id: userId,
          identified_user_id: identifiedUserId,
          timestamp: toClickHouseDateTime(event.timestamp),
          event_type: event.type,
          event_data: "", // Empty string when using R2
          event_data_key: r2BatchKey,
          batch_index: index,
          sequence_number: event.sequenceNumber ?? index,
          event_size_bytes: serializedData.length,
          viewport_width: metadata?.viewportWidth || null,
          viewport_height: metadata?.viewportHeight || null,
          is_complete: 0,
        };
      } else {
        // Traditional storage: store everything in ClickHouse
        return {
          site_id: siteId,
          session_id: sessionId,
          user_id: userId,
          identified_user_id: identifiedUserId,
          timestamp: toClickHouseDateTime(event.timestamp),
          event_type: event.type,
          event_data: serializedData,
          event_data_key: null,
          batch_index: null,
          sequence_number: event.sequenceNumber ?? index,
          event_size_bytes: serializedData.length,
          viewport_width: metadata?.viewportWidth || null,
          viewport_height: metadata?.viewportHeight || null,
          is_complete: 0,
        };
      }
    });

    // Batch insert events
    if (eventsToInsert.length > 0) {
      await clickhouse.insert({
        table: "session_replay_events",
        values: eventsToInsert,
        format: "JSONEachRow",
      });
    }

    // Update or insert metadata
    if (metadata) {
      // An events-free batch still carries metadata worth recording, but it has
      // no timestamps to bound it — anchor those on server time rather than
      // letting Math.min of nothing produce an epoch-dated row.
      const timestamps = events.length > 0 ? events.map(event => event.timestamp) : [Date.now()];
      const batchStats: BatchStats = {
        startTime: new Date(Math.min(...timestamps)),
        endTime: new Date(Math.max(...timestamps)),
        eventCount: eventsToInsert.length,
        compressedSizeBytes: eventsToInsert.reduce((total, event) => total + event.event_size_bytes, 0),
        screenWidth: metadata.viewportWidth || 0,
        screenHeight: metadata.viewportHeight || 0,
      };

      await this.updateSessionMetadata(siteId, sessionId, userId, identifiedUserId, metadata, batchStats, requestMeta);
    }
  }

  private async updateSessionMetadata(
    siteId: number,
    sessionId: string,
    userId: string,
    identifiedUserId: string,
    metadata: any,
    batchStats: BatchStats,
    requestMeta?: RequestMetadata
  ): Promise<void> {
    // In v1 and dual mode the legacy table remains a complete rollback target,
    // so it still needs the cumulative session totals. V2 is append-only and
    // receives only this batch's contribution.
    const legacyStats = shouldWriteReplayMetadataV1(this.replayMetadataMode)
      ? await this.getLegacySessionStats(siteId, sessionId, batchStats)
      : null;

    let trackingData: any = {};
    if (requestMeta?.userAgent) {
      try {
        // Extract hostname from the page URL
        const urlObj = new URL(metadata.pageUrl);
        const hostname = urlObj.hostname;

        trackingData = await parseTrackingData(
          requestMeta.userAgent,
          requestMeta.ipAddress,
          requestMeta.referrer || "",
          urlObj.search || "", // querystring from URL
          hostname,
          metadata.language || "", // language from client
          batchStats.screenWidth || metadata.viewportWidth || 0,
          batchStats.screenHeight || metadata.viewportHeight || 0
        );
      } catch (error) {
        logger.error({ siteId, sessionId, err: error }, "Error parsing tracking data for session replay");
      }
    }

    if (legacyStats) {
      await this.writeLegacyMetadata(siteId, sessionId, userId, identifiedUserId, metadata, legacyStats, trackingData);
    }

    if (shouldWriteReplayMetadataV2(this.replayMetadataMode)) {
      await this.writeV2Metadata(siteId, sessionId, userId, identifiedUserId, metadata, batchStats, trackingData);
    }
  }

  private async getLegacySessionStats(siteId: number, sessionId: string, fallback: BatchStats): Promise<BatchStats> {
    const sessionInfo = await clickhouse.query({
      query: `
        SELECT
          MIN(timestamp) AS start_time,
          MAX(timestamp) AS end_time,
          COUNT() AS event_count,
          SUM(event_size_bytes) AS compressed_size_bytes,
          MAX(viewport_width) AS screen_width,
          MAX(viewport_height) AS screen_height
        FROM session_replay_events
        WHERE site_id = {siteId:UInt16}
          AND session_id = {sessionId:String}
      `,
      query_params: { siteId, sessionId },
      format: "JSONEachRow",
    });

    type LegacyStatsRow = {
      start_time: string;
      end_time: string | null;
      event_count: number | string;
      compressed_size_bytes: number | string;
      screen_width: number | string | null;
      screen_height: number | string | null;
    };

    const [row] = await processResults<LegacyStatsRow>(sessionInfo);
    if (!row || Number(row.event_count) === 0) {
      return fallback;
    }

    const startTime = DateTime.fromSQL(row.start_time, { zone: "utc" });
    const endTime = row.end_time ? DateTime.fromSQL(row.end_time, { zone: "utc" }) : startTime;

    return {
      startTime: startTime.isValid ? startTime.toJSDate() : fallback.startTime,
      endTime: endTime.isValid ? endTime.toJSDate() : fallback.endTime,
      eventCount: Number(row.event_count),
      compressedSizeBytes: Number(row.compressed_size_bytes),
      screenWidth: Number(row.screen_width ?? fallback.screenWidth),
      screenHeight: Number(row.screen_height ?? fallback.screenHeight),
    };
  }

  private async writeLegacyMetadata(
    siteId: number,
    sessionId: string,
    userId: string,
    identifiedUserId: string,
    metadata: any,
    stats: BatchStats,
    trackingData: any
  ): Promise<void> {
    await clickhouse.insert({
      table: "session_replay_metadata",
      values: [
        {
          site_id: siteId,
          session_id: sessionId,
          user_id: userId,
          identified_user_id: identifiedUserId,
          start_time: DateTime.fromJSDate(stats.startTime, { zone: "utc" }).toFormat("yyyy-MM-dd HH:mm:ss"),
          end_time: DateTime.fromJSDate(stats.endTime, { zone: "utc" }).toFormat("yyyy-MM-dd HH:mm:ss"),
          duration_ms: Math.max(0, stats.endTime.getTime() - stats.startTime.getTime()),
          event_count: stats.eventCount,
          compressed_size_bytes: stats.compressedSizeBytes,
          page_url: metadata.pageUrl || "",
          country: trackingData.country || "",
          region: trackingData.region || "",
          city: trackingData.city || "",
          lat: trackingData.lat || 0,
          lon: trackingData.lon || 0,
          browser: trackingData.browser || "",
          browser_version: trackingData.browserVersion || "",
          operating_system: trackingData.operatingSystem || "",
          operating_system_version: trackingData.operatingSystemVersion || "",
          language: trackingData.language || "",
          screen_width: stats.screenWidth || metadata?.viewportWidth || 0,
          screen_height: stats.screenHeight || metadata?.viewportHeight || 0,
          device_type: trackingData.deviceType || "",
          channel: trackingData.channel || "",
          hostname: trackingData.hostname || "",
          referrer: trackingData.referrer || "",
          has_replay_data: 1,
        },
      ],
      format: "JSONEachRow",
    });
  }

  private async writeV2Metadata(
    siteId: number,
    sessionId: string,
    userId: string,
    identifiedUserId: string,
    metadata: any,
    batchStats: BatchStats,
    trackingData: any
  ): Promise<void> {
    await clickhouse.insert({
      table: "session_replay_metadata_v2",
      values: [
        {
          site_id: siteId,
          session_id: sessionId,
          user_id: userId,
          identified_user_id: identifiedUserId,
          start_time: toClickHouseDateTime(batchStats.startTime),
          end_time: toClickHouseDateTime(batchStats.endTime),
          event_count: batchStats.eventCount,
          compressed_size_bytes: batchStats.compressedSizeBytes,
          page_url: metadata.pageUrl || "",
          country: trackingData.country || "",
          region: trackingData.region || "",
          city: trackingData.city || "",
          lat: trackingData.lat || 0,
          lon: trackingData.lon || 0,
          browser: trackingData.browser || "",
          browser_version: trackingData.browserVersion || "",
          operating_system: trackingData.operatingSystem || "",
          operating_system_version: trackingData.operatingSystemVersion || "",
          language: trackingData.language || "",
          screen_width: batchStats.screenWidth || metadata?.viewportWidth || 0,
          screen_height: batchStats.screenHeight || metadata?.viewportHeight || 0,
          device_type: trackingData.deviceType || "",
          channel: trackingData.channel || "",
          hostname: trackingData.hostname || "",
          referrer: trackingData.referrer || "",
          has_replay_data: 1,
        },
      ],
      format: "JSONEachRow",
    });
  }
}
