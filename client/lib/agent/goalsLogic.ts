/**
 * agent/goalsLogic — the small pure rules the Goals tab and Home's "Coming up" share (AGENT_V3 + the server's
 * AGENT_PLAN), promoted from the approved prototypes (draft PR #900, client/screens/prototypes/protoLogic). Fixed copy
 * over served data; nothing athlete-, sport- or brand-specific. Human dates ("Sat 18 Oct"; a month-only date reads
 * "December"), never ISO and never a countdown.
 *
 *   horizonLabel        the plan's now / next / later → "This month · This quarter · This year" (owner, 10 Oct 2026)
 *   repeatsLabel        a recommendation's once / standing trigger → "Once" · "Before every event" … (plan 1.5.0)
 *   categoryOf          a served goal domain → the card's category (Performance, Commercial …; shared GOAL_DOMAIN_MARK)
 *   eventDateWords      an event date at its precision: "Sun 18 Oct" · "December" · "2027"
 *   dateLeaf            the date leaf's two lines at that precision
 *   beforeLine          "Before <event> on 18 Oct" / "Before <event> in December"
 *   readyWords          "2 ready" (blue: it waits on you) or the quiet "Nothing to prepare yet"
 *   actionMarkOf        the platform or brand an action leads with (its logo), or null
 *   postRowState        a post row's state (kit ready · preparing · preview failed · building · needs media · no kit ·
 *                       done), with postEyebrow, postStatus, postButton and the opened row's kitMediaLine
 *   postsThisWeek       the "Your plan is updated: N posts this week" count
 *   goalImages          DESIGN.md §9: her action shot for a performance goal only, atmosphere for every other goal and
 *                       every recommendation, the category default last
 *   atmosphereSlots     the picker's slots (POST /me/atmosphere/pick) for the images the screen needs
 */
import { GOAL_DOMAIN_MARK, type ComingUpItem, type GoalActionView, type GoalsPlanningView, type GoalView, type PlanEventRef, type RecommendedGoalView } from "../../../shared/plan";
import type { DatePrecision, GoalHorizon, GoalRepeats } from "../../../shared/agent";
import type { PostFormat } from "../../../shared/postKit";
import { PREVIEW_STALL_MS } from "../../components/postKit/preview";
import { domainLabel } from "../strategyLogic";
import { goalCapital, type GoalImagery } from "../goalLogic";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-18" → a local calendar date (no timezone drift). */
function parseDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export const HORIZON_WORDS: Record<GoalHorizon, string> = { now: "This month", next: "This quarter", later: "This year" };

/**
 * plan 1.5.0: whether a recommendation is a one-off or standing, in fixed words. Neutral across sports: the goal line
 * itself names the kind of event ("A post before every home game").
 */
export const REPEATS_WORDS: Record<GoalRepeats, string> = {
  once: "Once",
  before_event: "Before every event",
  weekly: "Every week",
  deal_signed: "With every new deal",
  new_media: "When new photos arrive",
  moment: "Every time it comes round",
  after_result: "After every result",
};

/** The card's once / standing chip; null from a server that sends no repeats. */
export function repeatsLabel(r: GoalRepeats | null | undefined): string | null {
  return r ? REPEATS_WORDS[r] ?? null : null;
}
export const HORIZON_CHOICES: ReadonlyArray<GoalHorizon> = ["now", "next", "later"];

export function horizonLabel(h: GoalHorizon | null | undefined): string | null {
  return h ? HORIZON_WORDS[h] ?? null : null;
}

export type GoalCategory = (typeof GOAL_DOMAIN_MARK)[keyof typeof GOAL_DOMAIN_MARK];

/** The card's category for a served domain, or null when nobody has said. */
export function categoryOf(domain: string | null | undefined): GoalCategory | null {
  return domain ? (GOAL_DOMAIN_MARK as Record<string, GoalCategory>)[domain] ?? null : null;
}

export const categoryLabel = (domain: string | null | undefined): string => domainLabel(categoryOf(domain));

/** Only a performance goal may carry her own photo (DESIGN.md §9). */
export const isPerformance = (domain: string | null | undefined): boolean => categoryOf(domain) === "performance";

/** "Sun 18 Oct" · "December" · "2027". */
export function eventDateWords(iso: string, precision: DatePrecision = "day"): string {
  const d = parseDay(iso);
  if (precision === "year") return String(d.getFullYear());
  if (precision === "month") return MONTHS_LONG[d.getMonth()];
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The date leaf's two lines: "18" over "Oct"; a month-only date "Dec" over its year; a year-only date the year alone. */
export function dateLeaf(iso: string, precision: DatePrecision = "day"): { day: string; month: string } {
  const d = parseDay(iso);
  if (precision === "year") return { day: String(d.getFullYear()), month: "" };
  if (precision === "month") return { day: MONTHS[d.getMonth()], month: String(d.getFullYear()) };
  return { day: String(d.getDate()), month: MONTHS[d.getMonth()] };
}

/** "Before <event> on 18 Oct" (a month-only date: "in December"). */
export function beforeLine(event: Pick<PlanEventRef, "label" | "date" | "precision">): string {
  const d = parseDay(event.date);
  if (event.precision === "year") return `Before ${event.label} in ${d.getFullYear()}`;
  if (event.precision === "month") return `Before ${event.label} in ${MONTHS_LONG[d.getMonth()]}`;
  return `Before ${event.label} on ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** An action's meta line: what it is timed before, else when it is due, else whether it is done. */
export function actionMeta(a: GoalActionView): string | null {
  if (a.state === "done") return "Done";
  if (a.event) return beforeLine(a.event);
  return a.when;
}

/** Whether the actions for a dated event are ready: "2 ready" (blue, it waits on you) or the quiet line. */
export function readyWords(n: number): { ready: boolean; text: string } {
  return n > 0 ? { ready: true, text: `${n} ready` } : { ready: false, text: "Nothing to prepare yet" };
}

/** The coming-up row's meta: the date in words. */
export const comingUpMeta = (c: ComingUpItem): string => eventDateWords(c.date, c.precision);

const PLATFORMS = ["instagram", "tiktok", "youtube", "gmail", "outlook", "spotify"];

/** The platform a connector or a deliverable's platform names (its real mark draws through the brand-logo chain). */
export function platformOf(id: string | null | undefined): string | null {
  const s = (id ?? "").toLowerCase().trim();
  if (!s) return null;
  for (const p of PLATFORMS) if (s.includes(p)) return p;
  if (s.includes("twitter") || s === "x" || s.startsWith("x-")) return "x";
  return null;
}

/** What an action leads with: a platform's logo, a brand's logo, or nothing. */
export function actionMarkOf(a: GoalActionView): { platform: string } | { brand: string } | null {
  const platform = platformOf(a.deliverable?.platform) ?? platformOf(a.deliverable?.connector);
  if (platform) return { platform };
  const t = a.deliverable?.target;
  if (t && (t.subjectKind === "brand" || t.subjectKind === "organization") && t.name.trim()) return { brand: t.name.trim() };
  return null;
}

// ─── Post rows (design "Goals tab post details + plan ready", 12 Oct 2026) ─────────────────────────────────────────

/**
 * A post row's state, from the served kit in short (GoalActionView.kit) and the plan run in progress:
 *   done            answered (posted)
 *   building        no kit yet and the plan run is building kits now
 *   no_kit          no kit yet, nothing building it: "Build it"
 *   needs_media     a kit built with none of her own assets in it
 *   preview_failed  the preview failed, or is still queued PREVIEW_STALL_MS after it was asked for (the kit screen's
 *                   own rule, components/postKit/preview.ts)
 *   preparing       the preview is queued, inside the stall window
 *   ready           the kit is built and its preview is ready, or none was asked for (the render is off)
 */
export type PostRowState = "done" | "building" | "no_kit" | "needs_media" | "preview_failed" | "preparing" | "ready";

export function postRowState(a: Pick<GoalActionView, "state" | "kit">, planning: GoalsPlanningView | null | undefined, nowMs: number = Date.now()): PostRowState {
  if (a.state === "done") return "done";
  const kit = a.kit ?? null;
  if (!kit) return planning?.step === "post_kits" ? "building" : "no_kit";
  if (kit.assets === 0) return "needs_media";
  const p = kit.preview;
  if (!p || p.status === "ready") return "ready";
  if (p.status === "failed") return "preview_failed";
  const at = Date.parse(p.requestedAt);
  return Number.isFinite(at) && nowMs - at >= PREVIEW_STALL_MS ? "preview_failed" : "preparing";
}

/** When a preparing row turns to failed (ms since epoch), so the row can redraw then; null for any other state. */
export function postRowStallAt(a: Pick<GoalActionView, "state" | "kit">): number | null {
  const p = a.kit?.preview;
  if (a.state === "done" || !a.kit || a.kit.assets === 0 || p?.status !== "queued") return null;
  const at = Date.parse(p.requestedAt);
  return Number.isFinite(at) ? at + PREVIEW_STALL_MS : null;
}

export const POST_FORMAT_WORDS: Record<PostFormat, string> = { reel: "Reel", carousel: "Carousel", story: "Story", feed: "Photo post" };

/**
 * What a kit with none of her media needs, as one noun, read from the plan's own words (post.mediaNeeds): "a clip" when
 * they name only video, "a photo" when they name only stills, null when they name both or neither (the row then says
 * the neutral "something"). Never guessed from the format.
 */
export function neededMedia(mediaNeeds: string | null | undefined): "a clip" | "a photo" | null {
  const t = (mediaNeeds ?? "").toLowerCase();
  const video = /\b(clips?|videos?|footage|reels?)\b/.test(t);
  const still = /\b(photos?|stills?|pictures?|images?|shots?|selfies?)\b/.test(t);
  return video && !still ? "a clip" : still && !video ? "a photo" : null;
}

export const POST_ROW_COPY = {
  openKit: "Open kit",
  build: "Build it",
  openPostKit: "Open post kit",
  talk: "Talk it over with Mila",
  ready: "Kit ready",
  preparing: "Preparing your preview",
  previewFailed: "Preview didn't come out",
  building: "Mila is building your kit",
  needsMedia: (mediaNeeds: string | null | undefined) => `Needs ${neededMedia(mediaNeeds) ?? "something"} you don't have yet`,
  noKit: "No kit yet",
  posted: "Posted",
  shows: "What it shows",
  caption: "The caption",
  avoid: "Leave out",
  need: "You'll need",
  whyNow: "Why now",
  yourPreview: "Your preview",
  yourKit: "In your kit",
} as const;

/** The eyebrow: the format word · "Before <moment>" when it is timed to one, else its pillar, else the format alone. */
export function postEyebrow(a: Pick<GoalActionView, "post" | "event" | "pillar">): string {
  const format = a.post ? POST_FORMAT_WORDS[a.post.format] ?? null : null;
  const why = a.event ? `Before ${a.event.label}` : a.pillar?.name?.trim() || null;
  return [format, why].filter(Boolean).join(" · ");
}

/** The row's title: the opening line in quotes (the plan's own words for the post). */
export const postHookLine = (hook: string): string => `“${hook.trim().replace(/^["“”]+|["“”]+$/g, "")}”`;

/**
 * The row's status line: its words, whether it waits on her (blue), whether it shows a spinner, and the due date it
 * carries (only "Kit ready" and "No kit yet" carry it).
 */
export function postStatus(a: Pick<GoalActionView, "when" | "post">, state: PostRowState): { text: string; waiting: boolean; spinner: boolean; date: string | null } {
  switch (state) {
    case "ready": return { text: POST_ROW_COPY.ready, waiting: true, spinner: false, date: a.when };
    case "preparing": return { text: POST_ROW_COPY.preparing, waiting: false, spinner: true, date: null };
    case "preview_failed": return { text: POST_ROW_COPY.previewFailed, waiting: false, spinner: false, date: null };
    case "building": return { text: POST_ROW_COPY.building, waiting: false, spinner: true, date: null };
    case "needs_media": return { text: POST_ROW_COPY.needsMedia(a.post?.mediaNeeds), waiting: false, spinner: false, date: null };
    case "no_kit": return { text: POST_ROW_COPY.noKit, waiting: false, spinner: false, date: a.when };
    case "done": return { text: POST_ROW_COPY.posted, waiting: false, spinner: false, date: null };
  }
}

/** The row's one button: into the kit, or Build it when there is none (off while Mila builds it); none once posted. */
export function postButton(state: PostRowState): { label: string; build: boolean; disabled: boolean } | null {
  if (state === "done") return null;
  if (state === "no_kit") return { label: POST_ROW_COPY.build, build: true, disabled: false };
  return { label: POST_ROW_COPY.openKit, build: false, disabled: state === "building" };
}

/** "Cut from 2 clips in your library" · "Made from 1 photo and 1 clip in your library" (the kit's own picks). */
export function kitMediaLine(media: ReadonlyArray<{ mediaType: "photo" | "clip"; inKit: boolean }>): string | null {
  const picked = media.filter((m) => m.inKit);
  const clips = picked.filter((m) => m.mediaType === "clip").length;
  const photos = picked.length - clips;
  if (!picked.length) return null;
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  if (!photos) return `Cut from ${n(clips, "clip")} in your library`;
  if (!clips) return `Made from ${n(photos, "photo")} in your library`;
  return `Made from ${n(photos, "photo")} and ${n(clips, "clip")} in your library`;
}

/** The posts waiting this week across her goals (the "Your plan is updated" notice). */
export function postsThisWeek(goals: ReadonlyArray<Pick<GoalView, "actions">>): number {
  return goals.reduce((n, g) => n + g.actions.filter((a) => a.planKind === "post" && a.state !== "done").length, 0);
}

export const GOALS_UPDATING_COPY = {
  title: "Mila is updating your plan",
  sub: "This page updates by itself when it's done.",
  done: (posts: number) => (posts ? `Your plan is updated: ${posts} ${posts === 1 ? "post" : "posts"} this week.` : "Your plan is updated."),
} as const;

// ─── Images (DESIGN.md §9) ────────────────────────────────────────────────────────────────────────────────────────

/** One atmosphere pick, as POST /me/atmosphere/pick answers each slot. */
export type AtmospherePick =
  | { key: string; kind: "image"; imageId: string; url: string; width: number | null; height: number | null }
  | { key: string; kind: "default"; category: string | null; reason: string };

export interface AtmosphereSlot {
  key: string;
  type: "goal" | "suggestion";
  purpose: string;
  context?: string | null;
  category?: string | null;
}

export const ATMOSPHERE_SCREEN = "goals";
const MAX_SLOTS = 12;

export const goalSlotKey = (id: string) => `goal:${id}`;
export const recSlotKey = (decisionId: string) => `rec:${decisionId}`;

/** The slots this screen asks the picker for: each goal that is not a performance goal with her photo, then each recommendation. */
export function atmosphereSlots(goals: ReadonlyArray<Pick<GoalView, "id" | "domain" | "text">>, recommended: ReadonlyArray<Pick<RecommendedGoalView, "decisionId" | "domain" | "goal">>, hasActionShot: boolean): AtmosphereSlot[] {
  const purpose = (domain: string | null) => `${categoryLabel(domain) || "Goal"} goal background`.toLowerCase();
  const slots: AtmosphereSlot[] = [
    ...goals.filter((g) => !(hasActionShot && isPerformance(g.domain))).map((g) => ({ key: goalSlotKey(g.id), type: "goal" as const, purpose: purpose(g.domain), context: g.text.slice(0, 300), category: categoryOf(g.domain) })),
    ...recommended.map((r) => ({ key: recSlotKey(r.decisionId), type: "suggestion" as const, purpose: purpose(r.domain), context: r.goal.slice(0, 300), category: categoryOf(r.domain) })),
  ];
  return slots.slice(0, MAX_SLOTS);
}

export type GoalImage = { imagery: GoalImagery };

/**
 * Each card's image, in the order the screen draws them: a performance goal takes the next of her action shots (never a
 * repeat); every other card its atmosphere pick (no credit line: none is shown anywhere, #907); the category default last.
 */
export function goalImages(
  goals: ReadonlyArray<Pick<GoalView, "id" | "domain">>,
  recommended: ReadonlyArray<Pick<RecommendedGoalView, "decisionId" | "domain">>,
  actionShots: ReadonlyArray<string>,
  picks: ReadonlyArray<AtmospherePick> | null | undefined,
): Map<string, GoalImage> {
  const out = new Map<string, GoalImage>();
  const byKey = new Map((picks ?? []).map((p) => [p.key, p]));
  const fallback = (domain: string | null): GoalImage => ({ imagery: { kind: "typographic", capital: goalCapital(domain) } });
  const atmosphere = (key: string, domain: string | null): GoalImage => {
    const p = byKey.get(key);
    return p && p.kind === "image" && p.url ? { imagery: { kind: "subject", image: p.url } } : fallback(domain);
  };
  let shot = 0;
  for (const g of goals) {
    if (isPerformance(g.domain) && actionShots[shot]) { out.set(g.id, { imagery: { kind: "performance", image: actionShots[shot] } }); shot += 1; continue; }
    out.set(g.id, atmosphere(goalSlotKey(g.id), g.domain));
  }
  for (const r of recommended) out.set(recSlotKey(r.decisionId), atmosphere(recSlotKey(r.decisionId), r.domain));
  return out;
}
