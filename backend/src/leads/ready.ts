import type { Prisma } from "../generated/prisma/client.js";

/** A website with more locations than this is a chain. */
export const CHAIN_LOCATIONS = 10;

/** What "Ready now" depends on besides the lead itself. */
export interface ReadyContext {
  outreachCountries: string[];
  minLeadScore: number;
}

/**
 * "Ready now": the lead has a primary address (the primary is only ever an address that passed the
 * checks: not a department address, mail server not missing, generic-only and published-only rules),
 * is not suppressed, its country has outreach switched on (never job-search-only countries), and it
 * is not below the minimum lead score (leads not crawled yet have no score and count).
 * Leads already e-mailed by a campaign, or waiting in one, are not "ready".
 */
export function readyWhere(ctx: ReadyContext): Prisma.PlaceWhereInput {
  return {
    AND: [
      { primaryEmail: { not: null } },
      { suppressed: false },
      { country: { in: ctx.outreachCountries } },
      // A chain (more than 10 locations on one website) is not a fit for a small studio's offer.
      { locationCount: { lte: CHAIN_LOCATIONS } },
      // Not contacted yet, and not waiting in a campaign.
      { campaignLeads: { none: { OR: [{ step: { gt: 0 } }, { status: { in: ["waiting_crawl", "queued"] } }] } } },
      ...(ctx.minLeadScore > 0 ? [{ OR: [{ leadScore: null }, { leadScore: { gte: ctx.minLeadScore } }] }] : []),
    ],
  };
}
