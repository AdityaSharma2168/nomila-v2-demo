/**
 * getFirstLook.ts — Mila tool: what the athlete's own posts say about them.
 *
 * Reads the latest first look per connected platform (athlete_snapshots.first_look, written by
 * the first_look workflow at connect time): what they post about, the tone, cadence, format mix,
 * who they tag. Offered only in an onboarding conversation for now (registry.ts onboardingTools);
 * the ONBOARDING_CONTEXT block already carries the headline, this is the detail when the athlete
 * asks "what did you see in my posts?".
 *
 * TENANCY: athleteId is injected by the loop; the query filters on it. No post text crosses —
 * themes and tone are short labels Mila herself derived, tagged handles are handles.
 */

import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { athleteSnapshots } from "../../../shared/schema";
import type { MilaTool } from "../types";
import type { FirstLook } from "../../skills/firstLook";

export const getFirstLookTool: MilaTool<z.ZodObject<Record<string, never>>> = {
  name: "get_first_look",
  description:
    "What the athlete's own recent posts say about them, per connected platform: themes, tone, " +
    "how often they post, format mix (video / carousel / image), and who they tag most. Call it " +
    "when they ask what you saw in their posts or want more than the headline. Returns an empty " +
    "list when no social account is connected yet.",
  argsSchema: z.object({}),
  async execute(athleteId, _args) {
    const rows = await db.select({ first_look: athleteSnapshots.first_look, created_at: athleteSnapshots.created_at })
      .from(athleteSnapshots)
      // A look lives on the connect-time snapshot (trigger "social_connect") or, once refreshed, on
      // its own row (trigger "first_look"). Filter on the column that holds the result (see mila/onboarding.ts).
      .where(and(eq(athleteSnapshots.athlete_id, athleteId), sql`${athleteSnapshots.first_look} IS NOT NULL`))
      .orderBy(desc(athleteSnapshots.created_at)).limit(9);
    const seen = new Set<string>();
    const looks = [];
    for (const r of rows) {
      const fl = r.first_look as FirstLook | null;
      if (!fl?.platform || seen.has(fl.platform)) continue;
      seen.add(fl.platform);
      looks.push({
        platform: fl.platform,
        computed_at: fl.computed_at ?? (r.created_at ? new Date(r.created_at).toISOString() : null),
        posts_read: fl.posts_read ?? 0,
        posts_per_week: fl.cadence?.posts_per_week ?? null,
        last_post_at: fl.cadence?.last_post_at ?? null,
        format_mix: fl.format_mix ?? null,
        caption_style: fl.caption_style
          ? { avg_length: fl.caption_style.avg_length, emoji_per_post: fl.caption_style.emoji_per_post, hashtags_per_post: fl.caption_style.hashtags_per_post }
          : null,
        themes: (fl.themes ?? []).slice(0, 6),
        tone: (fl.tone ?? []).slice(0, 4),
        often_tags: (fl.tagged ?? []).slice(0, 5).map((t) => ({ handle: t.handle, count: t.count })),
        // Prompt v2 fields; absent on older looks.
        interests: (fl.interests ?? []).slice(0, 6),
        recurring_phrases: (fl.recurring_phrases ?? []).slice(0, 5),
        causes_mentioned: (fl.causes_mentioned ?? []).slice(0, 5),
      });
    }
    return { looks };
  },
};
