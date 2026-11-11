/**
 * studio-contract — the shapes the Studio UI is built against.
 *
 * ─── WHY THIS IS NOT IN shared/ YET ────────────────────────────────────────────────────────────
 * Because it is a PROPOSAL. The UI is being built to the agreed design rather than to what the
 * server currently accepts, and the missing pieces are being built underneath it. This file is the
 * consumer's half of that agreement, written down where it compiles, so the backend has something
 * concrete to build to instead of a description.
 *
 * When the server adopts it, this moves to shared/ and both sides compile against one definition.
 * Today there are TWO hand-mirrors of the studio types — `use-studio.ts` mirrors
 * `server/studio/types.ts` by eye, and its own header says drift is "a 400, not a bad generation".
 * A third mirror is exactly how that gets worse, so this file is explicitly the target, never a
 * second copy of the present.
 *
 * ─── WHAT DIFFERS FROM THE LIVE API, AND WHY ───────────────────────────────────────────────────
 * 1. MANY references, not one. `PreviewRequest` takes a single `sourceAssetId`. A three-shot reel
 *    is three source frames by definition, so one is not an extension of the shape — it is the
 *    shape. The response type already returns `PlannedReference[]`; only the request needs widening.
 *
 * 2. An `inspiration` role. The server's roles are source-frame | product | brand-imagery.
 *    Inspiration is a genuinely different fourth thing: it is read for grade, crop and pacing and
 *    NEVER appears in the output. Folding it into brand-imagery would let a reference leak into a
 *    frame, which is the exact failure the design promises will not happen.
 */
import type {
  GenerationPreview,
  InterpretationLine,
  InterpretationSource,
  PreviewRequest,
  StudioClassification,
  StudioDeliverable, StudioIntent, StudioObjective,
  StudioReferenceRole,
  // Aliased because this module exports its own `StudioReference` — HER vocabulary, with a
  // ReferenceRole on it. This one is the ENGINE's, and keeping both names in scope unaliased is
  // how the two silently swap places.
  StudioReference as EngineReference,
  StudioRegion,
} from "../hooks/use-studio";

// ─── References ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a piece of attached material is FOR. Not where it came from.
 *
 * The distinction is load-bearing and is the reason this is not a camera-roll picker: a product has
 * to be the real piece (the engine refuses to render one from a description), while inspiration is
 * never rendered at all. A source-frame is her, and is what keeps the result looking like her.
 *
 * `object` is material — a ball to put between her cleats. It is separate from `product` because
 * the two get different sentences in the prompt's reference manifest: a product is the piece the
 * job is ABOUT, an object is a thing to place IN the frame. It is also the tile that stops the
 * commonest way the frame used to invert: before it existed, a ball had nowhere to go but "Your
 * media", and a "Your media" attachment could become the frame being edited.
 */
export type ReferenceRole =
  | "source-frame"
  | "product"
  | "object"
  | "inspiration"
  // PR 18 (EXPO_PUBLIC_STUDIO_STYLE_SPEC): one of her already-read references, whose READING shapes the look.
  // A new tray role rather than `inspiration` revived: a legacy draft's inspiration chip stays dropped.
  | "style";

export interface StudioReference {
  role: ReferenceRole;
  /** A row in media_assets, re-resolved server-side under the authenticated athlete. */
  assetId: string;
}

/** The client's view of one attachment, before it becomes a StudioReference. */
export interface Attachment {
  id: string;
  role: ReferenceRole;
  /** What to call it in the tray. */
  name: string;
  /** Local or signed URI for the thumbnail. Null while uploading, or for a pasted link. */
  uri: string | null;
  /** Set once it exists in media_assets. Until then it cannot go in a request. */
  assetId: string | null;
  /**
   * The library's `media_type` for this asset — IMAGE | VIDEO | REELS | CAROUSEL_ALBUM — when the
   * thing that minted this attachment knew it.
   *
   * ⚠️ IT LIVES ON THE TRAY ITEM BECAUSE THE ALTERNATIVE FAILS OPEN. This fact used to travel only
   * in a side map keyed by asset id (`CreateAnythingScreen`'s `mediaTypes`), built at the picker
   * and held in one screen's state. A map that travels separately from the tray it describes can
   * arrive partial or not at all — MakeItScreen gets its tray through navigation params and never
   * had one — and a MISSING KEY READS AS "not motion". That is the wrong direction to fail in: it
   * is what let a clip tagged "You" travel as a `person` reference into an edit and block the
   * preview (F-AM7). A tray that carries its own truth has no absent case to get wrong.
   *
   * Optional, because an attachment can predate the field: one rehydrated from a thread's stored
   * material, or minted before this existed. `isMotion` falls back to the map for exactly those,
   * where a map is available.
   */
  mediaType?: string | null;
  /** An inspiration link rather than an image — read, never composited. */
  href?: string;
}

// ─── The preview request ────────────────────────────────────────────────────────────────────────

/**
 * What the UI wants to send. Note what is absent: an athlete id (the server reads it from the
 * token) and a cost (the ceiling is read off the server's own preview row — there is deliberately
 * nothing here to forge).
 */
export interface TargetPreviewRequest {
  intent: StudioIntent;
  deliverable: StudioDeliverable;
  objective: StudioObjective;
  /** Her own words, passed through. */
  direction?: string;
  brandId?: number | null;
  references: StudioReference[];
  durationSeconds?: number;
  /**
   * Sound on this clip. Video deliverables only — the server drops it for a still.
   *
   * ⚠️ IT IS A PRICE, NOT A PREFERENCE. On Veo it buys the with-audio SKU at DOUBLE the per-second
   * rate ($0.40/s against $0.20/s), so it must be picked before the quote she approves, never after.
   * Free on b-roll, which is token-priced with no audio arm. Absent means off, and the server
   * freezes a key only for `true`.
   */
  audio?: boolean;
}

/** Reduces the tray to what a request can carry. An attachment with no asset row cannot go. */
export function toReferences(attachments: Attachment[]): StudioReference[] {
  return attachments
    .filter((a): a is Attachment & { assetId: string } => Boolean(a.assetId))
    .map((a) => ({ role: a.role, assetId: a.assetId }));
}

// ─── The plan that comes back ───────────────────────────────────────────────────────────────────

/**
 * What is being done to one frame. The distinction is not decoration: a whole-frame relight priced
 * and labelled as an edit is how a generated image ends up presented as a photograph.
 *
 *   untouched  her photograph, cropped to fit. Free, and nothing is claimed about it.
 *   fixed      her photograph with something taken out or placed in — a rival mark removed, a
 *              product composited. Still her frame.
 *   invented   pixels that did not exist. The one she has to agree to.
 */
export type FrameTier = "untouched" | "fixed" | "invented";

/**
 * SERVER: partial. `GenerationPlan.cost` is currently ONE EstimatedCost for the whole job, so
 * `costUsd` and `tier` are per-frame facts the engine does not yet return. Both are being added;
 * until then the plan is assembled client-side from what the preview does say.
 */
export interface PlanFrame {
  id: string;
  assetId: string | null;
  name: string;
  uri: string | null;
  tier: FrameTier;
  /** Why this frame is in the plan, in her language. */
  why: string;
  costUsd: number;
  /** What is being done to it: "as is", "logo out", "relit". */
  label: string;
  /** Something she asked for on this specific frame. */
  note: string | null;
}

/**
 * One piece of her material that ACTUALLY reached the engine.
 *
 * Built from the mapped references rather than the tray, because those are two different lists: an
 * inspiration image is in the tray and is not in the job. A strip that showed the tray would tell
 * her a photograph anchored the result when it was never sent.
 */
export interface BuiltFrom {
  assetId: string;
  /** The ENGINE's role — what it was actually sent as. */
  role: StudioReferenceRole;
  name: string;
  uri: string | null;
}

/**
 * NUMBER A NAME THAT REPEATS, and leave a name that does not (wave C card 2, the plural-You row).
 *
 * ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────────────────
 *
 * Three photographs of her rendered three "BUILT FROM" tiles all captioned YOU, and the screen reader
 * announced "You. Open it." three times over three different tappable thumbnails. Nothing distinguished
 * them, by sight or by voice. Reference packs made that the ordinary case rather than a rare one —
 * MAX_PERSON is 3 — so it is worth a fix rather than a note.
 *
 * ─── WHY IT IS HERE, AND PURE ───────────────────────────────────────────────────────────────────
 *
 * It lives beside `BuiltFrom` rather than inside the hook that calls it for the reason
 * `referencePack.ts` exists: jest's client suites are pure logic with no renderer, and
 * `use-studio-pending.ts` imports React. A caption that ships to her is only testable if it does not
 * arrive through react-native.
 *
 * ─── THE RULES, EACH ONE LOAD-BEARING ───────────────────────────────────────────────────────────
 *
 *   * Over the RESOLVED name, not the role, so every repeat is fixed the same way — a pack of three is
 *     YOU 1 / YOU 2 / YOU 3, and two Object photos are OBJECT 1 / OBJECT 2.
 *   * A name appearing ONCE is returned untouched. The common case must not grow a "1".
 *   * Numbering is per name, so one "You" beside two "Object"s leaves You alone and numbers the objects.
 *   * ORDER IS THE CALLER'S, which for the strip is the engine's reference order — the order the prompt's
 *     manifest numbers them in (studio/refOrder.ts). So "YOU 2" and "Image 2" are the same photograph,
 *     and a later card may say so without re-deriving anything.
 *
 * Returns a new array; inputs are never mutated.
 */
export function numberRepeatedNames<T extends { name: string }>(
  items: readonly T[],
): T[] {
  const total = new Map<string, number>();
  for (const it of items) total.set(it.name, (total.get(it.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return items.map((it) => {
    if ((total.get(it.name) ?? 0) < 2) return { ...it };
    const n = (seen.get(it.name) ?? 0) + 1;
    seen.set(it.name, n);
    return { ...it, name: `${it.name} ${n}` };
  });
}

/** Everything the Make it screen renders, in one shape. */
export interface GenerationPlanView {
  /** The server's record of this check — the row that later authorizes the spend. */
  previewId: string | null;
  title: string;
  line: string;
  heroUri: string | null;
  format: StudioFormat;
  frames: PlanFrame[];
  /** Read off the brief. Blocking gaps stop the button; warnings do not. */
  blockers: string[];
  warnings: string[];
  canGenerate: boolean;
  /**
   * THE AUTHORITATIVE FIGURE, straight off the preview row — one cost for the whole job, which is
   * all the engine returns. Null until the check answers, or when it comes back unpriced.
   *
   * It is here rather than only summed out of `frames` because the two can disagree in the one
   * direction that matters: a job costing $0.004 rounds to $0.00 across the frames and would render
   * as "free" over a real charge. Anything that says the word "free" must read THIS.
   */
  jobCostUsd: number | null;
  /** The server could not price this job. See the blocker note in use-studio-pending. */
  unpriced: boolean;
  /** Her material that survived the crossing — what genuinely anchors this generation. */
  builtFrom: BuiltFrom[];
  /**
   * WHAT THIS EDIT WILL ACTUALLY CHANGE, when the region was derived from her sentence rather than
   * drawn.
   *
   * Carried onto the view so the Make it screen can show her the box BEFORE she approves the spend.
   * An auto-derived mask she cannot see is a box she cannot correct, and the whole geometry design
   * is built on refusing visibly rather than clamping silently — a derived one should not be the
   * exception to that.
   *
   * Null on every generate, and null for an edit whose box she drew herself: there is nothing to
   * show her that she did not just do.
   */
  derivedRegions: StudioRegion[] | null;
  /** The photo being edited, for the mask editor to draw on. Null unless this is an edit. */
  editBaseUri: string | null;
  /**
   * THE CLASSIFIER DECLINED TO ROUTE THIS, AND WHY — a reason code, never a sentence.
   *
   * Null in the ordinary case and null whenever the cutover flag is off. When it is set, no check
   * was fired at all: there is nothing to price, because we have not agreed what she asked for.
   *
   * It is a code rather than the finished copy because the copy is the screen's job (`askCopyFor`)
   * and because the codes are the server's vocabulary — `person_target`, `fast_path_declined`,
   * `no_steps`. Rendering the code itself would be a generic decline wearing a specific name.
   */
  askReason: string | null;
  /**
   * The `vague` ask's op chips (PR 19, R-6), from the server's classify answer — null on every other plan, and absent
   * with STUDIO_IMAGE_OPS off. Each is a sentence she can tap into her draft; nothing is sent.
   */
  askSuggestions?: string[] | null;
  /**
   * What this plan will RUN as (PR 19, K-IO12) — set only with STUDIO_IMAGE_OPS on, so the thread can say "This makes
   * a new image" when a marked frame became a generate (a pose, an unknown brand's ad). Absent otherwise.
   */
  intent?: StudioIntent;
  /**
   * "HERE'S WHAT WE'LL DO" — the interpreter's reading of her words, when it proposed one (the interpreter,
   * I.6). Each line is the frozen intent's own words, tagged by where it came from, so what she reads is
   * what will run. Null on every preview it did not propose — and then this screen is exactly today's.
   */
  interpretation: { lines: InterpretationLine[] } | null;
  /**
   * The same card on a preview the RULES read, when her keep froze beside their steps (A3b): "make it
   * warmer, dont change anything about me" — the look, and "Keep your face, hair, body and pose as they
   * are", both hers. Null on every other preview.
   */
  card: { lines: InterpretationLine[] } | null;
  /**
   * Her sentence went to the preview to be interpreted, so the check she is waiting on is working out what
   * she meant. The screen says so rather than "checking what this needs".
   */
  interpreting: boolean;
}

/**
 * WHICH "HERE'S WHAT WE'LL DO" CARD THE PREVIEW SHOWS — and whether "Not what I meant" goes with it.
 *
 * The interpreter's card can be refused: it is a reading of her words, and refusing it is how she takes the
 * reading back. The rules' card (A3b) is the same promise — what will run, and that she is kept exactly as
 * she is — with nothing to take back: the rules read her words as she typed them, so there is no reading to
 * refuse, and the reject endpoint has nothing to reject. A preview with neither shows no card, as before.
 */
export function previewCard(
  plan: Pick<GenerationPlanView, "interpretation" | "card">,
): { lines: InterpretationLine[]; refusable: boolean } | null {
  if (plan.interpretation?.lines.length) {
    return { lines: plan.interpretation.lines, refusable: true };
  }
  if (plan.card?.lines.length) {
    return { lines: plan.card.lines, refusable: false };
  }
  return null;
}

/** A card line's tag, in her language — or none for a line nothing tagged. */
export function lineTagFor(source: InterpretationSource | null): string | null {
  switch (source) {
    case "yours":
      return "your words";
    case "suggested":
      return "our suggestion";
    case "brand":
      return "required by the brand";
    default:
      return null;
  }
}

// ─── Deriving the engine task ───────────────────────────────────────────────────────────────────

/** The formats a person picks. The engine task is derived from this, never chosen. */
export type StudioFormat = "photo" | "carousel" | "video" | "story";

/**
 * WHICH ENGINE, FROM WHAT SHE ASKED FOR.
 *
 * The athlete never names image.generate / image.edit / video.generate. She picks a format and
 * attaches material; the task follows. This is the whole reason the ＋ menu forks on audience
 * rather than on engine mode — the engine question has a deterministic answer, so asking it was
 * always a question she could get wrong on our behalf.
 *
 * Motion is video-only and an edit is stills-only, mirroring DELIVERABLES_FOR and the server's
 * taskForPair(). This function and that table must agree or the format she taps produces a 400 —
 * which is precisely why the derivation lives in one place with a test around it.
 */
export function deriveIntent(format: StudioFormat, refs: StudioReference[]): StudioIntent {
  if (format === "video") return "video.generate";
  // Editing means editing SOMETHING. Only a frame of hers counts — a product shot or an
  // inspiration image is material for the job, not the thing being edited.
  const hasSourceFrame = refs.some((r) => r.role === "source-frame");
  return hasSourceFrame ? "image.edit" : "image.generate";
}

/** The deliverable each format maps to. Kept beside deriveIntent so the pair stays consistent. */
export function deliverableFor(format: StudioFormat): StudioDeliverable {
  switch (format) {
    case "video":    return "reel";
    case "carousel": return "carousel";
    case "story":    return "story";
    default:         return "post";
  }
}

// ─── The engine's vocabulary, from hers ─────────────────────────────────────────────────────────

/**
 * HER ROLES ARE NOT THE ENGINE'S ROLES, AND THE GAP IS DELIBERATE.
 *
 * She tags material with what it IS to her: her own media, the product, a look she likes. The
 * engine's allowlist is `person | product` and nothing else (REFERENCE_ROLES in
 * server/routes/studio.ts), and an unrecognised role is a 400 rather than a reinterpretation. So
 * the translation happens ONCE, here, on the way out — and everything that cannot make the crossing
 * is COUNTED rather than quietly discarded, because a base image that silently vanishes turns a
 * reference-conditioned generation into a text-only one that still looks like it worked.
 *
 * ─── TODO(mila): `source-frame` IS A VOCABULARY COLLISION ──────────────────────────────────────
 * The name means "the frame being EDITED", which is exactly what it is inside CampaignWorkspace's
 * mask flow. In Create anything and Setup the same tile means "this is me", and it becomes the
 * engine's `person` — the identity anchor for reference-conditioned generation. One tile, two
 * meanings, and only the second is reachable outside CampaignWorkspace today because those flows
 * have no mask editor.
 *
 * The mapping below is correct for both readings and is what ships. Renaming the role, or splitting
 * it in two, is the ref-role decision Mia owns — deliberately NOT invented here.
 *
 * ─── DECIDED — 2026-09-09, PR R. THE TILE IS NOT SPLIT, AND THAT IS THE DECISION ───────────────
 *
 * Kept above rather than rewritten, because the reasoning is what dates it. The collision was real
 * and the resolution is not the one the TODO anticipated:
 *
 *   The THIRD meaning got the new tile. `object` is material to place in the frame, and it had no
 *   tile at all — which is how a soccer ball came to be tagged "Your media" and, being first in
 *   the array, became the frame being edited (sweep 7.2).
 *
 *   The FIRST TWO stay one tile. "The frame being edited" and "an identity anchor" are the same
 *   photograph of hers, and which one it is depends on a sentence she may not have typed yet. The
 *   cutover moved that decision to her words on purpose; a "Photo to edit" tile would move it back
 *   to attach time and would regress "make the socks blue" — the sentence the cutover is named for.
 *
 *   WHICH photograph is the frame stopped being a guess. It is her explicit mark (`frameFor`),
 *   never array order, and a second photograph asks rather than reassigning.
 *
 * ─── 2026-09-16, FRAME DEFAULTING. STILL ONE TILE — BUT THE MARK DECIDES, NOT THE SENTENCE ──────
 *
 * The block above kept "the frame" and "an identity anchor" as one tile because which one a photo was
 * depended on her sentence. In practice the sentence never got the choice: her first photograph was
 * marked the moment it was attached, the classifier was told there was a photo to edit whenever one was
 * in the tray, and so every photo of her was a frame first. A generate from several photos of her — a
 * reference pack — could not be asked for; it planned as an edit, and an edit refuses them.
 *
 * So the tile stays one tile, and the MARK is what separates the two meanings. A photo she marked (the
 * EDITING badge, Edit this, or the thread's continuation) is the frame. A photo she did not mark is her
 * likeness for a new image. Adi's call, made knowing its cost, which is real and is this:
 *
 *   "make the socks blue", "remove the soccer ball" and "put me on a rooftop at dusk" with an UNMARKED
 *   photo now plan as a new image, not an edit. To edit a library photo she marks it. The priced card
 *   says which it is before anything is spent, so the wrong reading costs her a look, not a charge.
 *
 * `routeWithServer`'s "never generate where the old path edited" asymmetry still holds for everything
 * it is handed; it is simply handed only the marked frame (`routeMarked`).
 *
 * And the "second photograph asks" above moved with it (F.4): a photo of hers beside a MARKED one is asked
 * about when she sends — edit the marked one, or a new image from all of them — not when she attaches it.
 */
/**
 * THE LIBRARY'S MOTION TYPES (hooks/use-media-library.ts, `media_type`).
 *
 * ⚠️ IT LIVES HERE BECAUSE TWO FILES WERE DISAGREEING ABOUT IT, and the disagreement was F-AM7.
 * `canvasesIn` (screens/studio/createAnythingLogic.ts) held a private copy of this set and used it
 * to say a clip is NEVER a canvas for an edit. `ENGINE_ROLE` below said a clip tagged "You" is
 * ALWAYS a `person` reference. Both were reachable from the same tray, and nothing reconciled them.
 *
 * One definition, imported by both, is the fix. A second copy is how it broke the first time.
 */
export const MOTION_TYPES: ReadonlySet<string> = new Set(["VIDEO", "REELS"]);

/**
 * Is this attachment a clip, as far as anything here knows?
 *
 * THE ATTACHMENT FIRST, THE MAP SECOND — and the order is the point. The attachment is the
 * authority because it travels with the tray through navigation, through a `SheetJob` and through
 * the composer alike. The map is a fallback for attachments that predate the field (a tray
 * rehydrated from stored material, say) and is only ever available where one is held; passing none
 * is the ordinary case on the sheet path.
 *
 * An attachment we know nothing about is not motion, which is the safe reading for every caller
 * here: `canvasesIn` would exclude it from being a canvas, and dropping a photograph of hers from
 * an edit's references because we could not identify it would be the worse mistake.
 */
export function isMotion(
  a: Pick<Attachment, "assetId" | "mediaType">,
  mediaTypes: Readonly<Record<string, string>> = {},
): boolean {
  const known = a.mediaType ?? (a.assetId ? mediaTypes[a.assetId] : undefined);
  return MOTION_TYPES.has(known ?? "");
}

const ENGINE_ROLE: Record<ReferenceRole, StudioReferenceRole | null> = {
  "source-frame": "person",
  product:        "product",
  // The thing to put IN the frame. Lands in the same provider slot as `product` and carries the
  // insert sentence rather than the showcase one — server/studio/preview.ts referenceManifest.
  object:         "object",
  // No engine role exists for it. Folding it into `product` would put a competitor's ad into the
  // output, which is the precise failure the role was invented to prevent — so it is dropped, and
  // declared, and never folded into the prompt text either.
  inspiration:    null,
  // PR 18: an already-read reference. The server derives a style spec from its stored READING and never
  // plans or sends its image (server/studio/preview.ts PLANNED_ROLE). Only mintable with the flag on.
  style:          "style_reference",
};

/**
 * THE ROLES A PICKER CAN ACTUALLY MINT — the tile contract, as a value rather than a comment.
 *
 * It lives here and not in AttachSheet because a constant inside a component is unreachable from
 * this suite (the client tests are pure logic, no renderer), and an unreachable contract is a
 * comment. `object` existing as an engine role while no tile could produce one is precisely the
 * hole sweep 7.2 fell through — the ball had nowhere to go but "Your media" — so the pairing is
 * pinned in a test instead of remembered.
 *
 * `inspiration` is deliberately absent: it is still a member of `ReferenceRole` for legacy drafts,
 * and `toEngineReferences` drops it, but nothing in the UI may mint one. That is the same fact
 * `PickableRole`'s `Exclude` states in the type system, said once more where a test can read it.
 */
export type PickableRole = Exclude<ReferenceRole, "inspiration">;
export const PICKABLE_ROLES: readonly PickableRole[] = ["source-frame", "product", "object"];

/**
 * The tiles a picker offers: PICKABLE_ROLES, plus Style when EXPO_PUBLIC_STUDIO_STYLE_SPEC is on (PR 18). The
 * flag is an ARGUMENT, not an import: this module reads no flag of its own (the census relies on that).
 * PICKABLE_ROLES itself is unchanged, so every screen that reads it offers exactly what it did.
 */
export function pickableRoles(style: boolean): readonly PickableRole[] {
  return style ? [...PICKABLE_ROLES, "style"] : PICKABLE_ROLES;
}

/**
 * The TOTAL reference ceiling, mirroring the server's default (`RefCapacity.total`,
 * server/studio/config.ts) so the ordinary case never spends a round trip to be refused.
 *
 * THE SERVER IS AUTHORITATIVE: it reads the cap off the model it actually routes to, and
 * STUDIO_REF_CAPS_JSON can move it. This is a courtesy trim; the 400 remains the real guard.
 */
export const MAX_ENGINE_REFERENCES = 6;

/**
 * What a request can carry, and an account of everything it cannot.
 *
 * The counts are not diagnostics — they are the copy on the Make it screen. An athlete who attached
 * four photographs and got a three-reference job is owed the sentence saying so.
 */
export interface EngineReferences {
  /** What the request carries. Asset ids and engine roles only, never a path. */
  references: EngineReference[];
  /** Attached, tagged as a look, and unsendable. */
  droppedInspiration: number;
  /** Attached but with no media_assets row yet, so there is nothing to point at. */
  droppedUnresolved: number;
  /** The same photograph attached twice — the server refuses a repeated assetId outright. */
  droppedDuplicate: number;
  /**
   * A clip tagged "You" on an EDIT. It cannot travel as a `person` reference without blocking the
   * whole preview (`refusedOnEdit`), and it was never usable as one — F-AM7.
   */
  droppedMotionOnEdit: number;
  /** Trimmed at the ceiling above. */
  droppedOverCap: number;
}

/**
 * Her tray, reduced to what the engine will accept.
 *
 * Order is preserved and the FIRST occurrence of a photograph wins, which matters because the tray
 * can hold one asset under two roles: `addAttachment` keys chips by `${role}:${assetId}`, so
 * attaching the same photo as both "your media" and "product" is two chips and one asset. The
 * server refuses a repeated assetId ("That photo is already on this list."), so the de-duplication
 * has to happen before the request, not after the 400.
 */
export function toEngineReferences(
  attachments: Attachment[],
  cap: number = MAX_ENGINE_REFERENCES,
  /**
   * The edit base, when there is one. It travels as `sourceAssetId` and must NOT also travel as a
   * reference: it is the frame being changed, not material to change it toward. Sending it twice
   * would pay its input tokens twice and would tell the model the picture it is editing is also a
   * likeness to render from, which is the role collision reasserting itself one layer down.
   */
  editBase: Attachment | null = null,
  /**
   * The library's `media_type` per asset id. Defaulted, so every caller that predates video sends
   * exactly what it always sent — an unknown id is not motion, and nothing is dropped.
   */
  mediaTypes: Readonly<Record<string, string>> = {},
): EngineReferences {
  let droppedInspiration = 0;
  let droppedUnresolved  = 0;
  let droppedDuplicate   = 0;
  let droppedMotionOnEdit = 0;

  const usable: EngineReference[] = [];
  const seen = new Set<string>();
  if (editBase?.assetId) seen.add(editBase.assetId);

  for (const a of attachments) {
    const role = ENGINE_ROLE[a.role];
    if (role === null)      { droppedInspiration += 1; continue; }
    if (!a.assetId)         { droppedUnresolved  += 1; continue; }
    // ─── F-AM7: A CLIP IS NOT A LIKENESS TO EDIT TOWARD ──────────────────────────────────────
    //
    // `source-frame` becomes the engine's `person`, and the server refuses an edit that carries
    // one at all: `refusedOnEdit` (server/studio/preview.ts) is `mode === "edit" && person.length
    // > 0`, with NO media-type predicate on it or on anything upstream of it — not the wire's
    // REFERENCE_ROLES, not `resolveReferences`, not `readOwnedImage` (which, despite its name,
    // filters id + athlete + stored + not-deleted and nothing else). So a clip tagged "You"
    // beside a marked photo resolves as a first-class person reference and BLOCKS the preview.
    //
    // Until now the only thing preventing that was `frameChoice("edit")` filtering the tray on
    // her way through the frame ask — a side effect of a UI branch, holding up a server contract.
    // This states it where both readings of the tile can see it: on an edit, a clip does not
    // travel. It is counted, not silently discarded, for the same reason every other drop is.
    if (editBase && a.role === "source-frame" && isMotion(a, mediaTypes)) {
      droppedMotionOnEdit += 1;
      continue;
    }
    // The edit base is pre-seeded into `seen`, so it falls out here rather than through a second
    // branch — and it is NOT counted as a dropped duplicate, because nothing was dropped: it is
    // travelling, as the thing being edited.
    if (seen.has(a.assetId)) {
      if (a.assetId !== editBase?.assetId) droppedDuplicate += 1;
      continue;
    }
    seen.add(a.assetId);
    usable.push({ assetId: a.assetId, role });
  }

  return {
    references: usable.slice(0, cap),
    droppedInspiration,
    droppedUnresolved,
    droppedDuplicate,
    droppedMotionOnEdit,
    droppedOverCap: Math.max(0, usable.length - cap),
  };
}

/**
 * How many OBJECT photos her tray will actually send — what `POST /studio/classify` is told as
 * `objectPhotos` (replace with reference). "change my earrings to these gold hoops" routes with one and
 * asks without, so the count is the photos that GO: the same survivors `toEngineReferences` sends, never
 * the tray itself (an unresolved upload, a duplicate or one past the cap is not attached to the job).
 */
export function objectPhotosIn(attachments: Attachment[]): number {
  // ⚠️ MUST AGREE WITH THE SERVER'S `attachedIn` (server/studio/nativeIntent.ts), which is the one
  // definition. This is the number the composer sends to /studio/classify for the draft badge and for
  // the plan's own routing call; a client that counts differently asks a question the server would not,
  // or skips one it would. Card 4 shipped broken with exactly that disagreement.
  //
  // Her Object photos, or — when the Object tile is EMPTY — her Product photos. Never summed.
  const refs = toEngineReferences(attachments).references;
  const objects = refs.filter((r) => r.role === "object").length;
  return objects || refs.filter((r) => r.role === "product").length;
}

/**
 * How many STYLE references her tray will send (PR 19, the look pointer) — what `/studio/classify` is told as
 * `stylePhotos`, so "match this look" finds her Style tile. Must agree with the server's `attachedIn`, which counts
 * `style_reference` roles; the same survivors `toEngineReferences` sends.
 */
export function stylePhotosIn(attachments: Attachment[]): number {
  return toEngineReferences(attachments).references.filter(
    (r) => r.role === "style_reference",
  ).length;
}

/**
 * Verbs that name an operation ON AN IMAGE THAT ALREADY EXISTS.
 *
 * This is the whole signal that separates the two things a photograph of hers can mean, and it has
 * to be a verb rather than the attachment, because the attachment is identical either way:
 *
 *   "put me on a rooftop at dusk"     + her photo  →  GENERATE. The photo is an identity anchor.
 *   "remove the ball"                 + her photo  →  EDIT.     The photo is the thing being changed.
 *
 * Deliberately NARROW. A miss costs nothing — it generates, which is exactly today's behaviour and
 * no regression at all. A false positive is the expensive direction: it routes to the edit pipeline,
 * where auto-mask either finds the region or REFUSES, and a refusal is a worse answer than the
 * generate she would otherwise have got. So this fires only on an explicit edit verb and never on
 * the mere presence of a photograph.
 */
const NAMES_AN_EDIT =
  /\b(remove|delete|erase|get rid of|replace|swap|change|recolou?r|blur|retouch|clean up|cover up|edit)\b/i;

/**
 * The same thing said with a SEPARATED PARTICLE, which the list above cannot see.
 *
 * "take the logo off my sleeve" and "crop the guy out" are the most natural way to ask for exactly
 * this, and `\btake off\b` misses both because English puts the object in the middle. The window is
 * bounded and stops at sentence punctuation, the same shape NAMES_A_PRODUCT uses, so "cut the
 * training short. head out" does not read as one phrase.
 *
 * The lookahead excludes "take me out" — that is a scene, not an edit — while still allowing "take
 * MY jersey off", which is one. The pronoun that follows the verb is the whole difference.
 */
const NAMES_AN_EDIT_SPLIT = /\b(take|cut|crop|rub|paint|wipe)\s+(?!me\b|myself\b)[^.?!]{0,30}\b(out|off)\b/i;

/**
 * WHICH ENGINE, ONCE THE ROLES HAVE ALREADY BEEN TRANSLATED.
 *
 * ─── THIS USED TO HARDCODE `image.generate`, AND WHY IT NO LONGER HAS TO ────────────────────────
 *
 * The reason was mechanical, not a preference: an `image.edit` needs a `sourceAssetId` AND at least
 * one measured region, the server refuses on both counts, and no screen outside CampaignWorkspace
 * had a mask editor — so an edit routed out of Create anything was a 400 or a permanently blocked
 * verdict, never an image.
 *
 * server/studio/autoMask.ts removed that. A region is now derived from her sentence, so the second
 * requirement is met by the instruction itself and an edit is reachable from a screen with no
 * canvas on it.
 *
 * ─── AND IT IS THE INSTRUCTION THAT DECIDES, NOT THE ROLE ──────────────────────────────────────
 *
 * `deriveIntent` forks on "is a source-frame attached", which is right for CampaignWorkspace, where
 * the tile means "the frame being edited". In Create anything the same tile means "this is me", and
 * one attachment therefore cannot decide between an edit and a reference-conditioned generate — the
 * documented `source-frame` collision. The sentence is what disambiguates it, so this takes both.
 *
 * The role itself is NOT renamed or split here. That is Mia's decision (see the TODO on
 * ENGINE_ROLE); this works with the collision in place by reading the thing that actually differs.
 */
export function engineIntentFor(
  format: StudioFormat,
  instruction?: string,
  attachments: Attachment[] = [],
  frameAssetId: string | null = null,
): StudioIntent {
  if (format === "video") return "video.generate";
  return editBaseFor(instruction, attachments, frameAssetId) ? "image.edit" : "image.generate";
}

/**
 * The photograph an edit would be performed ON, or null when this is not an edit.
 *
 * BOTH conditions, because either alone is ambiguous: a sentence naming an edit with nothing
 * attached has nothing to edit, and a photograph with no edit verb beside it is an anchor for a
 * generate.
 *
 * `frameAssetId` is HER MARK — see `frameFor`. It is threaded through rather than resolved here so
 * the gate and the pick stay separable, which is the same reason `sourceFrameFor` was extracted.
 *
 * It must have an `assetId`: an attachment still uploading has no row to point at, and the server
 * resolves the base by id under the authenticated athlete.
 */
export function editBaseFor(
  instruction: string | undefined,
  attachments: Attachment[],
  frameAssetId: string | null = null,
): Attachment | null {
  if (!instruction) return null;
  if (!NAMES_AN_EDIT.test(instruction) && !NAMES_AN_EDIT_SPLIT.test(instruction)) return null;
  return frameFor(attachments, frameAssetId);
}

/**
 * IS THERE A PHOTOGRAPH HERE THAT COULD BE EDITED — a yes/no, and nothing about WHICH one.
 *
 * ─── WHY THIS CAME OUT OF `editBaseFor` ────────────────────────────────────────────────────────
 *
 * That function does two jobs at once: it GATES (does this sentence name an edit) and it PICKS
 * (which attachment is the base). The gate is the verb list, and the verb list is what the cutover
 * replaces — but the picking is needed whoever decides. "make the socks blue" is an edit the server
 * routes and the verb list cannot see, and it still needs a base to be performed on.
 *
 * ⚠️ IT IS NO LONGER THE PICKER, AND THAT SPLIT IS WHAT THIS PR IS ABOUT. It used to return the
 * first `source-frame` in the tray and every caller took that as the frame being edited — so the
 * frame was ARRAY POSITION, and attaching material before her photograph silently made the material
 * the frame (sweep 7.2, reproduced: ball first + "make the socks yellow" → `sourceAssetId` = the
 * ball). `frameFor` picks now, from her explicit mark. This answers only the question
 * `hasSourcePhoto` actually asks, where "which one" is genuinely irrelevant.
 *
 * Kept rather than folded into `frameCandidates(...).length > 0` because the call site
 * (use-studio-pending) reads better as a question than as a count, and because its own docstring
 * there is about why the question must not be filtered through the verb gate.
 *
 * 2026-09-16 (frame defaulting): no longer what `hasSourcePhoto` asks — a photograph of hers COULD be
 * edited only once she has marked it (`markedFrame`). Its one caller now is SetupScreen, which has no
 * badge to mark with and passes this as its frame explicitly, so that screen routes exactly as before.
 */
export function sourceFrameFor(attachments: Attachment[]): Attachment | null {
  return frameCandidates(attachments)[0] ?? null;
}

/**
 * Every attachment that COULD be the frame: her own media, with a row to point at.
 *
 * An attachment still uploading has no `assetId` and cannot be a base, so it is not a candidate —
 * which also means the mark can never point at one.
 */
export function frameCandidates(attachments: Attachment[]): Attachment[] {
  return attachments.filter((a) => a.role === "source-frame" && !!a.assetId);
}

/**
 * THE PHOTOGRAPH SHE MARKED, or null — with no fallback of any kind (frame defaulting, 2026-09-16).
 *
 * `frameFor` without its shim. A mark that names nothing in the tray, or something that cannot be a
 * base, is no frame: nothing else in the tray is promoted to stand in for it.
 */
export function markedFrame(
  attachments: Attachment[],
  frameAssetId: string | null,
): Attachment | null {
  if (!frameAssetId) return null;
  return (
    frameCandidates(attachments).find((a) => a.assetId === frameAssetId) ?? null
  );
}

/**
 * THE FRAME BEING EDITED, FROM HER EXPLICIT MARK — never from tray order.
 *
 * ─── THE INVARIANT THIS EXISTS TO HOLD ─────────────────────────────────────────────────────────
 *
 * A reference can never displace the frame. Before this, the frame was `attachments.find(...)` —
 * so the frame was decided by the order she happened to tap, and every later attachment was a
 * chance to change it. Sweep 7.2 caught it live: a soccer ball attached before her photograph
 * became `sourceAssetId`, the edit targeted the ball, and her photograph travelled as a `person`
 * reference. The model was told the ball was the frame.
 *
 * Now the frame is a NAMED ASSET she marked, carried in screen state (`frameAssetId`) and moved
 * only by her — see `nextFrameAssetId` for the rule that keeps it still when the tray changes
 * underneath it. Nothing downstream re-derives it.
 *
 * ⚠️ THE `?? [0]` FALLBACK IS A COMPATIBILITY SHIM, NOT THE CONTRACT. A caller that passes no mark
 * gets the old first-candidate answer, because the alternative — returning null and routing an
 * edit to GENERATE — is the direction `routeWithServer` spends its whole safety argument avoiding:
 * a generate that should have been an edit costs her the photograph. So an un-marked caller is no
 * worse than today, and a marked one cannot be wrong. Every product path marks.
 *
 * 2026-09-16 (frame defaulting): and no product path reaches the shim any more. `routeMarked` hands
 * routing only the photograph she marked, so with nothing marked there is no candidate for the
 * fallback to find. The shim stays for direct callers of `routeWithServer`, whose tests read the same.
 */
export function frameFor(
  attachments: Attachment[],
  frameAssetId: string | null,
): Attachment | null {
  const candidates = frameCandidates(attachments);
  if (frameAssetId) {
    const marked = candidates.find((a) => a.assetId === frameAssetId);
    if (marked) return marked;
  }
  return candidates[0] ?? null;
}

/**
 * WHERE THE MARK GOES AFTER THE TRAY CHANGES — the "a reference can never displace it" rule, as a
 * pure function so it is a tested property rather than a line in a component.
 *
 * Three cases, and the middle one is the whole point:
 *
 *   nothing marked yet   → NOTHING. A photograph of hers in the tray is not a frame until she says
 *                          so — see the note below.
 *   already marked       → LEAVE IT. This is the rule. Attaching a second photograph, a product or
 *                          an object cannot move the frame, however the tray reorders around it.
 *   the mark is gone     → NOTHING. She removed the frame itself; no other photograph takes over.
 *
 * It never returns an id that is not a candidate, so a stale mark cannot survive a removal.
 *
 * ─── THE MARK IS NEVER DEFAULTED — 2026-09-16, FRAME DEFAULTING ────────────────────────────────
 *
 * This used to fill the first two blanks with the first candidate: her first photograph was the
 * frame, and removing the frame handed the mark to the next one. So a tray of photographs of her
 * ALWAYS had a frame, the EDITING badge could not be cleared (× moved it on), and a generate built
 * from several photos of her could not be expressed at all — every one planned as an edit of the
 * first, and an edit refuses photos of her (`refusedOnEdit`, server/studio/preview.ts). R1's pack
 * acceptance stopped on it (docs/probes/reference-packs.md).
 *
 * Now the frame is only ever what she marked: a tap on the photo, Edit this, or the thread's
 * continuation. A photograph she did not mark is her likeness for a new image. What that costs is
 * written up on ENGINE_ROLE, under the same date.
 */
export function nextFrameAssetId(
  attachments: Attachment[],
  current: string | null,
): string | null {
  const candidates = frameCandidates(attachments);
  if (current && candidates.some((a) => a.assetId === current)) return current;
  return null;
}

/** Everything the routing decision produces, whichever side of the flag made it. */
export interface RoutedPlan {
  intent: StudioIntent;
  /** The frame being changed. Null on every generate. */
  editBase: Attachment | null;
  /**
   * Why the classifier declined to route, when it did. Null on every answer that routes.
   *
   * A string rather than a boolean because the whole point of refusing HERE is that the refusal can
   * say why: `person_target` and `fast_path_declined` are different UI. See `askCopyFor` in
   * screens/studio/planLogic.
   */
  askReason: string | null;
  /**
   * Set only when the server's classifier asked AND said the preview may interpret the ask (the
   * interpreter, I.6): the sentence travels to the preview as an edit of her frame, and the preview says
   * what it made of it — or asks, as it would have here. Absent on every other answer.
   */
  interpreting?: true;
}

/**
 * WHICH ENGINE, WITH THE SERVER'S ANSWER IN HAND — the cutover's decision, as a pure function.
 *
 * ─── THE RULE: EDIT IF THE SERVER SAYS EDIT *OR* THE OLD VERB LIST DOES ────────────────────────
 *
 * Not "the server decides, full stop". The two gates are OR'd, and that asymmetry is the whole
 * safety argument for shipping this:
 *
 *   A photograph that gets EDITED when it should have been generated costs her one round trip. She
 *   sees an edit, says it again more plainly, and her original is untouched beside it.
 *
 *   A photograph that gets GENERATED when it should have been edited costs her the photograph.
 *
 * OR-ing the gates means the new path can never generate where the old path would have edited — the
 * set of sentences that reach `image.generate` only ever SHRINKS at this flag. So every case where
 * the cutover is wrong lands on the recoverable side by construction, rather than by our having
 * thought of it. That is also what makes the old verb list defence-in-depth rather than dead weight
 * while both are live: it is still consulted, and it can still only ever pull toward the edit.
 *
 * ─── WITH NO ANSWER, IT IS TODAY'S BEHAVIOUR EXACTLY ───────────────────────────────────────────
 *
 * `classification` is undefined while the round trip is in flight, when it failed, and when the
 * flag is off. All three fall back to `engineIntentFor` — the pre-cutover path, unchanged. A
 * classifier we cannot reach must not be a classifier that changes what happens; the fallback is
 * the behaviour we already ship.
 */
export function routeWithServer(
  format: StudioFormat,
  classification: StudioClassification | undefined,
  instruction: string | undefined,
  attachments: Attachment[],
  /**
   * HER MARK — which attachment is the frame. See `frameFor`; a caller that omits it gets the old
   * first-candidate behaviour, which is why every existing test below still reads the same.
   */
  frameAssetId: string | null = null,
  /**
   * STUDIO_INTERPRETER (client/lib/flags.ts). Off — and a caller that omits it — and an ask is exactly
   * today's ask.
   */
  interpreter = false,
  /**
   * STUDIO_IMAGE_OPS (PR 19). On, a GENERATE the server answered wins over the old edit-verb list: "change my pose" is
   * a new picture of her (R-8), never an edit of the marked frame the freeze would refuse. Off — and a caller that
   * omits it — routing is exactly today's.
   */
  imageOps = false,
): RoutedPlan {
  // Motion never reaches the classifier: an edit is stills-only, mirroring DELIVERABLES_FOR and the
  // server's taskForPair(). Asking about a sentence that cannot produce an edit either way would be
  // a round trip whose answer is ignored.
  if (format === "video") {
    return { intent: "video.generate", editBase: null, askReason: null };
  }

  const oldBase = editBaseFor(instruction, attachments, frameAssetId);

  if (!classification) {
    return {
      intent: engineIntentFor(format, instruction, attachments, frameAssetId),
      editBase: oldBase,
      askReason: null,
    };
  }

  // ASK is not a path and there is nothing to route. The reason travels; the intent stays whatever
  // the old path would have said, so a caller that ignores `askReason` gets today's behaviour
  // rather than something new — the refusal is a stop, never a redirect.
  if (classification.initialPath === "ASK") {
    // ─── AN ASK THE INTERPRETER MAY TAKE (the interpreter, I.6) ─────────────────────────────────────
    //
    // Only when the server said so (`interpretable` — its own answer, never inferred here), the flag is on,
    // and there is a frame she marked: the sentence goes to the preview as an EDIT of that frame, and the
    // preview interprets it — or asks with the line she would have seen here. It never becomes a
    // generate: an interpreted sentence is always an edit of her photograph.
    const frame = frameFor(attachments, frameAssetId);
    if (interpreter && classification.interpretable === true && frame) {
      return {
        intent: "image.edit",
        editBase: frame,
        askReason: null,
        interpreting: true,
      };
    }
    return {
      intent: engineIntentFor(format, instruction, attachments, frameAssetId),
      editBase: oldBase,
      askReason: classification.reason ?? "unspecified",
    };
  }

  const serverSaysEdit =
    classification.initialPath === "FULL_IMAGE" ||
    classification.initialPath === "MASKED" ||
    classification.initialPath === "BACKGROUND";

  // The base is picked WITHOUT the verb gate — that is the point of `frameFor` existing. And an
  // edit with no base is not an edit: the server refuses it ("editing needs the photo you want to
  // edit"), so a missing frame falls back to a generate rather than travelling as a 400.
  const base = frameFor(attachments, frameAssetId);
  // ⚠️ MUTATION M-x2 (client → server): let the verb list override the server's GENERATE again — "change my pose from a
  // marked frame is a generate" reds by name (createAnythingLogic.imageOps.test).
  const serverSaysGenerate =
    imageOps && classification.initialPath === "GENERATE";
  if ((serverSaysEdit || (oldBase !== null && !serverSaysGenerate)) && base) {
    return { intent: "image.edit", editBase: base, askReason: null };
  }

  return { intent: "image.generate", editBase: null, askReason: null };
}

/**
 * `routeWithServer`, over ONLY THE PHOTOGRAPH SHE MARKED — what every screen with a tray routes through
 * (frame defaulting, 2026-09-16).
 *
 * `routeWithServer` reads its attachments for one thing, the frame (`editBaseFor`, `frameFor`,
 * `engineIntentFor`), and with no mark `frameFor` falls back to the first photograph of hers. So a tray
 * holding photos of her always routed with a frame, and "generate a pic of me playing soccer" with her
 * pack attached planned as an edit of the first one. Handing it the marked photograph alone — or
 * nothing — means the fallback has nothing to find: no mark, no frame, whatever the sentence says.
 *
 * The references still come from the WHOLE tray (`toEngineReferences`, in the hook); only routing is
 * narrowed. The same fact decides `hasSourcePhoto` on the classify call: a photograph is there to be
 * edited when she marked one (`markedFrame`), and not because one is attached.
 */
export function routeMarked(
  format: StudioFormat,
  classification: StudioClassification | undefined,
  instruction: string | undefined,
  attachments: Attachment[],
  frameAssetId: string | null,
  interpreter = false,
  /** STUDIO_IMAGE_OPS (PR 19) — see `routeWithServer`. */
  imageOps = false,
): RoutedPlan {
  const frame = markedFrame(attachments, frameAssetId);
  return routeWithServer(
    format,
    classification,
    instruction,
    frame ? [frame] : [],
    frame?.assetId ?? null,
    interpreter,
    imageOps,
  );
}

/**
 * THE PREVIEW REQUEST A JOB DESCRIBES — the check's body, built in ONE place (catch-all through the interpreter,
 * 2026-09-16).
 *
 * It was composed inside `useGenerationPlan`, and nothing else sent it. Now the composer sends it too: a sentence
 * the interpreter may read is checked at SEND, against the one photo of hers in the tray, and the sheet then shows
 * that same preview rather than asking again (the interpreter is not deterministic run to run — ledger F-I5 — so
 * a second call could read her words differently). Reuse is only honest if both built the same request, byte for
 * byte, so both build it here: the hook's composition moved verbatim, key order included.
 *
 * `routed` and `refs` come back with it because the hook renders from them; the send only needs `request`, and
 * that `routed.interpreting` is set.
 */
export function previewRequestFor(job: {
  format: StudioFormat;
  /** The classifier's answer to her words, over her mark — undefined with routing off, in flight, or failed. */
  classification: StudioClassification | undefined;
  direction: string | null | undefined;
  attachments: Attachment[];
  frameAssetId: string | null;
  brandId?: number | null;
  regions?: StudioRegion[] | null;
  /** STUDIO_INTERPRETER. */
  interpreter: boolean;
  /** STUDIO_IMAGE_OPS (PR 19). Absent is off: routing exactly as it was. */
  imageOps?: boolean;
  /**
   * The library's `media_type` per asset id. Defaulted to empty, so a caller that does not have it
   * builds exactly the request it built before — F-AM7 only ever REMOVES a reference, and only one
   * that would have blocked the preview it belongs to.
   */
  mediaTypes?: Readonly<Record<string, string>>;
  /** quality-scrappy piece 5: a re-quote's gate codes (Try again on a failed output). Absent: the request it was. */
  corrective?: string[];
}): { routed: RoutedPlan; refs: EngineReferences; request: PreviewRequest } {
  const { format, direction, attachments, brandId, regions } = job;
  // Over her mark alone — the references below still come from the whole tray (`routeMarked`).
  const routed = routeMarked(
    format,
    job.classification,
    direction ?? undefined,
    attachments,
    job.frameAssetId,
    // An ask the server says the preview may interpret travels as an edit of her frame (I.6).
    job.interpreter,
    job.imageOps === true,
  );
  const editBase = routed.editBase;
  const refs = toEngineReferences(attachments, MAX_ENGINE_REFERENCES, editBase, job.mediaTypes);
  const request: PreviewRequest = {
    intent: routed.intent,
    deliverable: deliverableFor(format),
    objective: objectiveFor(brandId),
    ...(direction?.trim() ? { direction: direction.trim() } : {}),
    brandId: brandId ?? null,
    ...(refs.references.length ? { references: refs.references } : {}),
    // THE EDIT BASE, and still NO regions from this screen.
    //
    // The comment that used to sit here said an edit routed out of this flow could only be a 400
    // or a permanently blocked verdict, because an edit needs a measured region and there is no
    // mask editor on these screens. That was true and is no longer: the server derives the region
    // from her sentence (server/studio/autoMask.ts) and hands it back as `derivedRegions` for the
    // editor to be seeded with. So the base travels and the regions do not — the one thing this
    // screen still cannot supply is the one thing the server now supplies for it.
    //
    // `regions` DOES get sent once she corrects the derived box; that is the re-check in the hook.
    ...(editBase?.assetId ? { sourceAssetId: editBase.assetId } : {}),
    ...(regions?.length ? { regions } : {}),
    ...(job.corrective?.length ? { corrective: job.corrective } : {}),
  };
  return { routed, refs, request };
}

/**
 * A PREVIEW ALREADY CHECKED, AND THE REQUEST IT WAS CHECKED FOR (catch-all through the interpreter, C2).
 *
 * The composer's send read her words through the interpreter and got a proposal; the sheet it opens shows THAT
 * preview rather than asking again. It travels with the job in memory only — the thread's stored material names
 * fields one by one (`materialOf`), and Check again rebuilds a job without one, so it always asks.
 */
export interface PreviewSeed {
  request: PreviewRequest;
  preview: GenerationPreview;
}

/**
 * THE SEED'S PREVIEW, when it was checked for exactly this request — byte for byte, as `previewRequestFor` built
 * both — or null, and the screen asks as it always did. A mask she corrects is a different request (its regions),
 * so the seed stops answering the moment it would be stale.
 */
export function seededPreview(
  seed: PreviewSeed | null | undefined,
  request: PreviewRequest,
): GenerationPreview | null {
  if (!seed) return null;
  return JSON.stringify(seed.request) === JSON.stringify(request)
    ? seed.preview
    : null;
}

/**
 * The asks that still NAME AN EDIT — the classifier read an operation on her photograph and declined only how to do
 * it (auto-mark, 2026-09-16; Adi's D1, S2).
 *
 * Each is an edit by its own definition: a brand change or removal, a compound it read part of or found in conflict,
 * "if there are any logos…", an add it could not place (worn or not), a replacement pointing at a photo that is not
 * attached, more changes than one call takes, a headline out of bounds, a look it does not know.
 *
 * NOT here, each for its own reason:
 *   fast_path_declined          the catch-all. "take the logo off my sleeve" lands in it, and so do "generate pic of
 *                               me playing soccer" and "me dunking in a stadium" — marking it would undo frame
 *                               defaulting for every generate the rules cannot read. The edit-shaped ones are a
 *                               classifier-vocabulary follow-up (docs/probes/auto-mark.md), not a wider catch-all.
 *   person_target, _mentioned   a refusal of an edit to her. Marking only to refuse is worse than the new image.
 *   no_steps                    nothing was read clearly enough to be an operation of either kind.
 *   generate_not_permitted      a generate she asked for.
 *
 * An unknown code — one the server added after this — is not here either, so it leaves the photo her likeness: the
 * behaviour frame defaulting shipped.
 */
const EDIT_SHAPED_ASKS: ReadonlySet<string> = new Set([
  "brand_change",
  "brand_removal",
  "compound_partial",
  "compound_conflict",
  // Since the preservation fixes (#488): she kept a thing her change would alter — an edit, asked about (auto-mark, placed
  // beside compound_conflict when #488 was merged in; Adi to confirm).
  "keep_conflict",
  "conditional",
  "add_unclear",
  "worn_add_unclear",
  "object_photo_missing",
  "too_many_changes",
  "headline_bounds",
  "look_unknown",
]);

/**
 * PR 19's two asks, edit-shaped with STUDIO_IMAGE_OPS on: "make it pop" and "match this look" are about THIS photo, so
 * her frame is kept and she sees the ask (its op chips, or where to attach a Style) instead of a new image.
 * ⚠️ MUTATION M-x1 (client → server): drop `vague` — "the vague ask keeps her frame" reds by name.
 */
const IMAGE_OPS_EDIT_ASKS: ReadonlySet<string> = new Set([
  "vague",
  "style_reference_missing",
  // W-5: "change the angle" is about this photo; its chips name the angles.
  "angle_unclear",
]);

/**
 * IS HER SENTENCE EDIT-SHAPED — told there IS a photograph to edit, does the classifier read an edit (auto-mark).
 *
 * `classification` must be `route(sentence, true, …)`'s answer: with no photo the classifier answers GENERATE for every
 * sentence, so the question can only be asked as though the photo were marked.
 *
 *   routing on, an answer   a routed edit path, or an ask whose code names an edit (`EDIT_SHAPED_ASKS`).
 *   routing on, no answer   NO. In flight or failed, a classifier we cannot reach must not change what happens, and
 *                           what happens without it is frame defaulting's: her photo is her likeness.
 *   routing off             the verb list — the same fallback `routeWithServer` takes with no answer, so an edit
 *                           sentence plans as an edit on both sides of the flag.
 *
 * Deliberately NOT `routeMarked(...).intent`: that ORs the old verb list over the server's answer, so "create an adidas
 * ad featuring me, remove any nike logos" (GENERATE, with "remove" in it) would read as an edit.
 */
export function editShaped(
  routing: boolean,
  classification: StudioClassification | undefined,
  instruction: string | undefined,
  /** STUDIO_IMAGE_OPS (PR 19): PR 19's two asks are edit-shaped too. Absent is off. */
  imageOps = false,
): boolean {
  if (!routing) {
    return (
      !!instruction &&
      (NAMES_AN_EDIT.test(instruction) || NAMES_AN_EDIT_SPLIT.test(instruction))
    );
  }
  if (!classification) return false;
  if (classification.initialPath === "ASK") {
    return (
      !!classification.reason &&
      (EDIT_SHAPED_ASKS.has(classification.reason) ||
        (imageOps && IMAGE_OPS_EDIT_ASKS.has(classification.reason)))
    );
  }
  return (
    classification.initialPath === "FULL_IMAGE" ||
    classification.initialPath === "MASKED" ||
    classification.initialPath === "BACKGROUND"
  );
}

/**
 * The objective, derived rather than asked.
 *
 * Mirrors CampaignWorkspaceScreen's own default, which is the only other place this choice gets
 * made: a job with a brand on it is showing their product, and one without is hers to grow on. No
 * screen collects this today and none is added here — the server requires the field, so the choice
 * is between a default and a 400.
 */
export function objectiveFor(brandId: number | null | undefined): StudioObjective {
  return brandId != null ? "showcase-product" : "grow-following";
}

/**
 * WHY WE DIDN'T RUN IT, IN HER LANGUAGE — the classifier's reason code, turned into a sentence.
 *
 * ─── THE WHOLE REASON THE CODE TRAVELS THIS FAR ────────────────────────────────────────────────
 *
 * `person_target` and `fast_path_declined` are both ASK, and they are not the same thing to say.
 * One is a refusal — we will not edit a picture of her body — and there is no rephrasing that
 * changes the answer. The other is a question: we could not read the sentence, and saying it
 * differently is exactly what fixes it. Telling her "we couldn't do that" in both cases sends her
 * to rewrite a sentence that was never the problem, or to give up on one that was.
 *
 * The classifier already did the work of telling them apart (server/studio/classify.ts). This is
 * the last place that work can be thrown away, so it is the place it must not be.
 *
 * ─── AND THE FALLBACK IS A QUESTION, NEVER AN APOLOGY ──────────────────────────────────────────
 *
 * An unknown code is a reason the server added and this screen has not learned yet. The safe copy
 * for that is the one that invites another sentence, because a reason we cannot read is far more
 * likely to be "we did not understand" than "we refuse" — and it is the answer that leaves her with
 * something to do.
 */
/**
 * WHAT IS SITTING BESIDE THE MARKED PHOTO, when the frame ask fires — F-AM7's half of the fix.
 *
 * The ask's sentence claimed "other photos of you" unconditionally, which is false the moment one
 * of them is a clip. The mechanism to say something true is here; WHICH true sentence is Mia's
 * (see the ⚠️ placeholder markers below). `undefined` keeps the sentence that ships today, so
 * every caller that does not know about media types is unchanged.
 */
export type FrameCompanions = "photos" | "video" | "mixed";

export interface AskCopyOptions {
  /** Only read for `frame_with_likeness`; ignored for every other code. */
  companions?: FrameCompanions;
}

export function askCopyFor(reason: string, opts: AskCopyOptions = {}): string {
  switch (reason) {
    // ─── THREE DECLINES THAT USED TO SHARE ONE SENTENCE (PR C′, C.4) ───────────────────────────
    //
    // Measured on the 2026-09-09 G checks: an add she could not place, an edit to her body and a
    // brand change all arrived as `fast_path_declined` and all rendered "name the thing and what it
    // should become" — advice she had already followed in two of the three. The server now sends a
    // code per case (server/studio/classify.ts, declineReason); these are the words.
    //
    // HER BODY — refused, and no rephrasing changes that, so this copy does not invite one. Two
    // codes, one answer: `person_target` is the guard refusing a routed step, `person_mentioned` is a
    // sentence the fast path could not read that names only her ("make my arms bigger").
    case "person_target":
    case "person_mentioned":
      return "We don't edit people in photos — not a body, not a face, and we won't add a person. Studio changes what's around you: clothing, gear, objects and the background.";
    // AN ADD IT COULD NOT PLACE — she named the thing; what is missing is where. The second sentence
    // is there because people write their own "keep everything else the same", and that is exactly
    // what stopped the parse.
    case "add_unclear":
      return "To add something, say what it is and where it goes — \"add a soccer ball between my cleats\". You don't need to ask us to keep the rest of your photo the same; that part is automatic.";
    // A BRAND CHANGE IT COULD NOT READ (2026-09-10). Brand changes ROUTE now — a product decision, and
    // server/studio/classify.ts's rule 4c — so this is no longer a refusal and must not read like one:
    // it is the (a)-style teaching sentence, and its example is one 4c routes (pinned in the test, by
    // routing the example itself). What still reaches it: a colour INSIDE an item, a negation, a second
    // brand, a fifth item, a second instruction. ⚠️ PLACEHOLDER WORDING, a Mia review item.
    //
    // It LEADS with the one-item form, says a colour can come with it (descriptors route, B.1b), keeps
    // the four-item list as the extra, and names what still asks. NOT a model name any more: since
    // B.1c a model name routes as the brand, disclosed on the preview, so this line must not say
    // Studio refuses one.
    //
    // ⚠️ AND NOT "ONE CHANGE PER SENTENCE" ANY MORE (composition): "change my jersey to adidas and make
    // the socks white" routes now, each clause read by its own rule. What still asks is a second brand
    // inside ONE change ("a nike adidas kit"), so that is what the last sentence names.
    case "brand_change":
      return "Name the item and the brand — \"change my jersey to adidas\". A colour can come with it, like \"make my jersey a blue adidas kit\", and you can list up to four items at once. Each change can name one brand.";
    // A REMOVAL THAT NAMES A BRAND, which the fast path could not read — "remove the 8 and nike logo".
    // The brand_change line above teaches switching, the wrong answer to a removal. She DID name both
    // things; two readings stopped it. The digit is not a word, so "the 8" is not read — hence "spell
    // out numbers". And the removal rule reads only a thing with its own "the": "remove the eight and
    // nike logo" ROUTES, and removes the eight alone, dropping the logo without a word (a pre-existing
    // rule-1 partial, pinned in classify.test.ts). So the copy asks for both, and its example has both.
    // Whether a brand's mark may be removed at all is a Mia policy item; this line decides nothing.
    case "brand_removal":
      return "To take a logo or a number off, spell out numbers rather than typing the digit, and give each one its own \"the\" — \"remove the number eight and the nike logo\".";
    // ─── A SENTENCE OF SEVERAL CHANGES THAT STILL ASKS (composition, 2026-09-10) ──────────────────
    //
    // Composition routes a sentence of different changes, each clause through its own rule
    // (server/studio/classify.ts, rule ½), so PR 1's "one change per sentence right now" went stale
    // and is retired with its code, `compound_pending`. These three are what still asks, each true of
    // its case. A clause that asks on its own keeps its own code and copy — a body edit is the person
    // refusal above, an add with no place `add_unclear` — so these are only for what no clause says.
    //
    // ONE PART IT COULD NOT READ, in a sentence whose other parts it could: the catch-all, per clause.
    // No example — the part to reword is hers to find, and a quoted phrasing here would be a guess.
    case "compound_partial":
      return "We can do a few changes at once, but couldn't follow one part of that. Try each change on its own to find the part that needs rewording.";
    // More than the pipeline's four steps across the clauses — a brand change can be four by itself.
    // Asked up front rather than cut, so nothing she asked for is dropped without a word.
    case "too_many_changes":
      return "That's more than four changes in one go — split it into two edits.";
    // Two parts that cannot both happen: two backgrounds or two looks (a photo has one of each), or a
    // change to something the same sentence removes — she would pay for a change deleted in the same
    // call. Which she meant is not guessed.
    // A THING SHE KEPT, THAT HER CHANGE WOULD ALTER (the preservation fixes, K2, 2026-09-16) — "make it warmer but
    // keep the background the same", "make everything blue but keep my cleats". Not the conflict line above: she
    // asked for one change and one keep, not two changes. It says why (a look or a background covers the whole
    // photo) and how to get what she meant, and its example routes (pinned in the test, by routing it). A keep
    // she types beside a change we CAN make is simply honoured — this line is only for the conflict.
    // ⚠️ PLACEHOLDER WORDING, for the copy-review pile (Mia). The server's blocked-preview line is the same words
    // (server/studio/nativeIntent.ts, ASK_NOTES).
    case "keep_conflict":
      return "A look or a new background covers the whole photo, so it can't leave that part untouched. Name just the thing to change — \"make the socks blue\" — and everything you don't name stays as it is.";
    case "compound_conflict":
      return "That asks for two things that can't both happen — two backgrounds, two looks, or a change to something it also removes. Pick the one you want and try again.";
    // A CONDITION ON THE PICTURE (guard scope, 2026-09-10) — "…so if there are any, remove them". The
    // classifier does not read one (server/studio/classify.ts, rule ¼): it once turned Mia's into a
    // removal of her uniform. Honest that it is a gap, and the fix is hers to make in one move — say
    // the change itself. The example routes (pinned in the test, by routing it).
    case "conditional":
      return 'We can\'t do "if" yet — tell us the change directly, like "remove the nike logo".';
    // (`add_onto_body` — G.3's "a call we haven't made yet" for earrings onto her — is retired: Mia made
    // the call, M3, and those sentences route now. A server that still sent it would get the question
    // every unknown code gets, below. PR M3.)
    //
    // A WORN ADD IT COULD NOT READ (PR M3.8) — "add small gold hoops to my ears", "put a baseball cap on my
    // head". The thing she wears, onto its own place, with a word the classifier does not read beside it.
    // The same sentence said plainly routes, so this says so — never the person line above, which is false
    // of hoops. The example routes (pinned in the test, by routing it).
    case "worn_add_unclear":
      return 'Say the item plainly and where it goes — "add gold hoops to my ears".';
    //
    // A HEADLINE WHOSE WORDS ARE OUT OF BOUNDS (PR T, N8) — `add the headline "…" across the top`, said
    // exactly, with more than four words or 24 characters, a character beyond plain letters, numbers and
    // ! ? & ' . -, a brand's name, or a tagline on the deny-list (server/studio/classify.ts,
    // `headlineBound`). Her sentence was right; her words were not, so it quotes no phrasing to copy.
    // Reached only with STUDIO_DISPLAY_TEXT on. ⚠️ PLACEHOLDER WORDING, a Mia review item.
    case "headline_bounds":
      return "A headline can be up to four words and 24 characters, in plain letters and numbers, and can't use a brand's name or slogan. Try another line of your own.";
    //
    // A LOOK SHE NAMED THAT WE DO NOT HAVE (style vocabulary, V.4) — "give it a dreamy vibe", "add a dreamy
    // filter". She named a look, so the catch-all's "name the thing" is false of it. This says the feature
    // honestly and names some looks that route; every one it names routes (pinned in the test, by routing
    // each). Never a suggestion — M6's looks come only from her words, and this is a list she can pick
    // from, not a look applied. ⚠️ PLACEHOLDER WORDING, a Mia review item.
    case "look_unknown":
      return "That look isn't one we know yet — try warmer, moodier, cinematic, vintage or black and white.";
    //
    // SHE POINTED AT A PHOTO SHE HAS NOT ATTACHED (replace with reference, 2026-09-11) — "change my
    // earrings to THESE gold hoops" with nothing in the Object tile. Read as words alone it would be a
    // description, and "these" says it isn't one, so it asks. Two ways forward, both hers: show us, or
    // say it. The example routes, and routes as what it says (pinned in the test, by routing it) — the
    // obvious one, "change my earrings to gold hoops", routes as gold earrings with "hoops" dropped.
    case "object_photo_missing":
      return 'Attach a photo of the thing you want with the Product or Object tile — or describe it instead, like "make my earrings gold".';
    //
    // ─── AN AD, AS THE INTERPRETER'S AD GATE ASKS (the interpreter, I.4) ─────────────────────────────
    //
    // The server's own lines, verbatim (server/studio/nativeIntent.ts, ASK_NOTES) — they reach her on the
    // blocked preview, and a screen that ever renders the code says the same thing. ⚠️ PLACEHOLDER WORDING
    // for the second and third, Mia review items; the first is v1 §3's, and it says WHERE, because Create
    // anything has no brand picker (M5).
    case "ad_needs_brand":
      return "An ad for which brand? Name it — 'turn this into an adidas ad' — or start from Brand post and pick it.";
    case "ad_brand_mismatch":
      return "That ad names a different brand from the one you picked, or more than one. Name the one brand it's for.";
    case "ad_too_many_changes":
      return "Your changes plus the kit swap this ad needs come to more than four. Ask for fewer changes of your own, or make some first as their own edit.";
    //
    // ─── A NEW IMAGE, AS THE INTERPRETER ANSWERS IT (the new-image exit, interpret/5) ───────────────────
    //
    // Not the classifier's code: the interpreter read her words as a new picture of her, not an edit of this
    // photo ("me on a beach"), and the preview blocked on it. Her thread's card reads the code before the note,
    // so without this line the history would say "not sure what to change" where the preview said new image.
    // The server's line, verbatim (server/studio/nativeIntent.ts, NEW_IMAGE_NOTE — the same words a GENERATE
    // on a photo gets). ⚠️ PLACEHOLDER WORDING, for the copy-review pile (Mia).
    case "new_image":
      return "That asks for a new picture of you, not a change to this photo — start a new image instead.";
    //
    // ─── PR 19's asks (STUDIO_IMAGE_OPS; the server sends them only with it on) ─────────────────────────
    // ⚠️ PLACEHOLDER WORDING, for the copy-review pile (Mia).
    case "vague":
      return "Better how? Pick one to start from, or say what should change.";
    case "style_reference_missing":
      return "Which look? Add the photo whose look you want with the Style tile, then say it again.";
    case "angle_unclear":
      return "Which angle? Pick one, or say it — from below, from above, or straight down.";
    //
    // ─── A MARKED PHOTO AND OTHER PHOTOS OF HER, IN ONE SEND (frame defaulting, F.4) ─────────────────
    //
    // Not the classifier's code: Create anything asks it itself, before any check, when she marked a photo to
    // edit and attached other photos of herself (screens/studio/createAnythingLogic.ts, FRAME_ASK). An edit
    // cannot also be built from photos of her, so the question is which she meant; the card under it offers
    // both answers. In her thread's history it is this line alone, with whatever she chose below it.
    // ⚠️ PLACEHOLDER WORDING, for the copy-review pile (Mia).
    case "frame_with_likeness":
      // ─── F-AM7: THE ASK STILL FIRES, IT JUST STOPS LYING ────────────────────────────────────
      //
      // The ledger entry (docs/probes/sweep-4-ledger.md) reads as though the ask itself were the
      // bug. It is not, and the fix that suggests itself — give `frameChoiceNeeded` the motion
      // filter `canvasesIn` has — is WRONG and is pinned against in createAnythingLogic.test.ts
      // (RC-AM7-a). `frameChoice("edit")` drops the clip on her way through this ask, so the ask
      // is the only thing standing between her and the server's `refusedOnEdit` block. Silence it
      // and a false question becomes a blocking gap that costs the whole preview.
      //
      // What was actually wrong is the sentence: it says "photos" about a clip. ⚠️ ALL THREE ARE
      // PLACEHOLDER WORDING, for the copy-review pile (Mia) — the branch is the deliverable here,
      // not the prose.
      if (opts.companions === "video")
        return "You marked a photo to edit and added a video of you. An edit only ever changes the marked photo, so the video wouldn't be used. Edit that photo, or make a new image from everything you added?";
      if (opts.companions === "mixed")
        return "You marked one photo to edit and added other media of you. An edit only ever changes the marked photo, so the rest wouldn't be used. Edit that one, or make a new image from all of them?";
      return "You marked one photo to edit and added other photos of you. An edit only ever changes the marked photo, so the others wouldn't be used. Edit that one, or make a new image from all of them?";
    // Also Create anything's own (auto-mark, D4): two or more photos of her, none marked, and words asking for an
    // edit. Nothing is marked yet, so it cannot say "the marked one"; the card under it waits for her tap.
    // ⚠️ PLACEHOLDER WORDING, for the copy-review pile (Mia).
    case "frame_pick":
      return "You added more than one photo of you, so we don't know which to edit. Tap the one that should change — or make a new image from all of them.";
    case "fast_path_declined":
      return "We couldn't tell what to change here. Name the thing and what it should become — \"the socks blue\", \"the logo off my sleeve\".";
    case "generate_not_permitted":
      return "This reads as an edit to your photo rather than a new image. If you want something made from scratch, say so — \"make a new poster\".";
    case "no_steps":
      return "We couldn't find anything to change in that. Name the thing you want different.";
    default:
      return "We couldn't tell what to change here. Name the thing and what it should become.";
  }
}

// ─── What a tray tile is CALLED ─────────────────────────────────────────────────────────────────

/**
 * HER WORD FOR A ROLE. The same strings AttachSheet's tiles carry, in one place, because a role now
 * has to be renderable from two screens and a picker.
 *
 * `inspiration` is retired from the picker (see PickableRole) but still a member of ReferenceRole,
 * so it gets a label rather than an `Exclude` — an unlabelled member would be exactly the hole this
 * whole function exists to close.
 */
export const ROLE_LABELS: Record<ReferenceRole, string> = {
  "source-frame": "Your media",
  product: "Product",
  object: "Object",
  inspiration: "Inspiration",
  style: "Style",
};

/**
 * The VISION vocabulary, made human.
 *
 * `shot_type` is model output (server/lib/visionTag.ts): portrait | action | lifestyle | group |
 * text_graphic | other. Those are our internal words — `text_graphic` in particular is not a phrase
 * anybody says — so they are translated rather than title-cased, and an unrecognised value falls
 * through to the role for the same reason a missing one does.
 */
const SHOT_TYPE_LABELS: Record<string, string> = {
  portrait: "Portrait",
  action: "Action",
  lifestyle: "Lifestyle",
  group: "Group",
  text_graphic: "Graphic",
  other: "Photo",
};

/**
 * What to call an attachment in the tray.
 *
 * ─── THE BUG THIS REPLACES: `name: m.shot_type ?? role` ────────────────────────────────────────
 *
 * Two screens wrote that, and the fallback leaked a raw engine enum into the UI: an asset picked
 * before the enrichment cron reached it has `shot_type: null` and the tray showed `source-frame`.
 *
 * OBSERVED, not inferred — the caveat on this fix was that tray state at test time was not
 * observable. Measured 2026-09-09 on a genuinely fresh row: an asset one minute old read
 * `metadata.vision = null`, so `/media` returned `shot_type: null` (server/routes/media.ts) and the
 * expression above evaluated to `source-frame`. A generated asset from 80 minutes earlier had been
 * tagged ~90 seconds after ingest and read `action`. So the window is real, short, and every pick
 * inside it showed her an enum. "Untagged at pick time" is the mechanism.
 *
 * ⚠️ BOTH HALVES WERE LEAKING, WHICH IS WHY THIS TRANSLATES RATHER THAN DEFAULTS. Fixing only the
 * `?? role` branch would leave `text_graphic` rendering verbatim the moment the cron DID catch up —
 * the same defect one branch over, in a fix that looks complete. The function has no arm that can
 * return an internal token: every path ends in a hand-written phrase.
 *
 * Total at runtime, not just in the type. `role` reaches these screens through route params, so the
 * final fallback is what makes "no enum in the UI, in every state" a property of the code rather
 * than of the type-checker's view of it.
 */
export function trayLabelFor(
  shotType: string | null | undefined,
  role: ReferenceRole,
): string {
  const tagged = shotType?.trim().toLowerCase();
  if (tagged && SHOT_TYPE_LABELS[tagged]) return SHOT_TYPE_LABELS[tagged];
  return ROLE_LABELS[role] ?? "Attachment";
}

/**
 * What a plan RUNS as (PR 19, K-IO12): the routed intent — except that a preview the server turned into a new image
 * (`newImage`: the interpreter's exit, interpret/5) runs as a generate
 * whatever was routed. The thread says "This makes a new image" off this, on a photo she marked.
 */
export function plannedIntent(
  routed: StudioIntent,
  preview: { newImage?: boolean } | null | undefined,
): StudioIntent {
  return preview?.newImage ? "image.generate" : routed;
}
