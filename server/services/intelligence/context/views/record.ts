/**
 * views/record.ts — the record view (design §2.3, 2d-2): the Facts / Teams / Story / Found / Numbers /
 * Connections groups in today's RecordEntry shape, every research-derived row labelled by REAL provenance.
 * Fixes: D2 (division/conference from the ledger row's kind and dates, never "found online · researchedAt"),
 * D4 (position / class year / hometown from the contract's profile facts), D5 (no causes value),
 * D6 (the narrative row is emitted where the Story tab reads it: group `story`, field `narrative`).
 * Non-research rows (goals, voice, numbers, connections) keep their KEEP sources.
 * The generated media-kit hook is NOT read here: artifact output stays downstream and is never shown back as her
 * story or treated as a source (the Story feedback-loop fix, 30 Sep 2026). The kit rows themselves are untouched.
 */

import { readFollowers, type Followers } from "../../../followers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../../db";
import { athletesCurrent, connectedAccounts, deals, socialAnalyticsSnapshots } from "../../../../../shared/schema";
import { ASSERTED_FIELDS, latestFirstLooks, type AssertedField, type AssertedFieldSpec } from "../../../../mila/onboarding";
import { goalLabel, careerStatusLabel } from "../../../../../shared/goals";
import { displayTeam } from "../../../affiliations";
import { compact, schoolShort, titleCase } from "../../../athleteContext";
import type { AthleteRecord, RecordEntry, RecordGroup, RecordKind } from "../../../athleteRecord";
import type { BuiltContext } from "../build";
import type { Fact } from "../contract";

const EARNED = ["accepted", "completed"] as const;
const ATHLETE_CONFIRMED = ["contract_upload", "self_reported"] as const;
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const cadenceText = (perWeek: number | null | undefined): string | null => { if (perWeek == null || !Number.isFinite(perWeek)) return null; if (perWeek < 0.75) return "less than 1 a week"; return `about ${Math.round(perWeek)} a week`; };

export interface RecordExtras {
  /** athletes_current, non-score fields only (legacy retirement P2-3: no score, tier, capitals, rate card or counts). */
  cur: { research_updated_at: Date | null; story_arc: string | null } | null;
  /** Follower counts from the social substrate (services/followers.ts). */
  followers?: Followers;
  looks: Awaited<ReturnType<typeof latestFirstLooks>>;
  conns: Array<{ platform: string; username: string | null; status: string | null }>;
  partners: Array<{ brand: string | null; source: string | null }>;
  analytics: Array<{ platform: string; followers: number | null; gender: string | null; age: string | null; city: string | null; day: unknown }>;
  /** The M.I.A. score of record (the ledger read My Intelligence shows) — the only score this view emits. */
  mia?: { score: number | null; evidenceAsOf: string | null };
}

export async function readRecordExtras(athleteId: string): Promise<RecordExtras> {
  const [cur, looks, conns, partnerRows, analytics] = await Promise.all([
    db.select({ research_updated_at: athletesCurrent.research_updated_at, story_arc: athletesCurrent.story_arc }).from(athletesCurrent).where(eq(athletesCurrent.athlete_id, athleteId)).limit(1).then((r) => r[0] ?? null),
    latestFirstLooks(athleteId),
    db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username, status: connectedAccounts.status }).from(connectedAccounts).where(eq(connectedAccounts.athlete_id, athleteId)),
    db.select({ brand: deals.brand_name, source: deals.source }).from(deals).where(and(eq(deals.athlete_id, athleteId), inArray(deals.status, EARNED as unknown as string[]))).catch(() => [] as Array<{ brand: string | null; source: string | null }>),
    db.select({ platform: socialAnalyticsSnapshots.platform, followers: socialAnalyticsSnapshots.followers, gender: socialAnalyticsSnapshots.top_audience_gender, age: socialAnalyticsSnapshots.top_audience_age_range, city: socialAnalyticsSnapshots.top_audience_city, day: socialAnalyticsSnapshots.snapshot_date }).from(socialAnalyticsSnapshots).where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.source, "connected"))).orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(9),
  ]);
  // Legacy retirement, phase 1: the score row reads the ledger M.I.A., never athletes_current.display_score/tier.
  const { buildMyIntelligence } = await import("../../views/myIntelligence");
  const mi = await buildMyIntelligence(athleteId);
  const followers = await readFollowers(athleteId);
  return { cur, looks, conns, partners: partnerRows, analytics, followers, mia: { score: mi.assessment?.score ?? null, evidenceAsOf: mi.assessment?.evidenceAsOf ?? null } };
}

const editable = (field: AssertedField, spec: AssertedFieldSpec): Pick<RecordEntry, "editable" | "actions" | "shape"> => ({ editable: true, actions: ["change", "tell_mila", "history"], shape: spec.shape });
const readOnly = (field: string, label: string, value: string | null, kind: RecordKind | null, source: string | null, at: string | null, link?: RecordEntry["link"]): RecordEntry =>
  ({ field, label, value, kind: value ? kind : null, source: value ? source : null, at: value ? at : null, editable: false, actions: link ? ["link"] : [], ...(link ? { link } : {}) });

/** Provenance label for a contract fact (design §2.2): the athlete's word, a contract, a connection, a cited source, or legacy compatibility data. */
export function provenanceOf(f: Fact | null): { kind: RecordKind | null; source: string | null; at: string | null } {
  if (!f) return { kind: null, source: null, at: null };
  switch (f.origin) {
    case "athlete_asserted": return { kind: "said", source: "you said", at: f.retrievedAt };
    case "athlete_proof": return { kind: "proof", source: "contract on file", at: f.retrievedAt };
    case "connection": return { kind: "found", source: "from your connected account", at: f.retrievedAt };
    case "research": case "backfill": return { kind: "found", source: f.authorityTier != null ? `found online · source tier ${f.authorityTier}${f.freshness === "stale" ? " · stale" : ""}` : "found online", at: f.retrievedAt };
    case "legacy_row": return { kind: "said", source: "signup", at: f.retrievedAt };
    case "legacy_blob": return { kind: "found", source: "found online (earlier research)", at: f.retrievedAt };
  }
}

/** "Instagram 12K · Tiktok 8K · Youtube 300" — the record's Followers line (same order and format as before). */
export function followersLine(f: Followers | undefined): string | null {
  if (!f) return null;
  return ([["instagram", f.counts.instagram], ["tiktok", f.counts.tiktok], ["youtube", f.counts.youtube]] as Array<[string, number | null]>)
    .filter(([, n]) => n).map(([p, n]) => `${titleCase(p)} ${compact(Number(n))}`).join(" · ") || null;
}

export function recordView(b: BuiltContext, x: RecordExtras): AthleteRecord {
  const { ctx, legacy } = b;
  const a = legacy.row;
  const said = new Map(ctx.assertions.map((s) => [s.field, s]));
  const saidOr = (field: AssertedField, fallback: { value: string | null; raw?: unknown; kind: RecordKind | null; source: string | null; at: string | null }): RecordEntry => {
    const spec = ASSERTED_FIELDS[field] as AssertedFieldSpec;
    const s = said.get(field);
    if (s) {
      const how = s.source === "settings" ? "you changed it" : s.mode === "voice" ? "you told Mila" : s.source === "onboarding" ? "you told Mila" : "you said";
      return { field, label: spec.label, value: s.value, raw: s.raw, kind: "said", source: how, at: iso(s.at), ...editable(field, spec) };
    }
    return { field, label: spec.label, value: fallback.value, raw: fallback.raw, kind: fallback.value ? fallback.kind : null, source: fallback.value ? fallback.source : null, at: fallback.value ? fallback.at : null, ...editable(field, spec) };
  };
  const factRow = <T>(field: AssertedField, f: Fact<T> | null, render: (v: T) => string | null) => { const p = provenanceOf(f); return saidOr(field, { value: f ? render(f.value) : null, kind: p.kind, source: p.source, at: p.at }); };

  const seenBrand = new Set<string>();
  const partners = x.partners.filter((r) => { const k = (r.brand ?? "").trim().toLowerCase(); if (!k || seenBrand.has(k)) return false; seenBrand.add(k); return true; });
  const partnerNames = partners.map((r) => String(r.brand).trim());
  const partnersAllConfirmed = partners.length > 0 && partners.every((r) => (ATHLETE_CONFIRMED as readonly string[]).includes(r.source ?? ""));
  const latestBy = new Map<string, RecordExtras["analytics"][number]>();
  for (const r of x.analytics) if (!latestBy.has(r.platform)) latestBy.set(r.platform, r);
  const ig = latestBy.get("instagram") ?? x.analytics[0];
  const cur = x.cur;
  const researchAsOf = ctx.freshness.researchAsOf;

  // ── who ──
  const achievements = ctx.achievements.map((f) => ({ name: f.value.name, year: f.value.year != null ? String(f.value.year) : null, level: f.value.level, fact: f })).filter((v) => v.name);
  const marquee = achievements[0] ?? null;
  const sport = ctx.identity.sport?.value.sport ?? null;
  const identityLine = [sport ? titleCase(sport) : "", schoolShort(ctx.affiliations.current?.org ?? a.school ?? ""), marquee && /world cup|national|olympic|u-\d\d/i.test(marquee.name) ? marquee.name : ""].filter(Boolean).join(" · ");
  const connected = x.conns.filter((c) => c.status === "active");
  const byHandle = new Map<string, string[]>();
  for (const p of ["instagram", "tiktok", "youtube", "twitter"] as const) {
    const key = p === "twitter" ? "x" : p;
    const c = connected.find((y) => y.platform === key);
    // The row reads "signup" / "N connected": a connected handle, else what the athlete typed at signup
    // (athletes.socials — the athlete's own entry, not a projection). Identity-sourced handles (Step 1a/2c
    // substrate) outrank the typed one in `social.handles`; they surface in the identity and search views.
    const typed = a.socials[p] ?? a.socials[key];
    const h = c?.username ?? (typed ? String(typed) : null);
    if (!h) continue;
    const k = `@${String(h).replace(/^@/, "")}`;
    byHandle.set(k, [...(byHandle.get(k) ?? []), p === "twitter" ? "X" : titleCase(p)]);
  }
  const handleLine = [...byHandle.entries()].map(([h, ps]) => `${h} (${ps.join(", ")})`).join(" · ");
  const currentAff = ctx.affiliations.current;
  const affKind: RecordKind | null = currentAff ? (currentAff.kindOfFact === "found" ? "found" : currentAff.kindOfFact === "proof" ? "proof" : "said") : null;
  const affSource = currentAff ? (currentAff.source === "signup" ? "signup" : currentAff.kindOfFact === "found" ? "found online" : currentAff.kindOfFact === "proof" ? "contract on file" : currentAff.source === "onboarding" ? "you told Mila" : currentAff.source === "settings" ? "you changed it" : "you said") : null;
  const affAt = currentAff ? (currentAff.source === "signup" ? a.createdAt : currentAff.recordedAt ?? null) : null;
  const lv = ctx.affiliations.level;
  const who: RecordEntry[] = [
    readOnly("name", "Name", a.fullName, "said", "signup", a.createdAt),
    saidOr("nickname", { value: a.firstName?.trim() || null, kind: "said", source: "signup", at: a.createdAt }),
    readOnly("photo", "Photo", a.photoUrl ? "On file" : null, "found", "your sign-in", null, "connections"),
    saidOr("sport", { value: sport ? titleCase(sport) : null, kind: "said", source: "signup", at: a.createdAt }),
    saidOr("school", { value: currentAff?.org ?? a.school ?? null, kind: currentAff ? affKind : "said", source: currentAff ? affSource : "signup", at: currentAff ? affAt : a.createdAt }),
    saidOr("career_status", { value: careerStatusLabel(a.careerStatus) ?? "Playing", raw: { status: a.careerStatus ?? "active", since: null }, kind: "said", source: "signup", at: a.createdAt }),
    // D2: the level row carries the ledger row's real kind and date, never "found online · researchedAt"
    readOnly("division", "Division · conference", [lv.division, lv.conference].filter(Boolean).join(" · ") || null, affKind ?? "made", affSource ?? "from your team", affAt),
    readOnly("level", "Level", lv.segment ? titleCase(lv.segment.replace(/_/g, " ")) : null, "made", "from your team", null),
    // D4: profile facts from the contract (legacy: research.profile.*)
    factRow("position", ctx.profile.position, (v) => v.text),
    factRow("class_year", ctx.profile.classYear, (v) => v.label),
    factRow("hometown", ctx.identity.hometown, (v) => [v.city, v.region, v.country].filter(Boolean).join(", ") || null),
    readOnly("credential", "Marquee credential", marquee?.name ?? null, provenanceOf(marquee?.fact ?? null).kind, provenanceOf(marquee?.fact ?? null).source, provenanceOf(marquee?.fact ?? null).at),
    readOnly("handles", "Handles", handleLine || null, "said", connected.length ? `${connected.length} connected` : "signup", null, "connections"),
  ];

  // ── teams ──
  const teams = ctx.affiliations.all;
  const teamList = teams.map((t) => ({ org: t.org, kind: t.kind, level: t.level, conference: t.conference, role: t.role, position: t.position, from: t.from, to: t.to, primary: t.primary, fact: t.kindOfFact }));
  const teamRows: RecordEntry[] = teams.map((t, i) => {
    const span = t.to ? `${t.from ? t.from.slice(0, 4) + "–" : ""}${t.to.slice(0, 4)}` : t.from ? `since ${t.from.slice(0, 4)}` : null;
    const meta = [t.role, t.position, span].filter(Boolean).join(" · ");
    return { ...readOnly(`team_${i}`, t.current ? (t.primary ? "Team · current · primary" : "Team · current") : "Team · past", displayTeam(t as any), t.kindOfFact, [meta || null, t.source === "signup" ? "signup" : t.kindOfFact === "found" ? "found online" : t.source === "onboarding" ? "you told Mila" : t.source === "settings" ? "you changed it" : t.source].filter(Boolean).join(" · ") || null, null),
      editable: true, actions: ["change", "tell_mila", "history"], shape: "teams" as const, raw: { index: i, team: teamList[i], teams: teamList } };
  });
  const teamsEditor = saidOr("affiliations", { value: null, kind: null, source: null, at: null });
  const teamsGroup: RecordEntry[] = [...teamRows, { ...teamsEditor, label: teamRows.length ? "Add a team" : "Teams", value: null, raw: { index: null, team: null, teams: teamList } }];

  // ── want (KEEP sources) ──
  const secondary = Array.isArray(a.secondaryGoals) ? (a.secondaryGoals as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const want: RecordEntry[] = [
    saidOr("goal", { value: goalLabel(a.goalArchetype), raw: a.goalArchetype ?? undefined, kind: "said", source: "signup", at: a.createdAt }),
    saidOr("secondary_goals", { value: secondary.length ? secondary.map(goalLabel).join(", ") : null, raw: secondary.length ? secondary : undefined, kind: "said", source: "signup", at: a.createdAt }),
    saidOr("brands_wanted", { value: null, kind: null, source: null, at: null }),
    saidOr("never_post", { value: null, kind: null, source: null, at: null }),
    saidOr("cadence", { value: cadenceText(x.looks[0]?.posts_per_week), kind: "found", source: `from ${x.looks[0]?.platform ?? "your posts"}`, at: null }),
    readOnly("deal_preferences", "Deal types you take", null, null, null, null, "deal_preferences"),
    readOnly("floor", "The least you'll take", null, null, null, null, "rates"),
  ];
  for (const e of want) { if (e.field === "goal" && typeof e.raw === "string") e.value = goalLabel(e.raw); if (e.field === "secondary_goals" && Array.isArray(e.raw)) e.value = (e.raw as string[]).map(goalLabel).join(", ") || null; }

  // ── story ──
  const voice = a.brandVoice as { tone?: string; phrases?: string[]; avoid?: string[] } | null;
  const voiceLine = voice ? [voice.tone, voice.phrases?.length ? `says: ${voice.phrases.join(", ")}` : null, voice.avoid?.length ? `avoids: ${voice.avoid.join(", ")}` : null].filter(Boolean).join(" · ") : null;
  const st = ctx.inferences.storyArc;
  const story: RecordEntry[] = [
    readOnly("narrative", "Story", st?.value ?? null, "made", st?.legacy ? "written from research" : `written from research · ${st?.producer ?? ""}`, st?.computedAt ?? null),
    readOnly("stories", "Your stories", null, null, null, null),
    saidOr("brands_causes", { value: null, kind: null, source: null, at: null }),
    saidOr("hobbies", { value: null, kind: null, source: null, at: null }),
    saidOr("note", { value: null, kind: null, source: null, at: null }),
    saidOr("brand_voice", { value: voiceLine, raw: voice ?? undefined, kind: "said", source: "you confirmed", at: null }),
  ];

  // ── found ──
  const brandsSeen = [...new Set(ctx.brandMentions.map((m) => m.value.brand.trim()).filter(Boolean))];
  const legacyTag = ctx.coverage.brand_mentions === "unavailable" && ctx.brandMentions.length ? "found online (earlier research)" : "found online";
  const found: RecordEntry[] = [
    readOnly("achievements", "Achievements", achievements.length ? achievements.slice(0, 5).map((v) => v.year ? `${v.name} (${v.year})` : v.name).join(" · ") : null, "found", `${achievements.length} found online${ctx.coverage.achievements === "unavailable" ? " (earlier research)" : ""}`, researchAsOf),
    readOnly("press", "Press", ctx.press.length ? `${ctx.press.length} mentions` : null, "found", ctx.coverage.press === "unavailable" ? "found online (earlier research)" : "found online", researchAsOf),
    readOnly("brands_seen", "Brands seen with you", brandsSeen.length ? brandsSeen.slice(0, 6).join(", ") : null, "found", legacyTag, researchAsOf, "deals"),
    readOnly("confirmed", "Confirmed relationships", partnerNames.length ? partnerNames.join(", ") : null, "proof", partnerNames.length ? (partnersAllConfirmed ? "contract on file" : "accepted deal · from your inbox") : "contract on file or accepted deal", null, "deals"),
    readOnly("causes_seen", "Causes seen with you", null, "found", "found online", researchAsOf),   // D5: never a value; the row stays for shape stability
    ...x.looks.map((l) => readOnly(`first_look_${l.platform}`, titleCase(l.platform), [l.themes.length ? l.themes.join(", ") : null, `${l.posts_read} posts read`, cadenceText(l.posts_per_week), l.tagged.length ? `tags ${l.tagged.map((t) => `@${t}`).join(", ")}` : null].filter(Boolean).join(" · "), "found", `from your ${l.platform} posts`, null, "growth")),
    readOnly("followers", "Followers", followersLine(x.followers), "found", "connected accounts", x.followers?.asOf ?? null, "growth"),
    readOnly("audience", "Audience", ig ? [ig.gender ? (ig.gender === "F" ? "mostly women" : ig.gender === "M" ? "mostly men" : ig.gender) : null, ig.age, ig.city].filter(Boolean).join(" · ") || null : null, "found", "from Instagram", iso(ig?.day as Date | string | null | undefined), "growth"),
  ];

  // ── numbers ──
  // Legacy retirement, phase 1 (owner decision 8 Oct 2026): the score is the M.I.A. score of record; the legacy
  // capitals and the computed rate card rows are gone (rates are being rebuilt — her floor is under "What you want").
  const miaScore = x.mia?.score ?? null;
  const numbers: RecordEntry[] = [
    readOnly("score", "Score", miaScore != null ? String(miaScore) : null, "made", "computed", x.mia?.evidenceAsOf ?? null, "score"),
  ];

  // ── connections ──
  const connections: RecordEntry[] = connected.length
    ? connected.map((c) => readOnly(`conn_${c.platform}`, titleCase(c.platform), c.username ? (c.username.includes("@") && !c.username.startsWith("@") ? c.username : `@${c.username.replace(/^@/, "")}`) : "Connected", "found", "connected", null, "connections"))
    : [readOnly("conn_none", "Accounts", null, null, null, null, "connections")];

  const groups: RecordGroup[] = [
    { key: "who", title: "Who you are", entries: who }, { key: "teams", title: "Your teams", entries: teamsGroup }, { key: "want", title: "What you want", entries: want },
    { key: "story", title: "Your story", entries: story }, { key: "found", title: "What we found", entries: found }, { key: "numbers", title: "Your numbers", entries: numbers }, { key: "connections", title: "Connections", entries: connections },
  ];
  const all = groups.flatMap((g) => g.entries).filter((e) => e.value);
  return {
    athleteId: ctx.athleteId,
    header: { name: a.fullName, identityLine, displayScore: miaScore, tier: null, photoUrl: a.photoUrl ?? null },
    groups,
    counts: { said: all.filter((e) => e.kind === "said").length, found: all.filter((e) => e.kind === "found").length, made: all.filter((e) => e.kind === "made").length, proof: all.filter((e) => e.kind === "proof").length },
  };
}
