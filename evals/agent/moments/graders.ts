/**
 * evals/agent/moments/graders.ts — the moments stage's CODE graders. Pure functions over a MomentsRecord: no model, no
 * database, no network. Wherever the system already has the check, the grader calls the system's own function (the
 * source check research.ts checkSource, the same-moment rule moments/facts.ts, the response schema, the copy rules).
 *
 *   schema_valid      the scan completed and its JSON matches the moments schema
 *   moments_count     the scan kept between the case's minimum and maximum (3–5) moments
 *   moments_window    every moment the scan wrote or refreshed is dated inside the window; no owned moment on file has
 *                     passed
 *   moments_sourced   every moment the scan wrote or refreshed rests on a page its searches saw, or on the athlete's own
 *                     fact or deal (a source ref the case gave); a refreshed one may keep its own page
 *   moments_dedupe    no two active event facts are the same moment (date + normalised name)
 *   moments_store     what the case says must be retired is superseded; what must be kept is still active
 *   moments_kit       one pending candidate post per kept moment, each complete (moments 1.2.0: why now, a hook and one
 *                     angle; a candidate on file from before still needs its old fields: why now, hook, format, platform,
 *                     timing, what to show, caption angle, what to avoid, media needs), on an active moment
 *   moments_recall    the share of the case's "should have found this" list among the kept moments (≥ min_recall; a
 *                     miss is a warning until the owner has reviewed the case)
 *   must_not          none of the case's must-not items in the scan's words
 *   copy_rules        no gendered pronouns, no keys, no "AI" or "brain" in the scan's words
 *   cost              the scan's spend within its per-run reserve, its searches within the cap
 *
 * No athlete, sport, school or brand appears in this file: everything case-specific comes from the case.
 */
import { POST_FORMATS } from "../../../shared/postKit";
import { MOMENTS } from "../../../server/agent/moments/config";
import { EVENT_TOPICS, findSameMoment } from "../../../server/agent/moments/facts";
import { periodEnd } from "../../../server/agent/moments/scan";
import { BANNED_WORDS } from "../../../server/agent/plan/validate";
import { checkSource } from "../../../server/agent/research/research";
import { MOMENTS_SCHEMA } from "../../../server/agent/research/schemas";
import { matches, validateSchema } from "../graders";
import { fixtureUrl } from "./runMomentsCase";
import type { GraderResult } from "../types";
import type { MomentsCase, MomentsRecord, RecordedMoment } from "./types";

const PRONOUN = /\b(he|him|his|himself|she|her|hers|herself)\b/i;
const KEY = /(^|[^\p{L}\p{N}])[FMD]\d{1,3}(?![\p{L}\p{N}])/u;
const owned = (m: RecordedMoment) => (EVENT_TOPICS as readonly string[]).includes(m.topic ?? "");
const scanned = (r: MomentsRecord) => r.status === "scanned" && !!r.run && !!r.applied;
/** The moments the scan kept this run (written, refreshed or linked), as they stand after it. */
const kept = (r: MomentsRecord) => {
  const ids = new Set([...(r.applied?.written ?? []), ...(r.applied?.refreshed ?? []), ...(r.applied?.linked ?? [])]);
  return r.moments.filter((m) => ids.has(m.id));
};
/** Every piece of the scan's own words: its candidate posts and the moments it wrote or refreshed. */
export function momentCopy(r: MomentsRecord): Array<{ where: string; text: string }> {
  const touched = new Set([...(r.applied?.written ?? []), ...(r.applied?.refreshed ?? [])]);
  return [
    ...r.moments.filter((m) => touched.has(m.id)).flatMap((m) => [{ where: `moment ${m.name}`, text: m.name }, { where: `moment ${m.name} claim`, text: m.claim }]),
    ...r.candidates.filter((c) => c.response === "pending").flatMap((c) => [
      c.whyNow, c.idea.hook, c.idea.angle, c.idea.timing, c.brief.show, c.brief.captionAngle, c.brief.avoid, c.mediaNeeds,
    ].map((text) => ({ where: `candidate ${c.name}`, text }))),
  ].filter((x) => x.text.trim());
}
const skip = (grader: string, r: MomentsRecord): GraderResult => ({ grader, status: "skip", summary: r.error ? `the scan stopped: ${r.error}` : `the scan did not run (${r.status})` });

export function gradeMomentsSchema(r: MomentsRecord): GraderResult {
  if (!r.run) return r.error ? { grader: "schema_valid", status: "fail", summary: `the scan failed: ${r.error}` } : skip("schema_valid", r);
  if (r.run.status !== "completed") return { grader: "schema_valid", status: "fail", summary: `run ${r.run.status}${r.run.error ? `: ${r.run.error}` : ""}` };
  const errors = validateSchema(MOMENTS_SCHEMA, r.run.json);
  return errors.length
    ? { grader: "schema_valid", status: "fail", summary: `${errors.length} schema error(s)`, details: errors.slice(0, 10) }
    : { grader: "schema_valid", status: "pass", summary: "the scan completed with schema-valid JSON" };
}

export function gradeMomentsCount(c: MomentsCase, r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("moments_count", r);
  const n = kept(r).length;
  const ok = n >= c.expect.min_moments && n <= c.expect.max_moments;
  return { grader: "moments_count", status: ok ? "pass" : "fail", summary: `${n} moment(s) kept (${c.expect.min_moments}–${c.expect.max_moments}); ${r.held.length} held`, score: n, higherIsBetter: true, details: r.held.length ? { held: r.held } : undefined };
}

export function gradeMomentsWindow(r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("moments_window", r);
  const problems: string[] = [];
  const touched = new Set([...(r.applied!.written), ...(r.applied!.refreshed)]);
  for (const m of r.moments.filter((x) => touched.has(x.id))) {
    if (!m.date || m.date < r.today || m.date > r.horizonEnd) problems.push(`${m.name}: ${m.date ?? "no date"} is outside ${r.today}…${r.horizonEnd}`);
    if (m.datePrecision === "year") problems.push(`${m.name}: a year-only date`);
  }
  for (const m of r.moments.filter((x) => owned(x) && x.status === "active" && x.date && periodEnd(x.date, x.datePrecision as any) < r.today)) problems.push(`${m.name}: passed (${m.date}) but still active`);
  return problems.length ? { grader: "moments_window", status: "fail", summary: problems.join("; ") } : { grader: "moments_window", status: "pass", summary: `every moment inside ${r.today}…${r.horizonEnd}; nothing passed left active` };
}

export function gradeMomentsSourced(c: MomentsCase, r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("moments_sourced", r);
  const touched = new Set([...(r.applied!.written), ...(r.applied!.refreshed)]);
  const refs = new Set(r.internalRefs);
  const bad = r.moments.filter((m) => touched.has(m.id)).filter((m) => {
    // A moment on file the scan refreshed without a new page keeps its own source (the case's page for it).
    if (m.sourceUrl) return !checkSource(m.sourceUrl, r.run!.sources).ok && !(m.caseKey && m.sourceUrl === fixtureUrl(c, m.caseKey));
    return !(m.sourceRef && refs.has(m.sourceRef));
  });
  return bad.length
    ? { grader: "moments_sourced", status: "fail", summary: `${bad.length} moment(s) without a seen page or the athlete's own fact or deal`, details: bad.map((m) => ({ name: m.name, url: m.sourceUrl, ref: m.sourceRef })) }
    : { grader: "moments_sourced", status: "pass", summary: `${touched.size} moment(s), each on a seen page or the athlete's own record` };
}

export function gradeMomentsDedupe(r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("moments_dedupe", r);
  const active = r.moments.filter((m) => (m.status === "active" || m.status === "disputed") && m.date);
  const dups: string[] = [];
  active.forEach((m, i) => {
    const other = findSameMoment({ name: m.name, date: m.date!, precision: (m.datePrecision ?? "day") as any }, active.slice(i + 1).map((x) => ({ subject: { kind: "event" as const, name: x.name }, claim: x.claim, date: x.date, datePrecision: x.datePrecision as any })));
    if (other) dups.push(`${m.name} (${m.date}) twice`);
  });
  return dups.length ? { grader: "moments_dedupe", status: "fail", summary: dups.join("; ") } : { grader: "moments_dedupe", status: "pass", summary: `${active.length} active moment(s), no duplicates` };
}

export function gradeMomentsStore(c: MomentsCase, r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("moments_store", r);
  const byKey = new Map(r.moments.filter((m) => m.caseKey).map((m) => [m.caseKey!, m]));
  const problems = [
    ...c.expect.retired.filter((k) => byKey.get(k)?.status !== "superseded").map((k) => `${k} should be retired (is ${byKey.get(k)?.status ?? "missing"})`),
    ...c.expect.kept.filter((k) => byKey.get(k)?.status !== "active").map((k) => `${k} should stay active (is ${byKey.get(k)?.status ?? "missing"})`),
  ];
  return problems.length ? { grader: "moments_store", status: "fail", summary: problems.join("; ") } : { grader: "moments_store", status: "pass", summary: `${c.expect.retired.length} retired, ${c.expect.kept.length} kept, as the case expects` };
}

export function gradeMomentsKit(r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("moments_kit", r);
  const pending = r.candidates.filter((x) => x.response === "pending");
  const problems: string[] = [];
  for (const m of kept(r)) {
    const mine = pending.filter((x) => x.factId === m.id);
    if (mine.length !== 1) problems.push(`${m.name}: ${mine.length} pending candidate posts (one wanted)`);
  }
  const activeIds = new Set(r.moments.filter((m) => m.status === "active" || m.status === "disputed").map((m) => m.id));
  for (const x of pending) {
    if (!activeIds.has(x.factId)) problems.push(`${x.name}: its moment is not active`);
    // moments 1.2.0: a hook and one angle (the plan picks the rest); a candidate written before keeps its old fields.
    const legacy = !x.idea.angle && !!x.idea.format;
    const missing = Object.entries(legacy
      ? { whyNow: x.whyNow, hook: x.idea.hook, platform: x.idea.platform, timing: x.idea.timing, show: x.brief.show, captionAngle: x.brief.captionAngle, avoid: x.brief.avoid, mediaNeeds: x.mediaNeeds }
      : { whyNow: x.whyNow, hook: x.idea.hook, angle: x.idea.angle })
      .filter(([, v]) => !v.trim()).map(([k]) => k);
    if (missing.length) problems.push(`${x.name}: no ${missing.join(", ")}`);
    if (legacy && !(POST_FORMATS as readonly string[]).includes(x.idea.format)) problems.push(`${x.name}: format "${x.idea.format}"`);
  }
  return problems.length ? { grader: "moments_kit", status: "fail", summary: problems.join("; ") } : { grader: "moments_kit", status: "pass", summary: `${pending.length} complete candidate post(s), one per moment` };
}

export function gradeMomentsRecall(c: MomentsCase, r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("moments_recall", r);
  if (!c.expect.golden.length) return { grader: "moments_recall", status: "skip", summary: "the case has no golden list" };
  const texts = kept(r).map((m) => `${m.name}. ${m.claim}`);
  const rows = c.expect.golden.map((g) => ({ id: g.id, found: texts.some((t) => matches(t, g.match)) }));
  const recall = rows.filter((x) => x.found).length / rows.length;
  const missing = rows.filter((x) => !x.found).map((x) => x.id);
  const status = recall >= c.expect.min_recall ? "pass" : c.reviewed ? "fail" : "warn";
  return { grader: "moments_recall", status, summary: `${rows.length - missing.length}/${rows.length} should-have-found moments (min ${Math.round(c.expect.min_recall * 100)}%)${missing.length ? `; missing ${missing.join(", ")}` : ""}`, score: Math.round(recall * 1000) / 1000, higherIsBetter: true, details: rows };
}

export function gradeMomentsMustNot(c: MomentsCase, r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("must_not", r);
  if (!c.expect.must_not.length) return { grader: "must_not", status: "skip", summary: "the case lists nothing" };
  const hits = c.expect.must_not.flatMap((m) => momentCopy(r).filter((t) => matches(t.text, m.match)).map((t) => ({ why: m.why, where: t.where, text: t.text })));
  return hits.length ? { grader: "must_not", status: "fail", summary: `${hits.length} must-not hit(s)`, details: hits } : { grader: "must_not", status: "pass", summary: `none of ${c.expect.must_not.length} must-not items appeared` };
}

export function gradeMomentsCopy(r: MomentsRecord): GraderResult {
  if (!scanned(r)) return skip("copy_rules", r);
  const hits = momentCopy(r).flatMap((t) => [
    ...(PRONOUN.test(t.text) ? [{ rule: "gendered_pronoun", ...t }] : []),
    ...(KEY.test(t.text) ? [{ rule: "key", ...t }] : []),
    ...(BANNED_WORDS.test(t.text) ? [{ rule: "ai_or_brain", ...t }] : []),
  ]);
  return hits.length ? { grader: "copy_rules", status: "fail", summary: `${hits.length} copy hit(s): ${[...new Set(hits.map((h) => h.rule))].join(", ")}`, details: hits } : { grader: "copy_rules", status: "pass", summary: `${momentCopy(r).length} pieces of copy: no pronouns, keys, "AI" or "brain"` };
}

export function gradeMomentsCost(r: MomentsRecord): GraderResult {
  if (!r.run) return skip("cost", r);
  const usd = r.run.costMicroUsd / 1e6;
  const problems = [
    ...(r.run.costMicroUsd > MOMENTS.RUN_RESERVE_MICRO_USD ? [`$${usd.toFixed(3)} over the $${(MOMENTS.RUN_RESERVE_MICRO_USD / 1e6).toFixed(2)} reserve`] : []),
    ...(r.run.webSearchCalls > MOMENTS.MAX_SEARCHES ? [`${r.run.webSearchCalls} searches (cap ${MOMENTS.MAX_SEARCHES})`] : []),
  ];
  return { grader: "cost", status: problems.length ? "fail" : "pass", summary: problems.length ? problems.join("; ") : `$${usd.toFixed(4)}, ${r.run.webSearchCalls} search(es)`, score: Math.round(usd * 10_000) / 10_000, higherIsBetter: false };
}

/** Every moments grader, in report order. */
export function gradeMomentsCase(c: MomentsCase, r: MomentsRecord): GraderResult[] {
  return [
    gradeMomentsSchema(r), gradeMomentsCount(c, r), gradeMomentsWindow(r), gradeMomentsSourced(c, r), gradeMomentsDedupe(r), gradeMomentsStore(c, r),
    gradeMomentsKit(r), gradeMomentsRecall(c, r), gradeMomentsMustNot(c, r), gradeMomentsCopy(r), gradeMomentsCost(r),
  ];
}
