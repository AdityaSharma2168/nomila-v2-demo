/**
 * studio/brief — the CreativeBrief every generation reads from.
 *
 * One function, `assembleBrief(input)`, turns "make something for this athlete" into a single typed
 * object carrying everything a generation needs: who she is, who the brand is, what the job is, and
 * — critically — what we DON'T have. It is mostly assembly, not invention: the athlete half comes
 * from `getAthleteContext` and the brand half from `getBrandContext`, both owned by the pitch-deck
 * engine and read here, never modified.
 *
 * Like those two, this is a PURE READ: SELECTs only, no model call, no write. That matters because
 * the brief is built before the athlete has agreed to spend anything, and a pre-generation check
 * that itself costs money or mutates state is not a check.
 *
 * TWO THINGS THE A1 SPIKE PROVED, MADE STRUCTURAL
 *
 * 1. THE EDIT/GENERATE FORK (`job.mode`). These are different primitives, not one path with a flag.
 *    An `edit` has a real frame that must survive — the deliverable is the original file with a patch
 *    in it, and the spike measured 99.6% of a 4000x6000 frame staying bit-identical when it is done
 *    as a masked composite. A `generate` has no frame to preserve and full generation is correct.
 *    The spike's headline failure was running an edit as a generate: it returned a re-composed
 *    848x1264 image that could never be intercut with the real footage. Downstream branches entirely
 *    on this field, so it is required, and `edit` without a source asset is rejected outright.
 *
 * 2. PER-PIECE PRODUCT REFERENCES (`brand.pieces[].reference`). The spike's one unfixable miss was a
 *    charm that measured ~70px in the source frame: the model cannot render a product detail it has
 *    no clean reference for, and given a soft one it invents a different product — which is worse
 *    than a soft real photo, because it is convincing. So every named piece carries a reference SLOT.
 *    Today almost none are filled (see readBrandExtras), and the brief says so in `gaps` rather than
 *    pretending coverage. When a brand sends a real SKU photograph, that is a data change here, not
 *    an architecture change.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { inboxBrands } from "../../shared/schema";
import { getAthleteContext, type AthleteContext } from "../services/athleteContext";
import { getBrandContext, type BrandContext } from "../services/shotList";
import { createLogger } from "../logger";
import { namesSport } from "./sportVocab";
import { GenerationError, normalizeShotSpec, type ShotSpec } from "./types";
import type { FrozenEditIntent } from "./nativeEdit";
import type { DescribedLine } from "./compile";
import type { InterpretationRecord } from "./interpret/interpret";
import type { JobCampaign } from "./campaign/carrier";
import type { StyleSpec } from "./reference/styleSpec";
import type { FrozenTemplate } from "./templates/render";
import type { GateReason } from "./gateVocab";

const logger = createLogger("studio/brief");

// ─── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/**
 * Where the job came from. This is the "two entry points" the product has, modelled as a field
 * rather than two functions so both directions converge on one CreativeBrief and downstream code
 * never has to ask which door it came through.
 *
 *   system  — we author for the athlete. Objective-driven ("grow her following", "video concept
 *             ideas"); nobody handed us an ask, so we state the direction ourselves.
 *   inbound — someone came to us with the ask ("brand announcement, showcase this product"). The
 *             direction is GIVEN, and being given is exactly what makes it untrusted (see
 *             BriefDirection.untrusted).
 */
/**
 * `inbound` = external/untrusted brand or deal text · `system` = Nomila-originated creative work · `athlete` = her own
 * request, in her words (0072). Athlete-authored intent is never encoded as `system`.
 */
export type BriefOrigin = "system" | "inbound" | "athlete";

/** The fork. See §1 in the module header — these are different primitives. */
export type BriefMode = "edit" | "generate";

/** What the job is FOR. */
export type BriefObjective =
  | "announce"          // a partnership/launch announcement
  | "showcase-product"  // put a specific piece in frame
  | "grow-following"    // audience growth, no brand obligation
  | "concept"           // idea generation — "video concept ideas"
  | "recap"             // a moment that already happened
  | "thank-partner";

/** What comes out the other end. */
export type BriefDeliverable = "post" | "story" | "reel" | "carousel" | "ad" | "clip";

// ─── Input ──────────────────────────────────────────────────────────────────────────────────────

/** A region of the source frame, in the frame's own displayed pixel coordinates. */
export interface EditRegion {
  /** What is being changed here, e.g. "competitor swoosh". Goes into the edit prompt verbatim. */
  label: string;
  left: number; top: number; width: number; height: number;
  /**
   * The CONCRETE noun the segmenter needs to find this thing — "crop top", "sports bra", "soccer
   * ball". Never her wording, and never sent to the edit model: it exists only to be handed to
   * SAM-3 (studio/segment.ts) so the paste-back can use the thing's SHAPE instead of this rectangle.
   *
   * OPTIONAL, AND ITS ABSENCE IS A SUPPORTED STATE RATHER THAN A GAP. Three real cases have no
   * noun: a box she drew herself (nothing named it), a brief frozen before this field existed, and
   * a detection whose noun was rejected in studio/objectVocab.ts. All three composite through the
   * rectangle exactly as they did before this feature, which is why adding it needed no migration
   * and no backfill — see the fallback block above `distanceToOutside` in studio/composite.ts.
   *
   * ⚠️ IT NAMES A THING SHE IS NOT. The vocabulary is open for objects, so the one word this field
   * must never carry is the athlete — "person", "woman", "body", "face". A solo `samNoun` naming her
   * would confine the edit to a mask OF HER, which is the exact inverse of what `subjectNoun` below
   * is for. studio/objectVocab.ts PERSON_NOUNS is what makes that unrepresentable.
   *
   * It rides in the frozen brief because the Gemini pass that produces it runs in the ROUTE, before
   * approval, while the segmenter runs in generate.ts after it. A short word is cheap to freeze; the
   * MASK is not, and is deliberately never stored.
   */
  samNoun?: string;
  /**
   * The concrete SUBJECT noun — "person" — for a region whose edit must go around something rather
   * than into it. Handed to the same segmenter as `samNoun`, and never to the edit model.
   *
   * ⚠️ NEVER SET ALONGSIDE `samNoun`. The two name opposite operations: `samNoun` says "edit inside
   * this shape", `subjectNoun` says "preserve inside this shape and edit everything else in the
   * rectangle". A region carrying both describes no coherent edit, and both `parseDetections` and
   * `mapRegions` drop the pair rather than pick a winner — see studio/subjectVocab.ts for why the
   * two vocabularies are separate modules and not one list with a flag.
   *
   * ⚠️ ITS ABSENCE IS NOT THE SAME KIND OF STATE `samNoun`'s IS. A missing object noun costs the
   * region its shape and it composites through its rectangle, which is graceful. A missing subject
   * noun on a background edit is NOT recoverable that way: the rectangle for a background change is
   * the whole frame, so "fall back to the rectangle" means re-rendering the athlete herself. That
   * crop is REFUSED instead. The rule is stated once, in studio/generate.ts.
   */
  subjectNoun?: string;
}

/**
 * The frame an `edit` must stay continuous with. Required for mode "edit", forbidden otherwise.
 *
 * `ref` is a PATH, never a signed URL — a signed GCS url's query string IS the credential, and this
 * object is logged and snapshotted. Same rule as costLog.safeRef.
 */
/**
 * The frame a CLIP must arrive at, frozen onto the brief.
 *
 * ⚠️ ON THE BRIEF AND NOT AN OPTION, because the brief is the ONLY thing the spend leg replays.
 * `runStudioGeneration` calls `previewGeneration(stored.brief, …)` with no caller options, so
 * anything that reached the quote through `PreviewOptions` is gone by the time the money moves. A
 * last frame decides the ROUTED MODEL (Kling rather than Veo) and therefore the PRICE, so dropping
 * it between the two means she approves a bridge at one figure and is billed for an ordinary clip
 * at another. (`durationSeconds` HAD exactly that hole — quoted 6s, run at DEFAULT_CLIP_SECONDS —
 * and is on the brief now for the same reason; see `CreativeBrief["job"].durationSeconds`.)
 *
 * ⚠️ SO IT IS ALSO THE PROVENANCE: one frozen object carries the authorization AND the bridge's two
 * endpoints — `references[0]` is where the clip starts and this is where it arrives.
 *
 * ⚠️ FIRST AND LAST MUST BE THE SAME PERSON (`types.ts` states it on the wire field): two subjects
 * ask the model to morph one into the other. Nothing here can check it.
 *
 * Absent is the ordinary case — every image job, every clip with no destination, and every brief
 * frozen before this existed. A brief without it plans exactly as it always did.
 */
export interface JobLastFrame {
  mediaAssetId: string | null;
  /** A STORAGE PATH, resolved from the row by the route. Never a signed url, never a body string. */
  ref: string;
}

export interface SourceAsset {
  mediaAssetId: string | null;
  ref: string;
  /** DISPLAY width, after EXIF orientation — the space `editRegions` are measured in. */
  width: number | null;
  /** DISPLAY height. Same space as `width`. */
  height: number | null;
  /**
   * The EXIF orientation the stored object declares; 1 (or absent) when it renders as it is stored.
   *
   * Frozen here so studio/generate.ts can decide whether the bytes need normalizing before a
   * provider sees them WITHOUT a second ranged read — the probe that measured the frame already
   * knew this. Absent on rows written before this field existed, which reads as "no rotation" and
   * is the correct default for them: they are the upright majority, and a wrong guess would rotate
   * a frame that never needed it.
   */
  orientation?: number;
  /**
   * The regions the edit is allowed to touch. Everything outside them comes back PIXEL-identical —
   * that is the masked-composite contract, and studio/composite.ts is what delivers it.
   *
   * PIXEL, not BYTE, and the distinction is not pedantry: re-encoding a JPEG changes every byte of
   * the file even when every pixel is equal, so byte-identity is not a property this path has or
   * could cheaply get. What it does have is exact for a lossless source and measured-and-bounded for
   * a JPEG one (max delta 4/255 at the top encode rung — see JPEG_LADDER). "Byte-identical" used to
   * appear here and it is not a sentence anyone should repeat to a brand.
   *
   * Empty means "not yet measured", which is a gap, not permission to redraw the frame. The regions
   * arrive either from a box she drew (studio/geometry.ts) or from her instruction
   * (studio/autoMask.ts); both produce the same fractions, so nothing here can tell them apart.
   */
  editRegions: EditRegion[];
}

/**
 * What an uploaded reference CONTRIBUTES. Her vocabulary, and what the model is told to take from it.
 *
 *   person   — her identity/likeness. Contributes IDENTITY: the face and build to render.
 *   product  — the thing being sold or shown. Contributes the OBJECT.
 *   object   — a thing to PLACE IN the frame. Same slot as product, different job.
 *
 * ─── WHY `object` IS NOT JUST `product` UNDER ANOTHER NAME ──────────────────────────────────────
 *
 * They land in the same provider slot and they are still two roles, because the manifest line is
 * the only thing that tells the model what an image is FOR and the two sentences differ. A product
 * is the piece a job is ABOUT — it is being shown, and it is usually already in the frame or is the
 * whole subject. An object is material: a ball she wants put between her cleats, which is not in
 * the frame yet and has no reason to be the subject of anything.
 *
 * The probe measured the difference (docs/probes/2026-09-09-model-native-probe.md, Q1). Six cells,
 * frame in position 1 and the object in position 2, insertion and placement obeyed 6/6 across four
 * prepositions — and the reference is genuinely consumed as an OBJECT SOURCE rather than a style
 * hint: the BOLYN wordmark survives on the ball, and removing the reference yields a plausible but
 * DIFFERENT ball. Q1 set its slots by hand precisely because this role did not exist; the role is
 * what makes the product's own request the shape the probe proved.
 *
 * ⚠️ IT IS A ROLE, NOT A ROUTE. Nothing here makes ADD_OBJECT an operation the classifier can emit
 * — that is PR C′, and this deliberately stops short of it. What lands here is the addressing: an
 * object reference reaches the model in the object slot with a manifest line that says what it is.
 *
 * (PR C′, 2026-09-10: the route now exists — studio/classify.ts rule 4½. An add freezes this role's
 * `mediaAssetId` as its object (studio/nativeIntent.ts), and the instruction points at it by the
 * manifest's own number (studio/compile/manifest.ts, objectImageNumber). The role is still only
 * addressing.)
 *
 * ─── THERE WAS A THIRD ROLE, AND IT WAS CUT ON PURPOSE ──────────────────────────────────────────
 *
 * `influence` let her tag a mood board or a competitor's ad as a look reference, routed it to a
 * style slot, and told the model in the prompt to take grade and composition from it and never a
 * person. The routing worked exactly as designed. The model did not: faces leaked from look
 * references on gemini-3-pro-image, observed live.
 *
 * That was always the known ceiling — `:generateContent` has no typed reference field to enforce a
 * style-only slot with, so the instruction was prose the model could ignore (see RefSlot in
 * studio/types.ts). What made it untenable was not the leak on its own but the PROMISE: the picker
 * said "we'll take the look — never the people", and on our model that sentence was false.
 *
 * So the feature is gone rather than softened. Style direction now comes from the text she writes —
 * `job.direction`, which buildPrompt already carries — where nothing claims a guarantee. If a typed
 * style slot ever becomes available on the model we route to, this is the decision to revisit.
 *
 * ─── A FOURTH ROLE, `style_reference`, AND WHY IT IS NOT `influence` BACK (PR 18) ──────────────────
 *
 * Additive, behind STUDIO_STYLE_SPEC (brief R-1). What leaked was the PIXELS: a look image in a style
 * slot. A `style_reference` never becomes a slot. It carries the stored READING's spec
 * (studio/reference/styleSpec.ts), which compile renders as fenced text, and `referencesFor`
 * (studio/preview.ts) never plans it, so no byte of the reference image reaches the model (R-8;
 * ADI-GO18 G7). The three roles above are untouched: a brief without one compiles as it always did.
 */
export type ReferenceRole = "person" | "product" | "object" | "style_reference";

/**
 * One reference the athlete uploaded and tagged, on the job rather than on the brand.
 *
 * `ref` is a stored GCS PATH, never a signed url — same rule as SourceAsset.ref, and for the same
 * reason: this object is logged and frozen into two jsonb columns, and a signed url's query string
 * IS the credential.
 *
 * TENANCY: every field here is server-resolved. The client sends an ASSET ID and a role; the route
 * re-reads the row under `req.athleteId` and fills `ref` from it. A path that arrived in a request
 * body must never reach this type.
 */
export interface JobReference {
  role: ReferenceRole;
  /** Stored GCS path, resolved from the athlete's own media_assets row. */
  ref: string;
  /** The media_assets uuid it came from. Provenance, and the ids the cost log records. */
  mediaAssetId: string;
  /**
   * Her own words for what this is ("the charm", "my kit"). Rides into the prompt manifest verbatim.
   *
   * Trusted, on exactly the reasoning BriefInput.direction gives: it is her text, about her photo,
   * entering her own generation. THE SAME SEAM APPLIES — the moment a label is prefilled from an
   * inbox message, a brand email or any other outside source, this stops being trusted text and
   * must be fenced as data like an inbound ask. Do not reuse this field for text we did not watch
   * her type.
   */
  label?: string;
  /**
   * The style spec, present iff `role` is `style_reference`. SERVER-DERIVED from her stored reading
   * under her athlete id and frozen here at quote, so the run replays the derivation it was quoted
   * under (ADI-GO18 G1). Never from a request body.
   */
  style?: StyleSpec;
}

/** The ask, when someone brought one. Only meaningful for origin "inbound". */
export interface InboundAsk {
  /** Verbatim, as received. Never edited here — see BriefDirection.untrusted for how it must travel. */
  ask: string;
  /** Pieces the requester named by hand, e.g. ["Wilder Mini Alphabet M"]. Drives blocking gaps. */
  featuredPieces?: string[];
}

export interface BriefInput {
  athleteId: string;
  /** Null for an untailored job (a "grow her following" post owes no brand anything). */
  brandId?: number | null;
  origin: BriefOrigin;
  objective: BriefObjective;
  deliverable: BriefDeliverable;
  mode: BriefMode;
  /** Required when mode is "edit". */
  source?: SourceAsset;
  /** Required when origin is "inbound". */
  ask?: InboundAsk;
  /**
   * The frame a clip must arrive at. Server-resolved, exactly like `references` — the route reads
   * the row under HER athlete id and puts the ROW's path here, never a string from the body.
   */
  lastFrame?: JobLastFrame;
  /**
   * Seconds of video she asked for, already range-checked by the route. Frozen onto the job for the
   * reason `lastFrame` is — see `CreativeBrief["job"].durationSeconds`.
   */
  durationSeconds?: number;
  /**
   * She asked for this clip to have SOUND. `true` or absent — never `false`, so "off" and "frozen
   * before this existed" are the same brief. On the brief for the reason `durationSeconds` is: the
   * spend leg replays this object with empty options, so audio carried any other way is quoted at
   * $0.40/s and then run silent. It doubles Veo's rate, so it is part of what she approves.
   */
  audio?: true;
  /**
   * The structured shot slots she set, already validated against the closed sets by the route.
   * Frozen onto the job — see `CreativeBrief["job"].shot`.
   */
  shot?: ShotSpec;
  /**
   * The athlete's own words for what she wants, typed into our UI. Origin "system" only — it is the
   * direction she CHOSE, which is why it lands as `set: "chosen"` with `untrusted: false`: it is her
   * text, entering her own generation, and it is not an injection vector against herself.
   *
   * THE SEAM: that reasoning holds only while the text is hers. The moment this box is prefilled
   * from an inbox message, a brand email, or any other outside source, the job is no longer
   * system-origin — it must route the `inbound` door with `ask`, so `untrusted` flips to true and
   * buildPrompt fences it as data. Do not "reuse" this field for text we did not watch her type.
   *
   * Empty/whitespace is treated as absent, so a blank textarea falls back to the objective's goal.
   */
  direction?: string;
  /**
   * The tagged references this job is built FROM — the core of "never generate from scratch,
   * always from reference".
   *
   * Legal in BOTH modes, and they mean different things in each. A `generate` has no frame, so the
   * references are the whole anchor: they are what the net-new image is built out of. An `edit` has
   * a frame — the base is WHAT is being changed, and these are what to change it TOWARD.
   *
   * They live on the brief rather than travelling beside it because the brief is the only thing
   * previewGeneration, the blocking gate, savePreview and createGenerationJob all read. A side
   * input would be invisible to the check she approves and absent from the frozen record the spend
   * replays from.
   */
  references?: JobReference[];
  /**
   * The plan this generation belongs to, as the carrier (PR 14, studio/campaign/carrier.ts): the
   * brief's tone triple, style, energy and constraints, the concept's one line, her typed feel and the
   * purpose, and each reference's full reading. SERVER-BUILT from the plan row the route read under HER
   * athlete id (`readPlan`), never from a request body — a posted campaign object is refused. On the
   * brief for `durationSeconds`'s reason: the spend leg replays the brief and nothing else. Behind
   * STUDIO_BRIEF_CARRIER; absent ⇒ every prompt byte-identical to before this existed.
   */
  campaign?: JobCampaign;
  /**
   * quality-scrappy piece 5: a re-quote's corrective — the gate's reason CODES for a previous output of hers
   * (studio/gateVocab.ts), never text. Set only by the preview route under STUDIO_OUTPUT_GATE. Absent ⇒ unchanged.
   */
  corrective?: GateReason[];
  /** Provenance, not authorization (0072): the creative intent this brief serves. Absent for freeform work. */
  creativeIntentId?: string;
  /** Provenance (0073, #570 §6): the campaign scope version and unit of scope this brief serves. Absent otherwise. */
  campaignLineage?: CampaignLineage;
}

export interface CampaignLineage { specId: string; specVersion: number; campaignDeliverableId: string }

// ─── The brief ──────────────────────────────────────────────────────────────────────────────────

/**
 * The direction, normalised across both entry points so downstream reads one shape.
 *
 * `untrusted` is the load-bearing field. A GIVEN direction is attacker-controlled text that arrived
 * from outside the system, so when it reaches a prompt it must be delimited and labelled as data,
 * never concatenated in as instruction. Carrying that as a property of the brief means a prompt
 * builder cannot forget which kind it is holding.
 */
export interface BriefDirection {
  set: "given" | "chosen";
  statement: string;
  untrusted: boolean;
  featuredPieces: string[];
}

export interface BriefJob {
  origin: BriefOrigin;
  /** Provenance (0072): the creative intent this job serves, when there is one. Absent ⇒ no key. */
  creativeIntentId?: string;
  /** Provenance (0073): campaign scope lineage, when there is one. Absent ⇒ no key. */
  campaignLineage?: CampaignLineage;
  objective: BriefObjective;
  deliverable: BriefDeliverable;
  mode: BriefMode;
  /** Present iff mode is "edit". */
  source: SourceAsset | null;
  direction: BriefDirection;
  /**
   * The tagged references, in the order they were given. Always present, frequently empty.
   *
   * READ IT AS `job.references ?? []` EVERYWHERE. A preview is frozen as jsonb with a 30-minute
   * TTL and generation re-derives from that stored object, so a check taken before this field
   * existed can be generated from after — and it will have no key here at all.
   */
  references: JobReference[];
  /**
   * The frame a clip must ARRIVE at — video only, absent everywhere else. See `JobLastFrame` for why
   * it is frozen here rather than passed as an option.
   *
   * Read it as `job.lastFrame ?? undefined`: a brief frozen before this existed has no key at all,
   * and must plan exactly as it did then.
   */
  lastFrame?: JobLastFrame;
  /**
   * How long a CLIP runs, in seconds — video only, absent everywhere else.
   *
   * ⚠️ ON THE BRIEF AND NOT AN OPTION, and it is the `lastFrame` argument again. It was a
   * `PreviewOptions` field, and the spend leg replays the brief with NO caller options
   * (`videoRunner.inputsFor` passes `{}`), so a clip quoted at 8s ran at DEFAULT_CLIP_SECONDS: she
   * approved $1.60 and got half the clip. Duration is a price term on every video SKU, so the
   * quoted job and the run job disagreeing about it is quote/run drift, not a cosmetic default.
   *
   * Absent ⇒ the planner's default, exactly as before — a brief frozen before this existed has no
   * key at all and plans as it did then.
   */
  durationSeconds?: number;
  /**
   * She asked for this clip to have SOUND. `true` or absent — never `false`, so "off" and "frozen
   * before this existed" are the same brief. On the brief for the reason `durationSeconds` is: the
   * spend leg replays this object with empty options, so audio carried any other way is quoted at
   * $0.40/s and then run silent. It doubles Veo's rate, so it is part of what she approves.
   */
  audio?: true;
  /**
   * What she SET about the clip — framing, movement, lighting, environment — video only.
   *
   * ⚠️ ON THE BRIEF, because the compiler runs TWICE: once for the quote and again at spend time,
   * from this object and nothing else (`videoRunner.inputsFor` replays with `{}`). A slot that
   * reached the first compile through an option would be in the prompt she approved and missing
   * from the prompt that ran — the `kind → role` and `durationSeconds` defect, in the prompt.
   *
   * Absent ⇒ every template compiles byte-identically to before this existed. Never `{}`:
   * `normalizeShotSpec` returns `undefined` for a spec with nothing set, and no key is written.
   */
  shot?: ShotSpec;
  /**
   * The classified intent a NATIVE edit runs on — frozen when she was quoted, replayed at spend time.
   *
   * Set only by the preview route, only while STUDIO_NATIVE_EDIT is on, and only for an edit whose
   * regions were derived from her sentence (studio/nativeIntent.ts). Absent everywhere else, and
   * absent is the ordinary case: every flag-off brief, every brief frozen before this field existed,
   * and every edit on a box she drew. A brief without it plans exactly as it always did.
   */
  editIntent?: FrozenEditIntent;
  /**
   * The carrier (PR 14) — see `BriefInput.campaign`. Frozen here when she is quoted and replayed at
   * spend time from this object. Read it as `job.campaign ?? undefined`: a brief frozen before this
   * existed has no key at all and compiles exactly as it did then.
   */
  campaign?: JobCampaign;
  /**
   * What the interpreter made of her sentence, when it ran (studio/interpret, the interpreter, I.5):
   * her words, the proposal and where each part came from, the card's lines, what the call cost. DISPLAY
   * AND RECORD ONLY — nothing plans or executes from it. When it proposed, `direction.statement` is its
   * sentence C and `editIntent` is C's, frozen and re-checked like any typed sentence; this field is how
   * the card, QA's marks and the record know which parts were hers.
   *
   * Set only by the preview route with STUDIO_INTERPRETER on. Absent everywhere else, and absent is the
   * ordinary case — read it as optional, like every field added to a stored brief.
   */
  interpretation?: InterpretationRecord;
  /**
   * THE CARD on a preview the rules read with her keep beside them (A3b; studio/keepVocab.ts): "Here's what
   * we'll do", rendered from the FROZEN intent (compile/describe.ts), every line hers — the same promise an
   * interpreted preview makes, with nothing to refuse, because nothing was interpreted.
   *
   * DISPLAY ONLY. What keeps her is the frozen intent's version 2 constraint, which the spend replays and an
   * instance that predates constraints refuses; this field is never read at the spend, and an instance that
   * predates it ignores it. Set only by the preview route, only when the rules froze a constraint and the
   * interpreter did not run. Absent everywhere else — read it as optional, like every field on a stored brief.
   */
  card?: { lines: DescribedLine[] };
  /**
   * The prompt template this job compiles from, frozen at the quote (quality-scrappy piece 4, templates/freeze.ts,
   * ADI-QS-GO R2): its key, where it came from (a published `prompts` row, or the TS literal), the row's version and
   * hash, and — for a published row — its body verbatim, so the run renders what was quoted even if a newer version
   * is published in between. Set only by the preview route with STUDIO_PROMPT_REGISTRY on. Absent everywhere else,
   * and absent is the literal, byte for byte — read it as optional, like every field on a stored brief.
   */
  template?: FrozenTemplate;
  /**
   * quality-scrappy piece 5: what the last attempt got wrong, as the gate's reason codes — compiled into this job's
   * prompt as the target's fix (studio/gateVocab.ts). Frozen at the quote like everything the run replays. Absent is
   * every first attempt, and every brief before this existed: the prompt byte for byte.
   */
  corrective?: GateReason[];
}

export interface AthleteHalf {
  athleteId: string;
  identity: {
    name: string; firstName: string;
    /** sport · org · marquee credential — the one-line fact row. */
    identityLine: string;
    sport: string; org: string;
    division: string | null; conference: string | null; segment: string | null;
    marqueeTag: string | null;
  };
  /** How she should sound. Drawn from her researched arc, not a tone knob someone picked. */
  voice: { storyArc: string; highlights: string[] };
  audience: {
    /** e.g. "women 18-24 · top market US" — the real descriptor, not a hardcoded assumption. */
    descriptor: string;
    ageRange: string | null; topCity: string | null; topMarket: string | null;
    /** Share of the top segment, 0-100. */
    share: number | null;
  };
  /**
   * Her visual register. There is no first-class "aesthetic" field on an athlete anywhere in the
   * schema today, so this is what can be honestly derived: the credential and level that set the
   * register a frame should carry. Recorded as a gap so it is visibly thin rather than quietly thin.
   */
  aesthetic: { register: string; notes: string[] };
  /** What this job is trying to do for HER, as distinct from what it does for the brand. */
  goal: string;
  /** "none" | "undisclosed" | "active" — whether naming partners is safe. */
  commercialState: AthleteContext["commercialState"];
}

/** A named product. Granularity matters: you cannot render a SKU from a category name. */
export interface ProductPiece {
  name: string;
  /**
   * "category" is all `inbox_brands.enrichment.product_categories` carries today ("necklaces"),
   * and it is not enough to render a specific piece. "sku" means a specific product was named —
   * usually by an inbound ask — and it is the case that needs a reference photograph.
   */
  granularity: "category" | "sku";
  /** THE SLOT. Null is the norm today; filling it is a data change, not an architecture change. */
  reference: PieceReference | null;
}

export interface PieceReference {
  /** Path or URL of a clean product photograph of THIS piece. */
  ref: string;
  source: "brand-supplied" | "brand-site" | "library";
  note?: string;
}

export interface BrandImage {
  ref: string;
  role: "logo" | "cover" | "gallery";
}

export interface BrandHalf {
  brandId: number;
  name: string;
  category: string | null;
  tier: string | null;
  tone: {
    /** enrichment.content_style, e.g. "coastal-cool, effortlessly chic". */
    contentStyle: string | null;
    /** enrichment.brand_values — a voice phrase, not a list. */
    values: string | null;
    audience: string | null;
  };
  /**
   * Brand colours. NO source exists for this today — the field is present on zero of the brands in
   * `inbox_brands`, so this is always empty and always a recorded gap. It is here because a palette
   * is a real art-direction input and the slot should exist before someone needs it.
   */
  palette: string[];
  dos: string[];
  /** Always includes "never show a competitor" when competitors are known — the one rule the deck
   *  engine already enforces, restated here so a generation prompt inherits it. */
  donts: string[];
  pieces: ProductPiece[];
  referenceImagery: BrandImage[];
  recentCampaigns: string[];
  competitors: string[];
}

/**
 * Something the brief knows it is missing.
 *
 * "blocking" means generation should not proceed as briefed — the output would misrepresent
 * something. "degraded" means proceed, but expect less than the brief implies. The distinction is
 * the spike's lesson: a convincing render of the wrong product is worse than no render.
 */
export interface BriefGap {
  field: string;
  note: string;
  severity: "blocking" | "degraded";
}

export interface CreativeBrief {
  briefId: string;
  createdAt: string;
  job: BriefJob;
  athlete: AthleteHalf;
  /** Null for an untailored job. */
  brand: BrandHalf | null;
  gaps: BriefGap[];
}

// ─── Brand extras ───────────────────────────────────────────────────────────────────────────────

/**
 * The brand fields `getBrandContext` does not expose: the raw enrichment blob plus the brand's own
 * imagery columns.
 *
 * This exists as a second read rather than as three new fields on BrandContext because that function
 * belongs to the pitch-deck engine and is out of this lane to change. It is the same row, read
 * once more, SELECT only.
 */
interface BrandExtras {
  productCategories: string[];
  palette: string[];
  dos: string[];
  donts: string[];
  imagery: BrandImage[];
}

async function readBrandExtras(brandId: number): Promise<BrandExtras> {
  const [row] = await db.select({
    logo: inboxBrands.logo_url,
    image: inboxBrands.image_url,
    images: inboxBrands.images,
    enrichment: inboxBrands.enrichment,
  }).from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);

  const enr = (row?.enrichment ?? {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

  // brand_safety is a column every enriched brand carries and almost none populate — it is `null` on
  // the spike's own brand. Read it defensively rather than assuming a shape that is usually absent.
  const safety = (enr.brand_safety ?? {}) as Record<string, unknown>;

  const imagery: BrandImage[] = [
    ...(row?.logo ? [{ ref: row.logo, role: "logo" as const }] : []),
    ...(row?.image ? [{ ref: row.image, role: "cover" as const }] : []),
    ...strings(row?.images).map((ref) => ({ ref, role: "gallery" as const })),
  ];

  return {
    productCategories: strings(enr.product_categories),
    // No brand in the catalog carries colours today; read the plausible keys anyway so the day one
    // does, it flows through without a code change.
    palette: strings(enr.palette).concat(strings(enr.colors)).slice(0, 8),
    dos: strings(safety.dos).concat(strings(safety.do)),
    donts: strings(safety.donts).concat(strings(safety.dont)),
    imagery,
  };
}

// ─── Assembly helpers ───────────────────────────────────────────────────────────────────────────

/** What the job is trying to do for the athlete. Objective-derived, so it is never invented data. */
function goalFor(objective: BriefObjective, brand: BrandContext | null): string {
  switch (objective) {
    case "announce":         return brand ? `Announce the ${brand.name} partnership in her own voice` : "Announce a new partnership in her own voice";
    case "showcase-product": return brand ? `Put ${brand.name}'s product in frame without losing her` : "Put the product in frame without losing her";
    case "grow-following":   return "Grow her audience with something that reads as hers, not as an ad";
    case "concept":          return "Give her directions to choose from before anything is shot";
    case "recap":            return "Retell a moment she already earned";
    case "thank-partner":    return brand ? `Thank ${brand.name} publicly without it reading as obligation` : "Thank a partner publicly without it reading as obligation";
  }
}

/** The direction, from whichever door the job arrived through. */
function directionFor(input: BriefInput, brand: BrandContext | null): BriefDirection {
  if (input.origin === "inbound") {
    const ask = input.ask!;
    return {
      set: "given",
      statement: ask.ask,
      // Authored outside the system. Must be delimited as data wherever it meets a prompt.
      untrusted: true,
      featuredPieces: (ask.featuredPieces ?? []).filter((p) => p.trim().length > 0),
    };
  }
  // Her own words when she wrote any, the objective's goal when she did not. Both are "chosen" and
  // both are trusted — see BriefInput.direction for why, and for the one seam that changes it.
  const typed = input.direction?.trim();
  return {
    set: "chosen",
    statement: typed || goalFor(input.objective, brand),
    untrusted: false,
    featuredPieces: [],
  };
}

/**
 * The brand's pieces: its known categories, plus anything an inbound ask named by hand.
 *
 * A named piece that is not one of the brand's categories is still a piece — it is a SKU somebody
 * asked for, and its missing reference is the thing most worth knowing about this job.
 */
function piecesFor(extras: BrandExtras, featured: string[]): ProductPiece[] {
  const pieces: ProductPiece[] = extras.productCategories.map((name) => ({
    name, granularity: "category", reference: null,
  }));
  const known = new Set(pieces.map((p) => p.name.toLowerCase()));
  for (const name of featured) {
    if (known.has(name.toLowerCase())) {
      // Named AND a known category — promote it, since being asked for by name is what makes a
      // reference necessary.
      const hit = pieces.find((p) => p.name.toLowerCase() === name.toLowerCase())!;
      hit.granularity = "sku";
      continue;
    }
    pieces.push({ name, granularity: "sku", reference: null });
  }
  return pieces;
}

/**
 * What the tagged references do and don't tell us.
 *
 * One note, and it is not an error: "never generate from scratch, always from reference" means a
 * net-new image built only from product shots is anchored on her written description alone, and she
 * should know that is what she is about to buy. A product-only still is legitimate work, so this is
 * `degraded`.
 *
 * TWO WARNINGS USED TO LIVE HERE and went with the `influence` role: one when a look reference
 * appeared to have people in it, one when we had not analysed it yet. Both existed only to qualify
 * a promise that no longer gets made — there is no look reference to warn about.
 */
function referenceGaps(input: BriefInput): BriefGap[] {
  const refs = input.references ?? [];
  if (input.mode !== "generate" || refs.length === 0) return [];
  if (refs.some((r) => r.role === "person")) return [];
  return [{
    field: "job.references",
    note:
      "None of these references is tagged as you, so nothing anchors the person in this image to " +
      "your actual likeness — it will be built from your description instead. Add a photo of " +
      "yourself and tag it \u201cyou\u201d if she should look like you.",
    severity: "degraded",
  }];
}

function collectGaps(input: BriefInput, brand: BrandHalf | null, featured: string[]): BriefGap[] {
  const gaps: BriefGap[] = [];

  gaps.push(...referenceGaps(input));

  if (!brand) {
    gaps.push({
      field: "brand",
      // SHARPENED, wave C card 3 fork C. The old line said "tone, palette or product", which is now
      // both too broad and too narrow. Too broad: an ad's setting IS fitted to her sport and level when
      // no brand row exists (the interpreter's `<athlete>` block, fork A), so something is tailored —
      // just not to a partner. Too narrow: "palette" implies one would be used if a brand WERE
      // attached, and no brand in the catalog has one (BrandHalf.palette, and `brand.palette` below) —
      // a standing gap, not a consequence of this job. She reads this to decide whether to attach a
      // brand before paying, so overstating what is missing misleads as much as understating it.
      note: "No brand on this job, so nothing is tailored to a partner's tone or product. What is made is fitted to you instead — your sport and level.",
      severity: "degraded",
    });
  } else {
    if (!brand.palette.length) {
      gaps.push({
        field: "brand.palette",
        note: "No brand colours are stored for any brand in the catalog yet. Art direction falls back to the brand's own reference imagery.",
        severity: "degraded",
      });
    }
    if (!brand.dos.length && !brand.donts.length) {
      gaps.push({
        field: "brand.dos/donts",
        note: "inbox_brands.enrichment.brand_safety is empty for this brand, so there are no explicit do's and don'ts beyond the competitor rule.",
        severity: "degraded",
      });
    }
    if (!brand.referenceImagery.length) {
      gaps.push({
        field: "brand.referenceImagery",
        note: "No logo, cover or gallery imagery stored for this brand.",
        severity: "degraded",
      });
    }
    const wanted = new Set(featured.map((f) => f.toLowerCase()));
    for (const piece of brand.pieces) {
      if (piece.reference) continue;
      // A piece the ask named by hand is the M-charm case: the job is ABOUT that product and we have
      // no clean photograph of it, so generating it would invent one. That blocks.
      const named = wanted.has(piece.name.toLowerCase());
      gaps.push({
        field: `brand.pieces[${piece.name}].reference`,
        note: named
          ? `The ask names "${piece.name}" but no clean product photograph of it is on file. Rendering it would invent the product. Needs a supplied product shot before this can generate.`
          : `No product photograph on file for "${piece.name}" — only the category name, which is not enough to render a specific piece.`,
        severity: named ? "blocking" : "degraded",
      });
    }
  }

  if (input.mode === "edit" && !input.source!.editRegions.length) {
    gaps.push({
      field: NO_EDIT_REGIONS_FIELD,
      note: "No edit regions measured, so there is nothing to bound the edit to. Without a region the edit degrades into a full re-render, which is the failure this mode exists to avoid.",
      severity: "blocking",
    });
  }

  gaps.push({
    field: "athlete.aesthetic",
    // SHARPENED, wave C card 3 fork C. Two corrections: it left out the SPORT, which `athleteHalf`
    // puts in the register and which is the field an ad's setting actually turns on; and it read as a
    // pure apology when the register is now load-bearing — it is what a no-brand ad fits its background
    // to. The field is still missing; implying nothing stands in for it is no longer true.
    note: "No first-class aesthetic or visual-identity field exists on an athlete today. The register below stands in for one and is derived from her sport, level and credential alone — enough to fit a setting to her, not a visual identity.",
    severity: "degraded",
  });

  return gaps;
}

/**
 * THE TEXT SOMEBODY ACTUALLY ASKED FOR, which is not the same as `direction.statement`.
 *
 * `directionFor` falls back to `goalFor(objective, brand)` when she typed nothing, so the statement
 * is OUR OWN boilerplate on any brief with no written direction — and the brand's name is
 * interpolated into most of those strings. Reading the statement would mean a brand called
 * "Soccer.com" or "Basketball HQ" silently suppressed her real sport on every untyped brief for
 * that partner.
 *
 * Which is not a near-miss of the rule, it is the inverse of it: the rule is that an EXPLICIT
 * REQUEST outranks injected profile context, and generated boilerplate is not a request. So this
 * reads only the two places text arrives from outside — her typed direction, or the inbound ask —
 * and returns nothing when neither was given, which leaves the profile answering as it should.
 */
export function explicitAsk(input: BriefInput): string {
  return (input.origin === "inbound" ? input.ask?.ask : input.direction)?.trim() ?? "";
}

/**
 * ─── PRECEDENCE: WHAT SHE ASKED FOR BEATS WHAT HER PROFILE ASSERTS ─────────────────────────────
 *
 * `register` is profile-derived context — the one place a generate's prompt states her sport — and
 * `explicitAsk` is what somebody actually asked for. When both name a sport and they disagree, the
 * prompt carries a contradiction, and the model resolves it by obeying BOTH. Measured live on
 * 2026-09-09 (job e4814552): profile `Basketball`, direction "create an adidas soccer ad featuring
 * me", and the output was a basketball court, a basketball in her hands, a soccer ball at her feet
 * and a caption reading "Wait, soccer? … #basketball #soccer". Not a misread — an obedient
 * reconciliation of two inputs we told it were both true.
 *
 * So the assembler resolves it instead of the prompt asking the model to. When the direction names
 * a sport, the profile's sport leaves the register and the sentence is the only sport in the
 * prompt. When it does not, the register is untouched and the profile legitimately fills the gap —
 * that case is the reason the field is in the register at all and it is not what broke.
 *
 * ⚠️ THE RULE ONLY SUBTRACTS. It can drop a profile assertion; it can never write the direction's
 * words into the register or anywhere else trusted. That is what makes it safe on the `inbound`
 * arm, where `direction.statement` is attacker-controlled text: the worst a hostile ask can achieve
 * is omitting one profile field from a prompt that already fences the ask itself as data. A rule
 * that COPIED the named sport into the register would be a different rule with a different
 * argument, and it is deliberately not this one.
 *
 * ⚠️ SPORT ONLY, ON PURPOSE. `segment` stays whatever the profile says. (The legacy tier word left the register in
 * the legacy retirement, P2-2 — owner decision 6, 8 Oct 2026: it is no longer a generation input.) The same
 * contradiction is possible for school and org (Mia's §14 Stanford-grad case) and the mechanism
 * generalises, but no live failure has been measured for those and widening a precedence rule on
 * intuition is how a narrow fix becomes an unbounded one.
 */
function athleteHalf(
  ctx: AthleteContext,
  input: BriefInput,
  brand: BrandContext | null,
): AthleteHalf {
  const sportIsHers = namesSport(explicitAsk(input)) === null;
  const register =
    [ctx.segment, sportIsHers ? ctx.sport : null].filter(Boolean).join(" · ") ||
    "unspecified";
  return {
    athleteId: ctx.athleteId,
    identity: {
      name: ctx.name, firstName: ctx.firstName, identityLine: ctx.identityLine,
      sport: ctx.sport, org: ctx.org,
      division: ctx.division, conference: ctx.conference, segment: ctx.segment,
      marqueeTag: ctx.marqueeTag,
    },
    voice: { storyArc: ctx.storyArc, highlights: ctx.signalHighlights },
    audience: {
      descriptor: ctx.audienceFacts,
      ageRange: ctx.audienceAge, topCity: ctx.audienceCity,
      topMarket: ctx.geoCountry[0]?.key ?? null,
      share: ctx.audienceShare,
    },
    aesthetic: {
      register,
      notes: [ctx.marqueeTag, ctx.identityLine].filter((n): n is string => !!n),
    },
    goal: goalFor(input.objective, brand),
    commercialState: ctx.commercialState,
  };
}

// ─── assembleBrief ──────────────────────────────────────────────────────────────────────────────

/**
 * Assemble one content job into a CreativeBrief.
 *
 * Both entry points land here and both produce the same object — `input.origin` is the only thing
 * that differs, and it changes where the direction comes from, not what the brief looks like.
 *
 * Pure read: two or three SELECTs, no model call, no write.
 *
 * TENANCY — the caller's contract, because this function cannot enforce it. `input.athleteId` is
 * trusted as given, so it MUST come from `req.athleteId` on an authenticated route. Never pass an id
 * that came from a client body, a query string, or a model tool call: everything below is read for
 * whoever that id names, so a borrowed id reads another athlete's brief. The same rule the routes
 * already follow — scope is resolved server-side, always.
 */
export async function assembleBrief(input: BriefInput): Promise<CreativeBrief> {
  if (!input?.athleteId) {
    throw new GenerationError("assembleBrief requires an athleteId", "invalid_input");
  }
  // The fork is required, not inferred. Guessing it is how an edit becomes a re-render.
  if (input.mode === "edit" && !input.source) {
    throw new GenerationError(
      'mode "edit" requires a source asset — an edit has a real frame to preserve; use mode "generate" for net-new work',
      "invalid_input",
    );
  }
  if (input.mode === "generate" && input.source) {
    throw new GenerationError(
      'mode "generate" must not carry a source asset — pass mode "edit" if the output has to stay continuous with a real frame',
      "invalid_input",
    );
  }
  if (input.origin === "inbound" && !input.ask?.ask?.trim()) {
    throw new GenerationError('origin "inbound" requires the ask that was given', "invalid_input");
  }

  const [athleteCtx, brandCtx] = await Promise.all([
    getAthleteContext(input.athleteId),
    input.brandId ? getBrandContext(input.brandId) : Promise.resolve(null),
  ]);

  const direction = directionFor(input, brandCtx);

  let brand: BrandHalf | null = null;
  if (brandCtx) {
    const extras = await readBrandExtras(brandCtx.id);
    const donts = [...extras.donts];
    // The one rule the deck engine already enforces, restated so a generation prompt inherits it.
    if (brandCtx.competitors?.length) {
      donts.push(`Never show a competitor of ${brandCtx.name}: ${brandCtx.competitors.join(", ")}`);
    }
    brand = {
      brandId: brandCtx.id,
      name: brandCtx.name,
      category: brandCtx.category,
      tier: brandCtx.tier,
      tone: {
        contentStyle: brandCtx.contentStyle ?? null,
        values: brandCtx.brandValues ?? null,
        audience: brandCtx.audience,
      },
      palette: extras.palette,
      dos: extras.dos,
      donts,
      pieces: piecesFor(extras, direction.featuredPieces),
      referenceImagery: extras.imagery,
      recentCampaigns: brandCtx.recentCampaigns ?? [],
      competitors: brandCtx.competitors ?? [],
    };
  }

  const brief: CreativeBrief = {
    briefId: randomUUID(),
    createdAt: new Date().toISOString(),
    job: {
      origin: input.origin,
      objective: input.objective,
      deliverable: input.deliverable,
      mode: input.mode,
      source: input.source ?? null,
      direction,
      // Server-resolved, every field. See JobReference — a path that arrived in a request body
      // must never reach here, and the route is what guarantees it.
      references: input.references ?? [],
      // Additive and omitted when absent — NOT `lastFrame: undefined`, which would put a key on
      // every brief in the table and make "frozen before this existed" indistinguishable from
      // "explicitly none".
      ...(input.lastFrame ? { lastFrame: input.lastFrame } : {}),
      // Same rule, same reason. A number, so the test is `!== undefined` — and the route never
      // sends 0 (MIN_CLIP_SECONDS), so there is no falsy value to lose.
      ...(input.durationSeconds !== undefined
        ? { durationSeconds: input.durationSeconds }
        : {}),
      // Same rule. Only `true` freezes a key: off is the absence of one.
      ...(input.audio === true ? { audio: true as const } : {}),
      // Same rule again. Normalized HERE rather than trusted from the caller, so `{}` and a spec of
      // undefineds both freeze as no key at all.
      ...(normalizeShotSpec(input.shot)
        ? { shot: normalizeShotSpec(input.shot) }
        : {}),
      // Same rule (PR 14). The carrier is on the job so the spend leg's replay has it; absent is no key.
      ...(input.campaign ? { campaign: input.campaign } : {}),
      // quality-scrappy piece 5: a re-quote's corrective codes, only as the route passed them (STUDIO_OUTPUT_GATE).
      ...(input.corrective?.length ? { corrective: input.corrective } : {}),
      // Same rule (0072): provenance rides the frozen brief so the job it becomes can carry it; absent is no key.
      ...(input.creativeIntentId ? { creativeIntentId: input.creativeIntentId } : {}),
      ...(input.campaignLineage ? { campaignLineage: input.campaignLineage } : {}),
    },
    athlete: athleteHalf(athleteCtx, input, brandCtx),
    brand,
    gaps: collectGaps(input, brand, direction.featuredPieces),
  };

  logger.info(
    {
      briefId: brief.briefId, athleteId: input.athleteId, brandId: input.brandId ?? null,
      origin: input.origin, mode: input.mode, objective: input.objective,
      pieces: brand?.pieces.length ?? 0,
      references: brief.job.references.length,
      blocking: brief.gaps.filter((g) => g.severity === "blocking").length,
    },
    "creative brief assembled",
  );
  return brief;
}

/**
 * The field of the "no edit regions measured" gap. Named because two places read it by field — the
 * route's surface copy, and the preview's waiver for a region-free native edit (an add, PR C′) — and
 * a waiver keyed on a retyped string is one typo away from waiving nothing, silently.
 */
export const NO_EDIT_REGIONS_FIELD = "job.source.editRegions";

/** Convenience for callers that need to refuse before spending: does anything block generation? */
export function blockingGaps(brief: CreativeBrief): BriefGap[] {
  return brief.gaps.filter((g) => g.severity === "blocking");
}
