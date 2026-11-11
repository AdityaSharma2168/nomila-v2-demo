/**
 * grounding.ts — does a cited state path actually exist in the state that was supplied?
 *
 * The structural validator in `evalSpec.ts` proves a citation is WELL-FORMED: non-empty `state_path`, non-empty
 * `how`. It cannot prove the path RESOLVES, so an evaluator returning `preferences[future_media_goal]` for an
 * athlete who has stated nothing passes structural validation intact.
 *
 * That gap matters because of the claim the contract makes: `rests_on` is what separates an opportunity from an
 * invention. A citation nobody checks separates nothing. This is the same failure shape as Rate's
 * `validateRateResponse` — written, tested, imported, never called — except worse, because here the guard would
 * have been *called* and still proved nothing.
 *
 * AN EXPLICIT GRAMMAR, NOT A PATH LIBRARY. Arbitrary path evaluation over model output is an injection surface and
 * an accident waiting to happen: `constructor.prototype`, getters with side effects, prototype walking. This
 * resolver understands exactly the forms Athlete State deliberately exposes and refuses everything else.
 *
 *   audienceTrajectory                          a top-level field
 *   identity.sport                              a dotted field
 *   commercialPosition.demonstratedEconomics    a nested field
 *   findings[mia.narrative_power]               a keyed collection, selected by its own key
 *   preferences[avoids_coaching]                keyed by `subject`
 *   constraints[availability_window]            keyed by `key`
 *   materialGaps[0]                             a positional index
 *   findings[mia.audience_scale].direction      a field of a selected element
 *
 * RESOLUTION IS EXISTENCE, NOT TRUTH. A MISSING trajectory resolves: the athlete has one, and it says we cannot
 * see it. Resting an evidence-domain opportunity on exactly that is correct reasoning, and rejecting the citation
 * because its value is null would punish the most honest thing the evaluator can do.
 */
import type { AthleteState } from "../contracts/athleteState";

/** How a keyed collection in AthleteState is selected. Anything not listed is positional or not selectable. */
const KEYED_BY: Record<string, string> = {
  findings: "key",
  preferences: "subject",
  constraints: "key",
  // athlete-state/1.2.0 — per-platform collections and stated floors. `inbound` and `dates` stay positional.
  // athlete-state/1.3.0 — `athleteNotes` is positional; contract exclusivity is a `constraints` key.
  audience: "platform",
  contentPerformance: "platform",
  floors: "key",
};

/** Never traversed, whatever a model asks for. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export type Resolution =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `a.b[c].d` → [{name:"a"}, {name:"b", selector:"c"}, {name:"d"}]. Returns null on a malformed path. */
export function parseStatePath(path: string): Array<{ name: string; selector?: string }> | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const out: Array<{ name: string; selector?: string }> = [];
  for (const raw of path.trim().split(".")) {
    // A dotted selector — findings[mia.narrative_power] — splits across segments, so reassemble below.
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?$/.exec(raw);
    if (m) {
      if (FORBIDDEN.has(m[1]!)) return null;
      out.push(m[2] === undefined ? { name: m[1]! } : { name: m[1]!, selector: m[2] });
      continue;
    }
    // Continuation of a selector that contained a dot: "findings[mia" ... "narrative_power]".
    const open = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)$/.exec(raw);
    if (open) {
      if (FORBIDDEN.has(open[1]!)) return null;
      out.push({ name: open[1]!, selector: `${open[2]!}.` });
      continue;
    }
    const last = out[out.length - 1];
    if (last && typeof last.selector === "string" && last.selector.endsWith(".")) {
      const close = /^([^\]]*)\]$/.exec(raw);
      if (close) { last.selector = last.selector + close[1]!; continue; }
      if (!/[[\]]/.test(raw)) { last.selector = `${last.selector + raw}.`; continue; }
    }
    return null;
  }
  // An unterminated selector is malformed, not a lenient match.
  if (out.some((s) => typeof s.selector === "string" && s.selector.endsWith("."))) return null;
  return out;
}

/** Resolve a cited path against one AthleteState. */
export function resolveStatePath(state: AthleteState, path: string): Resolution {
  const segments = parseStatePath(path);
  if (!segments) return { ok: false, reason: `malformed path: ${JSON.stringify(path)}` };

  let cur: unknown = state;
  const walked: string[] = [];

  for (const seg of segments) {
    if (!isPlain(cur) && !Array.isArray(cur)) {
      return { ok: false, reason: `"${walked.join(".") || "<root>"}" is not traversable` };
    }
    if (!Object.prototype.hasOwnProperty.call(cur as object, seg.name)) {
      return { ok: false, reason: `no such field "${[...walked, seg.name].join(".")}" in the athlete state` };
    }
    cur = (cur as Record<string, unknown>)[seg.name];
    walked.push(seg.name);

    if (seg.selector === undefined) continue;

    if (!Array.isArray(cur)) {
      return { ok: false, reason: `"${walked.join(".")}" is not a collection, so [${seg.selector}] cannot select from it` };
    }
    const keyField = KEYED_BY[seg.name];
    if (keyField) {
      const hit = cur.find((el) => isPlain(el) && el[keyField] === seg.selector);
      if (hit === undefined) {
        const available = cur.filter(isPlain).map((el) => String(el[keyField])).slice(0, 12);
        return {
          ok: false,
          reason: `"${walked.join(".")}[${seg.selector}]" is not in the athlete state`
            + (available.length ? ` (present: ${available.join(", ")})` : " (the collection is empty)"),
        };
      }
      cur = hit;
      continue;
    }
    // Positional. A non-integer index into a plain array is malformed rather than merely absent.
    if (!/^\d+$/.test(seg.selector)) {
      return { ok: false, reason: `"${walked.join(".")}" is indexed positionally; [${seg.selector}] is not an index` };
    }
    const i = Number(seg.selector);
    if (i >= cur.length) {
      return { ok: false, reason: `"${walked.join(".")}[${i}]" is out of range — ${cur.length} present` };
    }
    cur = cur[i];
  }
  return { ok: true, value: cur };
}

export interface GroundingProblem {
  index: number;
  key: string | null;
  statePath: string;
  reason: string;
}

/**
 * Check every citation in a response against the exact state the evaluator was given.
 *
 * Returns problems rather than throwing, so a caller records the whole picture instead of the first failure — the
 * same reason `validateRateResponse` reports every malformed estimate at once.
 */
/** 1.1.0: what was actually supplied beside the state, so a support citation resolves against it — by count, never by content. */
export interface SupportSupplied { contextItems: number; researchBlocks: number }
const SUPPORT = /^(ctx|research)\[(\d+)\]$/;

export function validateGrounding(state: AthleteState, body: unknown, supplied: SupportSupplied = { contextItems: 0, researchBlocks: 0 }): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  const opportunities = (body as any)?.opportunities;
  if (!Array.isArray(opportunities)) return problems; // structural validation owns this failure

  opportunities.forEach((o: any, index: number) => {
    const key = typeof o?.key === "string" ? o.key : null;
    const rests = Array.isArray(o?.rests_on) ? o.rests_on : [];
    for (const r of rests) {
      const statePath = typeof r?.state_path === "string" ? r.state_path : "";
      if (!statePath) continue; // structural validation owns this failure
      const res = resolveStatePath(state, statePath);
      if (!res.ok) problems.push({ index, key, statePath, reason: res.reason });
    }
    // supported_by: ctx[<n>] must index an item of the CONTEXT block supplied; research[<n>] a block supplied.
    // Recorded under `statePath` for the diagnostic table (the field is the citation, whatever its form).
    const support = Array.isArray(o?.supported_by) ? o.supported_by : [];
    for (const s of support) {
      const ref = typeof s?.ref === "string" ? s.ref.trim() : "";
      const m = SUPPORT.exec(ref);
      if (!m) continue; // structural validation owns this failure
      const n = Number(m[2]);
      if (m[1] === "ctx") {
        if (supplied.contextItems === 0) problems.push({ index, key, statePath: ref, reason: "no CONTEXT was supplied" });
        else if (n >= supplied.contextItems) problems.push({ index, key, statePath: ref, reason: `context has ${supplied.contextItems} item(s); ctx[${n}] does not exist` });
      } else {
        if (supplied.researchBlocks === 0) problems.push({ index, key, statePath: ref, reason: "no RESPONSIVE EVIDENCE was supplied" });
        else if (n >= supplied.researchBlocks) problems.push({ index, key, statePath: ref, reason: `${supplied.researchBlocks} research block(s) supplied; research[${n}] does not exist` });
      }
    }
  });
  return problems;
}

/** One line per problem, for a run log. */
export function formatGroundingProblems(problems: GroundingProblem[]): string[] {
  return problems.map((p) => `opportunities[${p.index}]${p.key ? ` (${p.key})` : ""}: ${p.reason}`);
}
