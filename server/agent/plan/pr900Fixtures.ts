/**
 * agent/plan/pr900Fixtures.ts — the Goals and Home shapes the UI needs, copied VERBATIM from draft PR #900
 * (branch design/real-screens-prototypes @ 572291886c66e5759f10a3cded52aa1b4af34589,
 * client/screens/prototypes/protoFixtures.ts): the proto types the Goals tab and Home's "Coming up" read, and the three
 * placeholder personas' goals, coming-up events, game plans with this week's actions, recommended goals, upside and
 * risk. Placeholder data only (bracketed names, made-up athletes); used by contract.test.ts, never at runtime.
 *
 * #900 is a draft and not on main, so the shapes live here rather than as an import; when #900 merges, the contract
 * test should import client/screens/prototypes/protoFixtures.ts directly and this file can go.
 */

export type ProtoKey = "youth" | "college" | "pro";

// ── #900's types, as written there ───────────────────────────────────────────────────────────────────────────────
export interface ProtoEvent { id: string; title: string; date: string; ready: number; place?: string | null }
export interface ProtoAction { id: string; title: string; event: string; date: string; action: string }
export interface ProtoGoalPlan { goalId: string; gamePlan: string; actions: ProtoAction[] }
export interface ProtoRecommendedGoal { id: string; domain: string; text: string; why: string; horizon: "this_season" | "next_12_months" | "multi_year" }
export interface ProtoGoal { id: string; domain: string; text: string; hers: boolean; horizon: "this_season" | "next_12_months" | "multi_year" | null }

/** The part of a #900 persona the Goals tab and Home's "Coming up" read. */
export interface ProtoGoalsPersona {
  goals: ProtoGoal[];
  comingUp: ProtoEvent[];
  plans: ProtoGoalPlan[];
  recommended: ProtoRecommendedGoal[];
  upside: string;
  risk: string;
}

export const PROTO_NOW = new Date("2026-10-10T09:00:00.000Z");

export const PR900_GOALS_PERSONAS: Record<ProtoKey, ProtoGoalsPersona> = {
  youth: {
    goals: [
      { id: "g-y1", domain: "performance", text: "Qualify for [Event A] in two events.", hers: true, horizon: "this_season" },
      { id: "g-y2", domain: "audience", text: "Share training safely, with a parent approving posts.", hers: false, horizon: "next_12_months" },
    ],
    comingUp: [
      { id: "e-y1", title: "[Event A] heats", date: "2026-10-18", ready: 1, place: "[Pool A]" },
      { id: "e-y2", title: "Club open day", date: "2026-10-25", ready: 0 },
    ],
    plans: [
      { goalId: "g-y1", gamePlan: "Two clean qualifying swims, then rest before the final.", actions: [
        { id: "a-y1", title: "Ask your coach for the heat sheet", event: "[Event A]", date: "2026-10-18", action: "Review" },
      ] },
      { goalId: "g-y2", gamePlan: "One training post a week, approved before it goes out.", actions: [
        { id: "a-y2", title: "A short warm-up clip for approval", event: "[Event A]", date: "2026-10-18", action: "Review" },
      ] },
    ],
    recommended: [
      { id: "r-y1", domain: "positioning", text: "Be known as the swimmer who helps the younger lanes.", why: "Your club already sees you this way.", horizon: "next_12_months" },
    ],
    upside: "Results are rising fast; one strong meet moves your read the most.",
    risk: "Without your meet results on record, your read stays early.",
  },
  college: {
    goals: [
      { id: "g-c1", domain: "commercial", text: "Land my first paid partnership this season.", hers: true, horizon: "this_season" },
      { id: "g-c2", domain: "audience", text: "Grow my audience on [Platform B].", hers: true, horizon: "next_12_months" },
      { id: "g-c3", domain: "impact", text: "Make my clinics part of my public story.", hers: false, horizon: "multi_year" },
    ],
    comingUp: [
      { id: "e-c1", title: "Home opener vs [School B]", date: "2026-10-18", ready: 2, place: "[Arena A]" },
      { id: "e-c2", title: "Youth clinic", date: "2026-10-22", ready: 1 },
      { id: "e-c3", title: "[Event B] tournament", date: "2026-11-01", ready: 0 },
    ],
    plans: [
      { goalId: "g-c1", gamePlan: "Pitch two brands that already reach your audience, timed to the home opener.", actions: [
        { id: "a-c1", title: "Send your deck to Brand E", event: "the home opener", date: "2026-10-18", action: "Review" },
        { id: "a-c2", title: "Set your floor rate", event: "the home opener", date: "2026-10-18", action: "Set" },
      ] },
      { goalId: "g-c2", gamePlan: "Three posts around match days, one behind-the-scenes.", actions: [
        { id: "a-c3", title: "Match-day post, ready to check", event: "the home opener", date: "2026-10-18", action: "Review" },
      ] },
      { goalId: "g-c3", gamePlan: "Tell the clinic story once, in your words, on your page.", actions: [] },
    ],
    recommended: [
      { id: "r-c1", domain: "positioning", text: "Be the face of the programme's community work.", why: "Your clinics are the story people share most.", horizon: "next_12_months" },
      { id: "r-c2", domain: "commercial", text: "A local partner you can appear for in person.", why: "Home matches give you a weekly stage.", horizon: "this_season" },
    ],
    upside: "Your clinics are the story people share most: brands with community budgets look for exactly this.",
    risk: "Brand A's category rules could block a second partner in the same space.",
  },
  pro: {
    goals: [
      { id: "g-p1", domain: "commercial", text: "Launch my own training line.", hers: true, horizon: "next_12_months" },
      { id: "g-p2", domain: "performance", text: "Peak for [Event A].", hers: true, horizon: "this_season" },
      { id: "g-p3", domain: "positioning", text: "Be known beyond race days.", hers: false, horizon: "multi_year" },
    ],
    comingUp: [
      { id: "e-p1", title: "[Event A]", date: "2026-10-18", ready: 3, place: "[Stadium A]" },
      { id: "e-p2", title: "Brand A shoot", date: "2026-10-21", ready: 1 },
      { id: "e-p3", title: "Off-season clinic", date: "2026-11-04", ready: 0 },
    ],
    plans: [
      { goalId: "g-p1", gamePlan: "Line up a manufacturing partner before the season closes.", actions: [
        { id: "a-p1", title: "Reply to Brand I's intro", event: "[Event A]", date: "2026-10-18", action: "Review" },
      ] },
      { goalId: "g-p2", gamePlan: "Protect race week: nothing scheduled the three days before.", actions: [
        { id: "a-p2", title: "Move the Brand A call after race day", event: "[Event A]", date: "2026-10-18", action: "Review" },
      ] },
      { goalId: "g-p3", gamePlan: "A monthly mentoring story on your page.", actions: [
        { id: "a-p3", title: "Clinic recap post, ready to check", event: "[Event A]", date: "2026-10-18", action: "Review" },
      ] },
    ],
    recommended: [
      { id: "r-p1", domain: "commercial", text: "A second category so one partner doesn't carry you.", why: "Most of your income sits with one brand type.", horizon: "next_12_months" },
    ],
    upside: "Repeat partners and a medal year: the best time to ask for longer terms.",
    risk: "One category carries most of your income; a clause there limits the training line.",
  },
};
