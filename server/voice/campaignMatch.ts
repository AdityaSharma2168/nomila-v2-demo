/**
 * campaignMatch.ts — "which deal did they mean?" when they named the CAMPAIGN.
 *
 * The matching rule behind the campaign fallback in ./dealResolver. It lives
 * beside that module because the rule is the part with the sharp edges, and it
 * is testable without a database.
 *
 * ── The gap this closes ───────────────────────────────────────────────────────
 * Every deal lookup we had was keyed on BRAND NAME. An athlete who asks "are
 * there any deals about a FIFA World Cup campaign?" has named no brand at all —
 * so a brand lookup, which compares name-shaped strings, finds nothing, and
 * ./dealBriefRoute answers `notCached`, which the worker is
 * instructed to speak as "you have no deal with them". That answer was WRONG on
 * live data: the deal exists, stored under brand_name "Tec-Do" (the agency), and
 * the words "FIFA" and "World Cup" appear only in the thread's subject, the
 * thread's summary, and the classifier's own summary of it.
 *
 * ── Why STRICT, and what strict costs ─────────────────────────────────────────
 * Every content word the athlete said must appear. Not most, not the best
 * overlap, not a score above a threshold — all of them.
 *
 * The reason is asymmetric harm. A miss costs a turn: she says she doesn't have
 * it, the athlete rephrases. A WRONG match costs a confident brief about the
 * wrong deal — the money, the fit and the recommendation all belonging to a deal
 * the athlete wasn't asking about, delivered in the same voice as a right one.
 * There is no cheap way for the athlete to detect it. So this rule is built to
 * miss rather than to guess, and the looser variants (stemming, synonyms, edit
 * distance, partial overlap) are deliberately absent.
 *
 * Live evidence that strict is enough AND that it discriminates: the athlete
 * holds both the Tec-Do deal above and a separate deal whose brand_name is
 * literally "Poke World Cup". "FIFA World Cup" requires {fifa, world, cup} and
 * lands on Tec-Do alone, because the Poke deal's text never says FIFA. The
 * looser "the World Cup deal" requires {world, cup} and legitimately hits both —
 * which is a tie, and a tie is a question, not an answer. See ./dealResolver.
 *
 * ── The guard that matters most ───────────────────────────────────────────────
 * An empty content set NEVER matches. "The deal", "that campaign", "it" are all
 * scaffolding with no identity in them, and a rule of the form "every content
 * word is present" is vacuously true for zero content words — which would select
 * every deal the athlete has and hand back the first one. On the athlete this
 * was traced against, that is 185 deals. `matchesAll` refuses an empty set
 * explicitly rather than relying on the caller to check.
 *
 * TRUST: the phrase is MODEL-SUPPLIED free text derived from speech, and the
 * haystack is BRAND-AUTHORED email text (subject, thread summary, classifier
 * summary). Neither is trusted and neither is ever returned by this module — it
 * answers a boolean. What crosses back to the worker from the resolver above it
 * is a dealId and a brand name, both of which already cross today. No email text
 * enters the model's context through this path; ./threadRoutes stays the only
 * door for that, and it is still opened deliberately and once.
 */

/**
 * Words that never identify a campaign.
 *
 * Two groups, and the second is the one that does the work. The first is the
 * ordinary closed class — articles, prepositions, auxiliaries, pronouns. The
 * second is DEAL SCAFFOLDING: the words an athlete uses to ask about a deal at
 * all. "Are there any deals about a FIFA World Cup campaign" is seven scaffolding
 * words wrapped around three real ones, and if "deal" or "campaign" counted as
 * identity the phrase would only match a thread that happened to use those words
 * too.
 *
 * Kept deliberately short. Every word added here is a word the athlete can no
 * longer search on, so this is a list of things that cannot possibly name a
 * campaign, not a list of things that usually don't.
 */
const STOPWORDS = new Set([
  // Articles, conjunctions, prepositions.
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "from",
  "with",
  "about",
  "by",
  "as",
  "into",
  "over",
  "under",
  // Determiners and quantifiers.
  "any",
  "some",
  "this",
  "that",
  "these",
  "those",
  "all",
  "both",
  "each",
  "every",
  "no",
  "none",
  "other",
  "another",
  "same",
  // Pronouns and possessives.
  "i",
  "me",
  "my",
  "mine",
  "we",
  "us",
  "our",
  "ours",
  "you",
  "your",
  "yours",
  "he",
  "him",
  "his",
  "she",
  "her",
  "hers",
  "it",
  "its",
  "they",
  "them",
  "their",
  "theirs",
  "who",
  "whom",
  "whose",
  "which",
  "what",
  // Auxiliaries and common verbs of asking.
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "will",
  "would",
  "should",
  "there",
  "here",
  "get",
  "got",
  "tell",
  "know",
  "show",
  "find",
  "look",
  "see",
  "say",
  // ── Deal scaffolding. See the docblock. ────────────────────────────────────
  "deal",
  "deals",
  "campaign",
  "campaigns",
  "offer",
  "offers",
  "brand",
  "brands",
  "thing",
  "things",
  "one",
  "ones",
  "something",
  "anything",
]);

/** Tokens shorter than this carry no identity ("POPMART x You" — the x). */
const MIN_TOKEN_LENGTH = 2;

/**
 * Lowercase, strip everything that isn't a letter or digit, split.
 *
 * Punctuation becomes a SEPARATOR rather than being deleted, so "reaction-video"
 * tokenizes to two words instead of welding into one. Digits survive: "F1" and
 * "2026" can be the whole identity of a campaign.
 */
function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * The words in what the athlete said that could actually name something.
 *
 * Returns an empty array for a phrase made entirely of scaffolding, which
 * `matchesAll` treats as unmatchable — see the docblock.
 */
export function contentWords(phrase: string): string[] {
  return tokenize(phrase).filter(
    (t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t),
  );
}

/**
 * One deal's searchable text, as a token set.
 *
 * The sources are UNIONED rather than searched separately because the campaign
 * nouns are split across them in practice: on the live Tec-Do deal, the thread
 * subject says "World Cup Final" and only the summary says "FIFA". Searching
 * either alone misses the exact phrase the athlete used.
 *
 * Nulls are skipped rather than coerced — an absent summary is not an empty one.
 */
export function haystackOf(
  sources: (string | null | undefined)[],
): Set<string> {
  const tokens = new Set<string>();
  for (const source of sources) {
    if (typeof source !== "string") continue;
    for (const token of tokenize(source)) tokens.add(token);
  }
  return tokens;
}

/**
 * Every content word present in the haystack — whole tokens, never substrings.
 *
 * Whole-token is load-bearing: with substring matching, "cup" would be satisfied
 * by "cupcake" and short content words would match almost anything, which is the
 * mis-resolution this rule exists to avoid.
 *
 * An empty `words` returns FALSE, explicitly. See the docblock — this is the
 * guard that stops a scaffolding-only phrase from selecting every deal.
 */
export function matchesAll(words: string[], haystack: Set<string>): boolean {
  if (words.length === 0) return false;
  return words.every((w) => haystack.has(w));
}
