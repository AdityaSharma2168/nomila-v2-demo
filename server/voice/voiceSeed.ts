/**
 * voiceSeed.ts — structure becomes speech. Pure function, no DB, no model.
 *
 * Turns a `VoiceContextState` into ONE short note seeded into a new voice
 * session's chat context, so Mila can pick up where a previous session left off
 * without anyone replaying a transcript.
 *
 * ── Why this is app-authored copy and therefore safe to speak ────────────────
 * Every sentence below is written HERE, by template, from ids, enums and
 * booleans. Nothing is quoted from `chat_messages`, from a tool result, or from
 * a model. That is the same reason `reasons` crosses the voice wire while
 * `economicsState.read` does not: the shape of the text is ours.
 *
 * ── Names are the one thing we cannot template ───────────────────────────────
 * The artifact stores `brandId` and `dealId`, never names — names are extracted
 * from brand email and are not ours. But "you looked at brand one-six-six" is
 * useless out loud, so the caller resolves ids to display names and passes them
 * in. That keeps this function pure AND keeps the read at the boundary.
 *
 * Those names are still model-extracted text, so they are SANITISED here before
 * they reach a sentence: single line, bounded length, no angle brackets. A name
 * that fails is not spoken at all — the entry degrades to a count ("a couple of
 * others") rather than putting an unvetted string into speech. `dealRoutes`
 * already passes `brand_name` on the wire by deliberate precedent, but a seed is
 * injected into the model's own context, so it gets the stricter treatment.
 *
 * ── Silence is a designed outcome, not a fallback ────────────────────────────
 * No artifact → null → nothing injected. An athlete who has only ever TEXTED has
 * a long history in `chat_messages` and no voice state, and the seed deliberately
 * does NOT reach into that history: it is full of brand and email prose, and
 * pulling it into a session that speaks aloud is the exact boundary this design
 * exists to hold. The first voice turn is blind to text context on purpose.
 *
 * The safe future bridge is the TEXT side also populating `voice_context` — same
 * structured artifact, written from its own tool results. Not this change.
 */

// Deliberately from ./voiceContextTypes, NOT ./voiceContext: this module is pure
// and its test runs without a database. Importing the store would pull server/db
// in behind it.
import {
  MAX_ENTRIES,
  type Channel,
  type OpenTopic,
  type VoiceContextState,
} from "./voiceContextTypes";
import type { RecAction } from "../skills/dealScoreGrid";

/**
 * Display names for the ids in the artifact, resolved by the caller.
 * Missing entries are fine — the sentence degrades rather than failing.
 */
export interface SeedNames {
  /** dealId → the deal's brand name. */
  deals: Record<string, string>;
  /** brandId → the brand's name. */
  brands: Record<number, string>;
}

/** Longest name spoken. A real brand name is short; anything long is suspect. */
const NAME_MAX = 60;

/**
 * Model-extracted text, made safe to place in a sentence — or rejected.
 * Collapses whitespace (a newline would break the note into fake instructions),
 * bounds length, and refuses anything carrying markup.
 */
function safeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat || flat.length > NAME_MAX) return null;
  if (/[<>]/.test(flat)) return null;
  return flat;
}

/**
 * The call that was reached, in the words she'd use — never the enum.
 *
 * ── Why these describe a READ and not something she said ─────────────────────
 * `recommendationGiven` is `deal.recommendation`: OUR reconciled recommendation,
 * captured off the tool result. It is NOT a record of her answer, and the tool
 * guidance is explicit that the two can differ — she is told to report the call
 * and then give her own take on top, so a deal recommended `accept` can be one
 * she argued against.
 *
 * These phrases used to read "you told them to take it", which asserts speech we
 * never captured. That was already wrong for voice. It became worse when the TEXT
 * side started writing this artifact: the same sentence then claims she SPOKE
 * something the athlete only ever read on screen, and she would carry that false
 * memory into the call.
 *
 * So they name the read, which is exactly what we stored and all we can stand
 * behind. If she disagreed with it last time, "the read on it was to take it" is
 * still true and leaves her free to say so again.
 */
const REC_PHRASE: Record<RecAction, string> = {
  accept: "the read on it was to take it",
  negotiate: "the read was to push on the terms first",
  reject: "the read was to pass",
  delete: "the read was that it wasn't a real offer",
};

/**
 * How an entry from another surface is qualified, mid-sentence.
 *
 * Voice gets NOTHING — it is the default channel and the ordinary case, and a
 * qualifier on every sentence would be noise in the common path. Only text is
 * marked, because that is the case where an unqualified sentence would be false.
 */
const CHANNEL_QUALIFIER: Record<Channel, string> = {
  voice: "",
  text: " over chat",
};

/**
 * The watch-item, in two parts so the DEAL can lead the sentence: a short noun
 * phrase, and a gloss only where the noun alone is not self-explanatory.
 *
 * Deliberately generic on exclusivity — we are never told which category is
 * locked out, so the gloss must not imply we know.
 */
const TOPIC: Record<
  OpenTopic,
  { short: string; gloss?: string; plural?: true }
> = {
  exclusivity: {
    short: "the exclusivity",
    gloss: "whether it locks them out of other deals",
  },
  rate: { short: "the rate" },
  scope: {
    short: "the deliverable scope",
    gloss: "how much work it actually is",
  },
  usage_rights: {
    short: "the usage rights",
    gloss: "how long the brand can run the content",
    // "rights" takes a plural verb — "the usage rights WERE left open".
    plural: true,
  },
  timing: { short: "payment timing", gloss: "when they actually get paid" },
};

/**
 * Counts spoken as words, per the voice rule that numbers are said not read.
 * Lists are capped at MAX_ENTRIES, so the largest remainder is bounded.
 */
const NUM_WORD = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
const numWord = (n: number): string => NUM_WORD[n] ?? String(n);

/** Most names said aloud in one breath before it becomes a recital. */
const SPOKEN_NAMES = 3;

/**
 * Names a few and gestures at the rest. Reading ten brand names in a row is the
 * flat-list failure this whole phase removed from her spoken answers; it must not
 * come back in through the seed.
 */
function speakSome(names: string[], noun: string): string {
  const shown = names.slice(0, SPOKEN_NAMES);
  const extra = names.length - shown.length;
  if (!extra) return speakList(shown);
  return `${speakList(shown)}, and ${numWord(extra)} other ${plural(extra, noun, noun + "s")}`;
}

/** "a", "a and b", "a, b and c" — spoken lists, never comma-separated data. */
function speakList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The seed, or null when there is nothing worth saying.
 *
 * Null covers three cases that all mean the same thing out loud: no artifact at
 * all, an artifact with nothing in it, and an artifact whose entries were all
 * unnameable. In every one, saying nothing is better than saying we discussed
 * nothing — the athlete did not ask, and an agent who opens by announcing the
 * absence of memory sounds like software.
 */
export function buildVoiceSeed(
  state: VoiceContextState | null,
  names: SeedNames,
): string | null {
  if (!state) return null;

  const parts: string[] = [];

  // ── Deals she gave a read on ───────────────────────────────────────────────
  const namedDeals = state.dealsDiscussed
    .map((d) => ({
      name: safeName(names.deals[d.dealId]),
      rec: d.recommendationGiven,
      channel: d.channel,
    }))
    .filter(
      (d): d is { name: string; rec: RecAction | null; channel: Channel } =>
        d.name !== null,
    );

  if (namedDeals.length) {
    // Lead with the one carrying an actual call — that is the useful memory.
    const withRec = namedDeals.filter((d) => d.rec !== null);
    const lead = withRec[0] ?? namedDeals[0];
    // Qualifies the lead sentence only. The "you also looked at" list below is a
    // gesture at the rest, and tagging each of its names would turn a spoken
    // aside into a table of provenance.
    const where = CHANNEL_QUALIFIER[lead.channel];
    if (lead.rec) {
      parts.push(
        `You went through their ${lead.name} deal${where} and ${REC_PHRASE[lead.rec]}.`,
      );
    } else {
      parts.push(`You went through their ${lead.name} deal${where}.`);
    }

    const rest = namedDeals.filter((d) => d !== lead);
    if (rest.length) {
      parts.push(
        `You also looked at ${speakSome(
          rest.map((d) => d.name),
          "deal",
        )}.`,
      );
    }
  }

  // ── Brands with no deal ────────────────────────────────────────────────────
  const brandEntries = state.brandsDiscussed
    .filter((b) => !b.hadDeal)
    .map((b) => ({
      name: safeName(names.brands[b.brandId]),
      channel: b.channel,
    }))
    .filter((b): b is { name: string; channel: Channel } => b.name !== null);
  const namedBrands = brandEntries.map((b) => b.name);

  if (namedBrands.length) {
    // Qualified only when EVERY one of them came from chat. A mixed list has no
    // single true qualifier, and "some of these over chat" is a hedge nobody
    // speaks — better to say where nothing, than to say it wrongly.
    const where = brandEntries.every((b) => b.channel === "text")
      ? CHANNEL_QUALIFIER.text
      : "";
    // ── The no-deal fact is BOUND to the brand, never left standing alone ────
    // This used to end "— no deal with them.", which is a sentence-final
    // assertion: complete, present-tense, and quotable straight back as the
    // answer to a question nobody asked. Live, exactly that happened — asked to
    // make an open Handshake draft longer, she answered "There's no deal with
    // gorjana on file, so nothing to expand", lifting this clause for a brand
    // that had nothing to do with the request (gorjana appeared nowhere else in
    // that session).
    //
    // A relative clause carries the same information and cannot travel on its
    // own: "gorjana, which they have no deal with" is not an answer to
    // anything. The fact is kept — it is worth remembering that a brand came up
    // and went nowhere — and only its liftability is removed.
    parts.push(
      namedBrands.length === 1
        ? `They also asked about ${namedBrands[0]}${where}, which they have no deal with.`
        : `They also asked about ${speakSome(namedBrands, "brand")}${where}, none of which they have deals with.`,
    );
  }

  // ── What was left open ────────────────────────────────────────────────────
  // DEAL FIRST. "You flagged whether the exclusivity locks them out of other
  // deals on the Prime Hydration deal as still open" puts eleven words between
  // the subject and its qualifier — it parses and nobody talks like that.
  const threads = state.openThreads
    .map((t) => {
      const { short, gloss, plural: isPlural } = TOPIC[t.topic];
      const body = gloss ? `${short} — ${gloss} —` : short;
      const verb = isPlural ? "were" : "was";
      // A thread tied to a deal we cannot NAME is not speakable: "the
      // exclusivity is still open" leaves out the only thing that made it
      // actionable. Drop it rather than raise a worry with no subject. A thread
      // with no dealId at all was never tied to one, so it stands on its own.
      if (!t.dealId) return { lead: null, body, verb };
      const dealName = safeName(names.deals[t.dealId]);
      return dealName ? { lead: dealName, body, verb } : null;
    })
    .filter(
      (t): t is { lead: string | null; body: string; verb: string } =>
        t !== null,
    )
    .slice(0, 2); // Two is plenty spoken; the rest stay in the artifact.

  if (threads.length) {
    const [first, second] = threads;
    parts.push(
      first.lead
        ? `On ${first.lead} you flagged ${first.body} as still open.`
        : `You flagged ${first.body} as still open.`,
    );
    // A second full frame reads like a form. Shorten it.
    if (second) {
      parts.push(
        second.lead
          ? `On ${second.lead}, ${second.body} ${second.verb} left open too.`
          : `${second.body} ${second.verb} left open too.`,
      );
    }
  }

  // ── Cards already opened ──────────────────────────────────────────────────
  // The only entry in this note that records an ACTION rather than a topic, and
  // the reason it earns its place: "did we already pull up a reply to them?" is
  // a question the athlete can answer for themselves — they watched the card
  // appear — so getting it wrong is obvious in a way the rest of this is not.
  //
  // Deliberately says PULLED UP and not "sent", "wrote" or "drafted". Opening a
  // card is the whole of what happened: the app writes the body and only the
  // athlete's own tap sends it, and the tool guidance is emphatic that she must
  // never imply otherwise. A memory that overstated it would put her in exactly
  // the position that guidance exists to prevent, one session later.
  //
  // The intent is NOT spoken. "You pulled up a negotiate reply" is an enum read
  // aloud, and the athlete cares which brand, not which of our four verbs.
  const draftNames = state.draftsOpened
    .map((d) => safeName(d.brandName))
    .filter((n): n is string => n !== null);

  if (draftNames.length) {
    parts.push(
      draftNames.length === 1
        ? `You already pulled up a reply to ${draftNames[0]} — it is on their screen, unsent unless they tapped Send.`
        : `You already pulled up replies to ${speakSome(draftNames, "brand")} — those are on their screen, unsent unless they tapped Send.`,
    );
  }

  if (!parts.length) return null;

  // ── The cap, stated rather than implied ───────────────────────────────────
  // Only when a list is actually full, so it never claims a limit that did not
  // bite. And NO COUNT of what was dropped: those entries were evicted, so we do
  // not know how many there were, and a number here would be invented.
  const capped =
    state.dealsDiscussed.length >= MAX_ENTRIES ||
    state.brandsDiscussed.length >= MAX_ENTRIES ||
    state.draftsOpened.length >= MAX_ENTRIES;
  if (capped) {
    parts.push(
      "That is only the recent stretch — there was more before it that you no longer have in front of you.",
    );
  }

  // ── The framing does as much work as the content ──────────────────────────
  // Without the first sentence she reads this as something to announce, and
  // opens the call by recapping the last one.
  //
  // The second sentence is the one that was missing, and it cost a live
  // session. This block is injected as an ASSISTANT message, so the model reads
  // it as something it already said and therefore already believes — which
  // makes every fact in here look like a conclusion it can reuse. Asked to make
  // an open draft longer, it reached in here for a brand instead of using the
  // one on screen. So the note has to say explicitly what it is NOT: background
  // on what came before, never an answer, and never the way to work out which
  // deal a new request is about.
  return (
    "Context from earlier in this conversation, for your own reference. " +
    "Do NOT read it out, recap it, or mention that you remember it — just use it " +
    "if it is relevant to what they ask.\n" +
    "This is background on what came up BEFORE, and none of it is an answer to a " +
    "new question. If they ask you to change, redo or expand something, that is " +
    "about what is on their screen now — never assume it is about a brand named " +
    "here.\n" +
    parts.join(" ")
  );
}
