/**
 * identityPack — the best-3 chooser, at the request boundary (PR 17, R-3). Pure; no React, no network.
 *
 * ─── WHAT IT DOES, AND THE THREE THINGS IT NEVER DOES ───────────────────────────────────────────
 *
 * A likeness generation carries up to three photographs of her (CHARACTER_CAP, server/studio/config.ts).
 * When she picked fewer than three, this tops the person slots up from her PACK — deterministically,
 * with no model call: by measured face size (largest first), then prominence, then a clear face
 * before a partial one, then id, so the same pack and request give the same three, twice.
 *
 *   1. HER OWN PICKS ALWAYS FILL THE SLOTS FIRST. A pack photo never replaces, reorders or precedes
 *      an explicit reference; it is appended after everything she attached. Three explicit picks →
 *      the pack is unused. ⚠️ MUTATION (identityPack.test "pack overrides an explicit user
 *      reference"): put the pack picks first, or drop one of hers.
 *   2. THE PACK NEVER COMPETES WITH A PRODUCT OR SCENE REFERENCE. Only `person` slots are counted
 *      and only `person` refs are added; a product ref stays exactly where and what it was.
 *      ⚠️ MUTATION ("pack competes with a product reference"): count every role, or add over the cap
 *      so a product is trimmed.
 *   3. IT TOPS UP ONLY A LIKENESS GENERATION (Adi's ruling, 24 Sep 2026): an image generate with a
 *      person slot declared — a "You" ref present, or her words naming herself. A product-only still,
 *      an edit, a clip, or any request with no person intent gets ZERO pack refs.
 *      ⚠️ MUTATION ("pack attaches to a product-only still"): drop `hasPersonIntent`.
 *
 * "Just these" is a per-request policy she can state on the surfaces that collect her picks; with it
 * the pack is unused at any count. An incomplete pack (fewer than the server's minimum) is never used.
 * With the flag off (`previewBody`), the request is returned untouched — byte-identical (P-off).
 */
import type {
  PreviewRequest,
  StudioReference,
  StudioShotSpec,
} from "../hooks/use-studio";

export type PackPolicy = "top-up" | "just-these";

/** A pack entry as the server's profile wire carries it: an id and numbers, never a vector. */
export interface PackEntryWire {
  assetId: string;
  faceSizeFrac: number | null;
  prominence: number;
  faceVisibility: "clear" | "partial";
  /** The tagger's shot_type word at pack time, or null. Enters the chooser (slot 2) — see chooseBest. */
  shotType?: string | null;
}

/** A shot that shows her build, not only her face — a hand mirror of the server's BODY_SHOT_TYPES. */
export const BODY_SHOT_TYPES: readonly string[] = [
  "action",
  "lifestyle",
  "full-body",
];
export const isBodyShot = (shotType: string | null | undefined): boolean =>
  !!shotType && BODY_SHOT_TYPES.includes(shotType);

/** The request's framing slot, when it names one. */
/**
 * The request's framing slot. Widened to the whole slot vocabulary by PR 15 (the composer grew
 * `SHOT_SLOT_VALUES.framing`); `chooseBest` reads only wide and medium, so every other value — old
 * or new — takes the face-first arm exactly as `undefined` does.
 */
export type Framing = StudioShotSpec["framing"] | undefined;

export interface IdentityProfileWire {
  pack: PackEntryWire[];
  incomplete: boolean;
  min: number;
  max: number;
  band: { min: number; max: number; pairs: number; measuredAt: string } | null;
  controlPassed: boolean | null;
  controlMeasuredAt: string | null;
  embedder: string | null;
  standing: string;
}

/** The person slots one generation can carry — a hand mirror of the server's CHARACTER_CAP. */
export const PERSON_SLOTS = 3;
/** The server's whole-request ceiling — a hand mirror of MAX_ENGINE_REFERENCES / STUDIO_MAX_REFERENCES. */
export const REQUEST_CAP = 6;

/** Her words name herself. Deliberately narrow: first person only, never a name. */
const NAMES_HER = /\b(i|i'm|i’m|me|my|mine|myself)\b/i;

/**
 * Is this a LIKENESS generation — one a pack photo has any business anchoring?
 * A person slot is declared by a "You" reference, or by her sentence naming herself.
 */
export function hasPersonIntent(req: PreviewRequest): boolean {
  if (req.intent !== "image.generate") return false;
  if (req.sourceAssetId) return false;
  const person = (req.references ?? []).some((r) => r.role === "person");
  return person || NAMES_HER.test(req.direction ?? "");
}

/** Deterministic order: face size desc (unmeasured last), prominence desc, clear first, id asc. */
export function rankPack(pack: PackEntryWire[]): PackEntryWire[] {
  return [...pack].sort((a, b) => {
    const fa = a.faceSizeFrac ?? -1;
    const fb = b.faceSizeFrac ?? -1;
    if (fb !== fa) return fb - fa;
    if (b.prominence !== a.prominence) return b.prominence - a.prominence;
    if (a.faceVisibility !== b.faceVisibility)
      return a.faceVisibility === "clear" ? -1 : 1;
    return a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
  });
}

/** The best `need` pack photos not already on the request. */
/**
 * The best `need` pack photos not already on the request — FACE-ANCHORED, BODY-AWARE.
 *
 * Walk-driven amendment to R-3 (Adi, 24 Sep 2026): a generate anchored on three close-ups held her
 * face and lost her build, because the largest face is by construction the tightest crop. So:
 *
 *   slot 1  the largest CLEAR face by rank (a partial face never leads; ⚠️ MUTATION "slot 1 is not the
 *           largest clear face": drop the clear filter);
 *   slot 2  a BODY-bearing shot — action / lifestyle / full-body by shot_type — when the pack has one,
 *           else the next by rank (⚠️ MUTATION "best-3 picks three close-ups from a mixed pack": drop
 *           the body slot);
 *   slot 3  the next by rank.
 *
 * When the request's `shot.framing` is wide or medium, the body shot LEADS (⚠️ MUTATION "body slot
 * ignored when shot.framing is wide": drop the framing branch). Deterministic; no model call.
 */
export function chooseBest(
  pack: PackEntryWire[],
  need: number,
  exclude: ReadonlySet<string>,
  framing: Framing = undefined,
): PackEntryWire[] {
  if (need <= 0) return [];
  const ranked = rankPack(pack).filter((e) => !exclude.has(e.assetId));
  if (ranked.length === 0) return [];
  const face = ranked.find((e) => e.faceVisibility === "clear") ?? ranked[0];
  const body =
    ranked.find((e) => e.assetId !== face.assetId && isBodyShot(e.shotType)) ??
    null;
  const lead =
    body && (framing === "wide" || framing === "medium")
      ? [body, face]
      : body
        ? [face, body]
        : [face];
  const taken = new Set(lead.map((e) => e.assetId));
  const rest = ranked.filter((e) => !taken.has(e.assetId));
  return [...lead, ...rest].slice(0, need);
}

/**
 * The request with its person slots topped up from the pack — or the request, untouched.
 */
export function withPackReferences(
  req: PreviewRequest,
  profile: IdentityProfileWire | null | undefined,
  policy: PackPolicy = "top-up",
): PreviewRequest {
  if (policy === "just-these") return req;
  if (!profile || profile.incomplete || profile.pack.length === 0) return req;
  if (!hasPersonIntent(req)) return req;
  const refs = req.references ?? [];
  const personCount = refs.filter((r) => r.role === "person").length;
  if (personCount >= PERSON_SLOTS) return req;
  const room = Math.max(0, REQUEST_CAP - refs.length);
  const need = Math.min(PERSON_SLOTS - personCount, room);
  const picks = chooseBest(
    pack(profile),
    need,
    new Set(refs.map((r) => r.assetId)),
    req.shot?.framing,
  );
  if (picks.length === 0) return req;
  const added: StudioReference[] = picks.map((p) => ({
    assetId: p.assetId,
    role: "person",
  }));
  return { ...req, references: [...refs, ...added] };
}

const pack = (p: IdentityProfileWire) => p.pack;

/**
 * What usePreviewGeneration sends. `enabled` is the flag: off, the variables minus `packPolicy` are
 * the body, byte-for-byte what was sent before PR 17. ⚠️ MUTATION ("pack attaches with the flag
 * off"): drop the `enabled` guard.
 */
export function previewBody(
  vars: PreviewRequest & { packPolicy?: PackPolicy },
  profile: IdentityProfileWire | null | undefined,
  enabled: boolean,
): PreviewRequest {
  const { packPolicy, ...req } = vars;
  if (!enabled) return req;
  return withPackReferences(req, profile, packPolicy ?? "top-up");
}

/** The ids the chooser added, for a surface that wants to say so. */
export function addedFromPack(
  before: PreviewRequest,
  after: PreviewRequest,
): string[] {
  const had = new Set((before.references ?? []).map((r) => r.assetId));
  return (after.references ?? [])
    .filter((r) => !had.has(r.assetId))
    .map((r) => r.assetId);
}
