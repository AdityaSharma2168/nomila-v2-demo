/**
 * DealsGalleryScreen — DEV ONLY (web, `__DEV__` and EXPO_PUBLIC_OPPS_V2 both on; App.tsx mounts it at /deals-gallery
 * before sign-in). The OPPS_V2 deal and booking screens drawn from typed fixtures on a pre-filled query cache, so they
 * can be reviewed and screenshotted at phone width without signing in or a server. Nothing here ships in a production
 * bundle path: App.tsx only reaches it under __DEV__. The fixtures are sample data for review, never product logic.
 *
 *   /deals-gallery?s=board | bookings-empty | bk-requests | bk-sessions | detail-interview | detail-paid | detail-closed | all-deals | all-bookings | rates
 */
import React, { useMemo } from "react";
import { Platform } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { OpportunitiesScreen } from "../OpportunitiesScreen";
import { OpportunityDetailScreen } from "../OpportunityDetailScreen";
import { AllDealsScreen } from "../AllDealsScreen";
import { YourRatesScreen } from "../me/YourRatesScreen";
import { OPPORTUNITY_BOARD_KEY, type BoardItem, type OpportunityBoard } from "../../hooks/use-opportunity-board";
import { opportunityDetailKey, type OpportunityDetail } from "../../hooks/use-opportunity-detail";
import { brandPageKey } from "../../hooks/use-brand-page";
import { searchPath, DEAL_SEARCH_KEY, BOOKING_SEARCH_KEY, type DealSearchResult, type BookingSearchResult } from "../../hooks/use-deal-search";
import { RATES_KEY, type RatesView } from "../../hooks/use-rates";
import { FINANCIALS_KEY, BOOKINGS_SUMMARY_KEY, NO_MONEY } from "../../hooks/use-financials";
import { INTENTS_BY_TYPE, REPLY_INTENT_LABEL, type DealType } from "../../../shared/deals";
import type { BookingsSummary } from "../../../shared/meSummaries";

const acts = (t: DealType) => INTENTS_BY_TYPE[t].map((intent) => ({ intent, label: REPLY_INTENT_LABEL[intent] }));
const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

const brand = (name: string, over: Partial<BoardItem["brand"]> = {}): BoardItem["brand"] => ({
  id: 1, name, logo_url: null, category: null, tier: null, research_confirmed: false, image_url: null, safe_logo_url: null, is_person: false, domain: null, ...over,
});

const item = (id: string, over: Partial<BoardItem>): BoardItem => ({
  opportunity_id: id, brand: brand("Brand"), deal_ids: [`d-${id}`], lead_deal_id: `d-${id}`, lead_thread_id: `t-${id}`,
  qualification: "workable", state: "cash", kind: "deal", kind_label: null, poster: "paid", whats_new: null, stage: null,
  message_count: 1, via: null, channel: "direct", standing: "none", line: "", awaiting_response_from: "athlete",
  her_move_since: daysAgo(3), overdue: false, going_quiet: false, started_at: daysAgo(3), last_activity_at: daysAgo(3),
  brand_rollup: null, brand_opportunity_ids: [id], next: { action: "reply", label: "Reply", why: "", due: null, hers: true }, ...over,
});

const INTERVIEW = item("o-int", {
  brand: brand("Harrison Szep", { is_person: true }), kind: "interview", kind_label: "Interview", poster: "request", qualification: "workable",
  line: "Interview request · Their ask: collaborate on day-in-the-life video content · Waiting on you since Sep 25",
  overdue: true, her_move_since: daysAgo(17), started_at: daysAgo(17), dealType: "press", actions: acts("press"),
  read: {
    money: { line: "Unpaid: they’re asking for your time.", state: "unpaid", source: "Their email, 25 Sep" },
    fit: null,
    risk: { line: "Couldn’t confirm who this is.", flags: ["unverified_identity"], source: "Identity check" },
    goal: null,
  },
  terms: { unknown: ["deliverables"] },
});
const PAID = item("o-paid", {
  brand: brand("Gymshark", { domain: "gymshark.com", category: "Fitness apparel" }), state: "cash", line: "$1,400 · 2 Reels · above your minimum",
  dealType: "paid_content", actions: acts("paid_content"), message_count: 3,
  read: {
    money: { line: "About $700 a Reel: above your minimum, inside your suggested range.", state: "above_min", source: "Their email, 10 Oct" },
    fit: { line: "Training content is their core audience.", source: "Nomila’s research · confirmed brand" },
    risk: { line: "Nothing to flag.", flags: [], source: "Checked against your partners" },
    goal: { line: "Helps “bigger brand partners”.", source: "Your goals" },
  },
  terms: { fee: { amount: 1400, unit: "flat" }, deliverables: [{ kind: "ig_reel", count: 2 }], usage: { paid: true, months: 12 }, unknown: ["approvalRounds", "payment"] },
});
const NEEDS = item("o-needs", {
  brand: brand("On Running", { domain: "on.com" }), state: "needs_terms", qualification: "needs_terms", line: "Their ask: a launch-week post · no fee yet",
  dealType: "paid_no_fee", actions: acts("paid_no_fee"), next: { action: "ask_for_terms", label: "Ask for terms", why: "", due: null, hers: true },
});
const CLOSED = item("o-closed", {
  brand: brand("Nuun", { domain: "nuunlife.com" }), state: "product", poster: "product", line: "Sample + post", dealType: "gift", actions: acts("gift"),
  read: {
    money: { line: "Product only (~$150).", state: "product_only", source: "Their email, 8 Oct" },
    fit: { line: "Hydration fits your training days.", source: "Nomila’s research · confirmed brand" },
    risk: { line: "Nothing to flag.", flags: [], source: "Checked against your partners" },
    goal: null,
  },
});

const BOARD: OpportunityBoard = {
  seriousOffers: [], needsYou: [INTERVIEW, NEEDS, PAID], whatMatters: [INTERVIEW, NEEDS, PAID], needsTermsBatch: [], goingQuiet: [],
  inMotion: [], explore: [item("o-x", { brand: brand("NextGen Prospects"), line: "Product only, no cash · Waiting on you since Aug 29" })],
  toVerify: [], order: [], counts: { open: 4, inMotion: 0, toVerify: 0, filed: 115, needsYou: 3 },
};

const detail = (it: BoardItem, over: Partial<OpportunityDetail> = {}): OpportunityDetail => ({
  item: it, ask: null, reasons: [], unknowns: [], take: "", primary: { action: "reply", label: "Reply" }, secondary: [{ action: "decline", label: "Decline" }],
  draft: null, terms: null, looks_signed: false, signed_evidence: [], signed_target_deal_id: null, signed: null, contract_candidate: null,
  has_contract: false, lead_deal_id: it.lead_deal_id, lead_thread_id: it.lead_thread_id, read: it.read,
  deck: { confirmed: it.brand.research_confirmed, name: it.brand.name, category: it.brand.category, description: null, audience: null, sports: [], athletes: [], images: [],
    unconfirmed_reason: it.brand.is_person ? "A person, not a company: there is no brand research to show." : "Nomila couldn’t confirm who this is yet." },
  ...over,
});

const SEARCH: DealSearchResult = {
  q: "", tab: "active", type: null, tabs: { active: 4, done: 2, closed: 7 },
  types: [{ type: "gift", label: "Gift", count: 2 }, { type: "paid_content", label: "Paid content", count: 1 }, { type: "press", label: "Press", count: 1 }],
  not_a_deal: 0, total: 4,
  rows: [
    { opportunity_id: "o-paid", brand: { ...PAID.brand, safe_logo_url: null }, via: null, dealType: "paid_content", type_label: "Paid content", money: "$1,400 for 2 Reels", ask: "2 Reels in November", status_label: "Waiting on you", tab: "active", closed_group: null, last_activity_at: daysAgo(2), closed_at: null },
    { opportunity_id: "o-int", brand: INTERVIEW.brand, via: null, dealType: "press", type_label: "Press", money: "Unpaid: they’re asking for your time.", ask: "collaborate on day-in-the-life video content", status_label: "Waiting on you", tab: "active", closed_group: null, last_activity_at: daysAgo(17), closed_at: null },
    { opportunity_id: "o-x", brand: brand("MUD\\WTR"), via: null, dealType: "gift", type_label: "Gift", money: "Product only, no cash", ask: null, status_label: "Waiting on you", tab: "active", closed_group: null, last_activity_at: daysAgo(6), closed_at: null },
    { opportunity_id: "o-closed", brand: CLOSED.brand, via: null, dealType: "gift", type_label: "Gift", money: "$400 + gifting box", ask: null, status_label: "Waiting on them", tab: "active", closed_group: null, last_activity_at: daysAgo(5), closed_at: null },
  ],
};
const BSEARCH: BookingSearchResult = {
  q: "", tab: "active", tabs: { active: 2, done: 1, closed: 0 }, formats: [{ format: "video_call", label: "Video call", count: 1 }, { format: "clinic", label: "Clinic", count: 1 }], total: 2,
  rows: [
    { id: "b1", title: "Video call", format: "video_call", format_label: "Video call", buyer: "Jordan P.", starts_at: new Date(now + 5 * 86_400_000).toISOString(), duration_minutes: 30, price_cents: 6000, currency: "usd", status: "requested", status_label: "Waiting for you", tab: "active", updated_at: daysAgo(0) },
    { id: "b2", title: "Group clinic", format: "clinic", format_label: "Clinic", buyer: "Riverside FC U14", starts_at: new Date(now + 13 * 86_400_000).toISOString(), duration_minutes: 90, price_cents: 48000, currency: "usd", status: "confirmed", status_label: "Confirmed", tab: "active", updated_at: daysAgo(1) },
  ],
};
const SUMMARY: BookingsSummary = {
  version: "bookings-summary/0.1", published: true, publishedOffers: 2,
  requests: [{ id: "b1", title: "Video call · 30 min · Jordan P.", format: "video_call", status: "requested", priceCents: 6000, currency: "usd", startsAt: new Date(now + 5 * 86_400_000).toISOString(), respondBy: null, createdAt: daysAgo(0) }],
  upcoming: [{ id: "b2", title: "Group clinic · Riverside FC U14", format: "clinic", status: "accepted", priceCents: 48000, currency: "usd", startsAt: new Date(now + 13 * 86_400_000).toISOString(), respondBy: null, createdAt: daysAgo(1) }],
};
const RATES: RatesView = {
  bookings_enabled: true,
  note: "Mila's first estimates, from what you shared when you joined. Ranges, not quotes, and they sharpen as Nomila learns more. Your minimums are private: never shown to a brand.",
  rows: [
    { rate_type: "ig_reel", group: "content", label: "Instagram Reel", suggested: { low: 350, high: 550, currency: "usd", confidence: "medium", drivers: ["Your audience size and engagement", "Rates for athletes at a similar stage"], based_on: "what you shared when you joined", source: "Onboarding estimate", shown_at: daysAgo(30) }, minimum: { value: 400, source: "set" }, price: null, guard: null },
    { rate_type: "ig_post", group: "content", label: "Instagram feed post", suggested: { low: 250, high: 400, currency: "usd", confidence: "medium", drivers: [], based_on: "what you shared when you joined", source: "Onboarding estimate", shown_at: daysAgo(30) }, minimum: null, price: null, guard: null },
    { rate_type: "appearance_in_person_hour", group: "time", label: "Appearance · per hour", suggested: { low: 300, high: 600, currency: "usd", confidence: "low", drivers: [], based_on: "what you shared when you joined", source: "Onboarding estimate", shown_at: daysAgo(30) }, minimum: { value: 350, source: "set" }, price: null, guard: null },
    { rate_type: "booking_video_call_30", group: "booking", label: "Video call · 30 min", suggested: { low: 60, high: 120, currency: "usd", confidence: "medium", drivers: [], based_on: "what you shared when you joined", source: "Onboarding estimate", shown_at: daysAgo(30) }, minimum: null, price: { cents: 9000, offer_id: "of1", duration_minutes: 30, status: "published" }, guard: null },
    { rate_type: "booking_appearance", group: "booking", label: "Appearance", suggested: null, minimum: null, price: { cents: 20000, offer_id: "of2", duration_minutes: 120, status: "published" },
      guard: { below_minimum: true, minimum: 350, against: "appearance_in_person_hour", compared: "per_hour", line: "Your public price works out to $100 an hour, under your private minimum of $350 an hour for appearances. A brand could book you at the lower price." } },
  ],
};

function seed(page: string): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { queryFn: async () => null, retry: false, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false } } });
  qc.setQueryData([OPPORTUNITY_BOARD_KEY], BOARD);
  qc.setQueryData(FINANCIALS_KEY, { ...NO_MONEY, hasMoney: true, comingCents: 245000, paidMonthCents: 120000 });
  qc.setQueryData(BOOKINGS_SUMMARY_KEY, page === "bookings-empty" ? { ...SUMMARY, published: false, requests: [], upcoming: [] } : SUMMARY);
  qc.setQueryData(["/api/v1/me/connections"], { connections: [] });
  qc.setQueryData(["/api/v1/me/deals?view=active"], []);
  qc.setQueryData(["/api/v1/me/preferences"], { deal_preferences: { agent_name: "Alex Chen", agent_role: "Manager" } });
  for (const [it, over] of [[INTERVIEW, { ask: "collaborate on day-in-the-life video content", unknowns: ["where it runs", "dates"] }], [PAID, { ask: "2 Reels in November, 12 months’ paid usage." }], [NEEDS, {}], [CLOSED, { read_only: true, closed: { reason: "declined", at: daysAgo(4) }, secondary: [] }]] as const) {
    qc.setQueryData([opportunityDetailKey(it.opportunity_id)], detail(it, over as Partial<OpportunityDetail>));
    qc.setQueryData([brandPageKey(it.opportunity_id)], { brand: { id: 1, name: it.brand.name }, sections: [], open_section: null });
  }
  qc.setQueryData([searchPath(DEAL_SEARCH_KEY, { q: "", tab: "active", filter: null, filterKey: "type" })], SEARCH);
  qc.setQueryData([searchPath(BOOKING_SEARCH_KEY, { q: "", tab: "active", filter: null, filterKey: "format" })], BSEARCH);
  qc.setQueryData([RATES_KEY], RATES);
  // The one-look Bookings screen (Business › Bookings) on the shared fixtures.
  const soon = (d: number, h: number) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  qc.setQueryData([...BOOKINGS_KEY, "summary"], summaryFixture({ requests: 2 }));
  qc.setQueryData([...BOOKINGS_KEY, "list", "requests"], [
    listItemFixture({ id: "b1", buyerLabel: "Jordan P.", title: "1:1 video call · 30 min", startsAt: soon(2, 16), endsAt: soon(2, 17), respondBy: new Date(Date.now() + 18 * 3_600_000).toISOString(), receiveCents: 5000 }),
    listItemFixture({ id: "b2", buyerLabel: "Alex R.", title: "1:1 video call · 30 min", startsAt: null, endsAt: null, proposedTimes: [{ start: soon(3, 18), tz: null }, { start: soon(4, 18), tz: null }], respondBy: new Date(Date.now() + 50 * 3_600_000).toISOString(), receiveCents: 5000 }),
  ]);
  qc.setQueryData([...BOOKINGS_KEY, "list", "upcoming"], []);
  qc.setQueryData([...BOOKINGS_KEY, "list", "past"], []);
  qc.setQueryData([...BOOKINGS_KEY, "offers"], [offerFixture({ id: "o1", title: "1:1 video call · 30 min", status: "published" }), offerFixture({ id: "o2", title: "In-person session · 60 min", format: "clinic", status: "draft" })]);
  qc.setQueryData([...BOOKINGS_KEY, "slots", "o1"], [3, 4, 5].map((d, i) => ({ id: `s${i}`, startsAt: soon(d, 19), endsAt: soon(d, 19), taken: false })));
  qc.setQueryData([...BOOKINGS_KEY, "payouts"], payoutsFixture());
  for (const c of [3000, 5000, 7500, 10000]) qc.setQueryData([...BOOKINGS_KEY, "quote", c], { priceCents: c, serviceFeeCents: Math.round(c * 0.1906), buyerTotalCents: c + Math.round(c * 0.1906), athleteReceivesCents: c, currency: "usd" });
  return qc;
}

import { BookingsScreen } from "../bookings/BookingsScreen";
import { BOOKINGS_KEY } from "../../hooks/use-bookings";
import { listItemFixture, offerFixture, payoutsFixture, summaryFixture } from "../../test/bookingFixtures";

const Stack = createNativeStackNavigator();

const Detail = ({ route, navigation }: any) => (
  <OpportunityDetailScreen opportunityId={route.params.opportunityId} onBack={() => navigation.goBack()} onOpenThread={() => {}} />
);

const START: Record<string, { name: string; params?: object }> = {
  board: { name: "OpportunitiesList" },
  "bookings-empty": { name: "OpportunitiesList" },
  "detail-interview": { name: "OpportunityDetail", params: { opportunityId: "o-int" } },
  "detail-paid": { name: "OpportunityDetail", params: { opportunityId: "o-paid" } },
  "detail-closed": { name: "OpportunityDetail", params: { opportunityId: "o-closed" } },
  "all-deals": { name: "AllDeals", params: { mode: "deals" } },
  "all-bookings": { name: "AllDeals", params: { mode: "bookings" } },
  rates: { name: "YourRates" },
  "bk-requests": { name: "Bookings", params: { tab: "requests" } },
  "bk-sessions": { name: "Bookings", params: { tab: "offers" } },
};

export function DealsGalleryScreen() {
  const page = Platform.OS === "web" && typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("s") ?? "board" : "board";
  const qc = useMemo(() => seed(page), [page]);
  const start = START[page] ?? START.board;
  return (
    <QueryClientProvider client={qc}>
      <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName={start.name}>
        <Stack.Screen name="OpportunitiesList" component={OpportunitiesScreen} />
        <Stack.Screen name="OpportunityDetail" component={Detail} initialParams={start.name === "OpportunityDetail" ? start.params : undefined} />
        <Stack.Screen name="AllDeals" component={AllDealsScreen} initialParams={start.name === "AllDeals" ? start.params : undefined} />
        <Stack.Screen name="YourRates" component={YourRatesScreen} />
        <Stack.Screen name="Bookings" component={BookingsScreen} initialParams={start.name === "Bookings" ? start.params : undefined} />
      </Stack.Navigator>
    </QueryClientProvider>
  );
}
