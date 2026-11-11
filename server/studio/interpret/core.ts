/**
 * studio/interpret/core — the interpreter, PURE: a model's reply in, a proposal or an ask out (the
 * interpreter, I.2; plan v1 §1–§2, v2 §3–§4).
 *
 * No network, no rows, no clock. The model call is studio/interpret/transport.ts; this is everything that
 * decides whether its reply may become a proposal, and every decision is deterministic:
 *
 *   1. SCHEMA          exactly the reply's shape (reply.ts) — else `unparseable`
 *   2. NEW IMAGE       she asked for a new picture of her, not an edit of this photograph — `new_image`, a
 *                      terminal answer, never a refusal. Offered only on a call that is not an ad (an ad is an
 *                      edit of this photograph by definition, M1); said beside an ad anyway — `invalid_slot`
 *   2½. DECLINE        the model may decline — `declined`
 *   3. COVERAGE        every quote is her words, in order, and together they cover every word of her
 *                      sentence; filler is filler; nothing is unreadable; every edit of hers has a quote;
 *                      a treatment only where the ad gate found one — else `uncovered`
 *   4. TRIPWIRE        no negation inside an edit or a treatment — else `negation`
 *   5. SLOTS           each slot on the menu and inside the rules' bounds (menu.ts); a look only from her
 *                      words, with its term in her quote (M6) and her quote wholly a look (the style
 *                      vocabulary); a headline only with STUDIO_DISPLAY_TEXT on; one change per thing —
 *                      else `invalid_slot`. ONE exception: a suggestion the rules refuse on its own words (a
 *                      brand's slogan, a headline or a setting out of bounds) is DROPPED alone, and the rest
 *                      of the reply is read without it (ledger F-I5) — nothing left, and it asks as before
 *   6. EXCLUSION       an exclusion only once R2 has cleared it (M4's engineering gate) — else
 *                      `exclusion_uncleared`
 *   7. THE CAP         her changes, then the brand's required swaps, then a headline, then a background —
 *                      suggestions drop lowest first to fit four; hers and the brand's alone over four ask
 *                      — `too_many_changes`
 *   8. ROUND TRIP      C routes back as exactly these edits (canonical.ts) — `round_trip_mismatch`, or C's
 *                      own guard code (`guarded`)
 *   9. FIRST CLAIM     every clause of hers the rules read survives with their steps — `first_claim`
 *
 * Every refusal is an ASK, and on all but a guard, a too-many and an ad's own codes she hears S's
 * original ask: the interpreter can only ever turn an ask into a proposal, or leave it as it was — or, since
 * interpret/5, answer that it was never an edit at all. A new image is not built from here: the preview
 * blocks on it with its own line, and nothing is frozen, detected or spent.
 */
import {
  DETERMINERS,
  MAX_STEPS,
  type Attached,
  type EditStep,
} from "../classify";
import { namesWornItem, wornGoesOn } from "../objectVocab";
import type {
  EditConstraint,
  FrozenEditIntent,
  NativeChange,
} from "../nativeEdit";
import type { ChangeTag, LineProvenance, LineSource } from "../compile";
import { readWhollyLook } from "../lookVocab";
import { firstClaimHolds, roundTrip } from "./canonical";
import {
  AD_WORDS,
  FILLER,
  SUGGESTIBLE,
  TRIPWIRE,
  editKey,
  editOk,
  wordsOf,
  type EditSource,
  type SourcedEdit,
} from "./menu";
import { parseReply, type Reply, type Span, type VisibleMark } from "./reply";

/** Which menu kinds are open: the headline behind STUDIO_DISPLAY_TEXT, the exclusion behind R2. */
export interface MenuSwitches {
  text: boolean;
  exclusion: boolean;
}

/**
 * The ad gate's answer, when her sentence asked for an ad (studio/interpret/ad.ts): the brand it is for,
 * and what a kit swap needs — the BRANDS word her kit is swapped TO (null when the ad's brand is not one
 * rule 4c can name), and the brands whose marks it swaps away (N1).
 */
export interface AdTreatment {
  brand: string;
  category: string | null;
  swapTo: string | null;
  competitors: readonly string[];
  /**
   * What the brand's own row says about its tone — SANITISED, and null when the brand has no row or
   * nothing survived (interpret/ad.ts, `adTreatment`). Read by the prompt's `<brand>` block only.
   *
   * ⚠️ NO PALETTE, and that is a finding rather than an omission: `BrandHalf.palette` is present on
   * ZERO brands in `inbox_brands` (server/studio/brief.ts:426), so a palette-driven suggestion is not
   * buildable today at any cost. When a source exists it belongs here.
   */
  profile: BrandProfile | null;
  /**
   * Her own register, ALREADY PRECEDENCE-RESOLVED, or null — the no-brand fork (card 3, A).
   *
   * ⚠️ THE PRECEDENCE IS NOT OPTIONAL AND HAS A MEASURED FAILURE BEHIND IT. When her words name a
   * sport and her profile names a different one, a prompt carrying both makes the model obey BOTH:
   * server/studio/brief.ts records job e4814552, live 2026-09-09 — profile Basketball, direction
   * "create an adidas soccer ad featuring me", and the output was a basketball court, a basketball in
   * her hands, a soccer ball at her feet and a caption reading "Wait, soccer? … #basketball #soccer".
   * Not a misread: an obedient reconciliation of two inputs we told it were both true.
   *
   * So the sport leaves the register whenever her sentence names one, exactly as `athleteHalf` does
   * it.
   */
  register: AthleteRegister | null;
}

/** The brand tone the prompt may state. Every string here has been through `sanitizeBrandField`. */
export interface BrandProfile {
  contentStyle: string | null;
  audience: string | null;
  recentCampaigns: string[];
}

/**
 * HER OWN REGISTER — what an ad falls back to when the brand has no row (wave C card 3, fork A).
 *
 * `sport` is `athletes.sport`; it may be null, and a register without one is null rather than an empty one.
 * The legacy `athletes_current.tier` "level" line is gone (legacy retirement P2-2, owner decision 6, 8 Oct 2026):
 * the retired tier word is no longer a generation input.
 */
export interface AthleteRegister {
  sport: string | null;
}

/** The same three fields as they arrive off `getBrandContext`, before sanitising. */
export interface BrandProfileInput {
  contentStyle?: string | null;
  audience?: string | null;
  recentCampaigns?: readonly string[];
}

export interface InterpretationInput {
  /** Her typed words, S. System origin only — an inbound ask is never interpreted. */
  sentence: string;
  /** How many Object photos she attached: a pointed swap needs one, an add uses one. */
  attached: Attached;
  /** The ad gate's answer, or null when she named no treatment. */
  treatment: AdTreatment | null;
  menu: MenuSwitches;
}

/**
 * The code a new image blocks with — on the preview's note (nativeIntent.ts, ASK_NOTES), on the record the thread
 * card reads, and in the client's copy (client/lib/studio-contract.ts, askCopyFor). Never one of `route()`'s codes.
 */
export const NEW_IMAGE_ASK = "new_image";

/**
 * Is the new-image answer offered on this call? Not beside an ad: an ad is an edit of this photograph by
 * definition (M1), and leaving it out keeps an ad's prompt interpret/4's byte for byte (prompt.ts).
 */
export function offersNewImage(input: InterpretationInput): boolean {
  return input.treatment === null;
}

/** A constraint and where it came from: her words, or (on an ad) always-on "keep me", suggested. */
export type SourcedConstraint = EditConstraint & { source: EditSource };

export type InterpretOutcome =
  | "proposed"
  | "new_image"
  | "unparseable"
  | "declined"
  | "uncovered"
  | "negation"
  | "invalid_slot"
  | "exclusion_uncleared"
  | "too_many_changes"
  | "round_trip_mismatch"
  | "first_claim"
  | "guarded"
  | "unswappable"
  | "timeout"
  | "error";

/** Every outcome but the two answers: a proposal, and a new image — which is an answer, never a refusal. */
export type Refusal = Exclude<InterpretOutcome, "proposed" | "new_image">;

export type Interpretation =
  | {
      kind: "proposal";
      /** C — the sentence the rest of the preview reads as if she had typed it. */
      canonical: string;
      /** The edits C carries, in C's order, each with where it came from. */
      edits: SourcedEdit[];
      /** The constraints that ride beside C, canonical order, each with where it came from. */
      constraints: SourcedConstraint[];
      spans: Span[];
      visibleMarks: VisibleMark[];
      /** `route(C)`'s steps — what the freeze will read. */
      steps: EditStep[];
    }
  | {
      /** She asked for a new picture of her, not an edit of this photograph. Nothing to build here. */
      kind: "new_image";
    }
  | {
      kind: "ask";
      outcome: Refusal;
      /** The code she hears, when it is not S's own: a guard's on C, or a too-many's. */
      askReason: string | null;
    };

const ask = (
  outcome: Refusal,
  askReason: string | null = null,
): Interpretation => ({
  kind: "ask",
  outcome,
  askReason,
});

// ─── 3. Coverage ───────────────────────────────────────────────────────────────────────────────────

/** Her sentence as the checks compare it: lowercase, straight apostrophes and quotes, one space. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** The words of a normalized string, with where each one starts and ends. */
function wordRanges(s: string): { word: string; start: number; end: number }[] {
  return [...s.matchAll(/[a-z0-9]+(?:['-][a-z0-9]+)*/g)].map((m) => ({
    word: m[0].replace(/'/g, ""),
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
}

/**
 * Where each span's quote sits in her sentence — IN ORDER, never overlapping — or null when a quote is
 * not her words, or the spans leave a word of hers unread.
 */
function locate(
  sentence: string,
  spans: readonly Span[],
): { start: number; end: number }[] | null {
  const s = norm(sentence);
  const found: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const span of spans) {
    const q = norm(span.quote);
    const at = s.indexOf(q, cursor);
    if (!q || at < 0) return null;
    found.push({ start: at, end: at + q.length });
    cursor = at + q.length;
  }
  const covered = (w: { start: number; end: number }) =>
    found.some((f) => w.start >= f.start && w.end <= f.end);
  return wordRanges(s).every(covered) ? found : null;
}

/** The words of a span's quote, apostrophes dropped. */
const quoteWords = (span: Span) => wordsOf(span.quote);

/**
 * What a "keep" is about: her ("keep me", "my face"), or everything but the change ("keep everything else
 * the same", "change nothing else", "leave the rest") — which includes her. v1 §5 reads both as
 * `preserve_person`: it only adds a keep sentence, and every native scope sentence already keeps the rest.
 */
const SELF = new Set([
  "me",
  "myself",
  "my",
  "i",
  "im",
  "face",
  "body",
  "hair",
  "else",
  "rest",
]);
/** Words that keep: "keep me", "leave me", "the same", "unchanged", "alone" — beside the negations. */
const KEEPS = new Set([
  "keep",
  "leave",
  "same",
  "unchanged",
  "alone",
  "untouched",
]);
/**
 * The changes a negation must refuse for a "keep" to be one: "dont CHANGE anything about me", "change
 * nothing else", "dont touch my face". A negation beside her name refusing nothing is not a keep —
 * "i dont have earrings in this one" (cell 3's second phrasing) names her and asks for nothing kept.
 */
const CHANGES = new Set([
  "change",
  "changes",
  "changing",
  "changed",
  "touch",
  "touching",
  "alter",
  "altering",
  "edit",
  "editing",
  "modify",
  "modifying",
  "mess",
  "retouch",
]);

/**
 * Coverage, as the module header states it. Returns the reason it fails, or null when it holds. `edit`
 * spans carry only edits of hers; each edit of hers is quoted exactly once; each constraint at least
 * once; a treatment only where the ad gate found an ad — and then exactly one.
 */
function coverageFails(
  input: InterpretationInput,
  reply: Reply,
): Refusal | null {
  if (!locate(input.sentence, reply.spans)) return "uncovered";
  const quotedEdits = new Map<number, number>();
  const quotedConstraints = new Set<number>();
  let treatments = 0;
  for (const span of reply.spans) {
    switch (span.reads) {
      case "unreadable":
        return "uncovered";
      case "filler":
        if (span.edits.length || span.constraints.length) return "uncovered";
        if (!quoteWords(span).every((w) => FILLER.has(w))) return "uncovered";
        break;
      case "edit":
        if (!span.edits.length || span.constraints.length) return "uncovered";
        for (const i of span.edits) {
          if (reply.edits[i]?.source !== "yours") return "uncovered";
          quotedEdits.set(i, (quotedEdits.get(i) ?? 0) + 1);
        }
        break;
      case "constraint":
        if (!span.constraints.length || span.edits.length) return "uncovered";
        for (const i of span.constraints) {
          if (!reply.constraints[i]) return "uncovered";
          quotedConstraints.add(i);
        }
        break;
      case "treatment":
        treatments++;
        if (!input.treatment || span.edits.length || span.constraints.length) {
          return "uncovered";
        }
        if (!AD_WORDS.test(span.quote)) return "uncovered";
        break;
    }
  }
  if (input.treatment && treatments !== 1) return "uncovered";
  const yours = reply.edits.flatMap((e, i) =>
    e.source === "yours" ? [i] : [],
  );
  if (!yours.every((i) => quotedEdits.get(i) === 1)) return "uncovered";
  if (reply.constraints.some((_, i) => !quotedConstraints.has(i)))
    return "uncovered";
  return null;
}

// ─── 4. The tripwire ───────────────────────────────────────────────────────────────────────────────

/** A negation inside an edit or a treatment — dropped, it would invert what she said. */
function tripped(reply: Reply): boolean {
  return reply.spans.some(
    (span) =>
      (span.reads === "edit" || span.reads === "treatment") &&
      quoteWords(span).some((w) => TRIPWIRE.has(w)),
  );
}

// ─── 5. Slots ──────────────────────────────────────────────────────────────────────────────────────

/** The quote an edit of hers came from. */
const quoteOf = (reply: Reply, index: number): string =>
  reply.spans.find((s) => s.reads === "edit" && s.edits.includes(index))
    ?.quote ?? "";

/** Does `words` occur, as whole words, in `quote`? */
const saysWords = (quote: string, words: string) => {
  const q = ` ${wordsOf(quote).join(" ")} `;
  const w = wordsOf(words).join(" ");
  return !!w && q.includes(` ${w} `);
};

/** Is every word of `slot` a word of her quote — an article or determiner aside? */
const allSaid = (quote: string, slot: string) => {
  const said = new Set(wordsOf(quote));
  const words = wordsOf(slot).filter((w) => !DETERMINERS.includes(w));
  return words.length > 0 && words.every((w) => said.has(w));
};

/**
 * Did HER quote say every word this edit's slots hold? "Your words" on the card must be true: an edit of
 * hers names only things, colours, brands, designs and settings she named. So "make it pop" can never
 * come back as a red jersey she did not mention, and "add a soccer ball" never gets a place she did not
 * give (D2 never shipped "the model picks the spot").
 *
 * The one exception is M3's: a thing she wears goes on the part of her it is worn on, so "give me these
 * gold hoops" is hers in her ears without her saying "ears" — only where `wornGoesOn` says that place is
 * the thing's own (plan v2 §10, cell 3).
 */
function saidByHer(e: SourcedEdit, quote: string): boolean {
  switch (e.kind) {
    case "recolor":
      return allSaid(quote, e.target) && allSaid(quote, e.colour);
    case "remove":
      return allSaid(quote, e.target);
    case "brand_swap":
      return (
        allSaid(quote, e.item) &&
        e.descriptors.every((d) => allSaid(quote, d)) &&
        saysWords(quote, e.brand)
      );
    case "pointed_swap":
      return allSaid(quote, e.target) && allSaid(quote, e.what);
    case "add": {
      if (!allSaid(quote, e.thing)) return false;
      if (allSaid(quote, e.place)) return true;
      const head = e.place.split(" ").at(-1) ?? "";
      return namesWornItem(e.thing) && wornGoesOn(e.thing, head);
    }
    case "design":
      return allSaid(quote, e.design) && allSaid(quote, e.target);
    case "background":
      return allSaid(quote, e.setting);
    case "look":
      // M6: a look is hers only when her own quote names its term. And the words she used for it must be
      // WHOLLY a look — rule 5¾'s own reading (studio/lookVocab.ts) — or the look would change more than
      // she asked: "make the jersey look vintage" names her jersey, and as a whole-photo vintage look it
      // would grade her, the grass and the sky (the style vocabulary put "vintage" on the menu). It only
      // refuses: a quote rule 5¾ would read as one look is the quote that passes.
      return saysWords(quote, e.term) && readWhollyLook(quote) !== null;
    case "text":
      return saysWords(quote, e.content);
    // PR 19: code's edit (the ad treatment's logo), never a reply's — so never hers by her words.
    case "brand_mark":
      return false;
  }
}

/**
 * A suggestion the rules refuse on its OWN WORDS — and only that (ledger F-I5).
 *
 * ─── WHY A REFUSED SUGGESTION NO LONGER COSTS THE WHOLE REPLY ──────────────────────────────────────
 *
 * For "turn this into a puma ad but dont change my face" the model suggested Puma's own "FOREVER FASTER" in
 * every R1 recording, interpret/2 to interpret/5, although the prompt forbids a brand's slogan; interpret/2
 * suggested Nike's "FIND YOUR GREATNESS" for both nike ads. The deny-list (`headlineBound`) refused it every
 * time — the guard holding — but a slot failure asked for the WHOLE reply, so she lost her own keep and the
 * brand's swaps with it, over words she never said. The suggestion is ours, and so is refusing it: it is
 * dropped, and the reply is read as if it had never been made. Her changes, the brand's swaps and the other
 * suggestion stand, and the refused words reach no C, no card and no prompt.
 *
 * ─── WHAT IT DOES NOT FORGIVE ──────────────────────────────────────────────────────────────────────
 *
 * A suggestion the model had no business making still asks, whole — that is the model outside the protocol,
 * not a wording the rules bound: a suggestion with no ad (M1), of a kind that is never suggested (a look, M6;
 * a swap, which is the brand's and code's), a headline with the text switch off, and two suggestions of one
 * kind (a refused one still counts). An edit of HERS out of bounds still asks: those are her words, and only
 * other words of hers fix them.
 */
function refusedSuggestion(
  input: InterpretationInput,
  e: SourcedEdit,
): boolean {
  return (
    e.source === "suggested" &&
    !!input.treatment &&
    SUGGESTIBLE.has(e.kind) &&
    (e.kind !== "text" || input.menu.text) &&
    !editOk(e, input.attached.objects)
  );
}

/**
 * The reply with its refused suggestions taken out, and every span's edit indices moved to match. A
 * suggestion is never quoted (coverage: an `edit` span carries only hers), so no span loses an edit.
 */
function withoutRefusedSuggestions(
  input: InterpretationInput,
  reply: Reply,
): Reply {
  const refused = reply.edits.flatMap((e, i) =>
    refusedSuggestion(input, e) ? [i] : [],
  );
  if (!refused.length) return reply;
  const moved = (i: number) => i - refused.filter((r) => r < i).length;
  return {
    ...reply,
    edits: reply.edits.filter((_, i) => !refused.includes(i)),
    spans: reply.spans.map((s) => ({ ...s, edits: s.edits.map(moved) })),
  };
}

function slotsFail(input: InterpretationInput, reply: Reply): boolean {
  const keys = new Set<string>();
  for (const [i, e] of reply.edits.entries()) {
    if (!editOk(e, input.attached.objects) && !refusedSuggestion(input, e)) {
      return true;
    }
    // A headline is on the menu only behind its switch — off, rule ⅛ is not there to read it (PR T).
    if (e.kind === "text" && !input.menu.text) return true;
    if (e.source === "suggested") {
      // A suggestion only for a treatment she named, and only a headline or a background (M1, M6).
      if (!input.treatment || !SUGGESTIBLE.has(e.kind)) return true;
    } else if (!saidByHer(e, quoteOf(reply, i))) {
      // Hers means her words — a look's term (M6), a headline's words, a swap's brand, every slot.
      return true;
    }
    // One change per thing, and one background, look and headline per image. Two suggestions of a
    // kind count as two too.
    const key = `${e.source === "suggested" ? "s:" : ""}${editKey(e)}`;
    if (keys.has(key)) return true;
    keys.add(key);
  }
  for (const [i, c] of reply.constraints.entries()) {
    const quote = reply.spans
      .filter((s) => s.reads === "constraint" && s.constraints.includes(i))
      .map((s) => s.quote)
      .join(" ");
    const w = wordsOf(quote);
    const refuses = w.some((x) => TRIPWIRE.has(x) || KEEPS.has(x));
    if (c.kind === "preserve_person") {
      // A keep, or a negation refusing a change. A negation alone is not one: read as "keep me", "i dont
      // have earrings in this one" would carry cell 3's second phrasing past the tripwire that asks it
      // (Adi's tripwire-wins decision, 2026-09-14; plan v2 §10).
      const keeps =
        w.some((x) => KEEPS.has(x)) ||
        (w.some((x) => TRIPWIRE.has(x)) && w.some((x) => CHANGES.has(x)));
      if (!w.some((x) => SELF.has(x)) || !keeps) return true;
    } else {
      // v1: a constraint's brand must appear in its own quote — and so must a word that refuses it.
      const removes =
        /\b(remove|delete|erase|take (out|off)|get rid of)\b/.test(w.join(" "));
      if (!saysWords(quote, c.brand) || !(refuses || removes)) return true;
    }
  }
  return false;
}

// ─── 7. The cap ────────────────────────────────────────────────────────────────────────────────────

/**
 * Fit a proposal to the pipeline's four-change cap, by priority (v2 §4, conflict C-2): her changes, then
 * the brand's required swaps, then one headline, then one background — then, only in a slot still spare, the
 * brand's logo (PR 19, ADI-R19-W3's logo rec: "logo only if spare"). Suggestions drop lowest priority first —
 * the logo, the background, then the headline — until it fits. Her changes and the required swaps are never
 * dropped: over four on their own, it asks. Null when it asks.
 * ⚠️ MUTATION M-markSpare: put the logo before the background — "the logo only takes a spare slot" reds by name.
 */
export function fitToCap(
  hers: readonly SourcedEdit[],
  required: readonly SourcedEdit[],
  headline: SourcedEdit | null,
  background: SourcedEdit | null,
  mark: SourcedEdit | null = null,
  cap: number = MAX_STEPS,
): SourcedEdit[] | null {
  const fitted = [...hers, ...required];
  if (fitted.length > cap) return null;
  for (const suggestion of [headline, background, mark]) {
    if (suggestion && fitted.length < cap) fitted.push(suggestion);
  }
  return fitted;
}

// ─── The whole ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What a treatment adds beside her changes: the swaps the brand requires (N1, N3 — assembled by code,
 * never chosen by the model; studio/interpret/ad.ts supplies them), and the model's one suggested
 * headline and one suggested background, where she did not ask for her own.
 */
export interface TreatmentPlan {
  required: SourcedEdit[];
  headline: SourcedEdit | null;
  background: SourcedEdit | null;
  /**
   * The brand's logo, like a watermark (PR 19, STUDIO_IMAGE_OPS) — code's, for a brand the rules list; it takes a
   * slot only when one is spare. Absent on every other plan.
   */
  mark?: SourcedEdit | null;
  /**
   * Constraints the treatment itself requires — an ad's exclusion of each competitor it saw (ad.ts, C-3).
   * Hers win where both name the same constraint: her words are the truer source.
   */
  constraints?: SourcedConstraint[];
  /** The treatment cannot be assembled at all — the ad asks with this, instead of a proposal. */
  refuse?: { outcome: Refusal; askReason: string | null };
}

/**
 * The suggestions a reply makes for a treatment — no required swaps here; `ad.ts` adds those. A
 * suggestion of a kind she already asked for is dropped: one headline and one background per image.
 */
export function suggestionsOf(
  input: InterpretationInput,
  reply: Reply,
): TreatmentPlan {
  const hers = new Set(
    reply.edits.filter((e) => e.source === "yours").map((e) => e.kind),
  );
  const suggested = (kind: "text" | "background") =>
    reply.edits.find((e) => e.source === "suggested" && e.kind === kind) ??
    null;
  return {
    required: [],
    headline: input.menu.text && !hers.has("text") ? suggested("text") : null,
    background: hers.has("background") ? null : suggested("background"),
  };
}

/**
 * The constraints as the freeze takes them: the closed shapes alone, where each came from left behind —
 * the freeze refuses any other key (nativeEdit.ts, `constraintIsWellFormed`).
 */
export function frozenConstraints(
  constraints: readonly SourcedConstraint[],
): EditConstraint[] {
  return constraints.map((c) =>
    c.kind === "preserve_person"
      ? { kind: "preserve_person" }
      : { kind: "exclude_marks", brand: c.brand },
  );
}

/** The constraint key the freeze sorts by — "keep me" first, then each brand's exclusion. */
const constraintOrder = (c: EditConstraint) =>
  c.kind === "preserve_person" ? "0" : `1:${c.brand}`;

/**
 * The model's reply → a proposal, or the ask she gets instead. See the module header for each step.
 *
 * `plan` is how a treatment is assembled (the ad's required swaps and suggestions); left out, a reply's
 * suggestions are taken as they are, with no required swaps — which is every sentence that is not an ad.
 */
export function propose(
  input: InterpretationInput,
  text: string,
  plan: (
    input: InterpretationInput,
    reply: Reply,
  ) => TreatmentPlan = suggestionsOf,
): Interpretation {
  const replied = parseReply(text);
  if (!replied) return ask("unparseable");
  if (replied.newImage) {
    return offersNewImage(input) ? { kind: "new_image" } : ask("invalid_slot");
  }
  if (replied.decline) return ask("declined");
  const uncovered = coverageFails(input, replied);
  if (uncovered) return ask(uncovered);
  if (tripped(replied)) return ask("negation");
  if (slotsFail(input, replied)) return ask("invalid_slot");
  if (
    replied.constraints.some((c) => c.kind === "exclude_marks") &&
    !input.menu.exclusion
  ) {
    return ask("exclusion_uncleared");
  }
  // From here the reply is read WITHOUT the suggestions the rules refused (ledger F-I5, `refusedSuggestion`).
  const reply = withoutRefusedSuggestions(input, replied);
  const dropped = replied.edits.length - reply.edits.length;

  const hers = reply.edits.filter((e) => e.source === "yours");
  if (hers.length > MAX_STEPS)
    return ask("too_many_changes", "too_many_changes");
  const treatment = input.treatment ? plan(input, reply) : null;
  if (treatment?.refuse) {
    return ask(treatment.refuse.outcome, treatment.refuse.askReason);
  }
  const edits = fitToCap(
    hers,
    treatment?.required ?? [],
    treatment?.headline ?? null,
    treatment?.background ?? null,
    treatment?.mark ?? null,
  );
  if (!edits) {
    return ask(
      "too_many_changes",
      input.treatment ? "ad_too_many_changes" : "too_many_changes",
    );
  }
  // Nothing left once a refused suggestion is dropped: the ask it always was, never a relabelled decline.
  if (!edits.length) return ask(dropped ? "invalid_slot" : "declined");

  const constraints: SourcedConstraint[] = reply.constraints.map((c) => ({
    ...c,
    source: "yours",
  }));
  // An ad always keeps her face, hair, body and pose (v2 §4) — hers when she said so, ours otherwise.
  if (
    input.treatment &&
    !constraints.some((c) => c.kind === "preserve_person")
  ) {
    constraints.push({ kind: "preserve_person", source: "suggested" });
  }
  // What the treatment requires beside hers — never twice: where she named the same, hers stands.
  for (const c of treatment?.constraints ?? []) {
    if (!constraints.some((x) => constraintOrder(x) === constraintOrder(c))) {
      constraints.push(c);
    }
  }
  constraints.sort((a, b) =>
    constraintOrder(a).localeCompare(constraintOrder(b)),
  );

  const trip = roundTrip(edits, input.attached);
  if (!trip.ok) {
    return trip.outcome === "guarded"
      ? ask("guarded", trip.code)
      : ask("round_trip_mismatch");
  }
  if (!firstClaimHolds(input.sentence, trip.clauseSteps, input.attached)) {
    return ask("first_claim");
  }
  return {
    kind: "proposal",
    canonical: trip.canonical,
    edits,
    constraints,
    spans: reply.spans,
    visibleMarks: reply.visibleMarks,
    steps: trip.routed.steps,
  };
}

// ─── Provenance for the card ───────────────────────────────────────────────────────────────────────

/** Does this frozen change come from this edit? Matched on what the change names — never on a line. */
function producedBy(c: NativeChange, e: SourcedEdit): boolean {
  switch (c.op) {
    case "RECOLOR":
      return e.kind === "recolor" && e.target === c.target;
    case "APPLY_DESIGN":
      return e.kind === "design" && e.target === c.target;
    case "REPLACE_OBJECT":
      return (
        (e.kind === "brand_swap" && e.item === c.target) ||
        (e.kind === "pointed_swap" && e.target === c.target)
      );
    case "REMOVE_OBJECT":
      return e.kind === "remove" && e.target === c.target;
    // ⚠️ ALWAYS FALSE, AND THAT IS CORRECT RATHER THAN UNFINISHED. The interpreter's menu has no move
    // edit (`SourcedEdit` has no such kind), so no proposal of its can ever produce one of these — a
    // move reaches the freeze only from a sentence she typed. The case exists so the switch stays total
    // and so the day a move joins the menu is a compile error here rather than a silently unprovenanced
    // card line. Parity is ledgered with F-WA7's, which has the same shape for G1's placements.
    case "MOVE_OBJECT":
      return false;
    case "ADD_OBJECT":
      return e.kind === "add" && e.thing === c.add?.thing;
    case "DISPLAY_TEXT":
      return e.kind === "text";
    case "CHANGE_BACKGROUND":
      return e.kind === "background";
    case "GLOBAL_STYLE":
      return e.kind === "look";
    // PR 19: the ad's brand logo — code's edit, from the ad treatment (ad.ts), never the model's.
    case "BRAND_MARK":
      return e.kind === "brand_mark";
    // PR 19: not on the interpreter's menu — each reaches the freeze only from a sentence she typed (MOVE's case).
    case "RELIGHT":
    case "CAMERA":
    case "CROP":
    case "GENERATE":
      return false;
  }
}

/**
 * The card's provenance for a frozen intent (compile/describe.ts): each frozen change tagged with the
 * edit that produced it, and each constraint with where it came from. Tags only — every word on the card
 * is still the frozen intent's.
 */
export function provenanceFor(
  intent: FrozenEditIntent,
  proposal: Extract<Interpretation, { kind: "proposal" }>,
): LineProvenance {
  const changes = intent.changes.map((c): ChangeTag | null => {
    const e = proposal.edits.find((x) => producedBy(c, x));
    if (!e) return null;
    return e.reason
      ? {
          source: e.source,
          reason: { brand: e.reason.brand, away: e.reason.away },
        }
      : { source: e.source };
  });
  const constraints = (intent.constraints ?? []).map(
    (k): LineSource | null =>
      proposal.constraints.find(
        (c) => constraintOrder(c) === constraintOrder(k),
      )?.source ?? null,
  );
  return { changes, constraints };
}
