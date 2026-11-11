/**
 * templates/seeds — the first version of each registry template, written to reproduce today's TS literal EXACTLY
 * (quality-scrappy pieces 4 and 8, ADI-QS-GO / ADI-QS-3). Publishing a seed is therefore a proven no-op on every prompt — freeze.test.ts
 * renders each against the literal on the golden briefs — which makes it the first thing to publish on dev: it
 * exercises the read, the envelope, the freeze and the render end to end without moving a word. The version after a seed's is where an
 * edit begins.
 *
 * The SQL that inserts them is generated from this file (server/scripts/studioTemplateSeedSql.ts) and run by Adi on
 * dev — never by the code.
 */
import { createHash } from "crypto";
import {
  REGISTRY_TEMPLATES,
  TEMPLATE_FORMAT,
  type RegistryTemplateKey,
  type TemplateMeta,
} from "./render";

/** The Nano Pro image target every image seed is written for — the route's default (config.ts `routes`). */
const NANO_PRO_META: TemplateMeta = {
  model_target: "gemini-3-pro-image",
  provider: "vertex",
  dialect: null,
  asset_slots: ["frame", "character", "object", "style"],
  allowed_params: ["aspectRatio", "imageSize"],
  avoid: [],
  rubric_id: null,
};

/** A native edit's literal (compile/assemble.ts `buildNativePrompt`), placeholder for piece. */
const NATIVE_SEED =
  "{{references}}\n\n{{clause}} {{text}} {{scope}} {{preservation}} {{framing}} {{keep}} {{aspect}}\n\n{{style}}\n\n{{donts}}";
const nativeSeed = (what: string) => ({
  version: 1,
  template: NATIVE_SEED,
  meta: NANO_PRO_META,
  note: `quality-scrappy seed: the native ${what} literal, verbatim (compile/assemble.ts buildNativePrompt).`,
});

export const SEED_TEMPLATES: Record<
  RegistryTemplateKey,
  { version: number; template: string; meta: TemplateMeta; note: string }
> = {
  "studio.video.broll-seedance": {
    version: 1,
    template:
      "{{subject}}\n\n{{direction}}\n\n{{carrier}}\n\n{{environment}}\n\n{{camera}}\n\n{{style}}\n\n{{sound}}\n\n{{avoid}}",
    meta: {
      model_target: "bytedance/seedance-2.0-fast",
      provider: "openrouter",
      dialect: "seedance",
      asset_slots: ["frame"],
      allowed_params: ["watermark", "req_key"],
      avoid: [],
      rubric_id: null,
    },
    note: "quality-scrappy seed: the Seedance b-roll dialect's literal, verbatim (six steps, second-hand).",
  },
  "studio.video.identity-static": {
    version: 1,
    template:
      "{{opening}}\n\n{{direction}}\n\n{{carrier}}\n\n{{camera}}\n\n{{preservation}}\n\n{{discipline}}",
    meta: {
      model_target: "veo-3.1-generate-001",
      provider: "vertex",
      dialect: null,
      asset_slots: ["frame", "character"],
      allowed_params: ["generateAudio"],
      avoid: [],
      rubric_id: null,
    },
    note: "quality-scrappy seed: the Veo 'her' (identity-static) literal, verbatim — V2b's i2 wording.",
  },
  // VERSION 2: piece 4 handed out version 1 without {{aspect}}, which piece 8 made required (the dialect's canvas). A
  // version 1 already published on dev now falls back to the literal with a warning line (missing_placeholder); the
  // published SQL below archives it, as it is ours, and publishes this.
  "studio.image.generate": {
    version: 2,
    template:
      "{{opening}}\n\n{{references}}\n\n{{aspect}}\n\n{{audience}}\n\n{{text_rules}}\n\n{{brand}}\n\n{{style}}\n\n{{goal}}\n\n{{direction}}",
    meta: { ...NANO_PRO_META, asset_slots: ["character", "object", "style"] },
    note: "quality-scrappy seed: the Nano Pro image-generate literal, verbatim (compile/image.ts buildPrompt); version 2 adds the dialect's {{aspect}}.",
  },
  "studio.image.edit.masked": {
    version: 1,
    template:
      "{{opening}}\n\n{{references}}\n\n{{aspect}}\n\n{{brand}}\n\n{{edit}}\n\n{{goal}}\n\n{{direction}}",
    meta: NANO_PRO_META,
    note: "quality-scrappy seed: the masked-edit literal, verbatim (compile/image.ts buildPrompt, edit arm).",
  },
  "studio.image.edit.recolor": nativeSeed("recolour"),
  "studio.image.edit.apply_design": nativeSeed("apply-a-design"),
  "studio.image.edit.replace_object": nativeSeed("replace"),
  "studio.image.edit.add_object": nativeSeed("add"),
  "studio.image.edit.remove_object": nativeSeed("remove"),
  "studio.image.edit.move_object": nativeSeed("move"),
  "studio.image.edit.change_background": nativeSeed("background"),
  "studio.image.edit.global_style": nativeSeed("look"),
  "studio.image.edit.relight": nativeSeed("relight"),
  "studio.image.edit.camera": nativeSeed("camera"),
  "studio.image.edit.brand_mark": nativeSeed("logo"),
  "studio.image.edit.display_text": nativeSeed("headline"),
  "studio.image.edit.compound": nativeSeed("compound"),
  "studio.image.edit.ad": nativeSeed("ad"),
};

/** The row body — the envelope — for a seed. */
export const seedBody = (key: RegistryTemplateKey): string =>
  JSON.stringify({
    format: TEMPLATE_FORMAT,
    meta: SEED_TEMPLATES[key].meta,
    template: SEED_TEMPLATES[key].template,
  });

/** First 12 of sha1(body) — the `prompts.hash` convention (shared/schema.ts). */
export const seedHash = (key: RegistryTemplateKey): string =>
  createHash("sha1").update(seedBody(key)).digest("hex").slice(0, 12);

const dollar = (text: string) => {
  if (text.includes("$tpl$"))
    throw new Error("a template body contains the dollar-quote tag");
  return `$tpl$${text}$tpl$`;
};

/** Who the seed rows say wrote them — and the only rows the published SQL will ever archive. */
export const SEED_AUTHOR = "quality-scrappy seed";

/**
 * The SQL that inserts every seed at its version — for Adi to run on DEV. Guarded by the table's own unique indexes:
 * `prompts_key_version_uq` makes a re-run a no-op; `prompts_one_published_uq` refuses a second published version of a
 * key, so publishing first archives an OLDER published row of the same key that this seed itself wrote (piece 4's
 * generate version 1) — never a row anyone else wrote, which would instead stop the whole transaction. freeze.test.ts
 * executes exactly this text against PGlite.
 */
export function seedSql(status: "draft" | "published"): string {
  const lines = [
    "-- quality-scrappy pieces 4 + 8: Studio template seeds — each renders byte-identical to today's literal",
    "-- (server/studio/templates/freeze.test.ts proves it, and runs this text). Run on DEV only. Additive; no DDL.",
    "BEGIN;",
  ];
  for (const key of Object.keys(REGISTRY_TEMPLATES) as RegistryTemplateKey[]) {
    const { version, note } = SEED_TEMPLATES[key];
    if (status === "published")
      lines.push(
        `UPDATE prompts SET status = 'archived' WHERE key = '${key}' AND status = 'published' AND created_by = '${SEED_AUTHOR}' AND version < ${version};`,
      );
    lines.push(
      `INSERT INTO prompts (key, version, body, status, hash, note, created_by${status === "published" ? ", published_at" : ""})`,
      `VALUES ('${key}', ${version}, ${dollar(seedBody(key))}, '${status}', '${seedHash(key)}', ${dollar(note)}, '${SEED_AUTHOR}'${status === "published" ? ", now()" : ""})`,
      "ON CONFLICT (key, version) DO NOTHING;",
    );
  }
  lines.push("COMMIT;");
  return lines.join("\n");
}
