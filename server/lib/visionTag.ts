/**
 * visionTag — the Curator's vision layer (see docs/media-kit-specs.md Spec 4).
 * Tags one owned media asset for media-kit fitness using Gemini 2.5 Flash vision on Vertex
 * (GCP credits; same client family as researchAthlete/kimi). Image bytes are inlined (base64)
 * to avoid Vertex gs:// permission plumbing. Best-effort: returns null on failure.
 */
import { Storage } from "@google-cloud/storage";
import { genai, GEMINI } from "./models";

const BUCKET  = process.env.MEDIA_BUCKET ?? "nomila-v2-athlete-media";
const ai      = genai();
const bucket  = new Storage().bucket(BUCKET);

/** Hard-safety flags a mainstream sponsor would never accept, regardless of anything else the model
 *  said. Recorded individually; `hateful`/`sexual`/`self_harm` additionally FORCE reject/unsafe (see
 *  tagAsset) — `violence_or_weapons`, `drugs_or_alcohol`, `obscene_gesture` are recorded only (v1). */
export interface ContentFlags {
  hateful?: boolean; sexual?: boolean; violence_or_weapons?: boolean;
  drugs_or_alcohol?: boolean; self_harm?: boolean; obscene_gesture?: boolean;
}

/**
 * WHO the tagger is told to look for. Read from the athlete row by the caller (full_name · sport ·
 * school); no new schema. Null when the caller has no athlete — the prompt then falls back to the
 * profile-less wording it had before 22 Sep 2026.
 */
export interface AthleteProfile {
  name: string;
  sport: string | null;
  team: string | null;
}

/** The tagger's answer to "who is in the frame" — stored beside `athlete_present`, which is derived from it. */
export type TagSubject = "the_athlete" | "another_person" | "nobody";
export const TAG_SUBJECTS: readonly TagSubject[] = ["the_athlete", "another_person", "nobody"];

/**
 * How much of a face the frame shows (PR 12, ARCH §6 `quality.face_visibility`). What decides whether
 * a photo can stand in for HER at a generation: `none` cannot be a likeness reference.
 *   clear    frontal or three-quarter, sharp, unobstructed
 *   partial  side profile, sunglasses, a helmet, motion blur, or a face under ~5% of the frame
 *   none     no face, or one turned away, occluded, or too small to identify
 * Absent on rows tagged before it existed — every reader falls back (`faceOf`), none refuses.
 */
export type FaceVisibility = "none" | "partial" | "clear";
export const FACE_VISIBILITIES: readonly FaceVisibility[] = ["none", "partial", "clear"];

/**
 * What the photo is best used for (PR 12, ARCH §6 `role`). A HINT the picker and the planner read;
 * never a gate on its own. There is deliberately no `style`: "a look" was a reference tag once and
 * was removed because the model did not honour it (client/components/studio/ReferencePicker.tsx);
 * style is a brief role, not an asset's. `scene` is what the planner already calls a row without her.
 */
export type TagRole = "identity" | "product" | "scene" | "other";
export const TAG_ROLES: readonly TagRole[] = ["identity", "product", "scene", "other"];

export interface AssetTags {
  /**
   * DERIVED from `subject` since 22 Sep 2026: `the_athlete` → true, everything else → false. Kept
   * as the field every reader already reads. Older rows carry the model's direct answer, which the
   * enrichment eval convicted (a named male professional answered true at 0.9 on both models).
   */
  athlete_present: boolean;
  /** The ternary the prompt now asks for. Absent on rows tagged before it existed. */
  subject?: TagSubject;

  athlete_prominence: number;   // 0..1 — how centrally featured
  shot_type: string;            // portrait | action | lifestyle | group | text_graphic | other
  description: string;          // what's happening in the shot (label)
  brands_visible: string[];     // logos/brands/products seen in the image — never what makes it unsafe
  aesthetic_quality: number;    // 0..1 — sharpness, lighting, composition, polish
  brand_safe: boolean;          // true unless it trips a hard-safety flag below — NOT about rival logos
  content_flags?: ContentFlags; // optional: absent/missing fields on older stored tags default to false
  setting: string; attire: string; vibe: string;
  hero_suitability: number;     // 0..1 — would this work as a LARGE hero image in a premium kit?
  disposition: "as_is" | "crop" | "enhance" | "reject";  // the VLM's keep/edit decision
  edit_note: string;            // what edit/enhancement, if any
  reason: string;
  /** PR 12. Absent on rows tagged before 23 Sep 2026 — see `faceOf` / `roleOf` for the fallback. */
  face_visibility?: FaceVisibility;
  role?: TagRole;
  /**
   * 21 Oct 2026. THE ATHLETE's face as a box, fractions of the image (top-left x,y, width, height) — where a crop must
   * keep her. Null when her face is not in the frame. Absent on rows tagged before it existed (see applyFrameKeys).
   */
  face_box?: FaceBox | null;
  /**
   * 21 Oct 2026. Text burned INTO the image (a caption, an overlay, a graphic, a watermark) — never text that is part of
   * the scene (a jersey, a sign, a scoreboard). `share` = rough fraction of the frame it covers. Absent on older rows,
   * where the description-reading fallback (mediaSearch hasBurnedInText) still applies.
   */
  text_in_image?: { present: boolean; share: number };
}
export interface FaceBox { x: number; y: number; w: number; h: number }

/**
 * ─── THE ATHLETE, NAMED (22 Sep 2026, Mia-approved, "as simple as possible") ───────────────────
 *
 * The enrichment eval (docs/probes/enrich-eval.md) convicted `athlete_present` blind, on both
 * models: the prompt asked "is the athlete clearly the subject" without ever saying who she is, so
 * a named male professional WAS "the athlete" — Flash named him in its own description and still
 * answered present at 0.9. The model knew who it was looking at; the question did not. These two
 * lines tell it, and the answer shape asks the ternary the reader actually needs. Nothing else in
 * the prompt changes. Her name is given so a known face is not "the athlete"; the model is told not
 * to write it back, so it never lands in a description.
 */
export function profileBlock(profile: AthleteProfile | null): string {
  if (!profile) return "";
  // ⚠️ NO SPORT IN THE LINE. Measured 22 Sep 2026 on the 13-cell re-tag: with "a female Basketball
  // athlete" (her profile's sport) her own photo in a soccer uniform, face turned, came back as
  // ANOTHER PERSON — the model read the kit as the test. The name and the "anyone else" clause
  // carried every hit without it. A profile's sport is a fact about her career, not about a frame.
  // ⚠️ NO GENDER EITHER (8 Oct 2026, no-hardcoding rule). The line said "a female athlete" for
  // every athlete; the athlete row carries no gender, so the tagger is told only "an athlete" and
  // refers to them as "the athlete". The name and the "anyone else" clause do the identifying.
  const who = [
    profile.name,
    "an athlete",
    profile.team ? `at ${profile.team}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `THE ATHLETE is ${who}. Anyone else in the frame — a teammate, an opponent, a famous player, a model, anyone — is ANOTHER PERSON, however prominent. Never write their name in any field; say "the athlete".
`;
}

/**
 * The two PR 12 questions, defined in the prompt's own words. Measured 23 Sep 2026 (P-stable,
 * docs/probes/library-fields.md): on 5 tagged photos, old prompt vs this one, categorical fields
 * identical on 4/5 (a reject/other row moved nobody → another_person once a partial face was asked
 * about), numerics within 0.10 on 4/5 with the same image over on both old×old and old→new.
 */
export const FACE_ROLE_LINE = `face_visibility: "clear" if a person's face is frontal or three-quarter, sharp and unobstructed; "partial" if it is a side profile, or behind sunglasses, a helmet, motion blur, or under about 5% of the frame; "none" if no face is visible, or it is turned away, occluded, or too small to identify. role: what this photo is best used for — "identity" (THE ATHLETE, face clear or partial), "product" (a thing is the subject), "scene" (a place with nobody, or only a distant crowd), "other" (a text graphic, a screenshot, a meme, a group where the athlete is not the subject).`;

/**
 * The two framing questions (21 Oct 2026): where her face is, so a crop never cuts it; and whether text is burned into
 * the picture, so a repost's caption or a meme overlay never stands as a photo of her.
 */
export const FRAME_LINE = `face_box: THE ATHLETE's face as fractions of the image — x and y of its top-left corner, w and h its width and height, each 0.0-1.0 — or null if her face is not visible. text_in_image: text burned INTO the picture itself (a caption, an overlay, a graphic, a watermark, a screenshot's interface) — NOT text that is part of the scene, such as lettering on a jersey, a sign, a banner or a scoreboard; present true|false, and share = the rough fraction of the frame it covers (0.0 when absent).`;

/** The answer key for who is in the frame — the same three words in both taggers. */
export const SUBJECT_SHAPE = `"subject":"the_athlete|another_person|nobody"`;

export const promptFor = (profile: AthleteProfile | null): string => `You are the media curator for a professional athlete's brand media kit that goes to potential partners. ${profileBlock(profile)}Assess THIS image for that use: is THE ATHLETE clearly the subject, how polished/high-quality is it, would it carry a full-bleed hero card. A screenshot, meme, text graphic, low-res or busy group shot is a poor hero. Also note any brands/logos/products visible in brands_visible.

brand_safe: true unless the image contains content a mainstream sponsor would reject — hate symbols or slurs, obscene gestures, weapons, illegal drugs, sexual or nude content, self-harm. Visible logos or competitor brands do NOT make an image unsafe; list them in brands_visible instead.

content_flags: for each of hateful, sexual, violence_or_weapons, drugs_or_alcohol, self_harm, obscene_gesture — true/false. Flag hateful symbols, slurs, or hateful text anywhere in the frame, including on clothing, signs, or screens.

${FACE_ROLE_LINE}

${FRAME_LINE}

Decide its disposition: "as_is" (kit-ready), "crop" (good but reframe/subject off-center), "enhance" (worth upscaling/relighting), or "reject" (unusable — including anything caught by content_flags above). Respond with STRICT JSON only, no prose:
{${SUBJECT_SHAPE},"athlete_prominence":0.0-1.0,"shot_type":"portrait|action|lifestyle|group|text_graphic|other","description":"what's happening, short","brands_visible":["brand or logo",...],"aesthetic_quality":0.0-1.0,"brand_safe":true|false,"content_flags":{"hateful":true|false,"sexual":true|false,"violence_or_weapons":true|false,"drugs_or_alcohol":true|false,"self_harm":true|false,"obscene_gesture":true|false},"setting":"few words","attire":"few words","vibe":"few words","hero_suitability":0.0-1.0,"disposition":"as_is|crop|enhance|reject","edit_note":"what edit if any, short","reason":"one short sentence","face_visibility":"none|partial|clear","role":"identity|product|scene|other","face_box":{"x":0.0-1.0,"y":0.0-1.0,"w":0.0-1.0,"h":0.0-1.0}|null,"text_in_image":{"present":true|false,"share":0.0-1.0}}`;

/** The profile-less prompt — what every caller sent before the profile existed. */
const PROMPT = promptFor(null);

/**
 * `subject` → `athlete_present`: the_athlete is true, another_person and nobody are false. An
 * answer without a valid `subject` (an older prompt, a model that ignored the key) keeps whatever
 * `athlete_present` it carries — coerced to a boolean, as every reader assumes it is.
 *
 * ⚠️ MUTATION (visionTag.test, videoTag.test): collapse the ternary to always-the_athlete — the
 * another_person → false cases red by name.
 */
export function applySubject<T extends { athlete_present?: unknown; subject?: unknown }>(tags: T): T & { athlete_present: boolean; subject?: TagSubject } {
  const subject = (TAG_SUBJECTS as readonly unknown[]).includes(tags.subject) ? (tags.subject as TagSubject) : undefined;
  const athlete_present = subject ? subject === "the_athlete" : tags.athlete_present === true;
  const out = { ...tags, athlete_present } as T & { athlete_present: boolean; subject?: TagSubject };
  if (subject) out.subject = subject;
  else delete (out as { subject?: unknown }).subject;
  return out;
}

/**
 * May this photo stand in for HER (a cover, a story scene, a post about her)? Only when the tagger,
 * told who she is, answered `subject: "the_athlete"`. A row tagged before `subject` existed carries
 * the blind `athlete_present` the enrichment eval convicted (a named professional answered true), so
 * it does NOT count: it is "unsure" until the subject re-tag (studio/enrich/retag.ts) reads it again.
 * Untagged rows are unsure too. Never-her and unsure are both skipped; the slot falls back to fewer
 * photos rather than someone else's face (20 Oct 2026: a brand book reel cast another player).
 *
 * ⚠️ MUTATION (visionTag.test "a legacy athlete_present row is not her"): fall back to
 * `athlete_present` when `subject` is absent — reds by name.
 */
export function isTheAthlete(vision: { subject?: unknown } | null | undefined): boolean {
  return vision?.subject === "the_athlete";
}

/**
 * May this post stand as PROOF of her (a brand book's strongest posts, a pitch's proof card)? Her own post, tagged as
 * her (isTheAthlete), and the picture we would show is ABOUT her and clean: not a text graphic, meme or screenshot, not
 * a group shot (for a clip, its first beat — the frame a thumbnail shows), and no burned-in text the tagger saw
 * (another account's caption on a repost, a trend overlay). Reads only the stored tags: no model call. Unsure → no.
 * ONE predicate for every proof surface (20 Oct 2026: a team repost with someone else's caption led her proof).
 *
 * ⚠️ MUTATION (visionTag.test "a group or text-overlay post is not proof of her"): drop the first-beat check — reds.
 */
const NOT_PROOF_SHOTS = new Set(["text_graphic", "group", "screenshot", "meme"]);
const BURNED_TEXT = /\b(text overlay|overlaid text|on-screen text|text on screen|meme|caption(?:ed)? (?:over|on)|watermark)\b/i;
export function isProofOfHer(vision: Record<string, unknown> | null | undefined): boolean {
  const v = (vision ?? {}) as Record<string, any>;
  if (!isTheAthlete(v)) return false;
  if (NOT_PROOF_SHOTS.has(String(v.shot_type ?? ""))) return false;
  if (v.role === "other") return false;
  const first = Array.isArray(v.beats) ? v.beats[0] : null;
  if (first && NOT_PROOF_SHOTS.has(String(first.shot_type ?? ""))) return false;
  // The tagger's own text_in_image answer when the row carries one; the description reading for older rows.
  const burned = burnedTextOf(v);
  if (burned !== null) return !burned;
  const words = [v.description, v.edit_note, first?.description].filter((x) => typeof x === "string").join(" ");
  return !BURNED_TEXT.test(words);
}

/**
 * `face_visibility` / `role` as the model answered them — kept only when they are one of the words
 * the prompt offered; anything else is DROPPED, so a stored row never carries a value no reader
 * knows (the R-3 fallback then applies, exactly as for a row tagged before the keys existed).
 *
 * ⚠️ MUTATION (visionTag.test "an unknown face_visibility value is stored as given"): return `tags`
 * unchanged — reds by name.
 */
export function applyFaceRole<T extends { face_visibility?: unknown; role?: unknown }>(tags: T): T {
  const out = { ...tags };
  if (!(FACE_VISIBILITIES as readonly unknown[]).includes(out.face_visibility)) delete out.face_visibility;
  if (!(TAG_ROLES as readonly unknown[]).includes(out.role)) delete out.role;
  return out;
}

/**
 * `face_box` / `text_in_image` as the model answered them, made safe to store: a box is kept only when all four numbers
 * are finite, inside 0..1 and the box stays inside the frame (clamped by at most a rounding slip); an explicit null box
 * stays null ("her face is not visible"); anything else is DROPPED, so a reader falls back exactly as for an older row.
 * `share` is clamped to 0..1 and forced to 0 when `present` is false.
 *
 * ⚠️ MUTATION (visionTag.test "a face box outside the frame is dropped"): keep the box unchecked — reds by name.
 */
export function applyFrameKeys<T extends { face_box?: unknown; text_in_image?: unknown }>(tags: T): T {
  const out = { ...tags } as Record<string, unknown>;
  const b = out.face_box as Record<string, unknown> | null | undefined;
  if (b === null) out.face_box = null;
  else {
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
    const [x, y, w, h] = [n(b?.x), n(b?.y), n(b?.w), n(b?.h)];
    const ok = [x, y, w, h].every((v) => v >= 0 && v <= 1) && w > 0 && h > 0 && x + w <= 1.02 && y + h <= 1.02;
    if (ok) out.face_box = { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
    else delete out.face_box;
  }
  const t = out.text_in_image as Record<string, unknown> | undefined;
  if (t && typeof t.present === "boolean") {
    const s = typeof t.share === "number" && Number.isFinite(t.share) ? Math.max(0, Math.min(1, t.share)) : 0;
    out.text_in_image = { present: t.present, share: t.present ? s : 0 };
  } else delete out.text_in_image;
  return out as T;
}

/**
 * Burned-in text, from the tagger's own answer when the row carries one (present and covering at least 1% of the frame —
 * a corner watermark speck is not a caption); null when the row predates the key, so callers fall back to reading the
 * description (mediaSearch hasBurnedInText).
 */
export function burnedTextOf(vision: Record<string, unknown> | null | undefined): boolean | null {
  const t = (vision as { text_in_image?: { present?: unknown; share?: unknown } } | null | undefined)?.text_in_image;
  if (!t || typeof t.present !== "boolean") return null;
  return t.present && (typeof t.share === "number" ? t.share >= 0.01 : true);
}

/**
 * THE R-3 READER. `face_visibility` when the row carries one; else what the row DOES say — a row the
 * tagger called hers has a person in it and nothing about the face, so `partial`; anyone else or
 * nobody is `none`. Null only for a row with no vision at all — "unread", a different answer from
 * "no face". Nothing refuses an old row for lacking a key that did not exist when it was tagged.
 *
 * ⚠️ MUTATION (visionTag.test, referenceGate.test "an old row without face_visibility is refused"):
 * return null when the key is absent — the fallback cases red by name.
 */
export function faceOf(vision: Record<string, unknown> | null | undefined): FaceVisibility | null {
  if (!vision) return null;
  const f = vision.face_visibility;
  if ((FACE_VISIBILITIES as readonly unknown[]).includes(f)) return f as FaceVisibility;
  const s = vision.subject;
  if (s === "the_athlete" || (s === undefined && vision.athlete_present === true)) return "partial";
  return "none";
}

/** `role` when the row carries one; else from `subject`; null for an unread row. Same fallback discipline as `faceOf`. */
export function roleOf(vision: Record<string, unknown> | null | undefined): TagRole | null {
  if (!vision) return null;
  const r = vision.role;
  if ((TAG_ROLES as readonly unknown[]).includes(r)) return r as TagRole;
  const s = vision.subject;
  if (s === "the_athlete" || (s === undefined && vision.athlete_present === true)) return "identity";
  if (s === "nobody") return "scene";
  return "other";
}

/**
 * The inline part's MIME type, from the object's extension. Exported for the video tagger
 * (studio/enrich/videoTag.ts), which sends the clip the same way this sends a photo.
 *
 * `.mp4` / `.mov` map to their video types. Before C2 they fell to `image/jpeg` — latent, because
 * enrichment reads `thumb ?? path` and a video row is only a candidate once its poster exists, so
 * no mp4 ever reached this function in production; but a caller that passes a clip must not have it
 * labelled a JPEG. Anything unrecognised still falls to `image/jpeg`, as before.
 */
export function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "webp") return "image/webp";
  if (ext === "png") return "image/png";
  if (ext === "mp4") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  return "image/jpeg";
}

/** The three flags severe enough to override whatever the model said for disposition/brand_safe —
 *  and the one case where heroScore still zeroes outright (see heroScore below). */
export function hasHardSafetyFlag(t: Pick<AssetTags, "content_flags">): boolean {
  const f = t.content_flags;
  return !!(f?.hateful || f?.sexual || f?.self_harm);
}

export async function tagAsset(gcsPath: string, profile: AthleteProfile | null = null): Promise<AssetTags | null> {
  try {
    const [buf] = await bucket.file(gcsPath).download();
    const res = await ai.models.generateContent({
      model: GEMINI.flash,
      contents: [{ role: "user", parts: [
        { inlineData: { mimeType: mimeFor(gcsPath), data: buf.toString("base64") } },
        { text: profile ? promptFor(profile) : PROMPT },
      ] }],
      config: { responseMimeType: "application/json", temperature: 0.2 },
    });
    const txt = (res.text ?? "").trim();
    const tags = applyFrameKeys(applyFaceRole(applySubject(JSON.parse(txt) as AssetTags)));
    // Hard override: hateful/sexual/self-harm content is rejected and marked unsafe no matter what
    // the model returned for `disposition`/`brand_safe` — this is not a lens, it never ships.
    if (hasHardSafetyFlag(tags)) { tags.disposition = "reject"; tags.brand_safe = false; }
    return tags;
  } catch {
    return null;
  }
}

/** Combine the vision signals into one rankable "would this be a good kit HERO" score.
 *
 * `brand_safe` on its own is deliberately NOT a factor here — a good shot doesn't stop being a good
 * shot because another brand's logo is in frame (an athlete under contract with one apparel brand
 * can still be photographed in a rival's kit; our editors can strip a logo later). Brand safety (the
 * rival-logo kind) is applied as a LENS at the moment of use (see mediaSearch.searchMedia's
 * `excludeBrands` / `preferBrandSafe`), never as a blanket zero on the library-wide score.
 *
 * The ONE exception: a hard-safety flag (hateful / sexual / self-harm content) still zeroes outright,
 * unconditionally — that content never surfaces at any card, brand or generic. */
export function heroScore(t: AssetTags): number {
  if (!t.athlete_present) return 0;
  if (hasHardSafetyFlag(t)) return 0;
  if (t.shot_type === "text_graphic") return 0.05;
  return 0.45 * t.hero_suitability + 0.30 * t.aesthetic_quality + 0.25 * t.athlete_prominence;
}
