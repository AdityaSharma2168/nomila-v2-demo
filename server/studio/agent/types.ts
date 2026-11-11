/**
 * studio/agent/types — the vocabulary a plan is written in.
 *
 * Imports nothing but the plan cap, for the reason studio/types.ts imports nothing at all: the
 * planner, the parser, the route and (later) the executor all read this, and a type module that
 * drags a dependency in makes every one of them import it too.
 */
// ⚠️ FROM studio/types.ts, WHICH IMPORTS NOTHING — never from studio/spendCaps.ts, which reaches
// server/db through previewStore and would drag the database into the planner's graph. See the
// note beside the constant's declaration.
import { MAX_PLAN_ITEMS } from "../types";
import type { Provenance } from "./provenance";
import type { Capabilities, CapabilityAxis } from "./capabilities";
import type { StillMotion } from "../video/stillMotion";
import type { CampaignBrief } from "../campaign/brief";

/**
 * What one item of a plan IS. A closed set, and each one means a different thing to execution:
 *
 *   i2v      one of her photographs, moved. An identity shot — she is in it — so it routes to Veo.
 *   broll    a scene with nobody in it, made from WORDS — text-to-video, no photo (decided 21 Sep
 *            2026, docs/studio-broll-t2v-decision.md: i2v b-roll starts on its reference by
 *            construction, quality judged equal, t2v preferred). Routes to seedance, far cheaper.
 *            The caster casts nothing for it and the Board makes it from its direction alone.
 *   image    one of her photographs, HELD as it is for a few seconds — a still. $0: nothing is
 *            generated, so no preview, no admission, no spend; the Board holds it as a `still` row
 *            and the stitch encodes it into a clip at its position (C1 / C1b, 21 Sep 2026). It names
 *            ONE photo by its ref, with or without her in it, and rule 1 applies fully: a still IS
 *            the photo, so its line may say only what the photo shows.
 *            HISTORY, kept on purpose: this was RESERVED and refused in v1 (21 Sep 2026, in review)
 *            because a $0 item had no preview, no Board row kind and no path into a stitch — a
 *            stitch could not join a still (docs/studio-agent-open-cards.md card 2). PR C1 gave the
 *            stitch `stillSec` and C1b gave the Board a still row, which is what un-refused it.
 *   clip     one of her own VIDEOS, used as it is or cut to one of its beats — $0, like an image:
 *            nothing is generated, no preview, no admission, no spend; the Board holds it as a
 *            `clip` row and the stitch places it at its position, trimmed to the beat's window
 *            (C2 Half B, 22 Sep 2026). It names ONE clip by its ref and, optionally, one of that
 *            clip's beats by index (`segment`) — the beats Half A's tagger wrote into
 *            metadata.vision. Rule 1 applies as to an image: a clip IS its footage, so its line may
 *            say only what the clip's line (or its beat's) says is in it. Sound on a clip is its OWN
 *            sound, kept or muted, and free either way.
 *   product  the thing being shown, in frame. The product asset is the one SHE PICKED — the planner
 *            never casts it, because choosing which of her products is in an ad by embedding
 *            similarity is the wrong kind of guess — and it is only ever proposed when she picked one.
 *            It stays image-to-video on purpose: her ACTUAL product has to appear, not one a model
 *            imagined from a sentence.
 */
export const PLAN_ITEM_KINDS = [
  "i2v",
  "broll",
  "image",
  "product",
  "clip",
] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];

/**
 * What the planner may OFFER and its parser may ACCEPT. The whole union since C1b; the name is kept
 * because the parser's refusal of anything outside it — an invented kind, refused whole — is the
 * property the tests hold, whatever the list says.
 */
export const V1_PLAN_ITEM_KINDS: readonly PlanItemKind[] = [
  "i2v",
  "broll",
  "image",
  "product",
  "clip",
];

/**
 * Kinds made from a library photo the planner names — the kinds with a `ref`. An `i2v` item animates
 * its photo; an `image` item holds it. `product` is hers to choose and `broll` is made from words;
 * see above.
 */
export const CASTABLE_KINDS: readonly PlanItemKind[] = ["i2v", "image", "clip"];

/** What a library ref names: a photograph, or a clip. A kind fits one of them, never both. */
export type LibraryMediaType = "photo" | "clip";

/**
 * One beat of a clip, as the planner is allowed to know it — from Half A's `vision.beats`. The
 * freeform camera / motion words the tagger wrote are folded onto the closed vocabulary
 * deterministically (studio/agent/capabilities.ts `nearestCapability`); null when nothing matched.
 */
export interface LibraryBeat {
  /** Its position in the clip's beat list — what a `segment` names. */
  index: number;
  startSec: number;
  endSec: number;
  /** The beat's description, scrubbed and capped. Model-written text, like every field here. */
  description: string;
  camera: Capabilities["camera"] | null;
  movement: Capabilities["movement"] | null;
  motion: Capabilities["motion"] | null;
}

/**
 * The most products she may pick for one plan (decided 21 Sep 2026, device check finding 4). They
 * are matched to the plan's `product` items in the order she picked them; a product item past the
 * last of them is dropped and shown, never given a product twice.
 */
export const MAX_PLAN_PRODUCTS = 5;

/** Her sentence, and everything she set, as the planner is asked to see it. */
export interface PlanAsk {
  /**
   * What she typed. HER OWN WORDS, about her own work, entering her own generation — trusted on
   * exactly the reasoning studio/brief.ts gives for `BriefInput.direction`.
   *
   * ⚠️ THE SAME SEAM APPLIES. The moment this is prefilled from an inbox message, a brand email or
   * any other outside source, it stops being trusted text and must be fenced as data like an
   * inbound ask. Do not reuse this field for text we did not watch her type.
   */
  prompt: string;
  /** What the plan is FOR. The existing closed vocabulary — see studio/brief.ts `BriefObjective`. */
  objective: string;
  /** How she wants it to feel. Free text, hers, optional. Rides into the prompt and nowhere else. */
  aesthetic?: string;
  /**
   * The sport this plan is for — the one her sentence names, else her profile's (`athletes.sport`),
   * else null (library.ts `briefSport`). Read against each line's derived `sport`. Optional so
   * every existing caller of the planner is unchanged.
   */
  sport?: string | null;
  /** What her library offers, already read and described by the caller. Data, never instruction. */
  library: LibraryEntry[];
  /**
   * The products she picked, in the order she picked them — empty when she picked none, and then
   * the planner is never offered `product`. Described so each product item's direction can be about
   * its own product: they are matched to `product` items in this order (studio/agent/cast.ts).
   */
  products: ProductEntry[];
  /**
   * The brand brief this plan is for (PR 6, 6b) — a CampaignBrief, zod-validated at the route, behind
   * STUDIO_BRAND_PROFILES. It carries no athlete id and only opaque handles; its product handle
   * "product_N" names her Nth product (p{N}). Rendered inside a FENCED block as data, never as
   * instructions (plan.ts `campaignBlock`). Absent: the prompt is byte-identical to a plan without one.
   */
  campaign?: CampaignBrief;
  /**
   * The concept she picked (PR 6, 6c) — step 1's idea, which this plan's coverage serves. Model-written
   * text coming back through a client body, so it is DATA: fenced in its own block (plan.ts
   * `conceptBlock`). Absent: the prompt is byte-identical to a plan without one.
   */
  concept?: PlanConcept;
  /**
   * The plan is for a deal deliverable (PR 10, R-2). With the campaign, one of the two inputs that decide
   * whether the music is brand work (studio/music/suggest.ts `brandWorkFor`); the purpose chip decides
   * only when both are absent. Absent reads as not linked.
   */
  dealLinked?: boolean;
}

/** One concept from step 1 (studio/agent/concepts.ts): what the video is about, how it feels, one line. */
export interface PlanConcept {
  id: "A" | "B" | "C";
  angle: string;
  feeling: string;
  line: string;
}

/**
 * One product she picked, as the planner is allowed to know it. The same hazard as `LibraryEntry`:
 * the description is model-written text going back into a prompt, fenced and scrubbed.
 */
export interface ProductEntry {
  /** An opaque handle — "p1", "p2" — in the order she picked them. */
  ref: string;
  /** vision.description, scrubbed and capped — empty when the photo is not tagged yet. */
  description: string;
}

/**
 * One photograph, as the planner is allowed to know it.
 *
 * ⚠️ EVERY FIELD HERE IS MODEL-WRITTEN TEXT (metadata.vision, from lib/visionTag.ts) BEING PUT BACK
 * INTO A PROMPT. That is the hazard studio/autoMask.ts names: a model's restatement re-entering a
 * model. It is fenced and labelled as data for that reason, and it is scrubbed of the delimiter
 * characters that could close the fence early.
 *
 * No path, no url, no id the model could name back at us as a thing to fetch. The caller holds the
 * mapping from `ref` to an asset id; the model only ever sees `ref`.
 */
export interface LibraryEntry {
  /** An opaque handle — "a1", "a2". Never a uuid and never a storage path. */
  ref: string;
  /** vision.description, scrubbed and capped. */
  description: string;
  /** vision.shot_type — portrait | action | lifestyle | group | text_graphic | other. */
  shotType: string;
  /** vision.athlete_present. The single fact that decides whether a photo can be a shot of her. */
  athletePresent: boolean;
  /** vision.setting / vision.vibe, scrubbed and capped. */
  setting: string;
  vibe: string;
  /** She picked this photo for this video — the planner is asked to use it where it fits. */
  picked: boolean;
  /** vision.brands_visible, the tagger's own strings — so a plan for one brand can avoid another's. */
  brands: string[];
  /**
   * Where the row came from — her camera, made here, or synced from her accounts
   * (studio/agent/provenance.ts). A LABEL, read by the planner and ranked on by nothing yet: the
   * doctrine PR's "real footage first" is what this is groundwork for. Null when the origin is one
   * the fold does not know.
   */
  provenance: Provenance | null;
  /**
   * `media_assets.platform` — a synced row off "instagram" reads "from: her instagram" (PR 4 B2b,
   * provenance.ts `provenanceLabelOf`). Absent or any other value: the provenance's own words.
   */
  platform?: string | null;
  /** A photograph or a clip. An `i2v`/`image` ref must name a photo; a `clip` ref must name a clip. */
  mediaType: LibraryMediaType;
  /** A clip's measured length, or null when unmeasured. Always null on a photo. */
  durationSeconds: number | null;
  /** A clip's beats, in order — empty on a photo, and empty on a clip whose read found none. */
  beats: LibraryBeat[];
  /**
   * The sport the tagger's words name — `namesSport` over description, setting and attire
   * (studio/sportVocab.ts), the rule the enrichment eval measured at 444 of 458 rows. The tags carry
   * no sport field; this is DERIVED, $0, and null when the words name none. What lets a plan for
   * one sport keep to it: the planner reads it on the line, and library.ts offers her-room rows of
   * another sport after those of the brief's (a demotion, never an exclusion).
   */
  sport: string | null;
  /**
   * For a "from: her camera" row: true when the clip's container carries device atoms (signal 1,
   * studio/enrich/provenanceSignal.ts), false when it does not or was never probed. Null on every
   * other provenance and on a photo (a video signal). Rendered "(verified)" / "(unverified)";
   * ordering demotes an unverified camera row behind a verified one, never past made-here.
   */
  verified: boolean | null;
  /**
   * The rest of what the tagger knows (PR 12) — present only with STUDIO_LIBRARY_FIELDS on, so a
   * plan with the flag off renders the line it always did. The same hazard as every field above:
   * model-written text, fenced and scrubbed on its way back into a prompt (plan.ts `libraryLine`).
   */
  tags?: LibraryTags;
}

/**
 * The ten fields `library.ts` used to drop (AUDIT2 F28), plus PR 12's two, as the planner may read
 * them. Numbers are the tagger's 0..1; null where the row (tagged before the key existed) has none.
 */
export interface LibraryTags {
  /** vision.subject — the_athlete | another_person | nobody; null on a pre-ternary row. */
  subject: string | null;
  /** vision.athlete_prominence */
  prominence: number | null;
  /** vision.aesthetic_quality */
  quality: number | null;
  /** vision.hero_suitability */
  hero: number | null;
  /** vision.brand_safe */
  brandSafe: boolean | null;
  /** The keys of vision.content_flags that are true, in the tagger's order. */
  flags: string[];
  /** vision.attire, scrubbed and capped. */
  attire: string;
  /** vision.disposition — as_is | crop | enhance | reject. */
  disposition: string;
  /** vision.edit_note, scrubbed and capped. */
  editNote: string;
  /** vision.reason, scrubbed and capped. */
  reason: string;
  /** lib/visionTag.ts `faceOf` — with the R-3 fallback applied, so never null on a tagged row. */
  face: string;
  /** lib/visionTag.ts `roleOf` — with the R-3 fallback applied. */
  role: string;
}

/** One item of the plan the model proposed. */
export interface PlanItem {
  kind: PlanItemKind;
  /** Why this is in the plan, in a line she reads on the approval screen. */
  beat: string;
  /** The sentence this item is generated from. Compiled downstream; never shown as the whole truth. */
  direction: string;
  /**
   * WHICH PHOTO the direction is written about — a library `ref` ("a3") from the list the planner
   * was shown. `i2v` and `image` only: null for `product`, which takes her products in order, and
   * for `broll`, which is made from words.
   *
   * ⚠️ WHY A REF NOW, AFTER "A QUERY, NEVER A PICK" (reversed in review, device check finding 6).
   * With only a query, the direction and the photo were chosen separately: the planner wrote a
   * basketball direction about one library photo, and the caster cast a soccer photo onto it by
   * query. i2v animates the photo it is given, so she approved a plan the clip could never match.
   * The planner must say which photo it means.
   *
   * The tenancy rule still holds, because a ref is not an id: it is an opaque handle into a list the
   * server built from HER photographs through the caster's own predicate, and it never leaves the
   * server as anything else. A ref the planner was not shown refuses the whole plan (parsePlan),
   * exactly as an invented kind does — a model that hallucinates "a7" names nothing.
   */
  ref: string | null;
  /**
   * The FALLBACK: a short description of the photograph, used only when the photo `ref` names cannot
   * be cast here (it does not fit the kind, or another item took it). The item is then cast from her
   * library by this query and says, on screen, that its photo was swapped. `i2v` and `image` only,
   * like `ref`.
   */
  searchQuery: string | null;
  /**
   * The planner recommends SOUND for this item (device check finding 1). Only a literal `true` from
   * the model counts. It seeds the Board row's sound on, where she can turn it off; it is a PRICE on
   * a shot of her — Veo's audio SKU is double its silent one — and free on seedance b-roll. Always
   * false on an `image`: nothing is filmed, so there is nothing to sound.
   */
  sound: boolean;
  /**
   * For a `clip`: the index of the beat it is cut to, from the clip's beat list — or null for the
   * whole clip. Null on every other kind. A segment the clip does not have refuses the plan, as a
   * ref the planner was not shown does.
   */
  segment: number | null;
  /**
   * For a `clip` cut to a beat: the seconds INSIDE that beat the item plays — a long beat trimmed
   * to the moment that carries it (doctrine: trimmed, never skipped). SOURCE seconds, clamped into
   * the beat by the parser; null plays the whole beat. Null on a whole-clip item and on every
   * other kind. Found 22 Sep 2026: the planner cast only beats of ≤ 3 s and passed over her real
   * 6–12 s dribbling and juggling beats for a generated stranger — it had nowhere to put a trim.
   */
  window: { startSec: number; endSec: number } | null;
  /**
   * For an `image`: "dolly" ("pan" before PR 6, still read as dolly) gives the held photo a slow push-in over its hold (studio/video/still.ts
   * — $0, nothing generated, not a shot of her moving), null holds it dead still. Null on every
   * other kind: an i2v IS motion, and a clip has its own. C3, D2 (22 Sep 2026): the planner
   * offered i2v where a $0 push-in would carry the beat.
   */
  motion: StillMotion | null;
  /**
   * Where a zoom, sweep or punch heads — fractions 0..1 of the upright photo — or null for the
   * renderer's framing prior. Only beside a focused motion on an `image` (PR 6, 6a2). Absent on
   * plans parsed before it.
   */
  focus?: { x: number; y: number } | null;
  /**
   * Why this item: the capability-library entry it was chosen from (studio/agent/capabilityEntries),
   * why it fits this moment, and the entry it beat. Null when the model named no entry, or one that
   * is not in the library or not this item's kind — nulled at the parse and logged, never trusted
   * (PR 6, 6a2). Absent on plans parsed before it.
   */
  reason?: ItemReason | null;
  /**
   * What the item asks of the camera, the light, the frame and the movement — from the closed
   * vocabulary in studio/agent/capabilities.ts (Mia's §8), never free text. Absent when the model
   * set none. A value outside its list was nulled at the parse and logged by name.
   */
  capabilities?: Capabilities;
}

/** A choice's reason, against the capability library (PR 6, 6a2). */
export interface ItemReason {
  /** An id in CAPABILITY_ENTRIES, of this item's kind. */
  entry: string;
  /** Why it fits this moment, in a line she can read. */
  fits: string;
  /** The entry it was chosen over, or null. */
  over: string | null;
}

/** The plan's one grade over every held photo (studio/video/still.ts STILL_LOOKS), and why. */
export interface PlanLook {
  value: string;
  reason: ItemReason | null;
}

/** The plan's one track or bed (studio/video/beds.ts BedName), whether cuts land on its beat, and why. */
export interface PlanMusic {
  name: string;
  onBeat: boolean;
  reason: ItemReason | null;
}

export interface AgentPlan {
  items: PlanItem[];
  /**
   * Every capability value the model wrote outside the vocabulary, by item — reported, not stored,
   * so derivePlan can log each one and the plan eval can count them. Empty when none.
   */
  nulled: { item: number; axis: CapabilityAxis; value: string }[];
  /**
   * What the planner says it could NOT cover from her library — the honest-gap line (doctrine,
   * 22 Sep 2026): "no match footage, so the game is not shown" rather than a stock net-ripple
   * standing in for it. Plain lines she reads; at most MAX_PLAN_GAPS, each capped. Empty when the
   * model declared none. Not an item kind: nothing is made from it and nothing is priced.
   */
  gaps: string[];
  /** The plan-level grade, or null/absent when none was chosen or it was off the list (PR 6, 6a2). */
  look?: PlanLook | null;
  /** The plan-level music, or null/absent (PR 6, 6a2). Brand work never carries a track that is not brandSafe. */
  music?: PlanMusic | null;
  /** Reason entries the model named outside the library, by item — logged, never stored (PR 6, 6a2). */
  reasonsOutside?: { item: number; value: string }[];
}

/** The most gap lines a plan may carry. A plan that is mostly gaps is a plan to refuse by hand. */
export const MAX_PLAN_GAPS = 4;

/** The most items a plan may hold — one constant, shared with the money gate. */
export { MAX_PLAN_ITEMS };
