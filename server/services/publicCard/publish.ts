/**
 * publicCard/publish.ts — the publish model (design-public-card-v3 §10): her card row, the freeze into immutable
 * versions, removals, numbers refreshes and unpublish.
 *
 *   ensureCard(athleteId)                 her row (created on first use, every switch at its default)
 *   publishSnapshot(athleteId, input)     HER tap: freeze content + sources into version N+1 and switch the URL to it in
 *                                         the same transaction (atomic). Proposes a handle from her name if she has
 *                                         none. Refused while PUBLIC_CARD is off.
 *   publishNumbersRefresh(athleteId, …)   the weekly stat refresh: same items, new numbers only (kind numbers_only).
 *   publishRemoval(athleteId, …)          something must leave at once (an undone signed deal, deleted media, a door
 *                                         switched off …): version N+1 with the items gone (kind removal). Removals
 *                                         never add anything, and carry a note she is shown.
 *   unpublish(athleteId)                  one tap: the URL stops serving and every snapshot is deleted. Her handle
 *                                         stays hers; versions keep counting from last_version.
 *
 * Rows in public_card_snapshots are never updated (publicCard.boundary.test.ts holds every writer to inserts and
 * deletes). Removals and unpublish work with the flag off: pulling something is always allowed.
 * Nothing here names an athlete, sport, school, league or brand.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { athletes, publicCardSnapshots, publicCards, type PublicCard } from "../../../shared/schema";
import { publicCardEnabled } from "./config";
import { sanitizeSnapshot } from "./contactFilter";
import { proposeHandle } from "./handles";
import {
  DOORS, DUPLICATE_TILES_REASON, PUBLIC_CARD_CONTENT_SCHEMA, canonicalJson, contentItems, fallbackButton, tilesFor, validateSnapshot,
  type Door, type PublicCardContent, type PublicCardSources, type SnapshotKind,
} from "./types";

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Client = Db | Tx;

export class PublicCardError extends Error {
  constructor(public readonly code: "disabled" | "needs_handle" | "not_published" | "invalid", message: string, public readonly status = 409) {
    super(message);
    this.name = "PublicCardError";
  }
}

export const contentHash = (c: PublicCardContent): string => createHash("sha256").update(canonicalJson(c)).digest("hex");

/** Her switches as a door map. */
export function switchesOf(card: Pick<PublicCard, "door_partner" | "door_book" | "door_shop" | "door_create" | "door_ask_mila">): Record<Door, boolean> {
  return { partner: card.door_partner, book: card.door_book, shop: card.door_shop, create: card.door_create, ask_mila: card.door_ask_mila };
}

export async function ensureCard(athleteId: string, opts: { db?: Client } = {}): Promise<PublicCard> {
  const db = opts.db ?? defaultDb;
  await db.insert(publicCards).values({ athlete_id: athleteId }).onConflictDoNothing({ target: publicCards.athlete_id });
  const [row] = await db.select().from(publicCards).where(eq(publicCards.athlete_id, athleteId));
  return row;
}

async function lockCard(tx: Tx, athleteId: string): Promise<PublicCard> {
  await tx.insert(publicCards).values({ athlete_id: athleteId }).onConflictDoNothing({ target: publicCards.athlete_id });
  const [row] = await tx.select().from(publicCards).where(eq(publicCards.athlete_id, athleteId)).for("update");
  return row;
}

async function writeVersion(tx: Tx, card: PublicCard, v: {
  kind: SnapshotKind; content: PublicCardContent; sources: PublicCardSources; media: SnapshotMedia; note?: string | null; approvedByUserId?: string | null; now: Date;
}): Promise<number> {
  const version = card.last_version + 1;
  // No contact details are ever frozen (contactFilter.ts): every version, whatever wrote it, is filtered first.
  const clean = sanitizeSnapshot(v.content, v.sources);
  await tx.insert(publicCardSnapshots).values({
    athlete_id: card.athlete_id, version, kind: v.kind, content: clean.content, sources: clean.sources, media: v.media,
    content_sha256: contentHash(clean.content), note: v.note ?? null, approved_by_user_id: v.approvedByUserId ?? null, published_at: v.now,
  });
  await tx.update(publicCards).set({
    status: "published", published_version: version, last_version: version, updated_at: v.now,
    ...(v.kind === "full" ? { published_at: v.now, unpublished_at: null } : {}),
  }).where(eq(publicCards.athlete_id, card.athlete_id));
  return version;
}

/** Server-only: opaque media key → the stored object it stands for. Never served; the media proxy reads one entry. */
export type SnapshotMedia = Record<string, { path: string; kind: "image" | "video" }>;

/** Every media key in content has exactly one stored object, and the map holds nothing else. */
function checkMedia(content: PublicCardContent, media: SnapshotMedia): void {
  const keys = new Set(contentItems(content).map((i) => i.mediaKey).filter((k): k is string => !!k));
  for (const k of keys) if (!media[k]?.path) throw new PublicCardError("invalid", `The draft cannot be published: media ${k} has no stored object`, 422);
  for (const k of Object.keys(media)) if (!keys.has(k)) throw new PublicCardError("invalid", `The draft cannot be published: media ${k} is not on the card`, 422);
}

export interface PublishInput {
  content: PublicCardContent;
  sources: PublicCardSources;
  /** The stored object behind each media key in content (empty when the card shows no media). */
  media?: SnapshotMedia;
  /** The signed-in user who tapped Publish (req.userId). */
  approvedByUserId?: string | null;
}

export interface PublishResult { version: number; handle: string; contentSha256: string; content: PublicCardContent }

/** HER publish: freeze the draft into version N+1 and switch the URL to it, atomically. */
export async function publishSnapshot(athleteId: string, input: PublishInput, opts: { db?: Db; now?: Date } = {}): Promise<PublishResult> {
  if (!publicCardEnabled()) throw new PublicCardError("disabled", "The public card is not available yet.", 404);
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  // Contact details never reach a snapshot, even if a caller hands in content the draft builder did not filter.
  const { content, sources } = sanitizeSnapshot(input.content, input.sources);
  return db.transaction(async (tx) => {
    const card = await lockCard(tx, athleteId);
    try {
      validateSnapshot(content, sources, { showMia: card.show_mia, switches: switchesOf(card) });
    } catch (err: any) {
      throw new PublicCardError("invalid", err.message === DUPLICATE_TILES_REASON ? DUPLICATE_TILES_REASON : `The draft cannot be published: ${err.message}`, 422);
    }
    const media = input.media ?? {};
    checkMedia(content, media);
    let handle = card.handle;
    if (!handle) {
      const [a] = await tx.select({ full_name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId));
      handle = await proposeHandle(athleteId, content.displayName || a?.full_name || "", { db: tx, now });
      if (!handle) throw new PublicCardError("needs_handle", "Pick a handle before publishing.");
      await tx.update(publicCards).set({ handle, updated_at: now }).where(eq(publicCards.athlete_id, athleteId));
    }
    const version = await writeVersion(tx, card, { kind: "full", content, sources, media, approvedByUserId: input.approvedByUserId, now });
    return { version, handle, contentSha256: contentHash(content), content };
  });
}

async function currentSnapshot(tx: Tx, card: PublicCard) {
  if (card.status !== "published" || card.published_version == null) return null;
  const [snap] = await tx.select().from(publicCardSnapshots)
    .where(and(eq(publicCardSnapshots.athlete_id, card.athlete_id), eq(publicCardSnapshots.version, card.published_version)));
  return snap ?? null;
}

/** Her currently published content (server side; not a public read), or null when nothing is published. */
export async function publishedContent(athleteId: string, opts: { db?: Db } = {}): Promise<PublicCardContent | null> {
  const db = opts.db ?? defaultDb;
  const [row] = await db.select({ content: publicCardSnapshots.content }).from(publicCards)
    .innerJoin(publicCardSnapshots, and(eq(publicCardSnapshots.athlete_id, publicCards.athlete_id), eq(publicCardSnapshots.version, publicCards.published_version)))
    .where(and(eq(publicCards.athlete_id, athleteId), eq(publicCards.status, "published")));
  return (row?.content as PublicCardContent | undefined) ?? null;
}

/** The weekly refresh of stats she already chose: numbers and their "as of" only. Null when nothing changed. */
export async function publishNumbersRefresh(
  athleteId: string, values: Record<string, { value: number; asOf: string }>, opts: { db?: Db; now?: Date } = {},
): Promise<number | null> {
  if (!publicCardEnabled()) return null;
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const card = await lockCard(tx, athleteId);
    const snap = await currentSnapshot(tx, card);
    if (!snap) return null;
    const content = structuredClone(snap.content as PublicCardContent);
    let changed = false;
    for (const it of contentItems(content)) {
      const next = values[it.key];
      if (it.kind !== "stat" || !next || !Number.isFinite(next.value)) continue;
      if (it.value !== next.value || it.asOf !== next.asOf) { it.value = next.value; it.asOf = next.asOf; changed = true; }
    }
    if (!changed) return null;
    return writeVersion(tx, card, { kind: "numbers_only", content, sources: snap.sources as PublicCardSources, media: snap.media as SnapshotMedia, now });
  });
}

export interface RemovalInput {
  /** Items to pull (by key). */
  itemKeys?: string[];
  /** Doors to close (her switch went off, an offer paused, her shelf closed …). */
  closeDoors?: Door[];
  /** Pull the M.I.A. block (she switched show_mia off). */
  dropMia?: boolean;
  /** Why, in words she is shown. */
  reason: string;
}

/**
 * A removal: version N+1 with the named things gone. Never adds content: the grid is re-resolved (a closed door's
 * slot takes the resolver's fallback), a button pointing at a closed door falls back (§3), a chapter left empty leaves
 * (except Highlights), and closing Book or Shop takes its offers or picks with it. A removal is never refused, even when the
 * resolver must repeat a tile: pulling something always wins. Null when the card is not published or nothing would change.
 */
export async function publishRemoval(athleteId: string, input: RemovalInput, opts: { db?: Db; now?: Date } = {}): Promise<number | null> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const card = await lockCard(tx, athleteId);
    const snap = await currentSnapshot(tx, card);
    if (!snap) return null;
    const before = snap.content as PublicCardContent;
    const content = structuredClone(before);
    const drop = new Set(input.itemKeys ?? []);
    const close = new Set((input.closeDoors ?? []).filter((d) => content.doors[d]));

    for (const d of close) content.doors[d] = false;
    if (close.has("book")) for (const o of content.offers) drop.add(o.key);
    if (close.has("shop")) for (const p of content.picks) drop.add(p.key);
    content.chapters = content.chapters
      .map((ch) => ({ ...ch, items: ch.items.filter((it) => !drop.has(it.key)) }))
      .filter((ch) => ch.key === "highlights" || ch.items.length > 0);
    content.offers = content.offers.filter((o) => !drop.has(o.key));
    content.picks = content.picks.filter((p) => !drop.has(p.key));
    content.chapters = content.chapters.map((ch) => ({
      ...ch, button: ch.button && !content.doors[ch.button.door] ? fallbackButton(ch.button.door, content.doors, content.firstName) : ch.button,
    }));
    // The grid is re-resolved by the renderer's own resolver for what is left (a closed door falls back).
    content.tiles = tilesFor(content);
    if (input.dropMia) content.mia = null;

    if (canonicalJson(content) === canonicalJson(before)) return null;
    const kept = new Set(contentItems(content).map((it) => it.key));
    const prior = snap.sources as PublicCardSources;
    const sources: PublicCardSources = { ...prior, items: Object.fromEntries(Object.entries(prior.items).filter(([k]) => kept.has(k))) };
    // Removals never add: every item left was in the version before, unchanged.
    const was = new Map(contentItems(before).map((it) => [it.key, canonicalJson(it)]));
    if (contentItems(content).some((it) => was.get(it.key) !== canonicalJson(it))) throw new Error("a removal may not add or change an item");
    const keptMedia = new Set(contentItems(content).map((i) => i.mediaKey).filter(Boolean));
    const media = Object.fromEntries(Object.entries(snap.media as SnapshotMedia).filter(([k]) => keptMedia.has(k)));
    return writeVersion(tx, card, { kind: "removal", content, sources, media, note: input.reason.slice(0, 500), now });
  });
}

/** One tap off: the URL stops serving and every snapshot is deleted. True when something was published. */
export async function unpublish(athleteId: string, opts: { db?: Db; now?: Date } = {}): Promise<boolean> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const card = await lockCard(tx, athleteId);
    const wasPublished = card.status === "published";
    await tx.delete(publicCardSnapshots).where(eq(publicCardSnapshots.athlete_id, athleteId));
    if (card.status !== "draft" || wasPublished) {
      await tx.update(publicCards).set({ status: "unpublished", published_version: null, unpublished_at: now, updated_at: now })
        .where(eq(publicCards.athlete_id, athleteId));
    }
    return wasPublished;
  });
}

/** Re-exported so callers build content with the right tag. */
export { DOORS, PUBLIC_CARD_CONTENT_SCHEMA, canonicalJson };
