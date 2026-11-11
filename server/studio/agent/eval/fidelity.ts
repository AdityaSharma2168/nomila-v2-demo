/**
 * studio/agent/eval/fidelity — BRIEF FIDELITY, the deterministic half (PR 16, R-10): does the plan and
 * the prompts it compiled honour what she confirmed? Asserted in code, never judged:
 *
 *   constraints  every confirmed constraint is in every prompt that should carry it, AND is not
 *                contradicted there: a "do not X" beside an X is a FAILURE, not a pass
 *   output       the confirmed output type, and aspect, are what the prompts were compiled for
 *   product      the confirmed product line is carried by at least one prompt
 *   tone         every confirmed tone word is carried by at least one prompt
 *
 * The judged half (is the concept's angle traceable in the plan) goes on the blind sheet, never here.
 * ⚠️ MUTATION (fidelity.test): skip the contradiction check — "a constraint present in the prompt but
 * contradicted passes fidelity" reds by name.
 */

export interface FidelityPrompt {
  /** What the prompt is: a clip (video) or an image (generate or edit). */
  kind: "video" | "image";
  /** The template it was compiled with, when known — the bridge carries constraints only. */
  template?: string;
  aspectRatio?: string | null;
  text: string;
}

export interface FidelityBrief {
  constraints: readonly string[];
  output: { type: string | null; aspect_ratio: string | null };
  productLine: string | null;
  tone: readonly string[];
}

export interface FidelityCheck {
  check: "constraints" | "output" | "product" | "tone";
  pass: boolean;
  /** Why it failed, one line per failure — empty on a pass. */
  why: string[];
}

const low = (s: string) => s.toLowerCase();

/**
 * What a "do not" forbids, as words: "do not show ZQ040 any stopwatch" → ["stopwatch"]; the last content
 * word of the clause, which is the thing. Null for a constraint that is not a "do not".
 */
export function forbidden(constraint: string): string | null {
  const m = /\b(?:do not|don't|never|no)\b\s+(.*)$/i.exec(constraint);
  if (!m) return null;
  const words = m[1].toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const content = words.filter(
    (w) =>
      ![
        "show",
        "include",
        "feature",
        "display",
        "anywhere",
        "their",
        "your",
        "with",
        "logo",
        "logos",
      ].includes(w),
  );
  return content.length ? content[content.length - 1] : null;
}

/** The prompt with every line that states a constraint removed — what is left is what the model is asked for. */
const withoutConstraintLines = (text: string, constraints: readonly string[]) =>
  text
    .split("\n")
    .filter(
      (l) =>
        !constraints.some((c) => l.toLowerCase().includes(c.toLowerCase())),
    )
    .join("\n");

export function checkFidelity(
  brief: FidelityBrief,
  prompts: readonly FidelityPrompt[],
): FidelityCheck[] {
  const out: FidelityCheck[] = [];

  // ── constraints: present in every prompt, and not contradicted in any ──────────────────────────
  const cWhy: string[] = [];
  prompts.forEach((p, i) => {
    for (const c of brief.constraints) {
      if (!low(p.text).includes(low(c)))
        cWhy.push(
          `prompt ${i} (${p.kind}${p.template ? `/${p.template}` : ""}): "${c}" absent`,
        );
      const thing = forbidden(c);
      if (
        thing &&
        low(withoutConstraintLines(p.text, brief.constraints)).includes(thing)
      )
        cWhy.push(
          `prompt ${i}: "${c}" is present, but the prompt also asks for "${thing}" — contradicted`,
        );
    }
  });
  out.push({ check: "constraints", pass: cWhy.length === 0, why: cWhy });

  // ── output: type and aspect ─────────────────────────────────────────────────────────────────────
  const oWhy: string[] = [];
  if (brief.output.type)
    prompts.forEach((p, i) => {
      if (p.kind !== brief.output.type)
        oWhy.push(
          `prompt ${i} is ${p.kind}; the brief confirmed ${brief.output.type}`,
        );
    });
  if (brief.output.aspect_ratio)
    prompts.forEach((p, i) => {
      if (p.aspectRatio && p.aspectRatio !== brief.output.aspect_ratio)
        oWhy.push(
          `prompt ${i} is ${p.aspectRatio}; the brief confirmed ${brief.output.aspect_ratio}`,
        );
    });
  out.push({ check: "output", pass: oWhy.length === 0, why: oWhy });

  // ── product line: carried somewhere ─────────────────────────────────────────────────────────────
  const pWhy =
    brief.productLine &&
    !prompts.some((p) => low(p.text).includes(low(brief.productLine!)))
      ? [`the product line "${brief.productLine}" is in no prompt`]
      : [];
  out.push({ check: "product", pass: pWhy.length === 0, why: pWhy });

  // ── tone: every word somewhere ──────────────────────────────────────────────────────────────────
  const tWhy = brief.tone
    .filter((t) => !prompts.some((p) => low(p.text).includes(low(t))))
    .map((t) => `tone "${t}" is in no prompt`);
  out.push({ check: "tone", pass: tWhy.length === 0, why: tWhy });

  return out;
}
