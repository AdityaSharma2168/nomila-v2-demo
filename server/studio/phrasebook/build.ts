/**
 * The phrasebook (PR 19, ADI-R19-PB): what to type in Create Anything, for someone testing it — generated, never written.
 *
 * `cases.json` is the data: each phrase, its category, what it needs, and the route the rules must give it. This module
 * routes every phrase through the REAL classifier (`route`, the same call /studio/classify makes), with the switches
 * the sentence door runs with, and renders docs/studio/phrasebook.md from what it OBSERVED — so a phrase shown as
 * working is one the rules route to its category's target at this tip, checked by code. Her side of it — the ask copy,
 * the ad handoff's questions — is the client's own words, imported, not restated. Prices are the engine's own
 * (`estimateCost`), not typed in. $0: no model, no database, no network.
 *
 * phrasebook.test.ts fails by name if a phrase's route moves, or if the md is stale against this file's render.
 * Regenerate with `npm run studio:phrasebook`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askCopyFor } from "../../../client/lib/studio-contract";
import { route, type Routed } from "../classify";
import { adGate, asksForAd } from "../interpret/ad";
import { MODELS } from "../config";
import { ANGLE_SUGGESTIONS, VAGUE_SUGGESTIONS } from "../imageOps";
import { interpretableAsk } from "../interpret/eligibility";
import { estimateCost } from "../pricing";
import type { GenerationInputs, ProviderOpts } from "../types";

// ─── The data ──────────────────────────────────────────────────────────────────────────────────────

export const CATEGORY_IDS = [
  "colour",
  "kit",
  "add",
  "background",
  "lighting",
  "camera",
  "crop",
  "look",
  "ads",
  "text",
  "pose",
  "vague",
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];
type Need = "photo" | "style" | "brand";

export interface PhraseCase {
  phrase: string;
  category: CategoryId;
  kind: "works" | "miss";
  needs: Need[];
  /** The route the rules must give it — `routeOf`'s rendering. */
  expect: string;
  /** Style photos attached (the look pointer). */
  styles?: number;
  /** A miss's fix: a `works` phrase of the same category. */
  fix?: string;
  note?: string;
}
export interface PhraseData {
  quickRun: string[];
  cases: PhraseCase[];
}

const ROOT = join(__dirname, "..", "..", "..");
export const CASES_PATH = join(__dirname, "cases.json");
export const PHRASEBOOK_PATH = join(ROOT, "docs", "studio", "phrasebook.md");

export function loadCases(): PhraseData {
  return JSON.parse(readFileSync(CASES_PATH, "utf8")) as PhraseData;
}

// ─── Observing a phrase ─────────────────────────────────────────────────────────────────────────────

/**
 * The server switches the sentence door runs with that change a ROUTE. The rest of "Testing locally" (below) gates
 * routes and screens, not what the rules answer, so it cannot move a row here.
 */
const ROUTE_FLAGS = [
  "STUDIO_IMAGE_OPS",
  "STUDIO_DISPLAY_TEXT",
  "STUDIO_MOVE_OBJECT",
] as const;

/**
 * PR 20 (ADI-S20-GO): the master is saved and CLEARED too, never set. Under STUDIO_ALL_ON a deleted switch reads ON
 * (studio/studioFlag.ts), so "each one turned off alone" in routeFlagsFor would turn nothing off and every row would
 * say it needs no switch. ⚠️ MUTATION (phrasebook.test): drop STUDIO_ALL_ON from this list — "a developer's master
 * never changes the doc or what a row needs" reds by name.
 */
const CLEARED = [...ROUTE_FLAGS, "STUDIO_ALL_ON"] as const;

function withFlags<T>(on: readonly string[], fn: () => T): T {
  const saved = CLEARED.map((f) => [f, process.env[f]] as const);
  for (const f of CLEARED) {
    if (on.includes(f)) process.env[f] = "true";
    else delete process.env[f];
  }
  try {
    return fn();
  } finally {
    for (const [f, v] of saved) {
      if (v === undefined) delete process.env[f];
      else process.env[f] = v;
    }
  }
}

/** One answer, as one line: the harness's rendering (classify.imageOps.test.ts), plus placement. */
export function routeOf(r: Routed): string {
  if (r.initialPath === "ASK") return `ASK ${r.reason}`;
  return r.steps
    .map(
      (s) =>
        `${s.op}[${s.targets.join("|")}]=${s.value}${s.placement ? `@${s.placement}` : ""}`,
    )
    .join(" ; ");
}

const routeWith = (c: PhraseCase, flags: readonly string[]): Routed =>
  withFlags(flags, () =>
    route(c.phrase, true, { objects: 0, styles: c.styles ?? 0 }),
  );

/**
 * What the rules answer at this tip, with every route switch on — as dev and the walk run. An ad the interpreter will
 * read also carries what main's ad gate (interpret/ad.ts, $0, before any call) decides: whose ad, or its ask.
 */
export function observe(c: PhraseCase): string {
  const routed = routeWith(c, ROUTE_FLAGS);
  const line = routeOf(routed);
  if (routed.initialPath !== "ASK" || !asksForAd(c.phrase)) return line;
  const gate = adGate(c.phrase, null);
  return gate.kind === "ad"
    ? `${line} · ad=${gate.brand}`
    : gate.kind === "ask"
      ? `${line} · ad asks ${gate.code}`
      : line;
}

/** Which route switches this phrase's route needs: each one turned off alone, and the route moved. */
export function routeFlagsFor(c: PhraseCase): string[] {
  const all = observe(c);
  return ROUTE_FLAGS.filter(
    (f) =>
      routeOf(
        routeWith(
          c,
          ROUTE_FLAGS.filter((g) => g !== f),
        ),
      ) !== all,
  );
}

/** Does this route reach the category's target — what "works" means, per category. */
export function reachesTarget(category: CategoryId, observed: string): boolean {
  const one = !observed.includes(" ; ");
  switch (category) {
    case "colour":
      return one && observed.startsWith("RECOLOR[");
    case "kit":
      return one && /^(REPLACE_OBJECT|APPLY_DESIGN)\[/.test(observed);
    case "add":
      return one && /^(ADD_OBJECT|REMOVE_OBJECT)\[/.test(observed);
    case "background":
      return (
        one &&
        observed.startsWith("CHANGE_BACKGROUND[") &&
        !observed.endsWith("=null")
      );
    case "lighting":
      return one && observed.startsWith("RELIGHT[");
    case "camera":
      return one && observed.startsWith("CAMERA[");
    case "crop":
      return one && observed.startsWith("CROP[");
    case "look":
      return one && observed.startsWith("GLOBAL_STYLE[");
    case "ads":
      // It works when the interpreter's ad treatment runs: an ask it reads, whose ad gate names the brand.
      return /^ASK \S+ · ad=/.test(observed);
    case "text":
      return one && observed.startsWith("DISPLAY_TEXT[");
    case "pose":
      return observed === "GENERATE[]=null";
    case "vague":
      return observed === "ASK vague";
  }
}

// ─── What she sees, and what it costs ───────────────────────────────────────────────────────────────

type Makes = "edit" | "crop" | "new image" | "ad" | "question";

export function makesOf(observed: string): Makes {
  if (observed.startsWith("GENERATE[")) return "new image";
  if (observed.startsWith("CROP[")) return "crop";
  if (/ · ad=/.test(observed)) return "ad";
  if (observed.startsWith("ASK ")) return "question";
  return "edit";
}

const sized = (size: "2K" | "4K"): ProviderOpts =>
  ({
    providerParams: { generationConfig: { imageConfig: { imageSize: size } } },
  }) as ProviderOpts;
const refs = (n: number): GenerationInputs =>
  ({
    prompt: "",
    references: Array.from({ length: n }, () => ({
      kind: "url",
      url: "https://example.invalid/photo.jpg",
    })),
  }) as GenerationInputs;

/** The engine's own prices (studio/pricing.ts), for the one model each kind runs on. */
export function prices() {
  const usd = (inputs: GenerationInputs, model: string, opts?: ProviderOpts) =>
    estimateCost(inputs, model, opts).amountUsd;
  return {
    // An edit sends her photo as its one reference.
    edit4k: usd(refs(1), MODELS.nanoPro, sized("4K")),
    edit2k: usd(refs(1), MODELS.nanoPro, sized("2K")),
    crop: usd(refs(1), MODELS.crop),
    // A new image: with no photo, with one photo of her, and with a three-photo pack.
    newImage0: usd(refs(0), MODELS.nanoPro),
    newImage1: usd(refs(1), MODELS.nanoPro),
    newImage3: usd(refs(3), MODELS.nanoPro),
  };
}

const money = (usd: number) => (usd === 0 ? "$0" : `~$${usd.toFixed(2)}`);

function costOf(makes: Makes, p: ReturnType<typeof prices>): string {
  switch (makes) {
    case "crop":
      return `${money(p.crop)} — no model touches it`;
    case "edit":
      return `${money(p.edit4k)} on a 4K photo, ${money(p.edit2k)} on a 2K one`;
    case "ad":
      return `one image: ${money(p.edit4k)} on a 4K photo, ${money(p.edit2k)} on a 2K one`;
    case "new image":
      return `${money(p.newImage1)} with one photo of you, ${money(p.newImage3)} with a three-photo pack`;
    case "question":
      return "$0 — nothing is made until you answer";
  }
}

const MAKES_WORDS: Record<Makes, string> = {
  edit: "An edit of your photo",
  crop: "A crop of your photo",
  "new image": "A new image, with your photo as the likeness",
  ad: "One ad, an edit of your photo",
  question: "A question, with choices to tap",
};

/** Her screen for this answer — the client's own copy, imported. */
export function seenFor(observed: string): string {
  const ad = / · ad=(.+)$/.exec(observed);
  if (ad)
    return `Your photo gets the EDITING tag. Mila reads the ad and shows “Here's what we'll do”: ${ad[1]}'s kit where yours shows another brand's, a headline, a background — and ${ad[1]}'s logo, like a watermark, when there's room. Stop before Approve.`;
  const adAsk = / · ad asks (\S+)$/.exec(observed);
  if (adAsk) return `Mila asks: “${askCopyFor(adAsk[1])}”`;
  if (observed.startsWith("ASK ")) {
    const code = observed.slice(4);
    const chips =
      code === "vague"
        ? VAGUE_SUGGESTIONS
        : code === "angle_unclear"
          ? ANGLE_SUGGESTIONS
          : null;
    const said = `Mila asks: “${askCopyFor(code)}”`;
    if (chips)
      return `${said} With chips: ${chips.map((c) => `“${c}”`).join(", ")}.`;
    if (interpretableAsk(code))
      return `Mila may try to read it for you first. If she can't: “${askCopyFor(code)}”`;
    return said;
  }
  if (observed.startsWith("GENERATE["))
    return "A preview of a new picture of you, with its price. Stop before Approve.";
  if (observed.startsWith("CROP["))
    return "A preview of the crop, $0. Stop before Approve.";
  return "A preview of the edit on your photo, with its price. Stop before Approve.";
}

// ─── The categories' words (plain, no op names — the main body is for someone skimming) ─────────────

const CATEGORIES: Record<
  CategoryId,
  { title: string; does: string; extra?: string }
> = {
  colour: {
    title: "Colour",
    does: "Changes the colour of one thing you're wearing. Name the thing and the colour.",
  },
  kit: {
    title: "Kit and brands",
    does: "Swaps a piece of kit for a brand's version, or puts a brand's logo on it. Any brand — ones we don't list are drawn by the model as best it can.",
  },
  add: {
    title: "Add or remove things",
    does: "Puts a thing into your photo, or takes one out. Say where it goes; if you don't, it goes next to you. Adding is always an edit of your photo.",
  },
  background: {
    title: "Background and weather",
    does: "Changes what's behind you and keeps you exactly as you are. Weather keeps the same place: rain, snow or sun on the background you already have.",
  },
  lighting: {
    title: "Lighting",
    does: "Relights the whole photo — golden hour, studio, rim, soft or stadium light.",
  },
  camera: {
    title: "Camera angle",
    does: "Re-shoots the same moment from a different angle — low, high or overhead — with your pose kept.",
  },
  crop: {
    title: "Crop and sizes",
    does: "Cuts your photo to a size you can post: 9:16 (stories and reels), 4:5 (feed) or 1:1 (square), or a tighter crop on you. Nothing is redrawn.",
  },
  look: {
    title: "Match a look",
    does: "Gives your photo the colour and mood of another picture. Attach that picture with the Style tile first.",
  },
  ads: {
    title: "Ads",
    does: "Turns your photo into an ad for a brand, as one edit: Mila reads your sentence and shows what she'll do — the brand's kit where yours shows another brand's, a headline, a background, and the brand's logo like a watermark when there's room — before anything runs. Name a brand we know (adidas, nike, puma…).",
    extra:
      "Give your own headline and it is used as yours. With no photo attached, an ad request makes a new image instead.",
  },
  text: {
    title: "Text on the photo",
    does: "Puts your words on the photo as a big banner — at the top, the middle or the bottom. Put the words in quotes and keep them short.",
  },
  pose: {
    title: "New image from your photo (pose)",
    does: "A different pose or action can't be an edit — it makes a new picture of you, using your photo for how you look.",
  },
  vague: {
    title: "Vague asks",
    does: "“Make it better” doesn't say what to change, so Mila asks — with a few one-tap choices. Nothing is made until you pick.",
  },
};

const NEEDS_WORDS: Record<Need, string> = {
  photo: "your photo",
  style: "a Style photo",
  brand: "a brand",
};

// ─── The doc's fixed sections ───────────────────────────────────────────────────────────────────────

const NOT_YET = [
  "**Two products at once.** One thing per sentence — add them one at a time.",
  "**Straighten, upscale and extend** (“zoom out”, “make it wider”, 16:9). Not built.",
  "**A pose or an expression as an edit.** These make a new image instead (see the pose section).",
  "**The Agent tab.** The new asks here — lighting, camera, crop, looks, text, ads by sentence — work in Create Anything only.",
  "**An ad for a brand we don't list** (a school, a small brand): Mila asks which brand, as before. Name a brand we know.",
  "**Stats cards.**",
  "**Text is short and drawn by the model**, not typeset. Expect a few words in a banner, not layout.",
  "**Lighting and camera quality** is pending the eval cells. This doc says the ask is understood, not that the picture is good.",
];

/** Server switches for the sentence door, and what each one opens. The client ones are already on in .env.development. */
const SERVER_FLAGS: [string, string][] = [
  ["STUDIO_ENABLED", "Studio at all"],
  ["STUDIO_SESSIONS", "Create Anything's thread"],
  [
    "STUDIO_SERVER_ROUTING",
    "the server's classify-and-refuse check before anything is spent",
  ],
  ["STUDIO_NATIVE_EDIT", "sentence edits of your photo"],
  [
    "STUDIO_INTERPRETER",
    "Mila reading a sentence the rules couldn't — every ad, and the near misses",
  ],
  [
    "STUDIO_IMAGE_OPS",
    "this PR: lighting, camera, crop, weather, looks, text placement, ads, adds, vague asks",
  ],
  ["STUDIO_DISPLAY_TEXT", "text on the photo"],
  ["STUDIO_STYLE_SPEC", "the Style tile (match a look)"],
];

// ─── Where each route is decided (the appendix) ─────────────────────────────────────────────────────

/** file:line of the one line in `file` that contains `needle` — throws unless there is exactly one. */
export function lineOf(file: string, needle: string): string {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const hits = lines.flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
  if (hits.length !== 1) {
    throw new Error(
      `phrasebook anchor ${JSON.stringify(needle)} is on ${hits.length} lines of ${file}, not one`,
    );
  }
  return `${file}:${hits[0]}`;
}

const C = "server/studio/classify.ts";
const ANCHORS = {
  pose: [C, "    if (readPose(text)) {"],
  relight: [C, "    const light = readRelight(text);"],
  camera: [C, "    const angle = readCamera(text);"],
  crop: [C, "    const crop = readCrop(text);"],
  weather: [C, "    const weather = readWeather(text);"],
  look: [C, "    if (readLookPointer(text)) {"],
  text: [
    C,
    "    const said = displayTextEnabled() ? readTextAdd(text) : null;",
  ],
  headline: [C, "// ─── RULE ⅛ — A HEADLINE"],
  hold: [C, "    const hold = readHoldAdd(text);"],
  behind: [C, "  if (imageOpsEnabled() && addLed && BG.test(text)) {"],
  placeless: [C, "    const placed = withDefaultPlace(text);"],
  removal: [C, "// RULE 1 — removal."],
  setting: [C, "// RULE 2 — the setting."],
  worn: [C, "// ─── RULE 3¾b — A THING SHE WEARS"],
  brand: [C, "// ─── RULE 4 — DESIGN AND BRAND"],
  add: [C, "// ─── RULE 4½ — ADD_OBJECT"],
  recolour: [C, "// RULE 5 — colour on a named region."],
  adRule0: [
    C,
    "    if (imageOpsEnabled() && hasSourcePhoto && asksForAd(text)) return null;",
  ],
  adGate: ["server/studio/interpret/ad.ts", "export function adGate("],
  vague: [C, 'if (imageOpsEnabled() && readVague(text)) return "vague";'],
  angle: [
    C,
    'if (imageOpsEnabled() && readAngleUnclear(text)) return "angle_unclear";',
  ],
  decline: [C, "export function declineReason("],
  priceToken: ["server/studio/pricing.ts", 'case "per_image_token": {'],
  priceRefs: [
    "server/studio/config.ts",
    "export const tokensPerReference = () => {",
  ],
  cropModel: ["server/studio/config.ts", 'crop: "local/sharp-crop",'],
} as const;
type Anchor = keyof typeof ANCHORS;
const at = (a: Anchor) => lineOf(ANCHORS[a][0], ANCHORS[a][1]);

/** The rule that decides this route — read off the answer, and off the switch it needs. */
function whereOf(observed: string, needsImageOps: boolean): Anchor[] {
  const [head] = observed.split(" ; ");
  if (head.startsWith("GENERATE[")) return ["pose"];
  if (head.startsWith("RELIGHT[")) return ["relight"];
  if (head.startsWith("CAMERA[")) return ["camera"];
  if (head.startsWith("CROP[")) return ["crop"];
  if (head.startsWith("CHANGE_BACKGROUND["))
    return head.includes("=same place ") ? ["weather"] : ["setting"];
  if (head.startsWith("GLOBAL_STYLE[")) return ["look"];
  if (head.startsWith("DISPLAY_TEXT["))
    return head.includes("@") ? ["text"] : ["headline"];
  if (head.startsWith("ADD_OBJECT[")) {
    if (!needsImageOps) return ["worn", "add"];
    if (head.endsWith("=in my hand")) return ["hold"];
    if (head.includes("=behind")) return ["behind"];
    return ["placeless"];
  }
  if (head.startsWith("REMOVE_OBJECT[")) return ["removal"];
  if (/^(REPLACE_OBJECT|APPLY_DESIGN)\[/.test(head)) return ["brand"];
  if (head.startsWith("RECOLOR[")) return ["recolour"];
  if (/ · ad/.test(head))
    return needsImageOps ? ["adRule0", "adGate"] : ["adGate"];
  if (head === "ASK vague") return ["vague"];
  if (head === "ASK angle_unclear") return ["angle"];
  if (head === "ASK style_reference_missing") return ["look"];
  return ["decline"];
}

// ─── The render ─────────────────────────────────────────────────────────────────────────────────────

const md = (s: string) => s.replace(/\|/g, "\\|");
const quoted = (s: string) => `\`${s}\``;

export function renderPhrasebook(data: PhraseData): string {
  const p = prices();
  const byPhrase = (phrase: string, category?: CategoryId) =>
    data.cases.find(
      (c) =>
        c.phrase === phrase &&
        c.kind === "works" &&
        (!category || c.category === category),
    );
  const out: string[] = [];
  out.push(
    "# Studio phrasebook — what to type in Create Anything",
    "",
    "> Generated by `npm run studio:phrasebook` from `server/studio/phrasebook/cases.json`. Do not edit by hand —",
    "> a test fails if this file and the data disagree.",
    "",
    "Attach your photo in Create Anything, type one of these, and look at the preview. Every preview is free.",
    "",
    "## What this proves",
    "",
    "Which way each phrase goes — an edit, a crop, a new image or a question — checked by code on every test run.",
    "It does not prove the picture is good: that's your judgement, and the eval cells for lighting and camera.",
    "",
    "## What it costs",
    "",
    "Every preview is free. Only Approve (or “Make it” on an ad) spends.",
    "",
    "| It makes | Cost to make it |",
    "|---|---|",
    `| A crop | ${money(p.crop)} |`,
    `| An edit of your photo | ${money(p.edit4k)} on a 4K photo, ${money(p.edit2k)} on a 2K one |`,
    `| An ad of your photo | the same as an edit |`,
    `| A new image | ${money(p.newImage0)} with no photo, ${money(p.newImage1)} with one photo of you, ${money(p.newImage3)} with a three-photo pack |`,
    "",
    "## Quick test run",
    "",
    "Attach one photo of you. For the “match a look” step, also attach a second picture with the Style tile.",
    "Type each line, check the preview, then **stop before Approve every time**. Total: $0.",
    "",
    "| # | Type this | You should see | Making it would cost |",
    "|---|---|---|---|",
  );
  data.quickRun.forEach((phrase, i) => {
    const c = byPhrase(phrase);
    if (!c) throw new Error(`quick run phrase is not a works case: ${phrase}`);
    const observed = observe(c);
    out.push(
      `| ${i + 1} | ${quoted(md(phrase))} | ${md(seenFor(observed))} | ${costOf(makesOf(observed), p)} |`,
    );
  });
  out.push("");

  for (const id of CATEGORY_IDS) {
    const cat = CATEGORIES[id];
    const rows = data.cases.filter((c) => c.category === id);
    const works = rows.filter((c) => c.kind === "works");
    const misses = rows.filter((c) => c.kind === "miss");
    const makes = makesOf(observe(works[0]));
    const needs = [...new Set(works.flatMap((c) => c.needs))];
    out.push(
      `## ${cat.title}`,
      "",
      cat.does,
      ...(cat.extra ? ["", cat.extra] : []),
      "",
      `- **Needs:** ${needs.map((n) => NEEDS_WORDS[n]).join(", ")}`,
      `- **Makes:** ${MAKES_WORDS[makes]}`,
      `- **Cost to make:** ${costOf(makes, p)}. The preview is free.`,
      "",
      "**Phrases that work:**",
      "",
      ...works.map(
        (c) => `- ${quoted(md(c.phrase))}${c.note ? ` — ${c.note}` : ""}`,
      ),
      "",
      "**Near misses:**",
      "",
      "| You type | You'll see | Try instead |",
      "|---|---|---|",
      ...misses.map(
        (c) =>
          `| ${quoted(md(c.phrase))}${c.note ? ` (${c.note})` : ""} | ${md(seenFor(observe(c)))} | ${quoted(md(c.fix ?? ""))}${c.category === "look" && c.phrase === c.fix ? " with a Style photo attached" : ""} |`,
      ),
      "",
    );
  }

  out.push(
    "## Not yet",
    "",
    ...NOT_YET.map((l) => `- ${l}`),
    "",
    "## Testing locally",
    "",
    "Turn these on in the server's `.env`, then restart the server. The app's own switches are already on in",
    "`.env.development`.",
    "",
    "| Server switch | What it opens |",
    "|---|---|",
    ...SERVER_FLAGS.map(([f, w]) => `| \`${f}=true\` | ${w} |`),
    "",
    "## Appendix — for engineers",
    "",
    "Each phrase → the route the rules give it at this tip (observed, not typed), the route switches it needs (each",
    "switched off alone, and the route moved), and the line that decides it. Routes are `op[targets]=value`,",
    "`@placement` for text; an ask is `ASK <code>`.",
    "",
    "| Phrase | Category | Route | Needs switch | Decided at |",
    "|---|---|---|---|---|",
  );
  for (const c of data.cases) {
    const observed = observe(c);
    const flags = routeFlagsFor(c);
    const extra = [
      ...(c.styles ? ["STUDIO_STYLE_SPEC"] : []),
      ...(/ · ad=/.test(observed) ? ["STUDIO_INTERPRETER"] : []),
    ];
    const where = whereOf(observed, flags.includes("STUDIO_IMAGE_OPS"))
      .map(at)
      .join(", ");
    out.push(
      `| ${quoted(md(c.phrase))}${c.styles ? " + Style" : ""} | ${c.category} | ${quoted(md(observed))} | ${[...flags, ...extra].join(", ") || "—"} | ${where} |`,
    );
  }
  out.push(
    "",
    "**Prices** are `estimateCost` (" +
      at("priceToken") +
      ") on the model each kind runs: an edit sends one reference (her photo); a new image with 0, 1 or 3",
    "person references (" +
      at("priceRefs") +
      "); a crop is `" +
      MODELS.crop +
      "` (" +
      at("cropModel") +
      ").",
    "",
  );
  return out.join("\n");
}
