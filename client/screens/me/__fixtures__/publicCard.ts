// Test fixtures for her public card screens: typed with the shared contract (shared/publicCard.ts), so a change to the
// server's shapes breaks these at compile time. Placeholder people only ("Sam Lee"); nothing names a real athlete,
// sport, school, league or brand.

import type {
  DraftChapter, DraftItem, PublicCardContent, PublicCardDraftResponse, PublicCardPreviewResponse, PublicCardState,
  PublicGridTile,
} from "../../../../shared/publicCard";

export const SWITCHES_DEFAULT = { partner: true, book: false, shop: false, create: true, askMila: true, showMia: false, indexable: false };

export const state = (over: Partial<PublicCardState> = {}): PublicCardState => ({
  handle: null, status: "draft", publishedVersion: null, publishedAt: null, handleChangeAvailableAt: null,
  switches: { ...SWITCHES_DEFAULT }, ...over,
});

export const item = (key: string, over: Partial<DraftItem> = {}): DraftItem => ({
  key, kind: "proof_point", text: `Line ${key}`, basis: "said", state: "proposed", publishable: true, blockedBy: null,
  sources: [{ kind: "said:assertion", id: `s-${key}` }], textHash: null, ...over,
});

export const chapter = (key: DraftChapter["key"], items: DraftItem[], over: Partial<DraftChapter> = {}): DraftChapter => {
  const title = key.charAt(0).toUpperCase() + key.slice(1);
  return { key, title, defaultTitle: title, hidden: false, button: null, minimum: 1, meetsMinimum: true, items, ...over };
};

/** A new athlete: Highlights with nothing in it, no doors that can work, nothing to publish. */
export const NEW_DRAFT: PublicCardDraftResponse = {
  card: state(),
  availability: { book: false, shop: false },
  chapters: [chapter("highlights", [], { minimum: 0 })],
  offers: [],
  picks: [],
  cut: [],
  canPublish: false,
  blockedReason: "Add a chapter or turn on a door to publish",
};

/** An athlete with content: live at version 2, with every kind of item state the review screen explains. */
export const CONTENT_DRAFT: PublicCardDraftResponse = {
  card: state({ handle: "sam-lee", status: "published", publishedVersion: 2, publishedAt: "2026-10-05T12:00:00.000Z", switches: { ...SWITCHES_DEFAULT, shop: true } }),
  availability: { book: false, shop: true },
  chapters: [
    chapter("highlights", [
      item("hl-id", { kind: "identity_line", text: "Builder of teams", basis: "made", state: "approved", textHash: "h-id" }),
      item("hl-stat", { kind: "stat", text: null, label: "Instagram followers", value: 12400, basis: "found", publishable: false, blockedBy: "needs_approval" }),
      item("hl-aff", { kind: "affiliation", text: "City Club", basis: "found", publishable: false, blockedBy: "needs_confirmation" }),
    ], { minimum: 0 }),
    chapter("story", [
      item("st-origin", { kind: "beat", text: "Started at nine.", label: "origin", basis: "made", publishable: false, blockedBy: "needs_approval", textHash: "h-origin" }),
      item("st-rise", { kind: "beat", text: "Moved up fast.", label: "rise", basis: "made", state: "approved", publishable: false, blockedBy: "needs_approval", textHash: "h-rise-new" }),
    ], { minimum: 2, meetsMinimum: false }),
    chapter("impact", [
      item("im-cause", { kind: "cause", text: "Youth coaching", basis: "said", state: "hidden", publishable: false, blockedBy: "hidden" }),
    ], { title: "What I care about", defaultTitle: "Impact", hidden: true }),
  ],
  offers: [],
  picks: [item("pick-1", { kind: "pick", text: "Trail shoe", merchant: "Example Store", priceCents: 12000, currency: "usd" })],
  cut: [
    { key: "cut-1", kind: "beat", reason: "no_basis" },
    { key: "cut-2", kind: "cause", reason: "guardrail" },
  ],
  canPublish: true,
  blockedReason: null,
};

export const tiles = (): [PublicGridTile, PublicGridTile, PublicGridTile, PublicGridTile] => [
  { slot: "tl", intent: "partner", label: "Partner", subLabel: "Work with Sam" },
  { slot: "tr", intent: "story", label: "Sam's story", subLabel: "See Sam's story", targetChapterId: "story" },
  { slot: "bl", intent: "shop", label: "Shop", subLabel: "Sam's picks" },
  { slot: "br", intent: "create", label: "Create", subLabel: "Coming soon", soon: true },
];

export const content = (over: Partial<PublicCardContent> = {}): PublicCardContent => ({
  schema: "public-card/1",
  displayName: "Sam Lee",
  firstName: "Sam",
  lastName: "Lee",
  verified: true,
  chapters: [
    { key: "highlights", title: "Highlights", button: null, items: [
      { key: "hl-id", kind: "identity_line", text: "Builder of teams", basis: "made" },
      { key: "hl-q", kind: "quote", text: "Show up early.", basis: "said" },
      { key: "hl-stat", kind: "stat", text: null, label: "Instagram followers", value: 12400, asOf: "2026-10-08", basis: "found" },
    ] },
    { key: "story", title: "Story", button: null, items: [
      { key: "st-o", kind: "beat", text: "Started at nine.", label: "origin", basis: "made" },
      { key: "st-r", kind: "beat", text: "Moved up fast.", label: "rise", basis: "made" },
    ] },
  ],
  tiles: tiles(),
  socials: [{ network: "instagram", url: "https://instagram.com/samlee", handle: "@samlee" }],
  doors: { partner: true, book: false, shop: true, create: true, ask_mila: true },
  offers: [],
  picks: [],
  mia: null,
  ...over,
});

export const PREVIEW: PublicCardPreviewResponse = { handle: "sam-lee", content: content() };
export const NEW_PREVIEW: PublicCardPreviewResponse = {
  handle: null,
  content: content({ verified: false, chapters: [{ key: "highlights", title: "Highlights", button: null, items: [] }], socials: [] }),
};

/** What apiRequest throws for a refused request. */
export const httpError = (status: number, body: unknown) => new Error(`${status}: ${JSON.stringify(body)}`);
