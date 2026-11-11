// publicCardLogic — the pure half of her public card editor (design-public-card-v3 §3 her side, §9 chapters, §10
// publish, §16 Q1–Q3; the page layout from "v2 Mila at the centre"). No React, no fetch: the screens and the
// PublicCardSection read these, and publicCardLogic.test.ts pins them.
//
//   errors        publicCardError(err)       the "<status>: <json>" apiRequest throws → { status, code, error, nextChangeAt }
//   state         cardStatus(card)           draft / live vN / offline, in words she reads
//   decisions     decisionsFrom(draft)       her decisions as the server holds them, rebuilt from the draft response
//                 approveItem / hideItem / setChapterHidden / renameChapter / moveChapter
//   review        itemLine, itemNote, chapterNote, cutLine, waitingCount
//   handle        handleProblem(raw), HANDLE_ERROR_COPY, handle change date
//   the page      pageModel(content)        the visitor's page, mapped exactly as the server's snapshotAdapter maps it
//
// COPY RULE: to her, "you" and "your"; about her to the public, her first name. Never a pronoun, never a sport, school,
// league or brand word (no hardcoding for any athlete).

import type {
  BasisLabel, ChapterKind, CutItem, DraftChapter, DraftDecisions, DraftItem, ItemBlock, ItemKind, PublicCardContent,
  PublicCardDraftResponse, PublicCardErrorResponse, PublicCardState, PublicCardSwitches, PublicGridTile, PublicItem,
} from "../../shared/publicCard";

// ─── errors ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PublicCardProblem {
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  code: PublicCardErrorResponse["code"] | null;
  /** The server's sentence, when it sent one. */
  error: string | null;
  nextChangeAt: string | null;
}

/** apiRequest throws `Error("<status>: <body>")`; anything else is a network failure (status 0). */
export function publicCardError(err: unknown): PublicCardProblem {
  const m = /^(\d{3}): ([\s\S]*)$/.exec(err instanceof Error ? err.message : "");
  if (!m) return { status: 0, code: null, error: null, nextChangeAt: null };
  const status = Number(m[1]);
  try {
    const b = JSON.parse(m[2]) as Partial<PublicCardErrorResponse>;
    return {
      status,
      code: typeof b.code === "string" ? b.code : null,
      error: typeof b.error === "string" && b.error.trim() ? b.error : null,
      nextChangeAt: typeof b.nextChangeAt === "string" ? b.nextChangeAt : null,
    };
  } catch {
    return { status, code: null, error: null, nextChangeAt: null };
  }
}

/** The card's own routes answer 404 `disabled` while the server's PUBLIC_CARD flag is off. */
export const isDisabled = (p: PublicCardProblem) => p.status === 404;

export const ERROR_COPY = {
  load: "Your public card didn't load.",
  network: "Couldn't reach Nomila. Check your connection and try again.",
  disabled: "Publishing your card opens soon. Until then, brands see your deck.",
  save: "That change didn't save. Try again.",
  retry: "Try again",
} as const;

/** One line for a failed load or save, in her words. */
export function problemLine(p: PublicCardProblem, fallback: string = ERROR_COPY.load): string {
  if (p.status === 0) return ERROR_COPY.network;
  if (isDisabled(p)) return ERROR_COPY.disabled;
  if (p.status >= 500) return fallback;
  return p.error ?? fallback;
}

// ─── dates ──────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-07T…" → "7 Nov 2026" (UTC, as the server writes it). "" when it is not a date. */
export function dayLine(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ─── the card's state ───────────────────────────────────────────────────────────────────────────────────────────

export const CARD_COPY = {
  heading: "Your public card",
  draftChip: "Draft",
  liveChip: "Live",
  offlineChip: "Offline",
  draftLine: "Not published yet. Nothing is public until you publish.",
  offlineLine: "Taken offline. Your link doesn't open for anyone.",
  noHandle: "Your link is set when you publish. You can pick it in Card settings.",
  review: "Review & publish",
  reviewMetaReady: "Ready to publish",
  preview: "Preview as a visitor",
  previewMeta: "Exactly what publishing now would show",
  share: "Share link",
  shareMeta: "Send your card's link",
  settings: "Card settings",
  settingsMeta: "Doors, your link, M.I.A. and search",
  deck: "Your deck",
  deckMeta: "Your deck, as brands see it today",
} as const;

export interface CardStatus {
  chip: string;
  /** The line under the heading. */
  line: string;
  live: boolean;
}

export function cardStatus(card: PublicCardState): CardStatus {
  if (card.status === "published") {
    const v = card.publishedVersion != null ? ` · version ${card.publishedVersion}` : "";
    const since = dayLine(card.publishedAt);
    return { chip: `${CARD_COPY.liveChip}${card.publishedVersion != null ? ` · v${card.publishedVersion}` : ""}`, line: `Live${since ? ` since ${since}` : ""}${v}.`, live: true };
  }
  if (card.status === "unpublished") return { chip: CARD_COPY.offlineChip, line: CARD_COPY.offlineLine, live: false };
  return { chip: CARD_COPY.draftChip, line: CARD_COPY.draftLine, live: false };
}

/** The public page, on the API host (the server's PUBLIC_CARD_BASE_URL serves /p/:handle). */
export function publicCardUrl(base: string, handle: string): string {
  return `${base.replace(/\/+$/, "")}/p/${encodeURIComponent(handle)}`;
}
/** The link as she reads it: no scheme. */
export const displayUrl = (url: string) => url.replace(/^https?:\/\//, "");

/** Items that wait on her: proposed and not yet publishable because they need her approval or confirmation. */
export function waitingCount(d: PublicCardDraftResponse): number {
  const all = [...d.chapters.flatMap((c) => c.items), ...d.offers, ...d.picks];
  return all.filter((i) => i.blockedBy === "needs_approval" || i.blockedBy === "needs_confirmation").length;
}

export function reviewMeta(d: PublicCardDraftResponse): string {
  const n = waitingCount(d);
  if (n > 0) return `${n} ${n === 1 ? "item waits" : "items wait"} for you`;
  if (d.canPublish) return CARD_COPY.reviewMetaReady;
  return d.blockedReason ?? "Nothing to publish yet";
}

// ─── her decisions ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Her decisions, rebuilt from the draft (PUT /draft replaces them whole, and GET /draft does not echo them).
 *
 *   items     every item she decided (state ≠ proposed). A line Nomila wrote ("made") keeps its pin ONLY when the
 *             server still counts it approved: an approval of older wording (state approved, blocked needs_approval)
 *             is written back WITHOUT a hash, so rebuilding never re-approves wording she has not seen.
 *   chapters  hidden, and a title only when it differs from the default.
 *   order     the chapters as drawn (Highlights is always first on the server; it is left out).
 *
 * Limits: decisions on items the draft no longer lists (a cut line, an identity line that lost to a stronger one)
 * cannot be seen here and are not carried over.
 */
export function decisionsFrom(d: Pick<PublicCardDraftResponse, "chapters" | "offers" | "picks">): DraftDecisions {
  const items: NonNullable<DraftDecisions["items"]> = {};
  for (const i of [...d.chapters.flatMap((c) => c.items), ...d.offers, ...d.picks]) {
    if (i.state === "proposed") continue;
    if (i.state === "hidden") { items[i.key] = { state: "hidden" }; continue; }
    const pinned = i.basis === "made" && i.textHash && i.blockedBy !== "needs_approval";
    items[i.key] = pinned ? { state: "approved", textHash: i.textHash! } : { state: "approved" };
  }
  const chapters: NonNullable<DraftDecisions["chapters"]> = {};
  for (const c of d.chapters) {
    const entry: { hidden?: boolean; title?: string } = {};
    if (c.hidden) entry.hidden = true;
    if (c.title.trim() && c.title !== c.defaultTitle) entry.title = c.title;
    if (Object.keys(entry).length) chapters[c.key] = entry;
  }
  const order = d.chapters.map((c) => c.key).filter((k) => k !== "highlights");
  return { items, chapters, order };
}

/** Approve one item: a line Nomila wrote pins the exact wording she is looking at. */
export function approveItem(dec: DraftDecisions, item: Pick<DraftItem, "key" | "basis" | "textHash">): DraftDecisions {
  const decision = item.basis === "made" && item.textHash ? { state: "approved" as const, textHash: item.textHash } : { state: "approved" as const };
  return { ...dec, items: { ...(dec.items ?? {}), [item.key]: decision } };
}
export function hideItem(dec: DraftDecisions, key: string): DraftDecisions {
  return { ...dec, items: { ...(dec.items ?? {}), [key]: { state: "hidden" } } };
}
export function setChapterHidden(dec: DraftDecisions, key: ChapterKind, hidden: boolean): DraftDecisions {
  if (key === "highlights") return dec;
  const cur = { ...(dec.chapters?.[key] ?? {}) };
  if (hidden) cur.hidden = true; else delete cur.hidden;
  return { ...dec, chapters: { ...(dec.chapters ?? {}), [key]: cur } };
}
export const TITLE_MAX = 60;
/** Rename a chapter; an empty name (or the default) goes back to the default title. */
export function renameChapter(dec: DraftDecisions, ch: Pick<DraftChapter, "key" | "defaultTitle">, title: string): DraftDecisions {
  const t = title.trim().slice(0, TITLE_MAX);
  const cur = { ...(dec.chapters?.[ch.key] ?? {}) };
  if (!t || t === ch.defaultTitle) delete cur.title; else cur.title = t;
  return { ...dec, chapters: { ...(dec.chapters ?? {}), [ch.key]: cur } };
}
/** Move a chapter one step. Highlights never moves and nothing moves above it. */
export function moveChapter(order: ChapterKind[], key: ChapterKind, dir: -1 | 1): ChapterKind[] {
  const list: ChapterKind[] = order.filter((k) => k !== "highlights");
  const i = list.indexOf(key);
  const j = i + dir;
  if (key === "highlights" || i < 0 || j < 0 || j >= list.length) return order.filter((k) => k !== "highlights");
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
export function canMove(chapters: Pick<DraftChapter, "key">[], key: ChapterKind, dir: -1 | 1): boolean {
  if (key === "highlights") return false;
  const list = chapters.map((c) => c.key).filter((k) => k !== "highlights");
  const j = list.indexOf(key) + dir;
  return list.includes(key) && j >= 0 && j < list.length;
}

/** The state she sees for an item: her unsaved choice wins over the server's last answer. */
export function shownState(item: DraftItem, dec: DraftDecisions | null): DraftItem["state"] {
  return dec?.items?.[item.key]?.state ?? item.state;
}

// ─── the review screen's words ──────────────────────────────────────────────────────────────────────────────────

export const SOURCE_COPY: Record<BasisLabel, { chip: string; a11y: string }> = {
  said: { chip: "Said", a11y: "Source: you said this" },
  found: { chip: "Found", a11y: "Source: Nomila found this" },
  made: { chip: "Made", a11y: "Source: Nomila wrote this from your record" },
  proof: { chip: "Proof", a11y: "Source: a signed deal proves this" },
};

export const KIND_LABEL: Record<ItemKind, string> = {
  identity_line: "Identity line", quote: "Quote", affiliation: "Affiliation", stat: "Stat", beat: "Story beat",
  proof_point: "Career highlight", venture: "Venture", partner: "Partner", cause: "Cause", value: "Value",
  media: "Photo or video", pick: "Pick", offer: "Offer",
};

/** 12400 → "12.4K" (the page's own compact number). */
export function compactNumber(n: number): string {
  const f = (x: number, unit: string) => `${(Math.round(x * 10) / 10).toString()}${unit}`;
  if (Math.abs(n) >= 1_000_000) return f(n / 1_000_000, "M");
  if (Math.abs(n) >= 1_000) return f(n / 1_000, "K");
  return String(Math.round(n));
}
/** 4500, "usd" → "$45"; 4550 → "$45.50". */
export function money(minor: number, currency: string | null | undefined = "usd"): string {
  const c = (currency ?? "usd").toUpperCase();
  const amount = minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
  return c === "USD" ? `$${amount}` : `${amount} ${c}`;
}
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sinceLine = (ym: string | null | undefined) => {
  const m = ym?.match(/^(\d{4})-(\d{2})/);
  return m ? `since ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
};

/** The words of one item as she reviews it (the public words, verbatim), and a detail line under it. */
export function itemLine(i: PublicItem): { text: string; detail: string | null } {
  switch (i.kind) {
    case "stat": return { text: `${i.label ?? "Stat"}: ${i.value != null ? compactNumber(i.value) : "—"}`, detail: null };
    case "media": return { text: i.mediaType === "video" ? "Video" : "Photo", detail: "From your media library" };
    case "partner": return { text: i.text ?? "Partner", detail: sinceLine(i.since) ? cap(sinceLine(i.since)) : null };
    case "beat": return { text: i.text ?? "", detail: i.label ? cap(i.label) : null };
    case "offer": {
      const parts = [i.durationMinutes ? `${i.durationMinutes} min` : null, i.totalCents != null ? `${money(i.totalCents, i.currency)} all-in` : null].filter(Boolean);
      return { text: i.text ?? "Offer", detail: parts.length ? parts.join(" · ") : null };
    }
    case "pick": return { text: i.text ?? "Pick", detail: [i.merchant, i.priceCents != null ? money(i.priceCents, i.currency) : null].filter(Boolean).join(" · ") || null };
    default: return { text: i.text ?? "", detail: i.label ?? null };
  }
}

/** Why an item is (or is not) on the page if she publishes now. */
export function itemNote(i: DraftItem, state: DraftItem["state"] = i.state): string {
  if (state === "hidden") return "Hidden. It won't show on your card.";
  const block: ItemBlock | null = i.blockedBy === "hidden" ? null : i.blockedBy;
  if (block === "needs_approval") {
    if (i.basis === "made" && i.state === "approved") return "The wording changed since you approved it. Approve this version to show it.";
    if (i.basis === "made") return "Nomila wrote this. Approve this exact wording to show it.";
    return "Approve to show this.";
  }
  if (block === "needs_confirmation") return "Nomila found this. Approve to confirm it's right.";
  if (block === "over_limit") return "Not shown: this chapter already shows as many of these as it can.";
  return "Shows when you publish.";
}
/** Whether an item can still take "Approve" (it is not already approved and showing). */
export const canApprove = (i: DraftItem, state: DraftItem["state"]) => state !== "approved" || i.blockedBy === "needs_approval";
export const canHide = (state: DraftItem["state"]) => state !== "hidden";

/** The chapter's line: hidden, short of its minimum, or showing. */
export function chapterNote(ch: DraftChapter, hidden: boolean = ch.hidden): string {
  if (ch.key !== "highlights" && hidden) return "Hidden. This chapter won't show.";
  if (ch.key === "highlights") return "Always first on your card.";
  if (!ch.meetsMinimum) {
    const counted = ch.items.filter((i) => i.publishable && (ch.key !== "impact" || i.kind === "cause")).length;
    const what = ch.key === "impact" ? (ch.minimum === 1 ? "cause" : "causes") : ch.minimum === 1 ? "item" : "items";
    return `Shows once ${ch.minimum} ${what} ${ch.minimum === 1 ? "is" : "are"} approved (${counted} so far).`;
  }
  return "Shows when you publish.";
}

export const CUT_COPY: Record<CutItem["reason"], string> = {
  no_basis: "Nomila couldn't point to where it came from, so it was left out.",
  guardrail: "It touched one of your guardrails.",
  voice_avoid: "It used words you asked Nomila to avoid.",
  denied: "It rests on something you said isn't right.",
  unresolved: "It rests on something still open in What Nomila Knows.",
  contact_details: "It was only contact details, and those never go on your public page.",
};
export const cutLine = (c: CutItem) => ({ title: KIND_LABEL[c.kind] ?? "Item", why: CUT_COPY[c.reason] ?? "Left out." });

// ─── switches ───────────────────────────────────────────────────────────────────────────────────────────────────

export type DoorSwitch = "partner" | "book" | "shop" | "create" | "askMila";

export const DOOR_COPY: Record<DoorSwitch, { title: string; meta: string }> = {
  partner: { title: "Partner", meta: "Brands and press send you a request" },
  book: { title: "Book", meta: "Fans book your offers" },
  shop: { title: "Shop", meta: "Your picks, with your links" },
  create: { title: "Create", meta: "Shows as \"Coming soon\" for now" },
  askMila: { title: "Ask Mila", meta: "Mila answers from your published card" },
};
export const DOOR_ORDER: DoorSwitch[] = ["partner", "book", "shop", "create", "askMila"];

/** Why Book or Shop cannot work yet, from the draft's availability; null when it can. */
export function doorUnavailable(door: DoorSwitch, availability: PublicCardDraftResponse["availability"]): string | null {
  if (door === "book" && !availability.book) return "Not available yet: Book needs a published offer and payouts set up.";
  if (door === "shop" && !availability.shop) return "Not available yet: Shop needs at least one live pick in My Picks.";
  return null;
}

export const SETTINGS_COPY = {
  title: "Card settings",
  parent: "Your public card",
  doors: "Doors on your card",
  doorsLive: "Turning a door off takes it off your live card at once. Turning one on shows after you publish again.",
  doorsDraft: "Your choices show when you publish.",
  privacy: "What shows",
  mia: "Show M.I.A. on my card",
  miaMeta: "Your published M.I.A. number and its level. Nothing else from My Intelligence.",
  search: "Let search engines find my card",
  searchMeta: "Off: search engines are asked not to list your card. Anyone with your link can still open it.",
  socials: "Social links",
  socialsSoon: "Coming soon: choosing which social profiles show on your card. Today every connected profile shows.",
  socialsNone: "No connected social profiles yet.",
  link: "Your link",
  offline: "Take your card offline",
  offlineMeta: "Your link stops opening at once. Your draft and choices stay.",
  removed: "Removed from your live card.",
  nextPublish: "Shows after you publish again.",
} as const;

export const SWITCH_LABEL: Record<keyof PublicCardSwitches, string> = {
  partner: "Partner", book: "Book", shop: "Shop", create: "Create", askMila: "Ask Mila",
  showMia: SETTINGS_COPY.mia, indexable: SETTINGS_COPY.search,
};

// ─── her handle ─────────────────────────────────────────────────────────────────────────────────────────────────

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;
const HANDLE_SHAPE = /^[a-z0-9](-?[a-z0-9])+$/;

export const HANDLE_COPY = {
  rule: "3–30 letters, numbers and single hyphens.",
  invalid: "A link is 3–30 letters, numbers and single hyphens.",
  reserved: "That link is reserved by Nomila. Try another.",
  taken: "That link is taken. Try another.",
  tooSoon: (day: string) => `You can change your link once a month. Next change: ${day}.`,
  waitUntil: (day: string) => `You can change your link again on ${day}.`,
  monthly: "You can change it once a month. Your old link keeps working for 90 days.",
  first: "Pick your link. If you don't, Nomila suggests one from your name when you publish.",
  saved: "Saved.",
  save: "Save link",
} as const;

/** Lower-case and trim, as the server compares it. */
export const normalizeHandle = (raw: string) => raw.trim().toLowerCase();

/** The shape rule, before asking the server (the reserved list and who holds a handle are the server's to say). */
export function handleProblem(raw: string): string | null {
  const h = normalizeHandle(raw);
  if (h.length < HANDLE_MIN || h.length > HANDLE_MAX || !HANDLE_SHAPE.test(h)) return HANDLE_COPY.invalid;
  return null;
}

/** A refused PUT /handle, in her words (422 invalid, 409 reserved / taken, 429 too_soon with the date). */
export function handleErrorLine(p: PublicCardProblem): string {
  if (p.code === "invalid") return HANDLE_COPY.invalid;
  if (p.code === "reserved") return HANDLE_COPY.reserved;
  if (p.code === "taken") return HANDLE_COPY.taken;
  if (p.code === "too_soon") {
    const day = dayLine(p.nextChangeAt);
    return day ? HANDLE_COPY.tooSoon(day) : "You can change your link once a month.";
  }
  return problemLine(p, ERROR_COPY.save);
}

// ─── publish ────────────────────────────────────────────────────────────────────────────────────────────────────

export const PUBLISH_COPY = {
  title: "Publish your card",
  lede: "Everything below goes public at your link the moment you tap Publish. You can take it offline any time.",
  republish: "Your live card switches to this version the moment you tap Publish.",
  publish: "Publish",
  cancel: "Not now",
  doneTitle: "Your card is live",
  done: "Done",
  share: "Share link",
  needsHandle: "Pick your link before publishing.",
  pickHandle: "Pick your link",
  offlineTitle: "Take your card offline?",
  offlineLede: "Your link stops opening for everyone at once, and the published versions are deleted. Your draft and your choices stay, so you can publish again later.",
  offlineConfirm: "Take offline",
  offlineDone: "Your card is offline.",
} as const;

/** A refused publish, in her words: the server's 422 sentence is already hers ("Add a chapter or turn on a door …"). */
export function publishErrorLine(p: PublicCardProblem): string {
  if (p.code === "needs_handle") return PUBLISH_COPY.needsHandle;
  if (p.status === 422 && p.error) return p.error.replace(/^The draft cannot be published: /, "This draft can't be published yet: ");
  return problemLine(p, "Publishing didn't go through. Nothing changed on your card. Try again.");
}

/** The summary she confirms: chapter titles and doors that will be live. */
export function publishSummary(content: PublicCardContent): { chapters: string[]; doors: string[] } {
  const names: Record<keyof PublicCardContent["doors"], string> = { partner: "Partner", book: "Book", shop: "Shop", create: "Create", ask_mila: "Ask Mila" };
  return {
    chapters: content.chapters.map((c) => c.title),
    doors: (Object.keys(names) as (keyof typeof names)[]).filter((k) => content.doors[k]).map((k) => names[k]),
  };
}

// ─── the visitor's page (mirrors server/services/publicCard/snapshotAdapter.ts + render.ts) ───────────────────────

export type PageItem =
  | { type: "stat"; label: string; value: string; asOf?: string }
  | { type: "beat"; label: string; text: string }
  | { type: "partner"; name: string; since?: string }
  | { type: "fact"; text: string; detail?: string }
  | { type: "media"; kind: "image" | "video"; mediaKey: string };

export interface PageCard {
  key: ChapterKind;
  title: string;
  headline: string;
  eyebrow?: string;
  items: PageItem[];
}

export interface PageModel {
  firstName: string;
  lastName: string;
  verified: boolean;
  identityLine?: string;
  quote?: string;
  cards: PageCard[];
  tiles: PublicGridTile[];
  socials: PublicCardContent["socials"];
}

const asOfLine = (iso: string | null | undefined) => {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `as of ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : undefined;
};

const EYEBROW: Partial<Record<ChapterKind, (first: string) => string>> = {
  partnerships: () => "Signed partnerships",
  competition: () => "Career highlights",
  impact: (first) => `What ${first} stands for`,
  media: () => "Photos & videos",
};

function pageItem(it: PublicItem): PageItem | null {
  switch (it.kind) {
    case "stat": return it.value == null ? null : { type: "stat", label: it.label ?? "", value: compactNumber(it.value), ...(asOfLine(it.asOf) ? { asOf: asOfLine(it.asOf) } : {}) };
    case "beat": return it.text ? { type: "beat", label: cap(it.label ?? ""), text: it.text } : null;
    case "partner": return it.text ? { type: "partner", name: it.text, ...(sinceLine(it.since) ? { since: sinceLine(it.since) } : {}) } : null;
    case "media": return it.mediaKey ? { type: "media", kind: it.mediaType === "video" ? "video" : "image", mediaKey: it.mediaKey } : null;
    case "affiliation": case "proof_point": case "cause": case "value": case "venture":
      return it.text ? { type: "fact", text: it.text, ...(it.label ? { detail: it.label } : {}) } : null;
    default: return null; // identity_line and quote sit on the Highlights header; offers and picks are doors, not items
  }
}

/** The page caps per card, as render.ts draws them. */
const PAGE_CAPS: Record<PageItem["type"], number> = { stat: 3, beat: 4, partner: 4, fact: 4, media: 6 };

export function pageModel(c: PublicCardContent): PageModel {
  const highlights = c.chapters.find((ch) => ch.key === "highlights");
  const identityLine = highlights?.items.find((i) => i.kind === "identity_line")?.text ?? undefined;
  const quote = highlights?.items.find((i) => i.kind === "quote")?.text ?? undefined;
  const cards: PageCard[] = c.chapters.map((ch) => {
    const all = ch.items.map(pageItem).filter((x): x is PageItem => !!x);
    const seen: Partial<Record<PageItem["type"], number>> = {};
    const items = all.filter((i) => { seen[i.type] = (seen[i.type] ?? 0) + 1; return seen[i.type]! <= PAGE_CAPS[i.type]; });
    return {
      key: ch.key, title: ch.title,
      headline: ch.key === "highlights" ? c.displayName : ch.title,
      ...(EYEBROW[ch.key] ? { eyebrow: EYEBROW[ch.key]!(c.firstName) } : {}),
      items,
    };
  });
  return {
    firstName: c.firstName, lastName: c.lastName, verified: c.verified,
    ...(identityLine ? { identityLine } : {}), ...(quote ? { quote } : {}),
    cards, tiles: c.tiles, socials: c.socials,
  };
}

/** What a door does for a visitor on the live page (the preview explains instead of opening it). */
export function tileExplainer(intent: PublicGridTile["intent"], first: string): string {
  switch (intent) {
    case "partner": return `On your live card, Partner opens a chat with Mila where a brand or the press sends ${first} a request. Nothing is agreed without you.`;
    case "book": return `On your live card, Book shows your offers with all-in prices and lets a visitor request a time.`;
    case "shop": return `On your live card, Shop opens your picks. Every tile says "Paid link".`;
    case "create": return `On your live card, Create says "Create with ${first} is coming soon". Nothing is collected.`;
    case "follow": return `On your live card, this opens your connected social profiles.`;
    case "ask": return `On your live card, Mila answers questions about ${first} from your published card only.`;
    default: return `On your live card, this opens the ${intent} chapter.`;
  }
}
