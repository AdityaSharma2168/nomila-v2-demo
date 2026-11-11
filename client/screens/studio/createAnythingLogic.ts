/**
 * createAnythingLogic — what a prompt still needs before anything can be made.
 *
 * ─── WHY THERE IS A GATE AT ALL ────────────────────────────────────────────────────────────────
 * Two asks cannot be answered from a description, and generating anyway produces the two failures
 * that matter most:
 *
 *   A NAMED PRODUCT. "Put these sneakers on me" needs the actual piece. Rendering a plausible
 *   lookalike invents the product, and a wrong product is the thing a brand rejects fastest.
 *
 *   HER, IN IT. "A photo of me on a rooftop" needs a photo of her to work from, or the result is
 *   somebody else with her name on it.
 *
 * Everything else generates without a question. The gate is deliberately narrow: it fires on what
 * the request cannot be completed without, never on what would merely be nicer with more input.
 *
 * ─── A PROMPT CAN BE SHORT OF MORE THAN ONE THING ──────────────────────────────────────────────
 * "Put these sneakers on me" needs BOTH. The gate answers with the next thing missing rather than
 * a list, and is re-asked after every attachment, so satisfying one reveals the next instead of
 * going quiet and looking finished.
 *
 * ─── EDITING NEEDED NOTHING HERE, WHICH IS WORTH WRITING DOWN ──────────────────────────────────
 *
 * Create anything now routes an edit ("remove the ball" + her photo) as well as a generate, and the
 * obvious thought is that this gate should stop asking for a photograph when the request is an edit.
 * It should not, because it already does not: an edit BY DEFINITION has a photograph attached, so
 * `hasHer` is true and the question is never asked. And "take my jersey off" with nothing attached
 * SHOULD be asked, because an edit with no photo has nothing to edit.
 *
 * A short-circuit for edits was written here and removed: every branch it could reach was already
 * decided by `hasHer`, so it was dead on both sides. The fork lives in `engineIntentFor`
 * (lib/studio-contract) where the two readings of a source-frame are actually distinguished.
 */
import type {
  GenerationPreview,
  PreviewRequest,
  StudioClassification,
} from "../../hooks/use-studio";
import {
  editShaped,
  frameCandidates,
  markedFrame,
  objectPhotosIn,
  stylePhotosIn,
  previewRequestFor,
  isMotion,
  toEngineReferences,
  type FrameCompanions,
  type Attachment,
  type PreviewSeed,
} from "../../lib/studio-contract";

/**
 * A specific thing, named with a determiner. "these sneakers", "the necklace" — as opposed to
 * "sneakers", which is a category and can be invented freely.
 *
 * The 40-character window between the determiner and the noun is bounded, and stops at sentence
 * punctuation, so "this is great. buy sneakers" does not read as one phrase.
 */
const NAMES_A_PRODUCT =
  /\b(this|these|those|the)\b[^.?!]{0,40}\b(sneakers?|shoes?|trainers?|boots?|bag|handbag|purse|jacket|hoodie|watch|bottle|can|drink|serum|skincare|moisturiser|moisturizer|lipstick|necklace|bracelet|earrings?|ring|product|kit|shirt|jersey)\b/i;

/** The bare phrase, which the pattern above would miss for want of a noun to anchor on. */
const NAMES_THE_PRODUCT = /\b(this|the) product\b/i;

/** Asks to put something onto her, or to place her in a scene. */
const NEEDS_HER = /\b(of me|of myself|on me|me wearing|wearing it|my outfit|onto me|into a photo of me|my face|my hands?)\b/i;

/** What the chat is waiting for. Null means nothing is blocking. */
export type Missing = "product" | "photo" | null;

export interface GateState {
  attachments: Attachment[];
  /** She was offered a specific product, declined, and said carry on with a generic one. */
  carriedOn: boolean;
}

/**
 * The next thing this prompt is short of.
 *
 * Order matters: product is asked first because it is the answer that is hardest to get (she may
 * have to go and photograph it), and because a prompt that needs both reads more naturally asking
 * for the object before the person.
 */
export function whatIsMissing(prompt: string, state: GateState): Missing {
  const text = prompt || "";
  const wantsProduct = NAMES_A_PRODUCT.test(text) || NAMES_THE_PRODUCT.test(text);
  const wantsHer = NEEDS_HER.test(text);

  // Carrying on is a real answer to the product question, not a deferral of it. And a photo in the
  // Object tile IS a picture of the specific thing: "change my earrings to these gold hoops" with her
  // hoops attached has shown it. Asking again — and then answering "carry on" with "then it will be a
  // generic one" — would tell her something false about a photo she gave us (replace with reference).
  const hasProduct =
    state.attachments.some(
      (a) => a.role === "product" || a.role === "object",
    ) || state.carriedOn;
  const hasHer = state.attachments.some((a) => a.role === "source-frame");

  if (wantsProduct && !hasProduct) return "product";
  if (wantsHer && !hasHer) return "photo";
  return null;
}

/**
 * Whether the send button does anything.
 *
 * Attachments alone are never enough. The tray says what to work WITH; it never says what to do,
 * so a tray full of photographs and an empty box is not a request.
 */
export function canSend(draft: string): boolean {
  return draft.trim().length > 0;
}

/**
 * What to do once something has been attached.
 *
 * Never "generate". Nothing runs without a press, so a satisfied gate offers one rather than
 * quietly firing — and an unsatisfied one names what is still missing rather than going silent and
 * looking finished.
 */
export type AfterAttach =
  | { next: "ready" }
  | { next: "ask"; missing: Exclude<Missing, null> }
  | { next: "nothing" };

export function afterAttach(gatedPrompt: string | null, state: GateState): AfterAttach {
  // Nothing was blocked, so there is nothing to resume — she is just adding material for later.
  if (!gatedPrompt) return { next: "nothing" };
  const missing = whatIsMissing(gatedPrompt, state);
  return missing ? { next: "ask", missing } : { next: "ready" };
}

/**
 * What a send hands over, and what the tray is left holding.
 *
 * ─── EACH SEND IS ITS OWN JOB ──────────────────────────────────────────────────────────────────
 * This screen is a thread, and a thread accumulates by nature — but a GENERATION does not. Every
 * send is a separate job with its own prompt, and it used to inherit every photograph attached
 * during the whole conversation, because the tray was never emptied on the way out. Come back from
 * Make it, type something unrelated, send: the previous piece's references went with it. That is
 * how one job's material ends up conditioning another's.
 *
 * It is a function rather than two lines in the screen so the rule is testable and so the copy is
 * real: `sent` is a snapshot taken at hand-off, which is what makes clearing the tray immediately
 * afterwards safe. A caller that passed the live array and then emptied it would be relying on the
 * navigator having already read it.
 */
export function handOff<T extends Attachment>(attachments: T[]): { sent: T[]; tray: T[] } {
  return { sent: [...attachments], tray: [] };
}

/**
 * A TAP ON A CHIP IN THE TRAY — where her mark goes (frame defaulting, 2026-09-16).
 *
 * The EDITING badge is hers to put on and hers to take off. A photo of hers that she taps becomes the frame;
 * tapping the one already marked clears it, and the tray then holds references only — the state the old tray
 * could not reach, because the mark was defaulted onto her first photo and × only moved it on.
 *
 * Only a photograph of hers with a row can be the frame (`frameCandidates`), so a tap on a product, an object or
 * a photo still uploading changes nothing — nor does a tap on a chip no longer in the tray.
 */
export function toggleFrame(
  tray: Attachment[],
  current: string | null,
  tapped: string | null,
): string | null {
  if (!tapped || !frameCandidates(tray).some((a) => a.assetId === tapped))
    return current;
  return tapped === current ? null : tapped;
}

// ─── A marked frame beside other photos of her: ask, when she sends (frame defaulting, F.4) ────────────────

/**
 * THE ASK CODE. Client-minted, not the classifier's: it is stored as the `reason` of an ask entry in her thread
 * (server/studio/sessions.ts accepts any `^[a-z_]{1,40}$`), and history renders it through `askCopyFor`.
 */
export const FRAME_ASK = "frame_with_likeness";

/**
 * THE PICK ASK'S CODE (auto-mark, 2026-09-16; Adi's D4): two or more photos of her, none marked, and words that ask
 * for an edit. Which one is never picked silently — Mila asks her to tap the one to edit, or make a new image from
 * all of them. Client-minted and stored like FRAME_ASK; its own sentence, because nothing is marked yet.
 */
export const FRAME_PICK = "frame_pick";

/** Her answer: edit the marked photo alone, or make a new image from every photo of her. */
export type FrameChoice = "edit" | "new";

/**
 * DOES THIS SEND HAVE TO ASK FIRST — a photo she marked to edit, AND another photo of her beside it.
 *
 * An edit cannot also be built from photos of her: the server refuses the pair outright (`refusedOnEdit`,
 * server/studio/preview.ts), and only after the preview has run the interpreter and detection on it. So the
 * tray that holds both is asked about before anything is checked — edit the marked one, or a new image from
 * all of them (Adi's D1, option B). It replaces the "which one am I working on?" card that used to fire the
 * moment a second photo was attached, whose "keep the first — use this as a reference" answer always ended in
 * that refusal.
 *
 * A product or an object beside the frame is not a photo of her and asks nothing; neither does a tray with no
 * mark (a new image from all of them already) or a mark alone.
 */
export function frameChoiceNeeded(
  tray: Attachment[],
  frameAssetId: string | null,
): boolean {
  const frame = markedFrame(tray, frameAssetId);
  if (!frame) return false;
  return tray.some(
    (a) => a.role === "source-frame" && a.assetId !== frame.assetId,
  );
}

/**
 * WHAT IS BESIDE THE MARKED PHOTO — so the ask can say something true about it (F-AM7).
 *
 * `frameChoiceNeeded` answers WHETHER to ask; this answers what the sentence should call the things
 * it is asking about. They are separate on purpose: the ask fires for a clip exactly as it does for
 * a photo, and only the wording differs. Giving the first function a motion filter instead — which
 * is the fix the ledger entry seems to ask for — would silence the ask and hand her the server's
 * `refusedOnEdit` block instead. RC-AM7-a pins that.
 *
 * Meaningless when nothing is being asked; returns `null` there.
 */
export function frameCompanions(
  tray: Attachment[],
  frameAssetId: string | null,
  mediaTypes: Readonly<Record<string, string>> = {},
): FrameCompanions | null {
  const frame = markedFrame(tray, frameAssetId);
  if (!frame) return null;
  const others = tray.filter(
    (a) => a.role === "source-frame" && a.assetId !== frame.assetId,
  );
  if (!others.length) return null;
  const clips = others.filter((a) => isMotion(a, mediaTypes)).length;
  if (clips === 0) return "photos";
  return clips === others.length ? "video" : "mixed";
}

/**
 * WHAT HER ANSWER SENDS.
 *
 *   edit  the marked photo, and every product and object; the OTHER photos of her come out of this send. Her
 *         tap is what removes them — the refusal's rule that nothing she tagged is dropped silently holds.
 *   new   the whole tray, and no frame: every photo of her, the marked one included, is her likeness.
 *
 * With no mark there is nothing to edit, so either answer sends the tray as it is, with no frame.
 */
export function frameChoice<T extends Attachment>(
  tray: T[],
  frameAssetId: string | null,
  choice: FrameChoice,
): { tray: T[]; frameAssetId: string | null } {
  const frame = markedFrame(tray, frameAssetId);
  if (choice === "new" || !frame) return { tray, frameAssetId: null };
  return {
    tray: tray.filter(
      (a) => a.role !== "source-frame" || a.assetId === frame.assetId,
    ),
    frameAssetId: frame.assetId,
  };
}

// ─── Auto-mark: one photo of her and an edit-shaped sentence make that photo the frame (auto-mark, 2026-09-16) ────

/**
 * WHAT FRAME DEFAULTING COST, AND WHAT THIS GIVES BACK.
 *
 * Frame defaulting made a photo of hers the frame only when she marked it, which was right for her pack and a
 * regression for the flow most sends are: ONE photo and "make the socks blue", which now planned a new image unless
 * she tapped the photo first. So when the sentence is edit-shaped (`editShaped`) and exactly one photo of hers could
 * be the frame, the composer marks it for her — the badge appears, and the job goes out as if she had tapped.
 *
 * Her tap still decides. A tap on the badge takes it off (and keeps it off — `autoOff`), a tap on another photo marks
 * that one, and a photo she marked is never second-guessed. Nothing downstream knows the difference: the job carries
 * an ordinary `frameAssetId`, so the plan, the thread's record, Check again and "Not what I meant" replay it exactly
 * as frame defaulting pinned.
 */

/** Her mark, and whether she has said "not this one" since the tray last had a new photo of hers in it. */
export interface Mark {
  frameAssetId: string | null;
  /**
   * Auto-mark is OFF: she took a badge off (hers or one auto-mark put there), or "Not what I meant" gave her back a
   * tray she had sent with no frame. On until the tray empties at send or another photo of hers is attached (D3).
   */
  autoOff: boolean;
}

/**
 * The photographs of hers that could be the frame being edited — PLAUSIBLE canvases. Her media, still uploading or
 * not: a photo of her in flight is a photo of her all the same, and counts against "exactly one". A known video or
 * reel is not one — an edit is stills-only. A product or an object never is.
 */
export function canvasesIn<T extends Attachment>(
  tray: T[],
  mediaTypes: Readonly<Record<string, string>> = {},
): T[] {
  return tray.filter((a) => a.role === "source-frame" && !isMotion(a, mediaTypes));
}

/** The asks that are an add she did not place: the thing would come from a photo, if one could be bound to it. */
const ADD_ASKS: ReadonlySet<string> = new Set(["add_unclear", "worn_add_unclear"]);

/**
 * AN ADD THE SERVER CANNOT BIND A PHOTO OF HERS TO, BESIDE HER PRODUCTS — never auto-marked (Adi's D5 (b), as C3 left it).
 *
 * An edit's add takes its thing from her Object photo, or — with none attached, since C3 — from her ONE Product photo
 * (server/studio/nativeIntent.ts), and says so before she pays. So "add a water bottle" beside one product is an edit
 * now, auto-marked like the same tray with the bottle in the Object tile: post-C3, auto-mark marks whenever the server
 * can bind (Adi, 2026-09-17).
 *
 * TWO OR MORE products and no Object photo is what is left of D5 (b): the server asks which one is the thing, so an
 * auto-mark there would hand her a question she never asked for. It stays what frame defaulting made it — a new image
 * from her photo and her products (Adi's decision 4). Her own mark still gets the server's ask.
 */
export function productAddUnbound(
  classification: StudioClassification | undefined,
  tray: Attachment[],
): boolean {
  if (!classification) return false;
  const adds =
    classification.steps.some((s) => s.op === "ADD_OBJECT") ||
    (classification.initialPath === "ASK" &&
      !!classification.reason &&
      ADD_ASKS.has(classification.reason));
  if (!adds) return false;
  return productsWithoutObject(tray) > 1;
}

/** Would auto-mark take a photo of hers as the frame for these words, beside this tray? */
export function autoMarkShape(
  routing: boolean,
  classification: StudioClassification | undefined,
  text: string,
  tray: Attachment[],
  /** STUDIO_IMAGE_OPS (PR 19): its two asks are edit-shaped too. Absent is off. */
  imageOps = false,
): boolean {
  return (
    editShaped(routing, classification, text, imageOps) &&
    !productAddUnbound(classification, tray)
  );
}

/**
 * THE PHOTO AUTO-MARK PUTS THE BADGE ON, or null.
 *
 * Only when she has not marked one (hers always wins), has not switched it off, the words are edit-shaped
 * (`autoMarkShape`), and exactly ONE plausible canvas is in the tray — with a row, so it can be a base. Two or more
 * is never a silent pick: that asks at send (`frame_pick`).
 */
export function autoFrame(
  tray: Attachment[],
  mark: Mark,
  shape: boolean,
  mediaTypes: Readonly<Record<string, string>> = {},
): string | null {
  if (markedFrame(tray, mark.frameAssetId) || mark.autoOff || !shape) return null;
  const canvases = canvasesIn(tray, mediaTypes);
  return canvases.length === 1 && canvases[0].assetId ? canvases[0].assetId : null;
}

/** The photo the badge is on: hers if she marked one, auto-mark's otherwise. */
export function badgedFrame(
  tray: Attachment[],
  mark: Mark,
  auto: string | null,
): string | null {
  return markedFrame(tray, mark.frameAssetId)?.assetId ?? auto;
}

/**
 * A TAP ON A PHOTO OF HERS, with auto-mark in the tray — `toggleFrame`, over the badge she can SEE.
 *
 *   the badged photo    the badge comes off, whoever put it there, and auto-mark stays off (D3)
 *   another of hers     that one is marked, by her
 *   anything else       nothing moves
 */
export function tapBadge(
  tray: Attachment[],
  mark: Mark,
  auto: string | null,
  tapped: string | null,
): Mark {
  if (!tapped || !frameCandidates(tray).some((a) => a.assetId === tapped)) return mark;
  if (tapped === badgedFrame(tray, mark, auto)) return { frameAssetId: null, autoOff: true };
  return { ...mark, frameAssetId: tapped };
}

/** After something is attached: a new photo of hers is a new question, so auto-mark is back on (D3). */
export function autoOffAfterAttach(
  role: Attachment["role"],
  autoOff: boolean,
): boolean {
  return role === "source-frame" ? false : autoOff;
}

/**
 * AFTER "NOT WHAT I MEANT" — is auto-mark off for the tray it gives back (auto-mark, D3)?
 *
 * `composerAfterReject` (threadLogic) puts back the tray she sent, with the frame EXACTLY as it went — and a tray sent
 * with NO frame must not be re-read by auto-mark on her next send: that plan was a new image from her photo, the
 * thread's record says so, and frame defaulting pinned that its replay stays one. So a tray given back with no frame
 * comes back with auto-mark off; one given back with a frame carries that frame as her mark. When the composer
 * already held a tray of hers, nothing was given back, and nothing about auto-mark changes.
 */
export function autoOffAfterReject(
  now: { tray: readonly unknown[]; autoOff: boolean },
  refused: { frameAssetId: string | null },
): boolean {
  if (now.tray.length > 0) return now.autoOff;
  return refused.frameAssetId === null;
}

// ─── The catch-all through the interpreter: read at send, on the one photo of hers (C2, 2026-09-16) ────────────────

/**
 * WHAT AUTO-MARK COULD NOT READ, AND WHO READS IT NOW.
 *
 * Auto-mark marks a photo when the RULES read an edit in her words. Two kinds of sentence still dead-ended with one
 * photo of hers attached:
 *
 *   the catch-all      `fast_path_declined` — "take the logo off my sleeve", "make me hold the gatorade bottle from
 *                      image 2". Never auto-marked (D1: the same code holds "generate pic of me playing soccer"), so
 *                      they planned a new image, or asked once she marked the photo.
 *   an auto-marked ask an S2 ask the interpreter takes — "put the gatorade bottle in my hand" (`add_unclear`). Marked,
 *                      so the sheet ran the interpreter, and when it could not read the words she got its ask.
 *
 * Both are now read by the interpreter AT SEND, once, when the server says it may (`interpretable`) — the same
 * preview request the marked flow makes, built by the same builder (`previewRequestFor`). A ready proposal marks the
 * photo and the sheet shows that preview; every other answer plans a new image. Never an ask (Adi, 2026-09-16: D1).
 */
const CATCH_ALL = "fast_path_declined";

/** How long the send waits for the reading before it plans a new image instead (Adi's D3: above the server's 15s). */
export const READ_TIMEOUT_MS = 20_000;

/**
 * HOW MANY PRODUCT PHOTOS TRAVEL WITH NO OBJECT PHOTO — 0 when an Object photo travels (it is an add's thing, whatever
 * else rides). One is an add's thing since C3; two or more, and the server asks which (D5). The survivors that are
 * sent, never the raw tray.
 */
function productsWithoutObject(tray: Attachment[]): number {
  const sent = toEngineReferences(tray).references;
  if (sent.some((r) => r.role === "object")) return 0;
  return sent.filter((r) => r.role === "product").length;
}

/**
 * DOES THE INTERPRETER READ HER WORDS AT SEND — and if so, the photo it reads them against, or null.
 *
 * Only with both flags on, when the send's re-ask (`answer`, told there IS a photo) asked with `interpretable` —
 * the server's own answer, never inferred here — and the code is the catch-all or one auto-mark would mark on
 * (`autoMarkShape`, so an add beside two or more products and no object photo stays D5's new image). And only over exactly the
 * photo auto-mark would take (`autoFrame`: nothing she marked, auto-mark not switched off, ONE plausible canvas with
 * a row), where the send would go straight to its check — never beside another photo of hers, where F.4 asks first
 * and a reading would be thrown away.
 */
export function interpreterReads(args: {
  interpreter: boolean;
  routing: boolean;
  answer: StudioClassification | undefined;
  text: string;
  tray: Attachment[];
  mark: Mark;
  mediaTypes?: Readonly<Record<string, string>>;
  /** STUDIO_IMAGE_OPS (PR 19). */
  imageOps?: boolean;
}): string | null {
  const { answer } = args;
  if (!args.interpreter || !args.routing || !answer) return null;
  if (answer.initialPath !== "ASK" || answer.interpretable !== true) {
    return null;
  }
  if (
    answer.reason !== CATCH_ALL &&
    !autoMarkShape(
      args.routing,
      answer,
      args.text,
      args.tray,
      args.imageOps === true,
    )
  ) {
    return null;
  }
  const photo = autoFrame(args.tray, args.mark, true, args.mediaTypes);
  if (!photo || frameChoiceNeeded(args.tray, photo)) return null;
  return photo;
}

/**
 * WHAT THE READING SAID, for what the send does with it.
 *
 *   proposal     "Here's what we'll do" (`interpretation`), ready and priced, spendable — mark the photo, pass it on
 *   add_unbound  a proposal that ADDS a thing the server froze no photo of hers for, while a product photo travels (D2):
 *                the add would invent its thing beside her product — a new image. Read off the frozen adds, never the
 *                tray, since C3 made the binding the server's: one product with no Object photo IS the thing
 *   new_image    the interpreter read a new picture of her (interpret/5) — her photo stays her likeness
 *   no_proposal  it declined, could not fill the menu, timed out or tripped a guard on the server: the preview asked
 *   not_ready    it proposed and the preview blocked anyway (the freeze refused it, a blocker, unpriced)
 *   failed       no answer: the call threw (a 400 from detection, a 404, a 500, the network) or the send gave up (D3)
 *
 * Everything but `proposal` is a new image. The frozen steps are read off the brief the preview returns verbatim.
 */
export type Reading =
  | "proposal"
  | "add_unbound"
  | "new_image"
  | "no_proposal"
  | "not_ready"
  | "failed";

export function readingOf(
  preview: GenerationPreview | null,
  tray: Attachment[],
): Reading {
  if (!preview) return "failed";
  if (preview.newImage) return "new_image";
  if (!preview.interpretation) return "no_proposal";
  // The Make it screen's own test for a live button (use-studio-pending, `canGenerate`).
  const spendable =
    preview.status === "ready" &&
    preview.verdict.canGenerate === true &&
    Boolean(preview.previewId) &&
    !(preview.unpriced ?? preview.cost?.unpriced);
  if (!spendable) return "not_ready";
  const intent = preview.brief?.job.editIntent;
  const adds = (intent?.steps ?? []).some((s) => s.op === "ADD_OBJECT");
  // What the SERVER bound (C3): an add that froze a photo of hers as its thing. A brief without changes binds nothing.
  const placed = (intent?.changes ?? []).some((c) => !!c.add?.objectAssetId);
  const productTravels = toEngineReferences(tray).references.some(
    (r) => r.role === "product",
  );
  if (adds && !placed && productTravels) return "add_unbound";
  return "proposal";
}

/** The tray as a comparable value: which chips, in which roles, pointing at which rows. */
function trayKey(tray: Attachment[]): string {
  return JSON.stringify(tray.map((a) => [a.id, a.role, a.assetId]));
}

/** What a send goes out with, once auto-mark has had its say — or the question it asks first (`frame_pick`). */
export type SendResolution<T extends Attachment> =
  | {
      kind: "send";
      tray: T[];
      frameAssetId: string | null;
      /** The interpreter's reading at send, for the sheet to show rather than ask again (C2). Never persisted. */
      seed?: PreviewSeed;
    }
  | { kind: "ask"; code: typeof FRAME_PICK; tray: T[] };

/**
 * WHAT A SEND FROM THE COMPOSER CARRIES — her mark, auto-mark's, or none (auto-mark).
 *
 * ─── IT RE-ASKS, ON THE EXACT SENTENCE SENT ───────────────────────────────────────────────────────────────────────
 *
 * The badge she saw was read off a DRAFT answer — for words she may have changed since, or still in flight. What is
 * sent is decided on the words sent, so this asks again (`ask`, a one-shot classify, `purpose: "shape"`) whenever
 * auto-mark could apply, and never reads the draft answer at all.
 *
 * ─── AND IT READS HER TRAY AFTER THE ANSWER, NOT BEFORE ───────────────────────────────────────────────────────────
 *
 * `current` is read before the question and again after it. A tap while it was in flight wins: a badge she took off
 * stays off, a photo she marked is the frame. If the Object photos changed underneath it, the answer was for a
 * different tray ("these gold hoops" reads differently with one), so it is not used and nothing is auto-marked.
 *
 * With no answer — the classifier failed — nothing is auto-marked: frame defaulting's behaviour.
 *
 * ─── AND WHAT THE RULES COULD NOT READ, THE INTERPRETER READS — ONCE, HERE (C2) ───────────────────────────────────
 *
 * When `interpreterReads` says so, the send checks her words against that photo (`preview`, the request the sheet
 * would build) BEFORE handing over, and tells the composer it is working (`onReading`). A ready proposal is sent
 * with the photo marked and the preview as its `seed`; every other answer, a throw, or no answer inside
 * `previewTimeoutMs` sends no frame — a new image. Her tray is read AGAIN after it: a tap or an untap while it was
 * out wins as above, and a tray that changed at all throws the reading away (a new image). Omit `interpreter` or
 * `preview` and nothing is read: auto-mark's behaviour, exactly.
 */
export async function resolveSend<T extends Attachment>(args: {
  text: string;
  routing: boolean;
  current: () => {
    tray: T[];
    mark: Mark;
    mediaTypes: Readonly<Record<string, string>>;
  };
  ask: (
    text: string,
    objectPhotos: number,
    stylePhotos?: number,
  ) => Promise<StudioClassification>;
  /** STUDIO_INTERPRETER. */
  interpreter?: boolean;
  /** STUDIO_IMAGE_OPS (PR 19): its asks keep her frame, a server GENERATE wins, the Style tile is counted. */
  imageOps?: boolean;
  /** The preview check, once, with a signal that gives up when the send does. */
  preview?: (
    request: PreviewRequest,
    signal: AbortSignal,
  ) => Promise<GenerationPreview>;
  previewTimeoutMs?: number;
  /** True as the reading goes out, false once it is back or given up on — the composer's working state (D4). */
  onReading?: (reading: boolean) => void;
}): Promise<SendResolution<T>> {
  const settled = (): SendResolution<T> | null => {
    const { tray, mark, mediaTypes } = args.current();
    const hers = markedFrame(tray, mark.frameAssetId);
    if (hers) return { kind: "send", tray, frameAssetId: hers.assetId };
    if (mark.autoOff || canvasesIn(tray, mediaTypes).length === 0) {
      return { kind: "send", tray, frameAssetId: null };
    }
    return null;
  };

  const before = settled();
  if (before) return before;

  const objects = objectPhotosIn(args.current().tray);
  // PR 19 (B): her Style tile, counted only with the flag on — off, the re-ask is the call it always was.
  const styles = args.imageOps ? stylePhotosIn(args.current().tray) : 0;
  let answer: StudioClassification | undefined;
  if (args.routing) {
    try {
      answer = styles
        ? await args.ask(args.text, objects, styles)
        : await args.ask(args.text, objects);
    } catch {
      answer = undefined;
    }
  }

  const after = settled();
  if (after) return after;
  const { tray, mark, mediaTypes } = args.current();
  const sameTray = objectPhotosIn(tray) === objects;
  const shape =
    sameTray &&
    autoMarkShape(args.routing, answer, args.text, tray, args.imageOps === true);
  // Two or more photos of her and words that ask for an edit: which one is hers to say (D4), never guessed.
  if (shape && canvasesIn(tray, mediaTypes).length >= 2) {
    return { kind: "ask", code: FRAME_PICK, tray };
  }
  const photo = sameTray
    ? interpreterReads({
        interpreter: args.interpreter === true,
        routing: args.routing,
        answer,
        text: args.text,
        tray,
        mark,
        mediaTypes,
        imageOps: args.imageOps === true,
      })
    : null;
  // Create anything's jobs are photos (`hand`), so the reading is the request a photo job's sheet builds.
  const job = photo
    ? previewRequestFor({
        format: "photo",
        classification: answer,
        direction: args.text,
        attachments: tray,
        frameAssetId: photo,
        interpreter: true,
        imageOps: args.imageOps === true,
        // F-AM7: a clip tagged "You" must not travel as a person ref on an edit.
        mediaTypes,
      })
    : null;
  if (!photo || !job?.routed.interpreting || !args.preview) {
    return {
      kind: "send",
      tray,
      frameAssetId: autoFrame(tray, mark, shape, mediaTypes),
    };
  }

  const sentWith = trayKey(tray);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let preview: GenerationPreview | null = null;
  args.onReading?.(true);
  try {
    preview = await Promise.race([
      args.preview(job.request, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("the reading took too long"));
        }, args.previewTimeoutMs ?? READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    preview = null;
  } finally {
    clearTimeout(timer);
    args.onReading?.(false);
  }

  // Her tray, again: a tap or an untap while the reading was out is hers, and wins.
  const late = settled();
  if (late) return late;
  const now = args.current();
  if (trayKey(now.tray) !== sentWith) {
    return { kind: "send", tray: now.tray, frameAssetId: null };
  }
  const reading = readingOf(preview, now.tray);
  if (reading !== "proposal") {
    // PR 19 (W-4; ADI-R19-W): an ask about HER photo stays on her photo. A reading that declined, failed, timed out or
    // was blocked means "show her the ask on this photo", never a new picture of her — only the interpreter's own
    // new-image reading (and D2's unbound add) makes one. Off, today's answer: every non-proposal is a new image.
    // ⚠️ MUTATION M-keepFrame: restore the fallthrough (null for every non-proposal) — "an edit-shaped ask whose
    // reading declined keeps her photo" reds by name.
    const keeps =
      args.imageOps === true &&
      shape &&
      reading !== "new_image" &&
      reading !== "add_unbound";
    return { kind: "send", tray: now.tray, frameAssetId: keeps ? photo : null };
  }
  return {
    kind: "send",
    tray: now.tray,
    frameAssetId: photo,
    seed: { request: job.request, preview: preview! },
  };
}
