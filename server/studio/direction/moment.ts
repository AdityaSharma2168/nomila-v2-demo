/**
 * studio/direction/moment — research_moment: a moment found live, mapped onto a BriefProposal, never
 * dated by the model (PR 7, Lane D, "live-no-date").
 *
 *   {ask, brand?, date?}  →  ONE OpenAI web search (agent/research/llm callStructured on the fast tier,
 *   one web_search call at low context, a strict JSON answer — the same call and cost path as research
 *   v2 discover; the one search provider, owner 4 Nov 2026)  →  {title, summary, angle, feeling, line,
 *   feel}  →  a brief whose `story` is the moment, its tone the moment's feel, a concept the plan call
 *   can ride — every one of those lines INFERRED with a because that names the sources the SEARCH saw.
 *
 * ─── WHAT IS HERS, WHAT IS THE SEARCH'S, WHAT IS NOBODY'S ────────────────────────────────────────────
 *
 *   the date        HERS or nobody's. `date` in the input is a line she typed; it becomes the one literal
 *                   line here — a `Timing:` constraint quoting her words — and `extras.moment.dateBasis`
 *                   says "hers". It also goes into the search turn in a clear form ("on 3 November
 *                   2026", momentPrompt momentDateLine) so the search finds that specific event; never
 *                   today's date. Without it: "none", the turn is as before, and a note says so. A date in the model's answer is
 *                   never read: the search does not date things reliably (Lane D recon: no provider
 *                   returns a structured date), and a wrong date on a plan is worse than none.
 *   the sources     the pages the search saw (url / title / domain), capped — never the model's claimed
 *                   links, which are not asked for and are ignored if offered. They ride on the brief
 *                   (extras.moment.sources) and the confirm step shows each as a clickable link: OpenAI's
 *                   terms ask for prominent, clickable citations wherever web results are shown.
 *   the moment      the model's reading of what it found — inferred, like every other tool's lines.
 *
 * ─── WHAT THIS NEVER TOUCHES ─────────────────────────────────────────────────────────────────────────
 *
 * The research team's ledger. Their nightly runs reserve every attempt against `research_budget_days`
 * (services/intelligence/research/ledger.ts) and this tool is not one of their runs: it imports the
 * agent's structured call and nothing from that lane — the tripwire forbids the ledger by name —
 * writes no row there, and logs its own cost on a Studio line, priced from the call's own usage by
 * agent/models costOf (tokens + the web search fee). The caps on it: one web_search call per ask
 * (max_tool_calls 1), a bounded answer, the direction timeout, the per-athlete `webSearchLimiter` Mila
 * shares (consulted before the call and recorded after it, so one athlete cannot run the search in a
 * loop), and the athlete's day cap: each search is an agent_runs row with its cost, the ledger runSkill
 * and Mila's turns write, and a search that would pass AGENT_DAY_COST_CAP_USD is refused before the call.
 *
 * ⚠️ MUTATIONS (routes.test + moment.test): read the model's `date` into the constraint — "a date is
 * hers or nobody's" reds; cite the model's `sources` — "the sources are the pages the search saw" reds;
 * skip the limiter — "over the window is a 429 and no call" reds; skip the day-cap check — "over the
 * day cap is a 429 and no call" reds; import `reserveLlmCall` — the
 * tripwire and "never touches the research ledger" both red.
 */
import { eq } from "drizzle-orm";
import { athletes } from "../../../shared/schema";
import { db } from "../../db";
import type { RunCost } from "../../../shared/agent";
import { AGENT } from "../../agent/config";
import { modelFor, webSearchCallMicroUsd, ZERO_COST } from "../../agent/models";
import { dbStore } from "../../agent/research/dbStore";
import { callStructured, ModelCallError } from "../../agent/research/llm";
import { spentTodayMicroUsd } from "../../agent/trace";
import { withTimeout } from "../../lib/withTimeout";
import { createLogger } from "../../logger";
import {
  webSearchLimiter,
  type WebSearchLimiter,
} from "../../mila/webSearchLimiter";
import { directionTimeoutMs, momentSearchEnabled } from "../config";
import { namesSport } from "../sportVocab";
import { buildBrief, type KeptLine } from "./brief";
import {
  MAX_ANGLE,
  MAX_BECAUSE,
  MAX_CONSTRAINT,
  MAX_FEELING,
  MAX_LINE,
  MAX_MOMENT_SOURCES,
  MAX_MOMENT_SUMMARY,
  MAX_MOMENT_TITLE,
  MAX_NOTE,
  validateBriefProposal,
  type BriefProposal,
  type InferenceFlag,
} from "./envelope";
import {
  MAX_ASK,
  MAX_BRAND,
  MAX_DATE,
  MOMENT_PROMPT_VERSION,
  MOMENT_SCHEMA,
  MOMENT_SYSTEM,
  momentQuery,
} from "./momentPrompt";
import { readReplyJson, type SummarizeCost } from "./summarize";
import { capTitle, capWords } from "../text";

const logger = createLogger("studio/direction/moment");

export interface MomentInput {
  ask: string;
  brand?: string | null;
  date?: string | null;
}

export type MomentRefusal =
  | "disabled"
  | "invalid_input"
  | "rate_limited"
  | "day_cap"
  | "model_failed"
  | "invalid_reply"
  | "nothing_found";

export type MomentResult =
  | {
      ok: true;
      proposal: BriefProposal;
      model: string;
      promptVersion: string;
      cost: SummarizeCost;
      /** What the provider cited, how many queries it ran — the log line's numbers, for the runner. */
      cited: number;
      queries: number;
    }
  | {
      ok: false;
      reason: MomentRefusal;
      issues?: string[];
      cost?: SummarizeCost;
      model?: string;
    };

/** What one web search returned, as this tool reads it. */
export interface MomentSearchRaw {
  /** The answer text (the JSON object, or whatever the model wrote instead). */
  text: string;
  /** Every page the search saw or the answer cited (url + title), de-duplicated, in first-seen order. */
  sources: Array<{ url: string; title?: string }>;
  /** The queries the search ran. */
  queries: string[];
  /** agent/models costOf of the call's usage (tokens + web search fee); null when no usage was seen. */
  cost: RunCost | null;
}

/** The skill the call runs as (its id keys the prompt cache and any AGENT_SKILL_MODELS override). */
export const MOMENT_SKILL = {
  id: "studio/research-moment",
  version: "2.0.0",
  instructions: MOMENT_SYSTEM,
} as const;

/** The model the search runs on: the fast tier (web search stays on OpenAI by rule, agent/models). */
export const momentModel = () =>
  modelFor({ id: MOMENT_SKILL.id, model: "fast", effort: "low", tools: ["web_search"] });

/**
 * The production search: ONE OpenAI web_search call at low context, a strict JSON answer. A reply
 * with no valid JSON is handed back as its text (the tool then calls it unreadable, as before); any
 * other failure throws.
 */
export async function openaiMomentSearch(
  query: string,
  instructions: string,
): Promise<MomentSearchRaw> {
  try {
    const r = await callStructured({
      skill: { ...MOMENT_SKILL, instructions },
      model: momentModel(),
      input: query,
      schemaName: "research_moment",
      schema: MOMENT_SCHEMA as never,
      webSearch: { maxCalls: 1, contextSize: "low" },
      maxOutputTokens: 1_200,
    });
    return { text: r.text, sources: r.sources, queries: r.queries, cost: r.cost };
  } catch (err) {
    const partial = err instanceof ModelCallError ? err.partial : undefined;
    if (partial && typeof partial.text === "string")
      return {
        text: partial.text,
        sources: partial.sources ?? [],
        queries: partial.queries ?? [],
        cost: partial.cost ?? null,
      };
    throw err;
  }
}

/**
 * The athlete's day cap, the one Mila's turns are held to (AGENT_DAY_COST_CAP_USD over agent_runs since UTC
 * midnight): the search is refused when today's spend plus one search fee would pass it, and every search is written
 * as an agent_runs row with its cost so the next check (and Mila's next turn) counts it.
 */
export interface MomentLedger {
  spentTodayMicroUsd(athleteId: string): Promise<number>;
  record(athleteId: string, cost: RunCost, failed: boolean): Promise<void>;
}

export const agentRunsLedger: MomentLedger = {
  spentTodayMicroUsd: (athleteId) => spentTodayMicroUsd(athleteId),
  async record(athleteId, cost, failed) {
    const runId = await dbStore.startRun({
      athleteId,
      skillId: MOMENT_SKILL.id,
      skillVersion: MOMENT_SKILL.version,
      trigger: "event",
      model: momentModel(),
      parentRef: null,
    });
    await dbStore.finishRun(athleteId, runId, {
      status: failed ? "failed" : "completed",
      stopReason: failed ? "error" : null,
      cost,
      steps: [],
      evidenceRead: [],
      output: null,
      error: failed ? "research_moment search failed" : null,
    });
  },
};

/** Test seams: the search, the limiter and the ledger. Production takes openaiMomentSearch, the shared limiter and agent_runs. */
export interface MomentDeps {
  search?: (query: string, instructions: string) => Promise<MomentSearchRaw>;
  limiter?: WebSearchLimiter;
  ledger?: MomentLedger;
}

const MAX_TONES = 6;
const MAX_TONE = 40;
const MAX_STORY = 200;

// ─── Input ──────────────────────────────────────────────────────────────────────────────────────────────

export function readMomentInput(raw: unknown):
  | {
      ok: true;
      value: { ask: string; brand: string | null; date: string | null };
    }
  | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, issues: ["body: an object"] };
  const b = raw as Record<string, unknown>;
  const ask = typeof b.ask === "string" ? b.ask.trim() : "";
  if (!ask || ask.length > MAX_ASK)
    issues.push(`ask: what you're looking for, in up to ${MAX_ASK} characters`);
  const optional = (key: "brand" | "date", max: number): string | null => {
    const v = b[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      issues.push(`${key}: text`);
      return null;
    }
    const t = v.trim();
    if (!t) return null;
    if (t.length > max) issues.push(`${key}: up to ${max} characters`);
    return t;
  };
  const brand = optional("brand", MAX_BRAND);
  const date = optional("date", MAX_DATE);
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { ask, brand, date } };
}

// ─── The mapping ────────────────────────────────────────────────────────────────────────────────────────

export interface FoundMoment {
  title: string;
  summary: string;
  angle: string | null;
  feeling: string | null;
  line: string | null;
  feel: string[];
}

export interface MomentSource {
  title: string | null;
  url: string | null;
  domain: string | null;
}

const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
};

/** The pages the search saw, as the envelope carries them — the model's own claims never enter here. */
export function sourcesOf(raw: Pick<MomentSearchRaw, "sources">): MomentSource[] {
  return raw.sources
    .filter((s) => /^https?:\/\//i.test(s.url ?? ""))
    .slice(0, MAX_MOMENT_SOURCES)
    .map((s) => ({
      title: s.title?.trim() ? capWords(s.title, 160) : null,
      url: s.url.trim().slice(0, 500),
      domain: hostnameOf(s.url)?.slice(0, 120) ?? null,
    }));
}

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const LEAD = "(?:(?:on|from|in|by|until|since|through)\\s+)?";
/**
 * A timing signal the SEARCH supplied — a calendar date, a month-and-day, or a bare year — is never
 * hers, so it never passes: every model-written field is stripped of them before mapping, and what
 * was removed is named in `extras.moment.timingRemoved` and a note, so she can put the right one in
 * herself. Live cell D2 (23 Sep 2026) walked "2026 NWSL Championship" past a calendar-date scan; a year
 * inside an event's name is still the search dating her plan. ⚠️ MUTATION (moment.test, routes.test):
 * skip the strip — "a timing signal the search supplied never passes, calendar date or year" reds.
 */
export const TIMING_RE = new RegExp(
  [
    `${LEAD}\\b\\d{4}-\\d{2}-\\d{2}\\b`, // 2026-10-04
    `${LEAD}\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b`, // 10/4/2026
    `${LEAD}\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+(?:19|20)\\d{2})?\\b`, // October 4th, 2026
    `${LEAD}\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:\\s+(?:19|20)\\d{2})?\\b`, // 4 October 2026
    `${LEAD}\\b(?:19|20)\\d{2}\\b`, // 2026
  ].join("|"),
  "gi",
);

/** The text without its timing signals, and the signals themselves, in order. */
export function stripTiming(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const stripped = text
    .replace(TIMING_RE, (m) => {
      removed.push(m.trim());
      return " ";
    })
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text: stripped, removed };
}

/**
 * The model's answer, read strictly: `found`, then the six fields, each stripped of any timing signal.
 * Nothing else is looked at.
 */
export function readFound(
  json: Record<string, unknown>,
):
  | { found: false }
  | { found: true; moment: FoundMoment; timingRemoved: string[] }
  | null {
  if (json.found === false) return { found: false };
  if (json.found !== true) return null;
  const removed: string[] = [];
  const text = (v: unknown, max: number, asTitle = false): string | null => {
    if (typeof v !== "string" || !v.trim()) return null;
    const s = stripTiming(v.trim().replace(/\s+/g, " "));
    removed.push(...s.removed);
    return (asTitle ? capTitle(s.text, max) : capWords(s.text, max)) || null;
  };
  const title = text(json.title, MAX_MOMENT_TITLE, true);
  const summary = text(json.summary, MAX_MOMENT_SUMMARY);
  if (!title || !summary) return null;
  const feel = Array.isArray(json.feel)
    ? json.feel
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x.length >= 2 && x.length <= MAX_TONE)
        .filter((x, i, all) => all.indexOf(x) === i)
        .slice(0, MAX_TONES)
    : [];
  return {
    found: true,
    moment: {
      title,
      summary,
      angle: text(json.angle, MAX_ANGLE),
      feeling: text(json.feeling, MAX_FEELING),
      line: text(json.line, MAX_LINE),
      feel,
    },
    timingRemoved: removed
      .map((r) => capWords(r, 40))
      .filter((r, i, all) => all.indexOf(r) === i)
      .slice(0, 6),
  };
}

/** The moment onto a brief. Pure. The date is HER line or no line; the model never dates anything. */
export function proposalFromMoment(
  m: FoundMoment,
  about: {
    sources: MomentSource[];
    searchQueries: string[];
    date: string | null;
    /** Timing the SEARCH supplied and this tool removed — a date, a month-and-day, a year. */
    timingRemoved: string[];
  },
): unknown {
  const domains = about.sources
    .map((s) => s.domain)
    .filter((d): d is string => !!d);
  const where = domains.length
    ? domains.slice(0, 3).join(", ")
    : "no source named";
  const kept = new Map<string, KeptLine>();
  kept.set("story", {
    value: capWords(m.title, MAX_STORY),
    flag: {
      basis: "inferred",
      because: capWords(
        `found by web search — ${where}`,
        MAX_BECAUSE,
      ),
    },
  });
  if (m.feel.length)
    kept.set("creative_direction.tone", {
      value: m.feel,
      flag: {
        basis: "inferred",
        because: "the feel of the moment, as the search read it",
      },
    });
  const built = buildBrief(kept);
  const flags: InferenceFlag[] = [...built.flags];
  const constraints: string[] = [];
  if (about.date) {
    constraints.push(`Timing: ${about.date}`.slice(0, MAX_CONSTRAINT));
    flags.push({
      path: "extras.constraints.0",
      basis: "literal",
      quote: about.date,
    });
  }
  const concept =
    m.angle && m.feeling && m.line
      ? { angle: m.angle, feeling: m.feeling, line: m.line }
      : undefined;
  if (concept)
    flags.push({
      path: "extras.concept",
      basis: "inferred",
      because: capWords(
        `the angle the moment offers, as the search read it — ${where}`,
        MAX_BECAUSE,
      ),
    });
  const n = about.sources.length;
  const notes = [
    `Found by web search: ${n} source${n === 1 ? "" : "s"} cited.`,
    about.date
      ? `Timed by you: ${about.date}. The search never dates anything.`
      : "No date: the search doesn't date things reliably — add the date if you know it.",
    ...(about.timingRemoved.length
      ? [
          `Timing the search supplied was removed (${about.timingRemoved.join(", ")}) — the date is yours to add.`,
        ]
      : []),
  ].map((s) => capWords(s, MAX_NOTE));
  return {
    brief: built.brief,
    flags,
    sourceTool: "research_moment",
    extras: {
      constraints,
      ...(concept ? { concept } : {}),
      notes,
      moment: {
        title: m.title,
        summary: m.summary,
        sources: about.sources,
        searchQueries: about.searchQueries
          .slice(0, 5)
          .map((q) => capWords(q, 160)),
        dateBasis: about.date ? "hers" : "none",
        timingRemoved: about.timingRemoved,
      },
    },
  };
}

// ─── The tool ───────────────────────────────────────────────────────────────────────────────────────────

export async function researchMoment(
  athleteId: string,
  input: MomentInput,
  deps: MomentDeps = {},
): Promise<MomentResult> {
  if (!momentSearchEnabled()) return { ok: false, reason: "disabled" };
  const read = readMomentInput(input);
  if (!read.ok)
    return { ok: false, reason: "invalid_input", issues: read.issues };
  const { ask, brand, date } = read.value;

  const [row] = await db
    .select({ sport: athletes.sport })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const sport = namesSport(row?.sport ?? null);

  const limiter = deps.limiter ?? webSearchLimiter;
  if (!limiter.allow(athleteId)) {
    logger.info(
      { athleteId, tool: "research_moment" },
      "research_moment rate limited — no call",
    );
    return { ok: false, reason: "rate_limited" };
  }

  // The athlete's day cap: a read that fails counts as nothing spent, as Mila's turn does (agent/engine turn.ts).
  const ledger = deps.ledger ?? agentRunsLedger;
  const spentToday = await ledger.spentTodayMicroUsd(athleteId).catch(() => 0);
  if (spentToday + webSearchCallMicroUsd() > AGENT.DAY_COST_CAP_MICRO_USD) {
    logger.info(
      { athleteId, tool: "research_moment", spentToday, cap: AGENT.DAY_COST_CAP_MICRO_USD },
      "research_moment over the day cap — no call",
    );
    return { ok: false, reason: "day_cap" };
  }

  const model = momentModel().model;
  const query = momentQuery({ ask, sport, brand, date });
  const search = deps.search ?? openaiMomentSearch;
  let raw: MomentSearchRaw | null = null;
  let failure: string | null = null;
  try {
    raw = await withTimeout(
      search(query, MOMENT_SYSTEM),
      directionTimeoutMs(),
      "research_moment",
    );
  } catch (err) {
    failure = String((err as Error).message ?? err).slice(0, 160);
  } finally {
    limiter.record(athleteId); // the search ran, whatever it returned
  }
  // The Studio-side cost line, on EVERY call, priced the way research v2 discover prices its search:
  // agent/models costOf of the call's own usage (tokens + the web search fee). A call that failed
  // before any usage was seen still counts its one search at the per-call fee. The research lane's
  // ledger is not touched.
  const searchUsd = webSearchCallMicroUsd() / 1_000_000;
  const cost: SummarizeCost = raw?.cost
    ? {
        usd: Number((raw.cost.microUsd / 1_000_000).toFixed(6)),
        basis: "estimated",
        inputTokens: raw.cost.inputTokens,
        outputTokens: raw.cost.outputTokens,
      }
    : { usd: searchUsd, basis: "estimated", inputTokens: 0, outputTokens: 0 };
  // Counted in the day cap: the call's own cost, or its one search fee when no usage was seen.
  await ledger
    .record(
      athleteId,
      raw?.cost ?? { ...ZERO_COST, webSearchCalls: 1, microUsd: webSearchCallMicroUsd() },
      !raw,
    )
    .catch((err) =>
      logger.warn(
        { athleteId, error: String((err as Error)?.message ?? err).slice(0, 160) },
        "research_moment cost not recorded",
      ),
    );
  logger.info(
    {
      athleteId,
      tool: "research_moment",
      model,
      promptVersion: MOMENT_PROMPT_VERSION,
      searchCalls: raw?.cost ? raw.cost.webSearchCalls : 1,
      searchUsd,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      usd: cost.usd,
      basis: cost.basis,
      cited: raw?.sources.length ?? 0,
      queries: raw?.queries.length ?? 0,
      failed: failure !== null,
    },
    "research_moment cost — one web search, Studio-side",
  );
  if (!raw) {
    logger.warn({ athleteId, error: failure }, "research_moment search failed");
    return { ok: false, reason: "model_failed", cost, model };
  }

  const text = raw.text ?? "";
  const json =
    readReplyJson(text) ??
    (text.includes("{")
      ? readReplyJson(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
      : null);
  const found = json ? readFound(json) : null;
  if (!found) {
    logger.warn(
      { athleteId, model },
      "research_moment reply unreadable",
    );
    return { ok: false, reason: "invalid_reply", cost, model };
  }
  if (!found.found) return { ok: false, reason: "nothing_found", cost, model };

  const sources = sourcesOf(raw);
  const searchQueries = raw.queries.filter(
    (q): q is string => typeof q === "string" && !!q.trim(),
  );
  const candidate = proposalFromMoment(found.moment, {
    sources,
    searchQueries,
    date,
    timingRemoved: found.timingRemoved,
  });
  const v = validateBriefProposal(candidate);
  if (!v.ok) {
    logger.warn(
      { athleteId, model, issues: v.issues.length },
      "research_moment mapped an invalid proposal",
    );
    return {
      ok: false,
      reason: "invalid_reply",
      issues: v.issues,
      cost,
      model,
    };
  }
  logger.info(
    {
      athleteId,
      tool: "research_moment",
      model,
      promptVersion: MOMENT_PROMPT_VERSION,
      dateBasis: date ? "hers" : "none",
      cited: sources.length,
      lines: v.proposal.flags.length,
    },
    "research_moment answered",
  );
  return {
    ok: true,
    proposal: v.proposal,
    model,
    promptVersion: MOMENT_PROMPT_VERSION,
    cost,
    cited: sources.length,
    queries: searchQueries.length,
  };
}
