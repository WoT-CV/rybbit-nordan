import { isSiteGrantRole } from "@rybbit/shared";
import { and, eq } from "drizzle-orm";
import { db } from "../db/postgres/postgres.js";
import { member, memberSiteAccess } from "../db/postgres/schema.js";
import { siteIdsInOrganization } from "./access.js";
import { createServiceLogger } from "./logger/logger.js";

const logger = createServiceLogger("invitation-site-access");

// Better Auth's PostgreSQL adapter applies this server-owned default BEFORE
// INSERT, including acceptInvitation (which does not call beforeAddMember).
// The database default remains unchanged for existing non-SDK writers/rows.
export const restrictedMemberSiteAccessField = {
  type: "boolean",
  required: false,
  input: false,
  defaultValue: true,
  fieldName: "has_restricted_site_access",
} as const;

interface AcceptedInvitationSiteAccess {
  organizationId: string;
  hasRestrictedSiteAccess?: boolean | null;
  siteIds?: number[] | null;
  siteRole?: string | null;
}

/** Finalize only the invitation payload returned by the successful SDK accept. */
export async function applyInvitationSiteAccess(invitation: AcceptedInvitationSiteAccess, memberId: string) {
  const { organizationId, hasRestrictedSiteAccess, siteIds, siteRole } = invitation;

  // Only an explicitly unrestricted invitation can lift the INSERT-time
  // restriction. Missing/malformed data must not grant full organization access.
  if (hasRestrictedSiteAccess === false) {
    await db
      .update(member)
      .set({ hasRestrictedSiteAccess: false })
      .where(and(eq(member.id, memberId), eq(member.organizationId, organizationId)));
    return;
  }
  if (hasRestrictedSiteAccess !== true) {
    throw new Error("Accepted invitation is missing its site access restriction");
  }
  if (siteRole != null && !isSiteGrantRole(siteRole)) {
    throw new Error("Accepted invitation has an invalid site grant role");
  }
  if (siteIds != null && (!Array.isArray(siteIds) || siteIds.some(id => !Number.isSafeInteger(id) || id <= 0))) {
    throw new Error("Accepted invitation has invalid site ids");
  }

  // There is no invitation re-read and no unrestricted interval. On any lookup
  // or grant failure the new member keeps its INSERT-time restriction.
  // A site may have moved/deleted while the invitation was pending, so re-check
  // ownership immediately before writing grants, scoped to the invitation org.
  const invitedSiteIds = [...new Set(siteIds ?? [])];
  const grantableSiteIds = await siteIdsInOrganization(invitedSiteIds, organizationId);
  if (grantableSiteIds.length !== invitedSiteIds.length) {
    logger.warn(
      {
        organizationId,
        memberId,
        droppedSiteIds: invitedSiteIds.filter(siteId => !grantableSiteIds.includes(siteId)),
      },
      "Invitation named sites the organization no longer owns; those grants were dropped"
    );
  }
  if (grantableSiteIds.length > 0) {
    await db
      .insert(memberSiteAccess)
      .values(
        grantableSiteIds.map(siteId => ({ memberId, siteId, role: isSiteGrantRole(siteRole) ? siteRole : null }))
      );
  }
}

export function invitationSiteAccessHooks(invalidateSitesAccessCache: (userId: string) => void) {
  return {
    // The SDK calls this for organization creation and its server-only direct
    // addMember API, not invitation acceptance. Preserve their normal access.
    beforeAddMember: async () => ({ data: { hasRestrictedSiteAccess: false } }),
    afterAcceptInvitation: async ({
      invitation,
      member,
      user,
    }: {
      invitation: AcceptedInvitationSiteAccess;
      member: { id: string };
      user: { id: string };
    }) => {
      try {
        await applyInvitationSiteAccess(invitation, member.id);
      } catch (error) {
        logger.error({ err: error }, "Error applying invitation site restrictions");
      } finally {
        // Also evict after a partial/failed finalization: no previously cached
        // access decision may survive a newly accepted membership/grant change.
        invalidateSitesAccessCache(user.id);
      }
    },
  };
}
