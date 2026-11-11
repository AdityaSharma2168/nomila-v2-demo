/**
 * studio/agent/capabilityEntries — the capability library the planner plans against (PR 6, 6a1).
 *
 * The spec (docs/specs/studio-video-use-cases.md:690-698): every entry carries the same fields — what
 * it does, when it works and when it doesn't, what input it needs, its cost, its quality risk — "the
 * agent plans against these fields, never against a hard-coded list", and every choice records its
 * reason. These are COMMITTED CONSTANTS, the beds/tracks pattern, not database rows: an entry changes
 * in a reviewed diff, beside the ledger line that justifies it.
 *
 * ─── EVERY RELIABILITY CLAIM CITES A MEASURED LINE ──────────────────────────────────────────────
 *
 * `reliability.cites` are `{ file, line, quote }`: the quote must be ON that line of that file, and
 * capabilityEntries.test.ts reads each one. An entry cannot claim a number the ledger does not hold,
 * and a ledger edit that moves the line reds the suite instead of leaving the entry pointing at
 * nothing. What was never measured says so (`measured: false`) — her Instagram clips have a live N
 * of 0 — rather than borrowing a neighbour's number.
 *
 * ─── COST IS READ FROM THE REGISTRY, NEVER COPIED ───────────────────────────────────────────────
 *
 * A generated entry names its model (`cost.model`, a key of MODELS); the price is whatever
 * studio/config's registry says at render time, so a price change cannot leave the planner reading a
 * stale figure. Stills, holds, trims and grades are $0 — nothing is generated.
 *
 * ─── NAMES ARE SCOPED TO THEIR FIELD (PR 6 naming contract, docs/probes/photos-motion.md:12-23) ─
 *
 * A held photo's motion is `image.motion` = dolly | zoom | sweep | punch. A generated shot's camera
 * is `shot.movement`, the §8 vocabulary in studio/agent/capabilities.ts — which ALSO has "dolly" and
 * "pan". So a wire word alone is ambiguous by design, and an entry is addressed by `field` + `wire`,
 * never by the bare word (decision 1, PR 6 opening report). "pan" on an image item is the pre-PR-6
 * spelling of dolly and is read as dolly (studio/video/stillMotion `STILL_MOTION_ALIASES`); it is never
 * written.
 *
 * GATES ARE NOT ENTRIES. A1b, A2, S1, S1b and the camera-first order live in studio/agent/cast.ts and
 * veto whatever an entry's fields make attractive. An entry may describe a gate's effect
 * (`failureModes`) so the planner is not surprised by it; it never replaces one.
 *
 * ─── ONE LIBRARY, MORE THAN ONE PLANNER (capability layer v3, PR 1a) ────────────────────────────
 *
 * Post kits plan against this same library; there is no second list. An entry says which planners
 * may use it (`surfaces`; `onBoard` is derived from it so Board code does not move), which job it
 * belongs to (`group`, how the block is grouped), what settings it takes (`params`: fixed choice
 * lists wherever there is a choice), whether the app applies it on its own (`auto`), which flag must
 * be on for it to exist here (`flag`, and `surfaceFlags` for an entry live on one planner and still
 * coming on another), which post formats it fits, which per-post facts it needs to be worth showing
 * (`requires`), and the refusals a planner may get back (each naming what to do instead). An entry's
 * words must be true on EVERY surface it lists — otherwise it is split (music.mood beside
 * music.track, look.preset beside look) — and they never name an engine: that is
 * studio/capabilityRoutes.ts's job alone (a word-list test holds it).
 *
 * A capability flag is read STRICTLY (exactly "true"; the STUDIO_ALL_ON master never reaches it):
 * an entry the planner sees is a promise it acts on, so it turns on in the PR that builds it.
 */
import { z } from "zod";
import { LOOK_PRESETS, POST_FORMATS } from "../../../shared/postKit";
import { TRACK_MOODS } from "../music/tracks";
import { PLAN_ITEM_KINDS } from "./types";
import { PROVENANCES } from "./provenance";

// ─── The fields an entry addresses ──────────────────────────────────────────────────────────────

/**
 * Where an entry's `wire` value is written. `item.kind` — a plan item's kind; `image.motion` — a held
 * photo's move; `plan.*` — one value for the whole plan. `plan.caption` has no Board control yet
 * (PR 6 gap list), so its entries are `onBoard: false`.
 */
export const ENTRY_FIELDS = [
  "item.kind",
  "image.motion",
  "plan.music",
  "plan.look",
  "plan.caption",
  // Capability layer v3: a clip beat's finish (steadying, slow motion), a photo beat's finish (cut-out,
  // a placed background), and the one opening card of a post.
  "clip.finish",
  "image.finish",
  "plan.card",
] as const;
export type EntryField = (typeof ENTRY_FIELDS)[number];

/** The planners that read the library. `mila` lists entries only once Mila can offer them. */
export const SURFACES = ["board", "post_kit", "mila"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * What an entry is for — the block prints one short list per group, so the planner reads alternatives
 * side by side (design §3 rule 1). `looks` holds the plan.look entries. Looks join the library as ONE entry
 * whose `name` setting is a fixed list of look ids (look.preset today), never one entry per look: a list of
 * near-identical entries breaks rule 1, and the block prints one entry's list on one line. Reconciling the
 * Board's and the kits' lists into one (decision 1e) changes that list, not the shape.
 */
export const ENTRY_GROUPS = [
  "shots",
  "photo_moves",
  "clip_moves",
  "cards",
  "sound",
  "looks",
  "finishing",
  "paid",
] as const;
export type EntryGroup = (typeof ENTRY_GROUPS)[number];

/**
 * The per-post facts an entry needs before it is worth showing (design §3 rule 4: load only what is
 * relevant). A fact that is not known never hides an entry — only a fact known to be false does.
 */
export const ENTRY_REQUIREMENTS = [
  "photo_candidate",
  "clip_candidate",
  "clip_fps_59",
  "moment_ahead",
] as const;
export type EntryRequirement = (typeof ENTRY_REQUIREMENTS)[number];

/** A held photo's move — the renderer's own wire names (studio/video/stillMotion), "pan" read as dolly. */
export {
  STILL_MOTIONS as IMAGE_MOTIONS,
  readStillMotion as readImageMotion,
  type StillMotion as ImageMotion,
} from "../video/stillMotion";

// ─── The schema ─────────────────────────────────────────────────────────────────────────────────

export const citeSchema = z
  .object({
    /** Repo-relative: a ledger under docs/, or the code line that holds the fact. */
    file: z.string().regex(/^(docs|server)\/[\w./-]+$/),
    line: z.number().int().positive(),
    /** A substring of that line, verbatim. */
    quote: z.string().min(8),
  })
  .strict();
export type Cite = z.infer<typeof citeSchema>;

const costSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("free"), why: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("registry"),
      /** A key of studio/config MODELS — the price is the registry's at render time. */
      model: z.enum(["veo", "seedance", "seedanceFast"]),
      /** Veo bills the audio arm when the item asks for sound. */
      audioArm: z.boolean(),
    })
    .strict(),
]);
export type EntryCost = z.infer<typeof costSchema>;

/** One setting: a fixed list, bounded text, a bounded number, or a switch. */
export const paramSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("enum"),
      values: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ kind: z.literal("text"), max: z.number().int().positive() }).strict(),
  z
    .object({ kind: z.literal("number"), min: z.number(), max: z.number() })
    .strict(),
  z.object({ kind: z.literal("boolean") }).strict(),
]);
export type EntryParam = z.infer<typeof paramSchema>;

const refusalSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /**
     * Plain words that name what to do instead — never a dead end (design §3 rule 5). They never name another
     * entry: an entry the planner could switch to goes in `orUse`, printed only where that entry is available.
     */
    message: z.string().min(1).max(200),
    /** Another entry to suggest, and the words after its id ("on a photo of the peak"). Left off where it is off. */
    orUse: z
      .object({
        entry: z.string().min(1),
        words: z.string().min(1).max(80),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EntryRefusal = z.infer<typeof refusalSchema>;

const flagName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const entrySchema = z
  .object({
    /** Stable, dotted, field-scoped: `clip.camera`, `image.motion.zoom`. What a plan item's reason names. */
    id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/),
    field: z.enum(ENTRY_FIELDS),
    /** The value written into `field` when this entry is chosen. */
    wire: z.string().min(1),
    /** The plan item kind this entry makes, when `field` is item-level. */
    itemKind: z.enum(PLAN_ITEM_KINDS).nullable(),
    /** Which of her sources it casts from, when that is what distinguishes it. */
    provenance: z.enum(PROVENANCES).nullable(),
    does: z.string().min(1).max(200),
    needs: z.string().min(1).max(160),
    cost: costSchema,
    /** none: nothing of her is generated. high: a model draws her, so it can draw someone else. */
    likenessRisk: z.enum(["none", "low", "high"]),
    reliability: z
      .object({
        measured: z.boolean(),
        summary: z.string().min(1).max(240),
        cites: z.array(citeSchema).min(1),
      })
      .strict(),
    whenItWorks: z.string().min(1).max(240),
    failureModes: z.array(z.string().min(1).max(200)).max(4),
    /** A Board control exists for it (PR 6 gap list: captions and text graphics have none). Derived: `surfaces` holds "board". */
    onBoard: z.boolean(),
    /** The planners that may use it. */
    surfaces: z.array(z.enum(SURFACES)),
    group: z.enum(ENTRY_GROUPS),
    /** Its settings, each a fixed choice list wherever there is a choice (design §3 rule 2). */
    params: z.record(z.string().regex(/^[a-z][a-zA-Z_]*$/), paramSchema),
    /** The app applies it whenever its needs are met; the planner is told, never asked. */
    auto: z.boolean(),
    /** A flag that must be exactly "true" for it to exist anywhere, or null. */
    flag: flagName.nullable(),
    /** A flag that must be on for it to exist on one surface (live on the Board, coming to post kits). */
    surfaceFlags: z.record(z.enum(SURFACES), flagName),
    /** The post formats it fits, or null for any. */
    formats: z.array(z.enum(POST_FORMATS)).min(1).nullable(),
    requires: z.array(z.enum(ENTRY_REQUIREMENTS)),
    /** What a planner gets back when a step is refused: a code, and a sentence naming what to do instead. */
    refusals: z.array(refusalSchema).max(4),
    /** At most two short examples — only where an eval shows the planner gets the entry wrong. */
    examples: z.array(z.string().min(1).max(200)).max(2),
  })
  .strict()
  .refine(
    (e) => e.onBoard || e.field === "plan.caption" || e.itemKind === null,
    {
      message:
        "an entry the Board cannot hold must not be a plan item kind the planner may emit",
    },
  )
  .refine((e) => e.onBoard === e.surfaces.includes("board"), {
    message: "onBoard is derived from surfaces",
  })
  .refine(
    (e) =>
      Object.keys(e.surfaceFlags).every((s) =>
        e.surfaces.includes(s as Surface),
      ),
    { message: "a surface flag names a surface the entry is on" },
  )
  // Tap-to-send: the app never spends on its own. A paid entry is only ever a button she taps, so it is
  // never automatic (the block would state it as something the app just does).
  .refine((e) => !e.auto || (e.cost.kind === "free" && e.group !== "paid"), {
    message: "an automatic entry is free: a paid one is only ever her tap",
  });
export type CapabilityEntry = z.infer<typeof entrySchema>;

/** The fields an entry may leave out: they default to "nothing special", so Aditya's entries read as they did. */
type Defaulted =
  | "params"
  | "auto"
  | "flag"
  | "surfaceFlags"
  | "formats"
  | "requires"
  | "refusals"
  | "examples";

/** What an entry is written as: everything but the derived `onBoard`, the new fields optional. */
type RawEntry = Omit<CapabilityEntry, "onBoard" | Defaulted> &
  Partial<Pick<CapabilityEntry, Defaulted>>;

const loadEntry = (e: RawEntry): CapabilityEntry =>
  entrySchema.parse({
    params: {},
    auto: false,
    flag: null,
    surfaceFlags: {},
    formats: null,
    requires: [],
    refusals: [],
    examples: [],
    ...e,
    onBoard: e.surfaces.includes("board"),
  });

// ─── The entries ────────────────────────────────────────────────────────────────────────────────

const cite = (file: string, line: number, quote: string): Cite => ({
  file,
  line,
  quote,
});
const EE = "docs/probes/enrich-eval.md";
const C3 = "docs/probes/c3-doctrine2.md";
const IF = "docs/probes/ingest-flip.md";
const PM = "docs/probes/photos-motion.md";
const MF = "docs/probes/music-fonts.md";
const CL = "docs/probes/capability-layer.md";
const FREE = (why: string): EntryCost => ({ kind: "free", why });

const RAW_ENTRIES: RawEntry[] = [
  {
    id: "clip.camera",
    field: "item.kind",
    wire: "clip",
    itemKind: "clip",
    provenance: "camera",
    does: "A window of a clip she filmed, trimmed to the beat it covers.",
    needs: "A CLIP line from her camera whose beats cover the moment.",
    cost: FREE("a trim of her own footage — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary:
        "On own-footage recaps it fills every slot it can: 10 of 10 on one plan, 26 of 26 cast slots over two briefs.",
      cites: [
        cite(EE, 779, "Ten of ten slots her camera clip"),
        cite(C3, 213, "Every cast photo or clip is her camera — 26 of"),
      ],
    },
    whenItWorks:
      "Any moment her camera covers. The first choice for a shot of her doing the thing.",
    failureModes: [
      "Holds none of an ad's hero opening, product or sign-off — the beats are what she filmed.",
    ],
    surfaces: ["board", "post_kit"],
    group: "shots",
    formats: ["reel", "story", "carousel"],
    requires: ["clip_candidate"],
  },
  {
    id: "clip.her_instagram",
    field: "item.kind",
    wire: "clip",
    itemKind: "clip",
    provenance: "synced",
    does: "A window of a reel she posted, synced from her Instagram, trimmed to a beat.",
    needs: "A CLIP line marked her instagram.",
    cost: FREE("a trim of her own posted footage"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary:
        "Unmeasured: the test athlete holds no stored Instagram video, so the live N is 0.",
      cites: [
        cite(IF, 97, "the live N is **0** on the test athlete"),
        cite(
          IF,
          288,
          "zero synced / connected rows in the library on every run",
        ),
      ],
    },
    whenItWorks:
      "After her camera: it is her footage, but cut for a feed, often with text on it.",
    failureModes: [
      "Absent for most athletes today — plan as if it may not exist.",
    ],
    surfaces: ["board", "post_kit"],
    group: "shots",
    formats: ["reel", "story", "carousel"],
    requires: ["clip_candidate"],
  },
  {
    id: "clip.made_here",
    field: "item.kind",
    wire: "clip",
    itemKind: "clip",
    provenance: "made-here",
    does: "A window of a clip made in the Studio earlier.",
    needs: "A CLIP line marked made here.",
    cost: FREE("already made — reusing it spends nothing"),
    likenessRisk: "high",
    reliability: {
      measured: true,
      summary:
        "Cast on the ad brief when no camera beat fit (2 of 2 cells); a made-here clip may not show her at all.",
      cites: [cite(IF, 285, "ebe01971 · made-here · clip")],
    },
    whenItWorks:
      "Last among clips: only where neither her camera nor her Instagram covers the moment.",
    failureModes: [
      "It was generated, so it can show someone who is not her.",
      "On a brief asking for her own footage it is never used unless she picked it (S1c) — it is left out.",
    ],
    surfaces: ["board"],
    group: "shots",
  },
  {
    id: "image.held",
    field: "item.kind",
    wire: "image",
    itemKind: "image",
    provenance: null,
    does: "One of her photos held on screen, dead still.",
    needs:
      "A photo line; on an own-footage brief, a photo from her camera or one she picked.",
    cost: FREE("her photo, held — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary:
        "Renders in about half a second for a 4 s hold. Made-here and meta images are refused by the gates, not by taste.",
      cites: [
        cite(C3, 25, "measured 0.43–0.56 s wall for a 4 s 1080×1920 clip"),
        cite(IF, 248, "`image` and `i2v` unless `picked`"),
      ],
    },
    whenItWorks:
      'A moment her clips do not cover, told by a photo of it. Prefer a pushed-in "image" over an "i2v" when the moment is a look, a pose or a place rather than an action.',
    failureModes: [
      "On an own-footage brief a made-here photo is swapped or left out (S1b).",
      "A screenshot, mockup or colour block is never cast unless she picked it (A2).",
    ],
    surfaces: ["board", "post_kit"],
    group: "shots",
    requires: ["photo_candidate"],
  },
  {
    id: "image.motion.dolly",
    field: "image.motion",
    wire: "dolly",
    itemKind: null,
    provenance: null,
    does: "A slow centred push-in on a held photo — the frame ends 8% larger than it starts.",
    needs: "An image item.",
    cost: FREE("an ffmpeg move on her photo"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary:
        "The push-in A1b holds an own-footage i2v as; the renderer's quietest move.",
      cites: [
        cite("server/studio/video/still.ts", 78, "PAN_PUSH_IN = 0.08"),
        cite(PM, 14, "(D2's centred push-in"),
      ],
    },
    whenItWorks:
      "The fallback: a held photo with nothing in particular to arrive at, that should read as alive rather than as a slide. One thing to land on wants zoom; a wide frame wants sweep; a peak on a beat wants punch — dolly where none fits.",
    failureModes: [
      "Not a shot of her moving — that is an i2v, and it is not one.",
      "On a photo with a clear subject it wastes the arrival a zoom would make.",
    ],
    surfaces: ["board", "post_kit"],
    group: "photo_moves",
    // Live on the Board; a kit preview holds photos still until PR 3 moves them. Their words stay the Board's,
    // byte for byte, until then (the planner fingerprint is pinned): PR 3 makes them engine-free and true for kits
    // ("a held photo", no gate code), re-pins the fingerprint and re-runs the Board plan eval.
    surfaceFlags: { post_kit: "STUDIO_CAP_KIT_MOTION" },
    formats: ["reel", "story"],
    requires: ["photo_candidate"],
  },
  {
    id: "image.motion.zoom",
    field: "image.motion",
    wire: "zoom",
    itemKind: null,
    provenance: null,
    does: "The frame closes in on a point of the photo.",
    needs: "An image item; a focus point, or the upper-middle framing prior.",
    cost: FREE("an ffmpeg move on her photo"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary:
        "Untapped, it heads for the upper middle — within ~0.1 of her face in 8 of 8 portraits; give a focus point when the thing to arrive at sits elsewhere.",
      cites: [
        cite(PM, 44, "MISSED, 0 of 8"),
        cite(PM, 47, "(0.5, 0.28) in all 8"),
      ],
    },
    whenItWorks:
      "A photo with one thing to arrive at — her face, a medal, the product.",
    failureModes: [
      "With no point and a busy frame it lands on the upper middle, whatever is there — a saliency point found her 0 of 8, so the prior is not a person finder.",
    ],
    surfaces: ["board", "post_kit"],
    group: "photo_moves",
    // Live on the Board; a kit preview holds photos still until PR 3 moves them. Their words stay the Board's,
    // byte for byte, until then (the planner fingerprint is pinned): PR 3 makes them engine-free and true for kits
    // ("a held photo", no gate code), re-pins the fingerprint and re-runs the Board plan eval.
    surfaceFlags: { post_kit: "STUDIO_CAP_KIT_MOTION" },
    formats: ["reel", "story"],
    requires: ["photo_candidate"],
  },
  {
    id: "image.motion.sweep",
    field: "image.motion",
    wire: "sweep",
    itemKind: null,
    provenance: null,
    does: "A move across the photo's long axis at a fixed size, toward the point's side.",
    needs: "An image item; a focus point, or it crosses from the left.",
    cost: FREE("an ffmpeg move on her photo"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary: "Same framing prior as zoom; the Board calls it Pan.",
      cites: [cite(PM, 47, "(0.5, 0.28) in all 8")],
    },
    whenItWorks:
      "A wide photo — a pitch, a line-up, a place — where the eye should travel.",
    failureModes: ["On a tight portrait it has nowhere to go."],
    surfaces: ["board", "post_kit"],
    group: "photo_moves",
    // Live on the Board; a kit preview holds photos still until PR 3 moves them. Their words stay the Board's,
    // byte for byte, until then (the planner fingerprint is pinned): PR 3 makes them engine-free and true for kits
    // ("a held photo", no gate code), re-pins the fingerprint and re-runs the Board plan eval.
    surfaceFlags: { post_kit: "STUDIO_CAP_KIT_MOTION" },
    formats: ["reel", "story"],
    requires: ["photo_candidate"],
  },
  {
    id: "image.motion.punch",
    field: "image.motion",
    wire: "punch",
    itemKind: null,
    provenance: null,
    does: "A fast close-in to a point, then held — a snap on the peak.",
    needs: "An image item; a focus point, or the framing prior.",
    cost: FREE("an ffmpeg move on her photo"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary:
        "Same framing prior as zoom; lands on a beat when the plan is on the beat.",
      cites: [cite(PM, 47, "(0.5, 0.28) in all 8")],
    },
    whenItWorks: "A hype edit's peak — the goal, the result — set on a beat.",
    failureModes: ["In a slow, reflective edit it reads as a jolt."],
    surfaces: ["board", "post_kit"],
    group: "photo_moves",
    // Live on the Board; a kit preview holds photos still until PR 3 moves them. Their words stay the Board's,
    // byte for byte, until then (the planner fingerprint is pinned): PR 3 makes them engine-free and true for kits
    // ("a held photo", no gate code), re-pins the fingerprint and re-runs the Board plan eval.
    surfaceFlags: { post_kit: "STUDIO_CAP_KIT_MOTION" },
    formats: ["reel", "story"],
    requires: ["photo_candidate"],
  },
  {
    id: "i2v",
    field: "item.kind",
    wire: "i2v",
    itemKind: "i2v",
    provenance: null,
    does: "One of her photos brought to life as a short generated shot of her moving.",
    needs:
      "A photo she is in — her camera, synced, or one she picked; a made-here still only when identity-bound.",
    cost: { kind: "registry", model: "veo", audioArm: true },
    likenessRisk: "high",
    reliability: {
      measured: true,
      summary:
        "A model draws her: a generated still with no person reference was cast as her once. On an own-footage brief it is held pushed-in instead ($0).",
      cites: [
        cite(C3, 16, "The lookalike is `a6a8b954`"),
        cite(IF, 18, "so an i2v is held pushed-in on the same photo ($0)"),
        cite("server/studio/config.ts", 654, "usd: 0.2, usdWithAudio: 0.4"),
      ],
    },
    whenItWorks:
      "She asked for her in motion and no clip of her camera covers that moment.",
    failureModes: [
      "Can draw someone who is not her.",
      "On an own-footage brief it never runs — A1b holds the photo pushed in.",
      "Complex action (three defenders, a top-corner finish) is where it invents.",
    ],
    surfaces: ["board"],
    group: "paid",
  },
  {
    id: "broll",
    field: "item.kind",
    wire: "broll",
    itemKind: "broll",
    provenance: null,
    does: "A generated shot made from words alone — a place, an object, an atmosphere. Never her.",
    needs: "Nothing from her library: a direction.",
    cost: { kind: "registry", model: "seedanceFast", audioArm: false },
    likenessRisk: "low",
    reliability: {
      measured: true,
      summary:
        "Refuses real people by policy, so it cannot be her. On own-footage briefs it opened or bridged 3 of 12 cells unasked.",
      cites: [
        cite("server/studio/config.ts", 193, "$0.0914/s against Veo's $0.20/s"),
        cite("server/studio/config.ts", 195, "real-person image-to-video 6/6"),
        cite(C3, 229, "3 of 12 cells ($0.61 each)"),
      ],
    },
    whenItWorks:
      "A gap no footage of hers covers and no person is needed for — the stadium, the gear, the city.",
    failureModes: [
      "An opener on a recap is not a gap: it stands in front of her own footage.",
      "Anything that needs her in it.",
    ],
    surfaces: ["board"],
    group: "paid",
  },
  {
    id: "product",
    field: "item.kind",
    wire: "product",
    itemKind: "product",
    provenance: null,
    does: "A shot of the product she named, made from its photo.",
    needs: "A product photo she added to the plan.",
    cost: { kind: "registry", model: "seedance", audioArm: false },
    likenessRisk: "low",
    reliability: {
      measured: true,
      summary:
        "Ran with a real product-only upload from round 2 on; a product photo with her hand in it is made as a shot of her.",
      cites: [cite(C3, 21, "BOLYN product-only upload: `e64e900a`")],
    },
    whenItWorks: "A brand brief with a product to show.",
    failureModes: [
      "With her in the product photo it is an identity shot and costs as one.",
    ],
    surfaces: ["board"],
    group: "paid",
  },
  {
    id: "text_graphic",
    field: "plan.caption",
    wire: "text_graphic",
    itemKind: null,
    provenance: null,
    does: "A title card or graphic — words on a plate.",
    needs: "A Board row type that does not exist yet.",
    cost: FREE("would be rendered, not generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary:
        "Not plannable: no plan kind and no Board row. Her library's text graphics are meta images the gates refuse unpicked.",
      cites: [cite(IF, 239, '`vision.shot_type === "text_graphic"`')],
    },
    whenItWorks: "Not yet — PR 6 gap list.",
    failureModes: ["Cannot be planned today."],
    surfaces: [],
    group: "cards",
  },
  {
    id: "caption",
    field: "plan.caption",
    wire: "caption",
    itemKind: null,
    provenance: null,
    does: "The post's hook laid over the opening of a reel or story, inside the safe zones.",
    needs: "A hook of 80 characters or fewer with nothing in it the post must avoid.",
    cost: FREE("rendered, not generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary:
        "As a kit choice: a hook with a character the font cannot draw is left off, with a note.",
      cites: [
        cite(CL, 14, "caption (post kits) — NOT measured"),
        cite(
          "server/agent/postKit/render/compile.ts",
          317,
          'notes.push("overlay_not_drawable")',
        ),
      ],
    },
    whenItWorks:
      "Every reel and story: the app lays the hook over the opening, so the first second says what the post is.",
    failureModes: ["A feed post or carousel carries no words on the picture."],
    surfaces: ["post_kit"],
    group: "finishing",
    auto: true,
    formats: ["reel", "story"],
  },
  {
    id: "music.track",
    field: "plan.music",
    wire: "track",
    itemKind: null,
    provenance: null,
    does: "One licensed track under the whole edit, cut on its beat grid when on the beat.",
    needs: "A track from the catalogue; brand work only sees brandSafe tracks.",
    cost: FREE("licensed, already in the bucket"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary:
        "Grids measured to 0.01 BPM and ≤ 6 ms; one track's second half sits half a period off.",
      cites: [
        cite(PM, 49, "held, with margin (0.01 BPM, ≤ 6 ms on"),
        cite(MF, 33, "❌ half B 327 ms off (half a period)"),
        cite(MF, 19, "Brand work is fail-closed off the objective."),
      ],
    },
    whenItWorks: "Any edit; the four tracks run 84–120 BPM.",
    failureModes: ["No track between 90 and 114 BPM, and none above 120."],
    surfaces: ["board"],
    group: "sound",
  },
  {
    id: "music.bed",
    field: "plan.music",
    wire: "bed",
    itemKind: null,
    provenance: null,
    does: "One of six CC0 beds under the whole edit.",
    needs: "A bed name.",
    cost: FREE("CC0, already in the bucket"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary:
        "Five of six sit at 76–85 BPM, one at 63; the by-ear check against the grid is pending.",
      cites: [cite(PM, 73, "grid: PENDING.")],
    },
    whenItWorks: "A calm or reflective edit — the beds are slow.",
    failureModes: [
      "Nothing fast enough for a hype edit.",
      "No mood tags yet — chosen by name, not feel.",
    ],
    surfaces: ["board"],
    group: "sound",
  },
  {
    id: "look",
    field: "plan.look",
    wire: "look",
    itemKind: null,
    provenance: null,
    does: "One grade on every held photo — natural, warm, cool, teal-orange, muted or mono.",
    needs: "At least one held photo on the Board.",
    cost: FREE("one image operation per photo"),
    likenessRisk: "none",
    reliability: {
      measured: true,
      summary:
        "Warm and cool casts held within 6/255; clips are not graded, only stills.",
      cites: [
        cite(PM, 53, "warm and cool casts within 6/255 under Natural:** held."),
        cite("server/studio/video/still.ts", 440, "Clips are not graded here"),
      ],
    },
    whenItWorks: "An edit with held photos that should share one feel.",
    failureModes: [
      "A clip beside a graded still keeps its own colour — the two can clash.",
    ],
    surfaces: ["board"],
    group: "looks",
  },
];

// ─── The capability layer's entries (design v3 §1, PR 1a) ───────────────────────────────────────
//
// Post kits' own lines, and the nine the layer adds before launch. Everything here is $0: nothing is
// generated, her own pixels and frames are kept. An entry whose capability is not built yet carries
// its flag, OFF until the PR that builds it turns it on — until then the block names it once under
// "not available here yet", so no planner offers it and Mila never promises it.

const LAYER_ENTRIES: RawEntry[] = [
  {
    id: "music.mood",
    field: "plan.music",
    wire: "mood",
    itemKind: null,
    provenance: null,
    does: "The best licensed track for a mood, under the whole post.",
    needs:
      "A mood from the list; a post that names a partner only gets tracks cleared for brand work.",
    cost: FREE("licensed, already in the bucket"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary:
        "As a kit choice: the track is the catalogue's best for the mood; nobody has listened to the picks yet.",
      cites: [
        cite(CL, 12, "music.mood — NOT measured as a post-kit choice"),
        cite(
          "server/agent/postKit/render/compile.ts",
          257,
          "export function trackForMood(mood: string, forBrand: boolean)",
        ),
      ],
    },
    whenItWorks:
      "A reel or story: the mood the moment carries. none when the post should be quiet.",
    failureModes: [
      "A mood with no track cleared for this post plays no music; the preview says so.",
    ],
    surfaces: ["post_kit"],
    group: "sound",
    params: { mood: { kind: "enum", values: [...TRACK_MOODS, "none"] } },
    formats: ["reel", "story"],
    refusals: [
      {
        code: "no_track_for_mood",
        message:
          "No track carries that mood for this post. Choose another mood, or none.",
      },
    ],
  },
  {
    id: "look.preset",
    field: "plan.look",
    wire: "preset",
    itemKind: null,
    provenance: null,
    does: "One colour look on every photo and clip of the post; natural changes nothing.",
    needs: "A look name from the list.",
    cost: FREE("one colour filter — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary:
        "Each name is one fixed filter, the same on clips and photos; no cast check on clips yet.",
      cites: [
        cite(CL, 13, "look.preset — NOT measured"),
        cite("server/studio/video/look.ts", 24, "natural: null"),
      ],
    },
    whenItWorks:
      "Every post. Prefer natural unless the brief or the pictures clearly call for another.",
    failureModes: [
      "A strong look on a picture that is already filtered stacks on top of it.",
    ],
    surfaces: ["post_kit"],
    group: "looks",
    params: { name: { kind: "enum", values: [...LOOK_PRESETS] } },
  },
  {
    id: "clip.stabilise",
    field: "clip.finish",
    wire: "stabilise",
    itemKind: null,
    provenance: null,
    does: "Steadies a clip that measures shaky, trimming about 5–8% off the edges.",
    needs:
      "A kept clip that measures shaky; not a shot whose movement is shaky on purpose.",
    cost: FREE("a steadying pass on her own clip — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary: "Not yet: the steadying probe lands with its own PR.",
      cites: [cite(CL, 15, "clip.stabilise — NOT measured yet")],
    },
    whenItWorks: "Shaky phone footage of her: the app steadies it on its own.",
    failureModes: [
      "A whip pan or a handheld shot meant to feel raw is left alone when its direction says so.",
      "The edge trim can cut a hand or a ball at the frame's edge.",
    ],
    surfaces: ["post_kit"],
    group: "clip_moves",
    auto: true,
    flag: "STUDIO_CAP_STABILISE",
    formats: ["reel", "story"],
    requires: ["clip_candidate"],
  },
  {
    id: "clip.slow_mo",
    field: "clip.finish",
    wire: "slow_mo",
    itemKind: null,
    provenance: null,
    does: "Plays one moment of a clip at half or quarter speed, using the real frames.",
    needs: "A clip filmed at 59 fps or more; a moment of 1.5 s or less.",
    cost: FREE("a retime of her own clip — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary: "Not yet: the retime probe lands with its own PR.",
      cites: [cite(CL, 16, "clip.slow_mo — NOT measured yet")],
    },
    whenItWorks: "One peak: a finish, a landing, a celebration.",
    failureModes: [
      "The clip's own sound drops out for that moment while the music carries on.",
      "In a calm, talking clip it reads as a glitch.",
    ],
    surfaces: ["post_kit"],
    group: "clip_moves",
    flag: "STUDIO_CAP_SLOWMO",
    params: {
      factor: { kind: "enum", values: ["2", "4"] },
      atSec: { kind: "number", min: 0, max: 12 },
    },
    formats: ["reel", "story"],
    requires: ["clip_fps_59"],
    refusals: [
      {
        code: "fps_too_low",
        message:
          "This clip was filmed below 59 fps. Keep it at normal speed.",
        orUse: { entry: "image.motion.punch", words: "on a photo of the peak" },
      },
      {
        code: "window_too_long",
        message:
          "Slow motion holds 1.5 s or less. Choose a shorter moment, or keep the clip at normal speed.",
      },
    ],
  },
  {
    id: "caption.auto",
    field: "plan.caption",
    wire: "auto",
    itemKind: null,
    provenance: null,
    does: "Her spoken words as captions, timed to her voice, on any kept clip where she speaks.",
    needs: "A kept clip with speech.",
    cost: FREE("transcribed and drawn here — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary: "Not yet: the speech probe lands with its own PR.",
      cites: [cite(CL, 17, "caption.auto — NOT measured yet")],
    },
    whenItWorks: "Any clip where she talks to the camera or is heard clearly.",
    failureModes: [
      "Other voices near the phone can be captioned too.",
      "A clip with no speech gets no captions.",
    ],
    surfaces: ["post_kit"],
    group: "finishing",
    auto: true,
    flag: "STUDIO_CAP_CAPTIONS",
    formats: ["reel", "story"],
    requires: ["clip_candidate"],
  },
  {
    id: "image.cutout",
    field: "image.finish",
    wire: "cutout",
    itemKind: null,
    provenance: null,
    does: "Lifts her cleanly off the background of one photo.",
    needs: "A photo where she stands clear of other people.",
    cost: FREE("separated here — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary: "Not yet: the cut-out quality fixtures land with its own PR.",
      cites: [cite(CL, 18, "image.cutout — NOT measured yet")],
    },
    whenItWorks:
      "As the first half of a new background or an ad card, never on its own.",
    failureModes: [
      "Fine hair and fingers can lose detail at the edge.",
      "Someone touching her in the frame makes the cut-out fail.",
    ],
    surfaces: ["post_kit"],
    group: "finishing",
    flag: "STUDIO_CAP_CUTOUT",
    requires: ["photo_candidate"],
    refusals: [
      {
        code: "cutout_not_clean",
        message:
          "She can't be cut out cleanly from this photo. Keep its own background, or pick a photo where she stands clear.",
      },
    ],
  },
  {
    id: "image.background_place",
    field: "image.finish",
    wire: "background_place",
    itemKind: null,
    provenance: null,
    does: "Puts her, cut out, on a new background: a colour, a gradient, a scene with no people, or the partner's brand colour.",
    needs:
      "A photo she can be cut out of cleanly; brand colour only on a post that names a partner.",
    cost: FREE("composed here — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary:
        "Not yet: the placed-or-pasted check on each background lands with its own PR.",
      cites: [cite(CL, 19, "image.background_place — NOT measured yet")],
    },
    whenItWorks:
      "The original background is cluttered or off-brand, or the photo is for an ad.",
    failureModes: [
      "The place is the story — her home ground, the finish line.",
      "Light and shadow come from the original photo, so a detailed scene can look pasted on; prefer a colour or gradient for close portraits.",
      "A scene never names a real place, and the caption must not say she was there.",
    ],
    surfaces: ["post_kit"],
    group: "finishing",
    flag: "STUDIO_CAP_CUTOUT",
    params: {
      source: {
        kind: "enum",
        values: ["colour", "gradient", "scene", "brand_colour"],
      },
      sceneTags: { kind: "text", max: 80 },
    },
    requires: ["photo_candidate"],
    refusals: [
      {
        code: "cutout_not_clean",
        message:
          "She can't be cut out cleanly from this photo. Keep its own background, or pick a photo where she stands clear.",
      },
      {
        code: "brand_colour_without_partner",
        message:
          "Brand colour needs a post that names a partner. Use colour or gradient instead.",
      },
    ],
  },
  {
    id: "card.ad.cutout_hero",
    field: "plan.card",
    wire: "ad.cutout_hero",
    itemKind: null,
    provenance: null,
    does: "A finished ad still: her on a placed background, a headline, and the partner's logo when the post names one.",
    needs:
      "A new background on the same photo; a headline of 40 characters or fewer.",
    cost: FREE("composed here — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary: "Not yet: the logo and headline checks land with its own PR.",
      cites: [cite(CL, 20, "card.ad.cutout_hero — NOT measured yet")],
    },
    whenItWorks: "A partner post built on one strong photo of her.",
    failureModes: ["A recap or a moment post: an ad reads as selling."],
    surfaces: ["post_kit"],
    group: "cards",
    flag: "STUDIO_CAP_CUTOUT",
    params: { headline: { kind: "text", max: 40 } },
    formats: ["feed", "story"],
    requires: ["photo_candidate"],
    refusals: [
      {
        code: "headline_too_long",
        message:
          "The headline holds 40 characters or fewer. Shorten it, or leave the card out.",
      },
    ],
  },
  {
    id: "card.title",
    field: "plan.card",
    wire: "title",
    itemKind: null,
    provenance: null,
    does: "A 2-second opening card with the hook, over the first shot dimmed.",
    needs: "A hook of 40 characters or fewer.",
    cost: FREE("rendered here — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary: "Not yet: render time and text fit land with its own PR.",
      cites: [cite(CL, 21, "card.title — NOT measured yet")],
    },
    whenItWorks: "The hook reads better as words than as a picture.",
    failureModes: ["The first shot already says it — the card only delays her."],
    surfaces: ["post_kit"],
    group: "cards",
    flag: "STUDIO_CAP_CARDS",
    params: { text: { kind: "text", max: 40 } },
    formats: ["reel", "story"],
    refusals: [
      {
        code: "text_too_long",
        message:
          "The card holds 40 characters or fewer. Shorten the line, or leave the card out.",
      },
    ],
  },
  {
    id: "card.countdown",
    field: "plan.card",
    wire: "countdown",
    itemKind: null,
    provenance: null,
    does: 'An opening "N days to [moment]" card; the number is worked out when the preview is made.',
    needs: "A dated moment still ahead.",
    cost: FREE("rendered here — nothing is generated"),
    likenessRisk: "none",
    reliability: {
      measured: false,
      summary: "Not yet: the day count and re-render checks land with its own PR.",
      cites: [cite(CL, 22, "card.countdown — NOT measured yet")],
    },
    whenItWorks: "A build-up post before a dated moment.",
    failureModes: ["A recap, or a post not tied to a date."],
    surfaces: ["post_kit"],
    group: "cards",
    flag: "STUDIO_CAP_CARDS",
    formats: ["reel", "story"],
    requires: ["moment_ahead"],
    refusals: [
      {
        code: "no_moment_ahead",
        message:
          "This post has no dated moment ahead. Leave the card out.",
        orUse: { entry: "card.title", words: "instead" },
      },
    ],
  },
];

/** Parsed at load: a malformed entry is a crash at import, never a quietly wrong prompt. */
export const CAPABILITY_ENTRIES: readonly CapabilityEntry[] = [
  ...RAW_ENTRIES,
  ...LAYER_ENTRIES,
].map(loadEntry);

export const ENTRY_IDS: ReadonlySet<string> = new Set(
  CAPABILITY_ENTRIES.map((e) => e.id),
);
export const entryById = (id: string): CapabilityEntry | undefined =>
  CAPABILITY_ENTRIES.find((e) => e.id === id);

/**
 * The fixed list one setting of an entry allows — what a planner's output schema enumerates, read off the library so
 * the block and the schema can never disagree. Throws when the entry or its list does not exist: a schema built on a
 * missing list is a crash at load, never a quietly open field.
 */
export function paramValues(entryId: string, param: string): string[] {
  const p = entryById(entryId)?.params[param];
  if (!p || p.kind !== "enum")
    throw new Error(`${entryId} has no fixed list "${param}"`);
  return [...p.values];
}
