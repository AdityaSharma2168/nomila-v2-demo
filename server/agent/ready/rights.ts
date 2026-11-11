/**
 * agent/ready/rights.ts — the athlete's word that they may post their media, asked on "Post it" (content engine step 2;
 * owner decision 9 Nov 2026: "once per source asset, remembered, revocable, own posts only; a sponsored post keeps a
 * per-deal confirmation"). Stored in media_rights_attestations (migration 0151).
 *
 *   needsFor    what a ready item still needs: its source assets with no live own-posts word, and — on a sponsored post
 *               (the plan action's partner is a brand) — whether this deal's confirmation is live. The own-media word is
 *               about the media ("these are mine"); it never covers a sponsored use on its own, so a sponsored post needs
 *               both, and each is asked only when missing.
 *   approve     the sheet's taps ({ ownMedia, sponsoredRights }): refuses nothing it can ask instead — anything still
 *               missing and not ticked answers { approved: false, needs } and writes NOTHING. Ticked: one row per
 *               missing asset (own_posts) and one for the deal (sponsored), with the exact words shown; then the item
 *               is marked approved (detail.approval) and the answer carries what Copy & save needs (the caption, signed
 *               media URLs). Nothing is posted: they post it, then tap "I posted it" (tap-to-send).
 *   listLive / revoke   what they have confirmed, and taking a word back (revoked_at; the row stays as the record). A
 *               revoked asset or deal is asked again on the next "Post it".
 *
 * Deal key: the NEWEST of the athlete's deal / gift / affiliate records for the partner (disclosure.ts, "deal:<id>" or
 * "shop:<id>"), so a new deal with the same brand asks again; only with no record, "brand:<name, flattened>".
 *
 * Disclosure: the sponsored line and the #ad note are shown only when the post carries #ad (kit.guard.disclosure "ad").
 * A post that names a brand with no record ("ask") first asks "Is this paid, gifted or an affiliate post?": paid /
 * gifted / affiliate puts #ad first (the final guard runs again) and it is then a sponsored post; none leaves no #ad and
 * no sponsored line. Approve uses the queue's own readiness test (readiness.ts).
 *
 * Every read and write takes the athlete id first (from the session). Media is checked through the athlete's own
 * predicate (deps.media.load): an asset that is not theirs, or has gone, cannot be confirmed.
 */
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import {
  DISCLOSURE_ANSWER_LABELS, DISCLOSURE_ANSWERS, DISCLOSURE_QUESTION, RIGHTS_AD_NOTE, RIGHTS_OWN_MEDIA_LINE, RIGHTS_WORDS_VERSION, rightsSponsoredLine,
  SPONSORED_KINDS, type SponsoredKind,
  type ApproveBody, type ApproveResponse, type DisclosureAnswer, type ReadyRights, type RightsAttestationView, type RightsWords,
} from "../../../shared/readyQueue";
import type { Decision } from "../../../shared/agent";
import { PostKitError } from "../postKit/errors";
import type { ReadyDeps } from "./queue";
import { creditLines, guardSourcesFor, momentFor, type PostKitDeps } from "../postKit/build";
import { GUARD_REFUSALS, GUARD_VERSION, guardPostText, numberCandidates, withAdLead, wouldRemoveRefusal } from "../postKit/finalGuard";
import { hashtagsOf } from "../postKit/caption";
import { brandNamedIn, sameBrand, type MaterialConnection } from "../postKit/disclosure";
import { neverTermsFrom } from "../neverTerms";
import { isReadyRow, isResting } from "./readiness";

export interface Attestation {
  id: string;
  athleteId: string;
  scope: "own_posts" | "sponsored";
  /** The asset it is about; null on a sponsored row, and once that photo or clip has been deleted (the word is kept). */
  assetId: string | null;
  /** own_posts: which asset it was, kept after it is deleted — "<platform>:<media_assets id>". Null on sponsored. */
  assetRef: string | null;
  /** own_posts: "photo" | "clip". Null on sponsored. */
  assetKind: string | null;
  dealKey: string | null;
  brand: string | null;
  itemId: string | null;
  words: string;
  wordsVersion: string;
  attestedAt: string;
  revokedAt: string | null;
}

export type NewAttestation = Omit<Attestation, "id" | "attestedAt" | "revokedAt">;

/** The table, as this module uses it (dbRightsStore below; tests pass createMemoryRightsStore). */
export interface RightsStore {
  /** Live rows only (revoked_at null), newest first. */
  listLive(athleteId: string): Promise<Attestation[]>;
  /** Inserts each; one that is already live (the partial unique indexes) is skipped, never an error. */
  insertMany(athleteId: string, rows: NewAttestation[]): Promise<void>;
  /** Sets revoked_at on a live row of theirs; false when there is none. */
  revoke(athleteId: string, id: string, at: Date): Promise<boolean>;
}

/** What the approve path reads besides the queue's ports: the guard's inputs (all optional; absent = none). */
export type RightsDeps = ReadyDeps & { rights: RightsStore } & Partial<Pick<PostKitDeps, "preferences" | "avoidWords" | "connections">>;

const flat = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** The fallback deal key when the athlete has no deal / gift / affiliate record for the partner: its flattened name. */
export const dealKeyOf = (brand: string) => `brand:${flat(brand)}`;

/**
 * The deal a sponsored confirmation is for: the NEWEST of the athlete's records (disclosure.ts MaterialConnection: a
 * deal, gift or affiliate link) for this partner — "deal:<id>" / "shop:<id>" — so a new deal with the same brand asks
 * again. No record: the brand key (dealKeyOf).
 */
export function dealKeyFor(brand: string, connections: readonly MaterialConnection[]): string {
  const matches = connections.filter((c) => c.ref && sameBrand(c.brand, brand))
    .sort((a, b) => (b.since ?? "").localeCompare(a.since ?? "") || (b.ref ?? "").localeCompare(a.ref ?? ""));
  return matches[0]?.ref ?? dealKeyOf(brand);
}

/** The post's partner brand when the action is brand work, else null. */
export function partnerOf(det: Pick<ActionDecisionDetail, "deliverable">): string | null {
  const t = det.deliverable?.target;
  return t?.subjectKind === "brand" && t.name.trim() ? t.name.trim() : null;
}

/**
 * The partner a sponsored confirmation is for: the action's brand target; with none, a brand of the athlete's deal /
 * gift / affiliate records that the caption itself names (disclosure.ts brandNamedIn) — the record that made the final
 * guard put #ad first. Only on a post that carries #ad; else partnerOf.
 */
export function partnerFor(det: Pick<ActionDecisionDetail, "deliverable">, kit: Pick<PostKit, "caption" | "guard">, connections: readonly MaterialConnection[]): string | null {
  const target = partnerOf(det);
  if (target || kit.guard?.disclosure !== "ad") return target;
  return connections.find((c) => brandNamedIn(kit.caption.text, c.brand))?.brand ?? null;
}

/** The disclosure as it stands: the kit's guard mark, with an "ask" they answered "none" read as no disclosure. */
export function disclosureOf(kit: Pick<PostKit, "guard">, detail: Record<string, unknown> | null | undefined): "ad" | "ask" | null {
  const d = kit.guard?.disclosure ?? null;
  const answer = (detail?.disclosureAnswer as { answer?: unknown } | undefined)?.answer;
  return d === "ask" && answer === "none" ? null : d;
}

/**
 * What a kit still needs, against the live words. Pure. A post is SPONSORED (needs this deal's line) only when it
 * carries #ad (disclosure "ad") and has a partner; while the disclosure is still "ask", nothing about sponsorship is
 * asked until they answer the question.
 */
export function needsOf(
  kit: Pick<PostKit, "assets" | "guard">, partner: string | null, live: readonly Attestation[],
  ctx: { detail?: Record<string, unknown> | null; connections?: readonly MaterialConnection[] } = {},
): ReadyRights {
  const own = new Set(live.filter((a) => a.scope === "own_posts" && a.assetId).map((a) => a.assetId!));
  const missingAssetIds = [...new Set(kit.assets.map((a) => a.assetId))].filter((id) => !own.has(id));
  const disclosure = disclosureOf(kit, ctx.detail);
  const key = partner ? dealKeyFor(partner, ctx.connections ?? []) : null;
  const sponsored = partner && disclosure === "ad"
    ? { brand: partner, confirmed: live.some((a) => a.scope === "sponsored" && a.dealKey === key), kind: sponsoredKindOf(partner, ctx.detail, ctx.connections ?? []) }
    : null;
  return { missingAssetIds, sponsored, disclosure, complete: missingAssetIds.length === 0 && disclosure !== "ask" && (!sponsored || sponsored.confirmed) };
}

/**
 * What kind of brand post it is, for the sponsored line's words: their answer to DISCLOSURE_QUESTION when they gave one,
 * else the newest matching record's kind (deal → paid, gift → gifted, affiliate), else null (worded as paid). Wording
 * only: the #ad rules are the final guard's and do not change.
 */
export function sponsoredKindOf(partner: string, detail: Record<string, unknown> | null | undefined, connections: readonly MaterialConnection[]): SponsoredKind | null {
  const answer = (detail?.disclosureAnswer as { answer?: unknown } | undefined)?.answer;
  if ((SPONSORED_KINDS as readonly unknown[]).includes(answer)) return answer as SponsoredKind;
  const match = connections.filter((c) => sameBrand(c.brand, partner))
    .sort((a, b) => (b.since ?? "").localeCompare(a.since ?? "") || (b.ref ?? "").localeCompare(a.ref ?? ""))[0];
  return match ? ({ deal: "paid", gift: "gifted", affiliate: "affiliate" } as const)[match.kind] : null;
}

/** The lines the sheet shows for these needs (the same words that are stored when ticked). */
export function wordsFor(needs: ReadyRights): RightsWords {
  const askSponsored = !!needs.sponsored && !needs.sponsored.confirmed;
  const ask = needs.disclosure === "ask";
  return {
    version: RIGHTS_WORDS_VERSION,
    ownMedia: needs.missingAssetIds.length ? RIGHTS_OWN_MEDIA_LINE : null,
    sponsored: askSponsored ? rightsSponsoredLine(needs.sponsored!.brand, needs.sponsored!.kind) : null,
    adNote: needs.disclosure === "ad" ? RIGHTS_AD_NOTE : null,
    disclosureQuestion: ask ? DISCLOSURE_QUESTION : null,
    disclosureOptions: ask ? DISCLOSURE_ANSWERS.map((value) => ({ value, label: DISCLOSURE_ANSWER_LABELS[value] })) : null,
  };
}

interface ReadyRow { d: Decision; det: ActionDecisionDetail; kit: PostKit }

/** The item, only while it is READY (readiness.ts — the same test the queue lists by). */
async function readyRow(deps: ReadyDeps, athleteId: string, id: string, now: Date): Promise<ReadyRow> {
  const d = await deps.store.getDecision(athleteId, id);
  const det = (d?.detail ?? {}) as unknown as ActionDecisionDetail;
  const kit = det.prepared?.postKit;
  if (!d || d.kind !== "action" || det.kind !== "post" || !kit) throw new PostKitError("No such post", 404, "not_found");
  if (d.response !== "pending") throw new PostKitError("This post is no longer waiting to go up", 409, "closed");
  if (!isReadyRow(d, now)) {
    if (!kit.guard) throw new PostKitError("This post's words haven't passed the final check yet; open it and save the caption", 409, "not_guarded");
    if (!kit.assets.length || kit.aiGenerationNeeded?.value) throw new PostKitError("This post has no photos or clips yet", 409, "no_assets");
    if (isResting(d.detail, now)) throw new PostKitError("You set this one aside for now", 409, "resting");
    throw new PostKitError("This post isn't ready yet", 409, "not_ready");
  }
  return { d, det, kit };
}

/**
 * Their answer to DISCLOSURE_QUESTION, applied (one conditional write): paid / gifted / affiliate → `#ad` first in the
 * caption, through the final guard again (edit mode: nothing of theirs is removed; a refusal is "final_guard"), and the
 * kit's guard mark becomes "ad"; none → no #ad. Either way detail.disclosureAnswer { answer, at } records it.
 */
async function applyDisclosure(deps: RightsDeps, athleteId: string, r: ReadyRow, answer: DisclosureAnswer, now: Date): Promise<void> {
  let detail: Record<string, unknown> = { ...(r.d.detail ?? {}), disclosureAnswer: { answer, at: now.toISOString() } };
  if (answer !== "none") {
    const prefs = deps.preferences ? await deps.preferences(athleteId).catch(() => []) : [];
    const neverTerms = neverTermsFrom(prefs);
    const moment = await momentFor(deps.store, athleteId, r.det).catch(() => null);
    const sources = await guardSourcesFor(deps as unknown as PostKitDeps, athleteId, r.det, moment, neverTerms, now, "edit");
    // The kit already passed the guard: its own numbers stand; only #ad is added.
    const g = guardPostText(
      { caption: withAdLead(r.kit.caption.text), onCard: [] },
      { ...sources, disclosure: "required", extraTokens: [...numberCandidates([r.kit.caption.text])], keep: creditLines(r.kit) },
    );
    if (!g.ok) throw new PostKitError(g.block === "would_remove" ? wouldRemoveRefusal(g.found) : GUARD_REFUSALS[g.block], 409, "final_guard");
    const kit: PostKit = {
      ...r.kit, caption: { ...r.kit.caption, text: g.caption, hashtags: hashtagsOf(g.caption) },
      guard: { version: GUARD_VERSION, at: now.toISOString(), disclosure: "ad" }, updatedAt: now.toISOString(),
    };
    detail = { ...detail, prepared: { ...(r.det.prepared ?? {}), postKit: kit } };
  }
  const written = await deps.store.updateDecision(athleteId, r.d.id, { detail, ifUnchanged: { detail: r.d.detail ?? {}, response: "pending" } });
  if (!written) throw new PostKitError("This post changed while you were looking at it; open it again", 409, "conflict");
}

/** What the sheet will ask for one ready item (used by the queue read and by approve). */
export async function rightsFor(deps: RightsDeps, athleteId: string, kit: Pick<PostKit, "assets" | "guard" | "caption">, det: Pick<ActionDecisionDetail, "deliverable">, detail?: Record<string, unknown> | null): Promise<ReadyRights> {
  const connections = deps.connections ? await deps.connections(athleteId).catch(() => []) : [];
  return needsOf(kit, partnerFor(det, kit, connections), await deps.rights.listLive(athleteId), { detail, connections });
}

/** "Post it": the rights sheet's taps (see the header). */
export async function approveItem(deps: RightsDeps, athleteId: string, id: string, body: ApproveBody): Promise<ApproveResponse> {
  const now = deps.now ?? new Date();
  let r = await readyRow(deps, athleteId, id, now);
  let answeredNow = false;
  // 1. The disclosure question first, when the post names a brand with no record: their answer changes the caption.
  if (disclosureOf(r.kit, r.d.detail) === "ask" && body.disclosure && (DISCLOSURE_ANSWERS as readonly string[]).includes(body.disclosure)) {
    await applyDisclosure(deps, athleteId, r, body.disclosure, now);
    r = await readyRow(deps, athleteId, id, now);
    answeredNow = true;
  }
  const { d, det, kit } = r;
  const connections = deps.connections ? await deps.connections(athleteId).catch(() => []) : [];
  const partner = partnerFor(det, kit, connections);
  const needs = needsOf(kit, partner, await deps.rights.listLive(athleteId), { detail: d.detail, connections });
  const words = wordsFor(needs);
  // An answer that changed the post (#ad put first, now sponsored) changes what the sheet asks: the sheet shows the new
  // lines first, and no tick sent with the answer counts — they never saw the words it would store.
  if (answeredNow && !needs.complete) return { approved: false, needs, words };
  const ownOk = !needs.missingAssetIds.length || body.ownMedia === true;
  const sponsoredOk = !needs.sponsored || needs.sponsored.confirmed || body.sponsoredRights === true;
  if (needs.disclosure === "ask" || !ownOk || !sponsoredOk) return { approved: false, needs, words };

  // Only their own media that is still in their library can be confirmed (the athlete's predicate).
  const ids = kit.assets.map((a) => a.assetId);
  const rows = await deps.media.load(athleteId, ids);
  if (ids.some((x) => !rows.has(x))) throw new PostKitError("A photo or clip in this post is no longer in your library; swap it first", 409, "media_gone");

  const key = partner ? dealKeyFor(partner, connections) : null;
  const fresh: Parameters<RightsStore["insertMany"]>[1] = [
    ...needs.missingAssetIds.map((assetId) => ({ athleteId, scope: "own_posts" as const, assetId, assetRef: `${rows.get(assetId)?.platform ?? "media"}:${assetId}`, assetKind: kit.assets.find((k) => k.assetId === assetId)?.mediaType ?? rows.get(assetId)?.mediaType ?? null, dealKey: null, brand: null, itemId: d.id, words: words.ownMedia!, wordsVersion: RIGHTS_WORDS_VERSION })),
    ...(needs.sponsored && !needs.sponsored.confirmed ? [{ athleteId, scope: "sponsored" as const, assetId: null, assetRef: null, assetKind: null, dealKey: key!, brand: needs.sponsored.brand, itemId: d.id, words: words.sponsored!, wordsVersion: RIGHTS_WORDS_VERSION }] : []),
  ];
  if (fresh.length) await deps.rights.insertMany(athleteId, fresh);

  // The item remembers it was approved (what the sheet covered, and when) — conditional, one retry on a lost race.
  let row: Decision | null = d;
  for (let attempt = 0; attempt < 2 && row && row.response === "pending"; attempt++) {
    // The FIRST "Post it" stands (learning/core.ts mayAutoMark reads it): a second tap never moves it later.
    const first = (row.detail?.approval as { at?: unknown } | undefined)?.at;
    const approval = { at: typeof first === "string" ? first : now.toISOString(), assetIds: ids, sponsored: needs.sponsored ? { brand: needs.sponsored.brand, dealKey: key } : null, wordsVersion: RIGHTS_WORDS_VERSION };
    if (await deps.store.updateDecision(athleteId, row.id, { detail: { ...(row.detail ?? {}), approval }, ifUnchanged: { detail: row.detail ?? {}, response: "pending" } })) break;
    row = await deps.store.getDecision(athleteId, row.id);
  }

  const { readItem } = await import("./queue");
  const item = await readItem(deps, athleteId, d.id);
  return { approved: true, item, caption: kit.caption.text, media: await mediaFor(deps, athleteId, kit, rows) };
}

/** What Copy & save saves: the rendered preview when it is ready, else the kit's own photos and clips, signed now. */
async function mediaFor(deps: ReadyDeps, athleteId: string, kit: PostKit, rows: Map<string, any>): Promise<Array<{ assetId: string; kind: "image" | "video"; url: string | null }>> {
  const p = kit.preview;
  if (p?.status === "ready" && p.outputs.length && deps.render) {
    const signed = await deps.render.sign(athleteId, p).catch(() => null);
    if (signed) return p.outputs.map((o, i) => ({ assetId: o.assetId, kind: o.kind, url: signed.items[i] ?? null }));
  }
  return Promise.all(kit.assets.map(async (a) => {
    const row = rows.get(a.assetId);
    const urls = row ? await deps.media.urls(row) : { thumbUrl: null, videoUrl: null };
    return a.mediaType === "clip" ? { assetId: a.assetId, kind: "video" as const, url: urls.videoUrl } : { assetId: a.assetId, kind: "image" as const, url: urls.thumbUrl };
  }));
}

export async function listRights(deps: Pick<RightsDeps, "rights">, athleteId: string): Promise<RightsAttestationView[]> {
  return (await deps.rights.listLive(athleteId)).map((a) => ({ id: a.id, scope: a.scope, assetId: a.assetId, assetRef: a.assetRef, assetKind: a.assetKind, brand: a.brand, words: a.words, attestedAt: a.attestedAt }));
}

export async function revokeRights(deps: Pick<RightsDeps, "rights" | "now">, athleteId: string, id: string): Promise<{ revoked: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PostKitError("No such confirmation", 404, "not_found");
  const ok = await deps.rights.revoke(athleteId, id, deps.now ?? new Date());
  if (!ok) throw new PostKitError("No such confirmation", 404, "not_found");
  return { revoked: true };
}

// ─── stores ────────────────────────────────────────────────────────────────────────────────────────────────────

/** An in-memory RightsStore with the table's rules (one live row per asset / per deal; the athlete's own only). */
export function createMemoryRightsStore(clock: () => Date = () => new Date()): RightsStore & { all(): Attestation[]; assetDeleted(assetId: string): void } {
  const rows: Attestation[] = [];
  let n = 0;
  return {
    all: () => rows.map((r) => ({ ...r })),
    /** The table's ON DELETE SET NULL: the photo or clip is gone, the word is kept without it. */
    assetDeleted(assetId) { for (const r of rows) if (r.assetId === assetId) r.assetId = null; },
    async listLive(athleteId) {
      return rows.filter((r) => r.athleteId === athleteId && !r.revokedAt).sort((a, b) => b.attestedAt.localeCompare(a.attestedAt)).map((r) => ({ ...r }));
    },
    async insertMany(athleteId, list) {
      for (const r of list) {
        if (r.athleteId !== athleteId) continue;
        const clash = rows.some((x) => x.athleteId === athleteId && !x.revokedAt && x.scope === r.scope
          // A row whose asset was deleted (assetId null) confirms nothing and never blocks a new word.
          && (r.scope === "own_posts" ? !!x.assetId && x.assetId === r.assetId : x.dealKey === r.dealKey));
        if (clash) continue;
        n += 1;
        rows.push({ ...r, id: `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`, attestedAt: clock().toISOString(), revokedAt: null });
      }
    },
    async revoke(athleteId, id, at) {
      const r = rows.find((x) => x.id === id && x.athleteId === athleteId && !x.revokedAt);
      if (!r) return false;
      r.revokedAt = at.toISOString();
      return true;
    },
  };
}

/** The table (media_rights_attestations). Loaded lazily: it imports the database. */
export const dbRightsStore: RightsStore = {
  async listLive(athleteId) {
    const { and, desc, eq, isNull } = await import("drizzle-orm");
    const { db } = await import("../../db");
    const { mediaRightsAttestations: t } = await import("../../../shared/schema");
    const rows = await db.select().from(t).where(and(eq(t.athlete_id, athleteId), isNull(t.revoked_at))).orderBy(desc(t.attested_at));
    return rows.map((r) => ({
      id: r.id, athleteId: r.athlete_id, scope: r.scope as Attestation["scope"], assetId: r.asset_id, assetRef: r.asset_ref, assetKind: r.asset_kind, dealKey: r.deal_key, brand: r.brand,
      itemId: r.item_id, words: r.words, wordsVersion: r.words_version, attestedAt: r.attested_at.toISOString(), revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  },
  async insertMany(athleteId, list) {
    const mine = list.filter((r) => r.athleteId === athleteId);
    if (!mine.length) return;
    const { db } = await import("../../db");
    const { mediaRightsAttestations: t } = await import("../../../shared/schema");
    // A row already live (a double tap, two sheets at once) hits a partial unique index: skipped, not an error.
    await db.insert(t).values(mine.map((r) => ({
      athlete_id: athleteId, scope: r.scope, asset_id: r.assetId, asset_ref: r.assetRef, asset_kind: r.assetKind, deal_key: r.dealKey, brand: r.brand, item_id: r.itemId, words: r.words, words_version: r.wordsVersion,
    }))).onConflictDoNothing();
  },
  async revoke(athleteId, id, at) {
    const { and, eq, isNull } = await import("drizzle-orm");
    const { db } = await import("../../db");
    const { mediaRightsAttestations: t } = await import("../../../shared/schema");
    const rows = await db.update(t).set({ revoked_at: at }).where(and(eq(t.id, id), eq(t.athlete_id, athleteId), isNull(t.revoked_at))).returning({ id: t.id });
    return rows.length > 0;
  },
};
