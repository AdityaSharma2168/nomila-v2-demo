/**
 * studio/agent/eval/sheet — the blind sheet, the key beside it, and the scoresheet to fill.
 *
 * The bake-off's pattern (server/scripts/studioVideoBakeoff.ts): every cell shuffled by a fixed seed
 * behind an opaque code, the sheet showing what the judge needs and nothing that says which
 * configuration produced it, `key.json` written beside it and never linked. Pure — the script does
 * the disk.
 *
 * ─── WHAT IS BLIND, AND WHAT IS NOT ─────────────────────────────────────────────────────────────
 *
 * The judge SEES: the brief (its id, her sentence, the objective, the feel), the library lines
 * exactly as the planner read them, and the plan — each item the way the Agent screen would label
 * it. The same brief appears once per (configuration × repeat), so the judge knows a brief recurs;
 * that is inherent and fine. The judge DOES NOT SEE which run a cell came from: no label, no prompt
 * fingerprint, no git sha, no timestamp. `SheetCell` has no field for any of those — the type is
 * the guard — and the test holds that a run label passed anywhere near a cell does not reach the HTML.
 */
import type { AgentPlan, PlanItem } from "../types";

/** The seven things a judge scores, 1–5 each — the scoresheet's columns, in order. */
export const CRITERIA = [
  "i2v_reserved",
  "stills_where_carried",
  "real_clips_used",
  "broll_earned",
  "product_rules",
  "overall_mix",
  "relevance",
] as const;
export type Criterion = (typeof CRITERIA)[number];

/**
 * The concept eval's four criteria, 1–5 each (PR 16, R-9) — FROZEN at this wording before any run
 * (ADI-24SEP R8, docs/probes/flow-eval.md):
 *   relevance     the concept answers what the brief asks for
 *   groundable    groundable in her library — judged WITH THE PLAN THAT FOLLOWS beside it, never the
 *                 concept alone (the concept step is forbidden to see her library, concepts.ts:1-18)
 *   non_generic   it could not be pasted onto any other athlete or brand
 *   distinct      different from the other concepts for the same brief
 */
export const CONCEPT_CRITERIA = [
  "relevance",
  "groundable",
  "non_generic",
  "distinct",
] as const;
export type ConceptCriterion = (typeof CONCEPT_CRITERIA)[number];

/** What each kind is called on the sheet — the Agent screen's own words (client agentLogic KIND_LABEL). */
export const KIND_LABEL: Record<PlanItem["kind"], string> = {
  i2v: "Slight movement",
  broll: "B-roll",
  image: "Held photo",
  product: "Your product",
  clip: "Your clip",
};

export interface SheetCell {
  code: string;
  briefId: string;
  prompt: string;
  objective: string;
  aesthetic?: string;
  /** The fenced library lines the planner read, verbatim (plan.ts `libraryLine`). */
  libraryLines: readonly string[];
  /** Her products' lines, if the brief picked one. */
  productLines: readonly string[];
  /** Null when the planner returned nothing usable — the sheet says so, and it is scored as such. */
  plan: AgentPlan | null;
}

/** A cell before it has a code: the same, keyed by where it came from. */
export interface RawCell extends Omit<SheetCell, "code"> {
  /** Which run and repeat — goes to the KEY, never the sheet. */
  source: { run: string; repeat: number };
}

/** The bake-off's LCG. A fixed seed means a re-sheet of the same cells keeps the same codes. */
export function shuffle<T>(list: readonly T[], seed: number): T[] {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface Keyed {
  cells: SheetCell[];
  /** code → where it came from. Written to key.json, never to the sheet. */
  key: Record<string, { run: string; briefId: string; repeat: number }>;
}

/** Shuffle and code the cells; split what the judge sees from what the key holds. */
export function assignCodes(raw: readonly RawCell[], seed = 20260922): Keyed {
  const shuffled = shuffle(raw, seed);
  const key: Keyed["key"] = {};
  const cells = shuffled.map((r, i) => {
    const code = `P${String(i + 1).padStart(2, "0")}`;
    const { source, ...cell } = r;
    key[code] = { run: source.run, briefId: r.briefId, repeat: source.repeat };
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

/** One item as a judge reads it: kind label, beat, direction, its ref and line, sound, asks. */
function itemHtml(item: PlanItem, lines: readonly string[]): string {
  const line = item.ref
    ? (lines.find((l) => l.startsWith(`${item.ref} |`)) ??
      `${item.ref} (not in the library)`)
    : null;
  const caps = item.capabilities
    ? Object.entries(item.capabilities)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ")
    : "";
  return `<li class="item ${item.kind}">
  <div class="head"><span class="kind">${esc(KIND_LABEL[item.kind])}</span>${item.ref ? ` <span class="ref">${esc(item.ref)}</span>` : ""}${item.segment !== null ? ` <span class="ref">beat [${item.segment}]</span>` : ""}${item.sound ? ` <span class="sound">sound</span>` : ""}</div>
  <div class="beat">${esc(item.beat)}</div>
  <div class="direction">${esc(item.direction)}</div>
  ${line ? `<div class="line">${esc(line)}</div>` : ""}
  ${caps ? `<div class="caps">${esc(caps)}</div>` : ""}
</li>`;
}

function cellHtml(c: SheetCell): string {
  const plan = c.plan
    ? `<ol class="plan">${c.plan.items.map((i) => itemHtml(i, c.libraryLines)).join("\n")}</ol>` +
      (c.plan.nulled.length
        ? `<div class="nulled">outside the closed lists: ${c.plan.nulled.map((n) => esc(`${n.axis}=${n.value}`)).join(", ")}</div>`
        : "") +
      (c.plan.gaps.length
        ? `<div class="gaps">Not covered, the planner says: ${c.plan.gaps.map(esc).join(" · ")}</div>`
        : "")
    : `<div class="noplan">The planner returned nothing usable.</div>`;
  return `<section class="cell" id="${c.code}">
<header><span class="code">${c.code}</span><span class="brief-id">${esc(c.briefId)}</span></header>
<div class="ask"><div class="prompt">${esc(c.prompt)}</div><div class="meta">objective: ${esc(c.objective)}${c.aesthetic ? ` · feel: ${esc(c.aesthetic)}` : ""}</div></div>
${plan}
<details><summary>Library the planner read (${c.libraryLines.length} lines${c.productLines.length ? `, ${c.productLines.length} product` : ""})</summary>
<pre>${esc(c.libraryLines.join("\n"))}${c.productLines.length ? `\n\nPRODUCTS\n${esc(c.productLines.join("\n"))}` : ""}</pre></details>
</section>`;
}

/** The whole sheet. Nothing but the cells goes in; the caller passes nothing else. */
export function renderSheet(
  cells: readonly SheetCell[],
  title = "Plan eval — blind sheet",
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  :root { --bg:#0D0B08; --fg:#F3EEE6; --dim:#9C948A; --card:#17140F; --line:#2A251E; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--fg); font:15px/1.45 -apple-system,system-ui,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } .lede { color:var(--dim); margin:0 0 24px; max-width:760px; }
  .cell { background:var(--card); border:1px solid var(--line); border-radius:28px; padding:20px; margin:0 auto 20px; max-width:760px; }
  header { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; }
  .code { font:600 18px ui-monospace,monospace; } .brief-id { color:var(--dim); font-size:13px; text-transform:uppercase; letter-spacing:.08em; }
  .prompt { font-size:17px; } .meta { color:var(--dim); font-size:13px; margin:2px 0 14px; }
  .plan { list-style:none; padding:0; margin:0; counter-reset:i; }
  .item { border-top:1px solid var(--line); padding:12px 0; counter-increment:i; }
  .item .head::before { content:counter(i) ". "; color:var(--dim); }
  .kind { font-weight:600; } .i2v .kind { color:#F2B65A; } .broll .kind { color:#8FB7F2; } .image .kind { color:#9AD79A; } .clip .kind { color:#9AD79A; } .product .kind { color:#E59AD7; }
  .ref, .sound { font:12px ui-monospace,monospace; color:var(--dim); border:1px solid var(--line); border-radius:10px; padding:1px 6px; }
  .beat { margin-top:4px; } .direction { color:var(--dim); } .line { font:12px ui-monospace,monospace; color:var(--dim); margin-top:6px; white-space:pre-wrap; }
  .caps { font-size:12px; color:var(--dim); margin-top:4px; } .nulled { font-size:12px; color:#E5A07A; margin-top:8px; }
  .noplan { color:#E5A07A; padding:12px 0; }
  .gaps { font-size:13px; color:#9AD79A; margin-top:8px; }
  details { margin-top:12px; } summary { color:var(--dim); cursor:pointer; font-size:13px; }
  pre { font:12px/1.4 ui-monospace,monospace; white-space:pre-wrap; color:var(--dim); }
</style></head><body>
<h1>${esc(title)}</h1>
<p class="lede">Each card is one plan. Score it 1–5 on each column of <code>scores.csv</code>: i2v reserved for simple animatable beats · stills held where a photo already carries the beat · real clips used as they are where they fit · b-roll only where it earns its place · product per its rules · overall mix rather than all-generation · per-shot relevance to the brief. Which configuration produced each plan is in the key, not here.</p>
${cells.map(cellHtml).join("\n")}
</body></html>
`;
}

/** The scoresheet to fill — one row per code, in sheet order, every criterion blank. */
export function scoresTemplate(
  codes: readonly string[],
  /** The columns — the plan eval's by default, so its template is byte-identical to before. */
  criteria: readonly string[] = CRITERIA,
): string {
  return (
    [
      ["code", ...criteria, "note"].join(","),
      ...codes.map((c) => [c, ...criteria.map(() => ""), ""].join(",")),
    ].join("\n") + "\n"
  );
}
