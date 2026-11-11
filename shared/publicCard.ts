/**
 * shared/publicCard.ts — THE contract for the public Nomi Card, shared by the server, the app and the web page
 * (design-public-card-v3 §9–§11; layout: "v2 Mila at the centre" in design-public-profile-reimagined).
 *
 * Types and constants only: no runtime dependencies, so the client and the web bundle import it as is. The server's
 * rules over these shapes (validateSnapshot, the button and tile fallbacks) live in server/services/publicCard/.
 *
 * A published snapshot is two halves:
 *   content  EXACTLY what is public: chapters (her swipeable cards), the four tiles of the 2×2 grid, which doors are
 *            on, her offers, and her M.I.A. number + band only when she switched it on. No internal ids.
 *   sources  the manifest: for every item key in `content`, the source rows it rests on. Never served publicly.
 *
 * Nothing here names an athlete, sport, school, league or brand.
 */

export const PUBLIC_CARD_CONTENT_SCHEMA = "public-card/1" as const;
export const PUBLIC_CARD_SOURCES_SCHEMA = "public-card-sources/1" as const;

/** The chapter vocabulary (§9). A kind says what data it reads; it carries no sport, school or league words. */
export const CHAPTER_KINDS = ["highlights", "story", "competition", "venture", "partnerships", "impact", "media", "picks"] as const;
export type ChapterKind = (typeof CHAPTER_KINDS)[number];

/** Where a line came from, in the Athlete Record's words. */
export type BasisLabel = "said" | "found" | "made" | "proof";

/** The doors (§3). Ask Mila is the centre avatar, never a tile. */
export const DOORS = ["partner", "book", "shop", "create", "ask_mila"] as const;
export type Door = (typeof DOORS)[number];

/** The 2×2 grid's positions, in reading order (top-left, top-right, bottom-left, bottom-right). */
export const TILE_SLOTS = ["tl", "tr", "bl", "br"] as const;
export type TileSlot = (typeof TILE_SLOTS)[number];

export type ItemKind =
  | "identity_line" | "quote" | "affiliation" | "stat"            // highlights
  | "beat"                                                         // story
  | "proof_point"                                                  // competition
  | "venture"                                                      // venture
  | "partner"                                                      // partnerships
  | "cause" | "value"                                              // impact
  | "media"                                                        // media
  | "pick"                                                         // picks
  | "offer";                                                       // book (carried for the Book door)

/** One public item. `key` is stable across drafts (her decisions and removals use it). */
export interface PublicItem {
  key: string;
  kind: ItemKind;
  /** The words shown, verbatim as approved. */
  text: string | null;
  basis: BasisLabel;
  /** Optional fields a kind uses. Every value is public. */
  label?: string | null;
  value?: number | null;
  asOf?: string | null;
  since?: string | null;
  logoUrl?: string | null;
  mediaKey?: string | null;
  mediaType?: "image" | "video" | null;
  href?: string | null;
  merchant?: string | null;
  priceCents?: number | null;
  totalCents?: number | null;
  currency?: string | null;
  durationMinutes?: number | null;
  disclosure?: string | null;
  /** An offer's format: virtual or in person. */
  locationMode?: "virtual" | "in_person" | null;
  /** A pick's line in her own words, or null. */
  blurb?: string | null;
  /** A pick that is an Amazon link (the page then carries Amazon's statement). */
  amazon?: boolean;
}

/** The one white button on a chapter (§3 table). `null` only when every door it could point at is off. */
export interface ChapterButton {
  door: "partner" | "book" | "shop" | "ask_mila";
  label: string;
}

export interface PublicChapter {
  key: ChapterKind;
  title: string;
  button: ChapterButton | null;
  items: PublicItem[];
}

/**
 * One of the four grid tiles, resolved ONCE at publish by resolveTileSlots (server/services/publicCard/tiles.ts) and
 * stored as is; the page draws them in order and never works a fallback out live. Structurally identical to the
 * renderer's PublicTile (server/services/publicCard/view.ts); tileContract.test.ts holds the two together.
 */
export interface PublicGridTile {
  slot: TileSlot;
  intent: "partner" | "book" | "shop" | "create" | "story" | "follow" | "ask";
  label: string;
  subLabel: string;
  hint?: string | null;
  /** story / follow fallbacks: the chapter it opens (the chapter's key). */
  targetChapterId?: string;
  soon?: boolean;
}

/** A linked social profile she published (the Follow fallback tile and the footer). */
export interface PublicSocialLink {
  network: string;
  url: string;
  handle: string;
}

export interface PublicCardContent {
  schema: typeof PUBLIC_CARD_CONTENT_SCHEMA;
  displayName: string;
  firstName: string;
  /** The rest of her name after the first name ("" when she has one name). */
  lastName: string;
  /** Claimed account + at least one connected, measured social account (§16 Q7). */
  verified: boolean;
  chapters: PublicChapter[];
  tiles: [PublicGridTile, PublicGridTile, PublicGridTile, PublicGridTile];
  /** Her connected social profiles (public handles only). */
  socials: PublicSocialLink[];
  /** Which doors are live in this version. Ask Mila is the centre avatar. */
  doors: Record<Door, boolean>;
  /** Her published offers with the all-in total quoted at publish (the Book door). Empty when Book is off. */
  offers: PublicItem[];
  /** Her live picks, copied at publish (the Shop door). Empty when Shop is off. */
  picks: PublicItem[];
  /** Only when she switched show_mia on: the published number and its band, nothing else (§16 Q3). */
  mia: { score: number; band: string | null; asOf: string | null } | null;
}

/** A source row behind an item. `kind` names the table or record the id belongs to. */
export interface SourceRef {
  kind: string;
  id: string;
}

export interface PublicCardSources {
  schema: typeof PUBLIC_CARD_SOURCES_SCHEMA;
  /** item key → the refs it rests on. Every item in `content` has an entry with at least one ref. */
  items: Record<string, SourceRef[]>;
}

export type SnapshotKind = "full" | "numbers_only" | "removal";

/** What a public read of a handle returns (publicCardReader.read, minus the server-only athlete id). */
export type PublicCardPage =
  | { status: "ok"; handle: string; version: number; etag: string; publishedAt: string; indexable: boolean; content: PublicCardContent }
  | { status: "redirect"; to: string }
  | { status: "not_found" };

// ─── Her side: the /api/v1/me/public-card routes (PR 2) ──────────────────────────────────────────────────────

/** Her decision on one item. `textHash` pins the exact version of a line Nomila wrote ("made") that she approved. */
export interface ItemDecision {
  state: "approved" | "hidden";
  textHash?: string;
}

/** Her review decisions, stored on public_cards.draft. PUT /me/public-card/draft replaces them whole. */
export interface DraftDecisions {
  items?: Record<string, ItemDecision>;
  chapters?: Partial<Record<ChapterKind, { hidden?: boolean; title?: string }>>;
  /** Her chapter order (Highlights always stays first). */
  order?: ChapterKind[];
}

/** Why an item would not be on the page if she published now. */
export type ItemBlock = "needs_approval" | "needs_confirmation" | "hidden" | "over_limit";

export interface DraftItem extends PublicItem {
  /** Her decision, or "proposed" when she has not decided. */
  state: "approved" | "hidden" | "proposed";
  /** Whether Publish would include it now. */
  publishable: boolean;
  blockedBy: ItemBlock | null;
  /** Where it came from (shown on her review screen; never public). */
  sources: SourceRef[];
  /** For a line Nomila wrote: the hash she approves to pin this exact version. */
  textHash: string | null;
}

export interface DraftChapter {
  key: ChapterKind;
  title: string;
  defaultTitle: string;
  hidden: boolean;
  button: ChapterButton | null;
  /** The fewest publishable items the chapter needs to appear (§9). */
  minimum: number;
  meetsMinimum: boolean;
  items: DraftItem[];
}

/** Something the draft builder cut before proposing it, and why (cite-or-cut and her guardrails). No text. */
export interface CutItem {
  key: string;
  kind: ItemKind;
  /** contact_details: the line was nothing but an email, phone, address, link or handle (never on the page). */
  reason: "no_basis" | "guardrail" | "voice_avoid" | "denied" | "unresolved" | "contact_details";
}

export interface PublicCardSwitches {
  partner: boolean;
  book: boolean;
  shop: boolean;
  create: boolean;
  askMila: boolean;
  showMia: boolean;
  indexable: boolean;
}

export interface PublicCardState {
  handle: string | null;
  status: "draft" | "published" | "unpublished";
  publishedVersion: number | null;
  publishedAt: string | null;
  /** When she may next change her handle (null = now). */
  handleChangeAvailableAt: string | null;
  switches: PublicCardSwitches;
}

/** GET /me/public-card/draft and PUT /me/public-card/draft. */
export interface PublicCardDraftResponse {
  card: PublicCardState;
  /** Whether Book and Shop can work at all right now (her switch aside). */
  availability: { book: boolean; shop: boolean };
  chapters: DraftChapter[];
  /** Her published offers (the Book door), each with its all-in total. */
  offers: DraftItem[];
  /** Her live picks (the Shop door). */
  picks: DraftItem[];
  cut: CutItem[];
  /** True when Publish would produce a valid page now. */
  canPublish: boolean;
  /** Why Publish would be refused now (e.g. "Add a chapter or turn on a door to publish"); null when it would work. */
  blockedReason: string | null;
}

/** GET /me/public-card/preview: exactly what Publish would freeze now, rendered as a visitor would get it. */
export interface PublicCardPreviewResponse {
  handle: string | null;
  content: PublicCardContent;
}

/** PUT /me/public-card/draft body. */
export type PublicCardDraftRequest = DraftDecisions;

/** POST /me/public-card/publish → 200. */
export interface PublicCardPublishResponse {
  version: number;
  handle: string;
  page: Extract<PublicCardPage, { status: "ok" }>;
}

/** POST /me/public-card/unpublish → 200. */
export interface PublicCardUnpublishResponse { unpublished: boolean }

/** PATCH /me/public-card/switches body: any subset. */
export type PublicCardSwitchesRequest = Partial<PublicCardSwitches>;
/** PATCH /me/public-card/switches → 200. `removalVersion` is set when switching something off pulled it at once. */
export interface PublicCardSwitchesResponse { switches: PublicCardSwitches; removalVersion: number | null }

/** PUT /me/public-card/handle body and responses. */
export interface PublicCardHandleRequest { handle: string }
export interface PublicCardHandleResponse { handle: string; handleChangeAvailableAt: string | null }

/** Every error body from the /me/public-card routes. */
export interface PublicCardErrorResponse {
  error: string;
  code: "disabled" | "invalid" | "needs_handle" | "not_published" | "reserved" | "taken" | "too_soon" | "bad_request";
  nextChangeAt?: string;
}
