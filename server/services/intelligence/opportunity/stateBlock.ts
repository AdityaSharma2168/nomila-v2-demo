/**
 * stateBlock.ts — render an AthleteState for the evaluator.
 *
 * Evidence, not methodology: excluded from the canonical digest, because an athlete's state changes constantly and
 * hashing it would make the pin meaningless.
 *
 * THE BLOCK SHOWS ITS OWN CITATION PATHS. Every citable line is prefixed with the exact `state_path` that resolves
 * to it. This is not decoration — the evaluator is required to cite state and its citations are then checked against
 * that state, so asking it to guess a schema it cannot see would manufacture grounding failures that are our fault
 * rather than its. Showing the path makes the requirement answerable.
 *
 * ABSENCE IS RENDERED, NOT OMITTED. A missing trajectory, an empty constraint list and a zero deal count all appear
 * explicitly. An evaluator that cannot see what is absent will reason as though it were merely unmentioned, and the
 * evidence domain — often the most honest output available — depends on absence being visible and citable.
 */
import type { AthleteState, StateFinding } from "../contracts/athleteState";
import { citationStrength, type LedgerEvidenceCitation } from "../contracts/intelligenceLedger";

const val = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    const o = v as any;
    if (o.evidenceClass === "MISSING") return `not known (${o.reason ?? "no reason recorded"})`;
    if (o.evidenceClass === "MEASURED") return `${JSON.stringify(o.value)}  [measured · ${o.confidence} confidence]`;
    return JSON.stringify(o.value ?? o);
  }
  return String(v);
};

/**
 * A citable path, padded, with the separator GUARANTEED. A path longer than the pad used to run straight into its
 * value (`preferences[onboarding_goal.grow_my_following]WANTS`), which made the line unparseable for anything reading
 * the path back and let the evaluator copy the run-together casing.
 */
export const STANCES_TEXT = "  A stance is one of: wants | open | avoids | refuses — cite it in exactly that spelling.";
const CITE_PAD = 46;
const cite = (path: string): string => (path.length + 2 > CITE_PAD ? `${path}  ` : path.padEnd(CITE_PAD));

/** How a cited source's retrieval was established, by strength (absent lineage on older rows: nothing is shown). */
function lineageTag(e: LedgerEvidenceCitation): string {
  switch (citationStrength(e)) {
    case "grounded": return "  [retrieved · grounded]";
    case "site_only": return "  [weaker lineage: site retrieved, page unproven]";
    case "nomila_supplied": return "  [Nomila-supplied platform data]";
    case "not_support": return `  [${e.lineage?.level ?? "not retrieved"}]`;
    default: return "";
  }
}

const citationLine = (e: LedgerEvidenceCitation): string =>
  `          ${e.id}  ${e.sourceType ?? "source"}${e.observedAt ? ` · ${e.observedAt}` : ""}${lineageTag(e)}  ${e.claim}`;

/** Wrap prose so a long rationale stays legible in a fixed-width block. */
function wrap(text: string, width: number): string[] {
  const words = String(text).split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

function findingLine(f: StateFinding): string {
  const score = f.basis.evidenceClass === "MEASURED" ? String(f.basis.value) : "not scored";
  const conf = f.basis.evidenceClass === "MEASURED" ? f.basis.confidence : "—";
  const imp = f.imputedShare ? `${f.imputedShare.imputed}/${f.imputedShare.total} signals imputed` : "imputation not reported";
  return cite(`    findings[${f.key}]`) + `${f.direction.toUpperCase().padEnd(9)} score ${String(score).padEnd(7)} ${conf.padEnd(7)} ${imp}`;
}

export function renderStateBlock(s: AthleteState): string {
  const L: string[] = [];

  L.push(`Nomila's account of this athlete as of ${s.asOf} (${s.version}).`);
  L.push(`Overall confidence in this picture: ${s.overallConfidence}.`);
  L.push("");
  L.push("Cite any line below by the path shown at its left.");
  L.push("");

  L.push("IDENTITY");
  L.push(cite(`    identity.name`) + s.identity.name);
  L.push(cite(`    identity.sport`) + (s.identity.sport ?? "not recorded"));
  L.push(cite(`    identity.competitionContext`) + (s.identity.competitionContext ?? "not recorded"));
  L.push(cite(`    identity.careerStatus`) + (s.identity.careerStatus ?? "not recorded"));

  L.push("");
  L.push("FINDINGS — marketability dimensions, each judged by M.I.A. and read here unchanged.");
  L.push("  STRENGTH  measured, above the band");
  L.push("  GAP       measured, below the band");
  L.push("  NEUTRAL   MEASURED and unremarkable. We know; it is simply ordinary. This is NOT missing evidence.");
  L.push("  UNKNOWN   evidence is genuinely insufficient — no score, or mostly imputed signals. A statement about");
  L.push("            what Nomila has measured, never about the athlete.");
  L.push("");
  L.push("  Each finding may carry WHY M.I.A. concluded it and WHICH SOURCES it relied on. Read those as the");
  L.push("  evaluator's interpretation and the evidence behind it — NOT as established fact about the athlete.");
  if (s.findings.length) {
    for (const f of s.findings) {
      L.push("");
      L.push(findingLine(f));
      if (f.rationale) {
        L.push(`        WHY M.I.A. CONCLUDED THIS (M.I.A.'s evaluation, not established fact)`);
        for (const line of wrap(f.rationale.value, 96)) L.push(`          ${line}`);
        if (f.confidenceReason) L.push(`          confidence ${f.rationale.confidence} — ${f.confidenceReason}`);
      }
      if (f.citedEvidence?.length) {
        L.push(`        SOURCE EVIDENCE M.I.A. CITED`);
        for (const e of f.citedEvidence) {
          L.push(citationLine(e));
          if (e.sourceUrl) L.push(`              ${e.sourceUrl}`);
        }
      }
      // WEAKER than the list above, and said so: the site was retrieved, the page never proven.
      if (f.siteOnlyCitations?.length) {
        L.push(`        WEAKER LINEAGE — site retrieved, page unproven (not equal to the sources above)`);
        for (const e of f.siteOnlyCitations) {
          L.push(citationLine(e));
          if (e.sourceUrl) L.push(`              ${e.sourceUrl}`);
        }
      }
      if (f.nomilaSuppliedCitations?.length) {
        L.push(`        NOMILA-SUPPLIED DATA M.I.A. CITED`);
        for (const e of f.nomilaSuppliedCitations) L.push(citationLine(e));
      }
      // Cited, but the provider's grounding shows no retrieval behind it. Named so the absence is visible; never
      // listed as support, and no URL — a model-written URL is exactly what must not read as a source.
      if (f.unsupportedCitations?.length) {
        L.push(`        CITED BY M.I.A. BUT NOT RETRIEVED — the evaluator's own assertion, NOT supporting evidence`);
        for (const e of f.unsupportedCitations) L.push(`          ${e.id}  [${e.lineage?.level ?? "not retrieved"}]  ${e.claim}`);
      }
      if (f.danglingEvidence?.length) {
        L.push(`        CITED EVIDENCE IDS THAT DO NOT EXIST — not support: ${f.danglingEvidence.join(", ")}`);
      }
      if (f.components?.length) {
        const parts = f.components
          .map((c) => `${c.key.split(".").pop()}=${c.value ?? "—"} [${c.evidenceClass}]`)
          .join("  ");
        L.push(`        COMPONENTS  ${parts}`);
      }
    }
  } else L.push("    (no marketability assessment is recorded for this athlete)");

  L.push("");
  L.push("AUDIENCE TRAJECTORY — follower growth only. It says nothing about athletic or commercial direction.");
  L.push(cite(`    audienceTrajectory`) + val(s.audienceTrajectory));

  L.push("");
  L.push("COMMERCIAL POSITION — what the market has actually paid. Counted, never estimated.");
  L.push(cite(`    commercialPosition.closedDeals`) + val(s.commercialPosition.closedDeals));
  L.push(cite(`    commercialPosition.activeRelationships`) + val(s.commercialPosition.activeRelationships));
  L.push(cite(`    commercialPosition.demonstratedEconomics`) + val(s.commercialPosition.demonstratedEconomics));
  if (s.commercialPosition.cashShare) L.push(cite(`    commercialPosition.cashShare`) + val(s.commercialPosition.cashShare));
  L.push(cite(`    commercialPosition.pricingEvidence`) + s.commercialPosition.pricingEvidence);
  const pl = s.commercialPosition.pipeline.value;
  L.push("");
  L.push("COMMERCIAL PIPELINE — counts by state. `detected` means a brand made contact and nothing more.");
  L.push("  Inbound interest is NOT a deal, NOT revenue and NOT an active relationship.");
  L.push(cite(`    commercialPosition.pipeline`)
    + `detected ${pl.detected} · negotiating ${pl.negotiating} · rejected ${pl.rejected} · accepted ${pl.accepted} · completed ${pl.completed}`);

  L.push("");
  L.push("INBOUND SIGNALS — the athlete's own classified inbox, most recent first, capped. Demonstrated interest,");
  L.push("  as classified by Nomila's inbox pipeline. A category is the classifier's label, not a commitment.");
  if (s.commercialPosition.inbound.length) {
    s.commercialPosition.inbound.forEach((i, n) => {
      L.push(cite(`    commercialPosition.inbound[${n}]`)
        + `${i.category.padEnd(10)} ${i.counterparty ?? "counterparty unknown"} · ${i.lastMessageAt.slice(0, 10)}`
        + `${i.deadline ? ` · deadline ${i.deadline}` : ""}${i.threadStatus ? ` · ${i.threadStatus}` : ""}`);
    });
  } else L.push("    (no classified inbound threads)");

  L.push("");
  L.push("CONSTRAINTS — only what has been explicitly recorded as a bound on what the athlete can do.");
  L.push("  An empty list means Nomila has recorded none. It does NOT mean none exist.");
  if (s.constraints.length) for (const c of s.constraints) L.push(cite(`    constraints[${c.key}]`) + `${c.kind}: ${val(c.basis)}`);
  else L.push("    (none recorded)");

  L.push("");
  L.push("AUDIENCE — composition per platform, latest observation. Top buckets only.");
  if (s.audience.length) {
    for (const a of s.audience) {
      const parts = [
        `followers ${val(a.followers)}`,
        a.topCountry ? `top country ${a.topCountry.bucket} ${a.topCountry.pct}%` : null,
        a.topAge ? `top age ${a.topAge.bucket} ${a.topAge.pct}%` : null,
        a.gender?.length ? `gender ${a.gender.map((g) => `${g.bucket} ${g.pct}%`).join(" / ")}` : null,
      ].filter(Boolean).join(" · ");
      L.push(cite(`    audience[${a.platform}]`) + `${parts} · observed ${a.asOf.slice(0, 10)}`);
    }
  } else L.push("    (no audience composition is recorded on any platform)");

  L.push("");
  L.push("CONTENT PERFORMANCE — cadence and format, per platform, from Nomila's own measurement.");
  if (s.contentPerformance.length) {
    for (const c of s.contentPerformance) {
      const parts = [
        c.postsPerWeek !== undefined ? `${c.postsPerWeek} posts/week` : null,
        c.daysSinceLastPost !== undefined ? `${c.daysSinceLastPost} days since last post` : null,
        c.formatMix !== undefined ? `format mix ${JSON.stringify(c.formatMix)}` : null,
        c.reachMedianByFormat !== undefined ? `median reach by format ${JSON.stringify(c.reachMedianByFormat)}` : null,
        c.topDecileShare !== undefined ? `top-decile share ${c.topDecileShare}` : null,
        c.breakoutRate !== undefined ? `breakout rate ${c.breakoutRate}` : null,
      ].filter(Boolean).join(" · ");
      L.push(cite(`    contentPerformance[${c.platform}]`) + `${parts} · as of ${c.asOf.slice(0, 10)}`);
    }
  } else L.push("    (no content performance is measured on any platform)");

  L.push("");
  L.push("REPRESENTATION & FLOORS — as the athlete stated them. A FLOOR IS NOT A MARKET VALUE; it is the least");
  L.push("  the athlete has said they would accept.");
  if (s.representation) {
    L.push(cite(`    representation.agent`) + (s.representation.agent ?? "none stated"));
    L.push(cite(`    representation.agency`) + (s.representation.agency ?? "none stated"));
    if (s.representation.floors.length) {
      for (const f of s.representation.floors) L.push(cite(`    representation.floors[${f.key}]`) + `USD ${f.amount}`);
    } else L.push(cite(`    representation.floors`) + "(none stated)");
  } else L.push("    (the athlete has stated nothing about representation or floors)");

  L.push("");
  L.push("WHAT THE ATHLETE HAS SAID — their own words. A refusal bears on an opportunity; an ambition can generate one.");
  L.push("  Never infer a preference or an ambition that is not listed here.");
  L.push(STANCES_TEXT);
  L.push("  A line marked ONBOARDING CHOICE was selected from a fixed set when the athlete joined. It is evidence of");
  L.push("  intent at that time — the athlete actually chose it — and it is NOT a current strategic objective.");
  if (s.preferences.length) {
    for (const p of s.preferences) {
      const how = p.recordedAs?.method === "onboarding_v1_choice"
        ? `  [ONBOARDING CHOICE${p.recordedAs.at ? ` · ${p.recordedAs.at.slice(0, 10)}` : ""}]` : "";
      L.push(cite(`    preferences[${p.subject}]`) + `${p.stance}${p.note ? ` — "${p.note}"` : ""}${how}`);
    }
  } else L.push("    (the athlete has stated nothing)");
  // 1.3.0: her free notes, verbatim. Rendered only when she has given one, so an athlete without notes reads as before.
  const notes = s.athleteNotes ?? [];
  if (notes.length) {
    L.push("  Notes the athlete gave in their own words (verbatim; not a preference or a constraint unless they said so):");
    notes.forEach((n, i) => L.push(cite(`    athleteNotes[${i}]`) + `"${n.text}"${n.said ? ` (the athlete said: "${n.said}")` : ""}`));
  }
  // 1.4.0: her direction, verbatim. Rendered only when she has given one, so an athlete without it reads as before.
  if (s.athleteDirection) {
    const d = s.athleteDirection;
    L.push("  HER DIRECTION — how the athlete wants to be understood. Theirs and current; context for your reasoning. It is not a fact,");
    L.push("  not a finding, not a want and not a goal: it does not by itself create anything.");
    L.push(cite("    athleteDirection") + `"${d.statement}"${d.said ? ` (the athlete said: "${d.said}")` : ""}  [said ${d.source.asOf.slice(0, 10)}]`);
  }

  L.push("");
  L.push("DATES — recorded real-world dates that can bear on strategy, each with what it means. Only what is");
  L.push("  populated; an empty list means none are recorded, not that none exist.");
  if (s.dates.length) {
    s.dates.forEach((d, n) => L.push(cite(`    dates[${n}]`) + `${d.date}  ${d.kind.replace(/_/g, " ")} — ${d.subject}`));
  } else L.push("    (none recorded)");

  L.push("");
  L.push("WHAT NOMILA CANNOT SEE — evidence we looked for and could not find. A research task, not a caveat.");
  if (s.materialGaps.length) s.materialGaps.forEach((g, i) => L.push(cite(`    materialGaps[${i}]`) + g));
  else L.push("    (none recorded)");

  L.push("");
  L.push("SOURCES CONSULTED");
  for (const src of s.sources) L.push(`    ${src.owner.padEnd(24)} ${src.present ? "present" : "ABSENT"}${src.asOf ? ` · as of ${src.asOf}` : ""}`);

  return L.join("\n");
}
