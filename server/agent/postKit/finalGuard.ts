/**
 * agent/postKit/finalGuard.ts — the ONE check on the words a post kit hands the athlete to post, run on the FINAL text:
 * after the copy pass (COPYWRITER_V1) rewrote the caption and hook, and again on every caption edit. Pure: no database,
 * no model; the caller loads what it reads (build.ts guardSourcesFor; disclosure.ts for the athlete's deals).
 *
 * Before this, the never-content check ran on the plan's copy (build.ts, before the re-rank) and the copywriter's
 * rewrite after it was re-checked only for never-terms and avoided wording (services/copywriter.ts) — numbers, care
 * text, rates and disclosure were never looked at on the text that ships. The early check stays (it saves the re-rank
 * call on a kit that could never pass); this guard is the authority. It BLOCKS or FIXES — it never only records.
 *
 * The rules, in the order they run (content engine plan, "The guard"):
 *
 *   contact / prices / M.I.A.  a sentence carrying an email, a phone, a street address (lib/contactDetails.ts), a price
 *                              ("$500", "500 USD", "rate card", "my rates" — never "pounds", which is a weight) or the
 *                              M.I.A. / a marketability score is REMOVED at build. One exception: on a kit linked to a
 *                              real deal or affiliate record (disclosure "required"), a discount-code line ("Use code
 *                              RUN10 for $10 off") stands — when the record lists codes, only one of its own.
 *   numbers                    every number in the caption must appear in the post's own sources: the claims and names of
 *                              every ACTIVE fact the plan read for the athlete (not only the keys it cited; never a
 *                              disputed one), each fact's date as its YEAR only, the event's and moment's label, their
 *                              dates as a year and an ordinal day ("the 21st"), the due date likewise, and the countdown
 *                              to the event as "N days" / "N weeks" (so a bare "3" is never sourced by a date or a
 *                              countdown) — and, on an edit, the numbers the athlete typed themselves (theirs to state).
 *                              A sentence carrying an unsupported number is REMOVED and the rest re-checked; the number
 *                              is the point — BLOCKED — when it is in the on-card text, in the caption's first sentence,
 *                              or removing it leaves no words.
 *                              What is a number, and which ones are exempt, is numberParts below (NUMBERS): a distance,
 *                              a clock time, a jersey number only near words about what is worn, a 4-digit year only in
 *                              year context. Rankings and counts are checked ("#1 in the nation", "No. 1 seed", "Rushed
 *                              for 2000 yards", "10k+ followers"). This narrows invented numbers; it does not prove a
 *                              claim. Not caught, stated plainly: an invented race time written like a clock time
 *                              ("4:59"), a number written in words ("four goals"), a wrong number that some active fact
 *                              happens to hold — claim support is the model judge's job (phase 2).
 *   never / avoid / care       never-content (policy.findNeverContent: contact formats, a never-use name — also INSIDE a
 *                              hashtag: "#TeamEmma" matches "Emma"), the athlete's avoided wording (brand_voice avoid,
 *                              whole phrase, any case) and care text (validate.ts carriesCareText: five words in a row
 *                              from a care claim) in the caption, the on-card text or the music credit line → BLOCKED.
 *   #ad                        disclosure (shared/postKit.ts PostKitGuard) from the athlete's own records
 *                              (disclosure.ts): the post's partner (the caller's `disclosure`) AND every brand the final
 *                              words name or @-tag (disclosureInText), the stronger need winning. "required" — one
 *                              matches a signed / active deal, a gifted product or an affiliate record of theirs → `#ad`
 *                              at the very START of the caption (owner default, to confirm: a disclosure is never
 *                              buried at the end of a tag run), once — any other `#ad` taken out; FIXED, never
 *                              blocked; never added to an empty caption, never a caption that is only tags with "#ad".
 *                              "ask" — a brand named or @-tagged with no such record → nothing is added, and the kit is
 *                              marked so the athlete is asked one question ("Is this paid, gifted or an affiliate
 *                              post?"). "none" — no brand. On an edit without a record the athlete may take `#ad` out.
 *                              The caption limit (2,200) holds after `#ad`: only the words are trimmed, never the
 *                              disclosure or the music credit.
 *
 * Build vs edit (`mode`). At build the guard FIXES by removing what may not be posted. On an edit it never silently
 * deletes the athlete's words: anything it would remove is a refusal ("would_remove", with what it found) they can act
 * on; only the `#ad` a real deal requires is put in for them. The on-card text is never cut: what would be removed from
 * a caption blocks there. Lines in `keep` (the selected track's credit, music.ts creditLine) are never changed — only
 * read for never-content.
 *
 * A kit that passed is marked (PostKit.guard: version, when, its disclosure), so an edit of a kit built before the guard
 * existed (and never edited) re-checks its old numbers once — they are not taken as the athlete's own (edit.ts). The
 * version moves when the rules change, so a hold recorded under older rules is tried again (build.ts holdInputsKey).
 */
import type { MemoryFact } from "../../../shared/agent";
import { POST_KIT_CAPTION_CHARS, type PostKit, type PostKitDisclosure } from "../../../shared/postKit";
import { privateFormats } from "../../lib/contactDetails";
import { carriesCareText } from "../plan/validate";
import { findNeverContent } from "../policy";
import { hashtagsOf } from "./caption";
import { disclosureInText, type MaterialConnection } from "./disclosure";

export const GUARD_VERSION = 2 as const;

export type GuardFix = "contact" | "rate" | "mia" | "number" | "ad";
export type GuardBlock =
  | "never_content" | "avoided_wording" | "care_text" | "number_is_the_point" | "on_card" | "nothing_left" | "would_remove";
/** What disclosure a post owes (disclosure.ts decides it from the athlete's records). */
export type DisclosureNeed = "required" | "ask" | "none";

export interface GuardSources {
  /** The texts a number may come from (see the header). */
  numberSources: readonly string[];
  neverTerms: readonly string[];
  /** The athlete's avoided wording (brand_voice avoid). */
  avoidWords: readonly string[];
  /** The athlete's care facts (sensitive): their claims never appear in a post. */
  careFacts: readonly Pick<MemoryFact, "claim">[];
  /** What the post's partner (deliverable.target) owes, against the athlete's records (disclosure.ts disclosureFor). */
  disclosure: DisclosureNeed;
  /** The linked record's own discount codes (upper case); [] when it lists none. */
  codes?: readonly string[];
  /** The athlete's material connections, for brands the words themselves name or @-tag (disclosure.ts disclosureInText). */
  connections?: readonly MaterialConnection[];
  /** Brand names known to the product (studio/agent/brands.ts): one named with no record makes the post "ask". */
  knownBrands?: readonly string[];
  /** Number tokens allowed besides the sources' (an edit's own typed numbers, numberCandidates). */
  extraTokens?: readonly string[];
  /** "build": remove what may not be posted. "edit": refuse instead (never delete the athlete's words). */
  mode: "build" | "edit";
  /** Whole lines never changed (the music credit) — still read for never-content. */
  keep?: readonly string[];
}

export interface GuardInput {
  caption: string;
  /** The text laid on the post itself or read as its opening: the hook, the overlay. */
  onCard: readonly string[];
}

export type GuardResult =
  | { ok: true; caption: string; fixes: GuardFix[]; disclosure: PostKitDisclosure }
  | { ok: false; block: GuardBlock; fixes: GuardFix[]; found: string[] };

/// ─── what is read ────────────────────────────────────────────────────────────────────────────────────────────────

const RATE = /[$€£¥]\s?\d|\b\d[\d,.]*\s?[kKmM]?\s?(?:usd|eur|gbp|dollars?|euros?)\b|\brate\s?card\b|\b(?:my|our|her|his|their)\s+rates?\b/i;
const MIA = /\bM\.I\.A\.?(?![\p{L}\p{N}])|\bMIA\s+(?:score|index|rating|read)\b|\bmarketability\s+(?:score|index|rating)\b/u;
const CODE = /\bcode\s*[:\-]?\s*["“']?([A-Za-z0-9][A-Za-z0-9_-]{2,})/u;
const TAG = /#[\p{L}\p{M}\p{N}_]+/gu;
/** A tag with a letter in it ("#GameDay", "#Class2027"): read as a tag, never as a number. "#1" is a number. */
const WORD_TAG = /#[\p{L}\p{M}\p{N}_]*\p{L}[\p{L}\p{M}\p{N}_]*/gu;
const AD_TAG = /(^|[^\p{L}\p{N}_])#ad(?![\p{L}\p{N}_])/giu;
/** Words that make a k / m a count, not a distance, when one comes within the next three words ("10k new followers"). */
const AUDIENCE = /\b(?:followers?|following|views?|likes?|fans?|subscribers?|subs|plays?|streams?|impressions?|people|members?|downloads?|comments?|shares?|reach|listeners?|readers?|viewers?|supporters?)\b/iu;
/** Around a "No. N" / "#N": a jersey number only near words about what is worn, never near a ranking. */
const JERSEY_CONTEXT = /\b(?:jersey|wear(?:ing|s)?|wore|kit|shirt|uniform|on (?:my|the|his|her|their) back|rocking|repping|retired)\b/iu;
const RANK_CONTEXT = /\b(?:rank(?:ed|ing|s)?|seed(?:ed|s)?|nation(?:al(?:ly)?)?|country|state|world|conference|league|region(?:al)?|top|best|place[ds]?|finish(?:ed|es)?|pick|draft(?:ed)?|recruit)\b/iu;
/** Before / after a 4-digit year: only these make it a year ("Class of 2027", "in 2026", "the 2026 season"). */
const YEAR_BEFORE = /\b(?:class\s+of|in|since|from|until|through|back\s+in|fall|spring|summer|winter|season|year)\s*['’]?$/iu;
const YEAR_AFTER = /^\s*(?:[-–/]\s*['’]?\d{2,4}\s*)?(?:season|campaign|class|graduat\w*|grad|olympics|world\s+cup|draft|roster|team|squad|title)\b/iu;
const DAY_WEEK = /^\s*(?:(days?|nights?|sleeps?)|(weeks?|wks?))\b/iu;

/**
 * One pass over a text's numbers, in priority order. Named groups:
 *   iso                an ISO date — never checked; it lends only its year as a source (never its month or day)
 *   time               a clock time ("7 pm", "4:59") — never checked, lends nothing
 *   jersey (jn)        "No. 23" / "Number 23" / "#23" — a jersey number (not checked) only near JERSEY_CONTEXT and not
 *                      near RANK_CONTEXT; otherwise a number, checked ("No. 1 seed", "#1 in the nation")
 *   score              "3-1" — checked as a pair, either order
 *   dist (dv, du)      "100m", "5K", "10km", "3mi" — the event's name, not checked; a k / K / M with an AUDIENCE word in
 *                      the next three words ("10k+ followers", "10K new followers", "1.2M views") is a count, checked
 *   year (yr)          19xx / 20xx — a year (not checked) only with YEAR_BEFORE / YEAR_AFTER; otherwise a number
 *                      ("Rushed for 2000 yards" is checked)
 *   num                any other number: digits with thousands commas or a decimal, a k / m scale, a %, an ordinal
 */
const NUMBERS = new RegExp([
  String.raw`(?<iso>(?<![\p{N}])(?<isoyear>\d{4})-\d{2}-\d{2}(?:T[\d:.]+Z?)?(?![\p{N}]))`,
  String.raw`(?<time>(?<![\p{N}:.,])\d{1,2}(?::\d{2}){1,2}(?:\s?[ap]\.?m\.?)?(?![\p{L}\p{N}])|(?<![\p{N}:.,])\d{1,2}\s?[ap]\.?m\.?(?![\p{L}]))`,
  String.raw`(?<jersey>(?:\b(?:No|no|Number|number|Num|num)\.?\s?|#)(?<jn>\d{1,3})(?![\p{N}.,]\d|[\p{L}\p{N}]))`,
  String.raw`(?<score>(?<![\p{N}.,])\d{1,3}\s?[-–]\s?\d{1,3}(?![\p{N}]))`,
  String.raw`(?<dist>(?<![\p{N}.,])(?<dv>\d+(?:\.\d+)?)\s?(?<du>[kK][mM]|kilomet(?:er|re)s?|mi|miles?|met(?:er|re)s?|m|M|[kK])\+?(?![\p{L}]))`,
  String.raw`(?<year>(?<![\p{N}.,$€£#])(?<yr>(?:19|20)\d{2})(?![\p{N}%]|[.,]\d))`,
  String.raw`(?<num>(?<![\p{L}\p{N}_.,])[$€£]?(?<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<frac>\d+))?(?:\s?(?<scale>[kKmM])(?![\p{L}]))?(?<pct>%)?(?<ord>st|nd|rd|th)?(?![\p{L}\p{N}]))`,
].join("|"), "gu");

export interface NumberPart {
  raw: string;
  kind: "exempt" | "score" | "value";
  /** What it may match when it is in a caption: a value's (with and without its scale, its day / week / ordinal form). */
  tokens: string[];
  /**
   * What it lends when it is in a SOURCE: an ISO date only its year; "12 days" only "12d" (so a countdown or "out for 3
   * weeks" never sources a bare "3"); an ordinal ("3rd") only "3o"; a distance, a time or a jersey number nothing.
   */
  lends: string[];
}

const round = (n: number) => String(Math.round(n * 1000) / 1000);

/** A text's numbers, read as NUMBERS says. Word tags are not read; a number-only tag ("#1") is. */
export function numberParts(text: string): NumberPart[] {
  const t = text.replace(WORD_TAG, (m) => " ".repeat(m.length));
  const out: NumberPart[] = [];
  for (const m of t.matchAll(NUMBERS)) {
    const g = m.groups!;
    const at = m.index!;
    const before = t.slice(Math.max(0, at - 40), at);
    const after = t.slice(at + m[0].length, at + m[0].length + 40);
    const raw = m[0].trim();
    if (g.iso) { out.push({ raw, kind: "exempt", tokens: [], lends: [g.isoyear] }); continue; }
    if (g.time) { out.push({ raw, kind: "exempt", tokens: [], lends: [] }); continue; }
    if (g.jersey) {
      const n = String(Number(g.jn));
      const around = `${before} ${after}`;
      const worn = JERSEY_CONTEXT.test(around) && !RANK_CONTEXT.test(around);
      out.push(worn ? { raw, kind: "exempt", tokens: [], lends: [] } : { raw, kind: "value", tokens: [n], lends: [n] });
      continue;
    }
    if (g.score) {
      const [a, b] = g.score.split(/\s?[-–]\s?/).map((x) => String(Number(x)));
      const pair = [`${a}-${b}`, `${b}-${a}`];
      out.push({ raw, kind: "score", tokens: pair, lends: pair });
      continue;
    }
    if (g.dist) {
      const v = Number(g.dv);
      const unit = g.du;
      const next3 = after.replace(/^[+\s]+/, "").split(/\s+/).slice(0, 3).join(" ");
      if (/^[kKM]$/.test(unit) && (unit === "M" || AUDIENCE.test(next3))) {
        const scaled = round(v * (unit.toLowerCase() === "k" ? 1e3 : 1e6));
        out.push({ raw, kind: "value", tokens: [round(v), scaled], lends: [round(v), scaled] });
      } else out.push({ raw, kind: "exempt", tokens: [], lends: [] });
      continue;
    }
    if (g.year) {
      if (YEAR_BEFORE.test(before) || YEAR_AFTER.test(after)) out.push({ raw, kind: "exempt", tokens: [], lends: [g.yr] });
      else out.push({ raw, kind: "value", tokens: [g.yr], lends: [g.yr] });
      continue;
    }
    const whole = Number(g.int.replace(/,/g, ""));
    const v = round(whole + (g.frac ? Number(`0.${g.frac}`) : 0));
    const tokens = [v];
    if (g.scale) tokens.push(round(Number(v) * (g.scale.toLowerCase() === "k" ? 1e3 : 1e6)));
    const unit = DAY_WEEK.exec(after);
    if (g.ord) out.push({ raw, kind: "value", tokens: [...tokens, `${v}o`], lends: [`${v}o`] });
    else if (unit) { const u = `${v}${unit[1] ? "d" : "w"}`; out.push({ raw, kind: "value", tokens: [...tokens, u], lends: [u] }); }
    else out.push({ raw, kind: "value", tokens, lends: tokens });
  }
  return out;
}

/** What a set of SOURCE texts lends (NumberPart.lends): never a date's month or day, never a countdown's bare number. */
export function numberTokens(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const p of numberParts(t)) for (const k of p.lends) out.add(k);
  return out;
}

/** What a caption's numbers are, as tokens (NumberPart.tokens): an edit's own numbers (edit.ts). */
export function numberCandidates(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const p of numberParts(t)) if (p.kind !== "exempt") for (const k of p.tokens) out.add(k);
  return out;
}

const usesAvoided = (text: string, avoid: readonly string[]): boolean => {
  const low = text.toLowerCase();
  return avoid.some((a) => { const p = String(a ?? "").trim().toLowerCase(); return p.length > 0 && low.includes(p); });
};

/** A never-use term inside a hashtag: "#TeamEmma" / "#teamemma" carry "Emma" (letters and digits compared, any case). */
export function neverTermInTags(text: string, neverTerms: readonly string[]): boolean {
  const flat = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const terms = neverTerms.map(flat).filter((t) => t.length >= 2);
  if (!terms.length) return false;
  return [...text.normalize("NFC").matchAll(TAG)].some((m) => { const body = flat(m[0]); return terms.some((t) => body.includes(t)); });
}

/** What to remove from a sentence (and the offending text), or null to keep it. */
function removalFor(sentence: string, allowed: ReadonlySet<string>, codeLine: boolean): { fix: GuardFix; found: string } | null {
  if (privateFormats(sentence).length) return { fix: "contact", found: "a contact detail" };
  if (!codeLine && RATE.test(sentence)) return { fix: "rate", found: "a price or rate" };
  if (MIA.test(sentence)) return { fix: "mia", found: "the M.I.A." };
  if (!codeLine) {
    const bad = numberParts(sentence).find((p) => p.kind !== "exempt" && !p.tokens.some((t) => allowed.has(t)));
    if (bad) return { fix: "number", found: bad.raw };
  }
  return null;
}

const tagsOnly = (s: string) => s.trim().length > 0 && s.replace(TAG, "").trim() === "";

// ─── sentences ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A dot after these words is an abbreviation, never a sentence's end (any case): "St. Louis", "vs. the", "Jr. year". */
const ABBREVIATION_WORD = /(?:^|[\s("“])(?:nos|st|vs|jr|sr|dr|mr|mrs|ms|mt|ft|ave|approx|etc|e\.g|i\.e|a\.m|p\.m)\.$/iu;
/** An initial — a capital letter alone, case-sensitive ("U.S.", "M.I.A.", "J. Smith"); never a lower-case letter. */
const INITIAL = /(?:^|[\s("“.])\p{Lu}\.$/u;
/** "No." is an abbreviation only when a number follows it ("No. 23"); "Said no. Then yes." splits. */
const NUMBER_ABBREVIATION = /(?:^|[\s("“])no\.$/iu;

/** Sentences of a line: split after . ! ? … and a space — never after an abbreviation's dot. */
export function sentencesOf(line: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of line.matchAll(/[.!?…]+["”')\]]*\s+/gu)) {
    const end = m.index! + m[0].trimEnd().length;
    const tail = line.slice(Math.max(from, end - 12), end);
    const next = line.slice(m.index! + m[0].length);
    if (ABBREVIATION_WORD.test(tail) || INITIAL.test(tail) || (NUMBER_ABBREVIATION.test(tail) && /^\d/.test(next))) continue;
    out.push(line.slice(from, end));
    from = m.index! + m[0].length;
  }
  out.push(line.slice(from));
  return out.filter((s) => s.length > 0);
}

// ─── #ad ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `#ad` at the very START of the caption, then the caption (owner default, to confirm: a disclosure is never buried at
 * the end of a tag run). Any other `#ad` in it is taken out, so it is counted once. An empty caption gets none.
 */
export function withAdLead(body: string): string {
  const stripped = body.replace(AD_TAG, "$1").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return stripped ? `#ad ${stripped}` : "";
}

/** The caption cut to `max` characters with its disclosure and its kept lines whole: only the words in between shrink. */
function capped(caption: string, credit: readonly string[], max: number): string {
  if (!caption) return credit.join("\n\n"); // no words: the credit alone, with no blank lines before it
  const tail = credit.length ? `\n\n${credit.join("\n\n")}` : "";
  const lead = caption.startsWith("#ad ") ? "#ad " : "";
  const body = caption.slice(lead.length);
  const room = max - lead.length - tail.length;
  if (body.length <= room) return `${lead}${body}${tail}`;
  const head = body.slice(0, Math.max(0, room));
  const cut = head.search(/\s\S*$/);
  return `${lead}${(cut > room / 2 ? head.slice(0, cut) : head).trimEnd()}${tail}`;
}

// ─── the guard ───────────────────────────────────────────────────────────────────────────────────────────────────

export function guardPostText(input: GuardInput, src: GuardSources): GuardResult {
  const fixes: GuardFix[] = [];
  const found: string[] = [];
  const fix = (f: GuardFix, what: string) => { if (!fixes.includes(f)) fixes.push(f); if (!found.includes(what)) found.push(what); };
  const fail = (block: GuardBlock): GuardResult => ({ ok: false, block, fixes, found });
  const allowed = new Set([...numberTokens(src.numberSources), ...(src.extraTokens ?? [])]);
  const keep = new Set((src.keep ?? []).map((l) => l.trim()).filter(Boolean));
  const onCard = input.onCard.filter((t) => t && t.trim());

  // Disclosure: the post's partner (src.disclosure) and every brand the words themselves name or @-tag (disclosure.ts
  // disclosureInText, against the athlete's own records) — the stronger need wins.
  const named = disclosureInText([input.caption, ...onCard].join("\n"), src.connections ?? [], src.knownBrands ?? []);
  const need: DisclosureNeed = src.disclosure === "required" || named.need === "required" ? "required"
    : src.disclosure === "ask" || named.need === "ask" ? "ask" : "none";
  const codes = [...new Set([...(src.codes ?? []), ...named.codes])];
  const isCodeLine = (s: string) => {
    if (need !== "required") return false;
    const m = CODE.exec(s);
    return !!m && (!codes.length || codes.includes(m[1].toUpperCase()));
  };

  // The on-card text is one line: nothing in it is cut — what would be removed from a caption blocks here.
  for (const t of onCard) {
    const why = removalFor(t, allowed, false);
    if (why) { found.push(why.found); return fail(why.fix === "number" ? "number_is_the_point" : "on_card"); }
  }

  // The caption, line by line (kept lines aside), sentence by sentence (a tags-only line or sentence is read as tags).
  const lines = input.caption.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  const credit: string[] = [];
  let had = 0;
  let words = 0;
  for (const line of lines) {
    if (keep.has(line.trim())) { credit.push(line.trim()); continue; }
    if (!line.trim() || tagsOnly(line)) { kept.push(line); continue; }
    const out: string[] = [];
    for (const s of sentencesOf(line)) {
      if (tagsOnly(s)) { out.push(s); continue; }
      const why = removalFor(s, allowed, isCodeLine(s));
      // The first sentence is the line the post leads with: an unsupported number there is the point of the post. (On an
      // edit every finding is a refusal anyway — "would_remove", which names the number.)
      if (why?.fix === "number" && had === 0 && src.mode === "build") { fix("number", why.found); return fail("number_is_the_point"); }
      had++;
      if (why) { fix(why.fix, why.found); continue; }
      out.push(s);
      words++;
    }
    if (out.length) kept.push(out.join(" "));
  }
  // On an edit nothing of the athlete's is deleted for them: what would be removed is a refusal.
  if (src.mode === "edit" && fixes.length) return fail("would_remove");
  // Words went in and none came out: nothing is left to post. (A kit with no caption at all is left as it is — the
  // athlete writes one, and that edit is guarded too.)
  if (had && !words) return fail(fixes.includes("number") ? "number_is_the_point" : "nothing_left");
  let caption = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Re-check what is left: a removal never leaves a number, a price or a contact detail behind.
  for (const s of caption.split("\n").filter((l) => !tagsOnly(l)).flatMap(sentencesOf)) {
    if (!tagsOnly(s) && removalFor(s, allowed, isCodeLine(s))) return fail("nothing_left");
  }

  // Never-content (in a tag too), avoided wording and care text block — caption, on-card text and credit line alike.
  const all = [caption, ...onCard, ...credit].join("\n");
  if (findNeverContent(all, src.neverTerms).length || neverTermInTags(all, src.neverTerms)) return fail("never_content");
  if (usesAvoided(all, src.avoidWords)) return fail("avoided_wording");
  if (carriesCareText(all, src.careFacts)) return fail("care_text");

  // Never a caption that is only "#ad" (or only tags with #ad among them).
  if (caption && caption.replace(TAG, "").trim() === "" && hashtagsOf(caption).some((t) => t.toLowerCase() === "#ad")) return fail("nothing_left");
  // #ad at the start when a real record requires it — never on an empty caption. A caption that is only the music credit
  // has no words for a disclosure to lead: blocked, never a credit-only caption marked "ad".
  if (need === "required" && !caption && credit.length) return fail("nothing_left");
  if (need === "required" && caption) {
    const next = withAdLead(caption);
    if (next !== caption) { caption = next; fix("ad", "#ad"); }
  }
  // The caption limit holds after #ad: only the words between the disclosure and the kept lines are trimmed.
  return {
    ok: true, caption: capped(caption, credit, POST_KIT_CAPTION_CHARS), fixes,
    disclosure: need === "required" ? "ad" : need === "ask" ? "ask" : null,
  };
}

/**
 * The texts a built kit's numbers may come from (see the header): every fact the plan read (claims, names, and each
 * date's YEAR only — a fact dated 14 March never sources a "3" or a "14"), the event's and the moment's label, their
 * dates as a year and as an ordinal day ("the 21st"), the due date likewise, and the countdown from today and from the
 * due date to the event as "N days" / "N weeks" (so it sources "12 days", never a bare "12").
 */
export function numberSourcesFor(p: {
  facts: readonly Pick<MemoryFact, "claim" | "date" | "subject">[];
  event: { label: string; date: string } | null;
  moment: { name: string | null; date: string | null } | null;
  dueOn: string | null;
  today: string;
}): string[] {
  const out: string[] = [];
  const iso = (x: string | null | undefined): x is string => !!x && /^\d{4}-\d{2}-\d{2}/.test(x);
  const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
  const dated = (x: string | null | undefined) => { if (iso(x)) out.push(x.slice(0, 4), ordinal(Number(x.slice(8, 10)))); };
  for (const f of p.facts) { out.push(f.claim, f.subject?.name ?? ""); if (iso(f.date)) out.push(f.date.slice(0, 10)); }
  if (p.event) { out.push(p.event.label); dated(p.event.date); }
  if (p.moment) { out.push(p.moment.name ?? ""); dated(p.moment.date); }
  dated(p.dueOn);
  const target = p.event?.date ?? p.moment?.date ?? null;
  const day = (x: string) => Date.parse(`${x.slice(0, 10)}T00:00:00Z`);
  if (iso(target)) {
    for (const from of [p.today, p.dueOn].filter(iso)) {
      const days = Math.round((day(target) - day(from)) / 86_400_000);
      if (days >= 0) out.push(`${days} days`, `${Math.floor(days / 7)} weeks`, `${Math.ceil(days / 7)} weeks`);
    }
  }
  return out.filter(Boolean);
}

export type GuardKitResult =
  | { ok: true; kit: PostKit; fixes: GuardFix[] }
  | { ok: false; block: GuardBlock; fixes: GuardFix[]; found: string[] };

/**
 * A kit through the guard: its caption (the credit lines in `keep` aside) and its on-card text (the hook, the overlay).
 * The kit back with the guarded caption — its `hashtags` re-listed from it — and marked guarded (PostKit.guard), or the
 * block.
 */
export function guardKit(kit: PostKit, src: GuardSources, now: Date): GuardKitResult {
  const r = guardPostText({ caption: kit.caption.text, onCard: [kit.idea.hook, kit.treatmentPlan.overlayText ?? ""] }, src);
  if (!r.ok) return r;
  const guard = { version: GUARD_VERSION, at: now.toISOString(), disclosure: r.disclosure };
  const caption = r.caption === kit.caption.text ? kit.caption : { ...kit.caption, text: r.caption, hashtags: hashtagsOf(r.caption) };
  return { ok: true, kit: { ...kit, caption, guard }, fixes: r.fixes };
}

/** Plain words for a block on a caption edit — what the athlete can do next, not a code. */
export const GUARD_REFUSALS: Record<Exclude<GuardBlock, "would_remove">, string> = {
  never_content: "That caption has something you asked Nomila never to use. Take it out and save again.",
  avoided_wording: "That caption uses wording you asked Nomila to avoid. Change it and save again.",
  care_text: "That caption mentions something Nomila keeps out of posts. Take it out and save again.",
  number_is_the_point: "Nomila can't check a number in that caption against your facts. Take it out or change it, then save again.",
  on_card: "The post's opening line has something that can't go in a post.",
  nothing_left: "That caption needs some words of its own. Write a line, then save again.",
};

/** The refusal for an edit the guard would have had to cut (never done for the athlete): what it found, in plain words. */
export function wouldRemoveRefusal(found: readonly string[]): string {
  const items = found.map((f) => (f === "a contact detail" || f === "a price or rate" || f === "the M.I.A." ? f : `a number Nomila can't check against your facts (${f})`));
  const list = items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0] ?? "something that can't be posted";
  return `That caption has ${list}. Take it out, then save again.`;
}

export type { PostKitDisclosure };
