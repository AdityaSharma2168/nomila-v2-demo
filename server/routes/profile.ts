/**
 * profile.ts — durable athlete-profile writes (Phase-3 memory, persist side).
 *
 * Three athlete-scoped PATCH routes, one per writable profile field. Same house
 * pattern as PATCH /me/preferences (deals.ts): requireAuth → read req.athleteId! →
 * per-field validate with an early 400 → db.update(athletes)…where(id = athleteId)
 * → { ok: true, <field> }. Every write is scoped by the authenticated athlete id;
 * a client-supplied id is never trusted.
 *
 * These are the ONLY writers of goal_archetype / secondary_goals / brand_voice from
 * the app, and the ONLY way a durable profile write happens — reached exclusively by
 * an explicit on-screen confirm tap (the Mila extraction pass proposes but never
 * writes). The columns already exist; this adds no schema.
 *
 * Endpoints (mounted at /api/v1/me):
 *   PATCH /profile/goal            — goal_archetype (text; "" clears)
 *   PATCH /profile/secondary-goals — secondary_goals (jsonb string[]; whole-array replace)
 *   PATCH /profile/brand-voice     — brand_voice (jsonb { tone?, phrases?, avoid? })
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import {
  sanitizeBrandVoice,
  sanitizeGoal,
  sanitizeSecondaryGoals,
} from "../mila/profileFields";
import { clearAssertion, recordAssertions, type AssertedField, type AssertedValue } from "../mila/onboarding";

// PR A (The Athlete Record): these three routes are now DOORS into the one ledger rather than
// writers of their own. A confirmed value becomes an athlete_asserted row with a reversible
// profile_write receipt, and the athletes column is kept in step as a projection by the writer.
// The response shapes are unchanged, so the confirm cards need no edit.
import type { BrandVoice } from "../mila/profileFields";

const SETTINGS = { mode: "form" as const, source: "settings" as const };

async function writeOrClear(athleteId: string, field: AssertedField, value: AssertedValue | null): Promise<void> {
  const empty = value === null || value === "" || (Array.isArray(value) && value.length === 0)
    || (typeof value === "object" && !Array.isArray(value) && !("status" in value) && !(value as BrandVoice).tone && !(value as BrandVoice).phrases?.length && !(value as BrandVoice).avoid?.length);
  if (empty) { await clearAssertion({ athleteId, field, ...SETTINGS }); return; }
  await recordAssertions({ athleteId, runId: null, ...SETTINGS, corrections: [{ field, value: value as AssertedValue }] });
}

const logger = createLogger("routes/profile");
const router = Router();

// ─── PATCH /api/v1/me/profile/goal ────────────────────────────────────────────
// Body: { goal_archetype: string } — "" clears the goal.

router.patch(
  "/profile/goal",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const { goal_archetype } = req.body as { goal_archetype?: unknown };
    if (goal_archetype === undefined) {
      res.status(400).json({ error: "goal_archetype is required" });
      return;
    }
    const r = sanitizeGoal(goal_archetype);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    await writeOrClear(athleteId, "goal", r.value);
    logger.info({ athleteId }, "Athlete goal_archetype updated");
    res.json({ ok: true, goal_archetype: r.value });
  },
);

// ─── PATCH /api/v1/me/profile/secondary-goals ─────────────────────────────────
// Body: { secondary_goals: string[] } — WHOLE-ARRAY replace (the confirmed set).

router.patch(
  "/profile/secondary-goals",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const { secondary_goals } = req.body as { secondary_goals?: unknown };
    if (secondary_goals === undefined) {
      res.status(400).json({ error: "secondary_goals is required" });
      return;
    }
    const r = sanitizeSecondaryGoals(secondary_goals);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    await writeOrClear(athleteId, "secondary_goals", r.value);
    logger.info(
      { athleteId, count: r.value.length },
      "Athlete secondary_goals updated",
    );
    res.json({ ok: true, secondary_goals: r.value });
  },
);

// ─── PATCH /api/v1/me/profile/brand-voice ─────────────────────────────────────
// Body: { brand_voice: { tone?, phrases?, avoid? } } — PROVISIONAL shape (net-new
// column, no prior reader/writer). WHOLE-OBJECT replace; {} clears.

router.patch(
  "/profile/brand-voice",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId!;
    const { brand_voice } = req.body as { brand_voice?: unknown };
    if (brand_voice === undefined) {
      res.status(400).json({ error: "brand_voice is required" });
      return;
    }
    const r = sanitizeBrandVoice(brand_voice);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    await writeOrClear(athleteId, "brand_voice", r.value);
    logger.info({ athleteId }, "Athlete brand_voice updated");
    res.json({ ok: true, brand_voice: r.value });
  },
);

export default router;
