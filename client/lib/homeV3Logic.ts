// Home v3 — what Home shows and what Mila says about it (EXPO_PUBLIC_HOME_V3; UX flow v3 "one thing, one place",
// 19 Oct 2026). Pure: no React, no fetch, no storage. The screen (screens/home/HomeV3Screen.tsx) feeds it the reads it
// already has and draws what comes back. Four pieces, each item in exactly one place:
//
//   circles     This week (her pending plan posts with a built kit, this week) · Offers (deals and bookings waiting on
//               her) · Moments (dated moments, next 60 days) — always shown — and Wins (a deal signed or agreed in the
//               last 7 days, the learning loop's exceptional post, or a brand paying her), only when there is one. A coloured ring = an
//               item she has not seen; grey = all seen. A badge = how many need her (This week, Offers; Moments: soon with nothing prepared).
//   Mila's line ONE sentence, from the same items, about the single most urgent one: an overdue offer reply > posts ready
//               > Mila's open suggestion > offers waiting > "All caught up" + the next moment. It names only what is on
//               the screen (milaLine's `ref` says which item; the tests pin it to the shown items).
//   admin row   at most ONE blocking item (a contract to confirm, payouts while money is owed, a broken connection) and
//               "+N more", opening the checklist ("Things to sort · x of y done"); nice-to-have setup counts on the
//               avatar's badge (the avatar opens Me) and lives in Me → Get set up; all done, there is no checklist.
//   big card    the first This week post; with none, the next moment.
//
// Every word is a template around a stored name, title, label, date or count: nothing here invents a sentence about her,
// and nothing names an athlete, sport, school or brand.

import type { AgentGoalsResponse, AgentWinPayment, AgentWinPost, ComingUpItem, GoalActionView, MomentCategory, MomentView } from "../../shared/plan";
import type { NextCandidate } from "../../shared/meSummaries";
import type { BookingListItemView } from "./bookingsTypes";
import type { BoardItem, OpportunityBoard } from "../hooks/use-opportunity-board";
import type { Deliverable, TermSheet } from "../../shared/deals";
import { eventDateWords } from "./agent/goalsLogic";
import { money } from "./whatMattersNext";
import { cardLogo } from "../components/opps/oppBoardLogic";

// ── targets ──────────────────────────────────────────────────────────────────

/** Where a tap goes. The screen maps each to a navigate (or the chat sheet); nothing here acts. */
export type HomeTarget =
  | { screen: "post_kit"; id: string }
  | { screen: "opportunity"; opportunityId: string; dealId: string | null }
  | { screen: "booking"; bookingId: string }
  | { screen: "mila"; draft?: string; conversationId?: string }
  | { screen: "financials" }
  | { screen: "settings" }
  | { screen: "push" };

export type CircleKey = "week" | "offers" | "bookings" | "moments" | "wins";

/** One story: one item, one action. */
export interface StoryItem {
  /** Stable id: what "seen" is keyed on ("week:<action id>", "offer:<opportunity id>" …). */
  id: string;
  circle: CircleKey;
  /** The short eyebrow ("Wed · Reel", "Waiting 5 days", "Sat 7 Nov"). */
  kicker: string;
  title: string;
  line: string | null;
  action: { label: string; target: HomeTarget };
  /** The brand's logo (Offers, a deal win) — the SAME source the Opportunities cards read (oppBoardLogic cardLogo);
   * the photo is resolved by the screen (a kit's first asset). */
  logoUrl?: string | null;
  /** The brand's own domain: the favicon fallback when the stored logo fails (as on the Opportunities cards). */
  logoDomain?: string | null;
  /** The agency or platform it came through ("via {Agency}"), as the Opportunities card shows it. */
  via?: string | null;
  brandName?: string | null;
  /** A post action's id, so the screen can read its kit's first picture. */
  kitActionId?: string | null;
  /** A moment's date as a calendar face (the circle and its story draw it when there is no picture). */
  dateFace?: DateFace | null;
  /** An offer drawn as a poster: the money (or the ask) large, the brand's short name as texture. */
  poster?: OfferPoster | null;
  /** A moment the moments step chose: Mila's hook and angle, why now, and what kind of moment it is. */
  moment?: MomentStoryDetail | null;
  /** A moment that needs her: soon (MOMENT_BADGE_DAYS) and nothing prepared for it yet — what the Moments badge counts. */
  needsHer?: boolean;
  /** A brand paid her directly (a Win): who paid, as named — what "Say thanks" asks Mila to write to. */
  paidBy?: string | null;
  /** The brand's own colour (its logo's, deepened for white type): Home's hero card is drawn on it. Null: ink. */
  brandColor?: string | null;
  /** The brand's cover (only when its imagery is trusted, as on the Deals card): the offer's hero, story and circle. */
  coverUrl?: string | null;
}

export interface MomentStoryDetail {
  hook: string;
  angle: string | null;
  whyNow: string | null;
  /** The kind, in words ("Holiday", "In your sport"). */
  kind: string;
}

/** A date as a calendar page: the small top word (weekday, or the year for a month) over the big one (day, or month). */
export interface DateFace { top: string; big: string }

export interface OfferPoster {
  /** The brand's display name ("adidas", not "adidas America Inc."). */
  name: string;
  /** The stated fee, formatted ("$5,000"); null when none is stated. */
  amount: string | null;
  /** What they want, in words ("a Reel and a story"); null when the terms name no deliverable. */
  ask: string | null;
}

export interface Circle {
  key: CircleKey;
  label: string;
  items: StoryItem[];
  /** The "needs you" count (This week, Offers); null when the circle carries none. */
  badge: number | null;
  /** The ring's colour when something in it is new. */
  tone: "pink" | "gold";
}

export const HOME_V3_COPY = {
  circles: { week: "This week", offers: "Offers", bookings: "Bookings", moments: "Moments", wins: "Wins" } satisfies Record<CircleKey, string>,
  reviewPost: "Review & post",
  today: "Today",
  tomorrow: "Tomorrow",
  wants: (brand: string, ask: string) => `${brand} wants ${ask}`,
  makePost: "Make this post",
  makeAnother: "Make another like it",
  seeIt: "See it",
  notNow: "Not now",
  open: "Open",
  answer: "Answer",
  ofN: (i: number, n: number) => `${i} of ${n}`,
  forEvent: (label: string) => `For ${label}`,
  comingUp: (date: string) => `Coming up · ${date}`,
  empty: {
    week: { title: "No posts ready this week yet", line: "Mila prepares them from your plan.", action: "Ask Mila", draft: "What should I post this week?" },
    offers: { title: "Nothing waiting on you", line: "New offers from brands show here.", action: null, draft: null },
    bookings: { title: "No booking requests", line: "People booking your time show here.", action: null, draft: null },
    moments: { title: "No moments in the next two months", line: "Games, dates and causes show here when Mila finds them.", action: "Ask Mila", draft: "What's coming up that I could post about?" },
    wins: { title: "No wins this week", line: null, action: null, draft: null },
  } satisfies Record<CircleKey, { title: string; line: string | null; action: string | null; draft: string | null }>,
  checklist: {
    title: "Things to sort",
    progress: (done: number, total: number) => `${done} of ${total} done`,
    more: (n: number) => `+${n} more`,
  },
} as const;

// ── dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** Her local calendar day, YYYY-MM-DD. */
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (day: string, n: number): string => {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + n));
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekdayOf = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
};
const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const daysSince = (iso: string | null | undefined, now: Date): number | null => {
  const t = time(iso);
  return t == null ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
};

/** "Today", "Tomorrow", else the weekday ("Thu"). */
export function relativeDay(day: string, now: Date): string {
  const today = localDay(now);
  if (day === today) return HOME_V3_COPY.today;
  if (day === addDays(today, 1)) return HOME_V3_COPY.tomorrow;
  return weekdayOf(day);
}

const FORMAT_WORD: Record<string, string> = { reel: "Reel", carousel: "Carousel", story: "Story", feed: "Photo", photo: "Photo", image: "Photo", video: "Video" };
export const formatWord = (f: string | null | undefined): string | null => (f ? FORMAT_WORD[f] ?? f.charAt(0).toUpperCase() + f.slice(1) : null);

// ── This week ────────────────────────────────────────────────────────────────

/** This week runs from today through the next six days. */
export const WEEK_DAYS = 7;

const isPost = (a: GoalActionView) => a.kind === "post_kit" || a.planKind === "post";

/**
 * Her pending plan posts with a built kit, due this week (today … +6) or undated, soonest first: the goals she holds
 * and the recommended ones (a post is prepared before Keep). Posted (done) and past-due posts are out.
 */
export function weekPosts(goals: AgentGoalsResponse | null | undefined, now: Date): GoalActionView[] {
  if (!goals) return [];
  const today = localDay(now);
  const end = addDays(today, WEEK_DAYS - 1);
  const all = [...goals.goals.flatMap((g) => g.actions), ...goals.recommended.flatMap((r) => r.actions)];
  const seen = new Set<string>();
  const out: GoalActionView[] = [];
  for (const a of all) {
    if (seen.has(a.id) || !isPost(a) || a.state === "done" || !a.kit?.built) continue;
    if (a.dueOn && (a.dueOn < today || a.dueOn > end)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out.sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));
}

/** A leading chore verb on an action title ("Review your …", "Share a …"): the button already says what to do. */
const CHORE = /^(review|share|post|make|create|prepare|film|shoot|record|write|draft|publish|check)\s+(your|a|an|the|this)\s+/i;

/** The longest a post's own line may be and still serve as its title; a longer hook gives its first sentence. */
export const POST_TITLE_MAX = 90;

/**
 * What a This week post is called: the post itself (its hook, as the plan wrote it), never the chore. A long hook gives
 * its first sentence; with no hook, the action's title without a leading chore verb ("Review your captaincy portrait" →
 * "Captaincy portrait").
 */
export function postTitle(a: Pick<GoalActionView, "title" | "post">): string {
  const hook = (a.post?.hook ?? "").replace(/\s+/g, " ").trim();
  if (hook) {
    if (hook.length <= POST_TITLE_MAX) return hook;
    const first = hook.match(/^.+?[.!?](\s|$)/)?.[0]?.trim();
    if (first && first.length <= POST_TITLE_MAX) return first;
  }
  const t = a.title.trim();
  const bare = t.replace(CHORE, "");
  return bare && bare !== t ? bare.charAt(0).toUpperCase() + bare.slice(1) : t;
}

export function weekStory(a: GoalActionView, now: Date = new Date()): StoryItem {
  const kicker = [a.dueOn ? relativeDay(a.dueOn, now) : null, formatWord(a.post?.format ?? null)].filter(Boolean).join(" · ") || HOME_V3_COPY.circles.week;
  return {
    id: `week:${a.id}`,
    circle: "week",
    kicker,
    title: postTitle(a),
    line: a.event ? HOME_V3_COPY.forEvent(a.event.label) : null,
    action: { label: HOME_V3_COPY.reviewPost, target: { screen: "post_kit", id: a.id } },
    kitActionId: a.id,
  };
}

// ── Offers ───────────────────────────────────────────────────────────────────

/** A card whose next step is confirming a signature is paperwork: it belongs to the admin row, never to Offers. */
const isContractStep = (b: BoardItem) => b.next?.action === "confirm_signed";

/** A booking request "on a clock": past or within a day of its respond-by. */
export const BOOKING_URGENT_MS = DAY_MS;

export interface OfferStory extends StoryItem {
  /** Her reply is overdue (the board's own flag), or a booking's answer is due within a day. */
  overdue: boolean;
  /** Days she has had the move (deals); null when unknown. */
  waitingDays: number | null;
  /** When they last wrote, in words ("25 Sep"): the briefing card's quiet meta line, never a day count. */
  sentOn?: string | null;
  /** Who it is from, in a sentence (Mila's line names them this way). */
  who?: string;
  /** A deal's lead deal and thread: what "Not for me" closes (the Opportunities detail's own sheet). */
  dealId?: string | null;
  threadId?: string | null;
}

// Legal and regional tails a sender's company name carries ("adidas America Inc.", "Acme Holdings, LLC"): the display
// name drops them. A regional word goes only at the very end and never after "of" ("Bank of America" stays).
const LEGAL_TAIL = /[,\s]+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|ag|plc|bv|b\.v|nv|sa|s\.a|sas|srl|pty|pte|holdings?)\.?$/i;
const REGION_TAIL = /\s+(america|usa|us|u\.s\.a?|north america|europe|emea|uk|canada|international|intl|global|worldwide)\.?$/i;

/** A company's display name: its legal and regional tails dropped; the name itself when nothing would be left. */
export function displayBrandName(name: string): string {
  const original = name.replace(/\s+/g, " ").trim();
  let n = original;
  for (let i = 0; i < 4; i++) {
    const legal = n.replace(LEGAL_TAIL, "").trim();
    const region = /\bof\s+\S+$/i.test(legal) ? legal : legal.replace(REGION_TAIL, "").trim();
    if (!region || region === n) break;
    n = region;
  }
  return n.replace(/[,\s]+$/, "") || original;
}

// What a deliverable is called in a sentence ("a Reel and a story"): short words, the plural with a count.
const ASK_WORD: Partial<Record<Deliverable, [string, string]>> = {
  ig_post: ["post", "posts"], ig_carousel: ["carousel", "carousels"], ig_reel: ["Reel", "Reels"], ig_story: ["story", "stories"],
  ig_live: ["Live", "Lives"], tiktok_video: ["TikTok", "TikToks"], tiktok_live: ["TikTok Live", "TikTok Lives"],
  yt_short: ["Short", "Shorts"], yt_video: ["YouTube video", "YouTube videos"], x_post: ["X post", "X posts"],
  threads_post: ["Threads post", "Threads posts"], ugc: ["piece of content", "pieces of content"], paid_ad_asset: ["ad", "ads"],
  appearance_hour: ["appearance", "appearances"], virtual_appearance: ["virtual appearance", "virtual appearances"],
  camp_clinic: ["camp", "camps"], speaking: ["talk", "talks"], interview: ["interview", "interviews"],
  podcast_episode: ["podcast", "podcasts"], autograph_session: ["signing", "signings"],
};
const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");

/** The term sheet's deliverables in words ("a Reel and 2 stories"); null when it names none. At most three. */
export function askWords(terms: Pick<TermSheet, "deliverables"> | null | undefined): string | null {
  const parts = (terms?.deliverables ?? []).slice(0, 3).map((d) => {
    const plain = d.kind.replace(/_/g, " ");
    const [one, many] = ASK_WORD[d.kind] ?? [plain, `${plain}s`];
    const n = d.count && d.count > 1 ? d.count : 1;
    return n > 1 ? `${n} ${many}` : `${article(one)} ${one}`;
  });
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The ask in the board's own words, read off its line ("… · Their ask: Collaborate on day-in-the-life video · …", the
 * server's opportunityNext wording): for a poster when the terms name no deliverable. Null when the line has none.
 */
export function askFromLine(line: string | null | undefined): string | null {
  const m = /Their ask:\s*([^·]+)/i.exec(line ?? "");
  const t = m?.[1]?.trim().replace(/[.\s]+$/, "") ?? "";
  if (!t) return null;
  return t.length > 60 ? `${t.slice(0, 59).replace(/\s+\S*$/, "")}…` : t;
}

/** A stated fee, whole units ("$5,000"); null when none. */
export function feeWords(terms: Pick<TermSheet, "fee"> | null | undefined): string | null {
  const a = terms?.fee?.amount;
  if (a == null || !(a > 0)) return null;
  const cur = (terms?.fee?.currency ?? "usd").toUpperCase();
  const n = String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cur === "USD" ? `$${n}` : `${n} ${cur}`;
}

// Free mail domains say nothing about who someone works for.
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|zoho)\./i;

/**
 * Who an offer is from, in a sentence: a brand by its display name; a person (no brand confirmed) with where they
 * write from when their domain says it ("Sam Lee at acme.com").
 */
export function offerWho(b: Pick<BoardItem, "brand">): string {
  const name = displayBrandName(b.brand.name);
  const domain = (b.brand.domain ?? "").replace(/^www\./i, "").trim();
  if (b.brand.is_person && domain && !FREE_MAIL.test(domain)) return `${name} at ${domain}`;
  return name;
}

export function offerStories(board: OpportunityBoard | null | undefined, bookings: ReadonlyArray<BookingListItemView> | null | undefined, now: Date): OfferStory[] {
  const out: OfferStory[] = [];
  const ids = new Set<string>();
  for (const b of board?.needsYou ?? []) {
    if (isContractStep(b) || ids.has(b.opportunity_id)) continue;
    ids.add(b.opportunity_id);
    const days = daysSince(b.her_move_since, now);
    const name = displayBrandName(b.brand.name);
    const ask = askWords(b.terms);
    const who = offerWho(b);
    out.push({
      id: `offer:${b.opportunity_id}`,
      circle: "offers",
      kicker: days != null && days > 0 ? `Waiting ${days} day${days === 1 ? "" : "s"}` : "Needs you",
      title: ask ? HOME_V3_COPY.wants(name, ask) : who,
      line: b.line || null,
      action: { label: b.next?.label || HOME_V3_COPY.open, target: { screen: "opportunity", opportunityId: b.opportunity_id, dealId: b.lead_deal_id } },
      logoUrl: cardLogo(b)?.logoUrl ?? null,
      logoDomain: cardLogo(b)?.domain ?? null,
      via: b.via ?? null,
      brandName: name,
      poster: { name, amount: feeWords(b.terms), ask: ask ?? askFromLine(b.line) },
      who,
      dealId: b.lead_deal_id,
      threadId: b.lead_thread_id,
      overdue: !!b.overdue,
      waitingDays: days,
      sentOn: dayMonth(b.her_move_since),
      brandColor: b.brand.color ?? null,
      coverUrl: b.brand.image_url ?? null,
    });
  }
  for (const r of bookings ?? []) {
    if (r.phase !== "request" || ids.has(r.id)) continue;
    ids.add(r.id);
    const due = time(r.respondBy);
    out.push({
      id: `booking:${r.id}`,
      circle: "bookings",
      kicker: `Booking · ${r.buyerLabel}`,
      title: r.title,
      line: r.receiveCents ? `${money(r.receiveCents)} to you` : null,
      action: { label: HOME_V3_COPY.answer, target: { screen: "booking", bookingId: r.id } },
      overdue: due != null && due - now.getTime() <= BOOKING_URGENT_MS,
      waitingDays: null,
    });
  }
  // One order for the circle and Mila's line: what is overdue first (in the board's order), then the rest. So the item
  // Mila names is always Offers 1 of N.
  return [...out.filter((o) => o.overdue), ...out.filter((o) => !o.overdue)];
}

// ── Moments ──────────────────────────────────────────────────────────────────

/** The moments window: the server's comingUp is already the next 60 days; this guards an older read. */
export const MOMENT_DAYS = 60;
/** How soon a moment with nothing prepared counts on the Moments badge (further out it waits quietly in the circle). */
export const MOMENT_BADGE_DAYS = 14;

export function momentStories(goals: AgentGoalsResponse | null | undefined, now: Date): StoryItem[] {
  // The server already sends the next 60 days, soonest first (a month-only date is the 1st, so it is never cut at the
  // front here); only the far end is guarded. The moments the moments step chose come first (every kind: games, league
  // dates, holidays, culture); a server without them, or before the first scan, falls back to dated events.
  const end = addDays(localDay(now), MOMENT_DAYS);
  const soon = addDays(localDay(now), MOMENT_BADGE_DAYS);
  const flag = (date: string) => (s: StoryItem): StoryItem => ({ ...s, needsHer: !s.kitActionId && date <= soon });
  if (goals?.moments?.length) return goals.moments.filter((m) => m.date <= end).map((m) => flag(m.date)(momentViewStory(m)));
  return (goals?.comingUp ?? []).filter((m) => m.date <= end).map((m) => flag(m.date)(momentStory(m)));
}

/** A moment's kind, in words. */
export const MOMENT_KIND_WORDS: Record<MomentCategory, string> = {
  schedule: "On your calendar",
  league: "In your sport",
  holiday_awareness: "Holiday",
  cultural_trend: "Culture",
  partner_campaign: "Partner",
};

const readyLine = (n: number): string | null => (n > 1 ? `${n} posts ready` : n === 1 ? "Post ready" : null);

/** A moment the moments step chose: its name, its date as a face, Mila's hook and angle, why now. */
export function momentViewStory(m: MomentView): StoryItem {
  const kit = m.kitActionId ?? null;
  return {
    id: `moment:${m.factId}`,
    circle: "moments",
    kicker: eventDateWords(m.date, m.precision),
    title: m.name,
    line: readyLine(m.actionsReady) ?? (m.whyNow || null),
    action: kit
      ? { label: HOME_V3_COPY.reviewPost, target: { screen: "post_kit", id: kit } }
      : { label: HOME_V3_COPY.makePost, target: { screen: "mila", draft: momentAsk({ label: m.name, date: m.date, precision: m.precision }) } },
    kitActionId: kit,
    dateFace: dateFace(m),
    moment: { hook: m.hook, angle: m.angle, whyNow: m.whyNow || null, kind: MOMENT_KIND_WORDS[m.category] ?? MOMENT_KIND_WORDS.schedule },
  };
}

/** A moment's kind as its category key (the words back to the key), for its card's colours and glyph. */
export function momentCategoryOf(story: Pick<StoryItem, "moment">): MomentCategory {
  const words = story.moment?.kind;
  const hit = (Object.keys(MOMENT_KIND_WORDS) as MomentCategory[]).find((k) => MOMENT_KIND_WORDS[k] === words);
  return hit ?? "schedule";
}

/** The atmosphere picker's screen for moment pictures (Home and Studio share it, so a moment shows the same picture). */
export const MOMENT_ATMOSPHERE_SCREEN = "moments";
const ATMOSPHERE_MAX_SLOTS = 12;

/**
 * One atmosphere slot per moment with nothing prepared (a prepared one shows its post's photo): no people, the slot's
 * purpose is the moment's kind and name, why-now as context. The picker keeps a slot's picture once chosen.
 */
export function momentAtmosphereSlots(stories: ReadonlyArray<StoryItem>): Array<{ key: string; type: "suggestion"; purpose: string; context: string | null; category: string }> {
  return stories
    .filter((s) => s.circle === "moments" && !s.kitActionId && /^[A-Za-z0-9:_.\-]{1,120}$/.test(s.id))
    .slice(0, ATMOSPHERE_MAX_SLOTS)
    .map((s) => ({
      key: s.id,
      type: "suggestion" as const,
      purpose: `${s.moment?.kind ?? MOMENT_KIND_WORDS.schedule}: ${s.title}`.slice(0, 200),
      context: s.moment?.whyNow ? s.moment.whyNow.slice(0, 300) : null,
      category: momentCategoryOf(s),
    }));
}

/** The ask Mila is handed for a moment with nothing prepared yet (a draft: she sends it, or edits it). */
export const momentAsk = (m: Pick<ComingUpItem, "label" | "date" | "precision">): string =>
  `Help me make a post for ${m.label} (${eventDateWords(m.date, m.precision)}).`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "25 Sep" from an ISO time; null when there is none. */
function dayMonth(iso: string | null | undefined): string | null {
  const t = time(iso);
  if (t == null) return null;
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** A moment's date as a calendar page: weekday over the day ("SAT" / "24"); a month-only date, its year over the month. */
export function dateFace(m: Pick<ComingUpItem, "date" | "precision">): DateFace | null {
  const [y, mo, d] = m.date.split("-").map(Number);
  if (!y || !mo) return null;
  if (m.precision === "year") return { top: "", big: String(y) };
  if (m.precision === "month" || !d) return { top: String(y), big: MONTHS[mo - 1] };
  return { top: weekdayOf(m.date).toUpperCase(), big: String(d) };
}

export function momentStory(m: ComingUpItem): StoryItem {
  // A post already prepared for it opens that kit; otherwise Mila is asked (a draft) to prepare one.
  const kit = m.kitActionId ?? null;
  return {
    id: `moment:${m.factId}`,
    circle: "moments",
    kicker: eventDateWords(m.date, m.precision),
    title: m.label,
    line: readyLine(m.actionsReady),
    action: kit
      ? { label: HOME_V3_COPY.reviewPost, target: { screen: "post_kit", id: kit } }
      : { label: HOME_V3_COPY.makePost, target: { screen: "mila", draft: momentAsk(m) } },
    kitActionId: kit,
    dateFace: dateFace(m),
  };
}

// ── Wins ─────────────────────────────────────────────────────────────────────

export const WIN_DAYS = 7;
const WIN_STAGES = new Set(["Signed", "Agreed"]);

/** Every board card once (a card can sit in more than one list). */
function boardCards(board: OpportunityBoard | null | undefined): BoardItem[] {
  if (!board) return [];
  const lists = [board.needsYou, board.whatMatters, board.inMotion, board.needsTermsBatch, board.goingQuiet, board.explore, board.toVerify, board.seriousOffers];
  const byId = new Map<string, BoardItem>();
  for (const l of lists) for (const b of l ?? []) if (!byId.has(b.opportunity_id)) byId.set(b.opportunity_id, b);
  return [...byId.values()];
}

/**
 * Wins: a deal the board reads as Signed or Agreed whose last activity is in the last 7 days, the learning loop's
 * exceptional posts, and brands' direct payments to her (both GET /me/agent/wins, already the last 7 days). Newest first.
 */
export function winStories(
  board: OpportunityBoard | null | undefined,
  posts: ReadonlyArray<AgentWinPost> | null | undefined,
  now: Date,
  payments: ReadonlyArray<AgentWinPayment> | null | undefined = null,
): StoryItem[] {
  const since = now.getTime() - WIN_DAYS * DAY_MS;
  const deals = boardCards(board)
    .filter((b) => b.stage && WIN_STAGES.has(b.stage))
    .map((b) => ({ b, at: time(b.last_activity_at) }))
    .filter((x): x is { b: BoardItem; at: number } => x.at != null && x.at >= since && x.at <= now.getTime())
    .map(({ b, at }): { at: number; item: StoryItem } => ({
      at,
      item: {
        id: `win:deal:${b.opportunity_id}`,
        circle: "wins",
        kicker: "Win",
        title: b.stage === "Signed" ? `You signed with ${b.brand.name}` : `You agreed terms with ${b.brand.name}`,
        line: b.line || null,
        action: { label: HOME_V3_COPY.makeAnother, target: { screen: "mila", draft: `Help me find more deals like my ${b.brand.name} deal.` } },
        logoUrl: cardLogo(b)?.logoUrl ?? null,
        logoDomain: cardLogo(b)?.domain ?? null,
        brandName: b.brand.name,
      },
    }));
  const wins = (posts ?? []).map((p): { at: number; item: StoryItem } => {
    const what = (formatWord(p.format) ?? "post").toLowerCase();
    const times = `${Math.round(p.ratio * 10) / 10}×`;
    return {
      at: time(p.at) ?? 0,
      item: {
        id: `win:post:${p.id}`,
        circle: "wins",
        kicker: "Win",
        title: `Your ${what} is taking off`,
        line: `${times} your usual ${p.metric}`,
        action: { label: HOME_V3_COPY.makeAnother, target: { screen: "mila", draft: `Help me make another ${what} like the one that got ${times} my usual ${p.metric}.` } },
      },
    };
  });
  const paid = (payments ?? []).filter((p) => p.cents > 0).map((p): { at: number; item: StoryItem } => {
    const who = p.brand.trim() || "A brand";
    return {
      at: time(p.at) ?? 0,
      item: {
        id: `win:pay:${p.id}`,
        circle: "wins",
        kicker: "Paid",
        title: `${who} paid you ${money(p.cents, p.currency)}`,
        line: null,
        action: { label: HOME_V3_COPY.seeIt, target: { screen: "financials" } },
        brandName: p.brand.trim() || null,
        paidBy: p.brand.trim() || null,
      },
    };
  });
  return [...deals, ...wins, ...paid].sort((a, b) => b.at - a.at).map((x) => x.item);
}

// ── circles ──────────────────────────────────────────────────────────────────

/**
 * The circles, in order: This week · Offers · Bookings (only when a request waits) · Moments · Wins (only when there is
 * one). `offers` may carry booking requests (offerStories keeps them in its one urgency order for Mila); a booking
 * story (circle "bookings") gets its own circle — a brand deal and someone booking her time are different decisions.
 */
export function buildCircles(parts: { week: StoryItem[]; offers: StoryItem[]; moments: StoryItem[]; wins: StoryItem[] }): Circle[] {
  const c = HOME_V3_COPY.circles;
  const offers = parts.offers.filter((o) => o.circle !== "bookings");
  const bookings = parts.offers.filter((o) => o.circle === "bookings");
  const circles: Circle[] = [
    { key: "week", label: c.week, items: parts.week, badge: parts.week.length || null, tone: "pink" },
    { key: "offers", label: c.offers, items: offers, badge: offers.length || null, tone: "pink" },
  ];
  if (bookings.length) circles.push({ key: "bookings", label: c.bookings, items: bookings, badge: bookings.length, tone: "pink" });
  circles.push({ key: "moments", label: c.moments, items: parts.moments, badge: parts.moments.filter((m) => m.needsHer).length || null, tone: "pink" });
  if (parts.wins.length) circles.push({ key: "wins", label: c.wins, items: parts.wins, badge: null, tone: "gold" });
  return circles;
}

/** The ring: the circle's colour while any item in it is unseen; grey once all are seen, or when it is empty. */
export function ringState(circle: Pick<Circle, "items" | "tone"> & { badge?: number | null }, seen: ReadonlySet<string>): "pink" | "gold" | "seen" {
  // Coloured while anything in it is unseen, or while anything still needs her (a badge): seen-but-waiting is not done.
  return circle.items.some((i) => !seen.has(i.id)) || (circle.badge ?? 0) > 0 ? circle.tone : "seen";
}

/** Where a circle's story opens: its first unseen item, else its first. */
export function firstUnseenIndex(items: ReadonlyArray<Pick<StoryItem, "id">>, seen: ReadonlySet<string>): number {
  const i = items.findIndex((x) => !seen.has(x.id));
  return i < 0 ? 0 : i;
}

/** Seen ids with these added, kept only for items still live (so the stored list never grows without end). */
export function markSeen(seen: ReadonlySet<string>, ids: ReadonlyArray<string>, live?: ReadonlySet<string>): Set<string> {
  const next = new Set<string>([...seen, ...ids]);
  if (!live) return next;
  return new Set([...next].filter((id) => live.has(id)));
}

/** How many seen ids the phone keeps: the newest ones (an id seen long ago and gone from Home no longer matters). */
export const SEEN_MAX = 300;

/** The newest `max` ids, in the order they were seen. */
export function capSeen(seen: ReadonlySet<string>, max: number = SEEN_MAX): Set<string> {
  const all = [...seen];
  return new Set(all.length > max ? all.slice(all.length - max) : all);
}

/** Parse the stored list (AsyncStorage) — anything but an array of strings reads as nothing seen. */
export function parseSeen(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}

// ── Mila's suggestion ────────────────────────────────────────────────────────

/** Mila's suggestion candidate (GET /me/what-matters-next `mila_suggestion`), the first open one. */
export function suggestionOf(next: ReadonlyArray<NextCandidate> | null | undefined): NextCandidate | null {
  return (next ?? []).find((c) => c.kind === "mila_suggestion") ?? null;
}

/** Past this many days a reply she owes is a decision (reply, or let it go), not a reminder. */
export const STALE_REPLY_DAYS = 14;

// ── Mila's briefing (Home option C, 19 Oct 2026) ─────────────────────────────
//
// Home below the circles reads as Mila talking: at most BRIEFING_MAX messages, ONE sentence each, each carrying a visual
// card (the item itself) and two or three tap-to-answer chips. Priority: what needs her (offer replies, booking answers)
// > good news (a win) > a post ready > the next moment; a quiet day is one idea. The rest is "N more in your circles".
// Chips only open what the app already has (a screen, the Not-for-me sheet, Mila's chat with an ask); "Later" hides the
// item for today. Every sentence is a template around stored words — no model call, nothing about one athlete.

export type BriefKind = "offer" | "booking" | "win" | "post" | "moment" | "idea";

export const BRIEFING_MAX = 3;
/**
 * At most this many messages of one kind, so one busy circle cannot fill the whole briefing. Offers: ONE while anything
 * else has something to say (two reply-nags back to back read as a to-do list); two only when offers are all there is.
 */
export const BRIEFING_PER_KIND: Record<BriefKind, number> = { offer: 1, booking: 1, win: 1, post: 1, moment: 1, idea: 1 };
export const BRIEFING_OFFERS_ALONE = 2;

/** What a chip does. Nothing here acts: the screen maps each to an existing screen, sheet or chat. */
export type BriefAct =
  | { kind: "open"; target: HomeTarget }
  /** Mila's chat (the half-sheet) with this ask SENT for her — she still taps Send on anything that goes out. */
  | { kind: "ask"; prompt: string }
  /** Mila's chat with a draft in the composer (not sent) or a saved chat open (an open suggestion). */
  | { kind: "chat"; conversationId?: string; draft?: string }
  /** The Opportunities detail's own Not-for-me sheet (closes it; an optional polite no she sends herself). */
  | { kind: "not_for_me"; dealId: string; threadId: string | null; brandName: string }
  /** Hide this item from the briefing for the rest of today (on this phone). */
  | { kind: "later" };

export interface BriefChip { label: string; act: BriefAct; primary?: boolean }

/** The compact card under Mila's sentence: a small name line, the title (two lines at most), one quiet meta line. */
export interface BriefCardText { name: string | null; title: string; meta: string | null }

export interface BriefMessage {
  /** The item's story id ("offer:<id>") — what "Later" hides; "idea" for the quiet-day idea. */
  id: string;
  kind: BriefKind;
  text: string;
  /** What the card says. No day counts here — Mila's sentence already says how long (a count beside it read as a nag). */
  card: BriefCardText;
  /** The card's item (its photo, poster, date face or logo); null only for the quiet-day idea. */
  item: StoryItem | null;
  /** Tapping the card itself. */
  open: BriefAct;
  chips: BriefChip[];
}

export interface Briefing {
  messages: BriefMessage[];
  /** Items left out (needing her or new), pointed at the circles. */
  overflow: number;
}

export const BRIEFING_COPY = {
  greeting: (hour: number, first: string | null) => {
    const part = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
    return first ? `${part}, ${first}` : part;
  },
  waiting: (who: string) => `${who} is waiting on your reply.`,
  stale: (who: string, weeks: number) => `It's been ${weeks} weeks since ${who} heard from you. Still interested?`,
  booking: (title: string) => `Someone wants to book you: ${title}.`,
  win: (title: string) => `${title}.`,
  postReady: (format: string | null, when: string | null) => `Your ${format ? format.toLowerCase() : "post"}${when ? ` for ${when}` : ""} is ready.`,
  moment: (title: string, when: string) => `${title} is ${when}. Want to post for it?`,
  idea: "I have an idea for your brand. Want to look?",
  quiet: "Quiet day. Want an idea for your next post?",
  more: (n: number) => `${n} more in your circles`,
  chip: {
    draftReply: "Draft a reply", notForMe: "Not for me", later: "Later", answer: "Answer", review: "Review & post",
    makePost: "Make this post", notNow: "Not now", another: "Make another", look: "Show me", idea: "Give me an idea",
    seeIt: "See it", thanks: "Say thanks",
  },
  ask: {
    reply: (who: string) => `Draft a reply to ${who} for me.`,
    stale: (who: string) => `Draft a short reply to ${who} asking if they're still interested.`,
    quiet: "Give me one idea for my next post.",
    thanks: (who: string) => `Draft a short thank-you to ${who} for their payment.`,
  },
} as const;

// Words a sentence may start with that read fine in lower case after the greeting ("Morning, Mia — your post …").
const LOWER_AFTER_GREETING = /^(Your|It's|Quiet|Someone)\b/;

/** The first message opens with the greeting, by her phone's hour: "Morning, Mia — …". */
export function withGreeting(text: string, hour: number, first: string | null): string {
  const rest = LOWER_AFTER_GREETING.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  return `${BRIEFING_COPY.greeting(hour, first)} — ${rest}`;
}

/** Her first name from her name on file ("Mia Bhuta" → "Mia"); null when there is none. */
export function firstNameOf(name: string | null | undefined): string | null {
  const f = (name ?? "").trim().split(/\s+/)[0];
  return f ? f.charAt(0).toUpperCase() + f.slice(1) : null;
}

const LATER: BriefChip = { label: BRIEFING_COPY.chip.later, act: { kind: "later" } };
const metaOf = (parts: Array<string | null | undefined>): string | null => parts.filter((x): x is string => !!x && !!x.trim()).join(" · ") || null;
const openOf = (item: StoryItem): BriefAct => (item.action.target.screen === "mila"
  ? { kind: "chat", draft: item.action.target.draft, conversationId: item.action.target.conversationId }
  : { kind: "open", target: item.action.target });

function offerMessage(o: OfferStory): BriefMessage {
  const C = BRIEFING_COPY;
  if (o.circle === "bookings") {
    return { id: o.id, kind: "booking", text: C.booking(o.title), card: { name: null, title: o.title, meta: metaOf([o.kicker, o.line]) },
      item: o, open: openOf(o), chips: [{ label: C.chip.answer, act: openOf(o), primary: true }, LATER] };
  }
  const who = o.who ?? o.title;
  const stale = o.waitingDays != null && o.waitingDays > STALE_REPLY_DAYS;
  // "{Brand} wants a Reel and 2 stories" only when the terms name the deliverables (the story's title says so).
  const wants = o.title.includes(" wants ") ? `${o.title}.` : null;
  const text = stale ? C.stale(who, Math.floor(o.waitingDays! / 7)) : !o.overdue && wants ? wants : C.waiting(who);
  const chips: BriefChip[] = [{ label: C.chip.draftReply, act: { kind: "ask", prompt: stale ? C.ask.stale(who) : C.ask.reply(who) }, primary: true }];
  if (o.dealId) chips.push({ label: C.chip.notForMe, act: { kind: "not_for_me", dealId: o.dealId, threadId: o.threadId ?? null, brandName: o.brandName ?? who } });
  chips.push(LATER);
  const p = o.poster;
  const card: BriefCardText = {
    name: p?.name ?? o.brandName ?? who,
    title: p?.ask ?? o.line ?? o.title,
    meta: metaOf([o.via ? `via ${o.via}` : null, p?.amount ?? null, o.sentOn ? `Sent ${o.sentOn}` : null]),
  };
  return { id: o.id, kind: "offer", text, card, item: o, open: openOf(o), chips };
}

function postMessage(w: StoryItem): BriefMessage {
  const C = BRIEFING_COPY;
  const [day, format] = w.kicker.split(" · ");
  const when = day === HOME_V3_COPY.today ? "today" : day === HOME_V3_COPY.tomorrow ? "tomorrow" : day || null;
  return { id: w.id, kind: "post", text: C.postReady(format ?? null, when), card: { name: null, title: w.title, meta: metaOf([w.kicker, w.line]) },
    item: w, open: openOf(w),
    chips: [{ label: C.chip.review, act: openOf(w), primary: true }, LATER] };
}

function momentMessage(m: StoryItem): BriefMessage {
  const C = BRIEFING_COPY;
  const t = m.action.target;
  const go: BriefAct = t.screen === "mila" && t.draft ? { kind: "ask", prompt: t.draft } : openOf(m);
  return { id: m.id, kind: "moment", text: C.moment(m.title, m.kicker),
    card: { name: null, title: m.moment?.hook ? `“${m.moment.hook}”` : m.title, meta: metaOf([m.moment?.kind ?? null, m.kicker]) }, item: m, open: go,
    chips: [{ label: t.screen === "post_kit" ? C.chip.review : C.chip.makePost, act: go, primary: true }, { label: C.chip.notNow, act: { kind: "later" } }] };
}

function winMessage(w: StoryItem): BriefMessage {
  const C = BRIEFING_COPY;
  const go = openOf(w);
  // A brand paid her: see it in Financials, or have Mila draft a thank-you (she sends it herself).
  if (w.id.startsWith("win:pay:")) {
    const chips: BriefChip[] = [{ label: C.chip.seeIt, act: go, primary: true }];
    if (w.paidBy) chips.push({ label: C.chip.thanks, act: { kind: "ask", prompt: C.ask.thanks(w.paidBy) } });
    chips.push(LATER);
    return { id: w.id, kind: "win", text: C.win(w.title), card: { name: null, title: w.title, meta: null }, item: w, open: go, chips };
  }
  const again: BriefAct = go.kind === "chat" && go.draft ? { kind: "ask", prompt: go.draft } : go;
  return { id: w.id, kind: "win", text: C.win(w.title), card: { name: null, title: w.title, meta: w.line }, item: w, open: go,
    chips: [{ label: C.chip.another, act: again, primary: true }, LATER] };
}

/**
 * The briefing: up to BRIEFING_MAX messages, by priority, skipping what she put off "Later" today. Names only the items
 * the circles show. With nothing to say, one idea (Mila's open suggestion, else a quiet-day ask).
 */
export function briefing(input: {
  week: StoryItem[]; offers: OfferStory[]; moments: StoryItem[]; wins: StoryItem[];
  suggestion: NextCandidate | null; later: ReadonlySet<string>; hour: number; firstName: string | null;
}): Briefing {
  const { later } = input;
  const keep = (x: { id: string }) => !later.has(x.id);
  const candidates: BriefMessage[] = [
    ...input.offers.filter(keep).map(offerMessage),
    ...input.wins.filter(keep).map(winMessage),
    ...input.week.filter(keep).map(postMessage),
    ...input.moments.filter(keep).slice(0, 1).map(momentMessage),
  ];
  const used: Partial<Record<BriefKind, number>> = {};
  const messages: BriefMessage[] = [];
  const offersAlone = candidates.every((m) => m.kind === "offer");
  const cap = (k: BriefKind) => (k === "offer" && offersAlone ? BRIEFING_OFFERS_ALONE : BRIEFING_PER_KIND[k]);
  for (const m of candidates) {
    if (messages.length >= BRIEFING_MAX) break;
    if ((used[m.kind] ?? 0) >= cap(m.kind)) continue;
    used[m.kind] = (used[m.kind] ?? 0) + 1;
    messages.push(m);
  }
  if (!messages.length && !later.has("idea")) {
    const C = BRIEFING_COPY;
    const s = input.suggestion;
    const conversationId = s && s.target.screen === "mila" ? s.target.conversationId ?? undefined : undefined;
    const open: BriefAct = s ? { kind: "chat", conversationId } : { kind: "ask", prompt: C.ask.quiet };
    messages.push({ id: "idea", kind: "idea", text: s ? C.idea : C.quiet, card: { name: null, title: s ? C.chip.look : C.chip.idea, meta: null }, item: null, open,
      chips: [{ label: s ? C.chip.look : C.chip.idea, act: open, primary: true }, LATER] });
  }
  if (messages.length) messages[0] = { ...messages[0], text: withGreeting(messages[0].text, input.hour, input.firstName) };
  // What else needs her or is new, beyond what Mila said: offers and bookings, posts, wins.
  const shown = new Set(messages.map((m) => m.id));
  const overflow = [...input.offers, ...input.week, ...input.wins].filter((x) => keep(x) && !shown.has(x.id)).length;
  return { messages, overflow };
}

// ── "Later": what she put off today (kept on the phone) ──────────────────────

/** The stored "Later" list: today's ids only; another day's list, or anything unreadable, is empty. */
export function parseLater(raw: string | null | undefined, today: string): Set<string> {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && v.day === today && Array.isArray(v.ids) ? new Set(v.ids.filter((x: unknown) => typeof x === "string")) : new Set();
  } catch { return new Set(); }
}

// ── admin: the one row and the checklist ─────────────────────────────────────

export interface SetupItem {
  id: string;
  title: string;
  button: string;
  target: HomeTarget;
  done: boolean;
  /** Blocks something (money, a contract, a broken connection): may reach Home's row. */
  blocking: boolean;
}

const PLATFORM_LABEL: Record<string, string> = {
  gmail: "Gmail", outlook: "Outlook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", twitter: "X", x: "X",
  facebook: "Facebook", spotify: "Spotify", strava: "Strava", linkedin: "LinkedIn",
};
export const platformLabel = (p: string): string => PLATFORM_LABEL[p.toLowerCase()] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : "an account");

const BROKEN = new Set(["expired", "revoked"]);
const INBOXES = ["gmail", "outlook"];

export interface ConnectionLike { platform: string; status: string }
export type PushState = "granted" | "denied" | "undetermined" | "unavailable" | null;

/**
 * Every setup item, blocking first. Blocking: a deal to confirm as signed (its contract), payouts while money is owed
 * (what-matters-next's payout_setup), a broken connection. Setup (nice to have): notifications, Instagram, an inbox —
 * each shown done once it is.
 */
export function setupItems(input: {
  board: OpportunityBoard | null | undefined;
  next: ReadonlyArray<NextCandidate> | null | undefined;
  connections: ReadonlyArray<ConnectionLike>;
  push: PushState;
}): SetupItem[] {
  const out: SetupItem[] = [];
  for (const b of input.board?.needsYou ?? []) {
    if (b.next?.action !== "confirm_signed") continue;
    out.push({ id: `contract:${b.opportunity_id}`, title: `Confirm your ${b.brand.name} deal is signed`, button: HOME_V3_COPY.open, target: { screen: "opportunity", opportunityId: b.opportunity_id, dealId: b.lead_deal_id }, done: false, blocking: true });
  }
  const payout = (input.next ?? []).find((c) => c.kind === "payout_setup");
  if (payout) {
    const amount = payout.amountCents ? money(payout.amountCents, payout.currency) : null;
    out.push({ id: "payouts", title: amount ? `Set up payouts: ${amount} is waiting for you` : "Set up payouts: money is waiting for you", button: "Set up", target: { screen: "financials" }, done: false, blocking: true });
  }
  const broken = new Set<string>();
  for (const c of input.connections) {
    if (!BROKEN.has(c.status)) continue;
    // A platform with a working connection too is fine.
    if (input.connections.some((o) => o.platform === c.platform && o.status === "active")) continue;
    broken.add(c.platform);
  }
  for (const p of broken) out.push({ id: `reconnect:${p}`, title: `Reconnect ${platformLabel(p)}`, button: "Connect", target: { screen: "settings" }, done: false, blocking: true });

  const active = (p: string) => input.connections.some((c) => c.platform === p && c.status === "active");
  if (input.push && input.push !== "unavailable") {
    out.push({ id: "notifications", title: "Turn on notifications", button: "Turn on", target: input.push === "denied" ? { screen: "settings" } : { screen: "push" }, done: input.push === "granted", blocking: false });
  }
  if (!broken.has("instagram")) out.push({ id: "connect:instagram", title: "Connect Instagram", button: "Connect", target: { screen: "settings" }, done: active("instagram"), blocking: false });
  if (!INBOXES.some((p) => broken.has(p))) out.push({ id: "connect:inbox", title: "Connect your inbox", button: "Connect", target: { screen: "settings" }, done: INBOXES.some(active), blocking: false });
  return out;
}

export interface AdminRow {
  item: SetupItem;
  /** "+N more": every other item still to do. 0 = no link. */
  more: number;
}

/** At most ONE row on Home: the first blocking item, with how many others are still to do. Null when nothing blocks. */
export function adminRowOf(items: ReadonlyArray<SetupItem>): AdminRow | null {
  const first = items.find((i) => i.blocking && !i.done);
  if (!first) return null;
  return { item: first, more: items.filter((i) => !i.done && i !== first).length };
}

/** The checklist's head: done of all. */
export function checklistProgress(items: ReadonlyArray<SetupItem>): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length };
}

/** Every setup item is done: the checklist and Me's Get set up tile are gone (they come back if one reappears). */
export function setupDone(items: ReadonlyArray<SetupItem>): boolean {
  return items.every((i) => i.done);
}

/** A badge's text: the real count, "99+" past it (a story says "1 of 11", so the badge says 11). */
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** The avatar's badge: nice-to-have setup still to do (blocking items have Home's row). */
export function setupBadge(items: ReadonlyArray<SetupItem>): number {
  return items.filter((i) => !i.blocking && !i.done).length;
}

// ── the whole screen ─────────────────────────────────────────────────────────

export interface HomeV3Inputs {
  now: Date;
  goals: AgentGoalsResponse | null | undefined;
  board: OpportunityBoard | null | undefined;
  bookingRequests: ReadonlyArray<BookingListItemView> | null | undefined;
  next: ReadonlyArray<NextCandidate> | null | undefined;
  winPosts: ReadonlyArray<AgentWinPost> | null | undefined;
  /** Brands' direct payments to her (GET /me/agent/wins `payments`). */
  winPayments?: ReadonlyArray<AgentWinPayment> | null;
  connections: ReadonlyArray<ConnectionLike>;
  push: PushState;
}

export interface HomeV3Model {
  circles: Circle[];
  admin: AdminRow | null;
  checklist: SetupItem[];
  badge: number;
  /** Every item id in the circles: what "seen" is pruned to, and all Mila's briefing may name. */
  shownIds: Set<string>;
  /** The items as the circles hold them, for Mila's briefing (briefing() — the screen adds "Later", the hour, her name). */
  parts: { week: StoryItem[]; offers: OfferStory[]; moments: StoryItem[]; wins: StoryItem[]; suggestion: NextCandidate | null };
}

export function homeV3Model(i: HomeV3Inputs): HomeV3Model {
  const week = weekPosts(i.goals, i.now).map((a) => weekStory(a, i.now));
  const offers = offerStories(i.board, i.bookingRequests, i.now);
  const moments = momentStories(i.goals, i.now);
  const wins = winStories(i.board, i.winPosts, i.now, i.winPayments);
  const circles = buildCircles({ week, offers, moments, wins });
  const checklist = setupItems({ board: i.board, next: i.next, connections: i.connections, push: i.push });
  const shownIds = new Set<string>(circles.flatMap((c) => c.items.map((x) => x.id)));
  return {
    circles,
    admin: adminRowOf(checklist),
    checklist,
    badge: setupBadge(checklist),
    shownIds,
    parts: { week, offers, moments, wins, suggestion: suggestionOf(i.next) },
  };
}

// ── Me: the identity line and the tiles' live facts ──────────────────────────

/** Each " · " part starts with a capital ("Stanford Soccer · midfielder · Senior" → "… · Midfielder · Senior"). */
export function capitalizeParts(line: string | null | undefined): string | null {
  if (!line) return null;
  return line.split(" · ").map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(" · ");
}

export const ME_TILE_COPY = {
  brandBook: "How brands see you",
  plan: "Your goals and this week",
  page: "Your public page",
  rates: "Ranges + your minimums",
  knows: "Facts + sources",
  goals: (n: number) => `${n} goal${n === 1 ? "" : "s"}`,
  ready: (n: number) => `${n} post${n === 1 ? "" : "s"} ready`,
  toDo: (n: number) => `${n} to do`,
  connected: (n: number) => (n ? `${n} connected` : "Nothing connected yet"),
} as const;

/** Your plan's one live fact: goals held and posts ready this week ("2 goals · 3 posts ready"); else the plain line. */
export function planTileMeta(goals: number, ready: number): string {
  const parts = [goals ? ME_TILE_COPY.goals(goals) : null, ready ? ME_TILE_COPY.ready(ready) : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : ME_TILE_COPY.plan;
}
