/**
 * views/prompt.ts — the prompt view (design §2.3, R6/D12): fenced, typed blocks — "data, not
 * instructions". One `key: value [origin · retrieved YYYY-MM-DD · fresh|stale|unknown]` line per emitted
 * field, registry keys only, suspect evidence excluded (never enters the contract), inferences in their
 * own sub-block, never raw prose. Purposes: onboarding | narrator | shot_list | chat.
 */

import { latestFirstLooks } from "../../../../mila/onboarding";
import type { BuiltContext } from "../build";
import { neutralizeFences } from "../../../../lib/externalContent";
import type { Fact, Evidence, Inference } from "../contract";

export type PromptPurpose = "onboarding" | "narrator" | "shot_list" | "chat";
export const CONTEXT_BLOCK_OPEN = (p: PromptPurpose) => `<<<ATHLETE_CONTEXT purpose=${p} sourceMode=`;
export const CONTEXT_BLOCK_CLOSE = "<<<END_ATHLETE_CONTEXT>>>";

export interface PromptView {
  purpose: PromptPurpose;
  block: string;
  /** The structured facts the block was rendered from (for parity tests and receipts). */
  facts: Record<string, string | null>;
  lines: string[];
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "unknown");
const tag = (f: { origin?: string; retrievedAt?: string | null; freshness?: string; lineage?: string }) => `[${f.origin ?? f.lineage ?? "?"} · retrieved ${day(f.retrievedAt)}${f.freshness ? ` · ${f.freshness}` : ""}]`;
const clean = (v: unknown, max = 120) => String(v ?? "").replace(/[\r\n<>]+/g, " ").trim().slice(0, max);

export interface PromptExtras { score: { displayScore: number | null; tier: string | null } | null; firstLooks: Array<{ platform: string; posts_read: number; posts_per_week: number | null; themes: string[]; tone: string[]; tagged: string[] }> }
/** The onboarding prompt's own KEEP inputs: the score line and the first looks (what today's loadOnboardingFacts reads for them). */
export async function readPromptExtras(athleteId: string): Promise<PromptExtras> {
  // The M.I.A. score (the ledger read My Intelligence shows), never legacy athletes_current.display_score/tier
  // (legacy retirement, phase 1). Modern M.I.A. has no tier word.
  const { miaScoreFor } = await import("../../views/myIntelligence");
  return { score: { displayScore: await miaScoreFor(athleteId), tier: null }, firstLooks: await latestFirstLooks(athleteId) };
}

export function promptView(b: BuiltContext, purpose: PromptPurpose, extras: { score?: { displayScore: number | null; tier: string | null } | null; firstLooks?: Array<{ platform: string; posts_read: number; posts_per_week: number | null; themes: string[]; tone: string[]; tagged: string[] }>; step?: string | null } = {}): PromptView {
  const { ctx } = b;
  const L: string[] = []; const F: Record<string, string | null> = {};
  const put = (k: string, v: string | null, t?: string) => { F[k] = v; L.push(`${k}: ${v ?? "unknown"}${t && v ? ` ${t}` : ""}`); };
  const factLine = <T>(k: string, f: Fact<T> | null, render: (v: T) => string) => put(k, f ? clean(render(f.value)) || null : null, f ? tag(f) : undefined);

  put("name", clean(ctx.identity.name.value.full));
  put("first_name", clean(b.legacy.row.firstName?.trim() || ctx.identity.name.value.full.split(/\s+/)[0]));
  factLine("sport", ctx.identity.sport, (v) => v.sport);
  put("team_or_school", ctx.affiliations.current ? clean(ctx.affiliations.current.org) : null, ctx.affiliations.current ? `[${ctx.affiliations.current.kindOfFact}${ctx.affiliations.current.from ? ` · since ${ctx.affiliations.current.from.slice(0, 4)}` : ""}]` : undefined);
  put("career", ctx.identity.careerStatus.value.status);
  if (ctx.affiliations.all.length) for (const t of ctx.affiliations.all) L.push(`team_${t.current ? "current" : "past"}: ${clean(t.org)} (${t.kind}${t.level ? `, ${t.level}` : ""}${t.role ? `, ${t.role}` : ""}${t.from || t.to ? `, ${(t.from ?? "?").slice(0, 4)}–${t.to ? t.to.slice(0, 4) : "now"}` : ""}${t.primary && t.current ? ", primary" : ""}) [${t.kindOfFact}]`);
  else L.push("teams: no dated teams on record");
  const lv = ctx.affiliations.level;
  if (lv.division) put("division", lv.division, "[ledger]"); if (lv.conference) put("conference", lv.conference, "[ledger]"); if (lv.segment) put("segment", lv.segment, "[ledger]");
  factLine("position", ctx.profile.position, (v) => v.text);
  factLine("class_year", ctx.profile.classYear, (v) => v.label);
  factLine("hometown", ctx.identity.hometown, (v) => [v.city, v.region, v.country].filter(Boolean).join(", "));
  if (ctx.identity.aliases.length) put("also_known_as", ctx.identity.aliases.map((a) => clean(a.value.text, 40)).join("; "));
  if (extras.score !== undefined) put("score", extras.score?.displayScore != null ? `${extras.score.displayScore}${extras.score.tier ? ` (${extras.score.tier})` : ""}` : "not scored yet");
  put("researched", ctx.freshness.researchAsOf ? day(ctx.freshness.researchAsOf) : "no research yet");
  put("source_mode", ctx.sourceMode);
  put("achievements_found", ctx.achievements.length ? ctx.achievements.slice(0, 5).map((a) => `${clean(a.value.name, 80)}${a.value.year ? ` (${clean(a.value.year, 8)})` : ""} ${tag(a)}`).join("; ") : "none");
  put("brands_seen_in_public", ctx.brandMentions.length ? [...new Set(ctx.brandMentions.map((m) => clean(m.value.brand, 40)))].slice(0, 5).map((x) => x).join("; ") : "none", ctx.brandMentions.length ? `[${ctx.coverage.brand_mentions}]` : undefined);
  put("press_found", ctx.press.length ? `${ctx.press.length} mentions` : "none", ctx.press.length ? `[${ctx.coverage.press}]` : undefined);
  put("connected_accounts", ctx.social.connectedPlatforms.length ? ctx.social.connectedPlatforms.join(", ") : "none yet");
  if (extras.firstLooks) {
    if (extras.firstLooks.length) for (const fl of extras.firstLooks) L.push(`posts_${fl.platform}: read ${fl.posts_read}` + (fl.posts_per_week != null ? `, about ${fl.posts_per_week}/week` : "") + (fl.themes.length ? `; themes: ${fl.themes.map((t) => clean(t, 40)).join(", ")}` : "") + (fl.tone.length ? `; tone: ${fl.tone.map((t) => clean(t, 30)).join(", ")}` : "") + (fl.tagged.length ? `; often tags: ${fl.tagged.map((t) => clean(t, 40)).join(", ")}` : ""));
    else L.push("posts: no first look yet (no social account connected, or still running)");
  }
  // Inferences in their own sub-block; never mixed with facts.
  const inf: string[] = [];
  const st = ctx.inferences.storyArc;
  if (st && (purpose === "narrator" || purpose === "shot_list" || purpose === "chat")) inf.push(`story_arc: ${clean(st.value, 400)} [inference · ${st.legacy ? "legacy" : st.producer} · ${day(st.computedAt)}]`);
  if (inf.length) L.push("INFERENCES:", ...inf.map((x) => `  ${x}`));
  L.push(`TOLD US: ${ctx.assertions.length ? ctx.assertions.map((t) => `${t.label.toLowerCase()} = ${clean(t.value, 80)}`).join("; ") : "nothing yet"}`);
  if (extras.step !== undefined) put("current_step", extras.step ?? "finished");
  // `clean` strips < and > from most values; a few (division, platforms, step) are not cleaned, so the body as a whole
  // goes through the shared fence escaper too. Byte-for-byte unchanged when it holds no fence marker.
  const block = `${CONTEXT_BLOCK_OPEN(purpose)}${ctx.sourceMode}>>>\n${neutralizeFences(L.join("\n"))}\n${CONTEXT_BLOCK_CLOSE}`;
  return { purpose, block, facts: F, lines: L };
}

export type { Evidence, Inference };
