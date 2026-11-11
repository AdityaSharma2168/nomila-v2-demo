/**
 * studio/enrich/videoTag — tags one of her VIDEOS: the whole clip in the photo tagger's shape, plus
 * the beats inside it.
 *
 * Today (lib/visionTag.ts) a video row is tagged from its poster JPEG — one frame standing in for the
 * clip — and marked done. The planner then sees a description of a frame, not of a clip, and it
 * can only cast the clip whole. This module reads the clip itself, natively (Gemini video input, 1
 * fps, audio included), and writes two things into `metadata.vision`:
 *
 *   1. THE WHOLE-CLIP FIELDS, the exact `AssetTags` shape photos carry, so every existing reader
 *      (agent/cast.ts, services/mediaSearch.ts, routes/media.ts, routes/studio.ts) keeps working
 *      without knowing a video was tagged differently. They overwrite the poster-derived values:
 *      a description of one frame is strictly worse than one of the clip (Adi, 22 Sep 2026).
 *   2. `beats` — timestamped segments carrying the same tag fields, so a later planner can cut into
 *      a clip rather than cast it whole. Half B decides what to do with them; Half A only records.
 *
 * The previous vision object is stashed under `vision.prev` in the same write, so the enrichment
 * eval can diff poster-derived against video-derived tags on the same rows.
 *
 * ─── PARSE IS PURE, TRANSPORT IS INJECTED ─────────────────────────────────────────────────────
 *
 * `parseVideoTags` takes text and a duration and returns tags or null; it clamps every beat to
 * [0, duration] and drops the malformed. `tagVideo` composes a transport with it. The unit tests
 * drive parse with strings and the run loop with a fake transport; nothing here is tested against
 * Vertex.
 *
 * No untrusted text enters the prompt: the prompt is a constant, the clip is bytes. The model's
 * OUTPUT is the untrusted thing, and it re-enters prompts only where the planner already fences
 * `LibraryEntry` (studio/agent/types.ts) — beats join that same surface in Half B.
 */
import { genai } from "../../lib/models";
import { withTimeout } from "../../lib/withTimeout";
import {
  applySubject,
  hasHardSafetyFlag,
  mimeFor,
  profileBlock,
  SUBJECT_SHAPE,
  type AssetTags,
  type AthleteProfile,
} from "../../lib/visionTag";
import {
  videoEnrichModel,
  videoEnrichThinking,
  videoEnrichTimeoutMs,
} from "./config";
import type { TokenUsage } from "./videoCost";

/** One timestamped segment. The same tag fields as the clip, at the beat. */
export interface VideoBeat {
  start_s: number;
  end_s: number;
  description: string;
  shot_type: string;
  athlete_present: boolean;
  athlete_prominence: number;
  setting: string;
  attire: string;
  vibe: string;
  brands_visible: string[];
  aesthetic_quality: number;
  /** Freeform in Half A. Half B closes camera/motion into the capability enums (architecture doc §8). */
  camera: string;
  motion: string;
  hero_suitability: number;
  /** The full read only (MEDIA_VIDEO_FIXES): how steady the camera is in this beat. Absent on every other read. */
  stability?: BeatStability;
}

/** A beat's camera steadiness, as the full read asks it. A closed list: anything else is dropped at parse. */
export const BEAT_STABILITIES = ["steady", "handheld", "shaky"] as const;
export type BeatStability = (typeof BEAT_STABILITIES)[number];

/** One stretch of speech: seconds from the clip's start and the words as said. */
export interface SpeechSegment {
  start_s: number;
  end_s: number;
  text: string;
}

/**
 * What is SAID in the clip — the full read only (MEDIA_VIDEO_FIXES, media-intake plan fix 2). Lives at
 * `vision.speech`, inside the one object the read writes, so the library's text search (an ILIKE over
 * metadata.vision) finds a clip by what is said in it with no new reader.
 */
export interface VideoSpeech {
  has_speech: boolean;
  /** The main spoken language as a short code, or "" when no one speaks. */
  language: string;
  /** Music plays in the clip (a licensing question if it is ever reposted). */
  music_present: boolean;
  transcript: SpeechSegment[];
}

/** What this tagger records about the read itself — the eval keys off `model`. */
export interface VideoVisionMeta {
  source: "clip";
  model: string;
  sampled_fps: number;
  duration_s: number | null;
  tagged_at: string;
}

/** `AssetTags` plus the video-only keys. What lands in `metadata.vision` for a video row. */
export interface VideoAssetTags extends AssetTags {
  beats: VideoBeat[];
  video: VideoVisionMeta;
  /** The full read only — see VideoSpeech. Absent on every other read. */
  speech?: VideoSpeech;
  /** The vision object this write replaced (its own `prev`, if any, dropped — one level, not a chain). */
  prev?: Record<string, unknown> | null;
}

/** The frame rate the model is asked to sample at. 1 fps is the documented default and what the estimate assumes. */
export const SAMPLED_FPS = 1;

/**
 * The prompt, with THE ATHLETE named when the caller knows her (lib/visionTag.ts `profileBlock` —
 * the same two lines the photo tagger sends, by the same Mia-approved decision, 22 Sep 2026). The
 * whole-clip answer asks `subject` (the_athlete / another_person / nobody) and `athlete_present`
 * is derived from it in the parse; the beats keep their own `athlete_present` unchanged — the
 * minimum that changes the answer shape.
 */
export const videoPromptFor = (
  profile: AthleteProfile | null,
  opts: { full?: boolean } = {},
): string => `You are the media curator for a professional athlete's brand media kit and short-form content that goes to potential partners. ${profileBlock(profile)}Watch THIS video in full, with its sound. Assess the WHOLE CLIP first, then break it into BEATS.

WHOLE CLIP — the same judgement as for a photograph, applied to the clip as a whole: is THE ATHLETE clearly the subject, how polished is it, would it carry as a hero clip. A screen recording, meme, text graphic, low-res or busy group shot is a poor hero. Note any brands/logos/products visible anywhere in the clip in brands_visible.

brand_safe: true unless the clip contains content a mainstream sponsor would reject — hate symbols or slurs, obscene gestures, weapons, illegal drugs, sexual or nude content, self-harm. Visible logos or competitor brands do NOT make a clip unsafe; list them in brands_visible instead.

content_flags: for each of hateful, sexual, violence_or_weapons, drugs_or_alcohol, self_harm, obscene_gesture — true/false, for the clip as a whole, including anything said or shown on clothing, signs or screens.

Decide its disposition: "as_is" (ready), "crop" (good but reframe), "enhance" (worth upscaling/relighting), or "reject" (unusable — including anything caught by content_flags).

BEATS — split the clip into consecutive segments where the shot, setting or action changes: a cut, a new angle, a new place, a new action. A steady single shot is ONE beat. Give each beat its start and end as seconds from the start of the clip (numbers, e.g. 0 and 3.5), covering the clip in order with no gaps. For each beat give the same fields as the clip, plus camera (how it is framed and moving: e.g. "static wide", "handheld close-up", "slow push-in", "tracking side-on") and motion (what moves in frame: e.g. "the athlete sprints left to right", "still, the athlete looks at camera", "ball spins").${opts.full ? FULL_READ_BLOCK : ""}

Respond with STRICT JSON only, no prose:
{${SUBJECT_SHAPE},"athlete_prominence":0.0-1.0,"shot_type":"portrait|action|lifestyle|group|text_graphic|other","description":"what happens across the clip, short","brands_visible":["brand or logo",...],"aesthetic_quality":0.0-1.0,"brand_safe":true|false,"content_flags":{"hateful":true|false,"sexual":true|false,"violence_or_weapons":true|false,"drugs_or_alcohol":true|false,"self_harm":true|false,"obscene_gesture":true|false},"setting":"few words","attire":"few words","vibe":"few words","hero_suitability":0.0-1.0,"disposition":"as_is|crop|enhance|reject","edit_note":"what edit if any, short","reason":"one short sentence","beats":[{"start_s":0,"end_s":3.5,"description":"short","shot_type":"portrait|action|lifestyle|group|text_graphic|other","athlete_present":true|false,"athlete_prominence":0.0-1.0,"setting":"few words","attire":"few words","vibe":"few words","brands_visible":[],"aesthetic_quality":0.0-1.0,"camera":"few words","motion":"few words","hero_suitability":0.0-1.0${opts.full ? FULL_READ_BEAT_SHAPE : ""}},...]${opts.full ? FULL_READ_SHAPE : ""}}`;

/**
 * THE FULL READ (MEDIA_VIDEO_FIXES, media-intake plan fix 2): the same call, which already hears the audio, also writes
 * down what is said and how steady each beat is. Added to the prompt above only when the read is a full one, so with
 * the flag off the prompt is byte-identical to before. Prompt Register §24.
 */
export const FULL_READ_BLOCK = `

STEADINESS — for each beat also give stability: "steady" (on a tripod or gimbal-smooth), "handheld" (small natural movement) or "shaky" (jerky enough to distract a viewer).

SPEECH — listen to the sound. has_speech: true only if someone speaks words (crowd noise, cheering or song lyrics alone are not speech). language: the main spoken language as a two-letter code, or "" when no one speaks. music_present: true if music plays (a soundtrack, a song, a band), else false. transcript: what is said, in order, as segments with start_s and end_s in seconds from the start of the clip and the words exactly as spoken, in the language spoken — do not translate, summarise or tidy them. In the transcript only, write any name that is said aloud as it is said. Write [inaudible] for words you cannot make out, and never add words that are not said. When no one speaks, transcript is [].`;

/** The key the full read adds to each beat in the answer shape. */
export const FULL_READ_BEAT_SHAPE = `,"stability":"steady|handheld|shaky"`;

/** The key the full read adds after "beats" in the answer shape. */
export const FULL_READ_SHAPE = `,"speech":{"has_speech":true|false,"language":"two-letter code or empty","music_present":true|false,"transcript":[{"start_s":0,"end_s":2.5,"text":"the words as spoken"},...]}`;

/** The profile-less prompt — what the tagger sent before the profile existed, and what a caller without an athlete still sends. */
export const VIDEO_PROMPT = videoPromptFor(null);

const num = (v: unknown, lo = 0, hi = 1): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const bool = (v: unknown): boolean => v === true;

/** `MM:SS` or `MM:SS.s` → seconds, else the number itself, else null. The prompt asks for numbers; the model sometimes answers in its native timestamp form. */
export function secondsOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Text → tags, or null when the answer is not a clip's tags at all. Beats are clamped to
 * [0, duration] when the duration is known, ordered by start, and a beat that ends before it starts
 * is dropped. A clip whose beats all fail still returns its whole-clip tags with `beats: []` —
 * whole-clip-only is a valid read, and Half B says so on the Board when it is all there is.
 */
export function parseVideoTags(
  text: string,
  durationSeconds: number | null,
  meta: { model: string; taggedAt?: Date },
): VideoAssetTags | null {
  let raw: any;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  // The ternary, when the model answered it, decides `athlete_present`; else the boolean must be there.
  raw = applySubject(raw);
  if (
    typeof raw.athlete_present !== "boolean" ||
    (raw.subject === undefined &&
      typeof (JSON.parse(text.trim()) as { athlete_present?: unknown })
        .athlete_present !== "boolean")
  )
    return null;

  const hi =
    durationSeconds && durationSeconds > 0
      ? durationSeconds
      : Number.POSITIVE_INFINITY;
  const rawBeats: VideoBeat[] = (Array.isArray(raw.beats) ? raw.beats : [])
    .map((b: any): VideoBeat | null => {
      if (!b || typeof b !== "object") return null;
      const s = secondsOf(b.start_s);
      const e = secondsOf(b.end_s);
      if (s === null || e === null) return null;
      const start = Math.min(hi, Math.max(0, s));
      const end = Math.min(hi, Math.max(0, e));
      if (end <= start) return null;
      return {
        start_s: start,
        end_s: end,
        description: str(b.description),
        shot_type: str(b.shot_type),
        athlete_present: bool(b.athlete_present),
        athlete_prominence: num(b.athlete_prominence),
        setting: str(b.setting),
        attire: str(b.attire),
        vibe: str(b.vibe),
        brands_visible: strs(b.brands_visible),
        aesthetic_quality: num(b.aesthetic_quality),
        camera: str(b.camera),
        motion: str(b.motion),
        hero_suitability: num(b.hero_suitability),
        ...((BEAT_STABILITIES as readonly unknown[]).includes(b.stability)
          ? { stability: b.stability as BeatStability }
          : {}),
      };
    })
    .filter((b: VideoBeat | null): b is VideoBeat => b !== null)
    .sort((a: VideoBeat, b: VideoBeat) => a.start_s - b.start_s);
  const beats = mergeMicroBeats(rawBeats, durationSeconds);

  const disposition = ["as_is", "crop", "enhance", "reject"].includes(
    raw.disposition,
  )
    ? raw.disposition
    : "as_is";
  const tags: VideoAssetTags = {
    athlete_present: raw.athlete_present,
    ...(raw.subject ? { subject: raw.subject } : {}),
    athlete_prominence: num(raw.athlete_prominence),
    shot_type: str(raw.shot_type) || "other",
    description: str(raw.description),
    brands_visible: strs(raw.brands_visible),
    aesthetic_quality: num(raw.aesthetic_quality),
    brand_safe: raw.brand_safe !== false,
    content_flags:
      raw.content_flags && typeof raw.content_flags === "object"
        ? raw.content_flags
        : undefined,
    setting: str(raw.setting),
    attire: str(raw.attire),
    vibe: str(raw.vibe),
    hero_suitability: num(raw.hero_suitability),
    disposition,
    edit_note: str(raw.edit_note),
    reason: str(raw.reason),
    beats,
    video: {
      source: "clip",
      model: meta.model,
      sampled_fps: SAMPLED_FPS,
      duration_s:
        durationSeconds && durationSeconds > 0 ? durationSeconds : null,
      tagged_at: (meta.taggedAt ?? new Date()).toISOString(),
    },
  };
  // The full read's speech, when the answer carries it (every other read: no key at all).
  const speech = parseSpeech(raw.speech, hi);
  if (speech) tags.speech = speech;
  // The same hard override the photo tagger applies: hateful/sexual/self-harm never ships, whatever
  // the model said for disposition/brand_safe. Whole-clip — one flagged beat flags the clip.
  if (hasHardSafetyFlag(tags)) {
    tags.disposition = "reject";
    tags.brand_safe = false;
  }
  return tags;
}

/** The longest transcript kept, in segments and in characters per segment — a runaway answer is cut, not stored whole. */
export const MAX_SPEECH_SEGMENTS = 200;
export const MAX_SPEECH_CHARS = 500;

/**
 * The full read's `speech` → VideoSpeech, or null when the answer carries none (every read that is not a full one).
 * Segments are clamped to [0, duration], ordered, and empty or inverted ones dropped; a language that is not a short
 * code is "". `has_speech` false with words in the transcript keeps the words and says true — the words are evidence.
 */
export function parseSpeech(
  raw: unknown,
  hi: number = Number.POSITIVE_INFINITY,
): VideoSpeech | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const transcript: SpeechSegment[] = (
    Array.isArray(r.transcript) ? r.transcript : []
  )
    .map((t: any): SpeechSegment | null => {
      if (!t || typeof t !== "object") return null;
      const s = secondsOf(t.start_s);
      const e = secondsOf(t.end_s);
      const text = str(t.text).trim().slice(0, MAX_SPEECH_CHARS);
      if (s === null || e === null || !text) return null;
      const start = Math.min(hi, Math.max(0, s));
      const end = Math.min(hi, Math.max(0, e));
      return end > start ? { start_s: start, end_s: end, text } : null;
    })
    .filter((t: SpeechSegment | null): t is SpeechSegment => t !== null)
    .sort((a: SpeechSegment, b: SpeechSegment) => a.start_s - b.start_s)
    .slice(0, MAX_SPEECH_SEGMENTS);
  const lang = str(r.language).trim();
  return {
    has_speech: bool(r.has_speech) || transcript.length > 0,
    language: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) ? lang : "",
    music_present: bool(r.music_present),
    transcript,
  };
}

/** A clip no longer than this is SHORT — the only kind the merge below touches. */
export const SHORT_CLIP_SEC = 8;
/** A beat no longer than this is a MICRO-beat. The phantom splits were 1.0 s each; P006's real beats are 1.5 s and 2 s. */
export const MICRO_BEAT_SEC = 1.25;

/**
 * ─── PHANTOM SPLITS ON SHORT CLIPS (enrichment eval grid-1, 22 Sep 2026) ───────────────────────
 *
 * Five of 76 generated 4 s clips came back as three or four 1 s beats on a single steady shot —
 * "ball launches / ball flies / ball floats" — and the repeat sample read one static pose once as
 * 1 beat and once as 4. The prompt says a steady single shot is ONE beat; the model split on "a
 * new action" inside one shot. Pro avoided it on the one row it was tried; a post-parse rule takes
 * it for $0 and keeps Flash.
 *
 * THE RULE: on a clip of at most SHORT_CLIP_SEC, a run of two or more ADJACENT beats, each at most
 * MICRO_BEAT_SEC long, with the same `shot_type` and the same `athlete_present`, is one beat — first
 * start, last end, descriptions joined and deduped (nothing the model saw is thrown away), the
 * first beat's camera, motions joined, numerics at their max, brands united. A beat of 1.5 s is
 * not micro (P006 keeps its two); a beat of 5 s on a 51 s clip is never looked at (exhibit A's six
 * are byte-identical through this). A micro-beat with no micro neighbour of the same shape stays.
 *
 * Adjacency is by ORDER, not by exact contiguity: the model's boundaries are already clamped and
 * sorted, and a hairline gap between 1.0 and 1.0 is the same phantom.
 */
export function mergeMicroBeats(
  beats: readonly VideoBeat[],
  durationSeconds: number | null,
): VideoBeat[] {
  if (
    !durationSeconds ||
    durationSeconds <= 0 ||
    durationSeconds > SHORT_CLIP_SEC
  )
    return [...beats];
  const micro = (b: VideoBeat) => b.end_s - b.start_s <= MICRO_BEAT_SEC;
  const alike = (a: VideoBeat, b: VideoBeat) =>
    a.shot_type === b.shot_type && a.athlete_present === b.athlete_present;
  const out: VideoBeat[] = [];
  let run: VideoBeat[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) out.push(run[0]);
    else out.push(fold(run));
    run = [];
  };
  for (const b of beats) {
    if (micro(b) && (run.length === 0 || alike(run[run.length - 1], b))) {
      run.push(b);
      continue;
    }
    flush();
    if (micro(b)) run.push(b);
    else out.push(b);
  }
  flush();
  return out;
}

const uniq = (xs: string[]) => xs.filter((x, i) => x && xs.indexOf(x) === i);
const fold = (run: VideoBeat[]): VideoBeat => ({
  start_s: run[0].start_s,
  end_s: run[run.length - 1].end_s,
  description: uniq(run.map((b) => b.description)).join("; "),
  shot_type: run[0].shot_type,
  athlete_present: run[0].athlete_present,
  athlete_prominence: Math.max(...run.map((b) => b.athlete_prominence)),
  setting: run[0].setting,
  attire: run[0].attire,
  vibe: run[0].vibe,
  brands_visible: uniq(run.flatMap((b) => b.brands_visible)),
  aesthetic_quality: Math.max(...run.map((b) => b.aesthetic_quality)),
  camera: run[0].camera,
  motion: uniq(run.map((b) => b.motion)).join("; "),
  hero_suitability: Math.max(...run.map((b) => b.hero_suitability)),
});

export interface VideoTagReply {
  text: string;
  usage: TokenUsage | null;
  model: string;
}
export type VideoTagTransport = (
  bytes: Buffer,
  mimeType: string,
  /** The prompt to send — `videoPromptFor(profile)`. A transport that ignores it sends the profile-less one. */
  prompt?: string,
) => Promise<VideoTagReply>;

/** The product's transport: one Gemini call, the clip inline, bounded. */
export const geminiVideoTagTransport: VideoTagTransport = async (
  bytes,
  mimeType,
  prompt = VIDEO_PROMPT,
) => {
  const model = videoEnrichModel();
  const thinking = videoEnrichThinking();
  const res = await withTimeout(
    genai().models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: { mimeType, data: bytes.toString("base64") },
              videoMetadata: { fps: SAMPLED_FPS },
            },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
        ...(thinking ? { thinkingConfig: thinking } : {}),
        abortSignal: AbortSignal.timeout(videoEnrichTimeoutMs()),
      },
    }),
    videoEnrichTimeoutMs(),
    "studio video enrichment",
  );
  const um = (res as { usageMetadata?: Record<string, number> }).usageMetadata;
  const usage = um
    ? {
        inputTokens: um.promptTokenCount ?? 0,
        outputTokens:
          (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
      }
    : null;
  return { text: res.text ?? "", usage, model };
};

export interface TagVideoResult {
  tags: VideoAssetTags | null;
  usage: TokenUsage | null;
}

/** Bytes → tags. Null tags on an unparseable answer; a throw from the transport propagates (the run loop counts it). */
export async function tagVideo(
  bytes: Buffer,
  gcsPath: string,
  durationSeconds: number | null,
  transport: VideoTagTransport = geminiVideoTagTransport,
  profile: AthleteProfile | null = null,
  /** The full read (speech + steadiness), decided by the caller (MEDIA_VIDEO_FIXES). Off: the prompt is unchanged. */
  full = false,
): Promise<TagVideoResult> {
  const reply = await transport(
    bytes,
    mimeFor(gcsPath),
    videoPromptFor(profile, { full }),
  );
  return {
    tags: parseVideoTags(reply.text, durationSeconds, { model: reply.model }),
    usage: reply.usage,
  };
}
