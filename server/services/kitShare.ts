/**
 * kitShare — the share layer + analytics for the Nomi Card (docs/media-kit-specs.md Spec 6).
 *
 * A SHARE decouples "how the card is sent" from the canonical kit. mode=live renders the current
 * cached kit (always up to date); mode=snapshot freezes a copy at share time (consistent as it's
 * forwarded — for a rate/offer on the table). scope=recipient makes a non-transferable, revocable
 * link; a recipient_token makes a per-recipient TRACKED link (identity without an email wall).
 * Every open is logged (card_share_views) → opens · dwell · forwards analytics.
 */
import { randomBytes } from "crypto";
import { db } from "../db";
import { cardShares, cardShareViews } from "../../shared/schema";
import { and, eq, sql, desc } from "drizzle-orm";
import { getOrBuildKit, getCachedKit, withoutRetiredCards } from "./kitCache";
import type { MediaKitData } from "./mediaKitService";
import { createLogger } from "../logger";

const logger = createLogger("kit-share");
const APP_BASE = process.env.PUBLIC_CARD_BASE_URL ?? "https://nomila.co";

export interface CreateShareOpts {
  mode?: "live" | "snapshot";
  tailoring?: "generic" | "brand";
  brandId?: string | number; dealId?: string;
  scope?: "public" | "recipient";
  gate?: "none" | "email";
  recipientName?: string; recipientEmail?: string;
  label?: string; expiresAt?: Date | string;
}

/** Mint a share. Snapshot mode freezes the current (path-form) kit; recipient/email gets a token. */
export async function createShare(athleteId: string, opts: CreateShareOpts = {}) {
  const id = randomBytes(9).toString("base64url");
  const mode = opts.mode === "snapshot" ? "snapshot" : "live";
  const scope = opts.scope === "recipient" ? "recipient" : "public";
  const recipientToken = scope === "recipient" || opts.recipientEmail || opts.recipientName ? randomBytes(12).toString("base64url") : null;
  const snapshot_data = mode === "snapshot" ? await getOrBuildKit(athleteId, {}) : null;
  // A live share renders from the cache only (resolveShare never builds), so warm the deck it
  // points at now — on the athlete's authenticated call — rather than on a brand's first open.
  if (mode === "live") {
    const brandId = opts.brandId != null ? Number(opts.brandId) || undefined : undefined;
    await getOrBuildKit(athleteId, { brandId }).catch((err: any) =>
      logger.warn({ athleteId, brandId, error: String(err?.message ?? err).slice(0, 120) }, "share create: kit warm failed"));
  }

  await db.insert(cardShares).values({
    id, athlete_id: athleteId, mode, snapshot_data: snapshot_data as any,
    tailoring: opts.tailoring === "brand" ? "brand" : "generic", brand_id: opts.brandId != null ? String(opts.brandId) : undefined, deal_id: opts.dealId,
    scope, gate: opts.gate === "email" ? "email" : "none",
    recipient_name: opts.recipientName, recipient_email: opts.recipientEmail, recipient_token: recipientToken,
    label: opts.label, expires_at: opts.expiresAt ? new Date(opts.expiresAt) : null,
  });
  const url = `${APP_BASE}/c/${id}${recipientToken ? `?t=${recipientToken}` : ""}`;
  logger.info({ athleteId, shareId: id, mode, scope, tailoring: opts.tailoring ?? "generic" }, "share created");
  return { shareId: id, url, recipientToken };
}

export interface ResolvedShare { kit: MediaKitData | null; mode: string; gated: boolean; reason?: "revoked" | "expired" | "recipient-only" | "unavailable"; athleteId?: string; brandId?: number; customHtml?: string | null }

/** Resolve a share to the kit to render (live → current canonical; snapshot → frozen), enforcing
 *  revoke / expiry / recipient scope. Returns gated=true (with a reason) when it must not render. */
export async function resolveShare(shareId: string, token?: string): Promise<ResolvedShare | null> {
  const [s] = await db.select().from(cardShares).where(eq(cardShares.id, shareId)).limit(1);
  if (!s) return null;
  if (s.revoked) return { kit: null, mode: s.mode, gated: true, reason: "revoked" };
  if (s.expires_at && new Date(s.expires_at) < new Date()) return { kit: null, mode: s.mode, gated: true, reason: "expired" };
  if (s.scope === "recipient" && (!token || token !== s.recipient_token)) return { kit: null, mode: s.mode, gated: true, reason: "recipient-only" };
  const brandId = s.brand_id ? Number(s.brand_id) || undefined : undefined;
  // An external/hand-built deck is served verbatim — no kit assembly, but the same tracking.
  if (s.custom_html) return { kit: null, customHtml: s.custom_html, mode: s.mode, gated: false, athleteId: s.athlete_id, brandId };
  // A share link is public: it serves the frozen snapshot or the CACHED kit and never builds one
  // (a build is the paid agent DAG — only the athlete's own authenticated calls may start it).
  // A live share whose cache was invalidated reads "unavailable" until her app rebuilds it.
  // A frozen snapshot still loses the retired rate cards (legacy retirement, phase 1) — see withoutRetiredCards.
  const kit = s.mode === "snapshot" ? (s.snapshot_data ? withoutRetiredCards(s.snapshot_data as MediaKitData) : null) : await getCachedKit(s.athlete_id, { brandId });
  if (!kit) return { kit: null, mode: s.mode, gated: true, reason: "unavailable", athleteId: s.athlete_id, brandId };
  return { kit, mode: s.mode, gated: false, athleteId: s.athlete_id, brandId };
}

/** Log an open. is_forward = opened without the recipient token on a per-recipient link. */
export async function logShareView(shareId: string, opts: { token?: string; email?: string } = {}): Promise<string | null> {
  const [s] = await db.select({ recipient_token: cardShares.recipient_token }).from(cardShares).where(eq(cardShares.id, shareId)).limit(1);
  if (!s) return null;
  const isForward = !!s.recipient_token && opts.token !== s.recipient_token;
  const [row] = await db.insert(cardShareViews)
    .values({ share_id: shareId, viewer_token: opts.token, viewer_email: opts.email, is_forward: isForward })
    .returning({ id: cardShareViews.id });
  return row.id;
}

export async function updateDwell(viewId: string, dwellMs: number): Promise<void> {
  if (!Number.isFinite(dwellMs)) return;
  await db.update(cardShareViews).set({ dwell_ms: Math.min(3_600_000, Math.max(0, Math.round(dwellMs))) }).where(eq(cardShareViews.id, viewId));
}

/** Per-share analytics summary + a per-open timeline (one entry per open → exact dot strips). */
export async function shareAnalytics(shareId: string) {
  const [agg] = await db.select({
    opens:      sql<number>`count(*)::int`,
    viewers:    sql<number>`count(distinct coalesce(${cardShareViews.viewer_token}, ${cardShareViews.viewer_email}, ${cardShareViews.id}::text))::int`,
    forwards:   sql<number>`count(*) filter (where ${cardShareViews.is_forward})::int`,
    lastOpened: sql<string | null>`max(${cardShareViews.opened_at})`,
    avgDwellMs: sql<number>`coalesce(round(avg(${cardShareViews.dwell_ms})), 0)::int`,
  }).from(cardShareViews).where(eq(cardShareViews.share_id, shareId));
  const views = await db.select({ at: cardShareViews.opened_at, isForward: cardShareViews.is_forward, dwellMs: cardShareViews.dwell_ms })
    .from(cardShareViews).where(eq(cardShareViews.share_id, shareId)).orderBy(cardShareViews.opened_at);
  return { ...agg, timeline: views.map((v) => ({ at: v.at, isForward: v.isForward, dwellMs: v.dwellMs })) };
}

/** The athlete's shares, each with its open count (for the "Track opens" list). */
export async function listAthleteShares(athleteId: string) {
  return db.select({
    id: cardShares.id, mode: cardShares.mode, tailoring: cardShares.tailoring, scope: cardShares.scope,
    label: cardShares.label, recipient: cardShares.recipient_name, revoked: cardShares.revoked,
    createdAt: cardShares.created_at,
    // Qualify the outer id explicitly: an unqualified ${cardShares.id} renders as "id", which the
    // subquery binds to card_share_views' OWN id (uuid) → "text = uuid". "card_shares"."id" is unambiguous.
    opens: sql<number>`(select count(*) from card_share_views v where v.share_id = "card_shares"."id")::int`,
    lastOpened: sql<string | null>`(select max(v.opened_at) from card_share_views v where v.share_id = "card_shares"."id")`,
  }).from(cardShares).where(eq(cardShares.athlete_id, athleteId)).orderBy(desc(cardShares.created_at));
}

/** Exact per-day open counts across ALL the athlete's shares for the last `days` days.
 *  Powers the 14-day overview strip precisely (vs. lumping opens on each share's last-open day). */
export async function athleteOpensByDay(athleteId: string, days = 14): Promise<{ day: string; opens: number }[]> {
  return db.select({
    day:   sql<string>`to_char(date_trunc('day', ${cardShareViews.opened_at}), 'YYYY-MM-DD')`,
    opens: sql<number>`count(*)::int`,
  })
    .from(cardShareViews)
    .innerJoin(cardShares, eq(cardShareViews.share_id, cardShares.id))
    .where(and(
      eq(cardShares.athlete_id, athleteId),
      sql`${cardShareViews.opened_at} >= now() - (${days}::text || ' days')::interval`,
    ))
    .groupBy(sql`1`);
}

/** Who owns a share (for authz on analytics/revoke). */
export async function shareOwner(shareId: string): Promise<string | null> {
  const [s] = await db.select({ athlete_id: cardShares.athlete_id }).from(cardShares).where(eq(cardShares.id, shareId)).limit(1);
  return s?.athlete_id ?? null;
}

export async function revokeShare(shareId: string, athleteId: string): Promise<boolean> {
  await db.update(cardShares).set({ revoked: true }).where(and(eq(cardShares.id, shareId), eq(cardShares.athlete_id, athleteId)));
  return true;
}
