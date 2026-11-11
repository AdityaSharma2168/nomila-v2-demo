/**
 * onboarding — one run per athlete, started at signup (landing page or app).
 *
 * v1 is the automated half: research the web the moment we know a name and a sport, then
 * mark the outside view ready. A run started on v1 finishes on v1.
 *
 * v2 (PR 3, the first entry) adds the conversation: after research, the run PARKS on `greet`
 * until the athlete has reacted to what Mila found (corrections written through
 * server/mila/onboarding.ts), then on `doors` until they have chosen where to start, then
 * `wrap` closes it. Research is skipped when a snapshot is fresh, so an athlete who already has
 * one (Mia) goes straight to the greeting. New runs start on v2; the client gates the app on an
 * active onboarding run with a waiting step.
 *
 * Research is scoped to the handles the athlete typed or connected, so platform discovery
 * never runs against a handle the model guessed when a real one exists.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes, athleteSnapshots, connectedAccounts, mediaKits } from "../../../shared/schema";
import { buildSearchName, researchAthlete, type KnownHandles } from "../../skills/researchAthlete";
import { DOORS, parseDoorsFields, parseGreetFields, recordAssertions, type SavedFact } from "../../mila/onboarding";
import { createLogger } from "../../logger";
import { searchInputsFor } from "../../services/intelligence/context/searchInputs";
import { defineWorkflow } from "../registry";
import type { StepCtx } from "../types";

const logger = createLogger("workflow/onboarding");

const HANDLE_PLATFORMS = ["instagram", "tiktok", "youtube", "x"] as const;

/** Handles we actually know: typed at signup (athletes.socials) or proven by a connection. */
export async function collectKnownHandles(athleteId: string): Promise<KnownHandles> {
  const [row] = await db.select({ socials: athletes.socials }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const typed = ((row?.socials ?? {}) as Record<string, unknown>);
  const out: KnownHandles = {};
  for (const p of HANDLE_PLATFORMS) {
    const key = p === "x" ? "twitter" : p; // the landing page stores X under 'twitter'
    const v = typed[key] ?? typed[p];
    if (typeof v === "string" && v.trim()) out[p] = v.trim().replace(/^@/, "");
  }
  const connected = await db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active"), inArray(connectedAccounts.platform, [...HANDLE_PLATFORMS])));
  for (const c of connected) {
    if (c.username && (HANDLE_PLATFORMS as readonly string[]).includes(c.platform)) out[c.platform as keyof KnownHandles] = c.username.replace(/^@/, "");
  }
  return out;
}

export const ONBOARDING = defineWorkflow({
  process: "onboarding",
  version: 1,
  steps: [
    {
      name: "research",
      kind: "model",
      leaseMs: 3 * 60_000,
      retry: { maxAttempts: 3 },
      run: async (ctx) => {
        const athleteId = ctx.athleteId!;
        const [a] = await db.select({ full_name: athletes.full_name, school: athletes.school, sport: athletes.sport })
          .from(athletes).where(eq(athletes.id, athleteId)).limit(1);
        if (!a) throw new Error(`Athlete ${athleteId} not found`);
        if (!a.sport) throw new Error("Research needs a sport; the landing page asks for it at step 3");
        // The projection anchor + collectKnownHandles.
        const inputs = await searchInputsFor(athleteId, { anchor: buildSearchName(a), handles: await collectKnownHandles(athleteId) });
        const result = await researchAthlete(athleteId, inputs.anchor, "signup", { handles: inputs.handles });
        return { snapshot_id: result.snapshotId };
      },
    },
    {
      name: "context_ready",
      kind: "code",
      run: async (ctx) => {
        const athleteId = ctx.athleteId!;
        // The generic public card is rebuilt in the background; brand decks keep their own cache.
        const kits = await invalidateGenericKit(athleteId);
        logger.info({ athleteId, kitsInvalidated: kits }, "onboarding: outside view ready");
        return { ready_at: new Date().toISOString(), kits_invalidated: kits };
      },
    },
  ],
});

// ─── v2: research (skip if fresh) → context_ready → greet → doors → wrap ─────

/** A research snapshot younger than this is reused; older (or none) → research runs. */
export const RESEARCH_FRESH_DAYS = 7;

/**
 * The version a new onboarding run starts on: v2, pinned (never "whatever is newest"). The v3 identity-guard definition
 * behind ONBOARDING_V3 never ran (no v3 rows on dev, the flag off everywhere) and was deleted 2 Nov 2026, owner decision.
 */
export function onboardingStartVersion(): number { return 2; }

async function latestResearch(athleteId: string): Promise<{ id: string; created_at: Date | null; as_of: Date | null } | null> {
  const [snap] = await db.select({ id: athleteSnapshots.id, created_at: athleteSnapshots.created_at, as_of: athleteSnapshots.as_of })
    .from(athleteSnapshots)
    .where(and(eq(athleteSnapshots.athlete_id, athleteId), sql`${athleteSnapshots.research} IS NOT NULL`))
    .orderBy(desc(athleteSnapshots.created_at)).limit(1);
  return snap ?? null;
}

/** Drop the cached generic card (it was built from what we knew before) and rebuild it in the
 *  background, server-side. Public share links (/c/:shareId) only ever read the cache (they never
 *  build), so without the rebuild a live generic share would read "being refreshed" until the
 *  athlete next opened her app. Fire-and-forget: the step never waits on, or fails with, the build. */
async function invalidateGenericKit(athleteId: string): Promise<number> {
  const gone = await db.delete(mediaKits)
    .where(and(eq(mediaKits.athlete_id, athleteId), eq(mediaKits.brand_id, 0)))
    .returning({ id: mediaKits.id });
  if (gone.length) {
    void import("../../services/kitCache.js")
      .then(({ rebuildKitInBackground }) => rebuildKitInBackground(athleteId, 0))
      .catch((err: any) => logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 160) }, "onboarding: generic kit rebuild not scheduled"));
  }
  return gone.length;
}

const modeOf = (ctx: StepCtx): "chat" | "voice" | "form" => {
  // The runner stamps the mode on the step row at completion; complete() runs just before that,
  // so the answering channel travels in the fields for the writer to attribute.
  const m = (ctx.input as { mode?: unknown } | null)?.mode;
  return m === "voice" || m === "form" ? m : "chat";
};

export const ONBOARDING_V2 = defineWorkflow({
  process: "onboarding",
  version: 2,
  steps: [
    {
      name: "research",
      kind: "model",
      leaseMs: 3 * 60_000,
      retry: { maxAttempts: 3 },
      run: async (ctx) => {
        const athleteId = ctx.athleteId!;
        const fresh = await latestResearch(athleteId);
        const datedBy = fresh?.created_at;
        const ageMs = datedBy ? Date.now() - new Date(datedBy).getTime() : Infinity;
        if (fresh && ageMs < RESEARCH_FRESH_DAYS * 86_400_000) {
          logger.info({ athleteId, snapshotId: fresh.id, ageDays: Math.round(ageMs / 86_400_000) }, "onboarding v2: research is fresh, skipping");
          return { skipped: true, snapshot_id: fresh.id };
        }
        const [a] = await db.select({ full_name: athletes.full_name, school: athletes.school, sport: athletes.sport })
          .from(athletes).where(eq(athletes.id, athleteId)).limit(1);
        if (!a) throw new Error(`Athlete ${athleteId} not found`);
        if (!a.sport) throw new Error("Research needs a sport; the landing page asks for it at step 3");
        const inputs = await searchInputsFor(athleteId, { anchor: buildSearchName(a), handles: await collectKnownHandles(athleteId) });   // 2d-5 (#15/#16), as v1
        const result = await researchAthlete(athleteId, inputs.anchor, "signup", { handles: inputs.handles });
        return { skipped: false, snapshot_id: result.snapshotId };
      },
    },
    {
      name: "context_ready",
      kind: "code",
      run: async (ctx) => {
        const athleteId = ctx.athleteId!;
        const research = ctx.outputs.research as { skipped?: boolean } | undefined;
        // Fresh research → the card built from it is still right; only a new snapshot invalidates.
        const kits = research?.skipped ? 0 : await invalidateGenericKit(athleteId);
        logger.info({ athleteId, kitsInvalidated: kits }, "onboarding v2: outside view ready");
        return { ready_at: new Date().toISOString(), kits_invalidated: kits };
      },
    },
    {
      // Parks until the athlete has heard what Mila found and reacted. Answered through the
      // complete_onboarding_step tool (chat), the voice route (voice), or the athlete API (form).
      name: "greet",
      kind: "await_human",
      payload: async () => ({ asks: "reaction", fields: ["confirmed", "corrections"] }),
      complete: async (ctx, fields) => {
        const parsed = parseGreetFields(fields);
        const saved: SavedFact[] = await recordAssertions({
          athleteId: ctx.athleteId!, runId: ctx.runId, mode: modeOf({ ...ctx, input: fields }), corrections: parsed.corrections,
        });
        return { confirmed: parsed.confirmed, saved };
      },
    },
    {
      name: "doors",
      kind: "await_human",
      payload: async () => ({ asks: "door", doors: [...DOORS] }),
      complete: async (_ctx, fields) => parseDoorsFields(fields),
    },
    {
      name: "wrap",
      kind: "code",
      run: async (ctx) => {
        const athleteId = ctx.athleteId!;
        const greet = ctx.outputs.greet as { saved?: SavedFact[] } | undefined;
        const doors = ctx.outputs.doors as { door?: string } | undefined;
        // Facts changed → the generic card rebuilds on next open with what the athlete said.
        const kits = greet?.saved?.length ? await invalidateGenericKit(athleteId) : 0;
        logger.info({ athleteId, door: doors?.door, saved: greet?.saved?.length ?? 0, kitsInvalidated: kits }, "onboarding v2: first entry complete");
        return { finished_at: new Date().toISOString(), door: doors?.door ?? null, saved: greet?.saved?.length ?? 0, kits_invalidated: kits };
      },
    },
  ],
});
