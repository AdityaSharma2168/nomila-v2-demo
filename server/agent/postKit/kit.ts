/**
 * agent/postKit/kit.ts — the post kit's rules, as plain functions over rows already loaded (design §9–§11). No database,
 * no model call: build.ts loads and calls, this decides.
 *
 *   postSpecOf        the post to make, from the plan action (and the moment it is timed for, when the store has one):
 *                     idea, brief, media needs, the draft caption. Every athlete-visible line comes from text an
 *                     OpenAI-tier skill already wrote (the plan's deliverable, the moments scan's idea) — the cheap-tier
 *                     re-rank never writes a word the athlete reads.
 *   ineligibleReason  why a library row may not be in a post kit, or null: only the athlete's own footage (camera or
 *                     synced; never made here), the athlete in it, tagged, not a meta image, brand-safe, no conflicting
 *                     brand, no never-use name, not already in another kit
 *   segmentsOf        a clip's segments for the re-rank: described beats (vision.beats), else camera cuts (metadata.shots)
 *   clipRangeFor      a clip's seconds: the chosen segment, capped, snapped to a camera cut by the caster's own snap
 *                     (studio/agent/cast.ts snapCut), never shorter than MIN_CLIP_SEC
 *   treatmentFor      the treatment plan (§11) in the shape the stitch compiles: aspect, crop, order, trims, stills,
 *                     overlay, look, music mood, cover frame, total length
 *   assembleKit / swapInKit / withCaption   the kit, and the athlete's two edits
 */
import type { MemoryFact } from "../../../shared/agent";
import type { ActionDecisionDetail, MomentDecisionDetail, PlanTarget } from "../../../shared/plan";
import {
  LOOK_PRESETS, POST_FORMATS, POST_KIT_CONTRACT,
  type ClipRange, type LookPreset, type PostBrief, type PostCaption, type PostFormat, type PostIdea, type PostKit,
  type PostKitAsset, type PostKitMatch, type TreatmentPlan,
} from "../../../shared/postKit";
import { hasHardSafetyFlag, isTheAthlete, type AssetTags } from "../../lib/visionTag";
import { brandsOf, brandsShown, type Brand } from "../../studio/agent/brands";
import { snapCut, type CastableRow } from "../../studio/agent/cast";
import { capabilityBlock } from "../../studio/agent/entryPrompt";
import { TRACK_MOODS } from "../../studio/music/tracks";
import { capWords } from "../../studio/text";
import { DEFAULT_STILL_SEC } from "../../studio/video/spec";
import { findNeverContent } from "../policy";
import { POST_KIT } from "./config";

// ─── The post to make ────────────────────────────────────────────────────────────────────────────────────────────

/** A moment decision's detail (kind other, detail.kind "moment", §2), read defensively: every field may be absent. */
export interface MomentRef {
  decisionId: string;
  name: string | null;
  date: string | null;
  /** The scan's own one-line why (design §4/§12 "More info"). */
  whyNow: string | null;
  idea: Partial<PostIdea>;
  brief: Partial<PostBrief>;
  mediaNeeds: string | null;
}

export interface PostSpec {
  momentDecisionId: string | null;
  idea: PostIdea;
  /** False when neither the moment nor anything else fixed the format: it follows from the picks (formatFor). */
  formatFixed: boolean;
  brief: PostBrief;
  mediaNeeds: string;
  caption: PostCaption;
  /** The partner a post names (deliverable.target), when it is a brand: other sportswear brands stay out of frame. */
  partner: PlanTarget | null;
  /** The words the library is searched by. */
  searchText: string;
}

const oneLine = (s: unknown, max: number): string => (typeof s === "string" ? capWords(s, max) : "");
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// The caption, its tags and the shot list, read out of what the plan wrote (agent/postKit/caption.ts; plan 1.7.0 returns
// them as fields of their own, and a brief written before it is cut at every label it carries).
import { captionField, captionFromBody, hashtagsFromBody, hashtagsOf, shotListFromBody, withTags } from "./caption";
export { captionFromBody, hashtagsOf, shotListFromBody };

/**
 * A caption, as a caption keeps it: its line breaks kept (only runs of blank lines folded), trimmed, at most
 * CAPTION_CHARS — cut at the last space before the limit when there is one.
 */
export function capCaption(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= POST_KIT.CAPTION_CHARS) return t;
  const head = t.slice(0, POST_KIT.CAPTION_CHARS);
  const cut = head.search(/\s\S*$/);
  return (cut > POST_KIT.CAPTION_CHARS / 2 ? head.slice(0, cut) : head).trim();
}

/** The first sentence of a text (up to . ! ? or a line break), at most `max` characters at a word. */
export function firstSentence(text: string, max: number): string {
  const t = text.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(t);
  return capWords(m ? m[1] : t, max);
}

const isFormat = (v: unknown): v is PostFormat => typeof v === "string" && (POST_FORMATS as readonly string[]).includes(v);

/**
 * The moment off its decision row (the moments scan's candidate post: memory_decisions kind other, detail.kind
 * "moment", shared/plan.ts MomentDecisionDetail), or null when the row is not a moment. The row is jsonb, so every
 * field is read defensively (a partial or older row yields what it has); the fact, when given, names and dates it.
 */
export function momentOf(decisionId: string, detail: Partial<MomentDecisionDetail> | Record<string, unknown> | undefined, fact: MemoryFact | null): MomentRef | null {
  if (!detail || detail.kind !== "moment") return null;
  const d = detail as Partial<MomentDecisionDetail>;
  const idea: Partial<MomentDecisionDetail["idea"]> = d.idea && typeof d.idea === "object" ? d.idea : {};
  const brief: Partial<MomentDecisionDetail["brief"]> = d.brief && typeof d.brief === "object" ? d.brief : {};
  return {
    decisionId,
    name: fact?.subject.name ?? (str(d.name) || null),
    date: fact?.date ?? (str(d.date) || null),
    whyNow: str(d.whyNow) || null,
    idea: {
      hook: str(idea.hook) || undefined, platform: str(idea.platform) || undefined, timing: str(idea.timing) || undefined,
      format: isFormat(idea.format) ? idea.format : undefined,
    },
    // moments 1.2.0: a moment's one angle is the idea its caption carries (a row from before has a brief of its own).
    brief: { show: str(brief.show) || undefined, captionAngle: str(brief.captionAngle) || str(idea.angle) || undefined, avoid: str(brief.avoid) || undefined },
    mediaNeeds: str(d.mediaNeeds) || null,
  };
}

/** True when a line carries never-content (contact formats, a never-use name). */
const unsafeText = (text: string, neverTerms: readonly string[]) => findNeverContent(text, neverTerms).length > 0;

/**
 * The post to make. The plan's deliverable is the base (its caption was written and checked by the plan step), and the
 * plan's own idea for the post (detail.post: format, what it shows, the caption's angle, what to avoid, the media it
 * needs) leads line by line — the plan picks the format and the shot list (moments 1.2.0). A moment's words, when the
 * action is timed for one, fill only what the plan left empty (a moment written before 1.2.0 still carries a format,
 * a brief and media needs). Any line that carries never-content falls back to the next source.
 */
export function postSpecOf(
  det: ActionDecisionDetail, suggested: string, moment: MomentRef | null, neverTerms: readonly string[],
  dueWords: (iso: string) => string,
): PostSpec {
  const body = det.deliverable?.body ?? "";
  // plan 1.7.0: the caption, its tags and the shots are fields of their own — the kit takes them as written. Once the
  // `caption` key is there (validate.ts writes it on every 1.7.0 post_brief, "" included) the body is NEVER read for the
  // caption: a 1.7.0 body is the production brief, and an unlabelled brief read as a caption is the bug this fixes. A
  // deliverable from before carries all three in its body, which is cut at every label it holds (agent/postKit/
  // caption.ts). No caption leaves the kit's caption "" (the athlete writes one, or the copy pass does): never the
  // brief, and never the action's title standing in for one. The text kept is what is pasted: the words, then the tags
  // they do not already carry; `hashtags` lists every tag in it.
  const d = det.deliverable as Partial<typeof det.deliverable> | undefined;
  const structured = d && (typeof d.caption === "string" || d.caption === null) ? d : null;
  const words = structured ? captionField(structured.caption ?? "") : captionFromBody(body);
  const tags = structured ? structured.hashtags ?? [] : hashtagsFromBody(body);
  const captionText = capCaption(withTags(words, tags));
  const shotList = det.deliverable?.shots?.length ? det.deliverable.shots.join("; ") : shotListFromBody(body);
  const what = det.what || suggested;
  const post = det.post ?? null;
  const safe = (s: string | undefined | null): string | undefined => (s && s.trim() && !unsafeText(s, neverTerms) ? s : undefined);
  const pick = (fromPlan: string | undefined | null, fromMoment: string | undefined | null, fallback: string, max: number) =>
    oneLine(safe(fromPlan) ?? safe(fromMoment) ?? fallback, max);
  const hook = pick(post?.hook, moment?.idea.hook, firstSentence(captionText, 160) || what, 160);
  const format = (post?.format && isFormat(post.format) ? post.format : null) ?? moment?.idea.format ?? null;
  const timing = pick(null, moment?.idea.timing, det.dueOn ? `By ${dueWords(det.dueOn)}` : "This week", 120);
  const platform = oneLine(det.deliverable?.platform || moment?.idea.platform || "", 40);
  const show = pick(post?.show, moment?.brief.show, shotList || what, 300);
  const captionAngle = pick(post?.captionAngle, moment?.brief.captionAngle, firstSentence(captionText, 200), 200);
  const avoid = pick(post?.avoid, moment?.brief.avoid, "", 200);
  const mediaNeeds = pick(post?.mediaNeeds, moment?.mediaNeeds, "", 200);
  const target = det.deliverable?.target ?? null;
  return {
    momentDecisionId: moment?.decisionId ?? null,
    idea: { hook, format: format ?? "reel", platform, timing },
    formatFixed: format !== null,
    brief: { show, captionAngle, avoid },
    mediaNeeds,
    caption: { text: captionText, hashtags: hashtagsOf(captionText), edited: false },
    partner: target && target.subjectKind === "brand" ? target : null,
    searchText: [hook, show, mediaNeeds].filter(Boolean).join(" "),
  };
}

// ─── Which library rows may be in a kit ──────────────────────────────────────────────────────────────────────────

export const INELIGIBLE_REASONS = [
  "untagged", "not_own_footage", "athlete_not_in_it", "meta_image", "brand_unsafe", "rejected_by_tagger",
  "conflicting_brand", "never_term", "used_in_another_post", "clip_length_unknown",
] as const;
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

export interface EligibilityContext {
  neverTerms: readonly string[];
  /** Brands that may not be in frame (other sportswear brands when the post names a partner). */
  avoidBrands: readonly Brand[];
  /** Assets already in another kit. */
  used: ReadonlySet<string>;
}

/** Every line of tagger text on a row, for the never-use check. */
function taggerText(row: CastableRow): string {
  const v = row.vision ?? {};
  const parts = [v.description, v.setting, v.attire, v.vibe, v.edit_note, v.reason, ...(Array.isArray(v.brands_visible) ? v.brands_visible : [])];
  return [...parts.filter((p): p is string => typeof p === "string"), ...row.beats.map((b) => b.description)].join("\n");
}

/** Why a row may not be in a post kit, or null when it may. The order is the order of the checks; the first wins. */
export function ineligibleReason(row: CastableRow, ctx: EligibilityContext): IneligibleReason | null {
  if (!row.vision) return "untagged";
  if (row.provenance !== "camera" && row.provenance !== "synced") return "not_own_footage";
  // A post about her uses a photo of HER: the profile-aware tagger said so (a legacy blind tag is unsure, so it is out).
  if (row.athletePresent !== true || !isTheAthlete(row.vision)) return "athlete_not_in_it";
  if (row.meta) return "meta_image";
  if (row.vision.brand_safe === false || hasHardSafetyFlag(row.vision as Pick<AssetTags, "content_flags">)) return "brand_unsafe";
  if (row.vision.disposition === "reject") return "rejected_by_tagger";
  if (ctx.avoidBrands.length && brandsShown(brandsOf(row.vision), ctx.avoidBrands).length) return "conflicting_brand";
  if (ctx.neverTerms.length && findNeverContent(taggerText(row), ctx.neverTerms).includes("never_term")) return "never_term";
  if (ctx.used.has(row.id)) return "used_in_another_post";
  if (row.mediaType === "clip" && row.durationSeconds === null && row.beats.length === 0) return "clip_length_unknown";
  return null;
}

// ─── Segments and clip ranges ────────────────────────────────────────────────────────────────────────────────────

export interface Segment {
  startSec: number;
  endSec: number;
  from: "beat" | "shot";
  /** A described beat's words (the tagger's); "" for a camera cut. */
  what: string;
}

/** At most this many segments per clip are shown to the re-rank (a long clip's tail is not offered). */
export const MAX_SEGMENTS = 12;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A clip's segments: its described beats; else the spans between its camera cuts; else none. [] on a photo. */
export function segmentsOf(row: CastableRow): Segment[] {
  if (row.mediaType !== "clip") return [];
  if (row.beats.length) return row.beats.slice(0, MAX_SEGMENTS).map((b) => ({ startSec: b.startSec, endSec: b.endSec, from: "beat" as const, what: b.description }));
  const cuts = row.shots ?? [];
  const end = row.durationSeconds;
  if (!cuts.length || end === null) return [];
  const edges = [0, ...cuts.filter((c) => c > 0 && c < end), end];
  const out: Segment[] = [];
  for (let i = 0; i + 1 < edges.length && out.length < MAX_SEGMENTS; i++) {
    if (edges[i + 1] - edges[i] >= POST_KIT.MIN_CLIP_SEC) out.push({ startSec: edges[i], endSec: edges[i + 1], from: "shot", what: "" });
  }
  return out;
}

/**
 * A clip's seconds. The chosen segment (or, with none chosen — a swap, or a clip the re-rank named no segment of — the
 * clip's first segment, else its opening), capped at `maxSec` from its start, snapped onto a camera cut by the caster's
 * own snap (STUDIO_SHOT_DETECT), and stretched to MIN_CLIP_SEC when the clip allows.
 */
export function clipRangeFor(row: CastableRow, segment: Segment | null, maxSec: number = POST_KIT.MAX_CLIP_SEC): ClipRange {
  const seg = segment ?? segmentsOf(row)[0] ?? null;
  const duration = row.durationSeconds ?? (row.beats.length ? Math.max(...row.beats.map((b) => b.endSec)) : maxSec);
  let startSec = seg ? seg.startSec : 0;
  let endSec = seg ? seg.endSec : Math.min(duration, maxSec);
  if (endSec - startSec > maxSec) endSec = startSec + maxSec;
  const snapped = snapCut(row.id, { startSec, endSec }, row.shots, row.durationSeconds);
  startSec = Math.max(0, snapped.startSec);
  endSec = Math.min(duration, snapped.endSec);
  if (endSec - startSec < POST_KIT.MIN_CLIP_SEC) {
    endSec = Math.min(duration, startSec + POST_KIT.MIN_CLIP_SEC);
    if (endSec - startSec < POST_KIT.MIN_CLIP_SEC) startSec = Math.max(0, endSec - POST_KIT.MIN_CLIP_SEC);
  }
  return { startSec: round2(startSec), endSec: round2(endSec), from: seg ? seg.from : "opening" };
}

/** Video formats play in time; a feed post or carousel is swiped. */
export const isVideoFormat = (f: PostFormat): boolean => f === "reel" || f === "story";

/**
 * Fits a video post's clips into TOTAL_MAX_SEC: the later clips give up seconds first, none below MIN_CLIP_SEC. Stills
 * count at their hold. Returns new ranges (by asset id); a cut that already fits comes back unchanged.
 */
export function fitToTotal(assets: readonly PostKitAsset[], stillSec: number, maxTotal: number = POST_KIT.TOTAL_MAX_SEC): Map<string, ClipRange> {
  const ranges = new Map(assets.filter((a) => a.clip).map((a) => [a.assetId, { ...a.clip! }]));
  const total = () => assets.reduce((n, a) => n + (a.clip ? ranges.get(a.assetId)!.endSec - ranges.get(a.assetId)!.startSec : stillSec), 0);
  let over = round2(total() - maxTotal);
  for (let i = assets.length - 1; i >= 0 && over > 0; i--) {
    const r = ranges.get(assets[i].assetId);
    if (!r) continue;
    const give = Math.min(over, round2(r.endSec - r.startSec - POST_KIT.MIN_CLIP_SEC));
    if (give <= 0) continue;
    r.endSec = round2(r.endSec - give);
    over = round2(over - give);
  }
  return ranges;
}

// ─── The re-rank's answer ────────────────────────────────────────────────────────────────────────────────────────

export interface MatchAnswer {
  picks: Array<{ row: CastableRow; segment: Segment | null }>;
  noneFit: boolean;
  noneFitNote: string | null;
  look: LookPreset;
  musicMood: string | null;
}

/**
 * The model's JSON → picks, checked: only refs it was shown, each once, at most `maxPicks`; a segment only when it is
 * one of that clip's; the look and mood from the fixed lists (else natural / none). Nothing the model writes is kept as
 * athlete-facing text.
 */
export function parseMatch(json: unknown, refs: ReadonlyMap<string, CastableRow>, maxPicks: number): MatchAnswer {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const picks: MatchAnswer["picks"] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(j.picks) ? j.picks : []) {
    if (picks.length >= maxPicks) break;
    const ref = str((p as Record<string, unknown>)?.ref).toUpperCase();
    const row = refs.get(ref);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const segRef = str((p as Record<string, unknown>)?.segment).toUpperCase();
    const m = /^S(\d+)$/.exec(segRef);
    const segs = segmentsOf(row);
    picks.push({ row, segment: m ? segs[Number(m[1])] ?? null : null });
  }
  const look = (LOOK_PRESETS as readonly string[]).includes(str(j.look_preset)) ? (str(j.look_preset) as LookPreset) : "natural";
  const mood = (TRACK_MOODS as readonly string[]).includes(str(j.music_mood)) ? str(j.music_mood) : null;
  const noneFit = picks.length === 0;
  return { picks, noneFit, noneFitNote: noneFit ? (oneLine(j.none_fit_reason, 300) || null) : null, look, musicMood: mood };
}

/** What the re-rank is shown: one line per candidate (C1…), segments S0… — the tagger's text, as data. */
export function candidateInput(rows: readonly CastableRow[]): { refs: Map<string, CastableRow>; lines: Array<Record<string, unknown>> } {
  const refs = new Map<string, CastableRow>();
  const lines = rows.map((row, i) => {
    const ref = `C${i + 1}`;
    refs.set(ref, row);
    const v = row.vision ?? {};
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
    return {
      ref, kind: row.mediaType,
      description: oneLine(v.description, 300), shot_type: oneLine(v.shot_type, 40), setting: oneLine(v.setting, 120),
      attire: oneLine(v.attire, 120), vibe: oneLine(v.vibe, 120), quality: num(v.aesthetic_quality),
      duration_sec: row.mediaType === "clip" ? num(row.durationSeconds) : null,
      segments: segmentsOf(row).map((s, k) => ({ ref: `S${k}`, start_sec: round2(s.startSec), end_sec: round2(s.endSec), what: oneLine(s.what, 160) })),
    };
  });
  return { refs, lines };
}

/**
 * The refs a model run used (C1…, A1…), rebuilt from the ids it was shown in the order it was shown them (its
 * evidence) — for a reused run, whose answer names refs of THAT input, not of a fresh search. A row that is gone or no
 * longer kept leaves its ref unmapped (a pick naming it is dropped); the others keep their original numbers.
 */
export function refsInOrder(ids: readonly string[], rows: ReadonlyMap<string, CastableRow>, prefix: string, keep: (row: CastableRow) => boolean): Map<string, CastableRow> {
  const out = new Map<string, CastableRow>();
  ids.forEach((id, i) => {
    const row = rows.get(id);
    if (row && keep(row)) out.set(`${prefix}${i + 1}`, row);
  });
  return out;
}

// ─── The capability block ────────────────────────────────────────────────────────────────────────────────────────

/** Whole days from `now` (UTC) to an ISO date, or null when the date does not read as one. */
export function daysUntil(now: Date, iso: string | null): number | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return null;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(day)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((day - today) / 86_400_000);
}

/**
 * The capability block for this post (AGENT_POST_KIT_CAPABILITY_BLOCK): the post-kit surface of the Studio library,
 * with this post's facts — its format when fixed, the moment and how far off it is, whether it names a partner, and
 * what the candidates hold. A clip's frame rate is not read yet (left unknown, which hides nothing).
 */
export function capabilitiesFor(spec: PostSpec, moment: MomentRef | null, rows: readonly CastableRow[], now: Date): string {
  return capabilityBlock({
    surface: "post_kit",
    format: spec.formatFixed ? spec.idea.format : null,
    forBrand: spec.partner !== null,
    moment: moment ? { name: moment.name, date: moment.date, daysAway: daysUntil(now, moment.date) } : null,
    candidates: {
      photos: rows.filter((r) => r.mediaType === "photo").length,
      clips: rows.filter((r) => r.mediaType === "clip").length,
      maxFps: null,
    },
    maxSec: POST_KIT.TOTAL_MAX_SEC,
  });
}

// ─── The kit ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The format: the moment's when it set one; else from the picks — any clip → reel, 2+ photos → carousel, one → feed. */
export function formatFor(spec: PostSpec, mediaTypes: ReadonlyArray<"photo" | "clip">): PostFormat {
  return spec.formatFixed ? spec.idea.format : formatOfPicks(mediaTypes);
}

/** The format the picks themselves make: any clip → reel, 2+ photos → carousel, one photo → feed. */
export function formatOfPicks(mediaTypes: ReadonlyArray<"photo" | "clip">): PostFormat {
  if (mediaTypes.includes("clip")) return "reel";
  return mediaTypes.length >= 2 ? "carousel" : "feed";
}

/** Whether an asset of this kind belongs in a post of this format: a feed post is a photo; the rest take either. */
export const fitsFormat = (format: PostFormat, mediaType: "photo" | "clip"): boolean => format !== "feed" || mediaType === "photo";

/** The most assets a format holds: a feed post is one picture, a carousel up to MAX_ASSETS, a reel or story VIDEO_MAX_ASSETS. */
export const maxAssetsFor = (f: PostFormat): number => (f === "feed" ? 1 : f === "carousel" ? POST_KIT.MAX_ASSETS : POST_KIT.VIDEO_MAX_ASSETS);

export function assetOf(row: CastableRow, segment: Segment | null): PostKitAsset {
  return {
    assetId: row.id,
    mediaType: row.mediaType,
    clip: row.mediaType === "clip" ? clipRangeFor(row, segment) : null,
    durationSec: row.mediaType === "clip" ? row.durationSeconds : null,
    provenance: row.provenance === "synced" ? "synced" : "camera",
  };
}

/**
 * The treatment plan for these assets, in order (§11). A video format holds each photo DEFAULT_STILL_SEC and fits the
 * whole cut into TOTAL_MAX_SEC (the asset ranges are updated to match, so the kit and its plan never disagree). The
 * overlay is the hook, on a video format only, and only when it carries no never-content.
 */
export function treatmentFor(
  format: PostFormat, assets: PostKitAsset[], look: { lookPreset: LookPreset; musicMood: string | null }, hook: string, neverTerms: readonly string[],
): { treatment: TreatmentPlan; assets: PostKitAsset[] } {
  const video = isVideoFormat(format);
  const fitted = video ? fitToTotal(assets, DEFAULT_STILL_SEC) : new Map(assets.filter((a) => a.clip).map((a) => [a.assetId, a.clip!]));
  const out = assets.map((a) => (a.clip ? { ...a, clip: { ...fitted.get(a.assetId)!, from: a.clip.from } } : a));
  const trims = out.filter((a) => a.clip).map((a) => ({ assetId: a.assetId, startSec: a.clip!.startSec, endSec: a.clip!.endSec }));
  const stills = video ? out.filter((a) => !a.clip).map((a) => ({ assetId: a.assetId, holdSec: DEFAULT_STILL_SEC })) : [];
  const first = out[0];
  const overlay = video && hook && !unsafeText(hook, neverTerms) ? capWords(hook, POST_KIT.OVERLAY_CHARS) : null;
  const totalSec = video && out.length
    ? round2(trims.reduce((n, t) => n + (t.endSec - t.startSec), 0) + stills.reduce((n, s) => n + s.holdSec, 0))
    : null;
  return {
    assets: out,
    treatment: {
      aspect: video ? "9:16" : "4:5",
      cropToFill: true,
      order: out.map((a) => a.assetId),
      trims,
      stills,
      overlayText: overlay,
      lookPreset: look.lookPreset,
      musicMood: look.musicMood,
      coverFrame: first ? { assetId: first.assetId, atSec: first.clip ? round2(first.clip.startSec + Math.min(1, (first.clip.endSec - first.clip.startSec) / 2)) : null } : null,
      totalSec,
    },
  };
}

/** Fixed words for the generation flag: the athlete reads them; the model's own note stays internal. */
export const AI_REASONS = {
  realFootage: "Built from your own photos and clips.",
  emptyLibrary: "No photos or clips of you in your library can be used for this post yet.",
  noneFit: "Nothing in your library shows what this post needs yet.",
} as const;

export function assembleKit(input: {
  spec: PostSpec; picks: MatchAnswer["picks"]; shortlist: CastableRow[]; look: LookPreset; musicMood: string | null;
  match: PostKitMatch; eligibleCount: number; neverTerms: readonly string[]; now: Date;
}): PostKit {
  const format = formatFor(input.spec, input.picks.map((p) => p.row.mediaType));
  const picks = input.picks.filter((p) => fitsFormat(format, p.row.mediaType)).slice(0, maxAssetsFor(format));
  const { assets, treatment } = treatmentFor(format, picks.map((p) => assetOf(p.row, p.segment)), { lookPreset: input.look, musicMood: input.musicMood }, input.spec.idea.hook, input.neverTerms);
  const picked = new Set(assets.map((a) => a.assetId));
  const at = input.now.toISOString();
  return {
    contract: POST_KIT_CONTRACT,
    momentDecisionId: input.spec.momentDecisionId,
    idea: { ...input.spec.idea, format },
    formatFromMoment: input.spec.formatFixed,
    brief: input.spec.brief,
    assets,
    shortlist: input.shortlist.map((r) => r.id).filter((id) => !picked.has(id)),
    caption: input.spec.caption,
    treatmentPlan: treatment,
    aiGenerationNeeded: assets.length
      ? { value: false, reason: AI_REASONS.realFootage }
      : { value: true, reason: input.eligibleCount ? AI_REASONS.noneFit : AI_REASONS.emptyLibrary },
    match: input.match,
    builtAt: at,
    updatedAt: at,
  };
}

/**
 * The athlete swaps one asset for one from the same shortlist (no model call). The new asset takes the old one's place;
 * the old one goes to the front of the shortlist (so it can be swapped back); a clip's seconds are its first segment;
 * the treatment is recomputed around the same format, look, mood and hook.
 */
export function swapInKit(kit: PostKit, replaceId: string, withRow: CastableRow, neverTerms: readonly string[], now: Date): PostKit {
  const at = kit.assets.findIndex((a) => a.assetId === replaceId);
  if (at < 0) throw new Error("the asset to replace is not in the kit");
  if (kit.formatFromMoment && !fitsFormat(kit.idea.format, withRow.mediaType)) throw new FormatMismatch(kit.idea.format, withRow.mediaType);
  const assets = kit.assets.map((a, i) => (i === at ? assetOf(withRow, null) : a));
  // A format the picks made follows the picks; one the moment set holds (checked above).
  const format = kit.formatFromMoment ? kit.idea.format : formatOfPicks(assets.map((a) => a.mediaType));
  const { assets: fitted, treatment } = treatmentFor(format, assets, { lookPreset: kit.treatmentPlan.lookPreset, musicMood: kit.treatmentPlan.musicMood }, kit.idea.hook, neverTerms);
  return {
    ...kit,
    idea: { ...kit.idea, format },
    assets: fitted,
    shortlist: [replaceId, ...kit.shortlist.filter((id) => id !== withRow.id && id !== replaceId)],
    treatmentPlan: treatment,
    updatedAt: now.toISOString(),
  };
}

/** A swap that would break a format the moment set (a clip into a feed post). */
export class FormatMismatch extends Error {
  constructor(readonly format: PostFormat, readonly mediaType: "photo" | "clip") { super(`a ${mediaType} does not fit a ${format} post`); }
}

/** The athlete's own caption: the text as typed (trimmed, capped), its tags listed. */
export function withCaption(kit: PostKit, text: string, now: Date): PostKit {
  const t = text.replace(/\r\n?/g, "\n").trim().slice(0, POST_KIT.CAPTION_CHARS);
  return { ...kit, caption: { text: t, hashtags: hashtagsOf(t), edited: true }, updatedAt: now.toISOString() };
}

/** The asset ids a decision's kit holds, or [] (for "used"). */
export function kitAssetIds(detail: Record<string, unknown> | undefined): string[] {
  const kit = (detail as Partial<ActionDecisionDetail> | undefined)?.prepared?.postKit;
  return Array.isArray(kit?.assets) ? kit!.assets.map((a) => a.assetId).filter((id): id is string => typeof id === "string") : [];
}
