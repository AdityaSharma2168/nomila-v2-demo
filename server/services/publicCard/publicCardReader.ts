/**
 * publicCardReader.ts — THE ONE READ the public side may make (design-public-card-v3 §11 "One reader").
 *
 * Every public surface (the /p/:handle page, the media proxy, Mila's public read_card tool) reads through this module
 * and nothing else. It returns ONLY the published snapshot's content, never the draft, the sources manifest, her
 * switches beyond the search switch, or any other table. Visitors never trigger a query against her private data.
 *
 *   mediaObject(handle, key)  the stored object behind one media key of the published version (the media proxy)
 *   read(handle)  →  { status: "ok", … }           her published version
 *                 →  { status: "redirect", to }    an old handle inside its 90 days, while her card is published
 *                 →  { status: "not_found" }        unknown, unpublished, deleted, malformed, or PUBLIC_CARD off —
 *                                                   all the same answer, so a miss says nothing
 *
 * It touches exactly three tables: public_cards (handle, status, published_version, indexable, athlete_id),
 * public_card_snapshots (content, version, content_sha256, published_at; media for mediaObject only) and
 * public_card_handle_redirects.
 * publicCard.boundary.test.ts proves it, statically (imports) and by capturing every SQL statement it runs.
 *
 * Every content read passes the contact-detail filter (contactFilter.ts sanitizeSnapshot), so a version frozen before
 * the filter existed still shows no email, phone, address, URL or handle on the page, to Ask Mila or to the Partner door.
 *
 * `athleteId` is returned for SERVER use only (a public write resolves her id from the handle on the server, §11
 * tenant isolation); a renderer must never print it.
 */
import { and, eq, gt } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { publicCardHandleRedirects, publicCardSnapshots, publicCards } from "../../../shared/schema";
import { publicCardEnabled } from "./config";
import { sanitizeSnapshot } from "./contactFilter";
import { validateHandle } from "./handles";
import { etagOf, type PublicCardContent, type PublicCardPage } from "./types";

type Db = typeof defaultDb;

/** The shared page shape (shared/publicCard.ts), plus her id on "ok" for server use only (never serialised). */
export type PublicCardRead =
  | (Extract<PublicCardPage, { status: "ok" }> & { athleteId: string })
  | Exclude<PublicCardPage, { status: "ok" }>;

/** What a public route may send: the read without the server-only id. */
export function toPage(r: PublicCardRead): PublicCardPage {
  if (r.status !== "ok") return r;
  const { athleteId: _server, ...page } = r;
  return page;
}

const NOT_FOUND: PublicCardRead = { status: "not_found" };

async function published(db: Db, where: ReturnType<typeof eq>) {
  const [row] = await db.select({
    athlete_id: publicCards.athlete_id, handle: publicCards.handle, indexable: publicCards.indexable,
    version: publicCardSnapshots.version, content: publicCardSnapshots.content,
    content_sha256: publicCardSnapshots.content_sha256, published_at: publicCardSnapshots.published_at,
  }).from(publicCards)
    .innerJoin(publicCardSnapshots, and(eq(publicCardSnapshots.athlete_id, publicCards.athlete_id), eq(publicCardSnapshots.version, publicCards.published_version)))
    .where(and(where, eq(publicCards.status, "published")))
    .limit(1);
  return row ?? null;
}

export async function read(rawHandle: unknown, opts: { db?: Db; now?: Date } = {}): Promise<PublicCardRead> {
  if (!publicCardEnabled()) return NOT_FOUND;
  const v = validateHandle(rawHandle);
  if (!v.ok) return NOT_FOUND;
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();

  const row = await published(db, eq(publicCards.handle, v.handle));
  if (row?.handle) {
    // A version frozen with contact details in it is served filtered, under its own ETag so no cache keeps the old copy.
    const clean = sanitizeSnapshot(row.content as PublicCardContent);
    const etag = etagOf(row.version, row.content_sha256);
    return {
      status: "ok", handle: row.handle, version: row.version, etag: clean.changed ? etag.replace(/"$/, '-f"') : etag,
      publishedAt: row.published_at.toISOString(), indexable: row.indexable, content: clean.content, athleteId: row.athlete_id,
    };
  }

  const [redirect] = await db.select({ athlete_id: publicCardHandleRedirects.athlete_id }).from(publicCardHandleRedirects)
    .where(and(eq(publicCardHandleRedirects.handle, v.handle), gt(publicCardHandleRedirects.expires_at, now))).limit(1);
  if (!redirect) return NOT_FOUND;
  const [target] = await db.select({ handle: publicCards.handle }).from(publicCards)
    .where(and(eq(publicCards.athlete_id, redirect.athlete_id), eq(publicCards.status, "published"))).limit(1);
  return target?.handle && target.handle !== v.handle ? { status: "redirect", to: target.handle } : NOT_FOUND;
}

/** An opaque media key as the draft builder mints it (draft.ts mediaKeyOf). */
const MEDIA_KEY = /^m[0-9a-f]{20}$/;

/**
 * The one other public read (§11 "Media"): the stored object behind a media key, ONLY when that key is in the
 * published version of this handle. Null for anything else (unknown handle, unpublished, a key from an older version,
 * a malformed key, flag off). The caller signs a short-lived URL for it; the object path never reaches the page.
 */
export async function mediaObject(rawHandle: unknown, rawKey: unknown, opts: { db?: Db } = {}): Promise<{ path: string; kind: "image" | "video" } | null> {
  if (!publicCardEnabled()) return null;
  const v = validateHandle(rawHandle);
  if (!v.ok || typeof rawKey !== "string" || !MEDIA_KEY.test(rawKey)) return null;
  const db = opts.db ?? defaultDb;
  const [row] = await db.select({ media: publicCardSnapshots.media }).from(publicCards)
    .innerJoin(publicCardSnapshots, and(eq(publicCardSnapshots.athlete_id, publicCards.athlete_id), eq(publicCardSnapshots.version, publicCards.published_version)))
    .where(and(eq(publicCards.handle, v.handle), eq(publicCards.status, "published")))
    .limit(1);
  const hit = (row?.media as Record<string, { path?: unknown; kind?: unknown }> | undefined)?.[rawKey];
  return hit && typeof hit.path === "string" && (hit.kind === "image" || hit.kind === "video") ? { path: hit.path, kind: hit.kind } : null;
}

export const publicCardReader = { read, mediaObject };
