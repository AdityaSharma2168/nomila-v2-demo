// Studio v3 (EXPO_PUBLIC_HOME_V3; design "Studio and Home, designed", 20 Oct 2026): the feed, the shelves and the Create
// menu over the SAME data the library reads (useStudioItems) and the moments Home shows (homeV3Logic momentStories).
// Pure: the screen maps each entry to a tap.
//
//   Feed (the default)  full-screen, one at a time, swipe up: Ready for you → Ideas from moments → Posted (feedEntries)
//   Browse              the four shelves below, Posted as a grid
//
//   Ready for you      post kits not yet posted — soonest due first, then newest
//   Ideas from moments the moments the moments step chose that have nothing prepared yet (a prepared one is in Ready)
//   Posted             post kits she marked posted, newest first
//   Decks & pages      her brand book first, then decks (with the brand's logo) and pages, newest first
//
// A post is titled exactly as Home titles it (homeV3Logic postTitle: the plan's hook, never the chore), so the same item
// reads the same on both. Status is a colour, never a word like "Draft" or "v1": pink = ready for you, green = posted or
// sent, grey = Mila's still working on it.

import type { StudioItem } from "./agent/types";
import { displayBrandName, formatWord, postTitle, relativeDay, type StoryItem } from "./homeV3Logic";

export type StudioDot = "ready" | "posted" | "working";
export type StudioShelfKey = "ready" | "ideas" | "posted" | "decks";

export interface StudioTile {
  id: string;
  /** What it is, in a word or two ("Today · Reel", "Deck", "Posted"). */
  kicker: string;
  title: string;
  dot: StudioDot;
  thumbUrl: string | null;
  /** A deck's brand logo (drawn on the pitch-deck cover look). */
  logoUrl: string | null;
  /** Thumbnail shape: posts and moments are tall creative, decks are covers. */
  shape: "tall" | "cover";
  /** Where a tap goes. */
  open:
    | { to: "feed"; id: string }
    | { to: "kit"; id: string }
    | { to: "item"; item: StudioItem }
    | { to: "moment"; story: StoryItem };
  /** A moment's date as a calendar face (a chip over its picture). */
  dateFace?: { top: string; big: string } | null;
  /** A moment idea's story (its picture is drawn from it: her kit photo, an atmosphere image, else its kind's card). */
  story?: StoryItem | null;
  /** One extra line the item carries ("41 views", "10 pages"). */
  meta?: string | null;
}

export interface StudioShelf { key: StudioShelfKey; title: string; tiles: StudioTile[] }

export const STUDIO_V3_COPY = {
  title: "Studio",
  shelves: { ready: "Ready for you", ideas: "Ideas from moments", posted: "Posted", decks: "Decks & pages" } as Record<StudioShelfKey, string>,
  views: { feed: "Feed", browse: "Browse" },
  action: { review: "Review & post", seeIt: "See it", make: "Make this post", open: "Open", notNow: "Not now", sound: "Sound on", mute: "Mute" },
  idea: "Idea",
  create: "Create",
  createTitle: "What do you want to make?",
  createOptions: {
    post: { label: "Post", line: "A photo, carousel or reel" },
    ad: { label: "Ad", line: "A post for a brand" },
    deck: { label: "Deck", line: "A pitch for a brand" },
    page: { label: "Page", line: "Your public page" },
  },
  posted: "Posted",
  deck: "Deck",
  page: "Page",
  media: "Edit",
  empty: { title: "Nothing here yet", line: "Ask Mila for a post, a deck or a page, and it lands here." },
  emptyShelf: {
    ready: "Posts Mila prepares for you land here.",
    ideas: "Moments worth posting about land here.",
    posted: "What you post shows here.",
    decks: "Your pitches and pages land here.",
  } as Record<StudioShelfKey, string>,
  error: "Couldn't load your Studio.",
  retry: "Retry",
  dot: { ready: "Ready for you", posted: "Posted", working: "Mila's working on it" } as Record<StudioDot, string>,
} as const;

export type CreateKind = keyof typeof STUDIO_V3_COPY.createOptions;
export const CREATE_KINDS: CreateKind[] = ["post", "ad", "deck", "page"];

/** What Mila is asked when a Create choice has no screen of its own (a draft she sends, or edits). */
export const CREATE_ASK: Record<"post" | "ad", string> = {
  post: "Help me make a post.",
  ad: "Help me make a post for a brand.",
};

const byNewest = (a: StudioItem, b: StudioItem) => (b.updatedAt || "").localeCompare(a.updatedAt || "");

/** A post kit's title, the way Home titles it. */
export function studioPostTitle(item: Pick<StudioItem, "title" | "hook">): string {
  return postTitle({ title: item.title, post: item.hook ? ({ hook: item.hook } as never) : null } as never);
}

/** The status colour. */
export function dotOf(item: Pick<StudioItem, "kind" | "status" | "working">): StudioDot {
  if (item.status === "published") return "posted";
  if (item.working) return "working";
  if (item.kind === "deck" && item.status === "draft") return "working";
  return "ready";
}

export function tileOf(item: StudioItem, now: Date): StudioTile {
  const dot = dotOf(item);
  if (item.kind === "post_kit") {
    const when = dot === "posted" ? STUDIO_V3_COPY.posted : item.dueOn ? relativeDay(item.dueOn, now) : null;
    return {
      id: item.id,
      // A kit with no due day and no format falls back to its status in words — never "Posted" unless it was posted.
      kicker: [when, formatWord(item.format ?? null)].filter(Boolean).join(" · ") || STUDIO_V3_COPY.dot[dot],
      title: studioPostTitle(item),
      dot,
      thumbUrl: item.thumbUrl,
      logoUrl: null,
      shape: "tall",
      open: dot === "posted" ? { to: "kit", id: item.id } : { to: "feed", id: item.id },
    };
  }
  const kicker = item.kind === "deck" ? STUDIO_V3_COPY.deck : item.kind === "page" ? STUDIO_V3_COPY.page : STUDIO_V3_COPY.media;
  return {
    id: item.id,
    kicker,
    title: item.kind === "deck" ? displayBrandName(item.title) : item.title,
    dot,
    thumbUrl: item.thumbUrl,
    logoUrl: item.logoUrl ?? null,
    shape: item.kind === "media_edit" ? "tall" : "cover",
    open: { to: "item", item },
    meta: item.meta ?? null,
  };
}

/** A moment the moments step chose, as an idea tile (only one with nothing prepared: a prepared one is in Ready). */
export function ideaTile(story: StoryItem): StudioTile {
  return {
    id: story.id,
    kicker: story.kicker,
    title: story.moment?.hook || story.title,
    dot: "ready",
    thumbUrl: null,
    logoUrl: null,
    shape: "tall",
    open: { to: "moment", story },
    dateFace: story.dateFace ?? null,
    story,
  };
}

const dueKey = (i: StudioItem) => i.dueOn ?? "9999-99-99";
/** The brand book's own Studio items (lib/brandBookLogic bookStudioItems ids). */
const isBook = (id: string) => id === "brand-book" || id === "brand-book-reel";

/** The four shelves, in order. An empty shelf is kept (the screen shows its one quiet line), so the layout never jumps. */
export function studioShelves(items: ReadonlyArray<StudioItem>, moments: ReadonlyArray<StoryItem>, now: Date): StudioShelf[] {
  const posts = items.filter((i) => i.kind === "post_kit");
  const ready = posts.filter((i) => i.status !== "published")
    .slice().sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || byNewest(a, b));
  const posted = posts.filter((i) => i.status === "published").slice().sort(byNewest);
  // Her brand book (and its reel) first, then pitches and pages, newest first.
  const decks = items.filter((i) => i.kind === "deck" || i.kind === "page").slice()
    .sort((a, b) => Number(isBook(b.id)) - Number(isBook(a.id)) || byNewest(a, b));
  const ideas = moments.filter((m) => !m.kitActionId);
  return [
    { key: "ready", title: STUDIO_V3_COPY.shelves.ready, tiles: ready.map((i) => tileOf(i, now)) },
    { key: "ideas", title: STUDIO_V3_COPY.shelves.ideas, tiles: ideas.map(ideaTile) },
    { key: "posted", title: STUDIO_V3_COPY.shelves.posted, tiles: posted.map((i) => tileOf(i, now)) },
    { key: "decks", title: STUDIO_V3_COPY.shelves.decks, tiles: decks.map((i) => tileOf(i, now)) },
  ];
}

/** The grid: everything made, newest first (moments are ideas, not made, so they stay on the shelves). */
export function studioGrid(items: ReadonlyArray<StudioItem>, now: Date): StudioTile[] {
  return items.slice().sort(byNewest).map((i) => tileOf(i, now));
}

/** True when there is nothing at all to show (no items, no ideas). */
export const studioEmpty = (shelves: ReadonlyArray<StudioShelf>): boolean => shelves.every((s) => s.tiles.length === 0);

/** Where the auto-play feed opens: the tapped kit, else the first ready one. */
export function feedStartIndex(ids: ReadonlyArray<string>, startId: string | null | undefined): number {
  if (!startId) return 0;
  const i = ids.indexOf(startId);
  return i < 0 ? 0 : i;
}

// ── The feed (Studio's default view) ─────────────────────────────────────────

/** One full-screen card in the feed: a post kit (ready, or posted), or a moment idea. */
export type FeedEntry =
  | { id: string; kind: "kit"; item: StudioItem; tile: StudioTile }
  | { id: string; kind: "idea"; story: StoryItem; tile: StudioTile };

/** The feed, top to bottom: Ready for you (soonest due) → Ideas from moments → Posted (newest). Decks stay in Browse. */
export function feedEntries(items: ReadonlyArray<StudioItem>, moments: ReadonlyArray<StoryItem>, now: Date): FeedEntry[] {
  const posts = items.filter((i) => i.kind === "post_kit");
  const ready = posts.filter((i) => i.status !== "published").slice().sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || byNewest(a, b));
  const posted = posts.filter((i) => i.status === "published").slice().sort(byNewest);
  return [
    ...ready.map((item) => ({ id: item.id, kind: "kit" as const, item, tile: tileOf(item, now) })),
    ...moments.filter((m) => !m.kitActionId).map((story) => ({ id: story.id, kind: "idea" as const, story, tile: ideaTile(story) })),
    ...posted.map((item) => ({ id: item.id, kind: "kit" as const, item, tile: tileOf(item, now) })),
  ];
}

/** The feed card's status chip: what it is, in words, with its colour. */
export function feedChip(e: FeedEntry): { dot: StudioDot; text: string } {
  if (e.kind === "idea") return { dot: "ready", text: [STUDIO_V3_COPY.idea, e.story.moment?.kind ?? null].filter(Boolean).join(" · ") };
  return { dot: e.tile.dot, text: STUDIO_V3_COPY.dot[e.tile.dot] };
}

/** The feed card's one line under the title: when and what ("Thu · Photo"), or a moment's date and why now. */
export function feedLine(e: FeedEntry): string | null {
  if (e.kind === "idea") return [e.story.kicker, e.story.moment?.whyNow ?? null].filter(Boolean).join(" · ") || null;
  const k = e.tile.kicker;
  return k && k !== STUDIO_V3_COPY.dot[e.tile.dot] ? k : e.tile.meta ?? null;
}

/** The feed card's one action. */
export function feedAction(e: FeedEntry): string {
  if (e.kind === "idea") return e.story.action.target.screen === "post_kit" ? STUDIO_V3_COPY.action.review : STUDIO_V3_COPY.action.make;
  return e.tile.dot === "posted" ? STUDIO_V3_COPY.action.seeIt : STUDIO_V3_COPY.action.review;
}

/** A deck cover's name, as the pitch cover sets it: her first name, then the rest (drawn outlined) on its own line. */
export function coverName(full: string | null | undefined): { first: string; rest: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { first: (parts[0] ?? "").toUpperCase(), rest: parts.slice(1).join(" ").toUpperCase() };
}

/** Under a deck or page cover: brand · type · status ("gorjana · Deck · Ready for you"). */
export function coverCaption(t: StudioTile): string {
  return [t.kicker === STUDIO_V3_COPY.deck ? t.title : null, t.kicker, STUDIO_V3_COPY.dot[t.dot]].filter(Boolean).join(" · ");
}
