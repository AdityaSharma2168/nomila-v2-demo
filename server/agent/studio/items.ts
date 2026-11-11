/**
 * agent/studio/items.ts — the Studio library's real data: GET /me/agent/studio/items (client/lib/agent/api.ts
 * AGENT_ENDPOINTS.studioItems), which the client has always called and always 404'd on (its comment: "the Studio
 * library's fallback until studioItems lands" — client/lib/agent/api.ts pitchesToStudioItems). This is that route's
 * logic, built once post kits exist (design "Moments → post kits" §12, build step 5).
 *
 *   deckItems       today's decks (services/pitches.ts listPitches), mapped the SAME way the client's fallback does
 *                   (pitchesToStudioItems) — ported, not reinvented, so turning this route on never changes what a
 *                   deck looks like in the library.
 *   postKitItems    a post action decision (kind "action", detail.kind "post") with a built kit (detail.prepared.postKit)
 *                   as a StudioItem of kind "post_kit" — design §9: made -> draft, done -> published. Only an action
 *                   that is still open or was answered (pending · accepted · edited): an expired or skipped one is
 *                   closed, and its kit screen would only say so. The newest POST_KIT_ITEMS_MAX kits, one goals read
 *                   and one media read for all of them. Dark behind AGENT_POST_KITS: when it is off, post kits
 *                   contribute nothing and only decks show (byte-identical to today's fallback).
 *   listStudioItems both, newest first.
 *
 * A StudioItem with no kit built yet (state to_start: nothing prepared) is not listed — there is nothing to show.
 */
import type { Decision } from "../../../shared/agent";
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import type { Pitch } from "../../services/pitches";
import { agentPostKitsEnabled } from "../postKit/config";
import type { PostKitMedia } from "../postKit/build";
import type { CastableRow } from "../../studio/agent/cast";
import type { AgentStore } from "../research/store";

/** The wire shape (client/lib/agent/types.ts StudioItem) — duplicated here deliberately: the server never imports client/. */
export interface StudioItemWire {
  id: string;
  kind: "deck" | "post_kit" | "page" | "media_edit";
  title: string;
  status: "draft" | "approved" | "published" | "experimental";
  version: number;
  goal: { id: string; text: string } | null;
  thumbUrl: string | null;
  updatedAt: string;
  meta: string | null;
  open: { screen: string; params?: Record<string, unknown> } | { url: string } | null;
  /** A deck's brand logo (the pitch's brand), for the Studio shelf's deck thumbnail. */
  logoUrl?: string | null;
  /** A post kit's plan hook: Home titles the post by it, so Studio does too (client homeV3Logic postTitle). */
  hook?: string | null;
  /** A post kit's format (reel, carousel, feed, story). */
  format?: string | null;
  /** A post kit's due day (YYYY-MM-DD), when the plan set one. */
  dueOn?: string | null;
  /** True while Mila is still making the kit's preview (shown as "Mila's working"). */
  working?: boolean;
}

export interface StudioItemsDeps {
  store: AgentStore;
  media: Pick<PostKitMedia, "load" | "urls">;
  pitches: (athleteId: string) => Promise<Pitch[]>;
}

/** Today's decks, exactly as the client's own fallback mapped them (api.ts pitchesToStudioItems) — ported, not changed. */
export function deckItems(pitches: readonly Pitch[]): StudioItemWire[] {
  return pitches.map((p) => ({
    id: `deck-${p.brandId}`,
    kind: "deck",
    title: p.brandName,
    status: p.status === "sent" || p.status === "opened" ? "published" : p.status === "ready" ? "approved" : "draft",
    version: 1,
    goal: null,
    thumbUrl: null,
    updatedAt: p.sentAt ?? p.generatedAt ?? "",
    meta: p.status === "opened" && p.opensCount > 0 ? `Opened ${p.opensCount} ${p.opensCount === 1 ? "time" : "times"}` : null,
    open: p.hostedUrl ? { url: p.hostedUrl } : { screen: "PitchDetail", params: { brandId: p.brandId, brandName: p.brandName } },
    logoUrl: p.brandLogo ?? null,
  }));
}

/** The most post kits the library lists (newest first): a bound on the read, far above what a plan makes in a season. */
export const POST_KIT_ITEMS_MAX = 50;

/** The answers a listed kit's action may carry: still open, or answered by her. Expired and skipped are closed. */
const LISTED_RESPONSES: Decision["response"][] = ["pending", "accepted", "edited"];

/** A post action with its built kit, or null (not a post, or nothing built yet: state to_start, nothing to show). */
function builtKit(a: Decision): { a: Decision; det: Partial<ActionDecisionDetail>; kit: PostKit } | null {
  const det = (a.detail ?? {}) as Partial<ActionDecisionDetail>;
  if (det.kind !== "post") return null;
  const kit = det.prepared?.postKit as PostKit | undefined;
  return kit ? { a, det, kit } : null;
}

/** Every built post kit, newest first, at most POST_KIT_ITEMS_MAX (AGENT_POST_KITS on only — off contributes nothing). */
async function postKitItems(athleteId: string, deps: StudioItemsDeps): Promise<StudioItemWire[]> {
  if (!agentPostKitsEnabled()) return [];
  const actions = await deps.store.listDecisions(athleteId, { kinds: ["action"], responses: LISTED_RESPONSES });
  const built = actions.map(builtKit).filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((x, y) => y.kit.updatedAt.localeCompare(x.kit.updatedAt))
    .slice(0, POST_KIT_ITEMS_MAX);
  if (!built.length) return [];
  // One read each for every kit's goal and first asset (not one per kit). Dropped goals included: a kit made for a
  // goal she later dropped still says which goal it was for.
  const firstIds = [...new Set(built.map((b) => b.kit.assets[0]?.assetId).filter((id): id is string => !!id))];
  const [goals, rows] = await Promise.all([
    deps.store.listGoals(athleteId, { includeDropped: true }),
    firstIds.length ? deps.media.load(athleteId, firstIds) : Promise.resolve(new Map<string, CastableRow>()),
  ]);
  const goalById = new Map(goals.map((g) => [g.id, g]));
  return Promise.all(built.map(async ({ a, det, kit }): Promise<StudioItemWire> => {
    const row = kit.assets[0] ? rows.get(kit.assets[0].assetId) : undefined;
    const goal = a.goalId ? goalById.get(a.goalId) : undefined;
    return {
      id: a.id,
      kind: "post_kit",
      title: det.what || a.suggested,
      status: a.response === "accepted" || a.response === "edited" ? "published" : "draft",
      version: 1,
      goal: goal ? { id: goal.id, text: goal.text } : null,
      thumbUrl: row ? (await deps.media.urls(row)).thumbUrl : null,
      updatedAt: kit.updatedAt,
      meta: kit.aiGenerationNeeded.value ? "Needs media" : null,
      open: { screen: "post-kit", params: { id: a.id } },
      hook: det.post?.hook ?? null,
      format: kit.idea?.format ?? null,
      dueOn: det.dueOn ?? null,
      working: kit.preview?.status === "queued",
    };
  }));
}

/** Decks and post kits, newest first (an item with no date sorts last, not first). */
export async function listStudioItems(athleteId: string, deps: StudioItemsDeps): Promise<StudioItemWire[]> {
  const [decks, kits] = await Promise.all([deps.pitches(athleteId).then(deckItems), postKitItems(athleteId, deps)]);
  return [...decks, ...kits].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
