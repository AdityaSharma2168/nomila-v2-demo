/**
 * publicCard/service.ts — her side of the public card: read the draft, record her decisions, preview, publish,
 * unpublish, switches, handle, and the "pulled at once" reconcile (design-public-card-v3 §10).
 *
 * Every function takes the athlete id from the caller (the route passes req.athleteId from the token — never a body
 * field), and every read and write is keyed by it.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { publicCards, type PublicCard } from "../../../shared/schema";
import { PUBLIC_CARD, publicCardEnabled } from "./config";
import { buildDraft, type BuiltDraft, type CardSettings } from "./draft";
import { gatherDraftInputs } from "./gather";
import { setHandle } from "./handles";
import { PublicCardError, ensureCard, publishRemoval, publishSnapshot, switchesOf, unpublish } from "./publish";
import { etagOf, type PublicCardPublishResponse, type DraftDecisions, type Door, type PublicCardContent, type PublicCardDraftResponse, type PublicCardState, type PublicCardSwitches } from "./types";

const DAY = 86_400_000;

export function assertEnabled(): void {
  if (!publicCardEnabled()) throw new PublicCardError("disabled", "The public card is not available yet.", 404);
}

export function settingsOf(card: PublicCard): CardSettings {
  return { decisions: (card.draft ?? {}) as DraftDecisions, switches: switchesOf(card), showMia: card.show_mia };
}

export function stateOf(card: PublicCard, now = new Date()): PublicCardState {
  const next = card.handle && card.handle_changed_at ? new Date(card.handle_changed_at.getTime() + PUBLIC_CARD.handleChangeDays * DAY) : null;
  return {
    handle: card.handle,
    status: card.status as PublicCardState["status"],
    publishedVersion: card.published_version,
    publishedAt: card.published_at?.toISOString() ?? null,
    handleChangeAvailableAt: next && next > now ? next.toISOString() : null,
    switches: {
      partner: card.door_partner, book: card.door_book, shop: card.door_shop, create: card.door_create,
      askMila: card.door_ask_mila, showMia: card.show_mia, indexable: card.indexable,
    },
  };
}

async function built(athleteId: string, now = new Date()): Promise<{ card: PublicCard; draft: BuiltDraft }> {
  const card = await ensureCard(athleteId);
  const inputs = await gatherDraftInputs(athleteId, { showMia: card.show_mia, now });
  return { card, draft: buildDraft(inputs, settingsOf(card), athleteId) };
}

function response(card: PublicCard, d: BuiltDraft): PublicCardDraftResponse {
  return { card: stateOf(card), availability: d.availability, chapters: d.chapters, offers: d.offers, picks: d.picks, cut: d.cut, canPublish: d.canPublish, blockedReason: d.blockedReason };
}

export async function getDraft(athleteId: string): Promise<PublicCardDraftResponse> {
  assertEnabled();
  const { card, draft } = await built(athleteId);
  return response(card, draft);
}

export async function saveDecisions(athleteId: string, decisions: DraftDecisions): Promise<PublicCardDraftResponse> {
  assertEnabled();
  await ensureCard(athleteId);
  await db.update(publicCards).set({ draft: decisions, updated_at: new Date() }).where(eq(publicCards.athlete_id, athleteId));
  return getDraft(athleteId);
}

export async function getPreview(athleteId: string): Promise<{ handle: string | null; content: PublicCardContent }> {
  assertEnabled();
  const { card, draft } = await built(athleteId);
  return { handle: card.handle, content: draft.preview.content };
}

/** Her tap: freeze what the preview shows now. Returns the page exactly as a visitor now gets it. */
export async function publishDraft(athleteId: string, userId: string | null): Promise<PublicCardPublishResponse> {
  assertEnabled();
  const { draft } = await built(athleteId);
  if (!draft.canPublish) throw new PublicCardError("invalid", draft.blockedReason ?? "This draft cannot be published yet", 422);
  const { content: draftContent, sources, media } = draft.preview;
  const r = await publishSnapshot(athleteId, { content: draftContent, sources, media, approvedByUserId: userId });
  const content = r.content;
  const card = await ensureCard(athleteId);
  return {
    version: r.version, handle: r.handle,
    page: { status: "ok", handle: r.handle, version: r.version, etag: etagOf(r.version, r.contentSha256), publishedAt: card.published_at!.toISOString(), indexable: card.indexable, content },
  };
}

export async function unpublishCard(athleteId: string): Promise<boolean> {
  assertEnabled();
  return unpublish(athleteId);
}

const SWITCH_COLUMN: Record<keyof PublicCardSwitches, keyof PublicCard> = {
  partner: "door_partner", book: "door_book", shop: "door_shop", create: "door_create", askMila: "door_ask_mila",
  showMia: "show_mia", indexable: "indexable",
};
const SWITCH_DOOR: Partial<Record<keyof PublicCardSwitches, Door>> = { partner: "partner", book: "book", shop: "shop", create: "create", askMila: "ask_mila" };

/**
 * Her switches. Turning something ON only changes the next draft (a door on needs a new publish, §10). Turning a
 * door or show_mia OFF on a published card pulls it at once with a removal version. `indexable` is read live.
 */
export async function setSwitches(athleteId: string, patch: Partial<PublicCardSwitches>): Promise<{ switches: PublicCardSwitches; removalVersion: number | null }> {
  assertEnabled();
  const before = await ensureCard(athleteId);
  const set: Record<string, unknown> = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch) as [keyof PublicCardSwitches, boolean][]) set[SWITCH_COLUMN[k]] = v;
  await db.update(publicCards).set(set).where(eq(publicCards.athlete_id, athleteId));
  const closeDoors = (Object.entries(patch) as [keyof PublicCardSwitches, boolean][])
    .filter(([k, v]) => SWITCH_DOOR[k] && v === false && before[SWITCH_COLUMN[k]] === true).map(([k]) => SWITCH_DOOR[k]!);
  const dropMia = patch.showMia === false && before.show_mia;
  let removalVersion: number | null = null;
  if (before.status === "published" && (closeDoors.length || dropMia)) {
    removalVersion = await publishRemoval(athleteId, { closeDoors, dropMia, reason: "You switched this off, so it came off your public card." });
  }
  const after = await ensureCard(athleteId);
  return { switches: stateOf(after).switches, removalVersion };
}

export async function changeHandle(athleteId: string, handle: unknown): Promise<{ handle: string; handleChangeAvailableAt: string | null }> {
  assertEnabled();
  await ensureCard(athleteId);
  const h = await db.transaction((tx) => setHandle(tx, athleteId, handle));
  const card = await ensureCard(athleteId);
  return { handle: h, handleChangeAvailableAt: stateOf(card).handleChangeAvailableAt };
}
