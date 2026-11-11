/**
 * studio/agent/eval/conceptSheet — the CONCEPT blind sheet (PR 16, R-9): Concept[] per brief behind
 * opaque codes, seed-shuffled, the plan that followed beside them (the `groundable` criterion is judged
 * against it, ADI-24SEP R8), and `key.json` written beside it and never linked. Pure — the runner does
 * the disk.
 *
 * ─── WHAT IS BLIND ──────────────────────────────────────────────────────────────────────────────────
 * The judge SEES the brief (its id, her sentence, the objective, the feel), the concepts, which one was
 * planned, and that plan's items. The judge DOES NOT SEE which run a cell came from, the model, a prompt
 * fingerprint, a git sha or a timestamp. `ConceptCell` has no field for any of those — the type is the
 * guard — and `source` (run, repeat, model) goes to the KEY only.
 * ⚠️ MUTATIONS (conceptSheet.test): render `source` into a cell — "the concept sheet reveals the run
 * label" and "a judge sees the model name" red by name; drop the shuffle — "not shuffled" reds.
 */
import { CONCEPT_CRITERIA, shuffle, type ConceptCriterion } from "./sheet";
import { aggregate, type Aggregate } from "./metrics";
import { parseScoresFor } from "./reveal";

export interface SheetConcept {
  id: string;
  angle: string;
  feeling: string;
  line: string;
}

export interface ConceptCell {
  code: string;
  briefId: string;
  prompt: string;
  objective: string;
  aesthetic?: string;
  concepts: SheetConcept[];
  /** The concept the plan was made with (the runner picks A), or null when the plan step failed. */
  planned: string | null;
  /** That plan's items as she would read them — kind, beat, direction — or null. */
  plan: { kind: string; beat: string; direction: string }[] | null;
}

export interface RawConceptCell extends Omit<ConceptCell, "code"> {
  /** Where it came from — KEY ONLY, never the sheet. */
  source: { run: string; repeat: number; model: string };
}

export interface ConceptKeyed {
  cells: ConceptCell[];
  key: Record<
    string,
    { run: string; briefId: string; repeat: number; model: string }
  >;
}

/** Shuffle by a fixed seed and code the cells; split what the judge sees from what the key holds. */
export function assignConceptCodes(
  raw: readonly RawConceptCell[],
  seed = 20260924,
): ConceptKeyed {
  const key: ConceptKeyed["key"] = {};
  const cells = shuffle(raw, seed).map((r, i) => {
    const code = `C${String(i + 1).padStart(2, "0")}`;
    const { source, ...cell } = r;
    key[code] = {
      run: source.run,
      briefId: r.briefId,
      repeat: source.repeat,
      model: source.model,
    };
    return { code, ...cell };
  });
  return { cells, key };
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function cellHtml(c: ConceptCell): string {
  const concepts = c.concepts
    .map(
      (k) =>
        `<li class="concept${k.id === c.planned ? " planned" : ""}"><span class="cid">${esc(k.id)}</span> <b>${esc(k.angle)}</b> · ${esc(k.feeling)}<div class="line">${esc(k.line)}</div>${k.id === c.planned ? `<div class="tag">planned below</div>` : ""}</li>`,
    )
    .join("\n");
  const plan = c.plan
    ? `<ol class="plan">${c.plan.map((i) => `<li><span class="kind">${esc(i.kind)}</span> ${esc(i.beat)}<div class="dir">${esc(i.direction)}</div></li>`).join("")}</ol>`
    : `<div class="noplan">No plan came back for this cell.</div>`;
  return `<section class="cell" id="${c.code}">
<header><span class="code">${c.code}</span><span class="brief-id">${esc(c.briefId)}</span></header>
<div class="ask"><div class="prompt">${esc(c.prompt)}</div><div class="meta">objective: ${esc(c.objective)}${c.aesthetic ? ` · feel: ${esc(c.aesthetic)}` : ""}</div></div>
<ol class="concepts">${concepts}</ol>
<details open><summary>The plan made from the planned concept (judge "groundable" against this)</summary>${plan}</details>
</section>`;
}

/** The whole sheet. Nothing but the cells goes in. */
export function renderConceptSheet(
  cells: readonly ConceptCell[],
  title = "Concept eval — blind sheet",
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  :root { --bg:#0D0B08; --fg:#F3EEE6; --dim:#9C948A; --card:#17140F; --line:#2A251E; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--fg); font:15px/1.45 -apple-system,system-ui,sans-serif; }
  .cell { background:var(--card); border:1px solid var(--line); border-radius:28px; padding:20px; margin:0 auto 20px; max-width:760px; }
  header { display:flex; justify-content:space-between; } .code { font:600 18px ui-monospace,monospace; } .brief-id { color:var(--dim); font-size:13px; }
  .meta, .dir, .line, summary { color:var(--dim); } .concepts, .plan { padding-left:18px; } .planned { outline:1px solid var(--line); border-radius:10px; padding:4px; }
  .cid, .kind { font:12px ui-monospace,monospace; color:var(--dim); } .tag { font-size:12px; color:#9AD79A; }
</style></head><body>
<h1>${esc(title)}</h1>
<p>Score each card 1–5 on each column of <code>scores.csv</code>: relevance to the brief · groundable in her library (judged against the plan shown) · non-generic · distinct within the card's set. Which configuration produced each card is in the key, not here.</p>
${cells.map(cellHtml).join("\n")}
</body></html>
`;
}

/** The middle value (the mean of the middle two on an even count), or null with no scores. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Per run, per criterion — the judge's scores pooled, with the median P-concept is registered in. */
export function revealConcepts(input: {
  key: ConceptKeyed["key"];
  scoresCsv: string;
}): {
  run: string;
  cells: number;
  /** P-concept is registered in MEDIANS (docs/probes/flow-eval.md §5, R8): the median rides beside the aggregate. */
  criteria: Record<ConceptCriterion, Aggregate & { median: number | null }>;
}[] {
  const rows = parseScoresFor(input.scoresCsv, CONCEPT_CRITERIA);
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const runs = [...new Set(Object.values(input.key).map((k) => k.run))].sort();
  return runs.map((run) => {
    const codes = Object.entries(input.key)
      .filter(([, k]) => k.run === run)
      .map(([c]) => c);
    const criteria = Object.fromEntries(
      CONCEPT_CRITERIA.map((c) => {
        const vals = codes
          .map((code) => byCode.get(code)?.scores[c])
          .filter((v): v is number => v !== undefined);
        return [c, { ...aggregate(vals), median: median(vals) }];
      }),
    ) as Record<ConceptCriterion, Aggregate & { median: number | null }>;
    return { run, cells: codes.length, criteria };
  });
}

// ─── The deterministic half of distinctness (pre-registered in plan-eval.md: < 0.5 Jaccard) ───────

const STOP = new Set([
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "their",
  "them",
  "they",
  "then",
  "than",
  "what",
  "when",
  "each",
  "just",
  "over",
  "about",
  "before",
  "after",
  "every",
  "while",
  "being",
]);
const words = (t: string) =>
  new Set(
    (t.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !STOP.has(w)),
  );
/** |A∩B| / |A∪B| of two lines' words — studioPlanRoute.ts's own measure, pure. */
export function jaccard(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  const union = new Set([...x, ...y]).size;
  return union ? inter / union : 0;
}
/** The share of within-brief concept pairs under the 0.5 bar (P-concept: ≥ 80%). */
export function distinctShare(sets: readonly SheetConcept[][]): {
  pairs: number;
  under: number;
} {
  let pairs = 0;
  let under = 0;
  for (const set of sets)
    for (let i = 0; i < set.length; i++)
      for (let j = i + 1; j < set.length; j++) {
        pairs++;
        if (jaccard(set[i].line, set[j].line) < 0.5) under++;
      }
  return { pairs, under };
}
