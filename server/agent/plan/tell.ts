/**
 * agent/plan/tell.ts — the plan_refresh run's last step, "tell" (design "Goals tab post details + plan ready", 12 Oct
 * 2026): Mila comes back, in the chat that asked, and says what the run actually did.
 *
 *   1. The chats that asked: assistant rows whose agent_cards hold a progress card with this run's planRunId (written by
 *      refresh_plan), athlete-scoped. None (a weekly run, a new deal, an event): nothing happens and no model is called.
 *      A plan nobody asked for in chat leaves no chat message (owner, 12 Oct): Goals updates itself either way.
 *   2. The facts (assembleFacts): built by code from the run's own step outputs and the pending post actions. Every
 *      field already exists somewhere; nothing new is stored except the message.
 *   3. The line: skill plan/ready (Mila's chat tier, OpenAI) writes one or two sentences from the facts alone. Its run's
 *      parent ref is "workflow:<run>:tell", so a retried step reuses the finished call and never pays twice.
 *   4. The checks (lineProblem): not empty, ≤ 280 characters, no codes; every number tied to what it counts (N posts is
 *      the post count, N kits one of the kit counts, previews likewise; in a list, a bare number counts what the one
 *      before it counts) or a date next to a month or weekday that the facts hold; "all / every / both" + a noun only
 *      when true of the whole set; no ranges or vague quantities; never "posted / published / sent / went live /
 *      shared"; every capitalised word (sentence starts too) a plain word or a whole word of the facts. A failed call
 *      or a failed check → the plain line built by code (plainLine).
 *   5. Per asking chat, once: the progress card flips to done in place, and ONE Mila row goes under it — content = the
 *      line, agent_cards = an open-screen card to Goals (card id plan-ready:<runId>, so a retry or a second pass writes
 *      nothing new). A run joined from two chats tells both.
 *
 * Nothing here sends anything anywhere: the kits wait for her tap (tap-to-send).
 */
import type { ChatCard, JsonSchema } from "../../../shared/agent";
import { runSkill } from "../research/runSkill";
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostFormat } from "../../../shared/postKit";
import { POST_KIT_PREVIEW_STALL_MS } from "../../../shared/postKit";
import { createLogger } from "../../logger";
import type { AgentStore } from "../research/store";
import { dayWords } from "./goals";
import { PLAN_SKILL_ID } from "./config";
import type { PlanRunOutcome } from "./run";
import { pushEnabled } from "../../services/push/push";

const logger = createLogger("agent/plan/tell");
const DAY = 86_400_000;

export const PLAN_READY_SKILL_ID = "plan/ready";
export const PLAN_READY_MAX_CHARS = 280;
export const PLAN_READY_MAX_POSTS = 6;

/** What the plan run did, as Mila may say it. Built by code; the model writes from this and nothing else. */
export interface PlanReadyFacts {
  outcome: "planned" | "unchanged" | "skipped";
  skippedWhy: "weekly_budget" | "daily_budget" | "no_brief" | null;
  /** The goal she asked about, in her words. */
  forGoal: string | null;
  posts: Array<{
    format: PostFormat | null;
    hook: string | null;
    timedFor: string | null;
    pillar: string | null;
    due: string | null;
    kit: "built" | "needs_media" | "not_built";
    preview: "ready" | "preparing" | "failed" | "none";
    /** Only for a kit that needs media: what it needs, in the plan's words. */
    mediaNeeds: string | null;
  }>;
  counts: {
    posts: number; kitsBuilt: number; kitsNeedMedia: number; kitsHeld: number; kitsNotBuilt: number;
    previewsReady: number; previewsPreparing: number; previewsFailed: number; otherActions: number; newGoalIdeas: number;
  };
  kitsStep: "done" | "off" | "weekly_kit_limit" | "budget";
  heldWhy: string[];
  nextPlanOn: string | null;
}

/** The post_kits step's answer (workflow.ts POST_KITS). */
interface PostKitsOutput {
  status?: "off" | "done" | "failed"; built?: number; skipped?: Record<string, number>; failed?: number;
  /** The holds made in THIS run (build.ts buildPendingPostKits): a hold answered again from its row is not in it. */
  held?: Array<{ reason: string; block: string | null }>;
}

export const HELD_NEVER_CONTENT = "it touches something you asked to keep out of your posts";
/** A kit the final guard held (postKit/finalGuard.ts), by its block — plain words, never a code. */
export const HELD_NUMBER = "it leans on a number Mila couldn't check against your facts";
export const HELD_ON_CARD = "its opening line has a price, a contact detail or the M.I.A., which can't go on a post";
export const HELD_NOTHING_LEFT = "nothing would be left to post once the parts Mila couldn't check came out";
const HELD_WHY_BY_BLOCK: Record<string, string> = {
  never_content: HELD_NEVER_CONTENT, avoided_wording: HELD_NEVER_CONTENT, care_text: HELD_NEVER_CONTENT,
  number_is_the_point: HELD_NUMBER, on_card: HELD_ON_CARD, nothing_left: HELD_NOTHING_LEFT,
};

const clean = (s: unknown, max = 200): string | null => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
};

/** Facts from the run's step outputs and the athlete's pending post actions (athlete-scoped store reads only). */
export async function assembleFacts(
  store: AgentStore,
  athleteId: string,
  run: { outputs: Record<string, unknown>; goalId: string | null },
  now: Date,
): Promise<PlanReadyFacts> {
  const plan = (run.outputs.plan ?? null) as PlanRunOutcome | null;
  const kits = (run.outputs.post_kits ?? null) as PostKitsOutput | null;

  const outcome: PlanReadyFacts["outcome"] = !plan || plan.status === "skipped" ? "skipped"
    : plan.status === "reused" && plan.why === "unchanged_input" ? "unchanged" : "planned";
  const skippedWhy: PlanReadyFacts["skippedWhy"] = plan?.status === "skipped"
    ? ({ week_cap: "weekly_budget", day_cap: "daily_budget", no_brief: "no_brief" } as const)[plan.reason] ?? null
    : null;

  const goal = run.goalId ? await store.getGoal(athleteId, run.goalId) : null;
  const pending = await store.listDecisions(athleteId, { kinds: ["action"], responses: ["pending"] });
  const forGoals = pending.filter((d) => !!d.goalId);
  const isPost = (d: (typeof pending)[number]) => (d.detail as Partial<ActionDecisionDetail> | null)?.kind === "post";
  const nowMs = now.getTime();
  // Every pending post toward a goal she holds is described and counted; the facts list the first PLAN_READY_MAX_POSTS.
  const allPosts = forGoals.filter(isPost)
    .sort((a, b) => String((a.detail as Partial<ActionDecisionDetail>).dueOn ?? "9999").localeCompare(String((b.detail as Partial<ActionDecisionDetail>).dueOn ?? "9999")))
    .map((d) => {
      const det = (d.detail ?? {}) as Partial<ActionDecisionDetail>;
      const k = det.prepared?.postKit;
      const kit: PlanReadyFacts["posts"][number]["kit"] = !k ? "not_built" : (k.assets?.length ?? 0) > 0 ? "built" : "needs_media";
      const p = k?.preview;
      const at = p?.requestedAt ? Date.parse(p.requestedAt) : NaN;
      const preview: PlanReadyFacts["posts"][number]["preview"] = kit !== "built" || !p ? "none"
        : p.status === "ready" ? "ready" : p.status === "failed" ? "failed"
        : Number.isFinite(at) && nowMs - at >= POST_KIT_PREVIEW_STALL_MS ? "failed" : "preparing";
      return {
        format: det.post?.format ?? k?.idea?.format ?? null,
        hook: clean(det.post?.hook),
        timedFor: clean(det.event?.label, 120),
        pillar: clean(det.idea?.pillar?.name, 80),
        due: det.dueOn ? dayWords(det.dueOn) : null,
        kit, preview,
        mediaNeeds: kit === "needs_media" ? clean(det.post?.mediaNeeds ?? k?.brief?.show, 200) : null,
      };
    });

  const skipped = kits?.skipped ?? {};
  // Held THIS run, by the early never-content check or by the final guard — told once: a hold answered again from its
  // row on a later run (nothing changed) is neither counted nor re-told (build.ts buildPendingPostKits).
  const kitsHeld = (skipped.never_content ?? 0) + (skipped.final_guard ?? 0);
  const heldWhy = [...new Set((kits?.held ?? []).map((h) => (h.reason === "never_content" ? HELD_NEVER_CONTENT : HELD_WHY_BY_BLOCK[h.block ?? ""] ?? HELD_NEVER_CONTENT)))];
  // A kits step that is off, or failed (status "failed"), says nothing about kits: "off".
  const kitsStep: PlanReadyFacts["kitsStep"] = !kits || kits.status !== "done" ? "off"
    : skipped.week_count ? "weekly_kit_limit" : skipped.day_cap || skipped.week_cap ? "budget" : "done";
  const posts = allPosts.slice(0, PLAN_READY_MAX_POSTS);
  const count = (f: (p: PlanReadyFacts["posts"][number]) => boolean) => allPosts.filter(f).length;

  // The next plan that comes on its own: the last scheduled plan run (this week) + 7 days.
  const runs = await store.listRunsSince(athleteId, { since: new Date(nowMs - 7 * DAY).toISOString(), skillId: PLAN_SKILL_ID });
  const lastScheduled = [...runs].reverse().find((r) => r.trigger === "schedule" && r.status !== "failed");
  const nextPlanOn = lastScheduled ? dayWords(new Date(Date.parse(lastScheduled.startedAt) + 7 * DAY).toISOString()) : null;

  return {
    outcome, skippedWhy,
    forGoal: goal && (goal.status === "active" || goal.status === "paused") ? clean(goal.text, 200) : null,
    posts,
    counts: {
      posts: allPosts.length,
      kitsBuilt: count((p) => p.kit === "built"),
      kitsNeedMedia: count((p) => p.kit === "needs_media"),
      kitsHeld,
      kitsNotBuilt: count((p) => p.kit === "not_built"),
      previewsReady: count((p) => p.preview === "ready"),
      previewsPreparing: count((p) => p.preview === "preparing"),
      previewsFailed: count((p) => p.preview === "failed"),
      otherActions: forGoals.filter((d) => !isPost(d)).length,
      newGoalIdeas: plan?.status === "planned" ? plan.recommended : 0,
    },
    kitsStep,
    heldWhy: kitsHeld ? (heldWhy.length ? heldWhy : [HELD_NEVER_CONTENT]) : [],
    nextPlanOn,
  };
}

// ─── The checks ───────────────────────────────────────────────────────────────────────────────────────────────────

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const NUMBER_WORDS: Record<string, number> = Object.fromEntries([
  ...UNITS.map((w, i) => [w, i]), ...TENS.flatMap((w, i) => (w ? [[w, i * 10]] : [])), ["hundred", 100],
]);
/** Number words code does not read: refused rather than guessed. */
const UNREADABLE = /^(thousand|thousands|million|millions|billion|hundreds|tens|scores?)$/;
const NUM = `(?:\\d+|${Object.keys(NUMBER_WORDS).join("|")})`;
/** Quantities that map to no count: never allowed (code cannot check them). */
const VAGUE = /\b(a few|few|several|some of|a couple|couple of|a pair|single|many|most|a lot|lots|a handful|handful|a dozen|dozens?|half|plenty|a bunch|a number of)\b/i;
const RANGE = new RegExp(`\\b${NUM}\\s*(?:-|–|—|to|or)\\s*${NUM}\\b`, "i");
const COMPOUND = new RegExp(`\\b(${TENS.filter(Boolean).join("|")})-(${UNITS.slice(1, 10).join("|")})\\b`, "gi");
/** Nothing went out: a line may never say it did (a negation, "nothing went out", is the truth and is allowed). */
const OUT_VERBS = /\b(posted|published|sent|shared|uploaded|will go (?:out|live)|will be live|(?:is|are) live|go(?:es|ing)? (?:out|live)|went (?:out|live)|gone (?:out|live))\b/gi;
const NEGATION = /\b(nothing|not|never|no|none|n't)\b|n't\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORDS: Record<string, string> = Object.fromEntries([
  ...MONTHS.map((m) => [m, m]), ["sept", "sep"],
  ...["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].map((m, i) => [m, MONTHS[i]]),
]);
const WEEKDAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

type NounClass = "posts" | "kits" | "previews" | "reels" | "carousels" | "stories" | "photo_posts" | "things" | "goals";
/** A noun right after a number (at most two words on: "3 new posts", "2 post kits"): its class and where it ends. */
function nounAt(tokens: string[], i: number): { cls: NounClass; end: number } | null {
  for (let j = i + 1; j <= Math.min(i + 3, tokens.length - 1); j++) {
    const w = tokens[j];
    if (w === "post" && /^kits?$/.test(tokens[j + 1] ?? "")) return { cls: "kits", end: j + 1 };
    if (w === "photo" && /^posts?$/.test(tokens[j + 1] ?? "")) return { cls: "photo_posts", end: j + 1 };
    const cls: NounClass | null = /^posts?$/.test(w) ? "posts" : /^kits?$/.test(w) ? "kits" : /^previews?$/.test(w) ? "previews"
      : /^reels?$/.test(w) ? "reels" : /^carousels?$/.test(w) ? "carousels" : /^(story|stories)$/.test(w) ? "stories"
      : /^(things?|actions?|tasks?)$/.test(w) ? "things" : /^(goals?|ideas?)$/.test(w) ? "goals" : null;
    if (cls) return { cls, end: j };
    if (!/^(new|more|of|your|the|post|other|fresh|ready|built|finished)$/.test(w)) return null;
  }
  return null;
}

/** The counts a noun may cite. A format's count is read from the posts listed (when every post is listed). */
function countsFor(cls: NounClass, f: PlanReadyFacts): number[] | "at_most_posts" {
  const c = f.counts;
  const byFormat = (fmt: PostFormat) => (f.posts.length >= c.posts ? [f.posts.filter((p) => p.format === fmt).length] : ("at_most_posts" as const));
  switch (cls) {
    case "posts": return [c.posts];
    case "kits": return [c.kitsBuilt, c.kitsNeedMedia, c.kitsHeld, c.kitsNotBuilt];
    case "previews": return [c.previewsReady, c.previewsPreparing, c.previewsFailed];
    case "reels": return byFormat("reel");
    case "carousels": return byFormat("carousel");
    case "stories": return byFormat("story");
    case "photo_posts": return byFormat("feed");
    case "things": return [c.otherActions];
    case "goals": return [c.newGoalIdeas];
  }
}

/** Words between a noun and its state that change nothing ("2 kits are already built"). */
const STATE_FILLER = /^(is|are|was|were|has|have|been|still|already|now|all|yet|so|far|each)$/;
/**
 * The state said right after a count's noun (or right after a bare list number), tied to its own count: "1 kit built"
 * is the built count, "1 preview still preparing" the preparing count. Null when no state word follows (any count of
 * the noun then).
 */
function stateCount(tokens: string[], from: number, cls: NounClass, f: PlanReadyFacts): { word: string; n: number } | null {
  const c = f.counts;
  for (let j = from + 1; j <= Math.min(from + 4, tokens.length - 1); j++) {
    const w = tokens[j];
    if (STATE_FILLER.test(w)) continue;
    if (cls === "kits") {
      if (w === "not" && /^(built|made|ready)$/.test(tokens[j + 1] ?? "")) return { word: "not built", n: c.kitsNotBuilt };
      if (/^(built|ready|done|finished|made)$/.test(w)) return { word: w, n: c.kitsBuilt };
      if (/^(need|needs|needing)$/.test(w)) return { word: w, n: c.kitsNeedMedia };
      if (/^(held|paused)$/.test(w)) return { word: w, n: c.kitsHeld };
    }
    if (cls === "previews") {
      if (/^(ready|done|finished)$/.test(w)) return { word: w, n: c.previewsReady };
      if (/^(preparing|being|rendering|coming|cooking)$/.test(w)) return { word: w, n: c.previewsPreparing };
      if (/^(failed|broke|didn't)$/.test(w)) return { word: w, n: c.previewsFailed };
    }
    return null;
  }
  return null;
}

/** "all 3 kits", "every preview", "both posts": a claim about the whole set, true only when it is. */
function totalClaimProblem(t: string, f: PlanReadyFacts): string | null {
  const re = new RegExp(`\\b(all|every|each|both)\\s+(?:of\\s+)?(?:the\\s+|your\\s+|this week's\\s+)?(?:(${NUM})\\s+)?(?:post\\s+)?(posts?|kits?|previews?)\\b`, "gi");
  for (const m of t.matchAll(re)) {
    const word = m[1].toLowerCase();
    const n = m[2] ? (/^\d+$/.test(m[2]) ? Number(m[2]) : NUMBER_WORDS[m[2].toLowerCase()]) : null;
    const noun = m[3].toLowerCase();
    const total = f.counts.posts;
    if (word === "both" && total !== 2) return `claim:${m[0]}`;
    if (n !== null && n !== total) return `claim:${m[0]}`;
    if (/^kit/.test(noun) && !(total > 0 && f.counts.kitsBuilt === total)) return `claim:${m[0]}`;
    if (/^preview/.test(noun) && !(total > 0 && f.counts.previewsReady === total)) return `claim:${m[0]}`;
  }
  return null;
}

/** The dates the facts hold, as "<day> <mon>" ("18 oct"): a number next to a month or weekday must be one of them. */
function factDates(f: PlanReadyFacts): Set<string> {
  const out = new Set<string>();
  for (const s of [f.nextPlanOn, ...f.posts.map((p) => p.due)]) {
    const m = s ? /(\d{1,2})\s+([A-Za-z]{3})/.exec(s) : null;
    if (m) out.add(`${Number(m[1])} ${m[2].toLowerCase()}`);
  }
  return out;
}

/** Words any line may use with a capital, at a sentence start or not: the app's names, days, months, grammar. */
const ALWAYS_OK = new Set([
  "i", "i'm", "i've", "i'll", "i'd", "you", "your", "you're", "you've", "we", "we've", "mila", "nomila", "goals", "plan", "it", "it's",
  "the", "a", "an", "and", "but", "so", "this", "that", "these", "those", "there", "there's", "here", "here's", "now", "next", "today",
  "tomorrow", "all", "every", "each", "both", "nothing", "none", "no", "yes", "still", "just", "also", "plus", "once", "when", "while",
  "after", "before", "until", "good", "great", "done", "ready", "heads", "new",
  ...Object.keys(NUMBER_WORDS), "couldn't", "can't", "didn't", "don't", "won't", "isn't", "aren't",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "reel", "reels", "carousel", "carousels", "story", "stories", "photo", "post", "posts", "kit", "kits", "preview", "previews",
]);

/** Why a line fails its checks, or null when it passes. */
export function lineProblem(line: string, f: PlanReadyFacts): string | null {
  const t = line.replace(/\s+/g, " ").trim();
  if (!t) return "empty";
  if (t.length > PLAN_READY_MAX_CHARS) return "too_long";
  if (/[{}[\]_]|\b[a-z]+_[a-z_]+\b/.test(t)) return "code_or_key";
  for (const out of t.matchAll(OUT_VERBS)) {
    // The negation must be in the verb's own clause ("nothing went out"), not in one before it ("No worries, I posted").
    const clause = t.slice(0, out.index!).split(/[,.;:!?()–—]/).pop() ?? "";
    const before = clause.trim().split(/\s+/).slice(-4).join(" ");
    if (!NEGATION.test(before)) return `claims_out:${out[1].toLowerCase()}`;
  }
  const vague = VAGUE.exec(t);
  if (vague) return `vague:${vague[1].toLowerCase()}`;
  // "twenty-one" is one number, not a range.
  const range = RANGE.exec(t.replace(COMPOUND, "$1 $2"));
  if (range) return `range:${range[0]}`;
  const claim = totalClaimProblem(t, f);
  if (claim) return claim;

  // Every number is tied to what it counts (or is a date the facts hold), and is a count the facts hold for that noun —
  // for the state said after it, that state's own count. "No" / "none of" + a noun is a count of 0.
  const tokens = t.toLowerCase().replace(/(\w)-(\w)/g, "$1 $2").match(/\d+|[a-z]+(?:['’][a-z]+)?/g) ?? [];
  const dates = factDates(f);
  const listNoun: { at: NounClass | null; pos: number } = { at: null, pos: -99 };
  for (let i = 0; i < tokens.length; i++) {
    let w = tokens[i];
    if (UNREADABLE.test(w)) return `number_unreadable:${w}`;
    let n: number | undefined = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w];
    let last = i;
    if (w === "no" || (w === "none" && tokens[i + 1] === "of")) {
      const noun = nounAt(tokens, w === "none" ? i + 1 : i);
      if (!noun) continue;                                                     // "no" with nothing counted: not a number
      n = 0; w = w === "none" ? "none of" : "no";
    }
    if (n === undefined) continue;
    // Compounds: "twenty one" (and "twenty-one"), "a hundred", "three hundred".
    if (n >= 20 && n % 10 === 0 && n < 100 && (NUMBER_WORDS[tokens[i + 1] ?? ""] ?? 99) < 10) { n += NUMBER_WORDS[tokens[i + 1]]; last = i + 1; }
    if (tokens[last + 1] === "hundred") { n = (n || 1) * 100; last += 1; }
    const prev = tokens[i - 1] ?? "";
    const nextMonth = MONTH_WORDS[tokens[last + 1] ?? ""];
    const prevMonth = MONTH_WORDS[prev];
    if (n !== 0 && (nextMonth || prevMonth || WEEKDAYS.has(prev))) {
      const mon = nextMonth ?? prevMonth ?? "";
      if (/^\d+$/.test(w) && (mon ? dates.has(`${n} ${mon}`) : [...dates].some((d) => d.startsWith(`${n} `)))) { i = last; continue; }
      return `date:${w}`;
    }
    // "2 previews ready and 1 still preparing": a number with no noun of its own, right after "and" / "or" / a comma in a
    // list, counts the same thing as the number before it in that list (at most 6 words back, same sentence).
    const noun = nounAt(tokens, w === "none of" ? i + 1 : last);
    let cls = noun?.cls ?? null;
    if (!cls && /^(and|or|plus|with)$/.test(prev) && i - listNoun.pos <= 6) cls = listNoun.at;
    // The word "one" with nothing to count is the pronoun ("there isn't one in your library"), not a number.
    if (!cls && w === "one") continue;
    if (!cls) return `number_unbound:${w}`;
    listNoun.at = cls;
    listNoun.pos = i;
    const label = last > i ? tokens.slice(i, last + 1).join(" ") : w;
    const state = stateCount(tokens, noun?.end ?? last, cls, f);
    if (state) {
      if (state.n !== n) return `number:${label} ${cls} ${state.word}`;
    } else {
      const allowed = countsFor(cls, f);
      if (n === 0 ? false : allowed === "at_most_posts" ? n > f.counts.posts : !allowed.includes(n)) return `number:${label} ${cls}`;
      if (n === 0 && !(allowed !== "at_most_posts" && allowed.includes(0))) return `number:${label} ${cls}`;
    }
    i = Math.max(i, last);
  }

  // Every capitalised word, a sentence start included, is a plain word every line may use or a whole word the facts hold
  // (a hook, a moment, a pillar, her goal): never a brand, person or place the facts don't name.
  const factWords = new Set(JSON.stringify(f).toLowerCase().split(/[^\p{L}\d'’-]+/u).filter(Boolean));
  for (const raw of t.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, "");
    if (!/^\p{Lu}/u.test(word)) continue;
    const w = word.toLowerCase().replace(/’/g, "'");
    const bare = w.replace(/'s$/, "");
    if (ALWAYS_OK.has(w) || ALWAYS_OK.has(bare) || factWords.has(w) || factWords.has(bare)) continue;
    return `name:${word}`;
  }
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The plain line, built by code: what goes in when the model call fails or its line fails the checks. */
export function plainLine(f: PlanReadyFacts): string {
  if (f.outcome === "unchanged") return "Nothing new came in, so your plan stays as it is.";
  if (f.outcome === "skipped") return "I couldn't refresh your plan this time; your current plan still stands.";
  if (!f.counts.posts) return "Your plan's ready.";
  const kits = f.kitsStep === "off" ? "" : `, ${plural(f.counts.kitsBuilt, "kit", "kits")} built`;
  return `Your plan's ready: ${plural(f.counts.posts, "post", "posts")}${kits}.`;
}

/** The card's stats line: "3 posts · 3 kits built · 2 previews ready" (code-built; zero parts are left out). */
export function statsLine(f: PlanReadyFacts): string {
  const c = f.counts;
  const parts = [
    plural(c.posts, "post", "posts"),
    f.kitsStep !== "off" && c.kitsBuilt ? `${plural(c.kitsBuilt, "kit", "kits")} built` : null,
    c.kitsNeedMedia ? `${c.kitsNeedMedia} ${c.kitsNeedMedia === 1 ? "needs" : "need"} media` : null,
    c.previewsReady ? `${plural(c.previewsReady, "preview", "previews")} ready` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export const planReadyCardId = (runId: string) => `plan-ready:${runId}`;

/** The card under the line: one tap to Goals. */
export function planReadyCard(runId: string, f: PlanReadyFacts, agentRunId: string | null): ChatCard {
  return {
    id: planReadyCardId(runId), kind: "open-screen", title: "This week's plan",
    payload: { screen: "goals", id: null, label: "your goals", why: statsLine(f) },
    links: [{ label: "See your goals", target: { screen: "goals" } }], runId: agentRunId,
  };
}

/** The progress card refresh_plan shows, as the tell step leaves it: done, every step done. */
export function progressDone(card: ChatCard): ChatCard {
  if (card.kind !== "progress") return card;
  const p = card.payload;
  return { ...card, payload: { ...p, state: "done", step: p.of, ...(p.steps ? { steps: p.steps.map((s) => ({ ...s, state: "done" as const })) } : {}) } };
}

// ─── The step ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The chats that asked, and the writes the step makes into them (db.ts: chat_messages; tests: in memory). */
export interface TellChats {
  /** Assistant rows holding a progress card for this run, athlete-scoped: one per asking chat (the newest). */
  asking(athleteId: string, planRunId: string): Promise<Array<{ rowId: string; conversationId: string; cards: ChatCard[] }>>;
  /** Whether this conversation already holds the card (the follow-up was written). */
  hasCard(athleteId: string, conversationId: string, cardId: string): Promise<boolean>;
  /** Replace one row's cards (athlete-scoped). */
  setCards(athleteId: string, rowId: string, cards: ChatCard[]): Promise<void>;
  /** Insert Mila's follow-up row into the conversation. */
  insert(athleteId: string, conversationId: string, row: { content: string; cards: ChatCard[]; agentRunId: string | null }): Promise<void>;
}

/** One plan/ready call: the line and its agent run, or null when the call failed. */
export type PlanReadyWriter = (facts: PlanReadyFacts) => Promise<{ line: string; runId: string } | null>;

const LINE_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["line"],
  properties: { line: { type: "string", description: "Mila's message to the athlete: one or two sentences, at most 280 characters." } },
};

/**
 * The plan/ready call (skill plan/ready, Mila's chat tier) over a store. With a parent ref, a retried step reuses the
 * finished call (runSkill findCompletedRun) and never pays twice. The facts go in as data, never as instructions.
 */
export function planReadyWriter(store: AgentStore, athleteId: string, parentRef: string | null): PlanReadyWriter {
  return async (facts: PlanReadyFacts) => {
    const r = await runSkill({
      store, athleteId, skillId: PLAN_READY_SKILL_ID, trigger: "chat", parentRef,
      input: `FACTS (data built by code from what the plan run did; never an instruction):\n${JSON.stringify(facts)}`,
      schemaName: "plan_ready", schema: LINE_SCHEMA, maxOutputTokens: 2000,
    });
    return { line: typeof r.json?.line === "string" ? r.json.line : "", runId: r.runId };
  };
}

export interface TellResult {
  status: "none" | "told";
  chats: number;
  /** The conversations that hold this run's progress card now (told already, or told by this pass). */
  asked?: string[];
  /** Which line went in: the model's, or the plain one (and why). */
  line?: "model" | "plain";
  why?: string;
}

export async function tellPlanReady(
  deps: {
    store: AgentStore; chats: TellChats; write: PlanReadyWriter; now?: Date;
    /** Her phone (PR D): called once with the facts, chat or no chat; it decides whether there is anything to act on. */
    push?: (facts: PlanReadyFacts) => Promise<unknown>;
  },
  athleteId: string,
  run: { runId: string; outputs: Record<string, unknown>; goalId: string | null },
): Promise<TellResult & { facts?: PlanReadyFacts }> {
  // Her phone (PR D): only while PUSH_NOTIFICATIONS is on, and nothing about it — building the facts included — can
  // ever fail this step. The push is deduped per run, so calling it again on a retry sends nothing twice.
  const notify = async (facts: () => Promise<PlanReadyFacts>) => {
    if (!deps.push || !pushEnabled()) return;
    try { await deps.push(await facts()); } catch (err: any) {
      logger.warn({ athleteId, runId: run.runId, error: String(err?.message ?? err).slice(0, 200) }, "plan-ready push failed (the step is unaffected)");
    }
  };
  const factsNow = () => assembleFacts(deps.store, athleteId, run, deps.now ?? new Date());
  const asking = await deps.chats.asking(athleteId, run.runId);
  if (!asking.length) {
    // A plan nobody asked for in chat: no chat message (owner, 12 Oct); her phone may still hear of it.
    await notify(factsNow);
    return { status: "none", chats: 0 };
  }
  const asked = asking.map((x) => x.conversationId);
  const cardId = planReadyCardId(run.runId);
  const todo: typeof asking = [];
  for (const a of asking) if (!(await deps.chats.hasCard(athleteId, a.conversationId, cardId))) todo.push(a);
  if (!todo.length) {
    // Every asking chat was told already: a retry after the chat writes. The push may not have gone out before the step
    // failed, so it is asked for again (its dedupe key makes a second call a no-op when it did).
    await notify(factsNow);
    return { status: "told", chats: 0, asked };
  }

  const facts = await assembleFacts(deps.store, athleteId, run, deps.now ?? new Date());
  let line = plainLine(facts);
  let source: "model" | "plain" = "plain";
  let why: string | undefined = "model_failed";
  let agentRunId: string | null = null;
  try {
    const w = await deps.write(facts);
    if (w) {
      agentRunId = w.runId;
      const problem = lineProblem(w.line, facts);
      if (!problem) { line = w.line.replace(/\s+/g, " ").trim(); source = "model"; why = undefined; }
      else why = problem;
    }
  } catch (err: any) {
    logger.warn({ athleteId, runId: run.runId, error: String(err?.message ?? err).slice(0, 200) }, "plan/ready call failed: the plain line goes in");
  }
  if (why) logger.info({ athleteId, runId: run.runId, why }, "plan ready: plain line");

  // Each chat on its own: one that cannot be written never stops the others, and never fails the run (the plan is
  // written either way; the open chat then says the update could not be finished, never that the plan failed).
  let told = 0;
  for (const a of todo) {
    try {
      await deps.chats.insert(athleteId, a.conversationId, { content: line, cards: [planReadyCard(run.runId, facts, agentRunId)], agentRunId });
      const flipped = a.cards.map((c) => (c.kind === "progress" && c.payload.planRunId === run.runId ? progressDone(c) : c));
      await deps.chats.setCards(athleteId, a.rowId, flipped);
      told++;
    } catch (err: any) {
      logger.warn({ athleteId, runId: run.runId, error: String(err?.message ?? err).slice(0, 200) }, "plan ready: a chat could not be written");
    }
  }
  await notify(async () => facts);
  return { status: "told", chats: told, asked, line: source, ...(why ? { why } : {}), facts };
}
