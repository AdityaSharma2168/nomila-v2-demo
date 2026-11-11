/**
 * validate.ts — runtime invariants on a composed AthleteState, invoked ON THE BUILD PATH.
 *
 * The Rate lesson, applied before it can recur: a validator that is defined and tested but never called guards
 * nothing. `buildAthleteState` calls this and REFUSES to return a state that fails it. The integration test proves
 * the call is on the path, not merely that the function works.
 *
 * These are invariants the contract promises, not opinions about the athlete:
 *   - State composes and never judges: nothing owned by `athlete_state` is EVALUATED
 *   - pipeline states are distinct counts and agree with the closed-deal count
 *   - an inbound signal is interest, never a deal: it carries a category and a thread locator, no amount
 *   - onboarding intent is labelled as what it is — a choice from a fixed set at a time — never as an assertion
 *   - audience shares are percentages; dates parse; every keyed collection is selectable
 */
import { ATHLETE_STATE_VERSION, type AthleteState } from "../contracts/athleteState";

export const INBOUND_CAP = 12;
const STANCES = new Set(["wants", "open", "avoids", "refuses"]);
const DATE_KINDS = new Set(["deal_term_end", "inbound_deadline", "affiliation_started"]);
const isIso = (s: unknown) => typeof s === "string" && !Number.isNaN(Date.parse(s));

export function validateAthleteState(s: AthleteState): string[] {
  const p: string[] = [];
  if (s.version !== ATHLETE_STATE_VERSION) p.push(`version ${s.version} != ${ATHLETE_STATE_VERSION}`);
  if (!isIso(s.asOf)) p.push("asOf is not an ISO timestamp");

  // ── composition never becomes judgment ────────────────────────────────────
  const walk = (v: unknown, path: string) => {
    if (!v || typeof v !== "object") return;
    const o = v as any;
    if (o.owner === "athlete_state" && o.evidenceClass === "EVALUATED") p.push(`${path}: athlete_state may not emit EVALUATED`);
    for (const [k, x] of Object.entries(o)) if (x && typeof x === "object") walk(x, `${path}.${k}`);
  };
  walk(s, "state");

  for (const f of s.findings) {
    if (f.basis.owner !== "marketability") p.push(`findings[${f.key}].basis owned by ${f.basis.owner}, expected marketability`);
    if (!f.evidence.length) p.push(`findings[${f.key}] has no evidence pointer`);
  }

  // ── commercial position: pipeline states are distinct and agree ──────────
  const cp = s.commercialPosition;
  const pl = cp.pipeline.value;
  for (const [k, n] of Object.entries(pl)) if (!Number.isInteger(n) || (n as number) < 0) p.push(`pipeline.${k} is not a non-negative integer`);
  if (cp.closedDeals.value !== pl.accepted + pl.completed) p.push(`closedDeals ${cp.closedDeals.value} != accepted+completed ${pl.accepted + pl.completed}`);
  if (cp.inbound.length > INBOUND_CAP) p.push(`inbound has ${cp.inbound.length} entries; cap is ${INBOUND_CAP}`);
  cp.inbound.forEach((i, n) => {
    if (!i.category) p.push(`inbound[${n}] has no category`);
    if (i.evidence.source !== "inbox" || !i.evidence.locator) p.push(`inbound[${n}] must cite an inbox thread`);
    if ("amount" in (i as any)) p.push(`inbound[${n}] carries an amount — inbound interest is never a deal`);
    if (i.deadline !== null && !isIso(i.deadline)) p.push(`inbound[${n}].deadline is not a date`);
  });

  // ── intent is labelled as what it is ──────────────────────────────────────
  s.preferences.forEach((pr, n) => {
    if (!STANCES.has(pr.stance)) p.push(`preferences[${n}] stance invalid: ${pr.stance}`);
    if (!pr.source?.locator) p.push(`preferences[${n}] has no source`);
    if (pr.source.source === "onboarding" && pr.recordedAs?.method !== "onboarding_v1_choice") {
      p.push(`preferences[${n}] comes from onboarding but is not labelled onboarding_v1_choice — a fixed-set choice must not read as a conversational assertion`);
    }
  });
  const subjects = s.preferences.map((x) => x.subject);
  if (new Set(subjects).size !== subjects.length) p.push("preferences have duplicate subjects — the keyed citation would be ambiguous");

  // ── audience, content, representation, dates ──────────────────────────────
  const plats = s.audience.map((a) => a.platform);
  if (new Set(plats).size !== plats.length) p.push("audience has duplicate platforms");
  for (const a of s.audience) {
    for (const [lab, b] of [["topCountry", a.topCountry], ["topAge", a.topAge]] as const) {
      if (b && !(b.pct >= 0 && b.pct <= 100)) p.push(`audience[${a.platform}].${lab}.pct out of range: ${b.pct}`);
    }
    for (const g of a.gender ?? []) if (!(g.pct >= 0 && g.pct <= 100)) p.push(`audience[${a.platform}].gender pct out of range`);
    if (!isIso(a.asOf)) p.push(`audience[${a.platform}].asOf is not a date`);
  }
  const cplats = s.contentPerformance.map((c) => c.platform);
  if (new Set(cplats).size !== cplats.length) p.push("contentPerformance has duplicate platforms");
  if (s.representation) {
    const keys = s.representation.floors.map((f) => f.key);
    if (new Set(keys).size !== keys.length) p.push("representation.floors has duplicate keys");
    for (const f of s.representation.floors) if (!(f.amount > 0)) p.push(`representation.floors[${f.key}] is not a positive amount`);
  }
  s.dates.forEach((d, n) => {
    if (!DATE_KINDS.has(d.kind)) p.push(`dates[${n}] kind invalid: ${d.kind}`);
    if (!isIso(d.date)) p.push(`dates[${n}] is not a date: ${d.date}`);
    if (!d.subject) p.push(`dates[${n}] has no subject`);
  });
  return p;
}
