/**
 * profileRoute.ts — the athlete's own profile, for the voice worker (internal).
 *
 * GET /athletes/:id/profile, mounted at /api/internal/voice (server/index.ts).
 *
 * The caller is TRUSTED INFRASTRUCTURE, not a user: there is no session and no
 * `req.athleteId`, so the athlete id comes from the path and the shared secret is
 * the entire authorization boundary. See ./auth for the guard and why the secret
 * is its own rather than shared with CRON_SECRET.
 *
 * ── TENANCY ───────────────────────────────────────────────────────────────────
 * `:id` is the only athlete this route can ever read. Both queries below filter
 * on it with `eq` on a primary/foreign key — there is no join, no OR, and no
 * caller-supplied predicate, so the result set is one athlete's row or nothing.
 * The id is uuid-shape-validated before it reaches the DB, and a well-formed id
 * for a nonexistent athlete answers 404 rather than an empty profile.
 *
 * Unlike ./dealRoutes this does not go through a Mila tool, because `get_profile`
 * returns fields this wire must not carry (see below) and `get_rate_card` returns
 * the raw `{low, mid, high}` bands. Reading the two rows directly and mapping
 * them in ./athleteProfile is less indirection, not more.
 *
 * ── What crosses ──────────────────────────────────────────────────────────────
 * See ./athleteProfile for the provenance argument. In short: `segment` is a
 * generated column, `division` is allow-listed against the schema's own
 * vocabulary, the rate card is numbers, and the remaining fields are the
 * athlete's own words behind a shape gate.
 *
 * Deliberately NOT selected, though `get_profile` returns them: `full_name`
 * (the worker never needs to say it and it is PII on a wire that is logged),
 * `status`, `plan` (billing state — nothing to say and not the athlete's
 * business to hear from an agent), and connected-platform counts. `email`,
 * `auth_id` and every token column are not selected by `get_profile` either.
 */

import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { athletes } from "../../shared/schema";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";
import { readAthleteProfile, type VoiceAthleteProfile } from "./athleteProfile";
import { presentFields } from "./logShape";

const logger = createLogger("voice/profile");

const router = Router();

/** Same stalled-pool backstop as the sibling read routes. */
const READ_TIMEOUT_MS = 2_000;

interface VoiceProfileMiss {
  notFound: true;
}

const MISS: VoiceProfileMiss = { notFound: true };

router.get("/athletes/:id/profile", async (req: Request, res: Response) => {
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
    // TENANCY: `eq(athletes.id, id)` on the primary key. One row or none.
    const profileRead = db
      .select({
        sport: athletes.sport,
        school: athletes.school,
        division: athletes.division,
        conference: athletes.conference,
        segment: athletes.segment,
        goal_archetype: athletes.goal_archetype,
        secondary_goals: athletes.secondary_goals,
        brand_voice: athletes.brand_voice,
      })
      .from(athletes)
      .where(eq(athletes.id, id))
      .limit(1);

    // Legacy retirement, phase 1 (owner decision 8 Oct 2026): the computed rate card is no longer read, so
    // `rates` is always null on this wire. The worker's contract already treats null rates as "we have not worked
    // one out yet — say so, never guess", which is the truth while rates are being rebuilt.
    const [row] = await withTimeout(profileRead, READ_TIMEOUT_MS, "voice profile read");

    // A well-formed id for nobody is a 404, not an empty profile — an empty
    // profile would have Mila narrate the absence of an athlete.
    if (!row) {
      logger.info(
        { athleteId: id, tool: "get_athlete_profile", outcome: "miss" },
        "Voice tool — get_athlete_profile (notFound)",
      );
      res.status(404).json(MISS);
      return;
    }

    // Sport / school / level: the projection columns, through the speakable gate (readAthleteProfile).
    const profile: VoiceAthleteProfile = readAthleteProfile(row);

    logger.info(
      {
        athleteId: id,
        tool: "get_athlete_profile",
        outcome: "hit",
        // Presence only — never the values. These are the athlete's own words
        // and their rate; neither belongs in a log line. See ./logShape.
        fields: presentFields(profile),
        rates: presentFields(profile.rates),
      },
      "Voice tool — get_athlete_profile",
    );
    res.json(profile);
  } catch (err: any) {
    if (typeof err?.message === "string" && err.message.includes("timed out")) {
      logger.info(
        { athleteId: id, outcome: "timeout" },
        "Voice profile timed out",
      );
      // Degrade rather than fail the turn — same stance as the sibling routes.
      res.status(404).json(MISS);
      return;
    }
    logger.error({ athleteId: id, error: err.message }, "Voice profile failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
