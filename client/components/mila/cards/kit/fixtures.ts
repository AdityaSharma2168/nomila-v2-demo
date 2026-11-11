/**
 * cards/kit/fixtures — the design page's own examples as card DTOs (tests and the agent gallery). Every athlete, brand
 * and number is made up: Sam Rivera, a fictional college volleyball player. Built as code-built ChatCards and run through
 * the shared schema (toMilaCardDto), so a fixture that drifts from the DTO fails loudly.
 */
import { toMilaCardDto, type CardMedia, type MilaCardDto } from "../../../../../shared/milaCards";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const none = { url: null, mediaId: null, atmosphereId: null, brand: null, chart: null, hasFace: false } as const;
const media = (m: Partial<CardMedia> & Pick<CardMedia, "kind" | "alt">): CardMedia => ({ ...none, ...m });

/**
 * Pictures for the gallery, so the image-led design shows: photos from the shared ATMOSPHERE library's own sources
 * (scripts/data/atmosphere-library-seed.json — Unsplash, "Unsplash License", no people, logos or text), served from
 * Unsplash's image CDN as its licence asks. Never an athlete's media: Sam Rivera is made up, and the "clip" and "photo"
 * slots below show empty courts and nets standing in for their own frames.
 */
const unsplash = (photo: string) => `https://images.unsplash.com/${photo}?w=800&q=70&auto=format&fit=crop`;
export const FIXTURE_PHOTOS = {
  /** seed -t40mnV3vAU "White and red volleyball court aerial photo" (volleyball). */
  court: unsplash("photo-1479859546309-cd77fa21c8f6"),
  /** seed AtxFj3JGja0 "White sports net against a blurred blue background" (volleyball). */
  net: unsplash("photo-1780509459408-b49567ad060a"),
  /** seed Bt-oCv_YI3E "Empty sports hall" (general). */
  hall: unsplash("photo-1564769353575-73f33a36d84f"),
  /** seed run2RLJ_fb0 "A dark locker room with wooden benches and black lockers" (general). */
  lockerRoom: unsplash("photo-1781274326569-7120016a6c7e"),
  /** seed udavHQTBEz8 "Rippling blue water with a white line" (a brand cover stand-in). */
  water: unsplash("photo-1758626412221-47f0a0994eab"),
} as const;

/** Generic sample logos (made-up marks, drawn as SVG): no real brand's logo. */
const svg = (body: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${body}</svg>`)}`;
export const FIXTURE_LOGOS = {
  cobalt: svg('<circle cx="20" cy="20" r="17" fill="#1C6FB8"/><path d="M6 23c5-5 9-5 14 0s9 5 14 0" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round"/>'),
  north: svg('<path d="M4 32 17 10l7 11 4-6 8 17z" fill="#1E2A24"/><path d="M17 10l3 5-3 2-2-3z" fill="#fff"/>'),
  leaf: svg('<path d="M8 32C8 16 18 8 33 7c0 16-9 25-25 25z" fill="#3C8D4F"/><path d="M10 30 26 14" stroke="#fff" stroke-width="2.2"/>'),
  kite: svg('<path d="M20 4 33 20 20 36 7 20z" fill="#E07A1F"/><path d="M20 4v32M7 20h26" stroke="#fff" stroke-width="2"/>'),
} as const;

const COBALT = { name: "Cobaltwave Hydration", logoUrl: FIXTURE_LOGOS.cobalt, domain: "cobaltwave.example", isPerson: false };
const NORTH = { name: "Northpeak Apparel", logoUrl: FIXTURE_LOGOS.north, domain: "northpeak.example", isPerson: false };
const LEAF = { name: "Brightleaf Foods", logoUrl: FIXTURE_LOGOS.leaf, domain: "brightleaf.example", isPerson: false };
const KITE = { name: "Kitewear", logoUrl: FIXTURE_LOGOS.kite, domain: "kitewear.example", isPerson: false };

function dto(c: unknown): MilaCardDto {
  const r = toMilaCardDto(c);
  if (!r.ok) throw new Error(`fixture ${String((c as { kind?: string }).kind)} fails its DTO (${r.reason})`);
  return r.dto;
}

export const INSIGHT_DTO = dto({
  id: "insight:f1", kind: "insight", title: "Insight", links: [],
  payload: {
    decisionId: U(1), angle: "change",
    media: media({ kind: "chart", alt: "Reel saves by month", chart: { shape: "bars", points: [610, 720, 680, 840, 990, 1940], highlight: 5, big: "1,940", delta: "+96%" } }),
    headline: "Your reel saves doubled this month", line: "Gear and nutrition brands look for saves before reaching out.",
    more: { evidence: [{ label: "Saves", value: "1,940", note: "Sep: 990" }, { label: "Training reels", value: "6", note: "Sep: 5" }], why: "Saves show people want to come back to your content." },
    sources: [{ label: "Instagram", site: "instagram.com", date: "2026-11-03" }], factIds: [U(101)],
    seeMore: { label: "My Intelligence", target: { screen: "scouting", id: "mia" } }, ask: "Tell me more about my reel saves",
  },
});

export const IDEAS_DTO = dto({
  id: "ideas:run-1", kind: "ideas", title: "Ideas", links: [],
  payload: {
    items: [
      { ideaId: U(11), media: media({ kind: "content_thumb", alt: "Your warm-up clip", url: FIXTURE_PHOTOS.court, mediaId: U(901), hasFace: true }), headline: "Game-day routine in 15 seconds", line: "Last week's warm-up clips, posted before your home opener.", format: "reel", length: "15s", moment: { label: "Home opener · Sat 8 Nov", until: "2026-11-08" }, brand: null, pillarKey: "training days", studio: { screen: "studio", id: U(11) } },
      { ideaId: U(12), media: media({ kind: "content_thumb", alt: "Your serve clip", url: FIXTURE_PHOTOS.net, mediaId: U(902) }), headline: "Five serves, slowed down", line: "Your serve clips, cut to the beat.", format: "carousel", length: null, moment: null, brand: null, pillarKey: "training days", studio: { screen: "studio", id: U(12) } },
      { ideaId: U(13), media: media({ kind: "athlete_photo", alt: "Your locker room photo", url: FIXTURE_PHOTOS.lockerRoom, mediaId: U(903) }), headline: "Your locker room playlist, as a story", line: "A story your fans can tap through.", format: "story", length: null, moment: null, brand: null, pillarKey: "behind the scenes", studio: { screen: "studio", id: U(13) } },
    ],
  },
});

export const TURN_ON_DTO = dto({
  id: "turn-on:f1", kind: "turn-on", title: "Mila can do more", links: [],
  payload: {
    decisionId: U(21), capability: "post_ideas", accountRef: null, accountLabel: null,
    media: media({ kind: "atmosphere", alt: "An empty sports hall before a game", url: FIXTURE_PHOTOS.hall, atmosphereId: U(911) }),
    headline: "Post ideas from your camera roll", line: "Post ideas from the new photos and videos you share.", glyph: "camera",
    consentShort: ["Reads new photos and videos you share", "Always asks first: posting anything"],
    sheet: {
      purpose: "Post ideas from the new photos and videos you share.",
      rows: [
        { icon: "image", title: "Ideas from your own shots", line: "Mila looks at the new photos and videos you share with Nomila and suggests posts." },
        { icon: "lock", title: "You choose what Mila can do", line: "Nothing is posted without your tap. Turn it off any time in Me." },
        { icon: "eye", title: "Keep an eye on it", line: "Mila can get things wrong. Check each idea before you use it." },
      ],
      legal: "Ideas Mila already made stay yours if you turn this off.", button: "Turn on",
    },
    // The registry's post_ideas/1 words (server/agent/welcome/registry.ts via consentWords), verbatim.
    consent: { reads: ["Look at your newly tagged photos and videos and suggest posts"], drafts: false, alwaysAsks: ["Posting anything"], onRevoke: "stop_and_keep" },
    consentVersion: "post_ideas/1", choiceVersion: null, state: "unset",
  },
});

export const ONCE_DTO = dto({
  id: "once:f1", kind: "quick-question", title: "One quick question", links: [],
  payload: {
    question: "That's the second brand this month offering free product only. What should I do with these?",
    options: ["Always show me", "Only brands I already use", "Set them aside"], why: "Brightleaf Foods on 28 Oct and Kitewear on 2 Nov both offered free product only.",
    media: media({ kind: "brand_logo", alt: "Brightleaf Foods and Kitewear", brand: LEAF, brands: [LEAF, KITE] }), context: "2 product-only offers this month",
    once: {
      key: "product_only_offers", saveAs: "standing_rule", decisionId: U(31), answered: null, somethingElse: true, prefill: "Free-product offers: ",
      choices: [
        { label: "Always show me", rule: "Always show me product-only offers." },
        { label: "Only brands I already use", rule: "Only show product offers from brands you already use." },
        { label: "Set them aside", rule: "Set product-only offers aside." },
      ],
    },
  },
});

export const ANSWER_DTO = dto({
  id: "answer:f1", kind: "answer", title: "Answer", links: [],
  payload: {
    media: media({ kind: "brand_cover", alt: "Cobaltwave Hydration", url: FIXTURE_PHOTOS.water, brand: COBALT }), brand: COBALT,
    headline: "Yes, they run real athlete campaigns", line: "Since 2024, mostly with college runners and swimmers.",
    more: { kind: "list", items: [
      { lead: "Sep 2026", text: "\"Refill\" with 12 college track athletes", sourceIx: 0 },
      { lead: "Mar 2026", text: "Paid posts with a university swim team", sourceIx: 1 },
      { lead: "2025", text: "Beach volleyball series sponsor", sourceIx: 0 },
    ] },
    sources: [
      { label: "Press", url: "https://cobaltwave.example/press", site: "cobaltwave.example", date: null },
      { label: "College Sports Daily", url: "https://collegesportsdaily.example/refill", site: "collegesportsdaily.example", date: "2026-09-12" },
    ],
    asOf: "2026-11-03", followUps: ["Have they worked with volleyball players?", "What do their deals usually ask for?"], saved: false, decisionId: U(41),
  },
});

export const DEAL_DTO = dto({
  id: "deal:f1", kind: "deal", title: NORTH.name, links: [{ label: "Open deal", target: { screen: "deal", id: "o1" } }],
  payload: {
    opportunityId: "o1", brand: NORTH, typeLabel: "Paid content", moneyLine: "$1,400 for 2 reels — about $700 each, above your minimum",
    whoseMove: "yours", moveLabel: "Your move", chips: ["Above your minimum", "Nothing to flag"], action: { label: "Draft a reply", message: "Draft a reply to Northpeak Apparel" }, closed: false,
  },
});

export const DEALS_LIST_DTO = dto({
  id: "deals-list:f1", kind: "deals-list", title: "Your deals", links: [],
  payload: { items: [
    { opportunityId: "o1", brand: NORTH, moneyLine: "$1,400", typeLabel: "Paid content", stage: "Your move", lastActivity: "2 days ago" },
    { opportunityId: "o2", brand: COBALT, moneyLine: "No fee yet", typeLabel: "Launch post", stage: "Waiting on them", lastActivity: "Today" },
  ] },
});

export const KIT_FIXTURES = { insight: INSIGHT_DTO, ideas: IDEAS_DTO, "turn-on": TURN_ON_DTO, once: ONCE_DTO, answer: ANSWER_DTO, deal: DEAL_DTO, "deals-list": DEALS_LIST_DTO } as const;
export type KitFixtureKey = keyof typeof KIT_FIXTURES;

/**
 * Me › What Mila can do, as GET /api/v1/me/mila/capabilities answers it (gallery and tests): one capability on, one
 * paused, the rest off, and draft replies on one connected inbox. The words are the server's own presentations and
 * consent words (server/agent/milaCards/capabilities.ts, server/agent/welcome/registry.ts), copied for the gallery.
 */
const control = (line: string) => ({ icon: "lock", title: "You choose what Mila can do", line });
const watch = (line: string) => ({ icon: "eye", title: "Keep an eye on it", line });
type MeCap = import("./WhatMilaCanDo").MeCapability;
const meCap = (key: string, name: string, p: { headline: string; line: string; glyph: string; row1: [string, string, string]; control: string; watch: string; legal: string },
  consent: Partial<MeCap["consent"]> & { version: string }, choices: MeCap["choices"] = [], extra: Partial<MeCap> = {}): MeCap => ({
  key, name, scope: "athlete", accounts: [], choices,
  consent: { automatic: [], alwaysAsks: [], drafts: false, onRevoke: "stop_and_keep", ...consent },
  presentation: {
    headline: p.headline, line: p.line, glyph: p.glyph, platform: null,
    sheet: { purpose: p.line, rows: [{ icon: p.row1[0], title: p.row1[1], line: p.row1[2] }, control(p.control), watch(p.watch)], legal: p.legal, button: "Turn on" },
  },
  ...extra,
});
const DRAFTS = "Write drafts for you to check. Nothing is sent without your tap.";
export const ME_CAPABILITIES_FIXTURE: MeCap[] = [
  meCap("draft_replies", "Draft replies to brands", {
    headline: "Draft replies to brands", line: "A first reply written for you when a brand deal arrives.", glyph: "edit-3",
    row1: ["edit-3", "A reply ready to check", "When a brand deal arrives on this account, Mila writes a first reply for you to read."],
    control: "Nothing is sent without your tap. Turn it off any time in Me.", watch: "Mila can get things wrong. Read each draft before you send it.",
    legal: "Drafts Mila already wrote stay yours if you turn this off.",
  }, { version: "draft_replies/2", automatic: ["Write a first reply when a deal arrives on this account", DRAFTS], drafts: true, alwaysAsks: ["Sending any reply"] }, [],
  { scope: "per_account", accounts: [{ accountRef: U(701), platform: "gmail", label: "sam.rivera@example.com", status: "active" }] }),
  meCap("post_ideas", "Post ideas each week", {
    headline: "Post ideas from your camera roll", line: "Post ideas from the new photos and videos you share.", glyph: "camera",
    row1: ["image", "Ideas from your own shots", "Mila looks at the new photos and videos you share with Nomila and suggests posts."],
    control: "Nothing is posted without your tap. Turn it off any time in Me.", watch: "Mila can get things wrong. Check each idea before you use it.",
    legal: "Ideas Mila already made stay yours if you turn this off.",
  }, { version: "post_ideas/1", automatic: ["Look at your newly tagged photos and videos and suggest posts"], alwaysAsks: ["Posting anything"] },
  [{ accountRef: null, state: "enabled", version: 1, consentVersion: "post_ideas/1" }]),
  meCap("plan_refresh", "Your plan, refreshed weekly", {
    headline: "Your plan, refreshed weekly", line: "Mila rebuilds your plan each week and before dated events.", glyph: "refresh-cw",
    row1: ["refresh-cw", "A plan that keeps up", "Each week, and before dated events, Mila rebuilds your plan from what changed."],
    control: "Keep, change or drop any goal. Turn it off any time in Me.", watch: "Mila can get things wrong. Check the plan still fits before you follow it.",
    legal: "Your plan as it is today stays yours if you turn this off.",
  }, { version: "plan_refresh/1", automatic: ["Rebuild your plan each week and before dated events"] },
  [{ accountRef: null, state: "paused", version: 2, consentVersion: "plan_refresh/1" }]),
  meCap("pitch_deck", "Pitch card", {
    headline: "Pitch cards for brands", line: "A one-page pitch for a brand you want to work with, ready for you to check.", glyph: "file-text",
    row1: ["file-text", "A pitch for each brand", "Mila makes a pitch card for a brand you choose, from your research and your numbers."],
    control: "Nothing is shared without your tap. Turn it off any time in Me.", watch: "Mila can get things wrong. Read each pitch before you share it.",
    legal: "Pitches Mila already made stay yours if you turn this off.",
  }, { version: "pitch_deck/2", automatic: [DRAFTS], drafts: true, alwaysAsks: ["Sharing it with anyone"] }),
  meCap("auto_archive", "Set aside deals that went quiet", {
    headline: "Set aside deals that went quiet", line: "Deals nobody worked on for 45 days move out of your list, with Undo.", glyph: "archive",
    row1: ["archive", "A shorter list", "A deal with no activity for 45 days, that nobody worked on, moves out of your list."],
    control: "A deal you're working on, or one waiting on your reply, is never set aside. Turn it off any time in Me.",
    watch: "Mila can get things wrong. Each deal set aside shows under Set aside by Nomila, with Undo.",
    legal: "Deals already set aside stay set aside if you turn this off. Undo still works.",
  }, { version: "auto_archive/1", automatic: ["Move a deal nobody worked on for 45 days out of your list, with Undo"] }),
  meCap("bookings", "Bookings for lessons and camps", {
    headline: "Bookings for lessons and camps", line: "Booking requests from your page come to you. You accept or decline each one.", glyph: "calendar",
    row1: ["calendar", "Requests in one place", "Requests for lessons and camps from your public page come into your inbox for you to answer."],
    control: "Nothing is accepted, declined or charged without your tap. Turn it off any time in Me.",
    watch: "Mila can get things wrong. Check the date, time and price before you accept.",
    legal: "Bookings you already accepted stay booked if you turn this off.",
  }, { version: "bookings/1", automatic: ["Take booking requests into your inbox"], alwaysAsks: ["Accepting or declining a booking", "Charging anyone"] }),
];
