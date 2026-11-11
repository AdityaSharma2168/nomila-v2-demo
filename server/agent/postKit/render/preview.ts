/**
 * agent/postKit/render/preview.ts — writing postKit.preview onto the action's own decision row, and only ever onto the
 * kit it was asked for. Every write re-reads the row and writes conditionally on it (DecisionPatch.ifUnchanged); a row
 * that moved in between is re-read and tried again (a concurrent caption edit does not lose the preview), and a render
 * whose key is no longer the kit's never lands (a swap in between wins).
 *
 * Store-only: the athlete id comes from the claimed job row or the session, never from the spec or a body, and the
 * store is scoped to it — another athlete's decision is simply not found.
 */
import type { ActionDecisionDetail } from "../../../../shared/plan";
import type { PostKit, PostKitPreview, PostKitPreviewOutput, RenderNote } from "../../../../shared/postKit";
import type { AgentStore } from "../../research/store";

const ATTEMPTS = 3;

/**
 * Apply `next` to the row's kit and write it while the row is still what was read. `next` answers null to write
 * nothing. True when written.
 */
export async function writeKit(store: AgentStore, athleteId: string, decisionId: string, next: (kit: PostKit, det: ActionDecisionDetail) => PostKit | null): Promise<boolean> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const d = await store.getDecision(athleteId, decisionId);
    if (!d || d.kind !== "action") return false;
    const det = (d.detail ?? {}) as unknown as ActionDecisionDetail;
    const kit = det.prepared?.postKit;
    if (!kit) return false;
    const updated = next(kit, det);
    if (!updated) return false;
    const detail: ActionDecisionDetail = { ...det, prepared: { ...(det.prepared ?? {}), postKit: updated } };
    const written = await store.updateDecision(athleteId, decisionId, {
      detail: detail as unknown as Record<string, unknown>, ifUnchanged: { detail: d.detail ?? {}, response: d.response },
    });
    if (written) return true;
  }
  return false;
}

/** The kit's preview key now, and when it was asked for — null when the kit has none (or is gone). */
export async function currentPreview(store: AgentStore, athleteId: string, decisionId: string): Promise<PostKitPreview | null> {
  const d = await store.getDecision(athleteId, decisionId);
  if (!d || d.kind !== "action") return null;
  return (d.detail as unknown as ActionDecisionDetail | undefined)?.prepared?.postKit?.preview ?? null;
}

const merge = (a: readonly RenderNote[], b: readonly RenderNote[]): RenderNote[] => [...new Set([...a, ...b])];

/** The render for `key` finished: its outputs, its cover, anything more it left out. Written only while key is current. */
export function markReady(store: AgentStore, athleteId: string, decisionId: string, key: string, done: {
  outputs: PostKitPreviewOutput[]; coverAssetId: string | null; notes: RenderNote[]; at: Date;
}): Promise<boolean> {
  return writeKit(store, athleteId, decisionId, (kit) => kit.preview?.key !== key ? null : {
    ...kit,
    preview: {
      ...kit.preview, status: "ready", outputs: done.outputs, coverAssetId: done.coverAssetId,
      notes: merge(kit.preview.notes, done.notes), error: null, renderedAt: done.at.toISOString(),
    },
  });
}

/** The render for `key` could not be made: a sentence the athlete can read. Written only while key is current. */
export function markFailed(store: AgentStore, athleteId: string, decisionId: string, key: string, error: string, at: Date): Promise<boolean> {
  return writeKit(store, athleteId, decisionId, (kit) => kit.preview?.key !== key ? null : {
    ...kit,
    preview: { ...kit.preview, status: "failed", outputs: [], coverAssetId: null, error, renderedAt: at.toISOString() },
  });
}
