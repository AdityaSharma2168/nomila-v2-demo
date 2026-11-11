/**
 * shared/postKit.ts — the post kit contract (design "Moments → post kits" v2, §9–§11; build step 4, "Track E").
 *
 * A post kit is everything needed to make one post by hand: the idea and brief, 1–3 real assets from the athlete's own
 * library (with the exact seconds of any clip), a draft caption, and a TREATMENT PLAN — data, not video, in the shape a
 * later render compiles to (server/studio/video/types.ts StitchRequest). It lives on the SAME memory_decisions row as
 * the plan action it fulfils (kind "action", detail.kind "post") at detail.prepared.postKit; the kit's id is the
 * decision's id, which is also what detail.prepared.studioItemId holds. Building it moves the action's GoalActionState
 * from to_start to made. No table, no migration.
 *
 * Also here: the idea-bank entry (§6), memory_decisions kind "other", detail.kind "idea". Three writers, told apart by the
 * row's skill_id: the reverse pass (post-kit/ideas: assets → post ideas), the weekly moments scan (moments: one entry
 * per moment's candidate post) and the plan (plan: a fresh evergreen idea, or a missed timely idea adapted to a later
 * event). The plan reads the bank before it invents (server/agent/ideaBank, build step 8).
 *
 * Types and constants only, no runtime dependencies (shared/agent.ts rules). Nothing here names an athlete, sport,
 * school, league or brand.
 */

export const POST_KIT_CONTRACT = "post-kit/1" as const;

/** A caption's length, at most (the platforms' common ceiling): the server refuses longer, the screen stops typing there. */
export const POST_KIT_CAPTION_CHARS = 2_200;

/** The post's format, as the moments scan and the idea bank write it. */
export const POST_FORMATS = ["reel", "carousel", "story", "feed"] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

/** The frame the post is cut for: 9:16 for a reel or story, 4:5 for a feed post or carousel. */
export const POST_ASPECTS = ["9:16", "4:5"] as const;
export type PostAspect = (typeof POST_ASPECTS)[number];

/**
 * A look, by NAME only. The preview render (agent/postKit/render) applies it as one fixed ffmpeg colour filter per name
 * (studio/video/look.ts) — to every clip, held photo and carousel picture alike; "natural" is no filter at all.
 */
export const LOOK_PRESETS = ["natural", "warm", "cool", "vivid", "muted", "mono"] as const;
export type LookPreset = (typeof LOOK_PRESETS)[number];

/** The idea: the one line that stops the scroll, and where and when it goes up. */
export interface PostIdea {
  hook: string;
  format: PostFormat;
  platform: string;
  /** When relative to the moment (or the due date) it should go up, in words. */
  timing: string;
}

/** The brief: what the post shows, the one idea the caption carries, and what would make it feel wrong. */
export interface PostBrief {
  show: string;
  captionAngle: string;
  avoid: string;
}

/** How a clip's seconds were chosen: a described beat, a camera cut (shot), or the clip's opening when it has neither. */
export const CLIP_RANGE_SOURCES = ["beat", "shot", "opening"] as const;
export type ClipRangeSource = (typeof CLIP_RANGE_SOURCES)[number];

export interface ClipRange {
  startSec: number;
  endSec: number;
  from: ClipRangeSource;
}

/** One real asset from the athlete's own library, in the order it appears. */
export interface PostKitAsset {
  assetId: string;
  mediaType: "photo" | "clip";
  /** A clip's seconds (absolute in the source); null on a photo. */
  clip: ClipRange | null;
  /** A clip's measured length, when known; null on a photo. */
  durationSec: number | null;
  /** Where it came from: the athlete's camera or their synced accounts (nothing made here is ever picked). */
  provenance: "camera" | "synced";
}

/** A still held inside a video format (reel or story): how long it plays. */
export interface TreatmentStill {
  assetId: string;
  holdSec: number;
}

/** A clip's trim, as StitchClip.trimStartSec / trimEndSec will take it. */
export interface TreatmentTrim {
  assetId: string;
  startSec: number;
  endSec: number;
}

/**
 * The treatment plan (§11): exactly what a render WOULD do, as data. Compiles later to
 *   aspect + cropToFill → StitchTarget width/height + StitchFinishing.cropToFill
 *   order               → the StitchClip[] order
 *   trims / stills      → StitchClip.trimStartSec / trimEndSec, and a still's hold
 *   overlayText         → captionRender.ts PNG band → StitchClip.overlay (text never reaches ffmpeg's argv)
 *   musicMood           → server/studio/music recommend() → StitchRequest.audioBed
 *   lookPreset          → StitchFinishing.look: one fixed ffmpeg colour filter (studio/video/look.ts)
 *   coverFrame          → one ffmpeg still taken off the rendered preview at that moment (the preview's poster)
 * The compiler is agent/postKit/render/compile.ts; the render runs on the stitch queue (studio/stitchRunner.ts).
 */
export interface TreatmentPlan {
  aspect: PostAspect;
  cropToFill: boolean;
  /** Asset ids, in sequence. */
  order: string[];
  /** One per clip, in order. */
  trims: TreatmentTrim[];
  /** One per photo when the format is video (reel, story); empty for a feed post or carousel. */
  stills: TreatmentStill[];
  /** The short line laid over the opening, or null for none. */
  overlayText: string | null;
  lookPreset: LookPreset;
  /** One of the music catalogue's moods (server/studio/music/tracks.ts TRACK_MOODS), or null for no music. */
  musicMood: string | null;
  /** The frame shown before it plays: an asset and, for a clip, the second to take it from. */
  coverFrame: { assetId: string; atSec: number | null } | null;
  /** The cut's length for a video format (reel, story); null for a feed post or carousel. */
  totalSec: number | null;
}

/**
 * One of a kit's suggested tracks (AGENT_POST_KIT_MUSIC_CHOICES; server/studio/music/find.ts). Facts from the catalogue
 * only: the reason is built from the track's own tags, never written by a model.
 */
export interface KitMusicChoice {
  /** A catalogue id (server/studio/music tracks.ts or library.ts). */
  trackId: string;
  title: string;
  artist: string;
  /** One line: why this track, from its moods, energy, tempo and length. */
  reason: string;
  /** "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0" or "artlist". */
  licence: string;
  /** The credit line the post must carry (CC-BY), or null. While this track is selected it is in the caption. */
  credit: string | null;
  /** Its short form (title, author, licence), used only when the caption has no room for the full one. */
  creditShort?: string | null;
  /** The recording is registered with YouTube Content ID (claims are possible). Absent on kits built before it. */
  contentIdRegistered?: boolean | null;
}

/** postKit.music: up to three suggested tracks and the one under the preview. */
export interface KitMusic {
  /** 1–3, best first. */
  choices: KitMusicChoice[];
  /** One of the choices' trackId, or null for no music. */
  selected: string | null;
}

/** The draft caption. `hashtags` are the tags the text carries, as a list. */
export interface PostCaption {
  text: string;
  hashtags: string[];
  /** True once the athlete changed it. */
  edited: boolean;
}

/** How the assets were matched: the one cheap-tier re-rank run, for audit and the cost ledger. Never shown. */
export interface PostKitMatch {
  /** agent_runs id of the post-kit/match run, or null when there was nothing eligible to rank (no call made). */
  runId: string | null;
  skillVersion: string | null;
  /** Candidates that passed every check and were shown to the re-rank. */
  candidates: number;
  costMicroUsd: number;
  /** When the re-rank found nothing that fits: its one-line note on what the brief needs. Internal, never shown. */
  noneFitNote: string | null;
}

/** The post kit (memory_decisions.detail.prepared.postKit on the action's own row). */
export interface PostKit {
  contract: typeof POST_KIT_CONTRACT;
  /** The moment this came from, if any — the moment's decision id (kind other, detail.kind moment). */
  momentDecisionId: string | null;
  idea: PostIdea;
  /**
   * True when the moment set the format: a swap must keep to it (a feed post stays one photo). False when the format
   * followed from the picks: a swap recomputes it (a photo swapped for a clip turns a feed post into a reel).
   */
  formatFromMoment: boolean;
  brief: PostBrief;
  /** 1–3 real assets from the athlete's library, in the order they appear. Empty only when nothing fits (see below). */
  assets: PostKitAsset[];
  /** The rest of the same shortlist, eligible and not picked: what "swap" offers (no fresh model call). */
  shortlist: string[];
  caption: PostCaption;
  treatmentPlan: TreatmentPlan;
  /**
   * Whether a generated asset is needed instead of a real one. Defaults to false: the kit runs on real footage. True only
   * when no real asset in the library fits the brief at all — and even then nothing is generated: it is a flag for the
   * athlete (tap-to-send rule).
   */
  aiGenerationNeeded: { value: boolean; reason: string };
  match: PostKitMatch;
  builtAt: string;
  /** Set on every swap or caption edit. */
  updatedAt: string;
  /**
   * The suggested tracks (AGENT_POST_KIT_MUSIC_CHOICES): absent on a kit built without them, which then renders the way
   * it always did (treatmentPlan.musicMood → the best track for that mood). Present: the preview's music is `selected`.
   */
  music?: KitMusic;
  /**
   * The rendered preview (design §11 v2, build step 9): absent until a render is asked for (AGENT_POST_KIT_RENDER).
   * Holds asset ids, never URLs: a signed URL expires within the hour, so every read signs fresh ones
   * (PostKitResponse.preview.previewUrl). A swap clears it; the render request that follows writes the new one.
   */
  preview?: PostKitPreview;
  /**
   * The copy pass (COPYWRITER_V1, server/services/copywriter.ts): absent on a kit built without it. Present: idea.hook and
   * caption.text are the editor's pick, `original` is the copy the plan wrote, `options` every clean option written.
   */
  copy?: { original: { hook: string; caption: string }; options: Array<{ hook: string; caption: string }> };
  /**
   * The final-text guard's mark (server/agent/postKit/finalGuard.ts): absent on a kit built before it (an edit then
   * re-checks the whole caption once). `disclosure`: "ad" — a signed / active deal, gifted product or affiliate record
   * of the athlete's matches the post's partner, so `#ad` leads the hashtags; "ask" — a brand is named with no such
   * record, nothing was added, and the athlete should be asked once: "Is this paid, gifted or an affiliate post?";
   * null — no brand.
   */
  guard?: PostKitGuard;
}

/** Whether a post owes a disclosure (PostKit.guard.disclosure). */
export type PostKitDisclosure = "ad" | "ask" | null;

export interface PostKitGuard {
  /** finalGuard.ts GUARD_VERSION when it passed (2: review round 2 rules). */
  version: number;
  /** When the kit's text last passed the guard. */
  at: string;
  disclosure: PostKitDisclosure;
}

/**
 * Why a kit was held, on the action's row (memory_decisions.detail.prepared.postKitHold): the plan workflow does not try
 * the same action again until what it was built from changes (`inputsKey`), or the athlete asks (the Build it route).
 */
export interface PostKitHold {
  reason: "never_content" | "final_guard";
  /** The final guard's block, when it was one (finalGuard.ts GuardBlock). */
  block: string | null;
  inputsKey: string;
  at: string;
}

export const POST_KIT_RENDER_CONTRACT = "post-kit-render/1" as const;

/**
 * A preview still queued this long after it was asked for (PostKitPreview.requestedAt) is stalled. The screens stop
 * polling and offer "Try again" (client/components/postKit/preview.ts); the route's re-ask then treats it as not live —
 * its job is cancelled and a fresh one queued, with a new requestedAt (agent/postKit/render/request.ts). One number,
 * so the button the screen shows is one the server honours.
 */
export const POST_KIT_PREVIEW_STALL_MS = 10 * 60 * 1000;

/** What the render left out of a preview, and why — codes, never prose. */
export const RENDER_NOTES = [
  /** A music mood was set, but the licensed tracks are not installed in this environment (STUDIO_STITCH_BEDS_READY). */
  "music_not_installed",
  /** A music mood was set, but no track that may go under this post carries it. */
  "no_track_for_mood",
  /** The overlay line has nothing the caption font can draw once emoji and other scripts are removed. */
  "overlay_not_drawable",
  /** An asset in the kit is no longer in the athlete's library: the preview was cut without it. */
  "asset_missing",
  /** A clip too short to show (under half a second) was left out. */
  "clip_too_short",
  /** The cut ran past the length cap, so its last positions were shortened or left out. */
  "over_length",
] as const;
export type RenderNote = (typeof RENDER_NOTES)[number];

/** One rendered file: a derived media asset (origin "generated", derived_from_asset_id = sourceAssetId). */
export interface PostKitPreviewOutput {
  assetId: string;
  kind: "video" | "image";
  /** The kit asset it was cut from (a reel's: its opening position). */
  sourceAssetId: string;
}

/** postKit.preview: the render asked for, and what it made. */
export interface PostKitPreview {
  contract: typeof POST_KIT_RENDER_CONTRACT;
  /** The render's inputs, hashed: the same kit renders once, and a stale render never lands on a changed kit. */
  key: string;
  status: "queued" | "ready" | "failed";
  /** The studio_stitch_jobs row working it; null when the outputs for this key already existed and were reused. */
  jobId: string | null;
  /** In order: one video for a reel or story; one picture per slide (a clip slide is a short video) otherwise. */
  outputs: PostKitPreviewOutput[];
  /** The output whose poster is the cover frame (a video's thumbnail, or the picture itself). */
  coverAssetId: string | null;
  notes: RenderNote[];
  /** A sentence the athlete can read, when status is failed. */
  error: string | null;
  /** By the DATABASE's clock (the job row's created_at, or the database's now() for a reuse), so the runner can order it against a job. */
  requestedAt: string;
  renderedAt: string | null;
}

/** GET /api/v1/me/agent/actions/:id/post-kit — the kit with what the screen draws. */
export interface PostKitResponse {
  contract: typeof POST_KIT_CONTRACT;
  decisionId: string;
  state: "to_start" | "made" | "done";
  /** Null while nothing is built yet (state to_start). */
  kit: PostKit | null;
  /** The kit's assets, then its shortlist, as the screen shows them; `available` false when an asset has since gone. */
  media: Array<{ assetId: string; mediaType: "photo" | "clip"; thumbUrl: string | null; videoUrl: string | null; available: boolean; inKit: boolean }>;
  /** The goal this action serves, in the athlete's words — already on the row (goalId); null for an action not tied to a kept goal. */
  goal: { id: string; text: string } | null;
  /** The moment this was timed for, when there is one — design §4/§12 "More info": name and the scan's own why_now. */
  moment: { name: string; whyNow: string | null } | null;
  /** Plain words why this action, from the plan step that suggested it (never shown as Mila's own voice). */
  why: string;
  /** The rendered preview, signed for this read; null while none was asked for. */
  preview: PostKitPreviewView | null;
  /**
   * The suggested tracks with a fresh listening link each (so she can hear one against the preview before choosing);
   * null when the kit has none. Optional on the wire: an older server never sends it.
   */
  music?: PostKitMusicView | null;
}

/** kit.music as a screen draws it. */
export interface PostKitMusicView {
  /**
   * `allowed` false: the post became brand work after the kit was built and this track is not brand-safe — shown,
   * but it cannot be used (the screen says why). `selected` is the track the preview actually uses.
   */
  choices: Array<KitMusicChoice & { selected: boolean; allowed: boolean; listenUrl: string | null }>;
}

/** The preview as a screen draws it: fresh signed URLs, the first output as `previewUrl`. */
export interface PostKitPreviewView {
  status: PostKitPreview["status"];
  /** The first output (the reel itself, or the first picture); null until ready, or when it has since gone. */
  previewUrl: string | null;
  /** Every output in order, signed; a url is null when that asset has since gone. */
  items: Array<{ kind: "video" | "image"; url: string | null }>;
  coverUrl: string | null;
  notes: RenderNote[];
  error: string | null;
}

// ─── The idea bank (§6) ──────────────────────────────────────────────────────────────────────────────────────────

export const IDEA_STATUSES = ["new", "used", "skipped", "adapted"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/**
 * memory_decisions.detail when detail.kind === "idea" (kind "other"). The assets an idea came from are its evidence
 * ({ kind: "record", table: "media_assets", id }), so "unused" is read off the store without a new field.
 */
export interface IdeaBankEntry {
  kind: "idea";
  /** true = expires with its moment; false = evergreen. */
  timeBound: boolean;
  /** The content pillar it serves (P1…Pn), when evergreen and pillars exist; null otherwise. */
  pillarKey: string | null;
  /**
   * That pillar's name as the Brief had it when the idea was written: P-keys are renumbered with every Brief, so the
   * plan's pillar rotation matches on the name. Null when pillarKey is null. Absent on rows written before the plan
   * read the bank (build step 8).
   */
  pillarName?: string | null;
  /** The moment decision it is bound to, when time-bound. */
  momentDecisionId: string | null;
  /** The moment's date (YYYY-MM-DD), when time-bound; null when evergreen. */
  expiresOn: string | null;
  /**
   * The idea. `format` is null on a moment's own entry since moments 1.2.0 (the scan gives an angle and a hook; the plan
   * picks the format when it uses the idea). Every other writer sets one.
   */
  idea: Omit<PostIdea, "format"> & { format: PostFormat | null };
  brief: PostBrief;
  mediaNeeds: string;
  status: IdeaStatus;
  /** The post action decision this became, once used. */
  usedInDecisionId: string | null;
  /** On a new row adapted from a missed time-bound idea: the old row's id. */
  adaptedFromIdeaId: string | null;
  /**
   * On a missed idea claimed for adapting (status "adapted"): who claimed it — the post action's decision id, or the plan
   * run whose idea move adapted it. The claim is a conditional write that changes the row, so two plan runs racing for
   * one missed idea can never both adapt it (agent/ideaBank/bank.ts claimForAdapting). A claim whose claimant crashed
   * before writing the new row is taken over by a later claimant.
   */
  adaptedFor?: string;
  /** When that claim was made (ISO): a run's claim is live for IDEA_BANK.CLAIM_LEASE_MS from it. */
  adaptedAt?: string;
  /**
   * On a row a plan run skipped (an idea move): that run's id. It marks the skip as the plan's own, so the plan's digest
   * undoes it, however old (agent/ideaBank/bank.ts rewindForDigest). Absent on any other skip (a care moment's is real).
   */
  skippedByRunId?: string;
}
