/**
 * promptRegistry.ts — where a prompt's live text comes from.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * The exit criterion for phase 1 is that the founder can open a run, see the prompt behind
 * it, change that prompt, and watch a metric move — without a deploy and without an engineer.
 * Tracing gave the first two. This gives the third: prompt text resolves at CALL time from
 * the registry, so publishing a new version changes behaviour on the next request.
 *
 * ── RESOLUTION ORDER ────────────────────────────────────────────────────────
 *   1. the published row in `prompts`   — the live edit, the point of the exercise
 *   2. PROMPT_<KEY> in the environment  — an incident lever that needs no DB access
 *   3. the in-code constant             — always present, so there is no "prompt missing" state
 *
 * Every layer is a fallback for the one before it, so the worst case is the behaviour we had
 * before this file existed. That is deliberate: an unreachable database must degrade to
 * today's prompts, never to an empty string, and never to a throw inside a model call.
 *
 * ── WHY LOCKING LIVES IN CODE, AND NOT IN THE TABLE ─────────────────────────
 * The classifier, the scorer and the contract extractor decide money and carry compliance
 * weight. They are review-and-version: changing one takes a reviewed pull request, never a
 * live edit box.
 *
 * That rule is enforced by the LOCKED set below, and the table has no `locked` column at
 * all. If lockedness lived in the row, then a database that is unreachable — or a row
 * someone edited — would decide whether a money prompt can be swapped at runtime, and
 * failing open on that question is unacceptable. So the code answers it before any query is
 * made, and there is no second, inert copy of the answer for a reader to trust by mistake.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../logger";

const logger = createLogger("prompt-registry");

/**
 * Prompts that may NEVER be swapped at runtime. Adding a key here is a safety decision;
 * removing one is a much bigger decision than it looks.
 */
export const LOCKED_PROMPTS: ReadonlySet<string> = new Set([
  "classify.system",          // decides whether a message is a deal at all
  "score.system",             // sets the number an athlete negotiates against
  "contract.extract.system",  // reads binding terms out of a signed agreement
]);

/** Off unless explicitly enabled, following MILA_VOICE_WEB / STUDIO_ENABLED / LANGFUSE_TRACING. */
export function registryEnabled(): boolean {
  return process.env.PROMPT_REGISTRY?.trim().toLowerCase() === "true";
}

/**
 * How long a resolved prompt is reused before the table is consulted again.
 *
 * This is the delay between publishing and seeing the effect, so it trades directly against
 * a query per model call. Sixty seconds keeps "change it and watch" feeling immediate while
 * costing at most one read a minute per prompt.
 */
const TTL_MS = Number(process.env.PROMPT_CACHE_TTL_MS ?? 60_000);

type Entry = { body: string; at: number; version: number | null; hash: string | null; source: Source };
const cache = new Map<string, Entry>();

type Source = "db" | "env" | "code" | "locked";

/**
 * Record on the enclosing trace WHICH prompt produced this run.
 *
 * This is the half of the exit criterion that tracing alone cannot give. A run in Langfuse
 * shows the prompt TEXT because we send it as a model parameter — but text does not say
 * whether it came from a published row, an environment override during an incident, or the
 * constant in the repository, and it does not say which version. Without that, "I changed the
 * prompt and the metric moved" is a correlation nobody can check afterwards.
 *
 * Attached to the ACTIVE observation rather than passed back to the caller, which is why the
 * call sites stay `await resolvePrompt(key, CONSTANT)` and gain this for free. Outside a
 * trace it is a no-op.
 *
 * Never throws: a failure to annotate must not become a failure to answer, so the prompt is
 * returned whether or not this lands.
 */
async function stamp(key: string, e: Omit<Entry, "body" | "at">): Promise<void> {
  if (!tracingOn()) return;
  try {
    const { updateActiveObservation } = await import("@langfuse/tracing");
    updateActiveObservation({
      metadata: {
        [`prompt.${key}`]: {
          source:  e.source,          // db | env | code | locked — where the text actually came from
          version: e.version,
          hash:    e.hash,
        },
      },
    });
  } catch {
    // Deliberately silent. This is decoration on a trace; the caller wants a prompt.
  }
}

/** Tracing is a separate flag from the registry — either can be on without the other. */
function tracingOn(): boolean {
  return process.env.LANGFUSE_TRACING?.trim().toLowerCase() === "true";
}

/** Environment override name for a key: "classify.system" → PROMPT_CLASSIFY_SYSTEM. */
export function envVarFor(key: string): string {
  return `PROMPT_${key.replace(/[.\-]/g, "_").toUpperCase()}`;
}

/**
 * The live text for `key`, falling back to `inCode`.
 *
 * `inCode` is required rather than optional on purpose: every caller must pass the constant
 * it would have used anyway, which guarantees a usable prompt exists on every path — before
 * the registry is enabled, when the row is absent, and when the database is down.
 */
export async function resolvePrompt(key: string, inCode: string): Promise<string> {
  // Locked prompts short-circuit before any lookup — see the header. No query, no cache, no
  // environment override: the reviewed constant in the repository is the only answer.
  if (LOCKED_PROMPTS.has(key)) {
    // Stamped as `locked` rather than `code`, so a trace distinguishes "nothing was published"
    // from "publishing is refused here" — the difference matters when auditing a decision.
    await stamp(key, { version: null, hash: null, source: "locked" });
    return inCode;
  }

  const env = process.env[envVarFor(key)];
  const fallback = (): string => (env?.trim() ? env : inCode);
  const fallbackSource = (): Source => (env?.trim() ? "env" : "code");

  if (!registryEnabled()) {
    await stamp(key, { version: null, hash: null, source: fallbackSource() });
    return fallback();
  }

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    // Stamped on a cache hit too. A trace that only records the prompt on the minute it was
    // re-read would leave most runs unattributed, which defeats the point.
    await stamp(key, { version: hit.version, hash: hit.hash, source: hit.source });
    return hit.body;
  }

  try {
    const rows = await db.execute<{ body: string; version: number; hash: string }>(
      sql`SELECT body, version, hash FROM prompts WHERE key = ${key} AND status = 'published' LIMIT 1`,
    );
    const row = (rows as unknown as { rows?: Array<{ body: string; version: number; hash: string }> }).rows?.[0]
      ?? (rows as unknown as Array<{ body: string; version: number; hash: string }>)[0];
    if (row?.body?.trim()) {
      const entry: Entry = { body: row.body, at: Date.now(), version: row.version, hash: row.hash, source: "db" };
      cache.set(key, entry);
      await stamp(key, { version: entry.version, hash: entry.hash, source: "db" });
      return row.body;
    }
  } catch (err: any) {
    // A registry outage must not become a model outage. Cache the fallback briefly so a
    // database that is down does not produce a query per model call on top of everything else.
    logger.warn({ key, error: err?.message?.slice(0, 200) }, "prompt lookup failed — using fallback");
    cache.set(key, { body: fallback(), at: Date.now(), version: null, hash: null, source: fallbackSource() });
  }

  await stamp(key, { version: null, hash: null, source: fallbackSource() });
  return fallback();
}

/** Drop cached prompts so the next resolve re-reads. For tests and for an explicit reload. */
export function clearPromptCache(): void {
  cache.clear();
}
