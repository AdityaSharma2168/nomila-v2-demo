/**
 * publicCard/gather.ts — everything the draft builder reads, in one place (design-public-card-v3 §9 "Data sources").
 *
 * Her side only (behind requireAuth on /me/public-card); the PUBLIC path never calls this — it reads the frozen
 * snapshot through publicCardReader. Every read is keyed by the athlete id handed in.
 *
 *   record         getAthleteRecord: her name and the nickname she gave (said)
 *   identity       buildIdentityIntelligenceView (the /me/story data): essence, chapters, proof points, causes, her
 *                  words, audience, guardrails, directives, unresolved
 *   positioning    the current Brief's positioning statement (memory_briefs.display), for the identity line
 *   affiliations   athlete_affiliations, current said / proof rows only (found rows are not confirmed)
 *   partners       deals she marked signed (deals.signed_at), with the brand's name and logo
 *   media          her own media (connected or uploaded, stored, not deleted, not generated, not rejected)
 *   offers         her published offers, each with the all-in total quoted now (quoteBookingCharge)
 *   picks          publicShelf (SHOP_V1 + her shelf's own gates)
 *   mia            her M.I.A. number and level — read ONLY when she switched show_mia on
 *   socials        her connected social profiles (public usernames only)
 *   verified       claimed account + at least one active connected social account with a measured audience (Q7)
 *   bookReady      BOOKINGS on, she is on the pilot list, payouts ready, ≥ 1 published offer
 *
 * No model call is made anywhere in the draft: every line already exists (her words, assembled facts, or identity
 * synthesis she approves), so the Narrator is not needed.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { athletes, connectAccounts, connectedAccounts } from "../../../shared/schema";
import { ownMedia, publishedOffers, signedPartners, type GatheredMedia, type GatheredOffer, type GatheredPartner } from "./sources";
import { getAthleteRecord } from "../athleteRecord";
import { listAffiliations, type Affiliation } from "../affiliations";
import { buildIdentityIntelligenceView } from "../intelligence/identityIntelligence/view";
import type { IdentityIntelligenceView } from "../intelligence/identityIntelligence/contract";
import type { PublicSocialLink } from "./types";
import { buildMyIntelligence } from "../intelligence/views/myIntelligence";
import { publicShelf, type PublicPick } from "../shop/publicShelf";
import { BOOKINGS } from "../bookings/config";
import { createLogger } from "../../logger";
import { dbStore } from "../../agent/research/dbStore";

const logger = createLogger("publicCard/gather");

export interface DraftInputs {
  fullName: string;
  nickname: { value: string; ref: string } | null;
  identity: IdentityIntelligenceView | null;
  /**
   * The current Brief's positioning statement (memory_briefs.display.positioning), the identity line's first choice.
   * `hers` when she wrote the statement herself (display.editedByAthlete). Null when there is no Brief or no statement.
   */
  positioning?: { statement: string; briefId: string; factIds: string[]; hers: boolean } | null;
  affiliations: Affiliation[];
  partners: GatheredPartner[];
  media: GatheredMedia[];
  offers: GatheredOffer[];
  picks: PublicPick[];
  /** Her connected social profiles (active accounts with a public username). */
  socials: PublicSocialLink[];
  mia: { score: number; band: string | null; asOf: string | null } | null;
  verified: boolean;
  bookReady: boolean;
  /** For the stats' "as of". */
  now: Date;
}

const SOCIAL = ["instagram", "tiktok", "youtube", "x", "twitter", "facebook", "twitch", "linkedin", "threads", "snapchat"];

async function safe<T>(what: string, athleteId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (err: any) {
    logger.warn({ athleteId, what, error: String(err?.message ?? err).slice(0, 200) }, "public card source unavailable");
    return fallback;
  }
}

async function verifiedMark(athleteId: string, identity: IdentityIntelligenceView | null, db = defaultDb): Promise<boolean> {
  const [a] = await db.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, athleteId));
  if (!a?.auth_id) return false;
  const measured = new Set((identity?.audience?.measured?.platforms ?? []).filter((p) => p.followers != null).map((p) => p.platform.toLowerCase()));
  if (!measured.size) return false;
  const live = await db.select({ platform: connectedAccounts.platform }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active"), inArray(connectedAccounts.platform, SOCIAL)));
  return live.some((c) => measured.has(c.platform.toLowerCase()));
}

/**
 * Her public profiles, from accounts she connected (active, with a username). The network name and profile URL come
 * from a small table of platform URL shapes; a platform without one is left out rather than guessed.
 */
const PROFILE_URL: Record<string, { network: string; url: (h: string) => string }> = {
  instagram: { network: "Instagram", url: (h) => `https://www.instagram.com/${h}` },
  tiktok:    { network: "TikTok",    url: (h) => `https://www.tiktok.com/@${h}` },
  youtube:   { network: "YouTube",   url: (h) => `https://www.youtube.com/@${h}` },
  x:         { network: "X",         url: (h) => `https://x.com/${h}` },
  twitter:   { network: "X",         url: (h) => `https://x.com/${h}` },
  twitch:    { network: "Twitch",    url: (h) => `https://www.twitch.tv/${h}` },
  threads:   { network: "Threads",   url: (h) => `https://www.threads.net/@${h}` },
};
export async function socialLinks(athleteId: string, db = defaultDb): Promise<PublicSocialLink[]> {
  const rows = await db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active"), inArray(connectedAccounts.platform, Object.keys(PROFILE_URL))));
  const seen = new Set<string>();
  const out: PublicSocialLink[] = [];
  for (const r of rows) {
    const handle = (r.username ?? "").trim().replace(/^@/, "");
    const shape = PROFILE_URL[r.platform.toLowerCase()];
    if (!shape || !/^[A-Za-z0-9._-]{1,60}$/.test(handle) || seen.has(shape.network)) continue;
    seen.add(shape.network);
    out.push({ network: shape.network, url: shape.url(encodeURIComponent(handle)), handle });
  }
  return out;
}

async function briefPositioning(athleteId: string): Promise<DraftInputs["positioning"]> {
  const brief = await dbStore.currentBrief(athleteId);
  const pos = brief?.display?.positioning;
  const statement = typeof pos?.statement === "string" ? pos.statement.trim() : "";
  if (!brief || !statement) return null;
  return {
    statement, briefId: brief.id,
    factIds: (Array.isArray(pos?.factIds) ? pos.factIds : []).filter((id): id is string => typeof id === "string" && !!id),
    hers: !!brief.display?.editedByAthlete?.fields?.includes("statement"),
  };
}

async function bookingReady(athleteId: string, offerCount: number, db = defaultDb): Promise<boolean> {
  if (!BOOKINGS.enabled || !BOOKINGS.pilotAthleteIds.includes(athleteId) || offerCount === 0) return false;
  const [acct] = await db.select({ payouts: connectAccounts.payouts_enabled }).from(connectAccounts).where(eq(connectAccounts.athlete_id, athleteId));
  return !!acct?.payouts;   // no age gate on the athlete (owner, 22 Oct): youth athletes book like anyone
}

export async function gatherDraftInputs(athleteId: string, opts: { showMia: boolean; now?: Date }): Promise<DraftInputs> {
  const now = opts.now ?? new Date();
  const [athlete] = await defaultDb.select({ full_name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId));
  const [record, identity, affiliations, partners, media, offerRows, shelf, positioning] = await Promise.all([
    safe("record", athleteId, () => getAthleteRecord(athleteId), null),
    safe("identity", athleteId, () => buildIdentityIntelligenceView(athleteId, now), null),
    safe("affiliations", athleteId, () => listAffiliations(athleteId), [] as Affiliation[]),
    signedPartners(athleteId),
    ownMedia(athleteId),
    publishedOffers(athleteId),
    safe("picks", athleteId, () => publicShelf(athleteId), { picks: [], amazonStatement: null }),
    safe("positioning", athleteId, () => briefPositioning(athleteId), null),
  ]);
  const nick = record?.groups.flatMap((g) => g.entries).find((e) => e.field === "nickname" && e.kind === "said" && e.value);
  let mia: DraftInputs["mia"] = null;
  if (opts.showMia) {
    const view = await safe("mia", athleteId, () => buildMyIntelligence(athleteId, { now }), null);
    const a = view?.assessment;
    if (a && Number.isFinite(a.score)) mia = { score: a.score, band: a.overall?.level ?? null, asOf: a.evidenceAsOf ?? null };
  }
  const [verified, bookReady, socials] = await Promise.all([
    safe("verified", athleteId, () => verifiedMark(athleteId, identity), false),
    safe("bookings", athleteId, () => bookingReady(athleteId, offerRows.length), false),
    safe("socials", athleteId, () => socialLinks(athleteId), [] as PublicSocialLink[]),
  ]);
  return {
    fullName: (record?.header?.name || athlete?.full_name || "").trim(),
    nickname: nick?.value ? { value: nick.value.trim(), ref: "nickname" } : null,
    identity, positioning, affiliations, partners, media, offers: offerRows, picks: shelf.picks, socials, mia, verified, bookReady, now,
  };
}
