/**
 * agent/postKit/edit.ts — reading a post kit, and the athlete's two edits (design §12): swap one asset for another
 * from the same shortlist (no model call), and change the caption. Every function takes the athlete id first (from the
 * session, never a body) and reads the decision through the store, which is scoped to that athlete: another athlete's
 * action is "not found", never "forbidden".
 *
 *   readPostKit   the kit and what the screen draws (signed URLs; `available` false for an asset that has since gone)
 *   swapAsset     { replace, with }: `with` must be on the kit's shortlist AND still pass the athlete's own predicate
 *                 (herPhoto / herClip) and every eligibility check — a shortlisted asset deleted or re-tagged unsafe
 *                 since the build is refused
 *                 — and, when the moment set the format, of a kind that fits it ("format_mismatch"); when the picks set
 *                 it, the format follows the new set (a photo swapped for a clip makes a feed post a reel)
 *   editCaption   { text }: the athlete's own words, 1–2,200 characters; its tags listed. While the kit's selected track
 *                 owes a credit (CC BY), the credit line is locked: a caption saved without it gets it back. Then the
 *                 final guard (finalGuard.ts, edit mode) on the whole caption: never deletes their words — a contact
 *                 detail, a price, the M.I.A., a number it can't trace (their own typed numbers are theirs), never-
 *                 content, avoided wording or care text is a refusal in words ("final_guard", 400); #ad is put first
 *                 only when a real deal / gift / affiliate record requires it (else they may take it out)
 *   markPosted    "I posted it": records that THEY posted it (nothing is ever posted for them) by answering the
 *                 action the way every other action kind is answered (response "accepted"), so Results and the
 *                 goal-change trail read it the same way a reply or a pitch being sent does — and, in the same write,
 *                 detail.posted { at, link, by: "athlete" } (shared/readyQueue.ts PostedDetail): when it went up (now,
 *                 or the time they give) and the post's link if they paste one, which the learning loop links on
 *                 (learning/core.ts linkPosts, via "link"). The write is conditional on the row still being pending
 *                 with the detail that was read, so an action closed in between (expired, skipped) is never flipped
 *                 back open. Idempotent: a repeat tap on a kit already done answers the current read — except that a
 *                 link pasted later is added when none is stored yet. A kit must be built first; a kit with no assets
 *                 can still be marked posted.
 *   chooseTrack   { track }: switch to another of the kit's suggested tracks, or null for none (agent/postKit/music.ts) —
 *                 only one of the kit's own choices, never a non-brand-safe one on a brand post; the caption's credit
 *                 line follows the track (refused, never truncated, when her caption has no room); the old preview
 *                 goes and the new one is asked for, as after a swap. 404 while AGENT_POST_KIT_MUSIC_CHOICES is off.
 *
 * Every read and edit sees the kit reconciled with the post as it is now (music.ts reconcileMusic): a post that became
 * brand work after the build never shows, keeps or re-credits a track that is not brand-safe.
 *   renderPreview ask for the kit's preview render again (AGENT_POST_KIT_RENDER; render/request.ts) — after a failure,
 *                 or for a kit built before the render was on
 *   useAsset      CAMERA_ROLL_INTAKE, the targeted ask: { assetId } — a photo or clip she just imported from her camera
 *                 roll FOR this post goes straight into its kit. Only into a kit that has nothing of hers yet (a kit with
 *                 media is changed with a swap); the asset passes the same predicate and every eligibility check a
 *                 swap does, and a format the moment set still holds. The action moves to made, as a build that found
 *                 media would have left it, and the preview is asked for.
 *
 * After a swap or a caption edit the preview is asked for again (render/request.ts): a swap clears the old one, and its
 * new key renders (or reuses what was rendered for that set before); a caption edit changes no pixel, so its key is
 * unchanged and nothing renders.
 *
 * A built kit can be edited until its action is done (posted) or answered; then it is read-only. Every write re-reads
 * the row and writes conditionally on it, so a concurrent change answers "conflict" instead of being overwritten.
 */
import type { ActionDecisionDetail, GoalActionState } from "../../../shared/plan";
import { POST_KIT_CONTRACT, type PostKit, type PostKitMusicView, type PostKitResponse } from "../../../shared/postKit";
import { POSTED_LINK_MAX, type PostedDetail } from "../../../shared/readyQueue";
import { postKeyOf } from "../learning/core";
import { contentReadyQueueEnabled } from "../ready/config";
import { neverTermsFrom } from "../neverTerms";
import { brandsToAvoid } from "../../studio/agent/brands";
import { creditLines, guardSourcesFor, momentFor, PostKitError, usedAssetIds, type PostKitDeps } from "./build";
import { GUARD_REFUSALS, GUARD_VERSION, guardPostText, numberCandidates, wouldRemoveRefusal } from "./finalGuard";
import { hashtagsOf } from "./caption";
import { POST_KIT } from "./config";
import { AI_REASONS, assetOf, fitsFormat, formatOfPicks, ineligibleReason, swapInKit, treatmentFor, withCaption, type IneligibleReason } from "./kit";
import { previewView, requestPostKitRender, requestQuietly } from "./render/request";
import {
  agentPostKitMusicChoicesEnabled, chooseMusic, choiceAllowed, kitIsBrandWork, MusicChoiceError, NO_ROOM_FOR_CREDIT,
  reconcileMusic, selectedCredit, withCredit,
} from "./music";
import { creditAllowed, isMusicId, MUSIC_CATALOGUE } from "../../studio/music/find";
import { musicInstalled } from "../../studio/video/beds";
import { agentPostKitRenderEnabled } from "./config";

interface Loaded {
  det: ActionDecisionDetail; state: GoalActionState; kit: PostKit | null; goalId: string | null; why: string;
  /** The row's detail exactly as read: what a conditional write (DecisionPatch.ifUnchanged) compares against. */
  rawDetail: Record<string, unknown>;
  /** When the action was written (ISO): a post can't have gone up before it. */
  createdAt: string;
}

async function load(deps: PostKitDeps, athleteId: string, decisionId: string): Promise<Loaded> {
  const d = await deps.store.getDecision(athleteId, decisionId);
  if (!d || d.kind !== "action") throw new PostKitError("No such action", 404, "not_found");
  const det = (d.detail ?? {}) as unknown as ActionDecisionDetail;
  if (det.kind !== "post") throw new PostKitError("This action is not a post", 409, "not_a_post");
  const answered = d.response === "accepted" || d.response === "edited";
  const state: GoalActionState = answered ? "done" : det.state ?? "to_start";
  if (d.response === "expired" || d.response === "skipped") throw new PostKitError("This action is no longer open", 409, "closed");
  const stored = det.prepared?.postKit ?? null;
  // The kit against the post as it is NOW (music.ts reconcileMusic): a post that became brand work since the build
  // never shows, keeps or re-locks a track that is not brand-safe. Same updatedAt, so a save still guards on it.
  const kit = stored ? reconcileMusic(stored, kitIsBrandWork(det)) : null;
  return { det, state, kit, goalId: d.goalId ?? null, why: d.why === "-" ? "" : d.why, rawDetail: d.detail ?? {}, createdAt: d.createdAt };
}

/**
 * A kit the athlete may change: built, and not done. A kit with no assets (nothing in the library fitted) can still
 * have its caption edited; a swap on it answers "no_assets" — there is nothing to swap until new media arrives.
 */
async function editable(deps: PostKitDeps, athleteId: string, decisionId: string): Promise<Loaded & { kit: PostKit }> {
  const l = await load(deps, athleteId, decisionId);
  if (l.state === "done") throw new PostKitError("This post is already done", 409, "done");
  if (!l.kit) throw new PostKitError("No post kit is built for this action yet", 404, "no_kit");
  return l as Loaded & { kit: PostKit };
}

/**
 * Write an edited kit onto the row as it is NOW: re-read it, refuse when its state or its kit moved since the edit
 * began (a concurrent edit, a rebuild, the athlete posting), merge into the fresh row's own `prepared`, and write only
 * while the row is still exactly what was re-read (DecisionPatch.ifUnchanged).
 */
async function save(deps: PostKitDeps, athleteId: string, decisionId: string, before: Loaded & { kit: PostKit }, kit: PostKit): Promise<void> {
  const conflict = () => new PostKitError("This post kit changed while you were editing it; open it again", 409, "conflict");
  const fresh = await deps.store.getDecision(athleteId, decisionId);
  const freshDet = (fresh?.detail ?? {}) as unknown as ActionDecisionDetail;
  const freshKit = freshDet.prepared?.postKit;
  if (!fresh || fresh.response !== "pending" || (freshDet.state ?? "to_start") !== before.state || !freshKit || freshKit.updatedAt !== before.kit.updatedAt) throw conflict();
  const detail: ActionDecisionDetail = { ...freshDet, prepared: { ...(freshDet.prepared ?? {}), postKit: kit } };
  const written = await deps.store.updateDecision(athleteId, decisionId, {
    detail: detail as unknown as Record<string, unknown>, ifUnchanged: { detail: fresh.detail ?? {}, response: "pending" },
  });
  if (!written) throw conflict();
}

export async function readPostKit(deps: PostKitDeps, athleteId: string, decisionId: string): Promise<PostKitResponse> {
  const { det, state, kit, goalId, why } = await load(deps, athleteId, decisionId);
  const media: PostKitResponse["media"] = [];
  if (kit) {
    const ids = [...kit.assets.map((a) => a.assetId), ...kit.shortlist];
    const rows = await deps.media.load(athleteId, ids);
    const inKit = new Set(kit.assets.map((a) => a.assetId));
    for (const id of ids) {
      const row = rows.get(id);
      const urls = row ? await deps.media.urls(row) : { thumbUrl: null, videoUrl: null };
      const known = kit.assets.find((a) => a.assetId === id);
      media.push({ assetId: id, mediaType: row?.mediaType ?? known?.mediaType ?? "photo", ...urls, available: !!row, inKit: inKit.has(id) });
    }
  }
  const [goal, moment, preview, music] = await Promise.all([
    goalId ? deps.store.getGoal(athleteId, goalId) : Promise.resolve(null),
    momentFor(deps.store, athleteId, det),
    previewView(deps, athleteId, kit),
    musicView(deps, kit, kitIsBrandWork(det)),
  ]);
  return {
    contract: POST_KIT_CONTRACT, decisionId, state, kit, media, why, preview,
    // Only on a kit with suggestions: a kit without them reads exactly as before.
    ...(music ? { music } : {}),
    goal: goal ? { id: goal.id, text: goal.text } : null,
    moment: moment ? { name: moment.name ?? "", whyNow: moment.whyNow } : null,
  };
}

/** The kit's suggested tracks, each with a fresh listening link (null when the files are not installed here). */
async function musicView(deps: PostKitDeps, kit: PostKit | null, forBrand: boolean): Promise<PostKitMusicView | null> {
  // Dark with the flag: a kit built while it was on reads as it would without suggestions.
  if (!agentPostKitMusicChoicesEnabled()) return null;
  const m = kit?.music;
  if (!m || !m.choices.length) return null;
  // A choice that owes a credit is not offered at all while MUSIC_ALLOW_ATTRIBUTION_TRACKS is off (M2): left out, not
  // marked — `allowed: false` is drawn as "Not for brand posts", which is the wrong reason on her own post.
  const offered = m.choices.filter((c) => !isMusicId(c.trackId) || creditAllowed(MUSIC_CATALOGUE[c.trackId]));
  if (!offered.length) return null;
  const choices = await Promise.all(offered.map(async (c) => {
    const t = MUSIC_CATALOGUE[c.trackId];
    // A listening link only for a file installed here (the free library has its own gate).
    const listenUrl = t && musicInstalled(c.trackId) && deps.media.trackUrl ? await deps.media.trackUrl(t.gcsPath).catch(() => null) : null;
    return { ...c, selected: c.trackId === m.selected, allowed: choiceAllowed(c.trackId, forBrand), listenUrl };
  }));
  return { choices };
}

export async function chooseTrack(deps: PostKitDeps, athleteId: string, decisionId: string, body: { track?: unknown }): Promise<PostKitResponse> {
  if (!agentPostKitMusicChoicesEnabled()) throw new PostKitError("Music choices are not available", 404, "music_off");
  if (!(body.track === null || typeof body.track === "string")) throw new PostKitError("Say which track to use, or null for none", 400, "bad_request");
  const before = await editable(deps, athleteId, decisionId);
  let chosen: PostKit;
  try {
    chosen = chooseMusic(before.kit, body.track, kitIsBrandWork(before.det), deps.now ?? new Date());
  } catch (err) {
    if (err instanceof MusicChoiceError) throw new PostKitError(err.message, err.code === "not_a_choice" || err.code === "no_room_for_credit" ? 400 : 409, err.code);
    throw err;
  }
  if (before.kit.music?.selected === chosen.music?.selected) return readPostKit(deps, athleteId, decisionId);
  // The old preview has the old track under it: it goes, and the request below asks for the new one's.
  delete chosen.preview;
  await save(deps, athleteId, decisionId, before, chosen);
  await requestQuietly(deps, athleteId, decisionId);
  return readPostKit(deps, athleteId, decisionId);
}

export async function swapAsset(deps: PostKitDeps, athleteId: string, decisionId: string, body: { replace?: unknown; with?: unknown }): Promise<PostKitResponse> {
  const replace = typeof body.replace === "string" ? body.replace : "";
  const withId = typeof body.with === "string" ? body.with : "";
  if (!replace || !withId) throw new PostKitError("Say which asset to replace and which to use", 400, "bad_request");
  const before = await editable(deps, athleteId, decisionId);
  const { det, kit } = before;
  if (!kit.assets.length) throw new PostKitError("Nothing in your library fits this post yet, so there is nothing to swap", 409, "no_assets");
  if (!kit.assets.some((a) => a.assetId === replace)) throw new PostKitError("That asset is not in this post kit", 400, "not_in_kit");
  if (!kit.shortlist.includes(withId)) throw new PostKitError("That asset is not one of this post kit's options", 400, "not_on_shortlist");
  const row = (await deps.media.load(athleteId, [withId])).get(withId);
  if (!row) throw new PostKitError("That asset is no longer in your library", 409, "unavailable");
  const now = deps.now ?? new Date();
  const neverTerms = neverTermsFrom(await deps.preferences(athleteId));
  const partner = det.deliverable?.target?.subjectKind === "brand" ? det.deliverable.target.name : null;
  const why = ineligibleReason(row, { neverTerms, avoidBrands: partner ? brandsToAvoid(partner) : [], used: await usedAssetIds(deps.store, athleteId, now, decisionId) });
  if (why) throw new PostKitError("That asset can't be used in this post anymore", 409, why);
  if (kit.formatFromMoment && !fitsFormat(kit.idea.format, row.mediaType)) {
    throw new PostKitError(`A ${row.mediaType} doesn't fit this ${kit.idea.format} post`, 409, "format_mismatch");
  }
  // The old preview shows the old set: it goes with the swap, and the request below asks for the new set's.
  const swapped = swapInKit(kit, replace, row, neverTerms, now);
  delete swapped.preview;
  await save(deps, athleteId, decisionId, before, swapped);
  await requestQuietly(deps, athleteId, decisionId);
  return readPostKit(deps, athleteId, decisionId);
}

export async function editCaption(deps: PostKitDeps, athleteId: string, decisionId: string, body: { text?: unknown }): Promise<PostKitResponse> {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new PostKitError("A caption needs some words", 400, "bad_request");
  if (text.length > POST_KIT.CAPTION_CHARS) throw new PostKitError(`A caption is at most ${POST_KIT.CAPTION_CHARS} characters`, 400, "too_long");
  const before = await editable(deps, athleteId, decisionId);
  // The selected track's credit (CC BY) is locked in: a caption saved without it gets it back at the end — the full
  // form, or the short one when that is all that fits. Her words are never cut for it: no room is a refusal she can act on.
  const credit = selectedCredit(before.kit);
  const withIt = credit ? withCredit(text, null, credit) : { ok: true as const, text };
  if (!withIt.ok) throw new PostKitError(NO_ROOM_FOR_CREDIT, 400, "no_room_for_credit");
  // The final guard (finalGuard.ts) on the WHOLE caption they save, in edit mode: nothing of theirs is deleted for them —
  // what the guard would remove (a contact detail, a price, the M.I.A., a number it can't trace) is a refusal in words
  // they can act on; only the #ad a real deal requires is put in. Numbers: the post's own sources, plus every number
  // they typed themselves. A kit the guard has passed (kit.guard) vouches for the numbers already in it, and so does an
  // earlier edit of theirs (caption.edited: those are numbers they typed); only a kit built before the guard and never
  // edited does not, so its old numbers are re-checked once here — the ones they newly type are theirs.
  const now = deps.now ?? new Date();
  const edited = withCaption(before.kit, withIt.text, now);
  const [prefs, moment] = await Promise.all([deps.preferences(athleteId), momentFor(deps.store, athleteId, before.det)]);
  const neverTerms = neverTermsFrom(prefs);
  const sources = await guardSourcesFor(deps, athleteId, before.det, moment, neverTerms, now, "edit");
  const typed = numberCandidates([edited.caption.text]);
  const unchecked = before.kit.guard || before.kit.caption.edited ? new Set<string>() : numberCandidates([before.kit.caption.text]);
  const own = [...typed].filter((n) => !unchecked.has(n));
  const g = guardPostText(
    { caption: edited.caption.text, onCard: [] },
    { ...sources, extraTokens: own, keep: creditLines(edited) },
  );
  if (!g.ok) {
    const message = g.block === "would_remove" ? wouldRemoveRefusal(g.found) : GUARD_REFUSALS[g.block];
    throw new PostKitError(message, 400, "final_guard");
  }
  const guarded: PostKit = {
    ...edited, caption: { ...edited.caption, text: g.caption, hashtags: hashtagsOf(g.caption) },
    guard: { version: GUARD_VERSION, at: now.toISOString(), disclosure: g.disclosure },
  };
  await save(deps, athleteId, decisionId, before, guarded);
  await requestQuietly(deps, athleteId, decisionId);
  return readPostKit(deps, athleteId, decisionId);
}

/** Plain words for why an imported asset cannot go into the kit — what she can do next, not a code. */
const USE_REFUSALS: Record<IneligibleReason, string> = {
  untagged: "Nomila is still looking at that one. Try again in a minute.",
  athlete_not_in_it: "You don't seem to be in that one, so it can't carry this post. Pick one you're in.",
  meta_image: "That looks like a screenshot or a graphic, not a moment. Pick a photo or clip you're in.",
  brand_unsafe: "That one can't be used in a post. Pick another.",
  rejected_by_tagger: "That one is too soft or dark to use. Pick another.",
  conflicting_brand: "Another brand is showing in that one, and this post is for a partner. Pick another.",
  never_term: "That one shows something you asked Nomila to stay away from. Pick another.",
  used_in_another_post: "That one is already in another post. Pick another.",
  clip_length_unknown: "Nomila is still measuring that clip. Try again in a minute.",
  not_own_footage: "Only your own photos and clips can go in a post kit.",
};

/**
 * CAMERA_ROLL_INTAKE — the targeted ask's last step: put one asset she just imported for THIS post into its kit (see
 * the header). Conditional on the row being exactly what was read, like every kit write.
 */
export async function useAsset(deps: PostKitDeps, athleteId: string, decisionId: string, body: { assetId?: unknown }): Promise<PostKitResponse> {
  const assetId = typeof body.assetId === "string" ? body.assetId : "";
  if (!assetId) throw new PostKitError("Say which photo or clip to use", 400, "bad_request");
  const before = await editable(deps, athleteId, decisionId);
  const { det, kit } = before;
  if (kit.assets.length) throw new PostKitError("This post kit already has media; use Swap to change it", 409, "kit_has_media");
  const row = (await deps.media.load(athleteId, [assetId])).get(assetId);
  if (!row) throw new PostKitError("That photo or clip isn't in your library", 404, "unavailable");
  const now = deps.now ?? new Date();
  const neverTerms = neverTermsFrom(await deps.preferences(athleteId));
  const partner = det.deliverable?.target?.subjectKind === "brand" ? det.deliverable.target.name : null;
  const why = ineligibleReason(row, { neverTerms, avoidBrands: partner ? brandsToAvoid(partner) : [], used: await usedAssetIds(deps.store, athleteId, now, decisionId) });
  if (why) throw new PostKitError(USE_REFUSALS[why], 409, why);
  if (kit.formatFromMoment && !fitsFormat(kit.idea.format, row.mediaType)) {
    throw new PostKitError(`This ${kit.idea.format} post needs a photo, not a clip`, 409, "format_mismatch");
  }
  const format = kit.formatFromMoment ? kit.idea.format : formatOfPicks([row.mediaType]);
  const { assets, treatment } = treatmentFor(format, [assetOf(row, null)], { lookPreset: kit.treatmentPlan.lookPreset, musicMood: kit.treatmentPlan.musicMood }, kit.idea.hook, neverTerms);
  const next: PostKit = {
    ...kit,
    idea: { ...kit.idea, format },
    assets,
    shortlist: kit.shortlist.filter((id) => id !== row.id),
    treatmentPlan: treatment,
    aiGenerationNeeded: { value: false, reason: AI_REASONS.realFootage },
    updatedAt: now.toISOString(),
  };
  delete next.preview;

  // As save() does — re-read, refuse when anything moved — and, as a build that found media would, move it to made.
  const conflict = () => new PostKitError("This post kit changed while you were editing it; open it again", 409, "conflict");
  const fresh = await deps.store.getDecision(athleteId, decisionId);
  const freshDet = (fresh?.detail ?? {}) as unknown as ActionDecisionDetail;
  const freshKit = freshDet.prepared?.postKit;
  if (!fresh || fresh.response !== "pending" || (freshDet.state ?? "to_start") !== before.state || !freshKit || freshKit.updatedAt !== kit.updatedAt) throw conflict();
  const detail: ActionDecisionDetail = {
    ...freshDet,
    state: "made",
    prepared: { ...(freshDet.prepared ?? {}), studioItemId: decisionId, postKit: next },
  };
  const written = await deps.store.updateDecision(athleteId, decisionId, {
    detail: detail as unknown as Record<string, unknown>, ifUnchanged: { detail: fresh.detail ?? {}, response: "pending" },
  });
  if (!written) throw conflict();
  await requestQuietly(deps, athleteId, decisionId);
  return readPostKit(deps, athleteId, decisionId);
}

/** Ask for the preview render again: a failed one, or one never asked for. 404 while the render is off. */
export async function renderPreview(deps: PostKitDeps, athleteId: string, decisionId: string): Promise<PostKitResponse> {
  if (!agentPostKitRenderEnabled()) throw new PostKitError("Post previews are not available", 404, "render_off");
  const { kit } = await editable(deps, athleteId, decisionId);
  if (!kit.assets.length) throw new PostKitError("Nothing in your library fits this post yet, so there is nothing to preview", 409, "no_assets");
  const r = await requestPostKitRender(deps, athleteId, decisionId, { verify: true });
  if (r.status === "nothing_to_render") throw new PostKitError("None of this post's photos or clips are in your library anymore", 409, "nothing_to_render");
  if (r.status === "conflict") throw new PostKitError("This post kit changed while the preview was asked for; open it again", 409, "conflict");
  return readPostKit(deps, athleteId, decisionId);
}

/** A phone's clock may run a little ahead of the server's. */
const POSTED_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * "I posted it"'s optional fields, checked: a link must be http(s) and at most POSTED_LINK_MAX characters (it is
 * stored, never fetched); a time can't be in the future or before the action was suggested. No time: now.
 */
export function postedFields(body: { link?: unknown; postedAt?: unknown } | null | undefined, now: Date, notBefore: string): { link: string | null; at: string } {
  const raw = body ?? {};
  let link: string | null = null;
  if (raw.link != null && raw.link !== "") {
    if (typeof raw.link !== "string") throw new PostKitError("That doesn't look like a link to a post", 400, "bad_link");
    const t = raw.link.trim();
    let u: URL | null = null;
    try { u = new URL(t); } catch { u = null; }
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || t.length > POSTED_LINK_MAX) throw new PostKitError("That doesn't look like a link to a post", 400, "bad_link");
    link = t;
  }
  let at = now.toISOString();
  if (raw.postedAt != null && raw.postedAt !== "") {
    const ms = typeof raw.postedAt === "string" ? Date.parse(raw.postedAt) : NaN;
    if (!Number.isFinite(ms)) throw new PostKitError("Say when it went up as a date and time", 400, "bad_time");
    if (ms > now.getTime() + POSTED_CLOCK_SKEW_MS) throw new PostKitError("That time is still to come", 400, "bad_time");
    if (ms < Date.parse(notBefore) - POSTED_CLOCK_SKEW_MS) throw new PostKitError("That is before this post was suggested", 400, "bad_time");
    at = new Date(ms).toISOString();
  }
  return { link, at };
}

/**
 * "I posted it": answers the action (response "accepted", reason "posted") and records detail.posted { at, link, by:
 * "athlete" } in ONE conditional write — only while the row is still pending with exactly the detail just read
 * (DecisionPatch.ifUnchanged), the same guard every kit edit uses. So an action that expired or was skipped in between
 * can never be flipped to accepted. A repeat call on a kit that is already done answers the current read (a double tap
 * is not an error); a link given then, when none is stored, is added. A kit with no assets (nothing fitted) can still be
 * marked posted — they may have posted one they made themselves.
 */
export async function markPosted(deps: PostKitDeps, athleteId: string, decisionId: string, body: { link?: unknown; postedAt?: unknown } = {}): Promise<PostKitResponse> {
  const now = deps.now ?? new Date();
  const before = await load(deps, athleteId, decisionId);
  // CONTENT_READY_QUEUE off: exactly the tap as it was (response accepted, nothing else read or written) — the route is
  // live wherever AGENT_POST_KITS is on.
  const queueOn = contentReadyQueueEnabled();
  const fields = queueOn ? postedFields(body, now, before.createdAt) : null;
  if (before.state === "done") {
    if (fields) await addLinkLater(deps, athleteId, decisionId, fields.link, now);
    return readPostKit(deps, athleteId, decisionId);
  }
  if (!before.kit) throw new PostKitError("No post kit is built for this action yet", 404, "no_kit");
  // load() answered: not done (so not accepted/edited) and not closed (so not expired/skipped), so the row is pending.
  const written = await deps.store.updateDecision(athleteId, decisionId, fields ? {
    response: "accepted", responseReason: "posted",
    detail: { ...relinkFor(before.rawDetail, fields.link, now), posted: { at: fields.at, link: fields.link, by: "athlete" } satisfies PostedDetail },
    ifUnchanged: { detail: before.rawDetail, response: "pending" },
  } : { response: "accepted", ifUnchanged: { detail: before.rawDetail, response: "pending" } });
  if (!written) {
    // Something moved in between: answered elsewhere (done: the current read), closed (load throws 409 closed), or the
    // kit itself changed (conflict: open it again).
    const after = await load(deps, athleteId, decisionId);
    if (after.state === "done") return readPostKit(deps, athleteId, decisionId);
    throw new PostKitError("This post kit changed while you were editing it; open it again", 409, "conflict");
  }
  return readPostKit(deps, athleteId, decisionId);
}

/**
 * A link they paste is the truth about which post it was: a post the learning loop linked to this action by time
 * (detail.published) that is NOT the post at that link is unlinked — its readings were another post's — so the next
 * nightly pass links the right one by link (learning/core.ts linkPosts, via "link"). The judged outcome already
 * recorded from the wrong post is not undone here (it is superseded when the right post is judged). Kept: a published
 * link to the same post (postKeyOf equal), and one whose own link is unknown (a link made before links were stored, or
 * a post with no permalink) — nothing proves it wrong; their link is stored beside it.
 */
export function relinkFor(detail: Record<string, unknown>, link: string | null, now: Date): Record<string, unknown> {
  const pub = detail.published as { permalink?: unknown } | undefined;
  if (!link || !pub) return detail;
  const known = typeof pub.permalink === "string" ? postKeyOf(pub.permalink) : null;
  if (known === null || known === postKeyOf(link)) return detail;
  const { published: _wrong, ...rest } = detail;
  return { ...rest, unlinked: { at: now.toISOString(), reason: "athlete_link", was: pub } };
}

/**
 * A link pasted after the tap. Stored when none is, or when the one stored is the learning loop's own guess (posted by
 * "learning") and differs — their link wins, the row becomes theirs (by "athlete"), and a wrong auto-link is undone
 * (relinkFor). A link they pasted themselves is never replaced. Conditional, like every write.
 */
async function addLinkLater(deps: PostKitDeps, athleteId: string, decisionId: string, link: string | null, now: Date): Promise<void> {
  if (!link) return;
  const d = await deps.store.getDecision(athleteId, decisionId);
  if (!d) return;
  const prior = (d.detail?.posted ?? null) as Partial<PostedDetail> | null;
  if (prior?.link && prior.by !== "learning") return;
  if (prior?.link && postKeyOf(prior.link) !== null && postKeyOf(prior.link) === postKeyOf(link)) return;
  const posted: PostedDetail = { at: typeof prior?.at === "string" ? prior.at : d.respondedAt ?? now.toISOString(), link, by: "athlete" };
  await deps.store.updateDecision(athleteId, decisionId, { detail: { ...relinkFor(d.detail ?? {}, link, now), posted }, ifUnchanged: { detail: d.detail ?? {}, response: d.response } });
}
