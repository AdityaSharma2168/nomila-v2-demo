/**
 * studio/agent/subject — WHO the tagger's own words say is in the frame: her, another person, or
 * nobody.
 *
 * ─── ⚠️  A STOPGAP, PENDING THE PROMPT FIX — THE CODE SAYS SO ────────────────────────────────────
 *
 * The enrichment eval (docs/probes/enrich-eval.md, 22 Sep 2026) convicted `athlete_present` blind,
 * on both models: two uploads of a named male professional and a CGI clip holding his still answer
 * `true` at 0.9, and four more cells answer `true` on frames whose description names nobody. The
 * tagger's prompt asks "is the athlete clearly the subject" and has never been told who she is —
 * so a named professional IS "the athlete" to it. Flash names him in the description and still
 * says present. The real fix is a two-line profile in the prompt and a "the athlete / another
 * person / nobody" answer shape — SHARED CODE (lib/visionTag.ts, and the video prompt by the same
 * decision), proposed to Mia in docs/proposals/enrich-athlete-present-prompt.md.
 *
 * Until that lands, this module reads the DESCRIPTION the tagger wrote and refuses to let a row it
 * describes as someone else, or as no one, enter the planner's library as her. Every list below is
 * an EVAL-DERIVED HEURISTIC: the word lists, the stoplist and the quote rule were tuned against the
 * 110 stored descriptions of the eval's sheet (0 false fires on rows of her, 9 true fires) and
 * against nothing else. They are not a model of English. When the prompt fix lands and the tagger
 * answers the question itself, this module is deleted, not extended.
 *
 * ─── WHAT IT READS ──────────────────────────────────────────────────────────────────────────────
 *
 * The whole-clip `description`, and on a clip every beat's description too: `2a7d49f0`'s whole-clip
 * line says "a transition from a field to a studio portrait" and names no one, while its beats say
 * "the athlete … tying her shoe". Judged on the line alone it would read as nobody; it is her.
 *
 * ─── THE THREE ANSWERS ──────────────────────────────────────────────────────────────────────────
 *
 *   other    a male word — with a UNICODE-AWARE boundary, because to a plain `\b` the name "Mané"
 *            ends in the English word "Man" — or a Capitalised-Capitalised bigram that reads as a
 *            person's name: outside quotes (a quoted span is a logo or a sign — 'MUMBAI COBRAS',
 *            'Get Loud'), not all-caps, neither token inside `brands_visible`, and neither token
 *            on the place/org stoplist. The stored Mané lines carry no male word at all —
 *            "Professional soccer player Sadio Mané mid-air …" — so the name is the only signal.
 *   nobody   no person word at all (a ball, a bracelet, a graphic) — or only body-part / "a
 *            person" words with none of she·her·woman·girl·female·athlete·player: "a person's
 *            hands squeezing a bottle" is not a photograph OF her, whatever the tag says.
 *   her      everything else. The default, on purpose: a miss here costs one wrong line in a
 *            library of thirty, and the planner is told what the line shows.
 *
 * Pure. No model, no database, no network.
 */
import { normalizeBrandName } from "../../services/mediaSearch";

export type Subject = "her" | "other" | "nobody";

/** Unicode-aware word boundary: not preceded / followed by a letter or a digit. */
const bounded = (words: readonly string[]): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`,
    "iu",
  );

/** ⚠️ EVAL-DERIVED HEURISTIC (see the header). A male person, by the words the tagger uses for one. */
const MALE_WORDS: readonly string[] = [
  "male",
  "man",
  "men",
  "boy",
  "boys",
  "guy",
  "guys",
  "he",
  "him",
  "his",
  "himself",
  "gentleman",
  "father",
  "dad",
  "brother",
  "son",
  "husband",
  "boyfriend",
];

/** Words that say a PERSON is in frame at all — including the parts of one. */
const PERSON_WORDS: readonly string[] = [
  "athlete",
  "athletes",
  "player",
  "players",
  "woman",
  "women",
  "girl",
  "girls",
  "she",
  "her",
  "hers",
  "herself",
  "female",
  "person",
  "people",
  "someone",
  "figure",
  "silhouette",
  "hand",
  "hands",
  "arm",
  "arms",
  "leg",
  "legs",
  "foot",
  "feet",
  "face",
  "body",
  "runner",
  "goalkeeper",
  "keeper",
  "striker",
  "defender",
  "coach",
  "kid",
  "child",
  "teammate",
  "teammates",
  "team",
  "crowd",
  "fans",
  "subject",
  "model",
  "individual",
  "lady",
  "portrait",
  "selfie",
  "posing",
  "poses",
  "smiling",
  "smiles",
  ...MALE_WORDS,
];

/** Words that say the person is HER — or at least a woman or an athlete, which the tagger never distinguishes from her. */
const HER_WORDS: readonly string[] = [
  "she",
  "her",
  "hers",
  "herself",
  "woman",
  "women",
  "girl",
  "girls",
  "female",
  "athlete",
  "athletes",
  "player",
  "players",
];

/**
 * ⚠️ EVAL-DERIVED HEURISTIC (see the header). Capitalised words that begin or end a place, an
 * organisation or a phrase rather than a name — a bigram holding one is not a person.
 */
const NAME_STOPLIST: ReadonlySet<string> = new Set(
  [
    "Team",
    "USA",
    "US",
    "UK",
    "CGI",
    "AI",
    "New",
    "San",
    "Los",
    "Las",
    "Santa",
    "St",
    "Saint",
    "Mount",
    "Lake",
    "North",
    "South",
    "East",
    "West",
    "Golden",
    "World",
    "Champions",
    "Premier",
    "National",
    "Olympic",
    "Olympics",
    "Cup",
    "League",
    "University",
    "College",
    "Stadium",
    "Arena",
    "Park",
    "Field",
    "Center",
    "Centre",
    "The",
    "A",
    "An",
    "Two",
    "Three",
    "Close",
    "Still",
    "Professional",
    "Instagram",
    "TikTok",
    "YouTube",
  ].map((w) => w.toLowerCase()),
);

const MALE = bounded(MALE_WORDS);
const PERSON = bounded(PERSON_WORDS);
const HER = bounded(HER_WORDS);

/** A quoted span — 'like this' or "like this" — is a logo, a sign, a jersey. Removed before names are read. */
const QUOTED = /(['"“”‘’])[^'"“”‘’]{1,80}\1|['"“”‘’][^'"“”‘’]{1,80}['"“”‘’]/g;

/** Two consecutive Capitalised tokens — letters, apostrophes and hyphens; accents welcome. */
const BIGRAM =
  /(?<![\p{L}\p{N}])(\p{Lu}[\p{L}'’-]+)\s+(\p{Lu}[\p{L}'’-]+)(?![\p{L}\p{N}])/gu;

const allCaps = (w: string): boolean => w === w.toUpperCase();

/** The person-name bigrams a description holds — after the exceptions the header lists. */
export function namedPeople(
  description: string,
  brandsVisible: readonly string[],
): string[] {
  const brands = brandsVisible.map(normalizeBrandName).filter(Boolean);
  const inBrand = (w: string) => {
    const n = normalizeBrandName(w);
    return n.length > 0 && brands.some((b) => ` ${b} `.includes(` ${n} `));
  };
  const text = description.replace(QUOTED, " ");
  const out: string[] = [];
  for (const m of text.matchAll(BIGRAM)) {
    const [, a, b] = m;
    if (allCaps(a) && allCaps(b)) continue;
    if (
      NAME_STOPLIST.has(a.toLowerCase()) ||
      NAME_STOPLIST.has(b.toLowerCase())
    )
      continue;
    if (inBrand(a) || inBrand(b)) continue;
    out.push(`${a} ${b}`);
  }
  return out;
}

/** The text the verdict is read from: the whole-clip line, then each beat's own line. */
function textOf(vision: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof vision.description === "string") parts.push(vision.description);
  if (Array.isArray(vision.beats))
    for (const b of vision.beats)
      if (b && typeof b === "object") {
        const d = (b as Record<string, unknown>).description;
        if (typeof d === "string") parts.push(d);
      }
  return parts.join(" ");
}

/**
 * Who the tagger's words say is in the frame. Consulted only where a row claims her — a row the
 * tagger already said she is absent from needs no second opinion, and an untagged row has no words.
 */
export function subjectOf(vision: Record<string, unknown> | null): Subject {
  if (!vision || vision.athlete_present !== true) return "her";
  const text = textOf(vision);
  if (!text.trim()) return "her";
  const brands = Array.isArray(vision.brands_visible)
    ? vision.brands_visible.filter((b): b is string => typeof b === "string")
    : [];
  if (MALE.test(text)) return "other";
  if (namedPeople(text, brands).length > 0) return "other";
  if (!PERSON.test(text)) return "nobody";
  if (!HER.test(text)) return "nobody";
  return "her";
}
