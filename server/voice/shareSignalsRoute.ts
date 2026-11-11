/**
 * shareSignalsRoute.ts — who has actually opened the athlete's Nomi Card.
 *
 * GET /athletes/:id/share-signals, mounted at /api/internal/voice
 * (server/index.ts).
 *
 * The caller is TRUSTED INFRASTRUCTURE, not a user: there is no session and no
 * `req.athleteId`, so the athlete id comes from the path and the shared secret is
 * the entire authorization boundary. See ./auth for the guard.
 *
 * Answers "has anyone opened my media kit?" — a question the athlete asks a lot
 * after sending one, and which nothing else on the voice surface can answer.
 *
 * ── TENANCY: card_share_views has NO athlete_id ──────────────────────────────
 * This is the one thing to get right here. `card_shares` is athlete-scoped;
 * `card_share_views` is keyed only by `share_id`, so a view row carries no
 * ownership of its own. Scoping the views therefore CANNOT be done on the views
 * table — it has to come from the shares.
 *
 * BE PRECISE ABOUT WHICH LINE IS LOAD-BEARING, because there are two and they do
 * different jobs. Verified by mutation, not by reading:
 *
 *   `eq(cardShares.athlete_id, …)` on the SHARES query — THE BOUNDARY. Remove it
 *      and another athlete's shares and view counts appear in the answer;
 *      shareSignalsRoute.test.ts fails 4 tests. It is load-bearing twice over,
 *      because the aggregate below only ever looks up keys taken from this list,
 *      so a view whose share is not here can never be counted.
 *
 *   `inArray(cardShareViews.share_id, shareIds)` on the VIEWS query — NOT the
 *      boundary, and do not read it as one. Removing it changes no answer (the
 *      test suite stays green, which is how this was checked); what it costs is
 *      the whole card_share_views table being pulled into memory to build a map
 *      that then ignores most of it. It stays because an unbounded read on a
 *      growing analytics table is its own kind of outage.
 *
 * The model supplies no id at all on this route, and an empty share set
 * short-circuits before the view query runs.
 *
 * ── Trusted data, with one deliberate omission ───────────────────────────────
 * Almost everything here is ours (counts, timestamps, booleans) or the athlete's
 * own (`label`, `recipient_name` — they typed those when they made the share).
 * No wrapper is needed for any of it.
 *
 * `viewer_email` IS NOT RETURNED, and that is the reason the sentence above is
 * true rather than merely assumed. When a share has `gate: 'email'`, whoever
 * opens the link types that address themselves — it is outside text from an
 * unauthenticated party, exactly the class ./threadRoutes has to delimit. Rather
 * than carry it and wrap it, this route answers the question without it: "three
 * opens, one of them a forward, most recent Tuesday" is what the athlete wants,
 * and it needs no attacker-controlled string. `viewer_token` is out for the same
 * reason plus being useless aloud.
 *
 * If a future version needs to say WHO opened it, that field has to cross with
 * the <external_content> treatment and this header stops being true — do not add
 * it to the select without doing that.
 */

import { Router, type Request, type Response } from "express";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { cardShares, cardShareViews } from "../../shared/schema";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";

const logger = createLogger("voice/shareSignals");

const router = Router();

/** Two indexed reads (idx_card_shares_athlete, idx_card_share_views_share). */
const READ_TIMEOUT_MS = 2_000;

/**
 * How many shares come back, newest-first. Capped for the same context-cost
 * reason as the other read tools; an athlete with dozens of shares gets the
 * recent ones, and `totalShares` still reports the true count.
 */
const MAX_SHARES = 10;

/** One share and its signal. Ours or the athlete's own — nothing external. */
interface VoiceShareSignal {
  /** The athlete's own label for the share, or null. */
  label: string | null;
  /** Who they said they sent it to, as THEY typed it. Null on a public link. */
  recipientName: string | null;
  /** 'generic' | 'brand' — our enum. */
  tailoring: string | null;
  /** ISO. */
  createdAt: string | null;
  revoked: boolean;
  /** Total opens. 0 means sent-but-never-opened, which is itself the answer. */
  opens: number;
  /** Opens without the recipient token — i.e. it got forwarded on. */
  forwards: number;
  /** ISO of the most recent open, or null if never opened. */
  lastOpenedAt: string | null;
  /** Longest single dwell in ms — "they actually read it" vs "they glanced". */
  longestDwellMs: number | null;
}

interface VoiceShareSignals {
  /** Across the returned shares. */
  totalOpens: number;
  totalForwards: number;
  /** How many shares exist in total, so a capped answer can be honest. */
  totalShares: number;
  /** Shares that have never been opened — the "nobody's looked yet" answer. */
  unopenedShares: number;
  /** Newest-first: the athlete asks about what they just sent. */
  shares: VoiceShareSignal[];
}

const isoOf = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : null;

// GET /athletes/:id/share-signals — open/view signal on the athlete's cards.
// 404 when they have never shared one, which is distinct from "shared and nobody
// opened it" (that returns 200 with opens: 0 — a real and useful answer).
router.get(
  "/athletes/:id/share-signals",
  async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const voiceAuth = await voiceAuthorized(req, req.params.id);
    if (!voiceAuth.ok) {
      sendVoiceRefusal(res, voiceAuth);
      return;
    }

    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid athlete id" });
      return;
    }

    try {
      const signals = await withTimeout(
        readSignals(id),
        READ_TIMEOUT_MS,
        "voice get_share_signals",
      );

      if (!signals) {
        logger.info(
          { athleteId: id, tool: "get_share_signals", outcome: "miss" },
          "Voice tool — get_share_signals",
        );
        res.status(404).json({ error: "No shares" });
        return;
      }

      logger.info(
        {
          athleteId: id,
          tool: "get_share_signals",
          outcome: "hit",
          shares: signals.shares.length,
          totalOpens: signals.totalOpens,
        },
        "Voice tool — get_share_signals",
      );
      res.json(signals);
    } catch (err: any) {
      logger.error(
        { athleteId: id, error: err.message },
        "Voice share signals failed",
      );
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

async function readSignals(athleteId: string): Promise<VoiceShareSignals | null> {
  // 1. The shares — THIS is where the tenancy boundary is enforced, because the
  //    views table has no athlete_id of its own.
  const shares = await db
    .select({
      id: cardShares.id,
      label: cardShares.label,
      recipientName: cardShares.recipient_name,
      tailoring: cardShares.tailoring,
      createdAt: cardShares.created_at,
      revoked: cardShares.revoked,
    })
    .from(cardShares)
    .where(eq(cardShares.athlete_id, athleteId))
    .orderBy(desc(cardShares.created_at))
    .limit(MAX_SHARES);

  if (shares.length === 0) return null;

  // The true total, so a capped answer does not under-report.
  const all = await db
    .select({ id: cardShares.id })
    .from(cardShares)
    .where(eq(cardShares.athlete_id, athleteId));

  // 2. The views, restricted to exactly the share ids read above. Never a
  //    share id from anywhere else. `viewer_email` / `viewer_token` are NOT
  //    selected — see the header.
  const shareIds = shares.map((s) => s.id);
  const views = await db
    .select({
      shareId: cardShareViews.share_id,
      isForward: cardShareViews.is_forward,
      dwellMs: cardShareViews.dwell_ms,
      openedAt: cardShareViews.opened_at,
    })
    .from(cardShareViews)
    .where(inArray(cardShareViews.share_id, shareIds));

  const byShare = new Map<string, typeof views>();
  for (const v of views) {
    const list = byShare.get(v.shareId) ?? [];
    list.push(v);
    byShare.set(v.shareId, list);
  }

  let totalOpens = 0;
  let totalForwards = 0;
  let unopenedShares = 0;

  const mapped: VoiceShareSignal[] = shares.map((s) => {
    const mine = byShare.get(s.id) ?? [];
    const forwards = mine.filter((v) => v.isForward).length;
    const dwells = mine
      .map((v) => v.dwellMs)
      .filter((d): d is number => typeof d === "number" && Number.isFinite(d));
    const opens = mine.length;

    totalOpens += opens;
    totalForwards += forwards;
    if (opens === 0) unopenedShares += 1;

    const lastOpenedAt = mine.reduce<Date | null>((latest, v) => {
      if (!(v.openedAt instanceof Date)) return latest;
      return latest === null || v.openedAt > latest ? v.openedAt : latest;
    }, null);

    return {
      label: s.label,
      recipientName: s.recipientName,
      tailoring: s.tailoring,
      createdAt: isoOf(s.createdAt),
      revoked: s.revoked,
      opens,
      forwards,
      lastOpenedAt: isoOf(lastOpenedAt),
      longestDwellMs: dwells.length > 0 ? Math.max(...dwells) : null,
    };
  });

  return {
    totalOpens,
    totalForwards,
    totalShares: all.length,
    unopenedShares,
    shares: mapped,
  };
}

export default router;
export { MAX_SHARES };
