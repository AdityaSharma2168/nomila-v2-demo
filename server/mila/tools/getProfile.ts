/**
 * getProfile.ts — Mila read tool: the athlete's own profile.
 *
 * Reads `athletes` filtered by id, plus a count of active connected platforms.
 * Selects scalar, non-sensitive columns only — never email, auth_id,
 * auth_provider, tokens, stripe ids, or social handles.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes, connectedAccounts } from "../../../shared/schema";
import type { MilaTool } from "../types";
import { listAffiliations } from "../../services/affiliations";

export const getProfileTool: MilaTool<z.ZodObject<Record<string, never>>> = {
  name: "get_profile",
  description:
    "Get the athlete's profile: name, sport, school, division, conference, " +
    "segment (college / high_school / pro / ...), career_status (active / between_teams / " +
    "out_this_season / retired), teams (every team with kind, level, role, dates, current, primary), " +
    "account status, plan, goal archetype, secondary goals, brand voice, and which platforms they " +
    "have connected. Returns null if the profile doesn't exist.",
  argsSchema: z.object({}),
  async execute(athleteId, _args) {
    const [row] = await db
      .select({
        full_name: athletes.full_name,
        sport: athletes.sport,
        school: athletes.school,
        division: athletes.division,
        conference: athletes.conference,
        segment: athletes.segment,
        career_status: athletes.career_status,
        status: athletes.status,
        plan: athletes.plan,
        goal_archetype: athletes.goal_archetype,
        // Folded in so Mila can see the current durable values it may propose an
        // update against (Phase-3 memory). Both are athlete-set, non-sensitive.
        secondary_goals: athletes.secondary_goals,
        brand_voice: athletes.brand_voice,
      })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1);

    if (!row) return null;
    // Sport / school / level are the projection columns; teams are the ledger.
    const identity = { sport: row.sport, school: row.school, division: row.division, conference: row.conference, segment: row.segment };
    const teams = (await listAffiliations(athleteId)).map((t) => ({
      org: t.org, kind: t.kind, level: t.level, conference: t.conference, role: t.role, position: t.position,
      from: t.from, to: t.to, current: t.current, primary: t.primary, fact: t.kindOfFact,
    }));

    const accountRows = await db
      .select({ platform: connectedAccounts.platform })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.athlete_id, athleteId),
          eq(connectedAccounts.status, "active"),
        ),
      );
    const platforms = [...new Set(accountRows.map((r) => r.platform))];

    return {
      ...row,
      ...identity,
      teams,
      connected_platform_count: platforms.length,
      connected_platforms: platforms,
    };
  },
};
