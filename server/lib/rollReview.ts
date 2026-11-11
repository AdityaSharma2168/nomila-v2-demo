/**
 * rollReview — the keep/drop brain behind "Review my camera roll".
 *
 * The phone sends up SMALL review thumbnails (never the originals). Each one goes through the
 * SAME vision pass the media library already uses (`tagAsset`) plus the same multimodal
 * embedding (`embedImageGcs`), and this module turns those two signals into three buckets:
 *
 *   keep  — pre-ticked in the consent grid, capped and diversified
 *   more  — over the bar but past the cap ("More good ones", unticked)
 *   drop  — under the bar, each with a plain-English reason
 *
 * NOTHING here writes anything. Import is a separate, explicit step (POST /me/media/review/import),
 * and only the photos the athlete ticks ever leave her phone at full size.
 *
 * WHY THE RANK IS SPELLED OUT HERE and not taken from `heroScore` in lib/visionTag.ts: heroScore
 * zeroes an asset that is not `brand_safe`, and in this flow brand_safe is RECORDED, never used to
 * drop (rule 5). A photo with a beer can in the background is still her photo; it gets a note, not
 * a deletion. The weights are otherwise identical to heroScore's.
 *
 * Every threshold is env-overridable (ROLL_REVIEW_*) so the bar can be tuned without a deploy of
 * new logic — see `rollReviewConfig()`.
 */
import { hasHardSafetyFlag, type AssetTags } from "./visionTag";
import type { ModerationVerdict } from "./moderation";
import type { ReviewItemKind, ReviewQuality, ReviewSummary } from "../../shared/cameraRollIntake";

export interface RollReviewConfig {
  /** Max items accepted in one review (or import) call. */
  maxItems: number;
  /** Rule 1 — the athlete must be present AND at least this prominent in the frame. */
  minProminence: number;
  /** Rule 3 — minimum aesthetic_quality. */
  minAesthetic: number;
  /** Rule 4 — minimum likeness-to-her cosine, applied only when the proxy is available. */
  minLikeness: number;
  /** Fewer than this many `athlete_present` library assets ⇒ no centroid, rule 4 is skipped. */
  likenessMinRefs: number;
  /** Rule 6 — pairwise embedding cosine above this means "same burst"; only the best survives. */
  dupCosine: number;
  /** Max pre-ticked keepers returned per call. */
  keepCap: number;
  /** No single shot_type may take more than this share of the cap. */
  shotTypeShare: number;
  /** Per-thumbnail size ceiling for the review upload URL. */
  thumbMaxBytes: number;
  /**
   * CAMERA_ROLL_INTAKE: how much a targeted review's fit (0..1) moves the rank — rank = (1 − w)·rank + w·fit. 0 (the
   * default, and every review without a target) leaves the rank exactly as it was.
   */
  fitWeight: number;
}

const numEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** Read the live config. Read per call (not frozen at import) so the env can be flipped in tests. */
export function rollReviewConfig(): RollReviewConfig {
  return {
    maxItems:        numEnv("ROLL_REVIEW_MAX_ITEMS", 100),
    minProminence:   numEnv("ROLL_REVIEW_MIN_PROMINENCE", 0.25),
    minAesthetic:    numEnv("ROLL_REVIEW_MIN_AESTHETIC", 0.5),
    minLikeness:     numEnv("ROLL_REVIEW_MIN_LIKENESS", 0.6),
    likenessMinRefs: numEnv("ROLL_REVIEW_LIKENESS_MIN_REFS", 5),
    dupCosine:       numEnv("ROLL_REVIEW_DUP_COSINE", 0.92),
    keepCap:         numEnv("ROLL_REVIEW_KEEP_CAP", 60),
    shotTypeShare:   numEnv("ROLL_REVIEW_SHOT_TYPE_SHARE", 0.4),
    thumbMaxBytes:   numEnv("ROLL_REVIEW_THUMB_MAX_BYTES", 400 * 1024),
    fitWeight:       0,
  };
}

/** Cosine similarity in [-1,1]. Deliberately local: mediaSearch.ts is under concurrent change. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Mean vector of a set of embeddings — the "this is what she looks like" centroid. */
export function centroid(vectors: number[][]): number[] | null {
  const usable = vectors.filter((v) => Array.isArray(v) && v.length > 0);
  if (!usable.length) return null;
  const dim = usable[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of usable) for (let i = 0; i < dim; i++) out[i] += v[i] ?? 0;
  for (let i = 0; i < dim; i++) out[i] /= usable.length;
  return out;
}

const clamp01 = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

/**
 * The rank. Same weights as heroScore, WITHOUT its brand_safe / text_graphic zeroing — a
 * text graphic is already dropped by the disposition rule, and brand_safe never drops anything here.
 */
export function rankOf(t: AssetTags): number {
  return 0.45 * clamp01(t.hero_suitability) + 0.30 * clamp01(t.aesthetic_quality) + 0.25 * clamp01(t.athlete_prominence);
}

export interface ReviewCandidate {
  itemId: string;
  /**
   * SafeSearch verdict for the thumbnail (lib/moderation.ts). Checked BEFORE every other rule.
   * Review fails CLOSED: a verdict carrying `error` drops the item, because a silent Vision
   * outage must never pre-tick content nobody screened. `null` means "gate not run" and is only
   * used by unit tests of the other rules.
   */
  moderation?: ModerationVerdict | null;
  /** null when the vision pass failed for this thumbnail. */
  tags: AssetTags | null;
  /** null when the embedding failed — such an item simply can't be burst-collapsed or likeness-checked. */
  embedding: number[] | null;
  /** Cosine to the athlete's likeness centroid, or null when the centroid isn't available. */
  likeness: number | null;
  /**
   * CAMERA_ROLL_INTAKE only. Set ⇒ the entry carries `kind`, `summary` and `fit` (absent ⇒ the entry is exactly what it
   * was before the intake, field for field).
   */
  kind?: ReviewItemKind;
  /** CAMERA_ROLL_INTAKE: how close the preview is to what a targeted review looks for, 0..1 within the batch; null = no target. */
  fit?: number | null;
}

export interface ReviewTagSummary {
  shot_type: string;
  /** Recorded, NEVER used to drop (rule 5) — the grid shows it as a note. */
  brand_safe: boolean;
  brands_visible: string[];
  disposition: string;
}

export interface KeepEntry {
  itemId: string;
  rank: number;
  reason: string;
  tags: ReviewTagSummary;
  /** CAMERA_ROLL_INTAKE only (see ReviewCandidate.kind). */
  kind?: ReviewItemKind;
  summary?: ReviewSummary;
  fit?: number | null;
}
/**
 * `code` is the machine-readable half of a drop; `reason` is the line the grid shows her. They are
 * separate because the two content codes must be greppable in logs and in the client, while the
 * copy next to a photo of her has to read like a person wrote it.
 */
export type DropCode =
  | "content"                 // SafeSearch: adult / violence / racy at LIKELY+
  | "moderation_unavailable"  // the gate could not run — review fails closed
  | "unscored" | "not_present" | "too_small" | "disposition" | "quality" | "likeness" | "duplicate";
export interface DropEntry { itemId: string; reason: string; code: DropCode }
export interface ReviewOutcome { keep: KeepEntry[]; more: KeepEntry[]; drop: DropEntry[] }

const KEEPABLE_DISPOSITIONS = new Set(["as_is", "crop", "enhance"]);

/**
 * The vision pass's own content flags — `hasHardSafetyFlag` from visionTag.ts, which is the single
 * definition of which of the six `content_flags` are severe (hateful / sexual / self_harm) and
 * reads them all optionally, so an older stored tag without the field is simply unflagged.
 *
 * Re-exported under this name because from HERE the question is "does this photo leave the grid",
 * and because it is deliberately NOT the whole list: alcohol or a weapon in frame is a NOTE for the
 * athlete to weigh, not a decision this code makes for her.
 */
export const flaggedContent = (t: AssetTags): boolean => hasHardSafetyFlag(t);

function summarize(t: AssetTags): ReviewTagSummary {
  return {
    shot_type: typeof t.shot_type === "string" && t.shot_type ? t.shot_type : "other",
    brand_safe: t.brand_safe !== false,
    brands_visible: Array.isArray(t.brands_visible) ? t.brands_visible.filter((b) => typeof b === "string") : [],
    disposition: typeof t.disposition === "string" && t.disposition ? t.disposition : "as_is",
  };
}

/** The tagger's aesthetic_quality in words. */
export function qualityWord(aesthetic: unknown): ReviewQuality {
  const q = clamp01(aesthetic);
  return q >= 0.8 ? "great" : q >= 0.6 ? "good" : q >= 0.4 ? "fair" : "poor";
}

/** The short description a scored preview carries (CAMERA_ROLL_INTAKE): shot type, setting, what she is doing, quality. */
export function reviewSummary(t: AssetTags): ReviewSummary {
  const line = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  return {
    shotType: summarize(t).shot_type,
    setting: line(t.setting, 80),
    doing: line(t.description, 140),
    quality: qualityWord(t.aesthetic_quality),
  };
}

/** A targeted review's fit at or above this leads the keeper's line with "Close to what you're looking for". */
export const CLOSE_FIT = 0.7;

/** The one line the grid shows under a keeper. Prefers the model's own sentence. */
function keepReason(t: AssetTags): string {
  const own = (t.reason ?? "").trim();
  if (own) return own.length > 120 ? `${own.slice(0, 117)}…` : own;
  const bits = [summarize(t).shot_type];
  if (clamp01(t.aesthetic_quality) >= 0.75) bits.push("sharp and well-lit");
  if (clamp01(t.athlete_prominence) >= 0.6) bits.push("you're the subject");
  return bits.join(" · ");
}

/**
 * Apply the keep rules, collapse bursts, then cap with shot-type diversity.
 *
 * Rules, in the order a photo meets them (the first failure is the reason she is shown):
 *   0. SafeSearch: adult/violence/racy at LIKELY+ is a hard drop, and so is a check that
 *      could not run (fails closed — see ReviewCandidate.moderation)
 *   0b. the vision pass's own content_flags (hateful / sexual / self_harm) — same bucket
 *   1. athlete_present && athlete_prominence ≥ minProminence
 *   2. disposition ∈ {as_is, crop, enhance}
 *   3. aesthetic_quality ≥ minAesthetic
 *   4. likeness ≥ minLikeness — ONLY when the centroid exists (≥ likenessMinRefs reference assets)
 *   5. brand_safe is recorded and never drops anything
 *   6. among near-duplicates (cosine > dupCosine) only the highest-ranked survives
 */
export function reviewCandidates(
  candidates: ReviewCandidate[],
  cfg: RollReviewConfig = rollReviewConfig(),
): ReviewOutcome {
  const drop: DropEntry[] = [];
  const passed: { entry: KeepEntry; embedding: number[] | null }[] = [];

  for (const c of candidates) {
    // 0 — the content gate, ahead of every quality rule. Fails CLOSED here (see ReviewCandidate).
    const mod = c.moderation;
    if (mod) {
      if (mod.blocked) {
        drop.push({ itemId: c.itemId, code: "content", reason: "Flagged as inappropriate content — not added." });
        continue;
      }
      if (mod.error) {
        drop.push({
          itemId: c.itemId, code: "moderation_unavailable",
          reason: "We couldn't run the content check on this one, so we left it out.",
        });
        continue;
      }
    }

    const t = c.tags;
    if (!t) { drop.push({ itemId: c.itemId, code: "unscored", reason: "We couldn't read this one, so it wasn't scored." }); continue; }

    // 0b — the vision pass's OWN content flags, which land in the same bucket as a SafeSearch block.
    // Two independent models have to agree that a photo is fine, and either one saying it is not is
    // enough. Reads the flags optionally, so a tag stored before the field existed is unflagged
    // rather than undefined-throwing.
    if (flaggedContent(t)) {
      drop.push({ itemId: c.itemId, code: "content", reason: "Flagged as inappropriate content — not added." });
      continue;
    }

    // 1 — is she actually in it, and big enough to matter?
    if (!t.athlete_present) { drop.push({ itemId: c.itemId, code: "not_present", reason: "You're not in this one." }); continue; }
    if (clamp01(t.athlete_prominence) < cfg.minProminence) {
      drop.push({ itemId: c.itemId, code: "too_small", reason: "You're too small in the frame to carry a card." }); continue;
    }
    // 2 — the vision pass's own keep/edit verdict
    if (!KEEPABLE_DISPOSITIONS.has(summarize(t).disposition)) {
      drop.push({ itemId: c.itemId, code: "disposition", reason: (t.reason ?? "").trim() || "Not usable for a brand surface." }); continue;
    }
    // 3 — polish
    if (clamp01(t.aesthetic_quality) < cfg.minAesthetic) {
      drop.push({ itemId: c.itemId, code: "quality", reason: "Soft or noisy — below the quality bar for a kit." }); continue;
    }
    // 4 — likeness, only when we have a centroid to compare against
    if (c.likeness != null && c.likeness < cfg.minLikeness) {
      drop.push({ itemId: c.itemId, code: "likeness", reason: "The person in this doesn't look like you." }); continue;
    }
    // 5 — brand_safe is recorded in `tags`, never a reason to drop.

    // CAMERA_ROLL_INTAKE: a targeted review leans the rank toward what it looks for, and says so in the line.
    const fit = c.fit ?? null;
    const base = rankOf(t);
    const rank = fit !== null && cfg.fitWeight > 0 ? (1 - cfg.fitWeight) * base + cfg.fitWeight * clamp01(fit) : base;
    const own = keepReason(t);
    const entry: KeepEntry = { itemId: c.itemId, rank, reason: own, tags: summarize(t) };
    if (c.kind !== undefined) {
      entry.kind = c.kind;
      entry.summary = reviewSummary(t);
      entry.fit = fit;
      if (fit !== null && fit >= CLOSE_FIT) {
        const lead = "Close to what you're looking for";
        entry.reason = `${lead} · ${own}`.length > 120 ? lead : `${lead} · ${own}`;
      }
    }
    passed.push({ entry, embedding: c.embedding });
  }

  // Highest rank first — every downstream step (burst collapse, cap, diversity) is greedy on this order.
  passed.sort((a, b) => b.entry.rank - a.entry.rank || a.entry.itemId.localeCompare(b.entry.itemId));

  // 6 — burst collapse. Twelve frames of the same jump are one photo as far as she's concerned.
  const survivors: typeof passed = [];
  for (const p of passed) {
    const dupe = p.embedding && survivors.some((s) => s.embedding && cosine(p.embedding!, s.embedding) > cfg.dupCosine);
    if (dupe) { drop.push({ itemId: p.entry.itemId, code: "duplicate", reason: "Near-duplicate — we kept the best frame of this burst." }); continue; }
    survivors.push(p);
  }

  // Cap + diversity: sixty keepers max, and no single shot_type may eat more than its share, so a
  // day of portraits can't crowd out every action shot she has.
  const perType = Math.max(1, Math.floor(cfg.keepCap * cfg.shotTypeShare));
  const used = new Map<string, number>();
  const keep: KeepEntry[] = [];
  const more: KeepEntry[] = [];
  for (const s of survivors) {
    const type = s.entry.tags.shot_type;
    const n = used.get(type) ?? 0;
    if (keep.length < cfg.keepCap && n < perType) { keep.push(s.entry); used.set(type, n + 1); }
    else more.push(s.entry);
  }

  return { keep, more, drop };
}
