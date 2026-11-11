/**
 * studio/compile/geminiDialect — the Gemini 3 Pro Image ("Nano Banana Pro") dialect (quality-scrappy piece 7,
 * ADI-QS-3 / ADI-QS-5; docs/probes/quality-scrappy.md). Behind STUDIO_DIALECTS — opt-in, the master never reaches it —
 * and chosen from the model the image call is routed to (studio/preview.ts `plannedInputs`). Off, or any other model,
 * and nothing here is read: every image prompt is byte for byte today's (compile/golden.test.ts).
 *
 * ─── FIVE RULES, AND WHERE EACH ONE COMES FROM ─────────────────────────────────────────────────────────────
 *
 * Four are Google's, read first-hand on 2026-09-28 in the two guides below. The fifth is OURS: neither guide says it,
 * and the evidence for it is our own generate probes (docs/probes/generate-defects.md), which is why it is marked so
 * and why it is phrased positively — the Cloud guide's own advice ("Use positive framing") argues against a list of
 * negations. What each rule changes is the smallest change that meets it; where the code already met a rule, nothing
 * moves.
 *
 * ⚠️ MUTATIONS (compile/golden.test.ts, "the Gemini image dialect"): M7a drop the frame's role line; M7b state the
 * canvas on generates only; M7c send the headline unquoted; M7d the exact-text line on every edit; M7e the dialect
 * with the flag off; M7f the dialect for a model that is not this one.
 */
import type { NativeChange } from "../nativeEdit";
import { fenceSpan } from "./templates";
import { listOf } from "./text";

const BLOG =
  "https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/";
const CLOUD =
  "https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana";

/** One rule of the dialect, and whether a person here read it from Google or it is our own. */
export interface DialectRule {
  says: string;
  source: string;
  /** "google" — read first-hand in Google's guidance; "ours" — our own evidence, not Google's. */
  from: "google" | "ours";
}

export const GEMINI_IMAGE_RULES = {
  /** Code before: the manifest numbered every image but a frame-only native edit's single one. */
  roles: {
    says: '"Reference inputs: … clearly define the role of each"',
    source: `${BLOG} (read 2026-09-28)`,
    from: "google",
  },
  /** Already met — every native edit's scope sentence and preservation clause; nothing changes. */
  keep: {
    says: '"Be explicit about what to keep exactly the same"',
    source: `${CLOUD} (read 2026-09-28)`,
    from: "google",
  },
  /** Code before: the canvas was set in config (`imageConfig.aspectRatio`) and never in the words. */
  canvas: {
    says: '"Composition and aspect ratio: Define the canvas" ("A 9:16 vertical poster")',
    source: `${BLOG} (read 2026-09-28)`,
    from: "google",
  },
  /** Code before: her words unquoted, "in bold white capital letters" — a style, no font. */
  text: {
    says: '"Use quotes" for the words; "Choose a font" by name',
    source: `${BLOG}; ${CLOUD} (read 2026-09-28). The font itself is our choice (DEFAULT_TEXT_FONT)`,
    from: "google",
  },
  /** Only on an edit that adds text; the generate arm keeps its measured TEXT AND NAMES line. */
  exactText: {
    says: "State the only text an edit adds, exactly, in the positive",
    source:
      "our generate probes (docs/probes/generate-defects.md: invented handles and a surname on kit) — not Google's",
    from: "ours",
  },
} as const satisfies Record<string, DialectRule>;

/**
 * The face a headline is set in when no published template names one (ADI-QS-5: a template FIELD, `meta.font`, with
 * this as its default). Helvetica Bold: the most widely used sans-serif there is, so the model has seen it rendered
 * more than any other face; bold, which a headline wants; and neutral — Impact reads as a meme and Futura Condensed
 * ExtraBold as Nike's own. Outfit stays the captions' face, drawn by our code; it is too rare to trust a model to draw.
 */
export const DEFAULT_TEXT_FONT = "Helvetica Bold";

/** What an image prompt is written with, when the dialect is on. Null everywhere else. */
export interface GeminiImageDialect {
  /** The canvas this request pins (`inputs.aspectRatio`), or null when it pins none — then rule 3 says nothing. */
  aspect: string | null;
  /** The face a headline is set in. */
  font: string;
}

/** "portrait", "landscape" or "square", for a ratio written "W:H". Null for anything that is not one. */
function orientation(aspect: string): string | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  if (!m) return null;
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (!w || !h) return null;
  return w === h ? "square" : w < h ? "portrait" : "landscape";
}

/**
 * Rule 3 — the canvas, in the words. A generate is told what to make; an edit is told to keep the shape it has; a
 * masked edit's model holds a CROP, so it keeps THIS image's shape (compile/aspect.ts: the canvas is the crop's).
 */
export function canvasSentence(
  aspect: string | null,
  kind: "generate" | "edit" | "crop",
): string | null {
  const shape = aspect ? orientation(aspect) : null;
  if (!aspect || !shape) return null;
  if (kind === "generate") return `A ${aspect} ${shape} image.`;
  if (kind === "crop") return `Keep this image's ${aspect} ${shape} shape.`;
  return `Keep the photograph's ${aspect} ${shape} shape.`;
}

/**
 * Rule 1 — the one image of a frame-only native edit, given its role. With more than the frame the manifest already
 * names every image (compile/manifest.ts), and a masked edit's always does.
 */
export const FRAME_ROLE_LINE = "Image 1 — the photograph being edited.";

/** Rule 4 — her words, quoted, as the headline clause sends them: fenced exactly as today, the quotes outside. */
export const quotedWords = (c: Pick<NativeChange, "change" | "fenced">) =>
  `"${fenceSpan(c.change ?? "", c.fenced)}"`;

/**
 * Rule 5 (ours) — the text an edit adds, stated exactly and in the positive. Only a TEXT-BEARING edit carries it: a
 * headline alone, or an ad's headline beside its logo. "Added", not "in the image": a photograph she is editing can
 * already carry lettering (her kit, a sign), and the scope sentence keeps that — this line must not read as an order
 * to remove it. An ad's logo is a mark, named after the words so the line never contradicts its own clause.
 */
export function exactTextLine(
  changes: readonly Pick<NativeChange, "op" | "change" | "fenced">[],
): string | null {
  const words = changes
    .filter((c) => c.op === "DISPLAY_TEXT" && c.change)
    .map(quotedWords);
  if (!words.length) return null;
  const marks = changes
    .filter((c) => c.op === "BRAND_MARK" && c.change)
    .map((c) => `the ${c.change} logo`);
  return `Any text added to the image is exactly: ${listOf(words)}${marks.length ? `, plus ${listOf(marks)}` : ""}.`;
}
