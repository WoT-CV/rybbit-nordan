import { FastifyReply, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/postgres/postgres.js";
import { userProfiles } from "../../db/postgres/schema.js";
import { siteConfig } from "../../lib/siteConfig.js";
import { usageService } from "../usageService.js";
import { userIdService } from "../userId/userIdService.js";
import { resolveClientIp } from "./resolveClientIp.js";
import { isTrustedServerSideIngestion } from "./trackingRequest.js";
import { createServiceLogger } from "../../lib/logger/logger.js";
import { claimLegacyClientAlias, claimTrackerAlias } from "../userIdentity/userIdentityService.js";

const logger = createServiceLogger("identify-service");

// Max traits size in bytes (2KB)
const MAX_TRAITS_SIZE = 2048;

// Validation schema for identify requests
const identifyPayloadSchema = z.object({
  site_id: z.string().min(1),
  anonymous_id: z.string().min(1).max(255).optional(),
  user_id: z.string().min(1).max(255),
  ip_address: z.string().ip().optional(),
  user_agent: z.string().max(512).optional(),
  traits: z
    .record(z.unknown())
    .optional()
    .refine(
      traits => {
        if (!traits) return true;
        const size = new TextEncoder().encode(JSON.stringify(traits)).length;
        return size <= MAX_TRAITS_SIZE;
      },
      { message: `Traits must be less than ${MAX_TRAITS_SIZE} bytes (2KB)` }
    ),
  is_new_identify: z.boolean().default(true),
});

export async function handleIdentify(request: FastifyRequest, reply: FastifyReply) {
  try {
    const validationResult = identifyPayloadSchema.safeParse(request.body);

    if (!validationResult.success) {
      return reply.status(400).send({
        success: false,
        error: "Invalid payload",
        details: validationResult.error.flatten(),
      });
    }

    const { site_id, anonymous_id, user_id, traits, is_new_identify, ip_address, user_agent } = validationResult.data;

    // Get site configuration
    const siteConfiguration = await siteConfig.getConfig(site_id);
    if (!siteConfiguration) {
      return reply.status(404).send({
        success: false,
        error: "Site not found",
      });
    }

    const siteId = siteConfiguration.siteId;

    // A site whose organization has no plan collects nothing, profiles and aliases included.
    if (usageService.isSiteWithoutPlan(siteId)) {
      return reply.status(200).send("Site has no plan, identify not stored");
    }

    // Like tracking, only a bearer with ingest:write may speak for another
    // visitor. Otherwise anyone who knew a visitor's IP and user agent could
    // point that visitor's fingerprint at a user id of their choosing.
    const trustedOverride =
      (ip_address !== undefined || user_agent !== undefined) && (await isTrustedServerSideIngestion(request, siteId));
    const requestIp =
      (trustedOverride && ip_address) ||
      resolveClientIp(request, { firstPartyProxy: siteConfiguration.firstPartyProxy });
    const requestUserAgent = (trustedOverride && user_agent) || request.headers["user-agent"] || "";

    const anonymousId = anonymous_id
      ? await userIdService.generateUserIdFromClientId(anonymous_id, siteId)
      : await userIdService.generateUserId(requestIp, requestUserAgent, siteId);
    // Create alias if this is a new identify call (links anonymous_id to user_id)
    if (is_new_identify) {
      const aliasClaim = await claimTrackerAlias(siteId, anonymousId, user_id);
      if (aliasClaim.status === "conflict") {
        logger.warn(
          { siteId, anonymousId, requestedUserId: user_id, existingUserId: aliasClaim.existingUserId },
          "Rejected tracker alias reassignment"
        );
        return reply.status(409).send({
          success: false,
          code: "ANONYMOUS_ID_ALREADY_LINKED",
          rotateAnonymousId: true,
        });
      }

      if (anonymous_id) {
        const legacyAnonymousId = await userIdService.generateLegacyUserIdFromClientId(anonymous_id, siteId);
        if (legacyAnonymousId !== anonymousId) {
          const legacyClaim = await claimLegacyClientAlias(siteId, legacyAnonymousId, user_id);
          if (legacyClaim.status === "conflict") {
            logger.warn(
              {
                siteId,
                anonymousId: legacyAnonymousId,
                requestedUserId: user_id,
                existingUserId: legacyClaim.existingUserId,
              },
              "Skipped conflicting legacy client alias"
            );
          }
        }
      }

      // Ensure a user_profiles row exists at identify time so the user is
      // discoverable via search/inventory queries even when no traits are set,
      // and so createdAt reflects identification time rather than first setTraits.
      try {
        await db.insert(userProfiles).values({ siteId, userId: user_id }).onConflictDoNothing();
      } catch (error) {
        logger.error({ siteId, userId: user_id, err: error }, "Error creating user profile shell");
      }
    }

    // Atomic upsert: merge non-null traits and remove keys explicitly set to null.
    if (traits && Object.keys(traits).length > 0) {
      try {
        const filteredTraits = Object.fromEntries(Object.entries(traits).filter(([_, v]) => v !== null));
        const nullKeys = Object.entries(traits)
          .filter(([_, v]) => v === null)
          .map(([k]) => k);

        // When nullKeys is empty, drizzle serializes [] as `()` which is invalid
        // Postgres array literal syntax. Skip the subtract clause in that case.
        const traitsExpr =
          nullKeys.length > 0
            ? sql`(${userProfiles.traits} - ${nullKeys}::text[]) || ${JSON.stringify(filteredTraits)}::jsonb`
            : sql`${userProfiles.traits} || ${JSON.stringify(filteredTraits)}::jsonb`;

        await db
          .insert(userProfiles)
          .values({ siteId, userId: user_id, traits: filteredTraits })
          .onConflictDoUpdate({
            target: [userProfiles.siteId, userProfiles.userId],
            set: {
              traits: traitsExpr,
              updatedAt: sql`now()`,
            },
          });
      } catch (error) {
        logger.error({ siteId, userId: user_id, err: error }, "Error updating user profile");
      }
    }

    return reply.status(200).send({
      success: true,
    });
  } catch (error) {
    logger.error({ err: error }, "Error handling identify");
    return reply.status(500).send({
      success: false,
      error: "Failed to process identify",
    });
  }
}
