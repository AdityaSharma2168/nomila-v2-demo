/**
 * views/identity.ts — the identity view (design §2.3): what /auth/me, get_profile, the voice profile,
 * chat v1, dealDraft, scoreDeal and the admin list need. `currentTeam` is the ledger's primary current
 * row — the ONLY "current team". `legacySchool` is the projection column, exposed for parity while the
 * readers migrate (2d-3) and gone in Step 4. Pure over a BuiltContext.
 */

import { buildCanonicalContext, type BuiltContext } from "../build";
import type { Coverage, SourceMode } from "../contract";
import { CONTEXT_BLOCK_CLOSE, CONTEXT_BLOCK_OPEN } from "./prompt";

export interface IdentityView {
  athleteId: string;
  name: string;
  firstName: string;
  sport: string | null;
  currentTeam: string | null;
  orgKind: string | null;
  level: { division: string | null; conference: string | null; segment: string | null };
  teamsLine: string | null;
  careerStatus: string;
  /** Public handles only (platform → handle), by authority. */
  handles: Record<string, string>;
  connectionStatus: string;
  connectedPlatforms: string[];
  /** The projection column, for parity during migration only. */
  legacySchool: string | null;
  sourceMode: SourceMode;
  coverage: Record<string, Coverage>;
}

/** The identity readers' entry point (2d-3): build the context and project it. Null when the athlete does not exist. */
export async function readIdentityView(athleteId: string): Promise<IdentityView | null> {
  const built = await buildCanonicalContext(athleteId);
  return built ? identityView(built) : null;
}

const clean = (v: unknown, max = 120) => String(v ?? "").replace(/[\r\n<>]+/g, " ").trim().slice(0, max);

/**
 * The fenced identity block for chat v1 (D12): data, not instructions — today's prompt interpolates the school
 * column unfenced into the persona line. Name, sport, the ledger's primary current team, its level, the career state.
 */
export function identityFence(v: IdentityView): string {
  const lines = [
    `name: ${clean(v.name)}`,
    `sport: ${v.sport ? clean(v.sport) : "unknown"}`,
    `team: ${v.currentTeam ? `${clean(v.currentTeam)}${v.orgKind ? ` (${v.orgKind})` : ""}` : "none on record"}`,
    `level: ${[v.level.division, v.level.conference, v.level.segment].filter(Boolean).map((x) => clean(x)).join(" · ") || "unknown"}`,
    `career: ${clean(v.careerStatus)}`,
  ];
  return `${CONTEXT_BLOCK_OPEN("chat")}${v.sourceMode}>>>\n${lines.join("\n")}\n${CONTEXT_BLOCK_CLOSE}`;
}

export function identityView(b: BuiltContext): IdentityView {
  const { ctx } = b;
  const name = ctx.identity.name.value.full;
  return {
    athleteId: ctx.athleteId, name, firstName: ctx.identity.firstName?.trim() || name.split(/\s+/)[0] || name,
    sport: ctx.identity.sport?.value.sport ?? null,
    currentTeam: ctx.affiliations.current?.org ?? null, orgKind: ctx.affiliations.current?.kind ?? null,
    level: { division: ctx.affiliations.level.division, conference: ctx.affiliations.level.conference, segment: ctx.affiliations.level.segment },
    teamsLine: ctx.affiliations.teamsLine, careerStatus: ctx.identity.careerStatus.value.status,
    handles: Object.fromEntries(Object.entries(ctx.social.handles).map(([p, h]) => [p, h.handle])),
    connectionStatus: ctx.social.connectionStatus, connectedPlatforms: ctx.social.connectedPlatforms,
    legacySchool: b.legacy.row.school, sourceMode: ctx.sourceMode, coverage: ctx.coverage,
  };
}
