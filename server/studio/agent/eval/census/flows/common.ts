/**
 * census/flows/common — what every flow driver is handed (PR 16, R-6). Test-only.
 *
 * A flow is plain async code against the REAL router over HTTP, on PGlite, with the model and the
 * network edge stood in by the census suite's own `jest.mock`s. The client steps a screen wires in TSX
 * are replicated here from the pure client functions the screen calls — the screens themselves pull in
 * React Native and cannot be imported (docs/probes/flow-eval.md, C4).
 */
import { mediaAssets } from "../../../../../../shared/schema";
import type { db as testDb } from "../../../../../testUtils/pgliteDb";
import type { CaptureStore, Point } from "../capture";
import type { FidelityPrompt } from "../../fidelity";

/** What the stood-in model answers: its text, and — for the grounded search — the provider's citations. */
export interface ModelAnswer {
  text: string;
  grounding?: { uri: string; title: string; domain: string }[];
}

/** One kind of model call a flow expects: how to tell its prompt, where its prompt is filed, its answer. */
export interface ModelRoute {
  /** Words only this kind of prompt carries. */
  when: string;
  point: Point;
  reply: (prompt: string) => string | ModelAnswer;
}

export interface FlowCtx {
  athleteId: string;
  base: string;
  /** Every Studio flag on (true), or the pre-roadmap baseline with the six new gates off (false). */
  flagsOn: boolean;
  store: CaptureStore;
  db: typeof testDb;
  /**
   * Script the model: each call is answered by the first route whose `when` its prompt carries, and the
   * prompt is filed at that route's point. A prompt no route expects fails the flow by name.
   */
  model: (routes: readonly ModelRoute[]) => void;
  /**
   * When set, every compiled clip prompt a Board prices is collected here with its aspect — the input to
   * fidelity's code-checked half (eval/fidelity.ts). The suite sets it around flow 1 only: the flow whose
   * brief is the census's confirmed nonce campaign.
   */
  fidelity?: FidelityPrompt[];
  /** What the flow needs back from the suite's spies, drained per flow. */
  spies: {
    library: () => unknown[];
    briefInputs: () => unknown[];
  };
}

export async function post(
  ctx: Pick<FlowCtx, "base">,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${ctx.base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  };
}

export async function get(
  ctx: Pick<FlowCtx, "base">,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${ctx.base}${path}`);
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  };
}

/** One row of her library, synthetic. Returns its id. */
export async function seedAsset(
  ctx: Pick<FlowCtx, "athleteId" | "db">,
  o: {
    mediaType: "IMAGE" | "VIDEO";
    vision: unknown;
    origin?: string;
    durationSeconds?: number;
    embedding?: number[];
  },
): Promise<string> {
  const [row] = await ctx.db
    .insert(mediaAssets)
    .values({
      athlete_id: ctx.athleteId,
      platform: "studio",
      origin: o.origin ?? "upload",
      media_type: o.mediaType,
      status: "stored",
      gcs_path: `athletes/${ctx.athleteId}/census-${Math.random().toString(36).slice(2)}.${o.mediaType === "VIDEO" ? "mp4" : "jpg"}`,
      gcs_thumb_path:
        o.mediaType === "VIDEO"
          ? `athletes/${ctx.athleteId}/census-${Math.random().toString(36).slice(2)}-poster.jpg`
          : null,
      content_type: o.mediaType === "VIDEO" ? "video/mp4" : "image/jpeg",
      duration_seconds: o.durationSeconds ?? null,
      ingested_at: new Date(),
      metadata: { vision: o.vision, embedding: o.embedding ?? [1, 0, 0] },
    } as typeof mediaAssets.$inferInsert)
    .returning({ id: mediaAssets.id });
  return row.id;
}

/** The library ref the planner was shown for the row whose line carries `token`. */
export function refFor(prompt: string, token: string): string {
  const line = prompt
    .split("\n")
    .find((l) => l.includes(token) && / \| /.test(l));
  const ref = line?.trim().split(" |")[0]?.trim();
  if (!ref) throw new Error(`census: no library line carries ${token}`);
  return ref;
}
