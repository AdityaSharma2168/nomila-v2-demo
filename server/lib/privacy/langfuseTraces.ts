/**
 * langfuseTraces.ts — delete an athlete's Langfuse traces on account deletion.
 *
 * Traces are tagged userId = her athlete id (server/lib/tracing.ts withTraceAthlete: every request she makes and
 * every workflow step run for her). This finds her trace ids through the v2 observations API filtered by userId
 * (the v1 GET /api/public/traces list is deprecated on Langfuse Cloud), then deletes them with
 * DELETE /api/public/traces { traceIds } in batches. Langfuse processes deletions asynchronously.
 *
 * Runs whenever the API keys are set, whatever LANGFUSE_TRACING says now: traces written while tracing was on still
 * exist after it is switched off. Never throws; the outcome goes on the deletion receipt.
 *
 * Limits (documented in EXTERNAL_STORES): traces written before userId tagging, or by background work outside her
 * request / workflow context, carry no userId and cannot be found here — they age out under the project's
 * data-retention setting.
 */

import { createLogger } from "../../logger";

const logger = createLogger("privacy/langfuseTraces");

export type TracePurgeOutcome = "deleted" | "none_found" | "not_configured" | "failed";

export interface TracePurgeResult {
  outcome: TracePurgeOutcome;
  /** Trace ids found for her (and, when outcome is "deleted", submitted for deletion). */
  traces:  number;
  detail?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const PAGE_LIMIT = 1000;      // the v2 observations maximum
const MAX_PAGES = 100;        // 100k observations; anything beyond is reported, not silently dropped
const DELETE_BATCH = 500;
const TIMEOUT_MS = 10_000;

export function langfuseConfigured(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim());
}

export async function deleteAthleteTraces(athleteId: string, fetchImpl: FetchLike = fetch): Promise<TracePurgeResult> {
  if (!langfuseConfigured()) return { outcome: "not_configured", traces: 0 };
  const baseUrl = (process.env.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY!.trim()}:${process.env.LANGFUSE_SECRET_KEY!.trim()}`).toString("base64");

  const traceIds = new Set<string>();
  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const url = new URL(`${baseUrl}/api/public/v2/observations`);
      url.searchParams.set("userId", athleteId);
      url.searchParams.set("fields", "core");
      url.searchParams.set("limit", String(PAGE_LIMIT));
      url.searchParams.set("fromStartTime", "2020-01-01T00:00:00Z");
      url.searchParams.set("toStartTime", new Date().toISOString());
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetchImpl(url.toString(), { headers: { Authorization: auth }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return { outcome: "failed", traces: traceIds.size, detail: `langfuse list ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ traceId?: string | null }>; meta?: { cursor?: string } };
      for (const o of body.data ?? []) if (o.traceId) traceIds.add(o.traceId);
      cursor = body.meta?.cursor || undefined;
      if (++pages >= MAX_PAGES && cursor) {
        return { outcome: "failed", traces: traceIds.size, detail: `more than ${MAX_PAGES * PAGE_LIMIT} observations; nothing deleted, rerun` };
      }
    } while (cursor);

    if (traceIds.size === 0) return { outcome: "none_found", traces: 0 };

    const ids = [...traceIds];
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const res = await fetchImpl(`${baseUrl}/api/public/traces`, {
        method: "DELETE",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ traceIds: ids.slice(i, i + DELETE_BATCH) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { outcome: "failed", traces: ids.length, detail: `langfuse delete ${res.status} after ${i} of ${ids.length}` };
    }
    return { outcome: "deleted", traces: ids.length };
  } catch (err: any) {
    logger.warn({ athleteId, error: err?.message?.slice(0, 200) }, "Langfuse trace deletion failed (best-effort)");
    return { outcome: "failed", traces: traceIds.size, detail: String(err?.message ?? err).slice(0, 120) };
  }
}
