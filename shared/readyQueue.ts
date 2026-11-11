/**
 * shared/readyQueue.ts — "Ready for you": the made posts waiting on the athlete's one tap (content engine plan, Part C
 * "Where the queue lives" and "Endpoints and job events"; build step 2). Studio › Ready lists them, Home shows the
 * single most timely one as its one card, and "I posted it" closes one.
 *
 *   GET  /api/v1/me/engine/items?state=ready|posted     ReadyQueueResponse
 *   POST /api/v1/me/engine/items/:id/posted             PostedBody → PostedResponse   ("I posted it")
 *   POST /api/v1/me/engine/items/:id/approve            ApproveBody → ApproveResponse ("Post it": the rights sheet)
 *   GET  /api/v1/me/engine/rights                       { attestations: RightsAttestationView[] }
 *   POST /api/v1/me/engine/rights/:id/revoke            { revoked: boolean }
 *
 * An item is a post kit (shared/postKit.ts) on its plan action's memory_decisions row: the item id IS the decision id.
 * Nothing here posts anything: the athlete copies the caption, saves the media, posts it themselves and taps
 * "I posted it" (tap-to-send).
 *
 * Types and constants only, no runtime dependencies (shared/agent.ts rules). Nothing here names an athlete, sport,
 * school, league or brand.
 */
import type { PostFormat, PostKitDisclosure } from "./postKit";

export const READY_QUEUE_CONTRACT = "ready-queue/1" as const;

/** Which part of the queue a read asks for: still waiting on a tap, or already marked posted. */
export const READY_STATES = ["ready", "posted"] as const;
export type ReadyState = (typeof READY_STATES)[number];

/** What made the item (post kits today; the game-day cards and the engine's recipes join later). */
export const READY_RECIPES = ["post_kit"] as const;
export type ReadyRecipe = (typeof READY_RECIPES)[number];

/**
 * What the athlete can do with a ready item, as the screens draw it (D02/D03). `post_it` opens the rights sheet, then
 * Copy & save; `posted` is "I posted it"; `not_now` and `not_for_me` are the ⋯ steering (POST /me/mila/cards/outcome
 * with card "content"); `open` opens the full item (the post kit screen today).
 */
export const READY_ACTIONS = ["post_it", "copy_caption", "save_media", "posted", "open", "not_now", "not_for_me"] as const;
export type ReadyAction = (typeof READY_ACTIONS)[number];

/** The longest pasted post link "I posted it" stores. */
export const POSTED_LINK_MAX = 500;
/** The longest "Tell Mila why" reason a ⋯ tap stores. */
export const STEER_REASON_MAX = 280;

export interface ReadyItem {
  /** The memory_decisions row (the plan action the kit fulfils). */
  id: string;
  recipe: ReadyRecipe;
  /** The one line the item goes by: the post's hook, else the plan action's words. */
  title: string;
  format: PostFormat | null;
  platform: string | null;
  /** The day it should go up (YYYY-MM-DD), when the plan set one. */
  dueOn: string | null;
  /** The picture the list draws: the preview's cover, else the first asset's thumbnail; null when neither is there. */
  thumbUrl: string | null;
  /** The rendered preview, signed for this read (reel or first picture); null while none is ready. */
  previewUrl: string | null;
  /** The preview's state ("queued" is drawn as Mila still making it); null when no preview was asked for. */
  previewStatus: "queued" | "ready" | "failed" | null;
  caption: {
    /** The full caption the athlete copies (after the final guard). */
    text: string;
    /** Its first line, for the collapsed card and the list. */
    firstLine: string;
    hashtags: string[];
    /** True once the athlete changed it. */
    edited: boolean;
  };
  /** The final guard's mark: the item is only listed as ready once its final text passed. */
  guard: {
    version: number;
    at: string;
    /**
     * "ad": a real deal, gift or affiliate record matched, so `#ad` leads the caption. "ask": a brand is named with no
     * such record: ask once, "Is this paid, gifted or an affiliate post?". null: no brand.
     */
    disclosure: PostKitDisclosure;
  };
  /** The partner brand when the post is brand work (the plan action's target), else null. */
  sponsored: { brand: string } | null;
  /** The moment it was timed for, when there is one. */
  moment: { name: string; date: string | null; whyNow: string | null } | null;
  /** Plain words why this post (from the plan step that suggested it). */
  why: string;
  /** The goal it serves, in the athlete's words. */
  goal: { id: string; text: string } | null;
  /** The athlete's own media the post uses (the kit's assets), in order. */
  sourceAssetIds: string[];
  actions: ReadyAction[];
  /**
   * What "Post it" will still ask (state "ready" only; null for posted): the source assets with no live own-posts word
   * yet (asked once per asset, then remembered), and — on a sponsored post — whether this deal's confirmation is given.
   */
  rights: ReadyRights | null;
  /** When it was marked posted (state "posted" only): by the athlete's tap, or found by the nightly learning link. */
  posted: { at: string; link: string | null; by: "athlete" | "learning" } | null;
  /** The kit's last change (ISO). */
  updatedAt: string;
}

export interface ReadyQueueResponse {
  contract: typeof READY_QUEUE_CONTRACT;
  state: ReadyState;
  /** ready: the most timely first (see server/agent/ready/queue.ts rankReady). posted: the newest post first. */
  items: ReadyItem[];
  /** Home's one card: the first ready item; null when nothing is ready (always null for state "posted"). */
  top: ReadyItem | null;
  /** How many more are ready behind `top` (Home's "2 more"). */
  more: number;
}

/** POST /api/v1/me/engine/items/:id/posted — both optional: a bare tap is enough. */
export interface PostedBody {
  /** The post's link, if they paste it (http/https only). Lets the learning loop find the post without guessing. */
  link?: string | null;
  /** When it went up (ISO), if not just now: never in the future, never before the item was made. */
  postedAt?: string | null;
}

export interface PostedResponse {
  item: ReadyItem;
  /** The receipt the card turns into. */
  receipt: string;
}

// ─── Rights: the athlete's word that they may post their media (owner decision 9 Nov 2026) ───────────────────────

/**
 * The words the rights sheet shows, stored with every word given (media_rights_attestations.words / words_version).
 * Change the words → bump the version. Asked only for what is missing:
 *   own media   once per source asset, remembered, revocable, covering their own posts only
 *   sponsored   once per deal, on a sponsored post (the own-media word never covers a sponsored use on its own)
 */
/** rights/2 (10 Nov 2026): the sponsored line names the kind of post (paid, gifted or affiliate). */
export const RIGHTS_WORDS_VERSION = "rights/2" as const;
export const RIGHTS_OWN_MEDIA_LINE = "These are my own photos and clips, and I can post them.";
/** What kind of brand post it is: from their answer to DISCLOSURE_QUESTION, else from the matching record. */
export const SPONSORED_KINDS = ["paid", "gifted", "affiliate"] as const;
export type SponsoredKind = (typeof SPONSORED_KINDS)[number];
const SPONSORED_POST: Record<SponsoredKind, string> = { paid: "a sponsored post", gifted: "a gifted post", affiliate: "an affiliate post" };
/** The sponsored line, worded for the kind of post (paid when unknown). */
export const rightsSponsoredLine = (brand: string, kind: SponsoredKind | null = null) =>
  `I have the rights to use them in ${SPONSORED_POST[kind ?? "paid"]} for ${brand}.`;
/** Shown under the sponsored line: the post says it is an ad. */
export const RIGHTS_AD_NOTE = "This post starts with #ad, so it's clear it's sponsored.";
/** Asked once when the post names a brand with no deal, gift or affiliate record (kit.guard.disclosure "ask"). */
export const DISCLOSURE_QUESTION = "Is this paid, gifted or an affiliate post?";
export const DISCLOSURE_ANSWERS = ["paid", "gifted", "affiliate", "none"] as const;
export type DisclosureAnswer = (typeof DISCLOSURE_ANSWERS)[number];
export const DISCLOSURE_ANSWER_LABELS: Record<DisclosureAnswer, string> = { paid: "Paid", gifted: "Gifted", affiliate: "Affiliate", none: "None of these" };

export interface ReadyRights {
  /** Source assets still to confirm with the own-media line (empty when every one was confirmed before). */
  missingAssetIds: string[];
  /** On a sponsored post: the partner and whether this deal's confirmation was given before. Null on their own post. */
  sponsored: { brand: string; confirmed: boolean; kind: SponsoredKind | null } | null;
  /**
   * The post's disclosure as it stands: "ad" (#ad leads the caption), "ask" (a brand is named with no record and they
   * have not answered DISCLOSURE_QUESTION yet), null (no brand, or they answered "none").
   */
  disclosure: "ad" | "ask" | null;
  /** True when nothing is left to ask: "Post it" goes straight to Copy & save. */
  complete: boolean;
}

/** POST /api/v1/me/engine/items/:id/approve — the sheet's own taps. Omitted / false: not confirmed (yet). */
export interface ApproveBody {
  /** The own-media line, ticked: covers every asset in `needs.missingAssetIds`. */
  ownMedia?: boolean;
  /** The sponsored line, ticked: this deal's confirmation. */
  sponsoredRights?: boolean;
  /**
   * Their answer to DISCLOSURE_QUESTION, when needs.disclosure is "ask". paid / gifted / affiliate: #ad is put first in
   * the caption (the final guard runs again) and the post is sponsored; none: no #ad and no sponsored line.
   */
  disclosure?: DisclosureAnswer;
}

export type ApproveResponse =
  /** Something is still to confirm: the sheet asks exactly this, nothing else. Nothing was written. */
  | { approved: false; needs: ReadyRights; words: RightsWords }
  /** Approved: what Copy & save needs. Still nothing is posted: they post it themselves, then tap "I posted it". */
  | { approved: true; item: ReadyItem; caption: string; media: Array<{ assetId: string; kind: "image" | "video"; url: string | null }> };

/** The lines a sheet shows, built by the server so the stored words are the words shown. */
export interface RightsWords {
  version: typeof RIGHTS_WORDS_VERSION;
  ownMedia: string | null;
  sponsored: string | null;
  /** Shown only when the post carries #ad (disclosure "ad"). */
  adNote: string | null;
  /** DISCLOSURE_QUESTION and its four answers, only while needs.disclosure is "ask". */
  disclosureQuestion: string | null;
  disclosureOptions: Array<{ value: DisclosureAnswer; label: string }> | null;
}

/** GET /api/v1/me/engine/rights — every live word, newest first (Me › what you've confirmed; revocable). */
export interface RightsAttestationView {
  id: string;
  scope: "own_posts" | "sponsored";
  /** Null on a sponsored word, and once the photo or clip was deleted (the word is kept as the record). */
  assetId: string | null;
  /** Which asset it was ("<platform>:<id>"), kept after deletion; null on sponsored. */
  assetRef: string | null;
  assetKind: string | null;
  brand: string | null;
  words: string;
  attestedAt: string;
}

/**
 * On the action's row (memory_decisions.detail.posted): when it was posted and how Nomila knows. Written in the same
 * conditional write that answers the action (response "accepted") — by the athlete's tap, or by the learning loop when
 * it links a newly synced post to the action (detail.published), so they never have to say it twice.
 */
export interface PostedDetail {
  at: string;
  link: string | null;
  by: "athlete" | "learning";
}
