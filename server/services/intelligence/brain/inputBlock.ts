/**
 * brain/inputBlock.ts — render the Brain's inputs. Evidence, not methodology: excluded from the canonical digest.
 *
 * The State block is the Opportunity renderer's, unchanged, so the Brain sees the athlete exactly as the evaluators
 * did; the Opportunity Map block is the Objective evaluator's, unchanged. What is new here is rendered under the
 * same rule: every line the Brain may cite shows its reference at the left, and nothing is rendered that the Brain
 * could not cite.
 */
import type { Objective } from "../contracts/objectiveEntity";
import { renderAssessmentUnderWork } from "./commercialAssessment";
import type { CommercialAttachment } from "./commercialAssessment";
import type { BrandResearchItem, ContextBlock, DecisionRequest, ExistingWork, ResearchBlock, SubjectItem } from "./contract";
import { subjectRefString } from "./contract";

const period = (o: Objective) => (o.horizon && "period" in o.horizon && o.horizon.period ? o.horizon.period : "no horizon");

/**
 * `excludedOpenings` (Slice 3 B): lineage keys withheld from this run's current strategic basis — they are dropped from
 * "rests on openings", and the line is omitted when none remain. Empty (the default) renders byte-identically to before.
 */
/** Slice 3 A: the success line of an Objective in `withheldSuccess` is awaiting her; the old text is not shown. */
export const SUCCESS_AWAITING_LINE = "(awaiting the athlete's review after their rewrite — Nomila's earlier line is not current)";

export function renderObjectivesBlock(live: Objective[], deferred: Objective[], declined: Objective[], excludedOpenings: ReadonlySet<string> = new Set(), withheldSuccess: ReadonlySet<string> = new Set()): string {
  const L: string[] = [];
  L.push("LIVE OBJECTIVES — what the athlete has decided to pursue. The only things you may recommend on.");
  L.push("Cite as objective[<id>].");
  L.push("");
  if (!live.length) L.push("    (none — the athlete has no live Objective. Every decision list will be empty.)");
  for (const o of live) {
    L.push(`    objective[${o.id}]`);
    L.push(`        ${o.domain} · origin ${o.provenance.origin} · ${o.disposition} · ${period(o)}`);
    L.push(`        desired state, in the athlete's words: ${o.desiredState.value}`);
    if (o.modifiedFrom) L.push(`        (Nomila's original proposal, superseded by the athlete's wording: ${o.modifiedFrom.desiredState})`);
    if (o.currentState?.value) L.push(`        current state, as proposed: ${o.currentState.value}`);
    L.push(`        how anyone would know: ${withheldSuccess.has(o.id) ? SUCCESS_AWAITING_LINE : o.success.observableCondition}`);
    const restsOn = (o.lineage?.opportunityKeys ?? []).filter((k) => !excludedOpenings.has(k));
    if (restsOn.length) L.push(`        rests on openings: ${restsOn.join(", ")}`);
    L.push("");
  }
  L.push("DEFERRED — standing information conditions. NOT active. The athlete set each aside and said why. You may name the");
  L.push("condition and request what would resolve it; you may not recommend on it or revive it. Cite as deferred[<id>].");
  L.push("");
  if (!deferred.length) L.push("    (none)");
  for (const o of deferred) {
    const d = o.deferral ?? { kind: "information", said: "" };
    L.push(`    deferred[${o.id}]`);
    L.push(`        ${o.domain} · disposition deferred · lifecycle ${o.lifecycle} · deferral kind ${d.kind}${"after" in d && d.after ? ` · until ${String(d.after).slice(0, 10)}` : ""}`);
    L.push(`        what was proposed: ${o.desiredState.value}`);
    L.push(`        the athlete's reason: ${JSON.stringify(d.said ?? "")}`);
    L.push("");
  }
  L.push("DECLINED — closed. Nothing may be done with these; they are shown so nothing is re-proposed.");
  L.push("");
  if (!declined.length) L.push("    (none)");
  for (const o of declined) L.push(`    ${o.domain} · declined${o.reviewedAt ? ` ${o.reviewedAt.slice(0, 10)}` : ""} · ${o.desiredState.value}`);
  return L.join("\n");
}

/** Zero records observed by Nomila ≠ zero things in the world. The value says what it means; a caption is not enough. */
export function deliverablesLine(n: number): string {
  return n > 0
    ? `Nomila holds ${n} deliverable record${n === 1 ? "" : "s"} for this deal`
    : "Nomila holds no deliverable records for this deal; actual deliverable obligations are NOT_ESTABLISHED";
}

export function renderExistingWorkBlock(w: ExistingWork, commercial?: CommercialAttachment): string {
  const L: string[] = [];
  L.push(`What is already in motion, from Nomila's own records as of ${w.asOf} (${w.version}). Facts only. A lens on subjects, not a namespace: cite each item by the reference at its left.`);
  L.push("Where Nomila holds no deliverable records for an item, its actual deliverable obligations are NOT_ESTABLISHED — zero records is not zero obligations.");
  L.push("");
  if (!w.items.length) L.push("    (nothing recorded)");
  for (const i of w.items) {
    L.push(`    ${subjectRefString(i.ref)}`);
    L.push(`        ${i.kind}${i.brand ? ` · ${i.brand}` : ""} · since ${i.since.slice(0, 10)}${i.objectiveId ? ` · toward objective[${i.objectiveId}]` : ""}${i.for?.recommendationId ? ` · executing recommendation[${i.for.recommendationId}]` : ""}${i.for?.objectiveIds?.length ? ` · for ${i.for.objectiveIds.map((o) => `objective[${o}]`).join(", ")}` : ""}`);
    L.push(`        ${i.statement}`);
    const amt = i.amount ? `amount ${i.amount.total ?? "not recorded"}${i.amount.cash != null || i.amount.product != null ? ` (cash ${i.amount.cash ?? "—"} / product ${i.amount.product ?? "—"})` : ""}` : "amount not recorded";
    L.push(`        ${amt} · term ${i.termStart ?? "not recorded"} → ${i.termEnd ?? "not recorded"} · ${deliverablesLine(i.deliverablesRecorded)}`);
    if (commercial && commercial.placement === "work" && commercial.assessment.subjectRef === subjectRefString(i.ref)) L.push(...renderAssessmentUnderWork(commercial.assessment));
    L.push("");
  }
  return L.join("\n");
}

/**
 * 0.6.0-exp — the DECISION SUBJECTS lens: things a decision was requested about that no other lens renders. Being here
 * says nothing about a thing's stage. Evidence attached to a subject (the commercial projection) renders beneath it.
 */
export function renderDecisionSubjectsBlock(subjects: SubjectItem[], commercial?: CommercialAttachment): string {
  const L: string[] = [];
  L.push("Things a decision was requested about that no other block renders. A subject is what a decision concerns; being");
  L.push("here says nothing about its stage. Cite each by the reference at its left; evidence beneath it as <reference>.<key>.");
  L.push("");
  for (const s of subjects) {
    const ref = subjectRefString(s.ref);
    L.push(`    ${ref}`);
    L.push(`        ${s.label}`);
    L.push(`        ${s.statement}`);
    for (const f of s.facts) L.push(`        ${f}`);
    if (commercial && commercial.placement === "work" && commercial.assessment.subjectRef === ref) L.push(...renderAssessmentUnderWork(commercial.assessment));
    L.push("");
  }
  return L.join("\n");
}

/** Long research prose is clipped so the block stays bounded by the brand cap, not by what a profile happens to hold. */
const BRAND_TEXT_MAX = 400;
const clipText = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > BRAND_TEXT_MAX ? `${t.slice(0, BRAND_TEXT_MAX).replace(/\s+\S*$/, "")}…` : t;
};

/**
 * 0.13.0-exp — BRAND RESEARCH: confirmed external research on brands she has a deal or a qualified inbound thread with.
 * About the brand, never about her. Each brand cited as brand[<id>]; a line Nomila does not hold is left out, not guessed.
 */
export function renderBrandResearchBlock(brands: BrandResearchItem[]): string {
  const L: string[] = [];
  L.push("External web research about brands the athlete has a deal or an inbound conversation with — confirmed to be about the");
  L.push("right company, NOT evidence about the athlete. It may say who a brand is, whom it reaches and whom it already works with.");
  L.push("Cite each by the reference at its left.");
  L.push("");
  if (!brands.length) L.push("    (none)");
  for (const b of brands) {
    L.push(`    brand[${b.id}]`);
    L.push(`        ${b.name}${b.domain ? ` · ${b.domain}` : ""} · ${b.relation === "deal" ? "the athlete has a deal with this brand" : "an inbound conversation from this brand"}${b.researchedAt ? ` · researched ${b.researchedAt.slice(0, 10)}` : ""}`);
    const kind = [b.category, b.tier].filter(Boolean).join(" · ");
    if (kind) L.push(`        ${kind}`);
    const d = clipText(b.description); if (d) L.push(`        what it is: ${d}`);
    const a = clipText(b.audience); if (a) L.push(`        whom it reaches: ${a}`);
    if (b.sports.length) L.push(`        sports it works in: ${b.sports.slice(0, 8).join(", ")}`);
    if (b.partnerships.length) L.push(`        athletes it is reported to work with: ${b.partnerships.slice(0, 8).join(", ")}`);
    L.push("");
  }
  return L.join("\n");
}

export function renderContextBlock(c: ContextBlock): string {
  const L: string[] = [];
  L.push(`Observations about the athlete's world and the world around them, ${c.window.from.slice(0, 10)} → ${c.window.to.slice(0, 10)}, assembled by ${c.assembledBy} as of ${c.asOf} (${c.version}).`);
  L.push("Each is an observation with a source, a time and a confidence. None is a verdict. Cite as ctx[<n>].");
  L.push("");
  c.items.forEach((it, n) => {
    L.push(`    ctx[${n}]`);
    L.push(`        ${it.kind} · confidence ${it.confidence} · ${it.source.title}${it.source.url ? ` · ${it.source.url}` : ""} · observed ${it.source.observedAt}`);
    L.push(`        ${it.statement}`);
    L.push("");
  });
  return L.join("\n");
}

export function renderResearchBlock(rs: ResearchBlock[]): string {
  const L: string[] = [];
  L.push("Answers to questions asked in an earlier run, persisted as evidence. Cite as research[<n>].");
  L.push("");
  rs.forEach((r, n) => {
    L.push(`    research[${n}]`);
    L.push(`        proposition: ${r.proposition}`);
    L.push(`        asked for objective ${r.requestedBy.objectiveId} in run ${r.requestedBy.run} · resolved from ${r.sourceClass} · as of ${r.asOf} (${r.version})`);
    for (const line of r.block.split("\n")) L.push(`        ${line}`);
    if (r.sources.length) L.push(`        sources: ${r.sources.map((s) => `${s.title}${s.url ? ` <${s.url}>` : ""} (${s.observedAt})`).join("; ")}`);
    L.push("");
  });
  return L.join("\n");
}

/** EXPERIMENTAL (1B.3, 1C). Who asked, the question verbatim, what it is about — for each request, in order. Nothing else. */
export function renderDecisionRequestBlock(rs: DecisionRequest[]): string {
  const L: string[] = [];
  L.push(rs.length === 1
    ? "A question posed to you by a named party about a named thing. Answer that question. Cite as request[<id>]."
    : "Questions posed to you by named parties about named things. Answer each. Cite as request[<id>].");
  for (const r of rs) {
    L.push("");
    L.push(`    request[${r.id}]`);
    L.push(`        asked by: ${r.askedBy}`);
    L.push(`        about: ${subjectRefString(r.about)}`);
    L.push(`        question: ${JSON.stringify(r.question)}`);
  }
  return L.join("\n");
}
