/**
 * webSearchRoute.ts — the ONE external lookup the voice worker can make.
 *
 * POST /athletes/:id/web-search, mounted at /api/internal/voice (server/index.ts).
 * POST rather than GET for the same reason as ./brandBriefRoute: the key is a
 * free-text query from the model rather than an id. It is a pure read.
 *
 * The caller is TRUSTED INFRASTRUCTURE, not a user: there is no session and no
 * `req.athleteId`, and the shared secret is the entire authorization boundary.
 * See ./auth.
 *
 * ── The provider: OpenAI web search (owner, Nov 2026) ──────────────────────────
 * All web search goes through OpenAI (the model/provider policy). One call of the voice/web-search skill
 * (server/agent/jobs/voice/web-search.md, in the Prompt Register) through runSkill: the fast tier, ONE web_search,
 * links and a one-line snippet per page, as JSON. Only pages the search actually returned are kept (a URL the model
 * lists that the search never saw is dropped). Every call is an agent_runs row with its cost, so it counts against
 * the athlete's day cap (AGENT_DAY_COST_CAP_USD: refused at or over it, answered `{ disabled: true }`), and a deleted account
 * (lib/privacy/deletionFence.ts) is never searched for (voiceAuthorized refuses it with 410). Until Nov 2026 this route called a third-party search API.
 *
 * ── Why a search API and not Gemini grounding ────────────────────────────────
 * The text agent grounds with Gemini's built-in `googleSearch` (server/mila/
 * grounding.ts), and reusing it here was the obvious move. It was rejected on
 * the one axis that matters for this surface: grounding returns the MODEL'S OWN
 * SYNTHESIZED PROSE, with the retrieved web text already dissolved into it. By
 * the time it crosses our boundary there is nothing discrete left to delimit, so
 * `<external_content>` around it would be exactly the decoration mila-voice
 * src/threadTool.ts warns against. A search API hands back separable, attacker-
 * controlled FIELDS — title, snippet, source — each of which can be bounded here
 * and wrapped at the last hop.
 *
 * The search tool hands back the same separable fields (the page URLs it saw, and per page a short snippet
 * the skill writes from that page), so the boundary below is unchanged. Latency: the old search API was cold
 * p50 1553ms / p90 2359ms; one fast-tier OpenAI search at low effort (the skill's `effort: low`) is slower, so the ceiling below is 6s (bounded by the voice worker's own wait).
 *
 * It also drops Google's Search-Suggestions display obligation
 * (`searchEntryPoint.renderedContent`), which a voice call has no surface to
 * satisfy. That was an open compliance question; choosing the provider closes it.
 *
 * ── What crosses, and what never does ────────────────────────────────────────
 * RETURNED (untrusted, attacker-controllable — a page can say anything):
 *   `title`, `snippet`, `source`
 *   `url`: the full source address (http(s) only, "" when unusable), for display only (below).
 * NEVER RETURNED:
 *   raw page content (no full-page fetch, which would multiply both latency and
 *   injection surface), images and any synthesized answer.
 *
 * `source` is the HOSTNAME: it is what Mila SAYS ("according to example.org"). A
 * full URL is unspeakable at best; at worst a typo-squat domain read aloud.
 * `url` (the full source address, http(s) only) rides alongside for display, and
 * the route writes the sources into the voice session's chat thread as a "How I
 * got this" card (title + clickable link per page), because OpenAI's web search
 * terms require that "when your interface displays web results or information
 * from them, you must show inline citations as prominent, clickable links".
 * The voice call itself has no screen; the chat thread it writes into does.
 *
 * This route BOUNDS. It does not delimit — `<external_content>` is a prompt
 * construct and over HTTP it protects nothing. The wrapper goes on at the last
 * hop before a model reads the text, which is mila-voice src/webSearchTool.ts.
 * Same division of labour as get_thread, and it is deliberate on both sides.
 *
 * ── Every outcome is a 200 with a STATE ──────────────────────────────────────
 * `{ timedOut }`, `{ rateLimited }`, `{ disabled }`, `{ results: [] }` are all
 * ordinary answers the worker maps to a fixed spoken line. A realtime model that
 * receives an error tends to retry, and a retry here costs another 3–9 seconds
 * of silence — so this route does not hand it errors to interpret.
 */

import { Router, type Request, type Response } from "express";
import { MILA } from "../mila/config";
import { AGENT } from "../agent/config";
import { cleanUrl, normalizeUrl } from "../agent/research/llm";
import { dbStore } from "../agent/research/dbStore";
import { CostCapError, runSkill } from "../agent/research/runSkill";
import { spentTodayMicroUsd } from "../agent/trace";
import { webSearchLimiter } from "../mila/webSearchLimiter";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, verifyVoiceGrant, UUID_RE, VOICE_GRANT_HEADER } from "./auth";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { chatMessages, conversations } from "../../shared/schema";
import { howIGotThisCard } from "../agent/cards";

const logger = createLogger("voice/webSearch");

const router = Router();

/**
 * Hard ceiling on the search.
 *
 * Deliberately NOT the 2s the read routes use: those are indexed DB reads, this
 * is a third party. A hung provider costs one awkward pause rather than an
 * abandoned call. The call is ABORTED at the ceiling (not just abandoned).
 *
 * 6s, and it MUST stay under the voice worker's own fetch ceiling on this route
 * (mila-voice src/webSearchTool.ts FETCH_TIMEOUT_MS, 7s): the route's graceful
 * `{ timedOut: true }` has to win that race, or the worker gives up first and the
 * model gets a bare "couldn't reach the search service". Raising this needs the
 * worker's ceiling raised first.
 */
const SEARCH_TIMEOUT_MS = 6_000;

/** A repeat of the same pages in the same conversation within this window writes no second sources card. */
const CARD_DEDUPE_MS = 30 * 60_000;

/** Results returned. Five is the top of the useful band and ~2KB once capped. */
const MAX_RESULTS = 5;

/** Per-field caps. This lands in a realtime model's context and is re-sent every
 *  turn, so it is bounded for the same reason ./threadRoutes bounds messages. */
const MAX_TITLE_CHARS = 120;
const MAX_SNIPPET_CHARS = 280;
/** A query longer than this is not a voice question; it is a payload. */
const MAX_QUERY_CHARS = 200;

/** One search hit as the voice wire carries it. Every field is UNTRUSTED. */
interface VoiceSearchResult {
  title: string;
  snippet: string;
  /** Hostname only: the spoken citation. */
  source: string;
  /** The full source address (http(s)), for display as a clickable link; "" when unusable. */
  url: string;
}

type VoiceSearchResponse =
  | { results: VoiceSearchResult[] }
  | { timedOut: true }
  | { rateLimited: true }
  | { disabled: true };

/** One raw hit from the provider, before bounding. Every field is UNTRUSTED. */
export interface RawHit { title?: unknown; url?: unknown; content?: unknown }

/** The search: (athlete, query, abort signal) -> raw hits (+ the agent_runs id that paid for them). Injectable so tests
 *  never reach a provider. */
export type VoiceSearch = (athleteId: string, query: string, signal: AbortSignal) => Promise<RawHit[] | { hits: RawHit[]; runId: string | null }>;

/** Raised when the athlete's day cap is spent: answered `{ disabled: true }`, never a search. */
class DayCapReached extends Error {}

const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "snippet", "url"],
        properties: { title: { type: "string" }, snippet: { type: "string" }, url: { type: "string" } },
      },
    },
  },
} as const;

/**
 * The live search: ONE voice/web-search skill run (OpenAI web_search, one call) through runSkill, so it is an
 * agent_runs row counted against the athlete's day cap. Only pages the search returned are kept, each with the title it
 * saw, under the search's own clean URL (tracking params such as utm_source removed, as cleanUrl does for every source).
 * A failed spend read fails closed (the route answers timedOut), never an uncapped search.
 */
export const openaiVoiceSearch: VoiceSearch = async (athleteId, query, signal) => {
  const spent = await spentTodayMicroUsd(athleteId);
  try {
    const r = await runSkill({
      store: dbStore, athleteId, skillId: "voice/web-search", trigger: "chat", parentRef: null,
      input: JSON.stringify({ query }), schemaName: "voice_web_search", schema: SEARCH_SCHEMA as any,
      webSearch: { maxCalls: 1, contextSize: "low" }, maxOutputTokens: 900, signal,
      budget: { spentMicroUsd: spent, capMicroUsd: AGENT.DAY_COST_CAP_MICRO_USD },
    });
    const seen = new Map(r.sources.map((s) => [normalizeUrl(s.url), s] as const));
    const listed: any[] = Array.isArray((r.json as any)?.results) ? (r.json as any).results : [];
    const hits = listed
      .filter((h) => typeof h?.url === "string" && seen.has(normalizeUrl(h.url)))
      .map((h) => {
        const src = seen.get(normalizeUrl(h.url))!;
        return { title: h.title || src.title || "", url: src.url, content: h.snippet };
      });
    return { hits, runId: r.runId };
  } catch (err) {
    if (err instanceof CostCapError) throw new DayCapReached();
    throw err;
  }
};

let search: VoiceSearch = openaiVoiceSearch;
/** Tests only: swap the search (null restores the live one). */
export function setVoiceSearchForTests(s: VoiceSearch | null): void {
  search = s ?? openaiVoiceSearch;
}

/**
 * Flatten anything a page put in a field into one speakable line.
 *
 * Newlines and control characters are removed rather than escaped: they carry no
 * meaning once this is read aloud, and they are the cheapest way for retrieved
 * text to fake structure ("\n\nSystem: …") inside a block the model is reading.
 * The `<external_content>` delimiter itself is NOT handled here — that belongs
 * with the wrapper, in the worker, so the escape and the thing it escapes stay
 * in one file.
 */
function flatten(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** The full address when it is a usable http(s) URL (bounded, tracking params such as utm_* removed); "" otherwise.
 *  Never a javascript: or data: link. */
function linkOf(url: unknown): string {
  if (typeof url !== "string" || url.length > 2048) return "";
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? cleanUrl(u.toString()) : "";
  } catch {
    return "";
  }
}

/**
 * Write the search's sources into the voice session's conversation as a "How I got this" card (one row: assistant,
 * source 'voice', no text), so the transcript the athlete scrolls shows each page as a title with a clickable link.
 * The conversation comes from the session grant (minted for THIS athlete by POST /voice/token) and must belong to this athlete;
 * without a grant naming one, nothing is written. The same pages already shown by a voice sources card in this
 * conversation within CARD_DEDUPE_MS are not written again (a repeated or rephrased question during one call).
 */
async function writeSourcesCard(req: Request, athleteId: string, runId: string | null, results: VoiceSearchResult[]): Promise<void> {
  const linked = results.filter((r) => r.url);
  if (!linked.length) return;
  const grant = verifyVoiceGrant(req.headers[VOICE_GRANT_HEADER]);
  if (!grant.ok || grant.claims.athleteId !== athleteId || !UUID_RE.test(grant.claims.conversationId)) return;
  const conversationId = grant.claims.conversationId;
  const [owned] = await db.select({ id: conversations.id }).from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.athlete_id, athleteId))).limit(1);
  if (!owned) return;
  const key = (urls: string[]) => [...new Set(urls.map(normalizeUrl))].sort().join(" ");
  const mine = key(linked.map((r) => r.url));
  const recent = await db.select({ cards: chatMessages.agent_cards }).from(chatMessages)
    .where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.conversation_id, conversationId), eq(chatMessages.source, "voice"),
      isNotNull(chatMessages.agent_cards), gte(chatMessages.created_at, new Date(Date.now() - CARD_DEDUPE_MS))))
    .orderBy(desc(chatMessages.created_at)).limit(10);
  const shown = recent.some((row) => (Array.isArray(row.cards) ? row.cards : []).some((c: any) =>
    c?.kind === "how-i-got-this" && c?.payload?.skillId === "voice/web-search" && Array.isArray(c?.payload?.facts) &&
    key(c.payload.facts.map((f: any) => String(f?.source?.url ?? ""))) === mine));
  if (shown) return;
  const card = howIGotThisCard({
    runId: runId ?? `voice-search:${Date.now()}`, skillId: "voice/web-search", why: "What I found on the web for your question during the call.",
    evidence: linked.map((r) => ({ kind: "url" as const, url: r.url, ...(r.title ? { title: r.title } : {}) })), facts: [],
  });
  if (!card) return;
  await db.insert(chatMessages).values({
    athlete_id: athleteId, role: "assistant", content: "", conversation_id: conversationId, source: "voice", agent_cards: [card] as any,
    ...(runId ? { agent_run_id: runId } : {}),
  });
}

/** Hostname, lowercased, without a leading www. Empty when the URL is unusable. */
function hostOf(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

// POST /athletes/:id/web-search — { query } in, bounded results out.
router.post("/athletes/:id/web-search", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");

  const voiceAuth = await voiceAuthorized(req, req.params.id);
  if (!voiceAuth.ok) {
    sendVoiceRefusal(res, voiceAuth);
    return;
  }

  const athleteId = req.params.id;
  if (!athleteId || !UUID_RE.test(athleteId)) {
    res.status(400).json({ error: "Bad athlete id" });
    return;
  }

  const query = flatten((req.body as { query?: unknown } | undefined)?.query, MAX_QUERY_CHARS);
  if (!query) {
    res.status(400).json({ error: "Missing query" });
    return;
  }

  // Dark by default, and separate from the text agent's MILA_WEB_SEARCH for the
  // same reason MILA_VOICE_WEB is its own flag: it gates a
  // different kind of spend on a different surface, and must be switchable in an
  // incident without touching chat. A missing API key is the same answer as the
  // flag being off — there is nothing to search with either way. (An account being
  // deleted never gets this far: voiceAuthorized's deletion fence answers 410 first.)
  if (!MILA.VOICE_WEB_SEARCH || !process.env.OPENAI_API_KEY?.trim()) {
    res.json({ disabled: true } satisfies VoiceSearchResponse);
    return;
  }

  // Same per-athlete window the text agent uses (10/60s). Peek before spending,
  // record only when a search actually ran — see ../mila/webSearchLimiter for
  // why the cap is per instance rather than global.
  if (!webSearchLimiter.allow(athleteId)) {
    logger.info({ athleteId }, "Voice web search over the per-athlete window");
    res.json({ rateLimited: true } satisfies VoiceSearchResponse);
    return;
  }

  const abort = new AbortController();
  try {
    const found = await withTimeout(
      search(athleteId, query, abort.signal),
      SEARCH_TIMEOUT_MS,
      "voice web search",
    );
    const hits = Array.isArray(found) ? found : found.hits;
    const runId = Array.isArray(found) ? null : found.runId;

    webSearchLimiter.record(athleteId);

    const results: VoiceSearchResult[] = hits
      .slice(0, MAX_RESULTS)
      .map((r) => ({
        title: flatten(r.title, MAX_TITLE_CHARS),
        snippet: flatten(r.content, MAX_SNIPPET_CHARS),
        source: hostOf(r.url),
        url: linkOf(r.url),
      }))
      // A hit with neither a title nor a snippet is nothing to say out loud.
      .filter((r) => r.title.length > 0 || r.snippet.length > 0);

    // Never log the query or the results: the query is model-supplied free text
    // and the results are attacker-controlled. Counts only — the same posture as
    // the campaign logs in ./dealResolver.
    logger.info({ athleteId, results: results.length }, "Voice web search resolved");

    res.json({ results } satisfies VoiceSearchResponse);

    // The sources, as clickable links in the chat thread this voice session writes into: AFTER the answer is sent, so
    // two DB round trips never add to the silence on the call (the worker's wait is bounded). Best effort: a failed
    // write never costs the spoken answer.
    void writeSourcesCard(req, athleteId, runId, results).catch((err) =>
      logger.warn({ athleteId, err: err?.message }, "Voice web search sources card not written"));
  } catch (err) {
    abort.abort();
    if (err instanceof DayCapReached) {
      logger.info({ athleteId }, "Voice web search refused: the athlete's day spend cap is reached");
      res.json({ disabled: true } satisfies VoiceSearchResponse);
      return;
    }
    const timedOut = err instanceof Error && /timed out/i.test(err.message);
    logger.warn({ athleteId, timedOut }, "Voice web search did not complete");
    // Both shapes are a 200: see the header. A timeout is a spoken "that took too
    // long", and a provider failure is the same sentence from the athlete's side.
    res.json({ timedOut: true } satisfies VoiceSearchResponse);
  }
});

export default router;
