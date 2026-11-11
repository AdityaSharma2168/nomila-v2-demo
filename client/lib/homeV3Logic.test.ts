/**
 * homeV3Logic.test — Home v3 (EXPO_PUBLIC_HOME_V3): what shows, and what Mila says about it.
 *
 *   H1 item selection   This week = pending plan posts with a built kit due this week (or undated), soonest first,
 *                       held and recommended goals, no duplicates; Offers = the board's needsYou (a contract step goes to
 *                       admin instead) + booking requests; Moments = comingUp (a prepared kit opens it, else a Mila ask);
 *                       Wins = Signed/Agreed in 7 days + the learning loop's posts, only when there is one
 *   H2 Mila's line      overdue offer > posts ready > Mila's suggestion > offers waiting > all caught up (+ next moment);
 *                       the line NEVER names an item that is not on the screen
 *   H3 seen / unseen    a ring is the circle's colour while any item is unseen, grey once all are seen or empty; the
 *                       store parses defensively and prunes to live items
 *   H4 admin row        at most ONE row (the first blocking item) with "+N more" counting every other item to do; none
 *                       when nothing blocks; the badge counts nice-to-have setup only
 *   H5 design review    (19 Oct phone review) a post is titled by itself, not its chore; relative days; offers carry a
 *                       display name, the ask and the fee (a poster), overdue first so Mila's line is always Offers 1;
 *                       the line names who in context, turns into a decision past two weeks, and ends in a chip; a
 *                       moment's date face; real badge counts; all-done setup has no checklist; Me's tile facts
 */
import type { AgentGoalsResponse, AgentWinPost, ComingUpItem, GoalActionView } from "../../shared/plan";
import type { NextCandidate } from "../../shared/meSummaries";
import type { BoardItem, OpportunityBoard } from "../hooks/use-opportunity-board";
import type { BookingListItemView } from "./bookingsTypes";
import {
  adminRowOf, askFromLine, askWords, badgeText, BRIEFING_MAX, briefing, buildCircles, capitalizeParts, capSeen, checklistProgress, dateFace, displayBrandName,
  feeWords, firstNameOf, firstUnseenIndex, homeV3Model, markSeen, momentAtmosphereSlots, momentCategoryOf, momentStories, momentStory, offerStories, offerWho, parseLater, parseSeen, planTileMeta,
  postTitle, relativeDay, ringState, setupBadge, setupDone, setupItems, weekPosts, weekStory, winStories, type HomeV3Inputs,
  type SetupItem,
} from "./homeV3Logic";

// Monday 19 Oct 2026, noon local.
const NOW = new Date(2026, 9, 19, 12, 0, 0);
const day = (offset: number) => {
  const d = new Date(2026, 9, 19 + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

function action(id: string, over: Partial<GoalActionView> = {}): GoalActionView {
  return {
    id, title: `Post ${id}`, kind: "post_kit", when: null, state: "to_start", studioItemId: null, open: null, startPrompt: null,
    planKind: "post", why: "", button: "post", buttonLabel: "I'll post it", dueOn: day(1), event: null,
    deliverable: { type: "post_brief", title: "", body: "", target: null, platform: null, thread: null, connector: null },
    approvalId: null, post: { hook: "", format: "reel", show: "", captionAngle: "", avoid: "", mediaNeeds: "" }, pillar: null,
    kit: { built: true, assets: 3, aiGenerationNeeded: false, preview: null },
    ...over,
  };
}

function goals(actions: GoalActionView[], over: Partial<AgentGoalsResponse> = {}): AgentGoalsResponse {
  return {
    contract: "agent-goals/1",
    goals: [{ id: "g1", text: "Goal", plan: null, horizon: null, domain: null, actions, status: "active", source: "athlete", gamePlanBy: "athlete", inYourWords: true, priority: 1, nextEvent: null } as any],
    setAside: [], recommended: [], comingUp: [], riskUpside: null, missing: [], plan: null,
    ...over,
  };
}

const moment = (id: string, over: Partial<ComingUpItem> = {}): ComingUpItem => ({ date: day(10), precision: "day", label: `Moment ${id}`, factId: id, goalId: null, actionsReady: 0, kitActionId: null, ...over });

function card(id: string, over: Partial<BoardItem> = {}): BoardItem {
  return {
    opportunity_id: id,
    brand: { id: 1, name: `Brand ${id}`, logo_url: null, category: null, tier: null, research_confirmed: false, image_url: null, safe_logo_url: `https://logo/${id}`, is_person: false },
    deal_ids: [`d-${id}`], lead_deal_id: `d-${id}`, lead_thread_id: null, qualification: null, state: "cash", kind: "deal", kind_label: null,
    poster: "paid", whats_new: null, stage: null, message_count: 1, via: null, channel: "direct", standing: "", line: `Line ${id}`,
    awaiting_response_from: "athlete", her_move_since: iso(2), overdue: false, going_quiet: false, last_activity_at: iso(1),
    brand_rollup: null, brand_opportunity_ids: [id], next: { action: "reply", label: "Reply", why: "", due: null, hers: true },
    ...over,
  };
}

const board = (over: Partial<OpportunityBoard> = {}): OpportunityBoard => ({
  needsYou: [], whatMatters: [], needsTermsBatch: [], goingQuiet: [], inMotion: [], explore: [], toVerify: [], order: [],
  counts: { open: 0, inMotion: 0, toVerify: 0, filed: 0 }, ...over,
});

const booking = (id: string, over: Partial<BookingListItemView> = {}): BookingListItemView => ({
  id, status: "requested" as any, phase: "request", buyerLabel: "Jordan P.", title: "Video call", format: "video" as any, locationMode: "online" as any,
  startsAt: null, endsAt: null, proposedTimes: [], respondBy: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(), receiveCents: 5000,
  checks: {} as any, createdAt: iso(1), unreadMessages: 0, audience: "one", partySize: 1, unitPriceCents: 5000, slotId: null, ...over,
});

const suggestion: NextCandidate = {
  key: "mila_suggestion:dec1", kind: "mila_suggestion", dueAt: null, at: null, order: null, title: null, brandName: null, logoUrl: null,
  amountCents: null, currency: null, target: { screen: "mila", conversationId: "conv-9", decisionId: "dec1" },
};

const inputs = (over: Partial<HomeV3Inputs> = {}): HomeV3Inputs => ({
  now: NOW, goals: null, board: null, bookingRequests: null, next: null, winPosts: null, connections: [], push: null, ...over,
});

// ── H1 ───────────────────────────────────────────────────────────────────────

describe("H1 item selection", () => {
  it("This week: built, pending post kits due this week or undated, soonest first, held + recommended, no duplicates", () => {
    const g = goals([
      action("later", { dueOn: day(3) }),
      action("soon", { dueOn: day(0) }),
      action("undated", { dueOn: null }),
      action("next-week", { dueOn: day(7) }),
      action("past", { dueOn: day(-1) }),
      action("posted", { state: "done" }),
      action("no-kit", { kit: null }),
      action("not-built", { kit: { built: false, assets: 0, aiGenerationNeeded: false, preview: null } }),
      action("pitch", { kind: "pitch", planKind: "pitch" }),
    ], { recommended: [{ actions: [action("rec", { dueOn: day(2) }), action("soon", { dueOn: day(0) })] } as any] });
    expect(weekPosts(g, NOW).map((a) => a.id)).toEqual(["soon", "rec", "later", "undated"]);
  });

  it("a This week story: weekday · format, the post's title, 'For <event>' when it is timed for one, Review & post → its kit", () => {
    const s = weekStory(action("a1", { dueOn: day(2), event: { factId: "f", label: "the away game", date: day(4), precision: "day" } }), NOW);
    expect(s).toMatchObject({ id: "week:a1", kicker: "Wed · Reel", title: "Post a1", line: "For the away game", action: { label: "Review & post", target: { screen: "post_kit", id: "a1" } }, kitActionId: "a1" });
    expect(weekStory(action("a2", { event: null })).line).toBeNull();
  });

  it("Offers: the board's needsYou (not a contract step) and booking requests, each opening where it is handled", () => {
    const b = board({ needsYou: [card("o1", { overdue: true, her_move_since: iso(5) }), card("c1", { next: { action: "confirm_signed", label: "Confirm it’s signed", why: "", due: null, hers: true } })] });
    const offers = offerStories(b, [booking("b1"), booking("b2", { phase: "booked" })], NOW);
    expect(offers.map((o) => o.id)).toEqual(["offer:o1", "booking:b1"]);
    expect(offers[0]).toMatchObject({ kicker: "Waiting 5 days", title: "Brand o1", line: "Line o1", overdue: true, waitingDays: 5, action: { label: "Reply", target: { screen: "opportunity", opportunityId: "o1", dealId: "d-o1" } } });
    expect(offers[1]).toMatchObject({ title: "Video call", line: "$50 to you", overdue: false, action: { label: "Answer", target: { screen: "booking", bookingId: "b1" } } });
    // A booking due within a day is on a clock.
    expect(offerStories(null, [booking("b3", { respondBy: new Date(NOW.getTime() + 3_600_000).toISOString() })], NOW)[0].overdue).toBe(true);
  });

  it("Moments: comingUp in the next 60 days; a prepared kit opens it, otherwise Mila is handed a draft ask", () => {
    const g = goals([], { comingUp: [moment("m1", { kitActionId: "k1", actionsReady: 1 }), moment("m2"), moment("far", { date: day(61) })] });
    const ms = momentStories(g, NOW);
    expect(ms.map((m) => m.id)).toEqual(["moment:m1", "moment:m2"]);
    expect(ms[0]).toMatchObject({ kicker: "Thu 29 Oct", title: "Moment m1", line: "Post ready", action: { label: "Review & post", target: { screen: "post_kit", id: "k1" } } });
    expect(ms[1].action).toEqual({ label: "Make this post", target: { screen: "mila", draft: "Help me make a post for Moment m2 (Thu 29 Oct)." } });
  });

  it("Moments: the moments the moments step chose (every kind) win over dated events; hook, angle and why now ride along", () => {
    const chosen = { factId: "h1", date: day(9), precision: "day" as const, name: "A holiday", category: "holiday_awareness" as const, whyNow: "It matters to her audience.", angle: "Family and the game", hook: "Light it up", actionsReady: 0, kitActionId: null };
    const g = goals([], { comingUp: [moment("m1")], moments: [chosen, { ...chosen, factId: "far", date: day(61) }] });
    const ms = momentStories(g, NOW);
    expect(ms.map((m) => m.id)).toEqual(["moment:h1"]);
    expect(ms[0]).toMatchObject({ title: "A holiday", line: "It matters to her audience.", moment: { hook: "Light it up", angle: "Family and the game", kind: "Holiday" } });
    // Before the first scan (or an older server): dated events.
    expect(momentStories(goals([], { comingUp: [moment("m1")], moments: [] }), NOW).map((m) => m.id)).toEqual(["moment:m1"]);
  });

  it("Offers: the logo the Opportunities cards show (stored logo once confirmed, else the safe one; the domain as fallback) and via", () => {
    const b = board({ needsYou: [card("o1", { via: "An Agency", brand: { ...card("o1").brand, logo_url: "https://x/logo.png", safe_logo_url: null, research_confirmed: true, domain: "brand.com" } })] });
    expect(offerStories(b, [], NOW)[0]).toMatchObject({ logoUrl: "https://x/logo.png", logoDomain: "brand.com", via: "An Agency" });
    const u = board({ needsYou: [card("o2", { brand: { ...card("o2").brand, logo_url: "https://x/unconfirmed.png", safe_logo_url: null, research_confirmed: false, domain: "brand.com" } })] });
    expect(offerStories(u, [], NOW)[0]).toMatchObject({ logoUrl: null, logoDomain: "brand.com" });
  });

  it("askFromLine: the board line's own ask for a poster with no deliverables", () => {
    expect(askFromLine("Their ask: Collaborate on day-in-the-life video content · no fee yet · Waiting on you since Sep 25")).toBe("Collaborate on day-in-the-life video content");
    expect(askFromLine("Negotiating · Waiting on you since Oct 15")).toBeNull();
    expect(askFromLine(null)).toBeNull();
  });

  it("ringState: stays coloured while something still needs her, even once seen", () => {
    const items = [weekStory(action("a"), NOW)];
    expect(ringState({ items, tone: "pink", badge: 1 }, new Set([items[0].id]))).toBe("pink");
    expect(ringState({ items, tone: "pink", badge: null }, new Set([items[0].id]))).toBe("seen");
  });

  it("Wins: a deal Signed or Agreed in the last 7 days and the loop's exceptional posts, newest first; none otherwise", () => {
    const b = board({
      inMotion: [card("s", { stage: "Signed", last_activity_at: iso(1) }), card("old", { stage: "Signed", last_activity_at: iso(9) }), card("neg", { stage: "Negotiating", last_activity_at: iso(1) })],
      whatMatters: [card("s", { stage: "Signed", last_activity_at: iso(1) }), card("a", { stage: "Agreed", last_activity_at: iso(3) })],
    });
    const posts: AgentWinPost[] = [{ id: "p1", at: iso(2), platform: "instagram", format: "carousel", ratio: 3.4, metric: "saves", conversationId: null }];
    const wins = winStories(b, posts, NOW);
    expect(wins.map((w) => w.id)).toEqual(["win:deal:s", "win:post:p1", "win:deal:a"]);
    expect(wins[0]).toMatchObject({ title: "You signed with Brand s", action: { label: "Make another like it" } });
    expect(wins[1]).toMatchObject({ title: "Your carousel is taking off", line: "3.4× your usual saves" });
    expect(wins[2].title).toBe("You agreed terms with Brand a");
    expect(winStories(board(), [], NOW)).toEqual([]);
  });

  it("circles: This week, Offers, Moments always; Bookings and Wins only when there is one; badges count what needs her", () => {
    const empty = buildCircles({ week: [], offers: [], moments: [], wins: [] });
    expect(empty.map((c) => [c.key, c.badge])).toEqual([["week", null], ["offers", null], ["moments", null]]);
    const w = weekStory(action("a"));
    const full = buildCircles({ week: [w, weekStory(action("b"))], offers: [w], moments: [w], wins: [w] });
    expect(full.map((c) => [c.key, c.badge, c.tone])).toEqual([["week", 2, "pink"], ["offers", 1, "pink"], ["moments", null, "pink"], ["wins", null, "gold"]]);
    // A booking request is its own circle, after Offers: a deal and someone booking her time are different decisions.
    const offers = offerStories(board({ needsYou: [card("o1")] }), [booking("b1")], NOW);
    const withBookings = buildCircles({ week: [], offers, moments: [], wins: [] });
    expect(withBookings.map((c) => [c.key, c.badge, c.items.map((i) => i.id)])).toEqual([
      ["week", null, []], ["offers", 1, ["offer:o1"]], ["bookings", 1, ["booking:b1"]], ["moments", null, []],
    ]);
  });

  it("Moments badge counts the moments that need her: soon (14 days) and nothing prepared yet", () => {
    const g = goals([], { comingUp: [moment("near", { date: day(3) }), moment("ready", { date: day(5), kitActionId: "k1" }), moment("far", { date: day(30) })] });
    const ms = momentStories(g, NOW);
    expect(ms.map((m) => [m.id, m.needsHer])).toEqual([["moment:near", true], ["moment:ready", false], ["moment:far", false]]);
    expect(buildCircles({ week: [], offers: [], moments: ms, wins: [] }).find((c) => c.key === "moments")!.badge).toBe(1);
  });

});

// ── H2 ───────────────────────────────────────────────────────────────────────

describe("H2 Mila's briefing", () => {
  const week = [weekStory(action("a1", { dueOn: day(0), event: { factId: "f", label: "the away game", date: day(4), precision: "day" } }), NOW)];
  const overdue = offerStories(board({ needsYou: [card("o1", { overdue: true, her_move_since: iso(5) })] }), null, NOW);
  const waiting = offerStories(board({ needsYou: [card("o2"), card("o3")] }), null, NOW);
  const moments = momentStories(goals([], { comingUp: [moment("m1")] }), NOW);
  const base = { week: [], offers: [], moments: [], wins: [], suggestion: null, later: new Set<string>(), hour: 9, firstName: "Sam" };

  it("needs-you first, ONE offer while other kinds have something to say, then a post, then a moment; the rest point at the circles", () => {
    const b = briefing({ ...base, week, offers: [...overdue, ...waiting], moments });
    expect(b.messages.map((m) => [m.kind, m.id])).toEqual([["offer", "offer:o1"], ["post", "week:a1"], ["moment", "moment:m1"]]);
    expect(b.messages).toHaveLength(BRIEFING_MAX);
    // o2 and o3 are left out, pointed at the circles (the moment needs nothing, so it is not counted).
    expect(b.overflow).toBe(2);
  });

  it("two offers back to back only when offers are all there is", () => {
    const b = briefing({ ...base, offers: [...overdue, ...waiting] });
    expect(b.messages.map((m) => m.id)).toEqual(["offer:o1", "offer:o2"]);
    expect(b.overflow).toBe(1);
  });

  it("an offer's card: brand name, the ask, a quiet meta line with when they wrote — never a day count", () => {
    const o = offerStories(board({ needsYou: [card("q", { overdue: true, her_move_since: "2026-09-25T15:00:00.000Z", via: "Agencyco" } as any)] }), null, NOW);
    const [m] = briefing({ ...base, offers: o }).messages;
    expect(m.card.name).toBe("Brand q");
    expect(m.card.meta).toBe("via Agencyco · Sent 25 Sep");
    expect(JSON.stringify(m.card)).not.toMatch(/\d+ days?/i);
  });

  it("the first message opens with the greeting by the hour; one sentence each", () => {
    const b = briefing({ ...base, week, offers: overdue });
    expect(b.messages[0].text).toBe("Morning, Sam — Brand o1 is waiting on your reply.");
    expect(b.messages[1].text).toBe("Your reel for today is ready.");
    expect(briefing({ ...base, week, hour: 20 }).messages[0].text).toBe("Evening, Sam — your reel for today is ready.");
    expect(briefing({ ...base, week, hour: 14, firstName: null }).messages[0].text).toBe("Afternoon — your reel for today is ready.");
  });

  it("an offer's chips: Draft a reply (asks Mila, she still taps Send), Not for me (its own sheet), Later", () => {
    const [m] = briefing({ ...base, offers: overdue }).messages;
    expect(m.chips.map((c) => [c.label, c.act.kind])).toEqual([["Draft a reply", "ask"], ["Not for me", "not_for_me"], ["Later", "later"]]);
    expect(m.chips[0]).toMatchObject({ primary: true, act: { prompt: "Draft a reply to Brand o1 for me." } });
    expect(m.chips[1].act).toEqual({ kind: "not_for_me", dealId: "d-o1", threadId: null, brandName: "Brand o1" });
    expect(m.open).toEqual({ kind: "open", target: { screen: "opportunity", opportunityId: "o1", dealId: "d-o1" } });
  });

  it("past two weeks an offer asks whether she is still interested; it never counts days", () => {
    const stale = offerStories(board({ needsYou: [card("o", { overdue: true, her_move_since: iso(24) })] }), null, NOW);
    const [m] = briefing({ ...base, offers: stale, firstName: null }).messages;
    expect(m.text).toBe("Morning — it's been 3 weeks since Brand o heard from you. Still interested?");
    expect(m.text).not.toMatch(/\d+ days/);
  });

  it("an offer whose terms name the ask reads '<brand> wants <ask>' when not overdue", () => {
    const o = offerStories(board({ needsYou: [card("p", { terms: { fee: { amount: 1500 }, deliverables: [{ kind: "ig_reel" }], unknown: [] } } as any)] }), null, NOW);
    expect(briefing({ ...base, offers: o, firstName: null }).messages[0].text).toBe("Morning — Brand p wants a Reel.");
  });

  it("a booking: Answer opens it; a win: Make another asks Mila; a moment with nothing prepared: Make this post asks Mila", () => {
    const bk = offerStories(null, [booking("b1")], NOW);
    const bm = briefing({ ...base, offers: bk }).messages[0];
    expect(bm).toMatchObject({ kind: "booking", text: "Morning, Sam — someone wants to book you: Video call." });
    expect(bm.chips[0].act).toEqual({ kind: "open", target: { screen: "booking", bookingId: "b1" } });
    const wins = winStories(null, [{ id: "p1", at: iso(1), platform: "instagram", format: "reel", ratio: 3, metric: "views", conversationId: null }], NOW);
    const wm = briefing({ ...base, wins }).messages[0];
    expect(wm.kind).toBe("win");
    expect(wm.chips[0].act.kind).toBe("ask");
    const mm = briefing({ ...base, moments }).messages[0];
    expect(mm).toMatchObject({ kind: "moment", text: "Morning, Sam — Moment m1 is Thu 29 Oct. Want to post for it?" });
    expect(mm.chips.map((c) => [c.label, c.act.kind])).toEqual([["Make this post", "ask"], ["Not now", "later"]]);
  });

  it("a brand paying her is good news: '<Brand> paid you $X.'; See it opens Financials, Say thanks asks Mila (she sends it)", () => {
    const wins = winStories(null, null, NOW, [{ id: "t1", at: iso(2), brand: "Payerco", cents: 500000, currency: "usd", dealId: "d1" }]);
    expect(wins).toEqual([expect.objectContaining({ id: "win:pay:t1", circle: "wins", title: "Payerco paid you $5,000", action: expect.objectContaining({ target: { screen: "financials" } }) })]);
    const [m] = briefing({ ...base, wins, firstName: null }).messages;
    expect(m).toMatchObject({ kind: "win", text: "Morning — Payerco paid you $5,000." });
    expect(m.chips.map((c) => [c.label, c.act.kind])).toEqual([["See it", "open"], ["Say thanks", "ask"], ["Later", "later"]]);
    expect(m.chips[1].act).toEqual({ kind: "ask", prompt: "Draft a short thank-you to Payerco for their payment." });
    // No payer name: nothing to thank, so See it only (and no zero-amount wins).
    const anon = winStories(null, null, NOW, [{ id: "t2", at: iso(1), brand: "", cents: 100, currency: "usd", dealId: null }, { id: "t3", at: iso(1), brand: "X", cents: 0, currency: "usd", dealId: null }]);
    expect(anon.map((w) => w.title)).toEqual(["A brand paid you $1"]);
    expect(briefing({ ...base, wins: anon }).messages[0].chips.map((c) => c.label)).toEqual(["See it", "Later"]);
  });

  it("'Later' hides an item for today; the next one takes its place", () => {
    const b = briefing({ ...base, offers: overdue, week, later: new Set(["offer:o1"]) });
    expect(b.messages.map((m) => m.id)).toEqual(["week:a1"]);
    expect(b.overflow).toBe(0);
  });

  it("a quiet day is one idea: Mila's open suggestion (its chat), else an ask for one", () => {
    expect(briefing({ ...base, suggestion }).messages).toEqual([expect.objectContaining({ kind: "idea", item: null, open: { kind: "chat", conversationId: "conv-9" } })]);
    const q = briefing(base).messages[0];
    expect(q).toMatchObject({ kind: "idea", text: "Morning, Sam — quiet day. Want an idea for your next post?", open: { kind: "ask" } });
    expect(briefing({ ...base, later: new Set(["idea"]) }).messages).toEqual([]);
  });

  it("names only items the circles show (every case of the whole model)", () => {
    const g = goals([action("a1"), action("a2", { dueOn: day(30) })], { comingUp: [moment("m1"), moment("hidden", { date: day(90) })] });
    const b = board({ needsYou: [card("o1", { overdue: true }), card("c1", { next: { action: "confirm_signed", label: "x", why: "", due: null, hers: true } })] });
    const cases: HomeV3Inputs[] = [
      inputs({ goals: g, board: b }), inputs({ goals: g }), inputs({ board: b }),
      inputs({ bookingRequests: [booking("b1", { respondBy: iso(-0.01) })] }), inputs({ next: [suggestion] }), inputs(),
    ];
    for (const c of cases) {
      const m = homeV3Model(c);
      const br = briefing({ ...m.parts, later: new Set(), hour: 9, firstName: null });
      for (const msg of br.messages) {
        if (msg.item) expect(m.shownIds.has(msg.item.id)).toBe(true);
        expect(msg.text).not.toMatch(/Post a2|Moment hidden|Brand c1/);
      }
    }
  });

  it("first name and the stored Later list", () => {
    expect(firstNameOf("sam lee")).toBe("Sam");
    expect(firstNameOf("  ")).toBeNull();
    expect([...parseLater(JSON.stringify({ day: "2026-10-19", ids: ["a", 3] }), "2026-10-19")]).toEqual(["a"]);
    expect(parseLater(JSON.stringify({ day: "2026-10-18", ids: ["a"] }), "2026-10-19").size).toBe(0);
    expect(parseLater("not json", "2026-10-19").size).toBe(0);
  });
});

// ── H3 ───────────────────────────────────────────────────────────────────────

describe("H3 seen / unseen", () => {
  const items = [weekStory(action("a")), weekStory(action("b"))];
  const circle = { items, tone: "pink" as const };

  it("a coloured ring while anything in it is unseen, grey once all are seen, grey when empty", () => {
    expect(ringState(circle, new Set())).toBe("pink");
    expect(ringState(circle, new Set(["week:a"]))).toBe("pink");
    expect(ringState(circle, new Set(["week:a", "week:b"]))).toBe("seen");
    expect(ringState({ items, tone: "gold" }, new Set())).toBe("gold");
    expect(ringState({ items: [], tone: "pink" }, new Set())).toBe("seen");
  });

  it("a circle opens at its first unseen story; a new item makes a seen circle new again", () => {
    expect(firstUnseenIndex(items, new Set(["week:a"]))).toBe(1);
    expect(firstUnseenIndex(items, new Set(["week:a", "week:b"]))).toBe(0);
    const seen = new Set(["week:a", "week:b"]);
    expect(ringState({ items: [...items, weekStory(action("c"))], tone: "pink" }, seen)).toBe("pink");
  });

  it("marking seen adds ids and prunes to the items still live; the stored list parses defensively", () => {
    expect([...markSeen(new Set(["x"]), ["week:a"])]).toEqual(["x", "week:a"]);
    expect([...markSeen(new Set(["gone"]), ["week:a"], new Set(["week:a", "week:b"]))]).toEqual(["week:a"]);
    expect([...parseSeen(JSON.stringify(["a", 3, "b"]))]).toEqual(["a", "b"]);
    expect(parseSeen("{not json").size).toBe(0);
    expect(parseSeen(null).size).toBe(0);
    expect(parseSeen(JSON.stringify({ a: 1 })).size).toBe(0);
  });

  it("the phone keeps only the newest seen ids", () => {
    expect([...capSeen(new Set(["a", "b", "c", "d"]), 2)]).toEqual(["c", "d"]);
    expect([...capSeen(new Set(["a"]), 2)]).toEqual(["a"]);
  });
});

// ── H4 ───────────────────────────────────────────────────────────────────────

describe("H4 admin row and checklist", () => {
  const contract = card("c1", { next: { action: "confirm_signed", label: "Confirm it’s signed", why: "", due: null, hers: true } });
  const payout: NextCandidate = { ...suggestion, key: "payout_setup", kind: "payout_setup", amountCents: 62500, currency: "usd", target: { screen: "financials" } };

  it("blocking first (contract, payouts owed, a broken connection), then setup with its done state", () => {
    const items = setupItems({
      board: board({ needsYou: [contract] }),
      next: [payout],
      connections: [{ platform: "tiktok", status: "expired" }, { platform: "instagram", status: "active" }],
      push: "undetermined",
    });
    expect(items.map((i) => [i.id, i.blocking, i.done])).toEqual([
      ["contract:c1", true, false], ["payouts", true, false], ["reconnect:tiktok", true, false],
      ["notifications", false, false], ["connect:instagram", false, true], ["connect:inbox", false, false],
    ]);
    expect(items[1].title).toBe("Set up payouts: $625 is waiting for you");
    expect(items[2].title).toBe("Reconnect TikTok");
  });

  it("at most ONE row, the first blocking item, with +N counting every other item still to do", () => {
    const items = setupItems({ board: board({ needsYou: [contract] }), next: [payout], connections: [{ platform: "instagram", status: "active" }], push: "granted" });
    const row = adminRowOf(items)!;
    expect(row.item.id).toBe("contract:c1");
    // payouts + connect:inbox are still to do (notifications and Instagram are done).
    expect(row.more).toBe(2);
    expect(checklistProgress(items)).toEqual({ done: 2, total: 5 });
  });

  it("no row when nothing blocks, however much setup is left; the badge counts that setup", () => {
    const items = setupItems({ board: null, next: [], connections: [], push: "denied" });
    expect(adminRowOf(items)).toBeNull();
    expect(setupBadge(items)).toBe(3);
    expect(items.find((i) => i.id === "notifications")?.target).toEqual({ screen: "settings" });
  });

  it("a platform with a working connection too is not broken; notifications unavailable is not asked", () => {
    const items = setupItems({ board: null, next: [], connections: [{ platform: "gmail", status: "revoked" }, { platform: "gmail", status: "active" }], push: "unavailable" });
    expect(items.map((i) => i.id)).toEqual(["connect:instagram", "connect:inbox"]);
    expect(items.find((i) => i.id === "connect:inbox")?.done).toBe(true);
  });

  it("the row reads +0 as no link (one blocking item, nothing else)", () => {
    const only: SetupItem[] = [{ id: "payouts", title: "t", button: "Set up", target: { screen: "financials" }, done: false, blocking: true }];
    expect(adminRowOf(only)).toEqual({ item: only[0], more: 0 });
  });
});

// ── H5 ───────────────────────────────────────────────────────────────────────

describe("H5 design review fixes", () => {
  it("a post is titled by itself: its hook; a long hook's first sentence; else the title without a chore verb", () => {
    expect(postTitle({ title: "Review your captaincy portrait", post: { hook: "Next up: the road game." } as any })).toBe("Next up: the road game.");
    const long = `${"A first sentence that is short enough."} ${"x".repeat(100)}`;
    expect(postTitle({ title: "t", post: { hook: long } as any })).toBe("A first sentence that is short enough.");
    expect(postTitle({ title: "Review your captaincy portrait", post: { hook: "" } as any })).toBe("Captaincy portrait");
    expect(postTitle({ title: "Share a learning question in Stories", post: null })).toBe("Learning question in Stories");
    expect(postTitle({ title: "Game day recap", post: null })).toBe("Game day recap");
  });

  it("relative days: Today, Tomorrow, else the weekday", () => {
    expect(relativeDay(day(0), NOW)).toBe("Today");
    expect(relativeDay(day(1), NOW)).toBe("Tomorrow");
    expect(relativeDay(day(3), NOW)).toBe("Thu");
    expect(weekStory(action("t", { dueOn: day(0) }), NOW).kicker).toBe("Today · Reel");
  });

  it("a company's display name drops legal and regional tails, never the name itself", () => {
    expect(displayBrandName("adidas America Inc.")).toBe("adidas");
    expect(displayBrandName("Acme Holdings, LLC")).toBe("Acme");
    expect(displayBrandName("Bank of America")).toBe("Bank of America");
    expect(displayBrandName("Nike")).toBe("Nike");
    expect(displayBrandName("Inc.")).toBe("Inc.");
  });

  it("the ask and the fee in words, from the term sheet", () => {
    expect(askWords({ deliverables: [{ kind: "ig_reel" }, { kind: "ig_story", count: 2 }] })).toBe("a Reel and 2 stories");
    expect(askWords({ deliverables: [{ kind: "ig_post" }, { kind: "appearance_hour" }, { kind: "ugc", count: 3 }] })).toBe("a post, an appearance and 3 pieces of content");
    expect(askWords({})).toBeNull();
    expect(feeWords({ fee: { amount: 5000, currency: "usd" } })).toBe("$5,000");
    expect(feeWords({ fee: { amount: 1200, currency: "eur" } })).toBe("1,200 EUR");
    expect(feeWords({})).toBeNull();
  });

  it("who an offer is from: a brand by its display name; a person with where they write from (never a free mail domain)", () => {
    expect(offerWho(card("x", { brand: { ...card("x").brand, name: "adidas America Inc." } }))).toBe("adidas");
    expect(offerWho(card("x", { brand: { ...card("x").brand, name: "Sam Lee", is_person: true, domain: "acme.com" } }))).toBe("Sam Lee at acme.com");
    expect(offerWho(card("x", { brand: { ...card("x").brand, name: "Sam Lee", is_person: true, domain: "gmail.com" } }))).toBe("Sam Lee");
  });

  it("an offer story is a poster (name, fee, ask) titled '<brand> wants <ask>' when the ask is known", () => {
    const b = board({ needsYou: [card("p", { terms: { fee: { amount: 1500 }, deliverables: [{ kind: "ig_reel" }], unknown: [] } })] });
    const [o] = offerStories(b, null, NOW);
    expect(o).toMatchObject({ title: "Brand p wants a Reel", poster: { name: "Brand p", amount: "$1,500", ask: "a Reel" } });
  });

  it("Offers puts what is overdue first, so Mila's briefing starts at Offers 1 of N", () => {
    const b = board({ needsYou: [card("fresh"), card("late", { overdue: true, her_move_since: iso(5) })] });
    const m = homeV3Model(inputs({ board: b }));
    const offers = m.circles.find((c) => c.key === "offers")!;
    expect(offers.items.map((i) => i.id)).toEqual(["offer:late", "offer:fresh"]);
    expect(briefing({ ...m.parts, later: new Set(), hour: 9, firstName: null }).messages[0].id).toBe(offers.items[0].id);
  });

  it("a moment's date face: weekday over day; a month-only date, its year over the month", () => {
    expect(dateFace({ date: day(5), precision: "day" })).toEqual({ top: "SAT", big: "24" });
    expect(dateFace({ date: "2026-12-01", precision: "month" })).toEqual({ top: "2026", big: "Dec" });
    expect(momentStories(goals([], { comingUp: [moment("m")] }), NOW)[0].dateFace).toEqual({ top: "THU", big: "29" });
  });

  it("badges show the real count; all-done setup has no checklist", () => {
    expect(badgeText(11)).toBe("11");
    expect(badgeText(120)).toBe("99+");
    const done: SetupItem[] = [{ id: "n", title: "t", button: "b", target: { screen: "push" }, done: true, blocking: false }];
    expect(setupDone(done)).toBe(true);
    expect(setupDone([...done, { ...done[0], id: "x", done: false }])).toBe(false);
  });

  it("Me: the identity line's parts start with a capital; the plan tile's live fact", () => {
    expect(capitalizeParts("Stanford Soccer · midfielder · Senior")).toBe("Stanford Soccer · Midfielder · Senior");
    expect(capitalizeParts(null)).toBeNull();
    expect(planTileMeta(2, 3)).toBe("2 goals · 3 posts ready");
    expect(planTileMeta(1, 0)).toBe("1 goal");
    expect(planTileMeta(0, 0)).toBe("Your goals and this week");
  });
});


describe("moment pictures and the hero's brand colour", () => {
  const withMoments = (ms: any[]) => goals([], { moments: ms } as any);
  const mv = (id: string, over: any = {}) => ({ factId: id, name: `Moment ${id}`, date: day(5), precision: "day", category: "holiday_awareness", hook: "Light the lamps.", angle: null, whyNow: "Fans celebrate", actionsReady: 0, kitActionId: null, ...over });

  it("reads a moment's kind back to its category (the card's colours and glyph)", () => {
    const [h, l] = momentStories(withMoments([mv("a"), mv("b", { category: "league" })]), NOW);
    expect(momentCategoryOf(h)).toBe("holiday_awareness");
    expect(momentCategoryOf(l)).toBe("league");
    expect(momentCategoryOf({ moment: null })).toBe("schedule");
  });

  it("asks the atmosphere picker for moments with nothing prepared only: no people, its kind and name as purpose", () => {
    const stories = momentStories(withMoments([mv("a"), mv("b", { kitActionId: "k1" })]), NOW);
    const slots = momentAtmosphereSlots(stories);
    expect(slots).toEqual([{ key: "moment:a", type: "suggestion", purpose: "Holiday: Moment a", context: "Fans celebrate", category: "holiday_awareness" }]);
    expect(momentAtmosphereSlots(Array.from({ length: 20 }, (_, i) => ({ ...stories[0], id: `moment:x${i}` }))).length).toBe(12);
  });

  it("carries the brand's colour onto its offer (the hero card is drawn on it), null when the board has none", () => {
    const [o] = offerStories(board({ needsYou: [card("o1", { brand: { ...card("o1").brand, color: "#8A1C22" } })] }), [], NOW);
    expect(o.brandColor).toBe("#8A1C22");
    const [n] = offerStories(board({ needsYou: [card("o2")] }), [], NOW);
    expect(n.brandColor).toBeNull();
  });
});
