/**
 * fixtures.ts — three MADE-UP athletes for the public page renderer, used by the dev-only fixture route
 * (/p/_dev/fixtures) and by tests. Production reads the published snapshot instead (publicCard/snapshotAdapter.ts).
 *
 * None of these people exist. They cover the shapes the renderer must handle:
 *   - "avery-okafor"  : a full card, every door on (Partner, Book, Shop, Create), six chapters, three socials.
 *   - "rowan-castell" : a different sport, Shop not on (that slot falls back to Story), a factual hint on Book.
 *   - "sam-ito"       : a new athlete with little data: two chapters, Book and Shop not on (Story + Follow fallbacks).
 *
 * Sport and brand words here are fixture DATA, exactly as a real snapshot would carry them. No media files: chapters
 * without media draw on the neutral gradient, which is also what a real chapter without a picked photo does.
 */
import { resolveTileSlots } from "./tiles";
import type { PublicCardView, PublicChapter, PublicSocialLink } from "./view";

const PUBLISHED = "2026-10-02T15:00:00.000Z";

function build(
  base: Omit<PublicCardView, "tiles">,
  doors: { partnerOn: boolean; bookOn: boolean; shopOn: boolean; hints?: { book?: string } },
): PublicCardView {
  return {
    ...base,
    tiles: resolveTileSlots({
      firstName: base.athlete.firstName,
      partnerOn: doors.partnerOn,
      bookOn: doors.bookOn,
      shopOn: doors.shopOn,
      chapters: base.chapters,
      socials: base.socials,
      hints: doors.hints,
    }),
  };
}

// ── 1 · A full card ─────────────────────────────────────────────────────────
const averySocials: PublicSocialLink[] = [
  { network: "Instagram", url: "https://www.instagram.com/example.avery", handle: "example.avery" },
  { network: "TikTok", url: "https://www.tiktok.com/@example.avery", handle: "example.avery" },
  { network: "YouTube", url: "https://www.youtube.com/@example-avery", handle: "example-avery" },
];
const averyChapters: PublicChapter[] = [
  {
    id: "highlights",
    kind: "highlights",
    title: "Highlights",
    headline: "Avery Okafor",
    items: [
      { type: "stat", label: "Followers", value: "48.2K", asOf: "as of 1 Oct" },
      { type: "stat", label: "Avg. views", value: "21K", asOf: "as of 1 Oct" },
      { type: "stat", label: "Engagement", value: "6.4%", asOf: "as of 1 Oct" },
    ],
    source: "Published 2 Oct 2026",
  },
  {
    id: "story",
    kind: "story",
    title: "Story",
    eyebrow: "Story",
    headline: "From the back straight to the final",
    items: [
      { type: "beat", label: "Origin", text: "Started running at eleven on a cinder track behind the community centre." },
      { type: "beat", label: "Rise", text: "Moved up from the 400m to the 200m and made the conference final as a sophomore." },
      { type: "beat", label: "Now", text: "Training for a first national final while finishing a design degree." },
    ],
    quote: "I run the bend like it owes me something.",
    source: "Published 2 Oct 2026",
  },
  {
    id: "partnerships",
    kind: "partnerships",
    title: "Partnerships",
    eyebrow: "Signed partnerships",
    headline: "Who Avery works with",
    items: [
      { type: "partner", name: "Northline Running", since: "since Mar 2026" },
      { type: "partner", name: "Brightwater Hydration", since: "since Jul 2026" },
    ],
    source: "Shown with Avery's approval",
  },
  {
    id: "competition",
    kind: "competition",
    title: "Competition",
    eyebrow: "Track & field · sprints",
    headline: "On the track",
    items: [
      { type: "fact", text: "Conference 200m finalist", detail: "2025 and 2026" },
      { type: "fact", text: "4×400m relay, anchor leg", detail: "Team record, 2026" },
      { type: "fact", text: "Academic all-conference", detail: "2025" },
    ],
    source: "Confirmed by Avery",
  },
  {
    id: "impact",
    kind: "impact",
    title: "Impact",
    eyebrow: "What Avery stands for",
    headline: "Open tracks for every kid",
    body: "Avery runs a free Saturday sprint clinic for middle-schoolers and raises money for track resurfacing.",
    items: [{ type: "fact", text: "Saturday sprint clinic", detail: "Every week in season" }],
    source: "Confirmed by Avery",
  },
  {
    id: "media",
    kind: "media",
    title: "Media",
    eyebrow: "Press",
    headline: "In the news",
    items: [
      { type: "link", title: "The sprinter designing her own spikes", outlet: "Campus Daily", url: "https://example.com/press/1" },
      { type: "link", title: "Five athletes to watch this spring", outlet: "Track Weekly", url: "https://example.com/press/2" },
    ],
    source: "Approved by Avery",
  },
];
export const averyOkafor: PublicCardView = build(
  {
    handle: "avery-okafor",
    version: 3,
    publishedAt: PUBLISHED,
    indexable: false,
    athlete: {
      firstName: "Avery",
      lastName: "Okafor",
      identityLine: "Sprinter, designer, and the loudest voice at the start line.",
      quote: "Fast is a feeling. I chase it every day.",
      verified: true,
    },
    hero: null,
    chapters: averyChapters,
    offers: [
      { id: "o1", title: "1:1 video call", durationMin: 30, format: "virtual", allInMinor: 17796, currency: "USD", note: "Includes the Nomila service fee" },
      { id: "o2", title: "Sprint form session", durationMin: 45, format: "in_person", allInMinor: 29660, currency: "USD", note: "In person · ID check" },
    ],
    picks: [
      { id: "p1", title: "Carbon racing spike", merchant: "Northline", priceMinor: 18000, currency: "USD", herWords: "The only spike I trust on a wet bend.", goCode: "fxa1", fromBrand: true },
      { id: "p2", title: "Electrolyte mix", merchant: "Brightwater", priceMinor: 3200, currency: "USD", herWords: "Two scoops after every session.", goCode: "fxa2", fromBrand: true },
      { id: "p3", title: "Foam roller", merchant: "Example Store", priceMinor: 2900, currency: "USD", herWords: "Ten minutes, every night.", goCode: "fxa3" },
      { id: "p4", title: "Sketchbook, A5", merchant: "Example Store", priceMinor: 1400, currency: "USD", herWords: "Where every spike design starts.", goCode: "fxa4" },
      { id: "p5", title: "Recovery slides", merchant: "Example Store", priceMinor: 4500, currency: "USD", herWords: "Straight on after the cool-down.", goCode: "fxa5", amazon: true },
      { id: "p6", title: "Training watch", merchant: "Example Store", priceMinor: 24900, currency: "USD", herWords: "Splits on my wrist, not in my head.", goCode: "fxa6" },
    ],
    socials: averySocials,
    askChips: [
      { label: "How did Avery get started?", chapterId: "story" },
      { label: "Who has Avery worked with?", chapterId: "partnerships" },
      { label: "What has Avery won?", chapterId: "competition" },
      { label: "What does Avery care about?", chapterId: "impact" },
    ],
  },
  { partnerOn: true, bookOn: true, shopOn: true },
);

// ── 2 · A different sport, Shop not on, a hint on Book ─────────────────────
const rowanChapters: PublicChapter[] = [
  {
    id: "highlights",
    kind: "highlights",
    title: "Highlights",
    headline: "Rowan Castell",
    items: [
      { type: "stat", label: "Followers", value: "12.9K", asOf: "as of 30 Sep" },
      { type: "stat", label: "Avg. views", value: "8.1K", asOf: "as of 30 Sep" },
    ],
    source: "Published 2 Oct 2026",
  },
  {
    id: "competition",
    kind: "competition",
    title: "Racing",
    eyebrow: "Rowing · heavyweight eight",
    headline: "Stroke seat, two seasons",
    items: [
      { type: "fact", text: "National championship grand final", detail: "2026" },
      { type: "fact", text: "Stroke of the first eight", detail: "Since 2025" },
    ],
    source: "Confirmed by Rowan",
  },
  {
    id: "story",
    kind: "story",
    title: "Story",
    eyebrow: "Story",
    headline: "Up before the river",
    items: [
      { type: "beat", label: "Origin", text: "Walked on as a novice with no rowing background." },
      { type: "beat", label: "Now", text: "Coaching the novice squad on weekends." },
    ],
    source: "Published 2 Oct 2026",
  },
  {
    id: "venture",
    kind: "venture",
    title: "Venture",
    eyebrow: "What Rowan builds",
    headline: "Erg data, made readable",
    body: "Rowan writes a weekly newsletter that turns training numbers into plain advice for new rowers.",
    items: [{ type: "fact", text: "Weekly training newsletter", detail: "Since 2025" }],
    source: "Confirmed by Rowan",
  },
];
export const rowanCastell: PublicCardView = build(
  {
    handle: "rowan-castell",
    version: 1,
    publishedAt: PUBLISHED,
    indexable: false,
    athlete: {
      firstName: "Rowan",
      lastName: "Castell",
      identityLine: "Stroke seat. Early mornings. Plain-spoken coach in training.",
      quote: "The boat only moves when everyone does.",
      verified: true,
    },
    hero: null,
    chapters: rowanChapters,
    offers: [
      { id: "o1", title: "Erg technique review", durationMin: 30, format: "virtual", allInMinor: 11864, currency: "USD", note: "Includes the Nomila service fee" },
    ],
    picks: [],
    socials: [{ network: "Instagram", url: "https://www.instagram.com/example.rowan", handle: "example.rowan" }],
    askChips: [
      { label: "How did Rowan get started?", chapterId: "story" },
      { label: "What has Rowan raced?", chapterId: "competition" },
      { label: "What is Rowan building?", chapterId: "venture" },
    ],
  },
  { partnerOn: true, bookOn: true, shopOn: false, hints: { book: "Next: Thu 4:30p" } },
);

// ── 3 · A new athlete with little data ──────────────────────────────────────
export const samIto: PublicCardView = build(
  {
    handle: "sam-ito",
    version: 1,
    publishedAt: PUBLISHED,
    indexable: false,
    athlete: { firstName: "Sam", lastName: "Ito", identityLine: "Distance freestyle.", verified: false },
    hero: null,
    chapters: [
      {
        id: "highlights",
        kind: "highlights",
        title: "Highlights",
        headline: "Sam Ito",
        items: [{ type: "stat", label: "Followers", value: "1.2K", asOf: "as of 5 Oct" }],
        source: "Published 6 Oct 2026",
      },
      {
        id: "story",
        kind: "story",
        title: "Story",
        eyebrow: "Story",
        headline: "Lane four, every morning",
        items: [
          { type: "beat", label: "Origin", text: "Learned to swim at the public pool down the street." },
          { type: "beat", label: "Now", text: "First season on the senior squad." },
        ],
        source: "Published 6 Oct 2026",
      },
    ],
    offers: [],
    picks: [],
    socials: [{ network: "Instagram", url: "https://www.instagram.com/example.sam", handle: "example.sam" }],
    askChips: [{ label: "How did Sam get started?", chapterId: "story" }],
  },
  { partnerOn: true, bookOn: false, shopOn: false },
);

export const PUBLIC_CARD_FIXTURES: Record<string, PublicCardView> = {
  [averyOkafor.handle]: averyOkafor,
  [rowanCastell.handle]: rowanCastell,
  [samIto.handle]: samIto,
};
