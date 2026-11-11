/**
 * agent/postKit/music.ts — a post kit's three suggested tracks (AGENT_POST_KIT_MUSIC_CHOICES, dev flag).
 *
 *   musicChoicesFor   the build's music step: the match skill's mood + the post's use and length → find.ts findMusic
 *                     (over what is installed here: availableCatalogue) → up to three choices. The one SELECTED by
 *                     default is the first that is not registered with YouTube Content ID (else the first): a claim
 *                     is the athlete's problem, so the default avoids one. Null for a post with no music (mood
 *                     "none", a still feed post, a carousel) or when the flag is off — and then nothing changes: the
 *                     render picks by mood exactly as before (render/compile.ts trackForMood).
 *   chooseMusic       the athlete switches to another of the SAME choices. Refused for a track that is not one of them,
 *                     for one not brand-safe on a brand post, and when her caption has no room for its credit.
 *   reconcileMusic    a kit read against the post AS IT IS NOW: a post that became brand work after the build loses a
 *                     selected track that is not brand-safe (the first allowed choice takes its place, or none), and
 *                     that track's credit leaves the caption. Applied on every read and edit (edit.ts) and before
 *                     every render request (render/request.ts), which also writes it back.
 *   withCredit        a CC-BY track's TASL credit line goes into the caption while it is selected, and comes out (either
 *                     form, exactly that line) when it is not. Her words are NEVER cut to make room: the short form
 *                     (title, author, licence) is used when the full one does not fit, and when neither fits the
 *                     caller refuses with a reason she can act on. The line is LOCKED while the track is selected:
 *                     edit.ts editCaption puts it back if a save drops it.
 *
 * A post is brand work when it names a brand partner (deliverable.target.subjectKind "brand") — the same test the
 * build (kit.ts postSpecOf partner) and the render (render/request.ts) use, so all three agree by construction.
 */
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { KitMusic, KitMusicChoice, PostFormat, PostKit } from "../../../shared/postKit";
import { availableCatalogue, creditAllowed, findMusic, isMusicId, MUSIC_CATALOGUE } from "../../studio/music/find";
import { isMood } from "../../studio/music/taxonomy";
import { POST_KIT } from "./config";

/** AGENT_POST_KIT_MUSIC_CHOICES — kits offer three tracks from the whole catalogue (free library included when installed). */
export function agentPostKitMusicChoicesEnabled(): boolean {
  return process.env.AGENT_POST_KIT_MUSIC_CHOICES === "true";
}

export const kitIsBrandWork = (det: Pick<ActionDecisionDetail, "deliverable">): boolean =>
  det.deliverable?.target?.subjectKind === "brand";

export type MusicChoiceErrorCode = "no_music_choices" | "not_a_choice" | "not_brand_safe" | "not_offered" | "no_room_for_credit";
export class MusicChoiceError extends Error {
  constructor(message: string, readonly code: MusicChoiceErrorCode) { super(message); }
}

export const NO_ROOM_FOR_CREDIT = "Your caption is too long to add this track's credit. Shorten it first, or pick another track.";

const isVideo = (f: PostFormat) => f === "reel" || f === "story";

/**
 * Whether a choice may go under this post (now): it is still in the catalogue, brand-safe on a brand post, and — while
 * MUSIC_ALLOW_ATTRIBUTION_TRACKS is off (owner decision M2) — owes no credit. A stored pick that fails this is moved off
 * by reconcileMusic and never rendered (selectedTrackFor).
 */
export const choiceAllowed = (trackId: string, forBrand: boolean): boolean =>
  isMusicId(trackId) && (!forBrand || MUSIC_CATALOGUE[trackId].brandSafe) && creditAllowed(MUSIC_CATALOGUE[trackId]);

/** The default: the first allowed choice that is not Content ID registered, else the first allowed one, else none. */
export function defaultSelection(choices: readonly KitMusicChoice[], forBrand: boolean): string | null {
  const allowed = choices.filter((c) => choiceAllowed(c.trackId, forBrand));
  return (allowed.find((c) => c.contentIdRegistered !== true) ?? allowed[0])?.trackId ?? null;
}

export function musicChoicesFor(input: { mood: string | null; format: PostFormat; forBrand: boolean; totalSec: number | null }): KitMusic | null {
  if (!agentPostKitMusicChoicesEnabled()) return null;
  if (!input.mood || !isMood(input.mood) || !isVideo(input.format)) return null;
  const found = findMusic({
    mood: input.mood,
    use: input.forBrand ? "brand" : "personal",
    ...(input.totalSec ? { minLengthSec: input.totalSec } : {}),
  }, availableCatalogue());
  if (!found.ok) return null;
  const choices: KitMusicChoice[] = found.tracks.map(({ track, reason }) => ({
    trackId: track.id, title: track.title, artist: track.artist, reason, licence: track.licence, credit: track.credit,
    creditShort: track.creditShort, contentIdRegistered: track.contentIdRegistered,
  }));
  return { choices, selected: defaultSelection(choices, input.forBrand) };
}

/** The caption's credit line for a track: what a CC-BY licence asks the post to carry. */
export const creditLine = (credit: string): string => `Music: ${credit}`;

/** A choice's credit, in both forms; null when it owes none. */
export interface CreditForms { full: string; short: string | null }

/**
 * The caption with `from`'s credit line taken out (either form, exactly that line) and `to`'s appended — the full
 * form when it fits under the caption limit, else the short form, else `{ ok: false }`. Her own words are never cut.
 */
export function withCredit(text: string, from: CreditForms | null, to: CreditForms | null): { ok: true; text: string } | { ok: false } {
  const gone = new Set([from?.full, from?.short].filter((x): x is string => !!x).map(creditLine));
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => !gone.has(l.trim()));
  const base = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (!to) return { ok: true, text: base };
  const forms = [to.full, to.short].filter((x): x is string => !!x).map(creditLine);
  if (lines.some((l) => forms.includes(l.trim()))) return { ok: true, text: base };
  for (const line of forms) {
    const out = base ? `${base}\n\n${line}` : line;
    if (out.length <= POST_KIT.CAPTION_CHARS) return { ok: true, text: out };
  }
  return { ok: false };
}

const creditOf = (m: KitMusic | undefined, id: string | null): CreditForms | null => {
  const c = id ? m?.choices.find((x) => x.trackId === id) : undefined;
  return c?.credit ? { full: c.credit, short: c.creditShort ?? null } : null;
};

/** A freshly built kit with its music: the choices, and the selected track's credit in the caption. */
export function withMusic(kit: PostKit, music: KitMusic | null): PostKit {
  if (!music) return kit;
  let selected = music.selected;
  let r = withCredit(kit.caption.text, null, creditOf(music, selected));
  if (!r.ok) {
    // No room for the credit in the drafted caption: start on a choice that owes none (or none), never cut her words.
    selected = music.choices.find((c) => !c.credit)?.trackId ?? null;
    r = { ok: true, text: kit.caption.text };
  }
  return { ...kit, music: { ...music, selected }, caption: { ...kit.caption, text: r.text } };
}

/** She picks another of the kit's suggested tracks (or null for none). */
export function chooseMusic(kit: PostKit, trackId: string | null, forBrand: boolean, now: Date): PostKit {
  const m = kit.music;
  if (!m || !m.choices.length) throw new MusicChoiceError("This post has no suggested music", "no_music_choices");
  if (trackId !== null) {
    if (!m.choices.some((c) => c.trackId === trackId) || !isMusicId(trackId)) {
      throw new MusicChoiceError("That track is not one of this post's suggestions", "not_a_choice");
    }
    if (!creditAllowed(MUSIC_CATALOGUE[trackId])) {
      throw new MusicChoiceError("Tracks that need a credit line aren't offered right now", "not_offered");
    }
    if (!choiceAllowed(trackId, forBrand)) {
      throw new MusicChoiceError("That track can't be used on a brand post", "not_brand_safe");
    }
  }
  const r = withCredit(kit.caption.text, creditOf(m, m.selected), creditOf(m, trackId));
  if (!r.ok) throw new MusicChoiceError(NO_ROOM_FOR_CREDIT, "no_room_for_credit");
  return { ...kit, music: { ...m, selected: trackId }, caption: { ...kit.caption, text: r.text }, updatedAt: now.toISOString() };
}

/**
 * The kit as the post is NOW. Unchanged (the same object) unless the selected track may no longer go under the post —
 * then the default among the allowed choices takes its place, and the credit follows. Never touches a kit without
 * choices, or a selection of none.
 */
export function reconcileMusic(kit: PostKit, forBrand: boolean): PostKit {
  const m = kit.music;
  if (!m || m.selected === null || choiceAllowed(m.selected, forBrand)) return kit;
  let next = defaultSelection(m.choices, forBrand);
  let r = withCredit(kit.caption.text, creditOf(m, m.selected), creditOf(m, next));
  if (!r.ok) { next = null; r = withCredit(kit.caption.text, creditOf(m, m.selected), null); }
  return { ...kit, music: { ...m, selected: next }, caption: { ...kit.caption, text: r.ok ? r.text : kit.caption.text } };
}

/**
 * The track the render lays under the preview, from the kit's own choice — or undefined when the kit has no choices
 * (the render then picks by mood, as it always did). Null = no music. A stored choice that is no longer in the
 * catalogue, or not brand-safe on a brand post, is never used.
 */
export function selectedTrackFor(kit: PostKit, forBrand: boolean): string | null | undefined {
  const m = kit.music;
  if (!m) return undefined;
  const id = m.selected;
  if (id === null) return null;
  if (!m.choices.some((c) => c.trackId === id) || !choiceAllowed(id, forBrand)) return undefined;
  return id;
}

/** The selected track's credit, if it owes one — what a caption edit must keep. */
export const selectedCredit = (kit: PostKit): CreditForms | null => creditOf(kit.music, kit.music?.selected ?? null);
