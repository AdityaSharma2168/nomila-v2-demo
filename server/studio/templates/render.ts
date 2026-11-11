/**
 * templates/render — a Studio prompt template published in the `prompts` registry, read back as a JSON envelope and
 * rendered from the SAME named pieces the TS literal is joined from (quality-scrappy piece 4, docs/probes/
 * quality-scrappy.md, ADI-QS-GO R1/R2). Pure: no database. The read is templates/registry.ts; the freeze onto the
 * brief is templates/freeze.ts.
 *
 * ─── WHY AN ENVELOPE IN `body` ──────────────────────────────────────────────────────────────────────────
 *
 * The `prompts` table (Mia's, migrations/0033) has key, version, body (text), status, hash and note — no JSON column,
 * and its schema is not ours to change. So a Studio template's body is a versioned JSON envelope (R1):
 *
 *   { "format": "studio-template/1",
 *     "meta": { "model_target", "provider", "dialect", "asset_slots", "allowed_params", "avoid", "rubric_id" },
 *     "template": "…{{direction}}…" }
 *
 * Only this reader parses it; `resolvePrompt` (server/lib/promptRegistry.ts) never sees a `studio.*` key.
 *
 * ─── WHAT A TEMPLATE CAN AND CANNOT DO ──────────────────────────────────────────────────────────────────
 *
 * It ORDERS AND FRAMES the pieces the code computes — it cannot compute one. Her direction is a placeholder, fenced by
 * the code exactly as the literal fences it (an inbound brief stays data); the likeness block, the preservation clause
 * and the brand fence are placeholders too. So a published row can reword the scaffolding around them and move them,
 * and cannot unfence her words or drop her face — a template missing a REQUIRED placeholder is refused and the literal
 * is used instead, with a warning line. So is any placeholder the code does not fill (a typo would otherwise ship as
 * literal braces), a body that is not the envelope, and a format this reader does not know.
 *
 * ⚠️ MUTATIONS (templates/render.test.ts): drop the required-placeholder check — "a template without {{direction}}
 * falls back to the literal" reds; stop collapsing the blank lines an empty piece leaves — "an absent piece leaves no
 * blank paragraph" reds.
 */
import { createLogger } from "../../logger";
import type { TemplateInputs } from "./resolve";

const logger = createLogger("studio-templates");

export const TEMPLATE_FORMAT = "studio-template/1";

/**
 * A template choice frozen onto a brief at the quote (`brief.job.template`, templates/freeze.ts) — what the run renders
 * from, so a publish between the quote and the run never moves a queued clip. `source: "code"` is the TS literal, frozen
 * so every job carries its template's key for pass rates (piece 5); `"registry"` carries the published row verbatim.
 */
export interface FrozenTemplate {
  key: string;
  source: "registry" | "code";
  version: number | null;
  hash: string | null;
  /** The published row's body — present only on `source: "registry"`. */
  body?: string;
  /** What the resolver read to choose this key (quality-scrappy piece 9, templates/resolve.ts). Absent before piece 9. */
  inputs?: TemplateInputs;
}

/**
 * A native edit's pieces (compile/assemble.ts `buildNativePrompt`), in the literal's order. The instruction paragraph is
 * `{{clause}} {{text}} {{scope}} {{preservation}} {{framing}} {{keep}} {{aspect}}` — an empty one leaves no double space
 * (renderTemplate). Required: the clause and the scope (Google's "what to keep exactly the same", rule 2), the references
 * (which image is which), the DO NOTs (the brand's and the ad's exclusions are compliance) and the dialect's canvas.
 */
const NATIVE_EDIT = {
  placeholders: [
    "references",
    "clause",
    "text",
    "scope",
    "preservation",
    "framing",
    "keep",
    "aspect",
    "style",
    "donts",
  ],
  required: ["references", "clause", "scope", "aspect", "donts"],
  dialect: null,
} as const;
/** An edit that can add words — a headline, a compound, an ad — also keeps the dialect's exact-text line (rule 5). */
const NATIVE_TEXT_EDIT = {
  ...NATIVE_EDIT,
  required: [...NATIVE_EDIT.required, "text"],
} as const;

/**
 * The templates a published row may replace — piece 4's three, and piece 8's every Create Anything template — and what
 * each must keep.
 */
export const REGISTRY_TEMPLATES = {
  "studio.video.broll-seedance": {
    placeholders: [
      "subject",
      "direction",
      "carrier",
      "environment",
      "camera",
      "style",
      "sound",
      "avoid",
    ],
    // {{sound}} too: it is empty unless the clip paid for sound, and a template that drops it would buy a soundtrack
    // and never ask for one (video/prompts.ts SOUND_CLAUSE: the flag alone came back at −91 dB).
    required: ["direction", "sound"],
    dialect: "seedance",
  },
  "studio.video.identity-static": {
    placeholders: [
      "opening",
      "direction",
      "carrier",
      "camera",
      "preservation",
      "discipline",
    ],
    // No {{sound}}: the sound clause is appended AFTER the template, exactly as the literal appends it (withSound).
    required: ["direction", "preservation"],
    dialect: null,
  },
  // {{aspect}} (piece 8): the Gemini image dialect's canvas sentence (compile/geminiDialect.ts) — empty with the dialect
  // off. Required on every image template, so a row cannot quietly drop a rule the dialect applies.
  "studio.image.generate": {
    placeholders: [
      "opening",
      "references",
      "aspect",
      "audience",
      "text_rules",
      "brand",
      "style",
      "goal",
      "direction",
    ],
    required: ["direction", "references", "aspect"],
    dialect: null,
  },
  // A masked (or frame-space) edit: compile/image.ts's edit arm. {{opening}} is its keep — "every other pixel … must
  // stay exactly as they are" — so it is required with the region block and her direction.
  "studio.image.edit.masked": {
    placeholders: [
      "opening",
      "references",
      "aspect",
      "brand",
      "edit",
      "goal",
      "direction",
    ],
    required: ["opening", "references", "aspect", "edit", "direction"],
    dialect: null,
  },
  // Every native edit (compile/assemble.ts), one key per operation, a compound and an ad. {{clause}} is the code's —
  // the fence around her words and the "Image N" numbering are inside it, so a row POSITIONS it and never rewords it
  // (ADI-QS-5 (4)). A crop is cut in-process and never sent, so it has no key.
  "studio.image.edit.recolor": NATIVE_EDIT,
  "studio.image.edit.apply_design": NATIVE_EDIT,
  "studio.image.edit.replace_object": NATIVE_EDIT,
  "studio.image.edit.add_object": NATIVE_EDIT,
  "studio.image.edit.remove_object": NATIVE_EDIT,
  "studio.image.edit.move_object": NATIVE_EDIT,
  "studio.image.edit.change_background": NATIVE_EDIT,
  "studio.image.edit.global_style": NATIVE_EDIT,
  "studio.image.edit.relight": NATIVE_EDIT,
  "studio.image.edit.camera": NATIVE_EDIT,
  "studio.image.edit.brand_mark": NATIVE_EDIT,
  "studio.image.edit.display_text": NATIVE_TEXT_EDIT,
  "studio.image.edit.compound": NATIVE_TEXT_EDIT,
  "studio.image.edit.ad": NATIVE_TEXT_EDIT,
} as const satisfies Record<
  string,
  {
    placeholders: readonly string[];
    required: readonly string[];
    dialect: "seedance" | null;
  }
>;
export type RegistryTemplateKey = keyof typeof REGISTRY_TEMPLATES;
export const isRegistryTemplateKey = (k: string): k is RegistryTemplateKey =>
  Object.prototype.hasOwnProperty.call(REGISTRY_TEMPLATES, k);

/** The metadata every envelope carries (R1). Validated for shape; `avoid` extends the Seedance Avoid clause. */
export interface TemplateMeta {
  model_target: string;
  provider: string;
  dialect: string | null;
  asset_slots: string[];
  allowed_params: string[];
  avoid: string[];
  rubric_id: string | null;
  /**
   * The face a headline is set in under the Gemini image dialect (ADI-QS-5: a template FIELD, not a constant). Optional;
   * absent, compile/geminiDialect.ts DEFAULT_TEXT_FONT. Read only where the dialect writes a headline.
   */
  font?: string;
}

export type EnvelopeFallback =
  | "not_json"
  | "wrong_format"
  | "no_template"
  | "bad_meta"
  | "dialect_mismatch"
  | "unknown_placeholder"
  | "missing_placeholder";

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Parse and validate one envelope against the template it claims to be. Pure. */
export function parseEnvelope(
  key: RegistryTemplateKey,
  body: string,
):
  | { ok: true; template: string; meta: TemplateMeta }
  | { ok: false; reason: EnvelopeFallback; detail?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const env = raw as { format?: unknown; meta?: unknown; template?: unknown };
  if (!env || typeof env !== "object" || env.format !== TEMPLATE_FORMAT)
    return { ok: false, reason: "wrong_format" };
  if (typeof env.template !== "string" || !env.template.trim())
    return { ok: false, reason: "no_template" };
  const m = env.meta as Partial<TemplateMeta> | undefined;
  if (
    !m ||
    typeof m.model_target !== "string" ||
    typeof m.provider !== "string" ||
    !(m.dialect === null || typeof m.dialect === "string") ||
    !strings(m.asset_slots) ||
    !strings(m.allowed_params) ||
    !strings(m.avoid) ||
    !(m.rubric_id === null || typeof m.rubric_id === "string") ||
    !(m.font === undefined || (typeof m.font === "string" && !!m.font.trim()))
  )
    return { ok: false, reason: "bad_meta" };
  const spec = REGISTRY_TEMPLATES[key];
  if ((m.dialect ?? null) !== spec.dialect)
    return { ok: false, reason: "dialect_mismatch" };
  const used = [...env.template.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map(
    (x) => x[1],
  );
  const unknown = used.filter(
    (n) => !(spec.placeholders as readonly string[]).includes(n),
  );
  if (unknown.length)
    return {
      ok: false,
      reason: "unknown_placeholder",
      detail: unknown.join(","),
    };
  const missing = spec.required.filter((n) => !used.includes(n));
  if (missing.length)
    return {
      ok: false,
      reason: "missing_placeholder",
      detail: missing.join(","),
    };
  return { ok: true, template: env.template, meta: m as TemplateMeta };
}

/**
 * The frozen registry template for `key` on this brief — the base key's own row, or a VARIANT of it (`key+her`,
 * templates/resolve.ts), which renders under the base's placeholders — or null, and the literal applies.
 */
export const registryTemplateOn = (
  template: FrozenTemplate | undefined,
  key: RegistryTemplateKey,
): FrozenTemplate | null =>
  template?.source === "registry" &&
  (template.key === key || template.key.startsWith(`${key}+`)) &&
  template.body
    ? template
    : null;

/**
 * Render a frozen registry template from the literal's own pieces — or null, with a warning line naming the reason,
 * when the envelope cannot be used and the literal must be. Deterministic: the quote and the run render the same
 * frozen body to the same string.
 */
export function renderTemplate(
  frozen: FrozenTemplate,
  key: RegistryTemplateKey,
  /** The literal's own pieces, computed once the envelope's metadata is known (the Seedance Avoid clause reads it). */
  piecesFor: (meta: TemplateMeta) => Record<string, string>,
): { prompt: string; meta: TemplateMeta } | null {
  const parsed = parseEnvelope(key, frozen.body ?? "");
  if (!parsed.ok) {
    logger.warn(
      {
        key: frozen.key,
        version: frozen.version,
        hash: frozen.hash,
        reason: parsed.reason,
        detail: parsed.detail,
      },
      "published template not used — falling back to the literal",
    );
    return null;
  }
  const pieces = piecesFor(parsed.meta);
  const empty = (name: string) => !pieces[name];
  // ALL the tidying is done to the TEMPLATE, before a piece is put in (piece 8 moved it here): an absent piece (no
  // campaign, no brand, a dialect sentence with the dialect off) leaves no double space and no blank paragraph, as the
  // literal's join simply leaves it out — and her words, fenced inside a piece, are never trimmed or collapsed. Tidied
  // AFTER, as piece 4 first had it, a direction with three newlines came back different from the literal.
  const shaped = parsed.template
    // An empty placeholder goes with the one space after it, so "{{clause}} {{text}} {{scope}}" is "clause scope".
    .replace(/\{\{\s*([a-z_]+)\s*\}\} ?/g, (m, name: string) =>
      empty(name) ? "" : m,
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const prompt = shaped.replace(
    /\{\{\s*([a-z_]+)\s*\}\}/g,
    (_, name: string) => pieces[name] ?? "",
  );
  return { prompt, meta: parsed.meta };
}
